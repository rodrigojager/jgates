// Finds the compiler or type checker of a checker kind without installing or changing anything: the project's own
// copy first (node_modules/.bin, the virtual environment of the component), then PATH. The version comes from the
// package.json of the package (tsc) or from `<tool> --version`.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { probeEnv } from "../../core/runner/probe-env.js";

export const CHECKERS = ["tsc", "mypy", "pyright", "go", "cargo", "dotnet"] as const;
export type Checker = (typeof CHECKERS)[number];

export interface CheckerProbe {
  /** What runs: the executable, or Node when tsc is a script. */
  executable: string | null;
  /** Arguments before the checker's own (the tsc entry file when Node runs it). */
  prefix: string[];
  version: string | null;
  problem: "not_found" | "no_answer" | null;
  /** What was tried (not_found) or the path that did not answer (no_answer). */
  detail: string;
  source: "env" | "workspace" | "path" | null;
}

/** The environment variable that points at a checker, and the program name it is looked for under. */
export const CHECKER_ENV: Record<Checker, string> = {
  tsc: "JGATES_TSC",
  mypy: "JGATES_MYPY",
  pyright: "JGATES_PYRIGHT",
  go: "JGATES_GO",
  cargo: "JGATES_CARGO",
  dotnet: "JGATES_DOTNET",
};

const VERSION_PATTERN: Record<Exclude<Checker, "tsc">, RegExp> = {
  mypy: /mypy\s+(\d+\.\d+(?:\.\d+)?)/i,
  pyright: /pyright\s+(\d+\.\d+\.\d+)/i,
  go: /go version go(\d+\.\d+(?:\.\d+)?)/i,
  cargo: /cargo\s+(\d+\.\d+\.\d+)/i,
  dotnet: /^(\d+\.\d+\.\d+)/m,
};
const VERSION_ARGS: Record<Exclude<Checker, "tsc">, string[]> = {
  mypy: ["--version"],
  pyright: ["--version"],
  go: ["version"],
  cargo: ["--version"],
  dotnet: ["--version"],
};

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Folders from `from` up to `top` (inclusive), nearest first. */
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

const cache = new Map<string, { mtimeMs: number; version: string | null }>();

/** Runs `<executable> <args>` (a version query) once per file version and returns the version it prints. */
function queryVersion(executable: string, args: string[], pattern: RegExp, env: NodeJS.ProcessEnv): string | null {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(executable).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  const key = `${executable}\0${args.join(" ")}`;
  const hit = cache.get(key);
  if (hit && hit.mtimeMs === mtimeMs) return hit.version;
  const r = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 60_000,
    env: probeEnv(env, { PATH: env.PATH ?? "", HOME: env.HOME ?? "", NO_COLOR: "1", DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" }),
    windowsHide: true,
    // .cmd shims (npm, pip launchers) need the shell on Windows; the arguments are fixed words.
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable),
  });
  const version = r.status === 0 ? (pattern.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? null) : null;
  cache.set(key, { mtimeMs, version });
  return version;
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    const doc = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    return typeof doc === "object" && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A TypeScript package folder's entry (bin/tsc) and version, or null. */
function tscPackage(packageDir: string): { entry: string; version: string | null } | null {
  const entry = path.join(packageDir, "bin", "tsc");
  if (!isFile(entry)) return null;
  const pkg = readJson(path.join(packageDir, "package.json"));
  return { entry, version: typeof pkg?.version === "string" ? pkg.version : null };
}

function probeTsc(workspace: string, componentRoot: string | null, env: NodeJS.ProcessEnv, skipWorkspace: boolean): CheckerProbe {
  const tried: string[] = [];
  const found = (pkg: { entry: string; version: string | null }, source: NonNullable<CheckerProbe["source"]>): CheckerProbe =>
    pkg.version ? { executable: process.execPath, prefix: [pkg.entry], version: pkg.version, problem: null, detail: "", source } : { executable: null, prefix: [], version: null, problem: "no_answer", detail: pkg.entry, source };
  const named = env[CHECKER_ENV.tsc];
  if (named) {
    tried.push(named);
    const abs = findOnPath(named, env);
    const pkg = abs ? tscPackage(path.resolve(path.dirname(abs), "..")) : null;
    if (pkg) return found(pkg, "env");
    return { executable: null, prefix: [], version: null, problem: "not_found", detail: tried.join(", "), source: null };
  }
  const start = componentRoot && componentRoot !== "." ? path.join(workspace, componentRoot) : workspace;
  for (const dir of skipWorkspace ? [] : ancestors(start, workspace)) {
    const candidate = path.join(dir, "node_modules", "typescript");
    tried.push(candidate);
    const pkg = tscPackage(candidate);
    if (pkg) return found(pkg, "workspace");
  }
  tried.push("tsc on PATH");
  // The npm shim (tsc, tsc.cmd) sits next to node_modules/typescript of the global prefix.
  const onPath = findOnPath("tsc", env);
  if (onPath) {
    const shimDir = path.dirname(onPath);
    let real = onPath;
    try {
      real = fs.realpathSync(onPath);
    } catch {
      real = onPath;
    }
    const pkg =
      tscPackage(path.join(shimDir, "node_modules", "typescript")) ??
      tscPackage(path.resolve(shimDir, "..", "lib", "node_modules", "typescript")) ??
      // A project shim (node_modules/.bin/tsc, which npm puts first on the PATH of its scripts).
      tscPackage(path.resolve(shimDir, "..", "typescript")) ??
      tscPackage(path.resolve(path.dirname(real), ".."));
    if (pkg) return found(pkg, "path");
    return { executable: null, prefix: [], version: null, problem: "no_answer", detail: onPath, source: "path" };
  }
  return { executable: null, prefix: [], version: null, problem: "not_found", detail: tried.join(", "), source: null };
}

/** The virtual environment folders of a Python component, nearest first, then VIRTUAL_ENV. */
function pythonBins(workspace: string, componentRoot: string | null, env: NodeJS.ProcessEnv, skipWorkspace: boolean): string[] {
  const bin = process.platform === "win32" ? "Scripts" : "bin";
  const out: string[] = [];
  const start = componentRoot && componentRoot !== "." ? path.join(workspace, componentRoot) : workspace;
  for (const dir of skipWorkspace ? [] : ancestors(start, workspace)) for (const venv of [".venv", "venv"]) out.push(path.join(dir, venv, bin));
  if (env.VIRTUAL_ENV) out.push(path.join(env.VIRTUAL_ENV, bin));
  return out;
}

function probeByName(checker: Exclude<Checker, "tsc">, workspace: string, componentRoot: string | null, env: NodeJS.ProcessEnv, skipWorkspace: boolean): CheckerProbe {
  const tried: string[] = [];
  const answer = (executable: string, source: NonNullable<CheckerProbe["source"]>): CheckerProbe => {
    const version = queryVersion(executable, VERSION_ARGS[checker], VERSION_PATTERN[checker], env);
    return version ? { executable, prefix: [], version, problem: null, detail: "", source } : { executable, prefix: [], version: null, problem: "no_answer", detail: executable, source };
  };
  const named = env[CHECKER_ENV[checker]];
  if (named) {
    tried.push(named);
    const abs = findOnPath(named, env);
    return abs ? answer(abs, "env") : { executable: null, prefix: [], version: null, problem: "not_found", detail: tried.join(", "), source: null };
  }
  if (checker === "mypy" || checker === "pyright") {
    const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
    for (const bin of pythonBins(workspace, componentRoot, env, skipWorkspace)) {
      for (const ext of exts) {
        const candidate = path.join(bin, `${checker}${ext}`);
        tried.push(candidate);
        if (isFile(candidate)) return answer(candidate, "workspace");
      }
    }
  }
  tried.push(`${checker} on PATH`);
  const onPath = findOnPath(checker, env);
  if (onPath) return answer(onPath, "path");
  return { executable: null, prefix: [], version: null, problem: "not_found", detail: tried.join(", "), source: null };
}

/** Finds the checker for a component. Nothing is downloaded or installed. */
export function probeChecker(checker: Checker, workspace: string, componentRoot: string | null, env: NodeJS.ProcessEnv, skipWorkspace = false): CheckerProbe {
  return checker === "tsc" ? probeTsc(workspace, componentRoot, env, skipWorkspace) : probeByName(checker, workspace, componentRoot, env, skipWorkspace);
}
