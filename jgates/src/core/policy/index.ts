// CI policy: a complete JGates configuration (jgates.yml and .jgates/) kept in a folder outside the analyzed project.
// This module loads the configuration of a policy for a target project, computes the canonical hash of the policy
// bundle (the files JGates reads from it) and refuses a policy that lives inside the project it governs.
//
// Bundle hash: every bundle file is hashed as is (exact bytes, CRLF kept); the manifest has one line per file,
// "<sha256 hex>  <relative path>\n", paths with "/" sorted by their UTF-8 bytes (the order of `LC_ALL=C sort`); the
// bundle hash is the sha256 (lowercase hex) of the manifest. The same files give the same hash on every system.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR, loadProjectConfig, ROOT_FILE, type ConfigLoadResult, type LoadOptions } from "../config/load/index.js";
import { isBuiltinRef } from "../../builtin/index.js";
import { TemplateGraph } from "../config/resolve/templates.js";
import { resolveToolBindings } from "../tools/index.js";

/** Shared ignore file at the root of a configuration (read by the quality and semantic gates). */
export const POLICY_IGNORE_FILE = ".jgates.ignore";

/** Problems with a policy folder; every one is a configuration failure for the caller. */
export type PolicyErrorCode =
  /** The folder does not exist or is not a directory. */
  | "POLICY_DIR_MISSING"
  /** The folder has no jgates.yml. */
  | "POLICY_ROOT_MISSING"
  /** The policy is the analyzed project or a folder inside it. */
  | "POLICY_INSIDE_PROJECT"
  /** A bundle file (or a folder on its path) is a symbolic link: its bytes would differ between systems. */
  | "POLICY_SYMLINK"
  /** The configuration names a file outside the policy folder, or inside .git. */
  | "POLICY_REF_OUTSIDE"
  /** A bundle path has a line break, which would make the manifest ambiguous. */
  | "POLICY_BAD_PATH"
  /** A bundle file could not be read. */
  | "POLICY_UNREADABLE";

export interface PolicyError {
  code: PolicyErrorCode;
  /** English detail for logs; callers show their own translated text by `code`. */
  message: string;
  /** The policy-relative (or absolute) path involved, when there is one. */
  path: string | null;
}

export interface PolicyFile {
  /** Path relative to the policy folder, with "/". */
  path: string;
  /** sha256 of the exact bytes, lowercase hex. */
  sha256: string;
  size: number;
}

export interface PolicyBundle {
  /** Absolute policy folder. */
  dir: string;
  /** sha256 of the manifest, lowercase hex (the value of JGATES_POLICY_SHA256). */
  sha256: string;
  /** The bundle files in manifest order. */
  files: PolicyFile[];
  /** The canonical manifest the hash is computed from. */
  manifest: string;
}

export type PolicyBundleResult = { ok: true; bundle: PolicyBundle } | { ok: false; error: PolicyError };

const sha256Hex = (bytes: Buffer | string): string => crypto.createHash("sha256").update(bytes).digest("hex");

const policyError = (code: PolicyErrorCode, message: string, where: string | null = null): PolicyError => ({ code, message, path: where });

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function canonical(dir: string): string {
  const resolved = path.resolve(dir);
  let real: string;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    real = resolved;
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/**
 * Refuses a policy that the analyzed project could change: the policy folder must exist and must not be the project
 * or a folder inside it (links are resolved first). Returns null when the location is acceptable.
 */
export function checkPolicyLocation(policyDir: string, projectDir: string): PolicyError | null {
  if (!isDirectory(policyDir)) return policyError("POLICY_DIR_MISSING", `policy folder not found: ${policyDir}`, policyDir);
  const policy = canonical(policyDir);
  const project = canonical(projectDir);
  const rel = path.relative(project, policy);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return policyError("POLICY_INSIDE_PROJECT", `the policy folder ${policyDir} is inside the analyzed project ${projectDir}`, policyDir);
  }
  return null;
}

/**
 * Loads the configuration of `policyDir` for the project `projectDir`: the project's own jgates.yml and .jgates/ are
 * never read. Same result shape as loadProjectConfig (document paths are relative to the policy folder).
 */
export function loadPolicyConfig(policyDir: string, projectDir: string, options: Omit<LoadOptions, "configDir"> = {}): ConfigLoadResult {
  return loadProjectConfig(projectDir, { ...options, configDir: policyDir });
}

/** Normalizes a bundle hash given by a user (spaces, upper case and a "sha256:" prefix allowed); null when malformed. */
export function normalizePolicyHash(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^sha256:/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/** Whether `expected` (for example JGATES_POLICY_SHA256) names this bundle. */
export function policyHashMatches(bundle: PolicyBundle, expected: string | undefined | null): boolean {
  return normalizePolicyHash(expected) === bundle.sha256;
}

const hasGitSegment = (rel: string): boolean => rel.split("/").includes(".git");

/** Every regular file under `relDir`, with "/" paths; a link or a .git folder is never followed. */
function walk(root: string, relDir: string, out: string[], links: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, ...relDir.split("/")), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isSymbolicLink()) links.push(rel);
    else if (entry.isDirectory()) {
      if (entry.name !== ".git") walk(root, rel, out, links);
    } else if (entry.isFile()) out.push(rel);
  }
}

/** The first link on the path of `rel` (the file or one of its folders), or null. */
function linkOnPath(root: string, rel: string): string | null {
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    try {
      if (fs.lstatSync(path.join(root, ...parts.slice(0, i))).isSymbolicLink()) return prefix;
    } catch {
      return null;
    }
  }
  return null;
}

function isInside(parent: string, child: string): boolean {
  const r = path.relative(parent, child);
  return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
}

/**
 * Files the configuration of the policy names outside .jgates/: fragments in `extends`, template files (with their
 * parents) and files bound in tools.yml. Paths are policy-relative; a reference that leaves the folder is an error.
 */
function referencedFiles(dir: string): { files: string[]; error: PolicyError | null } {
  const files = new Set<string>();
  const load = loadProjectConfig(dir);
  for (const d of load.documents) files.add(d.file);

  const quiet = { error: () => undefined, warning: () => undefined };
  const graph = new TemplateGraph(dir, quiet);
  const root = load.byKind.root?.value;
  const entries = root !== null && typeof root === "object" ? (root as Record<string, unknown>).templates : undefined;
  const sources: string[] = [];
  const pushSource = (entry: unknown): void => {
    const source = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>).source : undefined;
    if (typeof source === "string" && source !== "" && !isBuiltinRef(source)) sources.push(source);
  };
  if (Array.isArray(entries)) entries.forEach(pushSource);
  else if (entries !== null && typeof entries === "object") Object.values(entries).forEach(pushSource);
  const pending: string[] = [];
  for (const source of sources) {
    const absolute = path.resolve(dir, source);
    if (path.isAbsolute(source) || !isInside(dir, absolute)) {
      return { files: [], error: policyError("POLICY_REF_OUTSIDE", `template outside the policy folder: ${source}`, source) };
    }
    const identity = graph.resolve(source, { file: ROOT_FILE, path: "templates" });
    if (identity !== undefined) pending.push(identity);
  }
  const seen = new Set<string>();
  while (pending.length > 0) {
    const identity = pending.pop() as string;
    if (seen.has(identity) || isBuiltinRef(identity)) continue;
    seen.add(identity);
    files.add(identity);
    pending.push(...(graph.node(identity)?.parents ?? []));
  }

  for (const instance of resolveToolBindings(dir, { skipInventory: true }).instances) {
    for (const binding of instance.bindings) {
      if (binding.refused || binding.relPath === null) {
        return { files: [], error: policyError("POLICY_REF_OUTSIDE", `tool ${instance.id} binds a file outside the policy folder: ${binding.declared}`, binding.declared) };
      }
      if (!binding.exists) continue;
      if (binding.kind === "file") files.add(binding.relPath);
      else for (const f of binding.files) files.add(binding.relPath === "" ? f.path : `${binding.relPath}/${f.path}`);
    }
  }
  return { files: [...files], error: null };
}

const byUtf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

/**
 * The policy bundle of `policyDir`: jgates.yml, .jgates.ignore, every file under .jgates/ (a .git folder excluded) and
 * the files the configuration names elsewhere in the folder, with the canonical hash (see the header of this module).
 * Files JGates does not read (a README, CI files, .git) never enter the bundle. Reads only; never throws.
 */
export function readPolicyBundle(policyDir: string): PolicyBundleResult {
  const dir = path.resolve(policyDir);
  if (!isDirectory(dir)) return { ok: false, error: policyError("POLICY_DIR_MISSING", `policy folder not found: ${policyDir}`, policyDir) };
  if (!fs.existsSync(path.join(dir, ROOT_FILE))) return { ok: false, error: policyError("POLICY_ROOT_MISSING", `${ROOT_FILE} not found in ${policyDir}`, ROOT_FILE) };

  const candidates = new Set<string>([ROOT_FILE]);
  if (fs.existsSync(path.join(dir, POLICY_IGNORE_FILE))) candidates.add(POLICY_IGNORE_FILE);
  const links: string[] = [];
  const configLink = linkOnPath(dir, CONFIG_DIR);
  if (configLink) links.push(configLink);
  else {
    const walked: string[] = [];
    walk(dir, CONFIG_DIR, walked, links);
    for (const f of walked) candidates.add(f);
  }
  if (links.length > 0) {
    const first = [...links].sort(byUtf8)[0] as string;
    return { ok: false, error: policyError("POLICY_SYMLINK", `symbolic link in the policy bundle: ${first}`, first) };
  }
  const referenced = referencedFiles(dir);
  if (referenced.error) return { ok: false, error: referenced.error };
  for (const f of referenced.files) candidates.add(f);

  const files: PolicyFile[] = [];
  for (const rel of [...candidates].sort(byUtf8)) {
    if (hasGitSegment(rel)) return { ok: false, error: policyError("POLICY_REF_OUTSIDE", `the configuration names a file inside .git: ${rel}`, rel) };
    if (/[\r\n]/.test(rel)) return { ok: false, error: policyError("POLICY_BAD_PATH", `line break in a policy file name: ${JSON.stringify(rel)}`, rel) };
    const link = linkOnPath(dir, rel);
    if (link) return { ok: false, error: policyError("POLICY_SYMLINK", `symbolic link in the policy bundle: ${link}`, link) };
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(dir, ...rel.split("/")));
    } catch {
      return { ok: false, error: policyError("POLICY_UNREADABLE", `cannot read the policy file ${rel}`, rel) };
    }
    files.push({ path: rel, sha256: sha256Hex(bytes), size: bytes.length });
  }
  const manifest = files.map((f) => `${f.sha256}  ${f.path}\n`).join("");
  return { ok: true, bundle: { dir, sha256: sha256Hex(Buffer.from(manifest, "utf8")), files, manifest } };
}
