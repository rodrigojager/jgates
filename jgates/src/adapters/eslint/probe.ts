// Finds a Node-based tool (ESLint, jscpd) without running or installing anything: the tools image's copy comes from
// image.json; a copy on disk (inside the image only) gets its version from the package.json of the package that owns
// the entry file, never from a process.
import fs from "node:fs";
import path from "node:path";
import { findOnPath } from "../../core/bridge/index.js";
import { inImageOverride, probeImageTool } from "../../core/tools-image/catalogue.js";
import { stepMode } from "../../core/runner/in-image.js";

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
  source: "env" | "workspace" | "image" | null;
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
  let real = fs.realpathSync(entry);
  let pkg = packageOf(real, pkgName);
  // Windows: node_modules/.bin/<tool>.cmd is a launcher shim, not a link into the package. The package sits next to
  // .bin, and Node runs the script its package.json declares as bin.
  if (!pkg && /[\\/]\.bin[\\/][^\\/]+\.(?:cmd|exe)$/i.test(real)) {
    const dir = path.join(path.dirname(path.dirname(real)), ...pkgName.split("/"));
    const found = packageOf(path.join(dir, "package.json"), pkgName);
    const field = readJson(path.join(dir, "package.json"))?.bin;
    const wanted = path.basename(real).replace(/\.(?:cmd|exe)$/i, "");
    const rel = typeof field === "string" ? field : field && typeof field === "object" ? ((field as Record<string, unknown>)[wanted] ?? Object.values(field as Record<string, unknown>)[0]) : null;
    const script = typeof rel === "string" ? path.resolve(dir, rel) : null;
    if (found && script && isFile(script)) {
      real = script;
      pkg = found;
    }
  }
  // A script is run by the Node that runs JGates; anything else (a native launcher) is the executable itself.
  const script = /\.(mjs|cjs|js)$/i.test(real);
  const base = { entry: real, packageDir: pkg?.dir ?? null, source };
  const run = { executable: script ? process.execPath : real, prefix: script ? [real] : [] };
  if (!pkg?.version) return { ...base, ...run, version: null, problem: "no_version", detail: real };
  return { ...base, ...run, version: pkg.version, problem: null, detail: "" };
}

/** A Node tool of the tools image, as image.json records it (its command on the image PATH, no entry file). */
export function imageNodeTool(tool: string, env: NodeJS.ProcessEnv): NodeToolProbe {
  const image = probeImageTool(tool, env);
  return image.problem === null
    ? { executable: image.executable, prefix: [], entry: null, version: image.version, packageDir: null, source: "image", problem: null, detail: "" }
    : { executable: null, prefix: [], entry: null, version: null, packageDir: null, source: null, problem: "not_found", detail: image.detail };
}

/**
 * Container-first: the tools image's copy, from image.json (nothing starts, nothing is read on the host). Inside the
 * image only: `envVar` (a file) first, then the project's own node_modules/.bin/<bin> from the component folder up to
 * the workspace root (the project's installed dependencies), then the image's copy. Nothing is downloaded.
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
  /** The tool's name in image.json (default: the package name). */
  imageTool?: string;
}): NodeToolProbe {
  const { pkgName, bin, envVar, workspace, componentRoot, env } = opts;
  const tried: string[] = [];
  const named = inImageOverride(env, envVar);
  if (named) {
    tried.push(named);
    const abs = findOnPath(named, env);
    if (abs) return describe(abs, pkgName, "env");
    return { executable: null, prefix: [], entry: null, version: null, packageDir: null, source: null, problem: "not_found", detail: tried.join(", ") };
  }
  if (stepMode(env) === "in-image" && !opts.skipWorkspace) {
    const start = componentRoot && componentRoot !== "." ? path.join(workspace, componentRoot) : workspace;
    for (const dir of ancestors(start, workspace)) {
      for (const suffix of exeSuffix) {
        const candidate = path.join(dir, "node_modules", ".bin", `${bin}${suffix}`);
        if (isFile(candidate)) return describe(candidate, pkgName, "workspace");
      }
    }
  }
  return imageNodeTool(opts.imageTool ?? pkgName, env);
}

export const findEslint = (workspace: string, componentRoot: string | null, env: NodeJS.ProcessEnv, skipWorkspace = false): NodeToolProbe =>
  findNodeTool({ pkgName: "eslint", bin: "eslint", envVar: "JGATES_ESLINT", workspace, componentRoot, env, skipWorkspace });
