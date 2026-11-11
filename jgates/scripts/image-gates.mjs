// The gates of PLAN-image.md section 5, run on every image build (image-build.mjs calls runGates) and testable one by one:
//   versions   /etc/jgates/image.json matches the pins of the Dockerfile and every adapter's toolVersionRange accepts
//              the shipped version;
//   licenses   an SPDX SBOM of the image made by the image's own Trivy, every component checked against
//              docker/tools/license-policy.json (AGPL and unknown licenses fail);
//   forbidden  no official semgrep rules, no CodeQL, no vulnerability database, no credential-looking file (a walk of
//              the image filesystem plus gitleaks over the places a credential could be left);
//   size       at most 7 GB uncompressed and 3 GB compressed; above it the five largest layers are listed;
//   scan       Trivy vulnerability scan of the image filesystem; a critical finding with a fix fails;
//   smoke      `jgates ci` in `in-image` mode on a known-bad and a clean project of every validated row of the matrix
//              (JGATES_SMOKE_GROUPS=a,b runs only those groups; JGATES_SMOKE_DIST mounts a working-tree build).
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
// `jgates ci` in `in-image` mode on a known-bad and a clean project of every validated row of the capability-by-stack
// matrix (core/matrix), so the tools the plan names are the ones of the image and the adapters run natively, under the
// governed path. A group is one tool configuration (templates of the policy, settings of tools.yml) with its two
// projects; it covers the rows it names. Every validated row must be covered by a group or be listed with the reason it
// cannot run in an offline container without services (SMOKE_EXEMPT), or belong to an adapter that a policy is refused
// from using by design (the trust table: excluded). A row with none of the three fails the gate before anything runs.

const PROFILE_CAPABILITIES = ["file-size", "lint", "secrets", "sast", "dependencies", "duplication", "iac", "unit", "coverage", "pii", "typecheck", "format-check", "integration", "properties", "tests", "mutation", "performance", "migration", "ci-cd", "supply-chain"];
const git = (cwd, ...args) => spawnSync("git", ["-c", "user.name=JGates", "-c", "user.email=smoke@example.invalid", ...args], { cwd, encoding: "utf8" });

function writeTree(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, ...name.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

const LONG_FILE = (comment) => Array.from({ length: 40 }, (_, i) => `${comment} filler line ${i}`).join("\n") + "\n";

/** The projects of the bridge's file-size subcheck (the legacy quality gate, kept by the governed path): per stack a clean one and a known-bad one. */
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

const PY = '[project]\nname = "demo"\nversion = "0.1.0"\n';
const GO_MOD = "module example.com/demo\n\ngo 1.21\n";
const NPM_PKG = (extra = "") => `{ "name": "demo", "version": "1.0.0", "private": true${extra} }\n`;

/**
 * The groups. `covers`: the matrix rows (`adapter#capability@stack`) the group proves; `templates`: built-in templates the
 * policy switches on (activation always: the policy folder holds no evidence); `tools`: tools.yml text added to the
 * policy; `caps`: the capabilities the policy's profile switches on (the others are off); `bad` and `clean`: a fixture
 * folder under tests/fixtures (`copy`) or inline `files`; `minimum`: the coverage minimum of the policy.
 */
const rowsOf = (adapter, caps, stacks) => caps.flatMap((cap) => stacks.map((stack) => `${adapter}#${cap}@${stack}`));
const tools = (id, adapter, caps, extra = "") => `schemaVersion: 1\ntools:\n  ${id}:\n    adapter: ${adapter}\n    capabilities: [${caps.join(", ")}]\n${extra}`;
const TESTS_CAPS = ["unit", "coverage", "integration", "properties"];

export const SMOKE_GROUPS = [
  {
    id: "file-size",
    caps: ["file-size"],
    covers: rowsOf("file-size", ["file-size"], ["any"]),
    tools: tools("file-size", "file-size", ["file-size"], "    maxLines: 20\n"),
    bad: { files: { "src/long.txt": LONG_FILE("#"), "README.md": "demo\n" } },
    clean: { files: { "src/short.txt": "one\n", "README.md": "demo\n" } },
  },
  {
    id: "pii",
    caps: ["pii"],
    covers: rowsOf("builtin-pii", ["pii"], ["any"]),
    bad: { files: { "README.md": "demo\n", "data/people.txt": "customer document 529.982.247-25 on file\n" } },
    clean: { files: { "README.md": "demo\n", "data/people.txt": "customer document on file\n" } },
  },
  {
    id: "ruff",
    caps: ["lint"],
    covers: rowsOf("ruff", ["lint"], ["python"]),
    templates: ["python"],
    bad: { files: { "pyproject.toml": PY, "app/__init__.py": "", "app/core.py": "import os\n\n\ndef double(value):\n    return value * 2\n" } },
    clean: { files: { "pyproject.toml": PY, "app/__init__.py": "", "app/core.py": "def double(value):\n    return value * 2\n" } },
  },
  {
    id: "semgrep",
    caps: ["sast"],
    covers: rowsOf("semgrep", ["sast"], ["python", "javascript", "typescript"]),
    tools: tools("semgrep", "semgrep", ["sast"], "    rulePack: jgates\n"),
    bad: { copy: "semgrep-pack/vulnerable" },
    clean: { copy: "semgrep-pack/clean" },
  },
  { id: "zizmor", caps: ["ci-cd"], covers: rowsOf("zizmor", ["ci-cd"], ["any"]), templates: ["github-actions-zizmor"], bad: { copy: "zizmor/injection" }, clean: { copy: "zizmor/clean" } },
  {
    id: "supply-chain",
    caps: ["supply-chain"],
    covers: rowsOf("supply-chain", ["supply-chain"], ["any"]),
    templates: ["supply-chain"],
    tools: tools("supply-chain", "supply-chain", ["supply-chain"], "    blockOn: low\n"),
    bad: { copy: "supply-chain/npm-risky" },
    clean: { copy: "supply-chain/npm-clean" },
  },
  { id: "build-typescript", caps: ["typecheck"], covers: rowsOf("build-check", ["typecheck"], ["typescript"]), templates: ["typescript-tsc"], bad: { copy: "build-check/typescript/bad" }, clean: { copy: "build-check/typescript/clean" } },
  { id: "build-python", caps: ["typecheck"], covers: rowsOf("build-check", ["typecheck"], ["python"]), templates: ["python-mypy-defaults"], bad: { copy: "build-check/python/bad" }, clean: { copy: "build-check/python/clean" } },
  { id: "build-go", caps: ["typecheck"], covers: rowsOf("build-check", ["typecheck"], ["go"]), templates: ["go-build"], bad: { copy: "build-check/go/bad" }, clean: { copy: "build-check/go/clean" } },
  { id: "build-rust", caps: ["typecheck"], covers: rowsOf("build-check", ["typecheck"], ["rust"]), templates: ["rust-cargo-check"], bad: { copy: "build-check/rust/bad" }, clean: { copy: "build-check/rust/clean" } },
  { id: "build-csharp", caps: ["typecheck"], covers: rowsOf("build-check", ["typecheck"], ["csharp"]), templates: ["dotnet-build"], bad: { copy: "build-check/csharp/bad" }, clean: { copy: "build-check/csharp/clean" } },
  { id: "format-python", caps: ["format-check"], covers: rowsOf("format-check", ["format-check"], ["python"]), templates: ["python-format"], bad: { copy: "format-check/python/bad" }, clean: { copy: "format-check/python/clean" } },
  { id: "format-typescript", caps: ["format-check"], covers: rowsOf("format-check", ["format-check"], ["typescript"]), templates: ["typescript-prettier"], bad: { copy: "format-check/typescript/bad" }, clean: { copy: "format-check/typescript/clean" } },
  { id: "format-go", caps: ["format-check"], covers: rowsOf("format-check", ["format-check"], ["go"]), templates: ["go-gofmt"], bad: { copy: "format-check/go/bad" }, clean: { copy: "format-check/go/clean" } },
  { id: "format-rust", caps: ["format-check"], covers: rowsOf("format-check", ["format-check"], ["rust"]), templates: ["rust-rustfmt"], bad: { copy: "format-check/rust/bad" }, clean: { copy: "format-check/rust/clean" } },
  { id: "format-csharp", caps: ["format-check"], covers: rowsOf("format-check", ["format-check"], ["csharp"]), templates: ["dotnet-format"], bad: { copy: "format-check/csharp/bad" }, clean: { copy: "format-check/csharp/clean" } },
  { id: "lint-go", caps: ["lint"], covers: rowsOf("golangci-lint", ["lint"], ["go"]), templates: ["go-golangci-lint"], bad: { copy: "lint-stacks/go/bad" }, clean: { copy: "lint-stacks/go/clean" } },
  { id: "lint-rust", caps: ["lint"], covers: rowsOf("clippy", ["lint"], ["rust"]), templates: ["rust-clippy"], bad: { copy: "lint-stacks/rust/bad" }, clean: { copy: "lint-stacks/rust/clean" } },
  { id: "lint-csharp", caps: ["lint"], covers: rowsOf("dotnet-analyzers", ["lint"], ["csharp"]), templates: ["dotnet-analyzers"], bad: { copy: "lint-stacks/csharp/bad" }, clean: { copy: "lint-stacks/csharp/clean" } },
  { id: "lint-shell", caps: ["lint"], covers: rowsOf("shellcheck", ["lint"], ["any"]), templates: ["shell-shellcheck"], bad: { copy: "lint-stacks/shell/bad" }, clean: { copy: "lint-stacks/shell/clean" } },
  { id: "lint-docker", caps: ["lint"], covers: rowsOf("hadolint", ["lint"], ["any"]), templates: ["docker-hadolint"], bad: { copy: "lint-stacks/docker/bad" }, clean: { copy: "lint-stacks/docker/clean" } },
  {
    id: "tests-go",
    caps: ["unit", "coverage", "integration"],
    covers: rowsOf("go-test", ["unit", "coverage", "integration"], ["go"]),
    templates: ["go-test"],
    minimum: 80,
    bad: { files: {"go.mod":"module example.com/calc\n\ngo 1.21\n","calc.go":"package calc\n\nfunc Add(a, b int) int { return a - b }\n\nfunc Abs(a int) int {\n\tif a < 0 {\n\t\treturn -a\n\t}\n\treturn a\n}\n\nfunc Mul(a, b int) int { return a * b }\n\nfunc Div(a, b int) int { return a / b }\n\nfunc Neg(a int) int { return -a }\n","calc_test.go":"package calc\n\nimport \"testing\"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatal(\"Add(2, 3) is not 5\")\n\t}\n}\n\nfunc TestAbs(t *testing.T) {\n\tif Abs(-4) != 4 || Abs(4) != 4 {\n\t\tt.Fatal(\"Abs is wrong\")\n\t}\n}\n","integration_test.go":"//go:build integration\n\npackage calc\n\nimport \"testing\"\n\nfunc TestIntegrationAdd(t *testing.T) {\n\tif Add(1, 1) != 2 {\n\t\tt.Fatal(\"Add(1, 1) is not 2\")\n\t}\n}\n"} },
    clean: { files: {"go.mod":"module example.com/calc\n\ngo 1.21\n","calc.go":"package calc\n\nfunc Add(a, b int) int { return a + b }\n\nfunc Abs(a int) int {\n\tif a < 0 {\n\t\treturn -a\n\t}\n\treturn a\n}\n","calc_test.go":"package calc\n\nimport \"testing\"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatal(\"Add(2, 3) is not 5\")\n\t}\n}\n\nfunc TestAbs(t *testing.T) {\n\tif Abs(-4) != 4 || Abs(4) != 4 {\n\t\tt.Fatal(\"Abs is wrong\")\n\t}\n}\n","integration_test.go":"//go:build integration\n\npackage calc\n\nimport \"testing\"\n\nfunc TestIntegrationAdd(t *testing.T) {\n\tif Add(1, 1) != 2 {\n\t\tt.Fatal(\"Add(1, 1) is not 2\")\n\t}\n}\n"} },
  },
  {
    id: "tests-rust",
    caps: ["unit", "coverage", "integration", "tests"],
    covers: [...rowsOf("cargo-test", ["unit", "coverage", "integration"], ["rust"]), "cargo-test#tests@rust"],
    templates: ["rust-cargo-test"],
    tools: tools("cargo-test-suite", "cargo-test", ["tests"]),
    minimum: 80,
    bad: { files: {"Cargo.toml":"[package]\nname = \"calc\"\nversion = \"0.1.0\"\nedition = \"2021\"\n","Cargo.lock":"version = 3\n\n[[package]]\nname = \"calc\"\nversion = \"0.1.0\"\n","src/lib.rs":"pub fn add(a: i32, b: i32) -> i32 {\n    a - b\n}\n\npub fn abs(a: i32) -> i32 {\n    if a < 0 {\n        -a\n    } else {\n        a\n    }\n}\n\npub fn mul(a: i32, b: i32) -> i32 {\n    a * b\n}\n\npub fn neg(a: i32) -> i32 {\n    -a\n}\n\npub fn twice(a: i32) -> i32 {\n    a * 2\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn adds_two_numbers() {\n        assert_eq!(add(2, 3), 5);\n    }\n\n    #[test]\n    fn absolute_value() {\n        assert_eq!(abs(-4), 4);\n        assert_eq!(abs(4), 4);\n    }\n}\n","tests/store.rs":"use calc::add;\n\n#[test]\nfn integration_adds() {\n    assert_eq!(add(1, 1), 2);\n}\n"} },
    clean: { files: {"Cargo.toml":"[package]\nname = \"calc\"\nversion = \"0.1.0\"\nedition = \"2021\"\n","Cargo.lock":"version = 3\n\n[[package]]\nname = \"calc\"\nversion = \"0.1.0\"\n","src/lib.rs":"pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\npub fn abs(a: i32) -> i32 {\n    if a < 0 {\n        -a\n    } else {\n        a\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn adds_two_numbers() {\n        assert_eq!(add(2, 3), 5);\n    }\n\n    #[test]\n    fn absolute_value() {\n        assert_eq!(abs(-4), 4);\n        assert_eq!(abs(4), 4);\n    }\n}\n","tests/store.rs":"use calc::add;\n\n#[test]\nfn integration_adds() {\n    assert_eq!(add(1, 1), 2);\n}\n"} },
  },
  {
    id: "tests-python",
    caps: TESTS_CAPS,
    covers: rowsOf("pytest", TESTS_CAPS, ["python"]),
    templates: ["python-pytest"],
    minimum: 80,
    bad: { copy: "test-stacks/python/clean", overlay: { "tests/unit/test_failing.py": "def test_fails():\n    assert 1 == 2\n" } },
    clean: { copy: "test-stacks/python/clean" },
  },
  {
    id: "tests-vitest",
    caps: ["unit", "coverage", "integration"],
    covers: rowsOf("vitest", ["unit", "coverage", "integration"], ["typescript"]),
    templates: ["typescript-vitest"],
    minimum: 80,
    // The fixture's property test needs fast-check, a dependency of the project: plain tests stand in for it.
    bad: { copy: "test-stacks/vitest/clean", overlay: { "src/calc.test.ts": "import { add } from \"./calc\";\n\ntest(\"adds two numbers\", () => {\n  expect(add(2, 3)).toBe(6);\n});\n" } },
    clean: { copy: "test-stacks/vitest/clean", overlay: { "src/calc.test.ts": "import { absolute, add } from \"./calc\";\n\ntest(\"adds two numbers\", () => {\n  expect(add(2, 3)).toBe(5);\n});\n\ntest(\"absolute value\", () => {\n  expect(absolute(-4)).toBe(4);\n  expect(absolute(4)).toBe(4);\n});\n" } },
  },
  {
    id: "eslint",
    caps: ["lint"],
    covers: rowsOf("eslint", ["lint"], ["typescript"]),
    // The policy binds the configuration (a file of the policy folder); plain rules need no plugin from the project.
    tools: tools("eslint", "eslint", ["lint"], "    config: eslint.config.mjs\n"),
    policyFiles: { "eslint.config.mjs": 'export default [{ files: ["**/*.js"], rules: { "no-var": "error" } }];\n' },
    bad: { files: { "package.json": NPM_PKG(), "src/index.js": "var total = 1;\nconsole.log(total);\n" } },
    clean: { files: { "package.json": NPM_PKG(), "src/index.js": "const total = 1;\nconsole.log(total);\n" } },
  },
  {
    id: "performance-go",
    caps: ["performance"],
    covers: rowsOf("performance", ["performance"], ["go"]),
    templates: ["go-bench"],
    tools: tools("go-bench", "performance", ["performance"], "    harness: go-bench\n    budgets:\n      \"*BenchmarkFib20\": 5\n"),
    bad: { copy: "e2e-migration-performance/perf-go/bad" },
    clean: { copy: "e2e-migration-performance/perf-go/clean" },
  },
  {
    id: "migration-squawk",
    caps: ["migration"],
    covers: rowsOf("migration-drift", ["migration"], ["any"]),
    templates: ["sql-squawk"],
    bad: { copy: "e2e-migration-performance/migration-squawk/bad" },
    clean: { copy: "e2e-migration-performance/migration-squawk/clean" },
  },
  {
    id: "mutation-python",
    caps: ["mutation"],
    covers: rowsOf("mutation", ["mutation"], ["python"]),
    tools: tools("mutation", "mutation", ["mutation"], "    engine: mutmut\n    minimumScore: 90\n"),
    bad: { copy: "mutation/py" },
    clean: { copy: ["mutation/py", "mutation/py-strong"] },
  },
  {
    id: "oasdiff",
    caps: ["api-compatibility"],
    covers: rowsOf("oasdiff", ["api-compatibility"], ["any"]),
    templates: ["openapi-oasdiff"],
    tools: tools("oasdiff", "oasdiff", ["api-compatibility"], "    spec: openapi.yaml\n    baseSpec: base/openapi.yaml\n"),
    bad: { copy: ["oasdiff/removed", { from: "oasdiff/base", to: "base" }] },
    clean: { copy: ["oasdiff/additive", { from: "oasdiff/base", to: "base" }] },
  },
  {
    id: "performance-typescript",
    caps: ["performance"],
    covers: rowsOf("performance", ["performance"], ["typescript", "javascript"]),
    templates: ["typescript-vitest-bench"],
    tools: tools("vitest-bench", "performance", ["performance"], "    harness: vitest-bench\n    budgets:\n      \"*fib(20)\": 5\n"),
    bad: { copy: "e2e-migration-performance/perf-ts/bad" },
    clean: { copy: "e2e-migration-performance/perf-ts/clean" },
  },
  {
    id: "mutation-javascript",
    caps: ["mutation"],
    covers: rowsOf("mutation", ["mutation"], ["javascript"]),
    tools: tools("mutation", "mutation", ["mutation"], "    engine: stryker\n    minimumScore: 90\n"),
    bad: { copy: "mutation/js" },
    clean: { copy: ["mutation/js", "mutation/js-strong"] },
  },
];

/** Rows that cannot run through `jgates ci` in an offline container with no services, each with the reason. */
export const SMOKE_EXEMPT = {
  "go-test#properties@go": "the property library (rapid) is a dependency of the project, installed by the dependencies phase",
  "cargo-test#properties@rust": "the property library (proptest) is a dependency of the project, installed by the dependencies phase",
  "vitest#properties@typescript": "the property library (fast-check) is a dependency of the project, installed by the dependencies phase",
  "dotnet-test#unit@csharp": "dotnet test restores the project's NuGet packages: needs the dependency volume or the network",
  "dotnet-test#coverage@csharp": "dotnet test restores the project's NuGet packages: needs the dependency volume or the network",
  "dotnet-test#integration@csharp": "dotnet test restores the project's NuGet packages: needs the dependency volume or the network",
  "dotnet-test#properties@csharp": "dotnet test restores the project's NuGet packages: needs the dependency volume or the network",
  "jest#unit@javascript": "Jest is the project's own dev dependency, installed into the dependency volume by the dependencies phase",
  "jest#coverage@javascript": "Jest is the project's own dev dependency, installed into the dependency volume by the dependencies phase",
  "jest#integration@javascript": "Jest is the project's own dev dependency, installed into the dependency volume by the dependencies phase",
  "jest#properties@javascript": "Jest is the project's own dev dependency, installed into the dependency volume by the dependencies phase",
  "schemathesis#api-contract@any": "needs a running target service",
  "zap#dast@any": "needs a running target service",
  "govulncheck#dependencies@go": "needs the advisory data volume (jgates-data), which an offline container does not have",
  "dotnet-vulnerable#dependencies@csharp": "asks the NuGet sources for advisories: needs the network",
  "mutation#mutation@csharp": "mutation testing runs the suite per mutant (minutes); covered by the real-engine suite",
  "playwright#e2e@typescript": "needs the project's compose services and browsers",
  "playwright#e2e@javascript": "needs the project's compose services and browsers",
  "playwright#e2e@python": "needs the project's compose services and browsers",
  "migration-drift#migration@python": "needs the project's database service",
  "migration-drift#migration@typescript": "needs the project's database service",
  "migration-drift#migration@javascript": "needs the project's database service",
  "migration-drift#migration@csharp": "needs the project's database service",
  "performance#performance@python": "pytest-benchmark runs on the project's own pytest, a dependency installed by the dependencies phase into the dependency volume",
  "performance#performance@rust": "criterion is a crate of the project: it needs the dependency volume or the network",
  "performance#performance@csharp": "BenchmarkDotNet is a NuGet package of the project: it needs the dependency volume or the network",
};

/** Rows of the legacy quality gate's bridge, kept by the governed path and proven by the file-size projects. */
const BRIDGE_ROWS = new Set(["quality-bridge#file-size@any"]);

/**
 * Which validated rows each part of the smoke covers. `rows`: the matrix rows (`{key, adapter, state}`); `trust`: the
 * trust table (adapter -> {treatment}). Returns the rows with no group and no reason (`missing`), the rows of adapters a
 * policy is refused from using (`refused`), the exempt ones and the unknown names in the tables (`stale`).
 */
export function smokeCoverage({ rows, trust, groups = SMOKE_GROUPS, exempt = SMOKE_EXEMPT }) {
  const validated = rows.filter((row) => row.state === "validated");
  const covered = new Set([...groups.flatMap((group) => group.covers), ...BRIDGE_ROWS]);
  const refused = [];
  const exemptRows = [];
  const missing = [];
  for (const row of validated) {
    if (covered.has(row.key)) continue;
    if (trust[row.adapter]?.treatment === "excluded") refused.push({ key: row.key, reason: "the trust table refuses it under jgates ci (it reads configuration from the analyzed tree)" });
    else if (exempt[row.key]) exemptRows.push({ key: row.key, reason: exempt[row.key] });
    else missing.push(row.key);
  }
  const known = new Set(validated.map((row) => row.key));
  const stale = [...groups.flatMap((group) => group.covers), ...Object.keys(exempt)].filter((key) => !known.has(key));
  return { missing, refused, exempt: exemptRows, stale: [...new Set(stale)] };
}

function copyFixture(root, relative, target) {
  fs.cpSync(path.join(root, ...relative.split("/")), target, { recursive: true });
}

/** Writes the project of one side (bad or clean) of a group. */
function writeProject(dir, side, fixtures) {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of [side.copy ?? []].flat()) {
    const { from, to } = typeof entry === "string" ? { from: entry, to: "." } : entry;
    copyFixture(fixtures, from, path.join(dir, ...to.split("/")));
  }
  if (side.files) writeTree(dir, side.files);
  if (side.overlay) writeTree(dir, side.overlay);
}

/** The policy folder of a group: jgates.yml with the templates, the profile that switches on only the group's capabilities, tools.yml, policy.yml and the quality policy. */
function writePolicy(dir, group) {
  // jgates ci always keeps the quality gate's file-size budgets on (POLICY_BUDGETS_DISABLED otherwise).
  const on = new Set(["file-size", ...group.caps]);
  const checks = [...new Set([...PROFILE_CAPABILITIES, ...group.caps])].map((capability) => `      capability:${capability}:\n        enabled: ${on.has(capability)}\n`).join("");
  const templates = [{ id: "base", source: "builtin:base", activation: "always" }, ...(group.templates ?? []).map((id) => ({ id, source: `builtin:${id}`, activation: "always" }))];
  const list = templates.map((t) => `  - id: ${t.id}\n    source: ${t.source}\n    activation: ${t.activation}\n`).join("");
  const files = {
    "jgates.yml": `schemaVersion: 2\nextends:\n  - .jgates/profiles.yml\nselection:\n  profile: gate\ntemplates:\n${list}`,
    ".jgates/profiles.yml": `schemaVersion: 1\nprofiles:\n  gate:\n    label: gate\n    extends: builtin:minimal\n    checks:\n${checks}`,
    ".jgates/quality-policy.json": `${JSON.stringify({ schemaVersion: 1, budgets: { maxFileLines: 5000 } }, null, 2)}\n`,
  };
  if (group.tools) files[".jgates/tools.yml"] = group.tools;
  Object.assign(files, group.policyFiles ?? {});
  if (group.minimum) files[".jgates/policy.yml"] = `schemaVersion: 1\nrules:\n  coverage.minimum:\n    threshold: ${group.minimum}\n`;
  writeTree(dir, files);
}

function policyHash(policyDir) {
  const probe = spawnSync("node", ["--input-type=module", "-e", "import { readPolicyBundle } from '/opt/jgates/jgates/dist/core/policy/index.js'; console.log(readPolicyBundle(process.argv[1]).bundle.sha256)", policyDir], { encoding: "utf8" });
  return probe.stdout.trim();
}

function runCi(dir, policyDir, home, timeout) {
  const ran = spawnSync("jgates", ["ci", "--cwd", dir, "--policy", policyDir, "--json"], {
    encoding: "utf8",
    // In the image the adapters run natively and the bridge starts the quality sidecar's own environment (/opt/tools/python/quality-sidecar).
    env: { ...process.env, JGATES_HOME: home, JGATES_POLICY_SHA256: policyHash(policyDir), NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
  let document = null;
  try {
    document = JSON.parse(ran.stdout);
  } catch {
    document = null;
  }
  return { ran, document };
}

/** Stages that count as done: the check ran, or it did not apply (nothing to run in this project), or it was switched off. */
const SETTLED = new Set(["completed", "not_applicable", "disabled", "skipped"]);

/**
 * Judges one project. The known-bad side must fail with a finding of the adapters the group proves; the clean side must
 * have none, with every stage of those adapters settled and at least one completed (a tool that errors, is blocked or is
 * missing is never a pass). An "incomplete" decision is fine on the clean side only because a self-reported adapter never
 * satisfies a requirement under jgates ci: it can fail the run, and that is what the bad side shows.
 */
const summarize = (project, ran, document, expected, adapters = null) => {
  const decision = document?.decision ?? null;
  const stages = (document?.stages ?? []).filter((s) => s.kind !== "composite");
  const ownStages = adapters ? stages.filter((s) => adapters.includes(s.adapter)) : stages;
  const findings = document?.findings ?? [];
  const ownFindings = adapters ? findings.filter((f) => adapters.includes(f.origin) || adapters.includes(f.tool)) : findings;
  const unsettled = ownStages.filter((s) => !SETTLED.has(s.state));
  const ok =
    expected === "failed"
      ? decision === "failed" && ownFindings.length > 0
      : (decision === "passed" || decision === "incomplete") && findings.length === 0 && unsettled.length === 0 && ownStages.some((s) => s.state === "completed");
  return {
    id: project,
    expected,
    decision,
    complete: document?.complete ?? null,
    exitCode: ran.status,
    ok,
    stages: ownStages.map((s) => s.id + ":" + s.state),
    unsettled: unsettled.map((s) => s.id + ":" + s.state + ":" + String(s.reason ?? "").slice(0, 240)),
    findings: ownFindings.slice(0, 3).map((f) => (f.tool ?? f.origin) + ":" + (f.ruleId ?? "?") + ":" + (f.location?.path ?? "?") + " " + String(f.message ?? "").slice(0, 120)),
    error: document ? (decision ? undefined : (document.code ?? "") + " " + (document.message ?? "") + " " + (document.detail ?? "")) : (ran.stderr || ran.stdout).slice(0, 400),
  };
};

/**
 * Runs inside the image: `jgates ci` on every smoke project. `groups` and `fixtures` come from the host (the groups
 * file and the read-only mount of tests/fixtures); `only` names the group ids to run (all by default).
 */
export function smokeInImage({ groups = SMOKE_GROUPS, fixtures = "/fixtures", only, work = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-smoke-")) } = {}) {
  const results = [];
  const home = path.join(work, "home");
  fs.mkdirSync(home, { recursive: true });
  // 1. The legacy bridge's file-size subcheck and the PII scan: per stack a clean and a known-bad project, with a budget of 20 lines.
  const budgetPolicy = path.join(work, "policy-budget");
  const bridgeGroup = { id: "bridge", caps: ["file-size", "pii"] };
  writePolicy(budgetPolicy, bridgeGroup);
  fs.writeFileSync(path.join(budgetPolicy, ".jgates", "quality-policy.json"), `${JSON.stringify({ schemaVersion: 1, budgets: { maxFileLines: 20 } }, null, 2)}\n`);
  if (!only || only.includes("bridge")) {
    for (const project of smokeProjects()) {
      const dir = path.join(work, project.id);
      writeTree(dir, project.files);
      git(dir, "init", "-q");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "smoke");
      const { ran, document } = runCi(dir, budgetPolicy, home, 10 * 60_000);
      results.push({ ...summarize(`bridge/${project.id}`, ran, document, project.expect, ["quality-bridge"]), stack: project.stack });
    }
  }
  // 2. The groups of the matrix rows.
  for (const group of groups) {
    if (only && !only.includes(group.id)) continue;
    const policyDir = path.join(work, `policy-${group.id}`);
    writePolicy(policyDir, group);
    for (const [side, expected] of [["bad", "failed"], ["clean", "passed"]]) {
      const dir = path.join(work, `${group.id}-${side}`);
      writeProject(dir, group[side], fixtures);
      git(dir, "init", "-q");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "smoke");
      const started = Date.now();
      const { ran, document } = runCi(dir, policyDir, home, 20 * 60_000);
      results.push({ ...summarize(`${group.id}/${side}`, ran, document, expected, [...new Set(group.covers.map((row) => row.split("#")[0]))]), group: group.id, seconds: Math.round((Date.now() - started) / 1000) });
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
  // The rows come from the matrix of this build and the trust table; a row nobody covers fails the gate before anything runs.
  const dist = path.join(packageRoot, "dist");
  const matrix = await import(pathToFileURL(path.join(dist, "core", "matrix", "index.js")).href);
  const governed = await import(pathToFileURL(path.join(dist, "core", "governed", "trust.js")).href);
  const coverage = smokeCoverage({ rows: matrix.buildMatrix().rows, trust: governed.ADAPTER_TRUST });
  const problems = [
    ...coverage.missing.map((key) => ({ kind: "row-without-smoke", message: `the validated row ${key} has no smoke group and no stated reason (add one to SMOKE_GROUPS or SMOKE_EXEMPT)` })),
    ...coverage.stale.map((key) => ({ kind: "unknown-row", message: `${key} is named by the smoke tables but is not a validated row of the matrix` })),
  ];
  const only = process.env.JGATES_SMOKE_GROUPS?.split(",").filter(Boolean);
  const mounts = ["-v", `${hostPath(path.join(packageRoot, "tests", "fixtures"))}:/fixtures:ro`];
  // Development: the CLI baked into the image is replaced by the build of this working tree (a real build bakes it in).
  if (process.env.JGATES_SMOKE_DIST) mounts.push("-v", `${hostPath(process.env.JGATES_SMOKE_DIST)}:/opt/jgates/jgates/dist:ro`);
  const ran = docker([...BASE_RUN, "--network", "none", "--read-only", "--tmpfs", "/tmp:exec,uid=10001,gid=10001,size=4g", "--memory", "6g", ...MOUNT_SELF(self), ...mounts, ...(only ? ["-e", `JGATES_SMOKE_GROUPS=${only.join(",")}`] : []), image, "node", "/gate/image-gates.mjs", "smoke"], { allowFailure: true, timeout: 4 * 60 * 60_000 });
  let result;
  try {
    result = JSON.parse(ran.out);
  } catch {
    result = { gate: "smoke", passed: false, results: [], findings: [{ kind: "smoke-failed", message: (ran.err || ran.out).slice(-600) }] };
  }
  result.findings = [...(result.findings ?? []), ...problems];
  result.passed = result.passed === true && problems.length === 0;
  result.coverage = { groups: SMOKE_GROUPS.length, refused: coverage.refused, exempt: coverage.exempt };
  writeReport(outDir, "smoke-report.json", result);
  return result;
}

export const GATES = { versions: gateVersions, licenses: gateLicenses, forbidden: gateForbidden, size: gateSize, scan: gateScan, smoke: gateSmoke };

/** Runs the gates (all of them, in order, even after a failure) and writes `gates-report.json`. */
export async function runGates({ image = "jgates-tools:dev", outDir = DEFAULT_OUT, only } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const chosen = only?.length ? only : process.env.JGATES_IMAGE_GATES?.split(",").filter(Boolean);
  const names = chosen?.length ? chosen : Object.keys(GATES);
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
  for (const item of (result.results ?? []).filter((r) => !r.ok)) lines.push(`  - ${item.id}: expected ${item.expected}, got ${item.decision} (exit ${item.exitCode}) ${item.error ?? ""}${item.unsettled?.length ? ` unsettled: ${item.unsettled.join(" | ")}` : ""}${item.findings?.length ? ` findings: ${item.findings.join(" | ")}` : ""}`);
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
    const only = process.env.JGATES_SMOKE_GROUPS?.split(",").filter(Boolean);
    process.stdout.write(`${JSON.stringify(smokeInImage({ ...(only?.length ? { only } : {}) }))}\n`);
  } else if (command === "run") {
    const only = option(rest, "only")?.split(",");
    const summary = await runGates({ image: option(rest, "image") ?? "jgates-tools:dev", outDir: option(rest, "out") ?? DEFAULT_OUT, only });
    process.exitCode = summary.passed ? 0 : 1;
  } else {
    console.error("usage: image-gates.mjs run [--image <ref>] [--out <dir>] [--only gate,gate] | scan-forbidden <root> [--allow a,b] | smoke");
    process.exitCode = 2;
  }
}
