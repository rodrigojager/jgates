// Language versions and Playwright browsers in the toolchain volume (PLAN-dependencies.md section 3). The tools image has
// one default version per runtime. When a component pins another one (.python-version, .nvmrc, go.mod, rust-toolchain,
// global.json) the `deps` phase fetches it once into `jgates-toolchains` with the ecosystem's own mechanism (uv Python,
// a Node distribution verified against SHASUMS256.txt, the Go toolchain mechanism, rustup, the .NET release metadata
// with its sha512) and records it on the host; every workspace pinning the same version finds the record and starts no
// container. Playwright browsers matching the project's Playwright version are fetched the same way after the install
// (the version is read from the installed package). A version that cannot be obtained leaves the unit not ready, with the
// two actions "use the default version this time" and "fix the version file".
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { EngineError, IMAGE_USER, engineLabels, ensureVolume, listManaged, runInEngine, sourceVolumeName, type EngineContext, type EngineMount } from "../engine/index.js";
import { renameWithRetry } from "../fs-retry/index.js";
import type { DependencyEcosystem } from "../discovery/dependencies.js";
import type { InstallRecipe } from "./recipes.js";
import type { InstallUnit } from "./units.js";

export const TOOLCHAINS_VOLUME = "jgates-toolchains";
/** Where the toolchain volume is mounted in the deps container and in the steps. */
export const TOOLCHAINS_TARGET = "/toolchains";
/** Environment variable that gives up the pinned version this time: "1"/"all", or a list of ecosystems ("python,node"). */
export const USE_DEFAULT_ENV = "JGATES_TOOLCHAIN_DEFAULT";
/** Browsers fetched for a project that uses Playwright. */
export const PLAYWRIGHT_BROWSERS = ["chromium"] as const;
const UP_TO_DATE = "jgates-toolchain: up to date";
const FETCHED = "jgates-toolchain: fetched";

/** The runtime versions of the tools image (/etc/jgates/image.json `tools`); kept in step with the image. */
export const IMAGE_DEFAULT_VERSIONS: Readonly<Record<DependencyEcosystem, string>> = { python: "3.15.2", node: "26.13.0", go: "1.27.3", rust: "1.99.1", dotnet: "10.0.403" };
const LANGUAGE_NAME: Readonly<Record<DependencyEcosystem, string>> = { python: "Python", node: "Node", go: "Go", rust: "Rust", dotnet: ".NET" };

export interface ToolchainPin {
  /** "language" pins are fetched before the install; "playwright" ones after it (the version comes from the install). */
  kind: "language" | "playwright";
  /** Host record key: python-3.11, node-20, playwright. */
  id: string;
  ecosystem: DependencyEcosystem;
  /** The request as written in the project (a version, a range or a channel). */
  request: string;
  source: string | null;
  phase: "before-install" | "after-install";
  /** Folders put first on PATH (in the deps container and in the steps). */
  pathPrefix: string[];
  /** Environment of the deps container's install commands. */
  installEnv: Record<string, string>;
  /** Environment of the steps that use the unit. */
  stepEnv: Record<string, string>;
  /** Environment of the container that fetches (besides the base environment). */
  fetchEnv: Record<string, string>;
  /** The shell of the fetch container; it prints `jgates-toolchain: up to date` or `jgates-toolchain: fetched`. */
  script: string;
}

export interface ToolchainAction {
  id: "use-default-version" | "fix-version-file";
  label: string;
  /** use-default-version: the variable that gives up the pinned version for one run. */
  env?: Record<string, string>;
  /** fix-version-file: the project-relative file to correct. */
  file?: string;
}

export type ToolchainResolution =
  | { kind: "default" }
  | { kind: "pinned"; pin: ToolchainPin }
  | { kind: "invalid"; reasonKey: string; params: Record<string, string>; actions: ToolchainAction[] };

// ---- versions ------------------------------------------------------------------------------------------------------

type Parts = number[];
const parseParts = (text: string): Parts | null => (/^\d+(?:\.\d+)*$/.test(text) ? text.split(".").map(Number) : null);
const pad = (p: Parts, n = 3): Parts => Array.from({ length: Math.max(n, p.length) }, (_, i) => p[i] ?? 0);

function compare(a: Parts, b: Parts): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** version starts with the (possibly partial) prefix: 3.15.2 matches 3, 3.15 and 3.15.2. */
const hasPrefix = (version: Parts, prefix: Parts): boolean => prefix.every((n, i) => version[i] === n);

/** Bumps the last part of a prefix: [18] -> [19, 0, 0], [1, 2] -> [1, 3, 0]. */
function bump(prefix: Parts, index = prefix.length - 1): Parts {
  const out = prefix.slice(0, index + 1);
  out[index] = (out[index] ?? 0) + 1;
  return pad(out);
}

/** PEP 440 specifiers (">=3.10,<3.13", "~=3.11", "==3.11.*"): does the version satisfy them? null: not understood. */
export function satisfiesSpecifier(version: Parts, spec: string): boolean | null {
  const clauses = spec.split(",").map((c) => c.trim()).filter(Boolean);
  if (clauses.length === 0) return null;
  for (const clause of clauses) {
    const m = /^(===|==|!=|~=|>=|<=|>|<)\s*(\d+(?:\.\d+)*)(\.\*)?$/.exec(clause);
    if (!m) return null;
    const target = parseParts(m[2] as string) as Parts;
    const wildcard = m[3] !== undefined;
    let ok: boolean;
    switch (m[1]) {
      case "==":
      case "===":
        ok = wildcard ? hasPrefix(version, target) : compare(version, target) === 0;
        break;
      case "!=":
        ok = !(wildcard ? hasPrefix(version, target) : compare(version, target) === 0);
        break;
      case "~=":
        ok = target.length < 2 ? false : compare(version, target) >= 0 && hasPrefix(version, target.slice(0, -1));
        break;
      case ">=":
        ok = compare(version, target) >= 0;
        break;
      case "<=":
        ok = compare(version, target) <= 0;
        break;
      case ">":
        ok = compare(version, target) > 0;
        break;
      default:
        ok = compare(version, target) < 0;
    }
    if (!ok) return false;
  }
  return true;
}

/** npm semver ranges, the common subset (^ ~ >= > <= < = x-ranges, hyphen ranges, ||, spaces as AND). null: not understood. */
export function satisfiesRange(version: Parts, range: string): boolean | null {
  const normalized = range.trim().replace(/(\S+)\s+-\s+(\S+)/g, ">=$1 <=$2").replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1");
  const alternatives = normalized.split("||").map((a) => a.trim());
  let understood = true;
  const results = alternatives.map((alt) => {
    const tokens = alt.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return true;
    return tokens.every((token) => {
      const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(token);
      if (!m) {
        understood = false;
        return false;
      }
      const given: Parts = [];
      for (const part of [m[2], m[3], m[4]]) {
        if (part === undefined || /^[xX*]$/.test(part)) break;
        given.push(Number(part));
      }
      const op = m[1] ?? "";
      if (given.length === 0) return op === "<" ? false : true;
      switch (op) {
        case "":
        case "=":
          return hasPrefix(version, given);
        case ">=":
          return compare(version, pad(given)) >= 0;
        case ">":
          return given.length === 3 ? compare(version, given) > 0 : compare(version, bump(given)) >= 0;
        case "<=":
          return given.length === 3 ? compare(version, given) <= 0 : compare(version, bump(given)) < 0;
        case "<":
          return compare(version, pad(given)) < 0;
        case "~":
          return compare(version, pad(given)) >= 0 && compare(version, bump(given.slice(0, Math.min(given.length, given.length === 1 ? 1 : 2)))) < 0;
        default: {
          // ^: nothing above the first non-zero part that is given
          const at = given.findIndex((n) => n !== 0);
          return compare(version, pad(given)) >= 0 && compare(version, bump(given, at < 0 ? given.length - 1 : at)) < 0;
        }
      }
    });
  });
  return understood ? results.some(Boolean) : null;
}

// ---- resolving what a unit asks for ----------------------------------------------------------------------------------

const safeName = (text: string): string => text.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** Does the run give up the pinned version of this ecosystem (JGATES_TOOLCHAIN_DEFAULT)? */
export function usesDefaultVersion(env: NodeJS.ProcessEnv, ecosystem: DependencyEcosystem): boolean {
  const value = (env[USE_DEFAULT_ENV] ?? "").trim().toLowerCase();
  if (!value) return false;
  return value === "1" || value === "true" || value === "all" || value.split(",").map((s) => s.trim()).includes(ecosystem);
}

interface Request {
  version: string;
  source: string | null;
  sourceKind: string | null;
}

type Decision = { kind: "default" } | { kind: "pin"; request: string } | { kind: "unknown" } | { kind: "invalid" };

function decidePython(r: Request): Decision {
  const request = r.version.trim().replace(/^cpython[-@]?/i, "");
  const def = parseParts(IMAGE_DEFAULT_VERSIONS.python) as Parts;
  const plain = /^(\d+(?:\.\d+){0,2})(?:\.\*)?$/.exec(request);
  if (plain) {
    const parts = parseParts(plain[1] as string) as Parts;
    if (parts[0] !== 3 || (parts[1] !== undefined && parts[1] < 8)) return { kind: "unknown" };
    return hasPrefix(def, parts) ? { kind: "default" } : { kind: "pin", request: plain[1] as string };
  }
  const ok = satisfiesSpecifier(def, request);
  if (ok === null) return { kind: "invalid" };
  // A requirement that excludes every Python 3 (e.g. "<3") names a version nobody can fetch.
  if (!ok && satisfiesSpecifier([3, 15, 0], request) === false && [8, 9, 10, 11, 12, 13, 14, 15, 16].every((m) => satisfiesSpecifier([3, m, 0], request) === false)) return { kind: "unknown" };
  return ok ? { kind: "default" } : { kind: "pin", request };
}

function decideNode(r: Request): Decision {
  const request = r.version.trim();
  if (/^(node|stable|latest|current|lts\/.+)$/i.test(request)) return { kind: "default" };
  const def = parseParts(IMAGE_DEFAULT_VERSIONS.node) as Parts;
  const ok = satisfiesRange(def, request.replace(/^v(?=\d)/, ""));
  if (ok === null) return r.sourceKind === "engines-node" ? { kind: "default" } : { kind: "invalid" };
  return ok ? { kind: "default" } : { kind: "pin", request: request.replace(/^v(?=\d)/, "") };
}

function decideGo(r: Request): Decision {
  const request = r.version.trim().replace(/^go/, "");
  const parts = parseParts(request);
  if (!parts) return { kind: "invalid" };
  return compare(parts, parseParts(IMAGE_DEFAULT_VERSIONS.go) as Parts) <= 0 ? { kind: "default" } : { kind: "pin", request };
}

function decideRust(r: Request): Decision {
  const request = r.version.trim();
  if (/^stable($|-)/.test(request)) return { kind: "default" };
  const parts = parseParts(request);
  const def = parseParts(IMAGE_DEFAULT_VERSIONS.rust) as Parts;
  if (parts) {
    if (r.sourceKind === "rust-version") return compare(parts, def) <= 0 ? { kind: "default" } : { kind: "pin", request };
    return hasPrefix(def, parts) ? { kind: "default" } : { kind: "pin", request };
  }
  return /^[A-Za-z0-9._-]+$/.test(request) ? { kind: "pin", request } : { kind: "invalid" };
}

function decideDotnet(r: Request): Decision {
  const request = r.version.trim();
  const parts = parseParts(request);
  if (!parts) return { kind: "invalid" };
  const def = parseParts(IMAGE_DEFAULT_VERSIONS.dotnet) as Parts;
  return parts[0] === def[0] && compare(parts, def) <= 0 ? { kind: "default" } : { kind: "pin", request };
}

// ---- the fetch scripts ------------------------------------------------------------------------------------------------

const header = (marker: string): string[] => ["set -eu", 'mkdir -p "$HOME"', `marker=${quote(marker)}`, `if [ -f "$marker" ]; then echo ${quote(UP_TO_DATE)}; exit 0; fi`];
const footer = (id: string): string[] => [`printf '{"id": "%s", "fetchedAt": "%s"}\\n' ${quote(id)} "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker"`, `echo ${quote(FETCHED)}`];

function pythonPin(request: string, source: string | null): ToolchainPin {
  const id = `python-${safeName(request)}`;
  const dir = `${TOOLCHAINS_TARGET}/uv-python`;
  const env = { UV_PYTHON_INSTALL_DIR: dir, UV_PYTHON_PREFERENCE: "only-managed", UV_NO_PROGRESS: "1" };
  return {
    kind: "language",
    id,
    ecosystem: "python",
    request,
    source,
    phase: "before-install",
    pathPrefix: [],
    installEnv: { ...env, UV_PYTHON_DOWNLOADS: "never" },
    stepEnv: { UV_PYTHON_INSTALL_DIR: dir, UV_PYTHON_DOWNLOADS: "never" },
    fetchEnv: { ...env, UV_PYTHON_DOWNLOADS: "automatic", UV_CACHE_DIR: "/tmp/uv-cache" },
    script: [...header(`${TOOLCHAINS_TARGET}/.jgates-${id}.json`), `uv python install ${quote(request)}`, ...footer(id)].join("\n"),
  };
}

/** Resolves the version with the semver of npm (it ships with the image), downloads the distribution and checks it against SHASUMS256.txt. */
function nodePin(request: string, source: string | null): ToolchainPin {
  const id = `node-${safeName(request)}`;
  const link = `${TOOLCHAINS_TARGET}/node/by-request/${safeName(request)}`;
  const resolver = [
    "const semver = require(require('path').join(require('path').dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'node_modules', 'semver'));",
    "let text = ''; process.stdin.on('data', (c) => (text += c)).on('end', () => {",
    "  const versions = JSON.parse(text).map((e) => e.version.replace(/^v/, ''));",
    "  const found = semver.maxSatisfying(versions, process.env.JGATES_REQUEST);",
    "  if (found) process.stdout.write(found);",
    "});",
  ].join(" ");
  const base = "https://nodejs.org/dist";
  return {
    kind: "language",
    id,
    ecosystem: "node",
    request,
    source,
    phase: "before-install",
    pathPrefix: [`${link}/bin`],
    installEnv: {},
    stepEnv: {},
    fetchEnv: { JGATES_REQUEST: request },
    script: [
      ...header(`${TOOLCHAINS_TARGET}/.jgates-${id}.json`),
      `version=$(curl -fsSL ${quote(`${base}/index.json`)} | node -e ${quote(resolver)})`,
      `[ -n "$version" ] || { echo "no Node version matches $JGATES_REQUEST" >&2; exit 3; }`,
      `dest="${TOOLCHAINS_TARGET}/node/$version"`,
      'if [ ! -x "$dest/bin/node" ]; then',
      `  mkdir -p "${TOOLCHAINS_TARGET}/node/by-request"`,
      `  tmp="${TOOLCHAINS_TARGET}/node/.tmp-$version"; rm -rf "$tmp"; mkdir -p "$tmp"`,
      `  file="node-v$version-linux-x64.tar.xz"`,
      `  curl -fsSL -o "/tmp/$file" "${base}/v$version/$file"`,
      `  curl -fsSL -o /tmp/SHASUMS256.txt "${base}/v$version/SHASUMS256.txt"`,
      `  expected=$(grep " $file\\$" /tmp/SHASUMS256.txt | cut -d' ' -f1)`,
      '  [ -n "$expected" ] || { echo "no checksum for $file" >&2; exit 4; }',
      '  echo "$expected  /tmp/$file" | sha256sum -c -',
      '  tar -xJf "/tmp/$file" -C "$tmp" --strip-components=1',
      '  mv "$tmp" "$dest"',
      "fi",
      `mkdir -p "${TOOLCHAINS_TARGET}/node/by-request"`,
      `ln -sfn "$dest" ${quote(link)}`,
      ...footer(id),
    ].join("\n"),
  };
}

/** The Go toolchain mechanism: GOTOOLCHAIN=go<version> downloads the verified toolchain module; it is copied to the volume. */
function goPin(request: string, source: string | null): ToolchainPin {
  const id = `go-${safeName(request)}`;
  const dest = `${TOOLCHAINS_TARGET}/go/go${request}`;
  return {
    kind: "language",
    id,
    ecosystem: "go",
    request,
    source,
    phase: "before-install",
    pathPrefix: [`${dest}/bin`],
    installEnv: { GOROOT: dest },
    stepEnv: { GOROOT: dest },
    fetchEnv: { GOTOOLCHAIN: `go${request}`, GOMODCACHE: "/tmp/gomod", GOPATH: "/tmp/gopath", GOFLAGS: "-modcacherw" },
    script: [
      ...header(`${TOOLCHAINS_TARGET}/.jgates-${id}.json`),
      "cd /tmp",
      "go version",
      `src=$(ls -d /tmp/gomod/golang.org/toolchain@v0.0.1-go${request}.linux-amd64)`,
      `mkdir -p "${TOOLCHAINS_TARGET}/go"`,
      `rm -rf ${quote(`${dest}.tmp`)}`,
      `cp -a "$src" ${quote(`${dest}.tmp`)}`,
      `chmod -R u+w ${quote(`${dest}.tmp`)}`,
      `rm -rf ${quote(dest)}`,
      `mv ${quote(`${dest}.tmp`)} ${quote(dest)}`,
      ...footer(id),
    ].join("\n"),
  };
}

function rustPin(request: string, source: string | null): ToolchainPin {
  const id = `rust-${safeName(request)}`;
  const home = `${TOOLCHAINS_TARGET}/rustup`;
  return {
    kind: "language",
    id,
    ecosystem: "rust",
    request,
    source,
    phase: "before-install",
    pathPrefix: [],
    installEnv: { RUSTUP_HOME: home, RUSTUP_TOOLCHAIN: request },
    stepEnv: { RUSTUP_HOME: home, RUSTUP_TOOLCHAIN: request },
    fetchEnv: { RUSTUP_HOME: home, CARGO_HOME: "/tmp/cargo-home" },
    script: [...header(`${TOOLCHAINS_TARGET}/.jgates-${id}.json`), `rustup toolchain install ${quote(request)} --profile minimal --component clippy --component rustfmt --no-self-update`, ...footer(id)].join("\n"),
  };
}

/** The SDK archive and its sha512 come from the official release metadata; the archive is checked before it is unpacked. */
function dotnetPin(request: string, source: string | null): ToolchainPin {
  const id = `dotnet-${safeName(request)}`;
  const dest = `${TOOLCHAINS_TARGET}/dotnet/${request}`;
  const finder = [
    "let text = ''; process.stdin.on('data', (c) => (text += c)).on('end', () => {",
    "  const doc = JSON.parse(text);",
    "  for (const r of doc.releases || []) for (const sdk of [r.sdk, ...(r.sdks || [])]) {",
    "    if (!sdk || sdk.version !== process.env.JGATES_REQUEST) continue;",
    "    const f = (sdk.files || []).find((x) => x.rid === 'linux-x64' && /\\.tar\\.gz$/.test(x.name));",
    "    if (f) { process.stdout.write(f.url + ' ' + f.hash); return; }",
    "  }",
    "});",
  ].join(" ");
  const channel = request.split(".").slice(0, 2).join(".");
  return {
    kind: "language",
    id,
    ecosystem: "dotnet",
    request,
    source,
    phase: "before-install",
    pathPrefix: [dest],
    installEnv: { DOTNET_ROOT: dest },
    stepEnv: { DOTNET_ROOT: dest },
    fetchEnv: { JGATES_REQUEST: request },
    script: [
      ...header(`${TOOLCHAINS_TARGET}/.jgates-${id}.json`),
      `found=$(curl -fsSL ${quote(`https://builds.dotnet.microsoft.com/dotnet/release-metadata/${channel}/releases.json`)} | node -e ${quote(finder)})`,
      '[ -n "$found" ] || { echo "no .NET SDK $JGATES_REQUEST in the release metadata" >&2; exit 3; }',
      'url=${found% *}; hash=${found#* }',
      'curl -fsSL -o /tmp/sdk.tar.gz "$url"',
      'echo "$hash  /tmp/sdk.tar.gz" | sha512sum -c -',
      `mkdir -p ${quote(`${dest}.tmp`)}`,
      `tar -xzf /tmp/sdk.tar.gz -C ${quote(`${dest}.tmp`)}`,
      `rm -rf ${quote(dest)}`,
      `mv ${quote(`${dest}.tmp`)} ${quote(dest)}`,
      ...footer(id),
    ].join("\n"),
  };
}

/**
 * Playwright browsers for the version installed in the unit's volume, read after the install: from node_modules for a
 * Node unit, from the virtual environment (the `playwright` distribution that pytest-playwright brings) for a Python
 * unit. Both share the browsers folder: a Playwright version installs its own browser revision there.
 */
export function playwrightPin(installRoot: string, target: string, ecosystem: "node" | "python" = "node"): ToolchainPin {
  const cwd = path.posix.join("/workspace", installRoot === "." ? "" : installRoot);
  const browsers = `${TOOLCHAINS_TARGET}/playwright`;
  if (ecosystem === "python") {
    return {
      kind: "playwright",
      id: "playwright",
      ecosystem: "python",
      request: PLAYWRIGHT_BROWSERS.join(","),
      source: null,
      phase: "after-install",
      pathPrefix: [],
      installEnv: {},
      stepEnv: { PLAYWRIGHT_BROWSERS_PATH: browsers, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
      fetchEnv: { PLAYWRIGHT_BROWSERS_PATH: browsers, JGATES_PLAYWRIGHT_VENV: target },
      script: [
        "set -eu",
        'mkdir -p "$HOME"',
        `cd ${quote(cwd)}`,
        'py="$JGATES_PLAYWRIGHT_VENV/bin/python"',
        '[ -x "$py" ] || { echo "no Python environment in $JGATES_PLAYWRIGHT_VENV" >&2; exit 5; }',
        `version=$("$py" -c "import importlib.metadata as m; print(m.version('playwright'))" 2>/dev/null) || { echo "Playwright is not installed in $JGATES_PLAYWRIGHT_VENV" >&2; exit 5; }`,
        `mkdir -p ${quote(browsers)}`,
        `marker=${quote(browsers)}/.jgates-${PLAYWRIGHT_BROWSERS.join("-")}-$version.json`,
        `if [ -f "$marker" ]; then echo ${quote(`${UP_TO_DATE} playwright`)} "$version"; exit 0; fi`,
        `"$py" -m playwright install ${PLAYWRIGHT_BROWSERS.join(" ")}`,
        `printf '{"playwright": "%s", "browsers": "%s", "fetchedAt": "%s"}\\n' "$version" ${quote(PLAYWRIGHT_BROWSERS.join(","))} "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker"`,
        `echo ${quote(`${FETCHED} playwright`)} "$version"`,
      ].join("\n"),
    };
  }
  return {
    kind: "playwright",
    id: "playwright",
    ecosystem: "node",
    request: PLAYWRIGHT_BROWSERS.join(","),
    source: null,
    phase: "after-install",
    pathPrefix: [],
    installEnv: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    stepEnv: { PLAYWRIGHT_BROWSERS_PATH: browsers, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    fetchEnv: { PLAYWRIGHT_BROWSERS_PATH: browsers, JGATES_PLAYWRIGHT_MODULES: target },
    script: [
      "set -eu",
      'mkdir -p "$HOME"',
      `cd ${quote(cwd)}`,
      'modules="$JGATES_PLAYWRIGHT_MODULES"',
      'pkg="$modules/@playwright/test/package.json"; [ -f "$pkg" ] || pkg="$modules/playwright/package.json"',
      '[ -f "$pkg" ] || { echo "Playwright is not installed in $modules" >&2; exit 5; }',
      'version=$(node -p "require(process.argv[1]).version" "$pkg")',
      `mkdir -p ${quote(browsers)}`,
      `marker=${quote(browsers)}/.jgates-${PLAYWRIGHT_BROWSERS.join("-")}-$version.json`,
      `if [ -f "$marker" ]; then echo ${quote(`${UP_TO_DATE} playwright`)} "$version"; exit 0; fi`,
      'cli="$modules/playwright/cli.js"; [ -f "$cli" ] || cli="$modules/playwright-core/cli.js"',
      `node "$cli" install ${PLAYWRIGHT_BROWSERS.join(" ")}`,
      `printf '{"playwright": "%s", "browsers": "%s", "fetchedAt": "%s"}\\n' "$version" ${quote(PLAYWRIGHT_BROWSERS.join(","))} "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker"`,
      `echo ${quote(`${FETCHED} playwright`)} "$version"`,
    ].join("\n"),
  };
}

// ---- resolution ------------------------------------------------------------------------------------------------------

export interface ResolveInput {
  env: NodeJS.ProcessEnv;
}

/** The two ways out of a version that cannot be obtained: the image's default this time, or fixing the version file. */
export function toolchainActions(unit: InstallUnit): ToolchainAction[] {
  const t = translator("deps");
  const { ecosystem, language } = unit.info;
  const file = language.source ? path.posix.basename(language.source) : null;
  return [
    { id: "use-default-version", label: t("toolchain_action_default", { version: IMAGE_DEFAULT_VERSIONS[ecosystem] }), env: { [USE_DEFAULT_ENV]: ecosystem } },
    ...(file ? [{ id: "fix-version-file" as const, label: t("toolchain_action_fix", { file }), file: language.source as string }] : []),
  ];
}

/** What the unit's pinned language version asks of the toolchain volume (no engine call). */
export function resolveToolchain(unit: InstallUnit, input: ResolveInput): ToolchainResolution {
  const { ecosystem, language } = unit.info;
  if (!language.version) return { kind: "default" };
  const request: Request = { version: language.version, source: language.source, sourceKind: language.sourceKind };
  const decision = { python: decidePython, node: decideNode, go: decideGo, rust: decideRust, dotnet: decideDotnet }[ecosystem](request);
  if (decision.kind === "default") return { kind: "default" };
  const defaultVersion = IMAGE_DEFAULT_VERSIONS[ecosystem];
  const actions = toolchainActions(unit);
  if (usesDefaultVersion(input.env, ecosystem)) return { kind: "default" };
  const params = { language: LANGUAGE_NAME[ecosystem], version: language.version, source: language.source ?? "-", default: defaultVersion };
  if (decision.kind === "unknown") return { kind: "invalid", reasonKey: "toolchain_unknown_version", params, actions };
  if (decision.kind === "invalid") return { kind: "invalid", reasonKey: "toolchain_invalid_request", params, actions };
  const make = { python: pythonPin, node: nodePin, go: goPin, rust: rustPin, dotnet: dotnetPin }[ecosystem];
  return { kind: "pinned", pin: make(decision.request, language.source) };
}

/** The Python dependency files that can name pytest-playwright or playwright. */
const PYTHON_DEPENDENCY_FILES = ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "requirements-test.txt", "setup.cfg", "Pipfile"];
const PYTHON_PLAYWRIGHT = /(?:^|["'\s])(?:pytest[-_.])?playwright(?![\w.-])/im;

/** Does the unit declare Playwright (package.json; for Python, playwright or pytest-playwright in its dependency files)? (read-only, host side) */
export function declaresPlaywright(unit: InstallUnit, projectDir: string): boolean {
  const root = path.join(projectDir, ...(unit.installRoot === "." ? [] : unit.installRoot.split("/")));
  if (unit.info.ecosystem === "python") {
    return PYTHON_DEPENDENCY_FILES.some((name) => {
      try {
        return PYTHON_PLAYWRIGHT.test(fs.readFileSync(path.join(root, name), "utf8"));
      } catch {
        return false;
      }
    });
  }
  if (unit.info.ecosystem !== "node") return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, ...(unit.installRoot === "." ? [] : unit.installRoot.split("/")), "package.json"), "utf8")) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "optionalDependencies"].some((group) => {
      const deps = pkg[group];
      return !!deps && typeof deps === "object" && ("@playwright/test" in deps || "playwright" in deps);
    });
  } catch {
    return false;
  }
}

/** The recipe with its pins applied: the version selected in the install commands, the environment and PATH of both containers. */
export function withToolchains(recipe: InstallRecipe, pins: readonly ToolchainPin[]): InstallRecipe {
  if (pins.length === 0) return recipe;
  let commands = recipe.commands;
  const language = pins.find((p) => p.kind === "language");
  if (language?.ecosystem === "python") {
    // The virtual environments are created on the pinned interpreter instead of the image's.
    commands = commands.map((argv) => (argv[0] === "uv" && argv[1] === "venv" ? argv.map((a, i) => (argv[i - 1] === "--python" ? language.request : a)) : argv));
  }
  const merge = (pick: (p: ToolchainPin) => Record<string, string>): Record<string, string> => Object.assign({}, ...pins.map(pick));
  return {
    ...recipe,
    commands,
    installEnv: { ...recipe.installEnv, ...merge((p) => p.installEnv) },
    stepEnv: { ...recipe.stepEnv, ...merge((p) => p.stepEnv) },
    pathPrefix: [...recipe.pathPrefix, ...pins.flatMap((p) => p.pathPrefix)],
    toolchains: [...pins],
  };
}

// ---- host record -------------------------------------------------------------------------------------------------------

export interface ToolchainRecord {
  id: string;
  ecosystem: string;
  request: string;
  volume: string;
  fetchedAt: string;
}

export interface ToolchainState {
  schemaVersion: 1;
  entries: Record<string, ToolchainRecord>;
}

export function toolchainStateFile(home: string): string {
  return path.join(home, "toolchains.json");
}

export function readToolchainState(home: string): ToolchainState {
  try {
    const doc = JSON.parse(fs.readFileSync(toolchainStateFile(home), "utf8")) as Partial<ToolchainState>;
    return { schemaVersion: 1, entries: { ...(doc.entries ?? {}) } };
  } catch {
    return { schemaVersion: 1, entries: {} };
  }
}

function recordToolchain(home: string, key: string, record: ToolchainRecord): void {
  const state = readToolchainState(home);
  state.entries[key] = record;
  const file = toolchainStateFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameWithRetry(tmp, file);
}

// ---- fetching ----------------------------------------------------------------------------------------------------------

export interface ToolchainContext {
  home: string;
  version: string;
  workspace: string;
  run?: string | undefined;
  imageId: string;
  engine: EngineContext;
  /** The toolchain volume (default jgates-toolchains). */
  volume?: string | undefined;
  extraLabels?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
}

export interface ToolchainFetch {
  id: string;
  /** "fetched": a container downloaded it; "reused": the host record and the volume say it is there. */
  status: "fetched" | "reused";
  volume: string;
  /** What the container printed (empty when reused). */
  output: string;
}

export class ToolchainError extends Error {
  constructor(
    message: string,
    readonly details: string,
    readonly pin: ToolchainPin,
  ) {
    super(message);
    this.name = "ToolchainError";
  }
}

const lastLines = (text: string, count = 20): string => text.trim().split(/\r?\n/).slice(-count).join("\n");

/**
 * Makes a pin available in the toolchain volume. A language pin recorded on the host (and a volume that still exists) starts
 * nothing: this is how a second workspace pinning the same version downloads nothing. Playwright is recorded per install key
 * (`recordKey`), because its version is only known from the installed package; the browsers themselves carry a marker in the
 * volume, so a second workspace with the same Playwright version finds them without a download too.
 */
export async function ensureToolchain(pin: ToolchainPin, ctx: ToolchainContext, options: { recordKey?: string; mounts?: EngineMount[]; workdir?: string } = {}): Promise<ToolchainFetch> {
  const t = translator("deps");
  const volume = ctx.volume ?? TOOLCHAINS_VOLUME;
  const extra = ctx.extraLabels ?? {};
  const labels = (kind: "toolchain" | "helper", withRun = true) =>
    engineLabels({ kind, version: ctx.version, ...(ctx.run && withRun ? { run: ctx.run } : {}), extra });
  const key = options.recordKey ?? pin.id;
  const now = ctx.now ?? (() => new Date());
  try {
    const volumes = await listManaged("volume", { kind: "toolchain", extraLabels: extra }, ctx.engine);
    const present = volumes.some((v) => v.name === volume);
    const record = readToolchainState(ctx.home).entries[key];
    if (present && record && record.volume === volume) return { id: pin.id, status: "reused", volume, output: "" };
    await ensureVolume(volume, { labels: labels("toolchain", false), helperLabels: engineLabels({ kind: "helper", version: ctx.version, extra }), image: ctx.imageId }, ctx.engine);
    const result = await runInEngine(
      {
        image: ctx.imageId,
        command: ["sh", "-c", pin.script],
        labels: labels("toolchain"),
        user: IMAGE_USER,
        network: "bridge",
        mounts: [{ type: "volume", source: volume, target: TOOLCHAINS_TARGET }, ...(options.mounts ?? [])],
        ...(options.workdir ? { workdir: options.workdir } : {}),
        env: pin.fetchEnv,
        resources: { memoryMb: 4096, cpus: 2, pids: 4096, tmpfsMb: 2048 },
        tmpExec: true,
        timeoutMs: ctx.timeoutMs ?? 1_200_000,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
      ctx.engine,
    );
    const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`;
    if (result.exitCode !== 0 || result.cancelled || result.timedOut) {
      throw new ToolchainError(t("toolchain_fetch_exit", { exit: String(result.exitCode ?? (result.timedOut ? "timeout" : "-")) }), lastLines(output), pin);
    }
    recordToolchain(ctx.home, key, { id: pin.id, ecosystem: pin.ecosystem, request: pin.request, volume, fetchedAt: now().toISOString() });
    return { id: pin.id, status: result.stdout.includes(UP_TO_DATE) && !result.stdout.includes(FETCHED) ? "reused" : "fetched", volume, output: lastLines(output) };
  } catch (error) {
    if (error instanceof ToolchainError) throw error;
    const details = error instanceof EngineError ? error.details : "";
    throw new ToolchainError(error instanceof Error ? error.message : String(error), details, pin);
  }
}

/** The mounts a container needs to run the Playwright fetch: the source, the unit's modules and nothing else. */
export function playwrightMounts(workspace: string, modulesVolume: string, modulesTarget: string): EngineMount[] {
  return [
    { type: "volume", source: sourceVolumeName(workspace), target: "/workspace" },
    { type: "volume", source: modulesVolume, target: modulesTarget, readonly: true },
  ];
}

/** The toolchain mount of a step or deps container (read-only: only the fetch container writes). */
export const toolchainMount = (volume: string = TOOLCHAINS_VOLUME): EngineMount => ({ type: "volume", source: volume, target: TOOLCHAINS_TARGET, readonly: true });
