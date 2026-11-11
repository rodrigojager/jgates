// The gates of PLAN-image.md section 5, run on every image build (image-build.mjs calls runGates) and testable one by one:
//   versions   /etc/jgates/image.json matches the pins of the Dockerfile and every adapter's toolVersionRange accepts
//              the shipped version;
//   licenses   an SPDX SBOM of the image made by the image's own Trivy, every component checked against
//              docker/tools/license-policy.json (AGPL and unknown licenses fail);
//   forbidden  no official semgrep rules, no CodeQL, no vulnerability database, no credential-looking file (a walk of
//              the image filesystem plus gitleaks over the places a credential could be left);
//   size       at most 7 GB uncompressed and 3 GB compressed; above it the five largest layers are listed;
//   scan       Trivy vulnerability scan of the image filesystem; a critical finding with a fix fails;
//   smoke      `jgates ci` in `in-image` mode on a clean and a known-bad project of the Python and TS stacks.
// Reports (SBOM, license report, scan report, one JSON per gate) go to the output folder.
//
// Usage (host):    node image-gates.mjs run [--image jgates-tools:dev] [--out <dir>] [--only gate,gate]
// In the image:    node /gate/image-gates.mjs scan-forbidden <root> | smoke      (mounted read-only by `run`)
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(here, "..");
export const repositoryRoot = path.resolve(packageRoot, "..");
const toolsContext = path.join(packageRoot, "docker", "tools");
const GB = 1024 ** 3;
const DEFAULT_OUT = path.resolve(repositoryRoot, "..", "_work", "00-tmp", "v2-container-image");
export const DEFAULT_BUDGET = { uncompressedBytes: 7 * GB, compressedBytes: 3 * GB };

// ---------------------------------------------------------------------------------------------------------------------
// 1. Versions
// ---------------------------------------------------------------------------------------------------------------------

/** Adapter tool names that are not tools of the image: the reason is the entry. */
export const NOT_IN_IMAGE = {
  codeql: "customer supplied, never in the image (ADR-0005)",
  compiler: "build-check drives the compiler of each stack (tsc, go, cargo, dotnet, mypy, pyright), each one checked on its own",
  formatter: "format-check drives the formatter of each stack (ruff, prettier, gofmt, cargo fmt, dotnet format), each one checked on its own",
  "jgates-file-size": "the built-in file-size check, versioned with JGates itself",
  "generic-command": "runs whatever command the user registers",
  "quality-gate": "the legacy bridge adapter, versioned with JGates itself",
  "quality-sidecar-pii": "the built-in PII scan, versioned with JGates itself",
  "jgates-supply-chain": "the built-in supply-chain check, versioned with JGates itself",
  jest: "the project's own dev dependency, installed into the dependency volume by the deps phase (PLAN-completeness.md section 2)",
  playwright: "the project's own dev dependency (@playwright/test, pytest-playwright), installed into the dependency volume; the browsers come into the toolchain volume (PLAN-image.md section 2.6)",
  "migration-tool": "migration-drift drives each framework's own command (Django, Alembic, Prisma from the project's dependencies; dotnet-ef, checked on its own)",
  benchmark: "performance drives each stack's benchmark harness (pytest-benchmark, vitest bench, go test -bench, criterion, BenchmarkDotNet), the project's own or the image's runtimes",
};

/** ARG names of the Dockerfile whose tool name differs from the lower-cased name without `_VERSION`. */
const ARG_TOOL_NAMES = { "dotnet-sdk": "dotnet", rust: "rustc", "tools-python": "toolsPython" };
const ARG_IGNORED = new Set(["jgates", "image", "base"]);

/** The `ARG <TOOL>_VERSION=<pin>` defaults of the final stage of the Dockerfile as tool name -> version. */
export function dockerfilePins(dockerfileText) {
  const pins = {};
  const finalStage = dockerfileText.slice(dockerfileText.indexOf("FROM base AS final"));
  for (const match of finalStage.matchAll(/^ARG ([A-Z0-9_]+)_VERSION=(\S+)$/gm)) {
    const key = match[1].toLowerCase().replace(/_/g, "-");
    if (ARG_IGNORED.has(key)) continue;
    pins[ARG_TOOL_NAMES[key] ?? key] = match[2];
  }
  return pins;
}

/** Loads the built adapter manifests (jgates/dist/adapters/<id>/manifest.js) and the range checker of the CLI. */
export async function loadManifests(dist = path.join(packageRoot, "dist")) {
  const adaptersDir = path.join(dist, "adapters");
  const manifests = [];
  for (const id of fs.readdirSync(adaptersDir).sort()) {
    const file = path.join(adaptersDir, id, "manifest.js");
    if (!fs.existsSync(file)) continue;
    const module = await import(pathToFileURL(file).href);
    for (const value of Object.values(module)) {
      if (value && typeof value === "object" && typeof value.toolName === "string" && "toolVersionRange" in value) manifests.push(value);
    }
  }
  const semver = await import(pathToFileURL(path.join(dist, "core", "prepare", "semver.js")).href);
  return { manifests, satisfiesRange: semver.satisfiesRange };
}

/**
 * The versions gate. `imageJson` is the document of /etc/jgates/image.json. Findings: a shipped version outside the
 * range of an adapter, an adapter whose tool is neither in the image nor in NOT_IN_IMAGE, a pin of the Dockerfile that
 * differs from the image, a pinned tool that is missing from the image.
 */
export function checkVersions({ imageJson, manifests, satisfiesRange, pins = {} }) {
  const findings = [];
  const tools = imageJson?.tools ?? {};
  if (Object.keys(tools).length === 0) findings.push({ kind: "no-tools", message: "image.json lists no tools" });
  for (const manifest of manifests) {
    const name = manifest.toolName;
    if (!(name in tools)) {
      if (!(name in NOT_IN_IMAGE)) findings.push({ kind: "tool-missing", adapter: manifest.id, tool: name, message: `adapter ${manifest.id} needs ${name}, which is not in image.json` });
      continue;
    }
    const ok = satisfiesRange(tools[name], manifest.toolVersionRange ?? "");
    if (ok !== true) {
      findings.push({
        kind: ok === false ? "outside-range" : "unreadable",
        adapter: manifest.id,
        tool: name,
        version: tools[name],
        range: manifest.toolVersionRange,
        message: `${name} ${tools[name]} is ${ok === false ? "outside" : "not comparable with"} the toolVersionRange "${manifest.toolVersionRange}" of adapter ${manifest.id}`,
      });
    }
  }
  const shown = { ...tools, toolsPython: imageJson?.toolsPython };
  for (const [name, pin] of Object.entries(pins)) {
    if (shown[name] === undefined) findings.push({ kind: "pin-missing", tool: name, pin, message: `${name} is pinned to ${pin} in the Dockerfile but image.json does not list it` });
    else if (shown[name] !== pin) findings.push({ kind: "pin-differs", tool: name, pin, version: shown[name], message: `${name}: the Dockerfile pins ${pin}, the image has ${shown[name]}` });
  }
  for (const name of imageJson?.pinned ?? []) {
    if (!(name in tools)) findings.push({ kind: "pinned-missing", tool: name, message: `${name} is listed as pinned but has no version in image.json` });
  }
  return { gate: "versions", passed: findings.length === 0, checked: manifests.length, tools: Object.keys(tools).length, findings };
}

/** The part of image.json that is stable between builds (no source revision): the file kept in jgates/release/. */
export function versionsSnapshot(imageJson) {
  const { sourceRevision: _revision, ...rest } = imageJson;
  return rest;
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Licenses
// ---------------------------------------------------------------------------------------------------------------------

export function loadPolicy(file = path.join(toolsContext, "license-policy.json")) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Parses an SPDX license expression into a tree: {id}, {with: [id, exception]}, {and: []}, {or: []}. null when unreadable. */
export function parseExpression(text) {
  const tokens = text.match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;
  const peek = () => tokens[position];
  const upper = (token) => token?.toUpperCase();
  function primary() {
    const token = tokens[position++];
    if (token === undefined) throw new Error("unexpected end");
    if (token === "(") {
      const inner = orExpression();
      if (tokens[position++] !== ")") throw new Error("missing )");
      return inner;
    }
    if (token === ")" || ["AND", "OR", "WITH"].includes(upper(token))) throw new Error(`unexpected ${token}`);
    if (upper(peek()) === "WITH") {
      position++;
      const exception = tokens[position++];
      if (exception === undefined) throw new Error("WITH without exception");
      return { with: [token, exception] };
    }
    return { id: token };
  }
  function andExpression() {
    const parts = [primary()];
    while (upper(peek()) === "AND") {
      position++;
      parts.push(primary());
    }
    return parts.length === 1 ? parts[0] : { and: parts };
  }
  function orExpression() {
    const parts = [andExpression()];
    while (upper(peek()) === "OR") {
      position++;
      parts.push(andExpression());
    }
    return parts.length === 1 ? parts[0] : { or: parts };
  }
  try {
    const tree = orExpression();
    return position === tokens.length ? tree : null;
  } catch {
    return null;
  }
}

const norm = (id) => id.toLowerCase();

/** Compiled view of the policy: sets for the categories and regular expressions for the patterns. */
export function compilePolicy(policy) {
  const category = new Map();
  for (const [name, ids] of Object.entries(policy.allowedSpdx)) for (const id of ids) category.set(norm(id), name);
  return {
    policy,
    category,
    exceptions: new Set(policy.allowedExceptions.map(norm)),
    forbidden: policy.forbiddenPatterns.map((pattern) => new RegExp(pattern, "i")),
    refNames: (policy.allowedLicenseRefNames ?? []).map((pattern) => new RegExp(pattern, "i")),
    osTypes: new Set(policy.operatingSystem.packageTypes),
    toolLevel: new Set(policy.declaredByTool.packageTypes),
    gpl: new Set((policy.gplPackages ?? []).map((entry) => entry.name)),
    resolved: new Map(Object.entries(policy.resolved ?? {})),
  };
}

/**
 * Judges one license expression. Returns {ok, reasons[]}: `reasons` explains each failing identifier. `names` maps a
 * LicenseRef-* to the name the SBOM gives it. OS packages (Debian main) accept any name that is not forbidden: the
 * distribution guarantees that main is free software and the copyright files give free-form names for it.
 */
export function judgeExpression(expression, compiled, { names = new Map(), osPackage = false, packageName = "" } = {}) {
  const tree = parseExpression(expression);
  if (!tree) return { ok: false, reasons: [`unreadable license expression "${expression.slice(0, 120)}"`] };
  const reasons = [];
  const idOk = (id) => {
    const name = id.startsWith("LicenseRef-") ? (names.get(id) ?? id) : id;
    const hit = compiled.forbidden.find((rx) => rx.test(name));
    if (hit) {
      reasons.push(`${name}: forbidden (${hit.source})`);
      return false;
    }
    if (osPackage) return true;
    const kind = compiled.category.get(norm(name));
    if (kind === undefined) {
      if (id.startsWith("LicenseRef-") && compiled.refNames.some((rx) => rx.test(name))) return true;
      reasons.push(`${name}: not in the allow-list`);
      return false;
    }
    if (kind === "gpl" && !compiled.gpl.has(packageName)) {
      reasons.push(`${name}: GPL is allowed only for the tools listed in gplPackages, not for ${packageName || "this component"}`);
      return false;
    }
    return true;
  };
  const evaluate = (node) => {
    if (node.id !== undefined) return idOk(node.id);
    if (node.with) {
      const [base, exception] = node.with;
      const baseOk = idOk(base);
      const exceptionOk = osPackage || compiled.exceptions.has(norm(exception)) || compiled.forbidden.every((rx) => !rx.test(exception));
      if (!exceptionOk) reasons.push(`${exception}: exception not in the allow-list`);
      return baseOk && exceptionOk;
    }
    if (node.and) return node.and.map(evaluate).every(Boolean);
    const results = node.or.map((child) => {
      const before = reasons.length;
      const ok = evaluate(child);
      return { ok, mine: reasons.splice(before) };
    });
    const any = results.some((entry) => entry.ok);
    if (!any) for (const entry of results) reasons.push(...entry.mine);
    return any;
  };
  const ok = evaluate(tree);
  return { ok, reasons: ok ? [] : reasons };
}

const annotationValue = (pkg, prefix) => {
  const found = (pkg.annotations ?? []).find((annotation) => typeof annotation.comment === "string" && annotation.comment.startsWith(prefix));
  return found ? found.comment.slice(prefix.length).trim() : "";
};

/**
 * The licenses gate over a Trivy SPDX JSON document. Components without a declared license are accepted only when the
 * policy says where their license is declared (the tool that embeds them) or resolves them by name with its evidence.
 */
export function checkLicenses({ sbom, policy }) {
  const compiled = compilePolicy(policy);
  const names = new Map((sbom.hasExtractedLicensingInfos ?? []).map((info) => [info.licenseId, info.name ?? info.licenseId]));
  const packages = sbom.packages ?? [];
  const violations = [];
  const counts = {};
  const accepted = { declared: 0, operatingSystem: 0, declaredByTool: 0, resolved: 0 };
  let toolLevelNote = 0;
  for (const pkg of packages) {
    const type = annotationValue(pkg, "PkgType:") || (pkg.primaryPackagePurpose ?? "").toLowerCase();
    const license = (pkg.licenseDeclared && pkg.licenseDeclared !== "NOASSERTION" ? pkg.licenseDeclared : pkg.licenseConcluded) ?? "NOASSERTION";
    const label = `${pkg.name}${pkg.versionInfo ? `@${pkg.versionInfo}` : ""}`;
    const osPackage = compiled.osTypes.has(type);
    const resolved = osPackage ? undefined : compiled.resolved.get(pkg.name);
    if (resolved) {
      // The policy names the license of this component (and why); it replaces what the SBOM could not read.
      const verdict = judgeExpression(resolved.license, compiled, { names, packageName: pkg.name });
      if (verdict.ok) {
        accepted.resolved++;
        counts[resolved.license] = (counts[resolved.license] ?? 0) + 1;
      } else violations.push({ component: label, type, license: resolved.license, kind: "resolved-license-not-allowed", reasons: verdict.reasons });
      continue;
    }
    if (license === "NOASSERTION" || license === "NONE" || license === "") {
      if (osPackage) {
        accepted.operatingSystem++;
        counts["(Debian main, not declared)"] = (counts["(Debian main, not declared)"] ?? 0) + 1;
      } else if (compiled.toolLevel.has(type)) {
        accepted.declaredByTool++;
        toolLevelNote++;
      } else if (["operating-system", "source", "file"].includes(type)) {
        // The SBOM's own root entries (the image, its OS) carry no license.
      } else violations.push({ component: label, type, license: "NOASSERTION", kind: "unknown", reasons: ["no license declared and none resolved by the policy"] });
      continue;
    }
    const verdict = judgeExpression(license, compiled, { names, osPackage, packageName: pkg.name });
    if (verdict.ok) {
      accepted.declared++;
      const key = osPackage ? "(Debian main, per-file licenses)" : license;
      counts[key] = (counts[key] ?? 0) + 1;
    } else violations.push({ component: label, type, license: license.length > 200 ? `${license.slice(0, 200)}...` : license, kind: "not-allowed", reasons: verdict.reasons });
  }
  const byLicense = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
  return {
    gate: "licenses",
    passed: violations.length === 0,
    components: packages.length,
    accepted,
    declaredByToolCount: toolLevelNote,
    byLicense,
    violations,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Forbidden content
// ---------------------------------------------------------------------------------------------------------------------

const SKIP_DIRS = new Set(["/proc", "/sys", "/dev", "/out", "/cache", "/gate"]);

const CREDENTIAL_NAMES = [
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /^\.env(\.(?!example$|sample$|template$|dist$|defaults$).+)?$/,
  /^(credentials|credentials\.json|service[-_]account.*\.json|client_secret.*\.json)$/,
  /\.(pfx|p12|jks|keystore|ovpn)$/,
];
/** Files that are credentials when they hold something: an empty .npmrc (npm ships one) is not. */
const CREDENTIAL_WHEN_FILLED = { ".npmrc": /(_auth|_authToken|_password)\s*=/, ".pypirc": /password\s*[:=]/i, ".netrc": /password\s+\S+/, ".git-credentials": /:\/\/[^\s/]+:[^\s/@]+@/, ".dockercfg": /"auth"\s*:\s*"[^"]+"/, ".htpasswd": /^\S+:\S+/m, ".pgpass": /^[^#\s].*:.+/m };
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/;
const CODEQL_NAME = /^(codeql(-[\w.-]+)?|codeql\.exe|qlpack\.ya?ml|codeql-pack\.lock\.yml)$|\.(ql|qll|qlpack)$/i;
const DATABASE_NAMES = new Set(["trivy.db", "fanal.db", "advisory-db", "trivy-db", "trivy-java-db", "osv-scanner-db", "vulndb", "grype-db"]);
const DATABASE_DIR_PATHS = [/\.cache\/trivy(\/|$)/, /\/cache\/trivy(\/|$)/, /\/\.cargo\/advisory-db(\/|$)/, /\/osv-scanner\/[^/]*\/all\.zip$/];
const SEMGREP_RULES_DIR = /(^|\/)semgrep[-_]rules(\/|$)|(^|\/)semgrep-registry(\/|$)/i;

function looksLikeSemgrepRule(text) {
  return /^rules:\s*$/m.test(text) && /^\s*-\s*id:\s*\S+/m.test(text) && /^\s*message:/m.test(text) && /^\s*(pattern|patterns|pattern-either|pattern-regex|mode):/m.test(text) && /^\s*languages:/m.test(text);
}

/**
 * Walks `root` (a folder of the host or `/` in the image) and returns what must not be shipped. `prefix` is the
 * path the walked folder has in the image (for reports); `allow` lists path prefixes (in image terms) that are exempt:
 * JGates's own semgrep pack and its CLI, which names an adapter `codeql`.
 */
export function scanForbidden(root, { prefix = "", allow = [], allowPatterns = [] } = {}) {
  const findings = [];
  let files = 0;
  const rootAbs = path.resolve(root);
  const imagePath = (absolute) => {
    const rest = absolute.slice(rootAbs.length).replace(/\\/g, "/");
    return (prefix + (rest === "" || rest.startsWith("/") ? rest : `/${rest}`)) || "/";
  };
  const add = (kind, file, detail) => findings.push({ kind, path: imagePath(file), detail });
  const patterns = allowPatterns.map((pattern) => new RegExp(pattern));
  const isAllowed = (shown) => allow.some((entry) => shown === entry || shown.startsWith(entry.endsWith("/") ? entry : `${entry}/`)) || patterns.some((rx) => rx.test(shown));
  const readSmall = (file, limit) => {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > limit) return null;
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  const walk = (dir) => {
    const shownDir = imagePath(dir);
    if (SKIP_DIRS.has(shownDir) || isAllowed(shownDir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const base = path.basename(dir);
    if (DATABASE_NAMES.has(base.toLowerCase())) add("vulnerability-database", dir, `folder ${base}`);
    else if (DATABASE_DIR_PATHS.some((rx) => rx.test(`${shownDir}/`))) add("vulnerability-database", dir, "scanner cache folder");
    if (SEMGREP_RULES_DIR.test(`${shownDir}/`)) add("semgrep-rules", dir, "folder of semgrep rules");
    if (/^codeql(-[\w.-]+)?$/i.test(base)) add("codeql", dir, `folder ${base}`);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files++;
      const name = entry.name;
      const lower = name.toLowerCase();
      const shown = imagePath(full);
      if (isAllowed(shown)) continue;
      if (CODEQL_NAME.test(name)) add("codeql", full, `file ${name}`);
      if (DATABASE_NAMES.has(lower)) add("vulnerability-database", full, `file ${name}`);
      const filled = CREDENTIAL_WHEN_FILLED[lower];
      if (filled) {
        const text = readSmall(full, 256 * 1024);
        if (text !== null && filled.test(text)) add("credential", full, `${name} with credentials in it`);
      } else if (CREDENTIAL_NAMES.some((rx) => rx.test(name))) add("credential", full, `credential-looking file name ${name}`);
      else if (/\.(pem|key)$/i.test(name)) {
        const text = readSmall(full, 64 * 1024);
        if (text !== null && PRIVATE_KEY.test(text)) add("credential", full, "private key");
      }
      if (/\.ya?ml$/i.test(name)) {
        const text = readSmall(full, 512 * 1024);
        if (text !== null && looksLikeSemgrepRule(text)) add("semgrep-rules", full, "semgrep rule file (rules: / id / message / pattern)");
      }
    }
  };
  walk(rootAbs);
  return { gate: "forbidden", scanned: files, findings };
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. Size
// ---------------------------------------------------------------------------------------------------------------------

/** `layers`: [{size, createdBy}] (bytes); `compressedBytes`: what a registry pull transfers. */
export function checkSize({ layers, compressedBytes, budget = DEFAULT_BUDGET }) {
  const uncompressed = layers.reduce((sum, layer) => sum + layer.size, 0);
  const largest = [...layers]
    .sort((a, b) => b.size - a.size)
    .slice(0, 5)
    .map((layer) => ({ sizeBytes: layer.size, size: formatBytes(layer.size), createdBy: String(layer.createdBy ?? "").replace(/\s+/g, " ").slice(0, 160) }));
  const findings = [];
  if (uncompressed > budget.uncompressedBytes) findings.push({ kind: "uncompressed-over-budget", message: `uncompressed size ${formatBytes(uncompressed)} is above the budget of ${formatBytes(budget.uncompressedBytes)}` });
  if (compressedBytes !== undefined && compressedBytes > budget.compressedBytes) findings.push({ kind: "compressed-over-budget", message: `compressed size ${formatBytes(compressedBytes)} is above the budget of ${formatBytes(budget.compressedBytes)}` });
  return { gate: "size", passed: findings.length === 0, uncompressedBytes: uncompressed, compressedBytes: compressedBytes ?? null, budget, findings, largestLayers: largest };
}

export function formatBytes(bytes) {
  return bytes >= GB ? `${(bytes / GB).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. Vulnerabilities of the image
// ---------------------------------------------------------------------------------------------------------------------

/** `report`: Trivy JSON (--format json). A critical finding with a fixed version fails; the others are only counted. */
export function checkScan({ report }) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  const blocking = [];
  for (const result of report.Results ?? []) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      counts[vulnerability.Severity] = (counts[vulnerability.Severity] ?? 0) + 1;
      if (vulnerability.Severity === "CRITICAL" && vulnerability.FixedVersion) {
        blocking.push({ id: vulnerability.VulnerabilityID, package: vulnerability.PkgName, installed: vulnerability.InstalledVersion, fixed: vulnerability.FixedVersion, target: result.Target });
      }
    }
  }
  return { gate: "scan", passed: blocking.length === 0, counts, findings: blocking };
}

// ---------------------------------------------------------------------------------------------------------------------
// 6. Smoke (runs inside the image)
// ---------------------------------------------------------------------------------------------------------------------

const PROFILE_CAPABILITIES = ["file-size", "lint", "secrets", "sast", "dependencies", "duplication", "iac", "unit", "coverage", "pii"];
const git = (cwd, ...args) => spawnSync("git", ["-c", "user.name=JGates", "-c", "user.email=smoke@example.invalid", ...args], { cwd, encoding: "utf8" });

function writeTree(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, ...name.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

const LONG_FILE = (comment) => Array.from({ length: 40 }, (_, i) => `${comment} filler line ${i}`).join("\n") + "\n";

/** The projects of the smoke: per stack a clean one and a known-bad one (a source file above the policy's line budget). */
export function smokeProjects() {
  const python = {
    "pyproject.toml": '[project]\nname = "smoke"\nversion = "0.1.0"\n',
    "pkg/__init__.py": "",
    "pkg/mod.py": "def add(a, b):\n    return a + b\n",
  };
  const typescript = {
    "package.json": '{ "name": "smoke", "version": "1.0.0", "private": true }\n',
    "tsconfig.json": '{ "compilerOptions": { "strict": true, "target": "es2022", "module": "esnext" }, "include": ["src"] }\n',
    "src/index.ts": "export const add = (a: number, b: number): number => a + b;\n",
  };
  return [
    { id: "python-clean", stack: "python", expect: "passed", files: python },
    { id: "python-known-bad", stack: "python", expect: "failed", files: { ...python, "pkg/long.py": LONG_FILE("#") } },
    { id: "typescript-clean", stack: "typescript", expect: "passed", files: typescript },
    { id: "typescript-known-bad", stack: "typescript", expect: "failed", files: { ...typescript, "src/long.ts": LONG_FILE("//") } },
  ];
}

/** Runs inside the image: `jgates ci` on every smoke project, with a policy that bounds a source file to 20 lines. */
export function smokeInImage(work = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-smoke-"))) {
  const results = [];
  const home = path.join(work, "home");
  fs.mkdirSync(home, { recursive: true });
  const policyDir = path.join(work, "policy");
  const checks = PROFILE_CAPABILITIES.map((capability) => `      capability:${capability}:\n        enabled: ${capability === "file-size" || capability === "pii"}\n`).join("");
  writeTree(policyDir, {
    "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/profiles.yml\nselection:\n  profile: gate\n",
    ".jgates/profiles.yml": `schemaVersion: 1\nprofiles:\n  gate:\n    label: gate\n    extends: builtin:minimal\n    checks:\n${checks}`,
    ".jgates/quality-policy.json": `${JSON.stringify({ schemaVersion: 1, budgets: { maxFileLines: 20 } }, null, 2)}\n`,
  });
  const hashProbe = spawnSync("node", ["--input-type=module", "-e", "import { readPolicyBundle } from '/opt/jgates/jgates/dist/core/policy/index.js'; console.log(readPolicyBundle(process.argv[1]).bundle.sha256)", policyDir], { encoding: "utf8" });
  const sha = hashProbe.stdout.trim();
  for (const project of smokeProjects()) {
    const dir = path.join(work, project.id);
    writeTree(dir, project.files);
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "smoke");
    const ran = spawnSync("jgates", ["ci", "--cwd", dir, "--policy", policyDir, "--json"], {
      encoding: "utf8",
      // In the image the bridge starts the quality sidecar's own environment (/opt/tools/python/quality-sidecar) by itself.
      env: { ...process.env, JGATES_HOME: home, JGATES_POLICY_SHA256: sha, NO_COLOR: "1" },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10 * 60_000,
    });
    let document = null;
    try {
      document = JSON.parse(ran.stdout);
    } catch {
      document = null;
    }
    const decision = document?.decision ?? null;
    results.push({ id: project.id, stack: project.stack, expected: project.expect, decision, complete: document?.complete ?? null, exitCode: ran.status, ok: decision === project.expect, unsatisfied: document?.unsatisfied?.slice(0, 6), steps: document?.steps?.map((s) => `${s.id}:${s.status}`).slice(0, 12), error: document ? undefined : (ran.stderr || ran.stdout).slice(0, 400) });
  }
  fs.rmSync(work, { recursive: true, force: true });
  return { gate: "smoke", passed: results.every((r) => r.ok), results };
}

// ---------------------------------------------------------------------------------------------------------------------
// The run against a built image
// ---------------------------------------------------------------------------------------------------------------------

function docker(args, { input, allowFailure = false, timeout = 60 * 60_000 } = {}) {
  const runtime = process.env.JGATES_CONTAINER_RUNTIME || "docker";
  const result = spawnSync(runtime, args, { encoding: "utf8", input, maxBuffer: 1024 * 1024 * 1024, timeout });
  if (result.error) throw new Error(`${runtime} could not start: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) throw new Error(`${runtime} ${args.slice(0, 4).join(" ")} exited with ${result.status}: ${(result.stderr || result.stdout).trim().slice(0, 600)}`);
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

const hostPath = (p) => path.resolve(p);
const MOUNT_SELF = (script) => ["-v", `${hostPath(script)}:/gate/image-gates.mjs:ro`];
const BASE_RUN = ["run", "--rm", "--pull", "never", "--init", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--label", "org.jgates.managed=true", "--label", "org.jgates.kind=helper"];

function writeReport(outDir, name, document) {
  fs.writeFileSync(path.join(outDir, name), `${JSON.stringify(document, null, 2)}\n`);
}

const self = fileURLToPath(import.meta.url);

async function gateVersions({ image, outDir }) {
  const imageJson = JSON.parse(docker([...BASE_RUN, "--network", "none", image, "cat", "/etc/jgates/image.json"]).out);
  const { manifests, satisfiesRange } = await loadManifests();
  const pins = dockerfilePins(fs.readFileSync(path.join(toolsContext, "Dockerfile"), "utf8"));
  const result = checkVersions({ imageJson, manifests, satisfiesRange, pins });
  writeReport(outDir, "image.json", imageJson);
  writeReport(outDir, "versions-report.json", result);
  // The copy the unit test (tests/image-versions.test.js) reads without an engine.
  fs.writeFileSync(path.join(packageRoot, "release", "image-tools.json"), `${JSON.stringify(versionsSnapshot(imageJson), null, 2)}\n`);
  return result;
}

const TRIVY_COMMON = ["--skip-dirs", "/proc,/sys,/dev,/out,/cache,/gate", "--no-progress", "--quiet"];

function trivyRun({ image, outDir, args, memory }) {
  const cache = path.join(outDir, "trivy-cache");
  fs.mkdirSync(cache, { recursive: true });
  return docker([...BASE_RUN, "--tmpfs", "/tmp", "--memory", memory, "-v", `${hostPath(outDir)}:/out`, "-v", `${hostPath(cache)}:/cache`, "-e", "TRIVY_CACHE_DIR=/cache", image, "trivy", "rootfs", ...TRIVY_COMMON, ...args, "/"], { allowFailure: true });
}

async function gateLicenses({ image, outDir }) {
  const sbomPath = path.join(outDir, "sbom.spdx.json");
  fs.rmSync(sbomPath, { force: true });
  const ran = trivyRun({ image, outDir, memory: "4g", args: ["--scanners", "license", "--license-full", "--format", "spdx-json", "--output", "/out/sbom.spdx.json"] });
  if (ran.code !== 0 || !fs.existsSync(sbomPath)) return { gate: "licenses", passed: false, findings: [{ kind: "sbom-failed", message: `Trivy could not write the SBOM: ${ran.err.trim().slice(-600)}` }] };
  const sbom = JSON.parse(fs.readFileSync(sbomPath, "utf8"));
  const result = checkLicenses({ sbom, policy: loadPolicy() });
  writeReport(outDir, "license-report.json", result);
  return result;
}

async function gateScan({ image, outDir }) {
  const reportPath = path.join(outDir, "scan-report.json");
  fs.rmSync(reportPath, { force: true });
  const ran = trivyRun({ image, outDir, memory: "4g", args: ["--scanners", "vuln", "--severity", "CRITICAL,HIGH", "--format", "json", "--output", "/out/scan-report.json"] });
  if (ran.code !== 0 || !fs.existsSync(reportPath)) return { gate: "scan", passed: false, findings: [{ kind: "scan-failed", message: `Trivy could not scan the image: ${ran.err.trim().slice(-600)}` }] };
  return checkScan({ report: JSON.parse(fs.readFileSync(reportPath, "utf8")) });
}

async function gateForbidden({ image, outDir }) {
  const policy = loadPolicy();
  const walked = docker([...BASE_RUN, "--network", "none", "--read-only", "--tmpfs", "/tmp", ...MOUNT_SELF(self), image, "node", "/gate/image-gates.mjs", "scan-forbidden", "/", "--allow", policy.forbiddenContentAllow.join(","), "--allow-patterns", (policy.forbiddenContentAllowPatterns ?? []).map((entry) => entry.pattern).join("|||"), "--gitleaks", policy.gitleaksRoots.join(","), "--apt-main"], { timeout: 60 * 60_000 });
  const result = JSON.parse(walked.out);
  const final = { gate: "forbidden", passed: result.findings.length === 0, scanned: result.scanned, gitleaksRoots: policy.gitleaksRoots, findings: result.findings };
  writeReport(outDir, "forbidden-report.json", final);
  return final;
}
async function gateSize({ image, outDir }) {
  const history = docker(["history", "--no-trunc", "--human=false", "--format", "{{json .}}", image]).out.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const layers = history.map((row) => ({ size: Number(row.Size), createdBy: row.CreatedBy }));
  const inspect = JSON.parse(docker(["image", "inspect", image]).out)[0];
  const result = checkSize({ layers, compressedBytes: inspect.Size });
  writeReport(outDir, "size-report.json", result);
  return result;
}

async function gateSmoke({ image, outDir }) {
  const ran = docker([...BASE_RUN, "--network", "none", "--read-only", "--tmpfs", "/tmp:exec,uid=10001,gid=10001", "--memory", "4g", ...MOUNT_SELF(self), image, "node", "/gate/image-gates.mjs", "smoke"], { allowFailure: true });
  let result;
  try {
    result = JSON.parse(ran.out);
  } catch {
    result = { gate: "smoke", passed: false, results: [], findings: [{ kind: "smoke-failed", message: (ran.err || ran.out).slice(-600) }] };
  }
  writeReport(outDir, "smoke-report.json", result);
  return result;
}

export const GATES = { versions: gateVersions, licenses: gateLicenses, forbidden: gateForbidden, size: gateSize, scan: gateScan, smoke: gateSmoke };

/** Runs the gates (all of them, in order, even after a failure) and writes `gates-report.json`. */
export async function runGates({ image = "jgates-tools:dev", outDir = DEFAULT_OUT, only } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const names = only?.length ? only : Object.keys(GATES);
  const results = [];
  for (const name of names) {
    const started = Date.now();
    let result;
    try {
      result = await GATES[name]({ image, outDir });
    } catch (error) {
      result = { gate: name, passed: false, findings: [{ kind: "gate-error", message: error.message }] };
    }
    result.seconds = Math.round((Date.now() - started) / 1000);
    results.push(result);
    console.log(`image:gates: ${name} ${result.passed ? "passed" : "FAILED"} (${result.seconds} s)`);
    if (!result.passed) printFailure(result);
  }
  const summary = { image, passed: results.every((r) => r.passed), gates: results.map((r) => ({ gate: r.gate, passed: r.passed, seconds: r.seconds })), outDir };
  writeReport(outDir, "gates-report.json", { ...summary, results });
  return summary;
}

function printFailure(result) {
  const lines = [];
  for (const item of (result.findings ?? []).slice(0, 15)) lines.push(`  - ${item.message ?? `${item.kind} ${item.path ?? item.id ?? ""} ${item.detail ?? ""}`}`);
  for (const item of (result.violations ?? []).slice(0, 15)) lines.push(`  - ${item.component} [${item.license}]: ${item.reasons.join("; ")}`);
  for (const item of (result.results ?? []).filter((r) => !r.ok)) lines.push(`  - ${item.id}: expected ${item.expected}, got ${item.decision} (exit ${item.exitCode}) ${item.error ?? ""}`);
  if (result.largestLayers) for (const layer of result.largestLayers) lines.push(`  - layer ${layer.size}: ${layer.createdBy}`);
  console.error(`image:gates: ${result.gate} failed:\n${lines.join("\n")}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Checks that run inside the image next to the walk: gitleaks and the Debian archive section
// ---------------------------------------------------------------------------------------------------------------------

/** gitleaks (the image's own) over the folders where a credential could be left; leaks are redacted in the report. */
export function gitleaksFindings(roots, run = spawnSync) {
  const findings = [];
  for (const root of roots) {
    try {
      fs.accessSync(root, fs.constants.R_OK | fs.constants.X_OK);
    } catch {
      continue; // a folder the step user cannot read (such as /root) cannot be read by a step either
    }
    const report = path.join(os.tmpdir(), `gitleaks-${process.pid}-${crypto.randomBytes(4).toString("hex")}.json`);
    const ran = run("gitleaks", ["dir", root, "--no-banner", "--redact=100", "--exit-code", "3", "--report-format", "json", "--report-path", report], { encoding: "utf8", env: { ...process.env, HOME: os.tmpdir() } });
    if (ran.status === 3) {
      for (const leak of JSON.parse(fs.readFileSync(report, "utf8"))) findings.push({ kind: "credential", path: leak.File, detail: `gitleaks ${leak.RuleID}` });
    } else if (ran.status !== 0) findings.push({ kind: "gitleaks-error", path: root, detail: `gitleaks exited with ${ran.status}: ${(ran.stderr ?? "").slice(0, 200)}` });
    fs.rmSync(report, { force: true });
  }
  return findings;
}

/** Installed Debian packages outside `main` (Section contrib/ or non-free/): the license rule for OS packages needs main only. */
export function nonMainPackages(run = spawnSync) {
  const ran = run("dpkg-query", ["-W", "-f", "${Package} ${Section}\\n"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (ran.status !== 0) return [{ kind: "apt-section", path: "dpkg-query", detail: `dpkg-query failed: ${(ran.stderr ?? "").slice(0, 200)}` }];
  return ran.stdout
    .split("\n")
    .filter((line) => /\s(contrib|non-free|non-free-firmware)\//.test(line))
    .map((line) => ({ kind: "apt-section", path: line.split(" ")[0], detail: `not in Debian main: ${line.split(" ")[1]}` }));
}
// ---------------------------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------------------------

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "scan-forbidden") {
    const allow = (option(rest, "allow") ?? "").split(",").filter(Boolean);
    const allowPatterns = (option(rest, "allow-patterns") ?? "").split("|||").filter(Boolean);
    const result = scanForbidden(rest[0] ?? "/", { allow, allowPatterns });
    const roots = (option(rest, "gitleaks") ?? "").split(",").filter(Boolean);
    result.findings.push(...gitleaksFindings(roots));
    if (rest.includes("--apt-main")) result.findings.push(...nonMainPackages());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (command === "smoke") {
    process.stdout.write(`${JSON.stringify(smokeInImage())}\n`);
  } else if (command === "run") {
    const only = option(rest, "only")?.split(",");
    const summary = await runGates({ image: option(rest, "image") ?? "jgates-tools:dev", outDir: option(rest, "out") ?? DEFAULT_OUT, only });
    process.exitCode = summary.passed ? 0 : 1;
  } else {
    console.error("usage: image-gates.mjs run [--image <ref>] [--out <dir>] [--only gate,gate] | scan-forbidden <root> [--allow a,b] | smoke");
    process.exitCode = 2;
  }
}
