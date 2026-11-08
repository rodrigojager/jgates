// Supply-chain check: provenance and package-execution signals of npm and Python lockfiles that a CVE database does
// not give (install scripts, missing integrity hashes, registries that are not the public one or are not pinned,
// deprecated packages). Pure and offline: it only reads the lockfiles, runs nothing and never asks a registry, so what
// needs the network (the deprecation of a Python package, the age of a release) is reported as `unknown`, never as
// clean. A lockfile that cannot be read is an `unknown` too, not an absence of findings.
import fs from "node:fs";
import path from "node:path";
import { translator, type Translator } from "../../i18n/index.js";

export type SupplyChainSignal = "install-script" | "missing-integrity" | "unpinned-registry" | "deprecated" | "unpinned-source";

export interface SupplyChainFinding {
  signal: SupplyChainSignal;
  ruleId: string;
  /** Lockfile, workspace-relative with forward slashes. */
  file: string;
  ecosystem: "npm" | "python";
  package: string;
  version: string | null;
  severity: "high" | "medium" | "low";
  message: string;
}

/** A signal the check could not decide (reported, never counted as clean). */
export interface SupplyChainUnknown {
  signal: SupplyChainSignal | "lockfile";
  file: string;
  reason: string;
}

export interface SupplyChainResult {
  lockfiles: string[];
  findings: SupplyChainFinding[];
  unknown: SupplyChainUnknown[];
  /** The check is offline: no registry is asked. */
  network: false;
}

export interface SupplyChainOptions {
  /** Registry hosts accepted as the public ones (default: registry.npmjs.org, pypi.org, files.pythonhosted.org). */
  trustedHosts?: string[];
  translate?: Translator;
}

const NPM_LOCKS = new Set(["package-lock.json", "npm-shrinkwrap.json"]);
const PY_LOCKS = new Set(["requirements.txt", "poetry.lock", "Pipfile.lock"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "dist", "build", "__pycache__"]);
const DEFAULT_HOSTS = ["registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org"];

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const slash = (p: string): string => p.split(path.sep).join("/");

/** Lockfiles of the workspace (bounded depth, vendor folders skipped). */
export function findLockfiles(dir: string, maxDepth = 4): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const next = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name)) walk(next, depth + 1);
      } else if (NPM_LOCKS.has(e.name) || PY_LOCKS.has(e.name)) {
        out.push(next);
      }
    }
  };
  walk("", 0);
  return out;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Is a `resolved` URL a pinned artifact of a trusted registry? Returns the reason it is not, or null. */
function registryProblem(resolved: string, trusted: string[]): "not-https" | "untrusted-host" | "git-source" | null {
  if (/^(git\+|git:|github:|git@)/.test(resolved) || /\.git(#|$)/.test(resolved)) return "git-source";
  if (!/^https:/i.test(resolved)) return "not-https";
  const host = hostOf(resolved);
  return host !== null && trusted.includes(host) ? null : "untrusted-host";
}

function nameFromPath(key: string): string {
  const i = key.lastIndexOf("node_modules/");
  return i >= 0 ? key.slice(i + "node_modules/".length) : key;
}

interface Collected {
  findings: SupplyChainFinding[];
  unknown: SupplyChainUnknown[];
}

function analyzeNpm(file: string, text: string, trusted: string[], t: Translator, out: Collected): void {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    out.unknown.push({ signal: "lockfile", file, reason: t("sc_unreadable", { file, detail: error instanceof Error ? error.message : String(error) }) });
    return;
  }
  if (!isRec(doc)) {
    out.unknown.push({ signal: "lockfile", file, reason: t("sc_unreadable", { file, detail: "not an object" }) });
    return;
  }
  const add = (signal: SupplyChainSignal, severity: SupplyChainFinding["severity"], pkg: string, version: string | null, message: string): void => {
    out.findings.push({ signal, ruleId: `supply-chain/${signal}`, file, ecosystem: "npm", package: pkg, version, severity, message });
  };
  const inspect = (name: string, entry: Record<string, unknown>): void => {
    const version = typeof entry.version === "string" ? entry.version : null;
    const scripts = isRec(entry.scripts) ? entry.scripts : {};
    const lifecycle = ["preinstall", "install", "postinstall"].filter((k) => typeof scripts[k] === "string");
    if (lifecycle.length > 0 || entry.hasInstallScript === true) {
      add("install-script", "high", name, version, t("sc_install_script", { package: name, scripts: lifecycle.length > 0 ? lifecycle.join(", ") : "install" }));
    }
    const resolved = typeof entry.resolved === "string" ? entry.resolved : null;
    const link = entry.link === true;
    if (entry.integrity === undefined && !link && resolved !== null && !/^file:/.test(resolved)) {
      add("missing-integrity", "high", name, version, t("sc_missing_integrity", { package: name }));
    }
    if (resolved !== null && !link) {
      const problem = registryProblem(resolved, trusted);
      if (problem !== null) add("unpinned-registry", problem === "git-source" ? "high" : "medium", name, version, t(`sc_registry_${problem}`, { package: name, source: resolved }));
    }
    if (typeof entry.deprecated === "string" && entry.deprecated !== "") {
      add("deprecated", "medium", name, version, t("sc_deprecated", { package: name, notice: entry.deprecated }));
    }
  };
  if (isRec(doc.packages)) {
    for (const [key, entry] of Object.entries(doc.packages)) {
      if (key === "" || !isRec(entry)) continue; // the root project itself
      inspect(typeof entry.name === "string" ? entry.name : nameFromPath(key), entry);
    }
  } else if (isRec(doc.dependencies)) {
    // lockfileVersion 1: nested dependencies
    const walk = (deps: Record<string, unknown>): void => {
      for (const [name, entry] of Object.entries(deps)) {
        if (!isRec(entry)) continue;
        inspect(name, entry);
        if (isRec(entry.dependencies)) walk(entry.dependencies);
      }
    };
    walk(doc.dependencies);
  } else {
    out.unknown.push({ signal: "lockfile", file, reason: t("sc_no_packages", { file }) });
  }
}

/** requirements.txt: --hash lines, index options and VCS/URL requirements. */
function analyzeRequirements(file: string, text: string, trusted: string[], t: Translator, out: Collected): void {
  const joined = text.replace(/\\\r?\n/g, " ");
  let seen = 0;
  const add = (signal: SupplyChainSignal, severity: SupplyChainFinding["severity"], pkg: string, version: string | null, message: string): void => {
    out.findings.push({ signal, ruleId: `supply-chain/${signal}`, file, ecosystem: "python", package: pkg, version, severity, message });
  };
  for (const raw of joined.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "") continue;
    const index = /^(?:--index-url|-i|--extra-index-url|--find-links|-f)[ =]+(\S+)/.exec(line);
    if (index) {
      const problem = registryProblem(index[1] as string, trusted);
      if (problem !== null) add("unpinned-registry", "medium", index[1] as string, null, t(`sc_registry_${problem}`, { package: "requirements", source: index[1] as string }));
      continue;
    }
    if (line.startsWith("-")) continue;
    seen += 1;
    const vcs = /^(?:([A-Za-z0-9_.\-]+)\s*@\s*)?(git\+\S+|https?:\/\/\S+)/.exec(line);
    const pinned = /^([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?\s*==\s*([^\s;]+)/.exec(line);
    if (vcs) {
      const name = vcs[1] ?? (vcs[2] as string);
      const ref = (vcs[2] as string).includes("@") && /@[0-9a-f]{40}\b/.test(vcs[2] as string);
      if (!ref) add("unpinned-source", "high", name, null, t("sc_unpinned_source", { package: name, source: vcs[2] as string }));
      continue;
    }
    const name = pinned?.[1] ?? /^([A-Za-z0-9_.\-]+)/.exec(line)?.[1] ?? line;
    const version = pinned?.[2] ?? null;
    if (!/--hash[= ]sha\d+:[0-9a-f]+/i.test(line)) add("missing-integrity", "high", name, version, t("sc_missing_hash", { package: name }));
    else if (!pinned) add("unpinned-source", "medium", name, null, t("sc_unpinned_version", { package: name }));
  }
  if (seen === 0) out.unknown.push({ signal: "lockfile", file, reason: t("sc_no_packages", { file }) });
}

/** poetry.lock: [[package]] tables with name/version and a files list of hashes, optional [package.source]. */
function analyzePoetry(file: string, text: string, trusted: string[], t: Translator, out: Collected): void {
  const blocks = text.split(/^\[\[package\]\]\s*$/m).slice(1);
  if (blocks.length === 0) {
    out.unknown.push({ signal: "lockfile", file, reason: t("sc_no_packages", { file }) });
    return;
  }
  for (const block of blocks) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1] ?? "?";
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1] ?? null;
    const base = { file, ecosystem: "python" as const, package: name, version };
    if (!/hash\s*=\s*"sha\d+:[0-9a-f]+"/i.test(block)) {
      out.findings.push({ ...base, signal: "missing-integrity", ruleId: "supply-chain/missing-integrity", severity: "high", message: t("sc_missing_hash", { package: name }) });
    }
    const type = /^\[package\.source\][\s\S]*?^type\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const url = /^\[package\.source\][\s\S]*?^url\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (type === "git" && !/^resolved_reference\s*=\s*"[0-9a-f]{40}"/m.test(block)) {
      out.findings.push({ ...base, signal: "unpinned-source", ruleId: "supply-chain/unpinned-source", severity: "high", message: t("sc_unpinned_source", { package: name, source: url ?? "git" }) });
    } else if (url && type !== "git" && registryProblem(url, trusted) !== null) {
      out.findings.push({ ...base, signal: "unpinned-registry", ruleId: "supply-chain/unpinned-registry", severity: "medium", message: t("sc_registry_untrusted-host", { package: name, source: url }) });
    }
  }
}

function analyzePipfileLock(file: string, text: string, trusted: string[], t: Translator, out: Collected): void {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    out.unknown.push({ signal: "lockfile", file, reason: t("sc_unreadable", { file, detail: error instanceof Error ? error.message : String(error) }) });
    return;
  }
  if (!isRec(doc)) {
    out.unknown.push({ signal: "lockfile", file, reason: t("sc_unreadable", { file, detail: "not an object" }) });
    return;
  }
  const sources = isRec(doc._meta) && Array.isArray(doc._meta.sources) ? doc._meta.sources : [];
  for (const s of sources) {
    if (isRec(s) && typeof s.url === "string" && registryProblem(s.url, trusted) !== null) {
      out.findings.push({ signal: "unpinned-registry", ruleId: "supply-chain/unpinned-registry", file, ecosystem: "python", package: String(s.name ?? s.url), version: null, severity: "medium", message: t("sc_registry_untrusted-host", { package: String(s.name ?? "source"), source: s.url }) });
    }
  }
  for (const section of ["default", "develop"]) {
    const pkgs = doc[section];
    if (!isRec(pkgs)) continue;
    for (const [name, entry] of Object.entries(pkgs)) {
      if (!isRec(entry)) continue;
      const version = typeof entry.version === "string" ? entry.version.replace(/^==/, "") : null;
      if (typeof entry.git === "string") {
        if (!(typeof entry.ref === "string" && /^[0-9a-f]{40}$/.test(entry.ref))) out.findings.push({ signal: "unpinned-source", ruleId: "supply-chain/unpinned-source", file, ecosystem: "python", package: name, version, severity: "high", message: t("sc_unpinned_source", { package: name, source: entry.git }) });
      } else if (!Array.isArray(entry.hashes) || entry.hashes.length === 0) {
        out.findings.push({ signal: "missing-integrity", ruleId: "supply-chain/missing-integrity", file, ecosystem: "python", package: name, version, severity: "high", message: t("sc_missing_hash", { package: name }) });
      }
    }
  }
}

/** Analyzes the lockfiles of a workspace (or the explicit list of relative paths). */
export function analyzeSupplyChain(dir: string, options: SupplyChainOptions & { lockfiles?: string[] } = {}): SupplyChainResult {
  const t = options.translate ?? translator("supply-chain");
  const trusted = options.trustedHosts ?? DEFAULT_HOSTS;
  const lockfiles = options.lockfiles ?? findLockfiles(dir);
  const out: Collected = { findings: [], unknown: [] };
  for (const rel of lockfiles) {
    const file = slash(rel);
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, ...file.split("/")), "utf8");
    } catch (error) {
      out.unknown.push({ signal: "lockfile", file, reason: t("sc_unreadable", { file, detail: error instanceof Error ? error.message : String(error) }) });
      continue;
    }
    const base = path.posix.basename(file);
    if (NPM_LOCKS.has(base)) analyzeNpm(file, text, trusted, t, out);
    else if (base === "requirements.txt") analyzeRequirements(file, text, trusted, t, out);
    else if (base === "poetry.lock") analyzePoetry(file, text, trusted, t, out);
    else if (base === "Pipfile.lock") analyzePipfileLock(file, text, trusted, t, out);
  }
  // What an offline read cannot decide stays visible: it is never a clean result.
  if (lockfiles.some((f) => PY_LOCKS.has(path.posix.basename(slash(f))))) {
    const file = lockfiles.find((f) => PY_LOCKS.has(path.posix.basename(slash(f)))) as string;
    out.unknown.push({ signal: "deprecated", file: slash(file), reason: t("sc_unknown_python_deprecation") });
  }
  if (lockfiles.length === 0) out.unknown.push({ signal: "lockfile", file: ".", reason: t("sc_no_lockfile") });
  return { lockfiles: lockfiles.map(slash), findings: out.findings, unknown: out.unknown, network: false };
}
