// Finds a Node-based tool (ESLint, jscpd) on disk without running or installing anything: the version comes from the
// package.json of the package that owns the entry file, never from a process.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { findOnPath } from "../../core/bridge/index.js";

export interface NodeToolProbe {
  /** What runs: Node plus the entry file, or the executable itself. */
  executable: string | null;
  /** Arguments before the tool's own (the entry file when Node runs it). */
  prefix: string[];
  /** Real path of the entry file / executable. */
  entry: string | null;
  version: string | null;
  /** Folder of the package (null when the executable is not inside one). */
  packageDir: string | null;
  source: "env" | "workspace" | "path" | "jgates" | null;
  problem: "not_found" | "no_version" | null;
  detail: string;
}

const exeSuffix = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    const doc = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    return typeof doc === "object" && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The package folder (with a package.json named `name`) that holds `file`, walking up from it. */
function packageOf(file: string, name: string): { dir: string; version: string | null } | null {
  let dir = path.dirname(file);
  for (let i = 0; i < 12; i++) {
    const pkg = readJson(path.join(dir, "package.json"));
    if (pkg && pkg.name === name) return { dir, version: typeof pkg.version === "string" ? pkg.version : null };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Folders from `from` up to `top` (inclusive), nearest first; only `from` itself when it is outside `top`. */
function ancestors(from: string, top: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(from);
  const stop = path.resolve(top);
  for (let i = 0; i < 32; i++) {
    out.push(dir);
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir || path.relative(stop, parent).startsWith("..")) break;
    dir = parent;
  }
  return out;
}

function describe(entry: string, pkgName: string, source: NonNullable<NodeToolProbe["source"]>): NodeToolProbe {
  const real = fs.realpathSync(entry);
  const pkg = packageOf(real, pkgName);
  // A script is run by the Node that runs JGates; anything else (a native launcher) is the executable itself.
  const script = /\.(mjs|cjs|js)$/i.test(real);
  const base = { entry: real, packageDir: pkg?.dir ?? null, source };
  const run = { executable: script ? process.execPath : real, prefix: script ? [real] : [] };
  if (!pkg?.version) return { ...base, ...run, version: null, problem: "no_version", detail: real };
  return { ...base, ...run, version: pkg.version, problem: null, detail: "" };
}

/** The copy of the package that ships with JGates itself, found through its bin entry. */
function bundledEntry(pkgName: string, bin: string): string | null {
  try {
    const pkgFile = createRequire(import.meta.url).resolve(`${pkgName}/package.json`);
    const pkg = readJson(pkgFile);
    const field = pkg?.bin;
    const rel = typeof field === "string" ? field : field && typeof field === "object" ? (field as Record<string, unknown>)[bin] : null;
    if (typeof rel !== "string") return null;
    const abs = path.resolve(path.dirname(pkgFile), rel);
    return isFile(abs) ? abs : null;
  } catch {
    return null;
  }
}

/**
 * `envVar` (a file), then node_modules/.bin/<bin> from the component folder up to the workspace root, then PATH, then the
 * copy that ships with JGates. Nothing is downloaded.
 */
export function findNodeTool(opts: {
  pkgName: string;
  bin: string;
  envVar: string;
  workspace: string;
  componentRoot: string | null;
  env: NodeJS.ProcessEnv;
  /** jgates ci: a copy installed in the analyzed project is the project's code, never the tool; it is not looked for. */
  skipWorkspace?: boolean;
}): NodeToolProbe {
  const { pkgName, bin, envVar, workspace, componentRoot, env } = opts;
  const tried: string[] = [];
  const named = env[envVar];
  if (named) {
    tried.push(named);
    const abs = findOnPath(named, env);
    if (abs) return describe(abs, pkgName, "env");
    return { executable: null, prefix: [], entry: null, version: null, packageDir: null, source: null, problem: "not_found", detail: tried.join(", ") };
  }
  const start = componentRoot && componentRoot !== "." ? path.join(workspace, componentRoot) : workspace;
  for (const dir of opts.skipWorkspace ? [] : ancestors(start, workspace)) {
    for (const suffix of exeSuffix) {
      const candidate = path.join(dir, "node_modules", ".bin", `${bin}${suffix}`);
      tried.push(candidate);
      if (isFile(candidate)) return describe(candidate, pkgName, "workspace");
    }
  }
  tried.push(`${bin} on PATH`);
  const onPath = findOnPath(bin, env);
  if (onPath) return describe(onPath, pkgName, "path");
  const bundled = bundledEntry(pkgName, bin);
  if (bundled) return describe(bundled, pkgName, "jgates");
  return { executable: null, prefix: [], entry: null, version: null, packageDir: null, source: null, problem: "not_found", detail: tried.join(", ") };
}

export const findEslint = (workspace: string, componentRoot: string | null, env: NodeJS.ProcessEnv, skipWorkspace = false): NodeToolProbe =>
  findNodeTool({ pkgName: "eslint", bin: "eslint", envVar: "JGATES_ESLINT", workspace, componentRoot, env, skipWorkspace });
