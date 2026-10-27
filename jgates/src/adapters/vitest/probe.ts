// Finds Vitest and its coverage provider on disk, without running or installing anything: the versions come from
// the package.json files, never from a process.
import fs from "node:fs";
import path from "node:path";
import { findOnPath } from "../../core/bridge/index.js";

export const COVERAGE_PROVIDER = "@vitest/coverage-v8";

export interface VitestProbe {
  /** What runs: Node plus the entry file, or the executable itself. */
  executable: string | null;
  /** Arguments before the Vitest ones (the entry file when Node runs it). */
  prefix: string[];
  /** Real path of the Vitest entry file / executable. */
  entry: string | null;
  version: string | null;
  /** Folder of the vitest package (null when the executable is not inside one). */
  packageDir: string | null;
  source: "env" | "workspace" | "path" | null;
  problem: "not_found" | "no_version" | null;
  detail: string;
}

export interface ProviderProbe {
  installed: boolean;
  version: string | null;
  /** Installed version differs from Vitest's: the provider must be the pinned one. */
  mismatch: boolean;
  dir: string | null;
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

function describe(entry: string, source: NonNullable<VitestProbe["source"]>): VitestProbe {
  const real = fs.realpathSync(entry);
  const pkg = packageOf(real, "vitest");
  // A script is run by the Node that runs JGates; anything else (a native launcher) is the executable itself.
  const script = /\.(mjs|cjs|js)$/i.test(real);
  const base = { entry: real, packageDir: pkg?.dir ?? null, source };
  if (!pkg?.version) return { ...base, executable: script ? process.execPath : real, prefix: script ? [real] : [], version: null, problem: "no_version", detail: real };
  return { ...base, executable: script ? process.execPath : real, prefix: script ? [real] : [], version: pkg.version, problem: null, detail: "" };
}

/**
 * JGATES_VITEST (a file), then node_modules/.bin/vitest from the component folder up to the workspace root, then
 * PATH. Only the project's own copy or the one the environment names is used.
 */
export function findVitest(workspace: string, componentRoot: string | null, env: NodeJS.ProcessEnv): VitestProbe {
  const tried: string[] = [];
  if (env.JGATES_VITEST) {
    tried.push(env.JGATES_VITEST);
    const abs = findOnPath(env.JGATES_VITEST, env);
    if (abs) return describe(abs, "env");
    return { executable: null, prefix: [], entry: null, version: null, packageDir: null, source: null, problem: "not_found", detail: tried.join(", ") };
  }
  const start = componentRoot && componentRoot !== "." ? path.join(workspace, componentRoot) : workspace;
  for (const dir of ancestors(start, workspace)) {
    for (const suffix of exeSuffix) {
      const candidate = path.join(dir, "node_modules", ".bin", `vitest${suffix}`);
      tried.push(candidate);
      if (isFile(candidate)) return describe(candidate, "workspace");
    }
  }
  tried.push("vitest on PATH");
  const onPath = findOnPath("vitest", env);
  if (onPath) return describe(onPath, "path");
  return { executable: null, prefix: [], entry: null, version: null, packageDir: null, source: null, problem: "not_found", detail: tried.join(", ") };
}

/**
 * The coverage provider (v8) next to the project or next to Vitest itself. It is only looked for: when it is not
 * there nothing installs it.
 */
export function findCoverageProvider(workspace: string, componentRoot: string | null, vitest: VitestProbe): ProviderProbe {
  const start = componentRoot && componentRoot !== "." ? path.join(workspace, componentRoot) : workspace;
  const roots = ancestors(start, workspace).map((d) => path.join(d, "node_modules"));
  // Vitest resolves the provider from its own location too (hoisted or global installs).
  if (vitest.packageDir) roots.push(path.dirname(vitest.packageDir));
  for (const root of roots) {
    const dir = path.join(root, ...COVERAGE_PROVIDER.split("/"));
    const pkg = readJson(path.join(dir, "package.json"));
    if (pkg && pkg.name === COVERAGE_PROVIDER) {
      const version = typeof pkg.version === "string" ? pkg.version : null;
      return { installed: true, version, mismatch: vitest.version !== null && version !== vitest.version, dir };
    }
  }
  return { installed: false, version: null, mismatch: false, dir: null };
}
