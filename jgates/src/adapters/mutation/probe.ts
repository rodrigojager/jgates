// Finds the mutation testing engines without installing or changing anything. Container-first, both come from the
// tools image (image.json: stryker, mutmut), and mutmut runs in the Linux container, so Windows hosts are no longer
// refused. Inside the image only: JGATES_STRYKER, then the project's node_modules, for Stryker; JGATES_PYTHON (the
// project's Python, asked through importlib.metadata) for mutmut. Never a mutation run.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findOnPath, resolveProjectPython } from "../../core/bridge/index.js";
import { imageProbeUnlessOverridden, inImageOverride, probeImageTool } from "../../core/tools-image/catalogue.js";
import { stepMode } from "../../core/runner/in-image.js";
import { probeEnv } from "../../core/runner/probe-env.js";

export const STRYKER_PACKAGE = "@stryker-mutator/core";

export interface StrykerProbe {
  /** What runs: Node plus the entry script, or the executable itself. */
  executable: string | null;
  prefix: string[];
  version: string | null;
  source: "env" | "workspace" | "path" | "image" | null;
  problem: "not_found" | "no_version" | null;
  detail: string;
}

export interface MutmutProbe {
  python: string | null;
  /** The image's `mutmut` command (its own environment); false or absent: `python -m mutmut` of the named interpreter. */
  command?: boolean;
  version: string | null;
  problem: "python_missing" | "no_mutmut" | "windows" | "not_in_image" | null;
  detail: string;
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    const doc = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    return typeof doc === "object" && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

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

/** Stryker's entry script and version from a node_modules folder that has the package. */
function fromNodeModules(nodeModules: string, source: "workspace" | "path"): StrykerProbe | null {
  const dir = path.join(nodeModules, ...STRYKER_PACKAGE.split("/"));
  const pkg = readJson(path.join(dir, "package.json"));
  if (!pkg || pkg.name !== STRYKER_PACKAGE) return null;
  const bin = pkg.bin;
  const rel = typeof bin === "string" ? bin : typeof bin === "object" && bin !== null ? ((bin as Record<string, unknown>).stryker as string | undefined) : undefined;
  const entry = rel ? path.join(dir, rel) : null;
  const version = typeof pkg.version === "string" ? pkg.version : null;
  if (!entry || !fs.existsSync(entry)) return { executable: null, prefix: [], version, source, problem: "not_found", detail: dir };
  return { executable: process.execPath, prefix: [entry], version, source, problem: version ? null : "no_version", detail: version ? "" : dir };
}

/** Container-first: the tools image's Stryker. Inside the image only: JGATES_STRYKER (a file), then
 * node_modules/@stryker-mutator/core from the component folder up to the workspace root, then the image's copy. */
export function findStryker(workspace: string, componentRoot: string | null, env: NodeJS.ProcessEnv): StrykerProbe {
  const named = inImageOverride(env, "JGATES_STRYKER");
  if (named) {
    const abs = findOnPath(named, env);
    if (!abs) return { executable: null, prefix: [], version: null, source: null, problem: "not_found", detail: named };
    const script = /\.(mjs|cjs|js)$/i.test(abs);
    const r = spawnSync(script ? process.execPath : abs, [...(script ? [abs] : []), "--version"], { encoding: "utf8", timeout: 30_000, env: probeEnv(env, { PATH: env.PATH ?? "", HOME: env.HOME ?? "" }), windowsHide: true, shell: !script && /\.(cmd|bat)$/i.test(abs) });
    const version = r.status === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? null) : null;
    return { executable: script ? process.execPath : abs, prefix: script ? [abs] : [], version, source: "env", problem: version ? null : "no_version", detail: version ? "" : abs };
  }
  if (stepMode(env) === "in-image") {
    const start = componentRoot && componentRoot !== "." ? path.join(workspace, componentRoot) : workspace;
    for (const dir of ancestors(start, workspace)) {
      const hit = fromNodeModules(path.join(dir, "node_modules"), "workspace");
      if (hit) return hit;
    }
  }
  const image = probeImageTool("stryker", env);
  return image.problem === null
    ? { executable: image.executable, prefix: [], version: image.version, source: "image", problem: null, detail: "" }
    : { executable: null, prefix: [], version: null, source: null, problem: "not_found", detail: image.detail };
}

export interface StrykerNetProbe {
  executable: string | null;
  prefix: string[];
  version: string | null;
  problem: "not_found" | null;
  detail: string;
}

/**
 * Stryker.NET: the tools image's dotnet-stryker (image.json, nothing starts). Inside the image only, JGATES_DOTNET_STRYKER
 * names another command (a Node script stands for it through Node); its version is the image catalogue's.
 */
export function findStrykerNet(env: NodeJS.ProcessEnv): StrykerNetProbe {
  const named = inImageOverride(env, "JGATES_DOTNET_STRYKER");
  const image = probeImageTool("dotnet-stryker", env);
  if (named) {
    const abs = findOnPath(named, env);
    if (!abs) return { executable: null, prefix: [], version: null, problem: "not_found", detail: named };
    const script = /\.(mjs|cjs|js)$/i.test(abs);
    return { executable: script ? process.execPath : abs, prefix: script ? [abs] : [], version: image.version ?? "0.0.0", problem: null, detail: "" };
  }
  return image.problem === null && image.executable !== null
    ? { executable: image.executable, prefix: [], version: image.version, problem: null, detail: "" }
    : { executable: null, prefix: [], version: null, problem: "not_found", detail: image.detail };
}

const known = new Map<string, { mtimeMs: number; version: string | null }>();

export function findMutmut(env: NodeJS.ProcessEnv): MutmutProbe {
  const image = imageProbeUnlessOverridden("mutmut", env, "JGATES_PYTHON");
  if (image) return image.problem === null ? { python: "mutmut", command: true, version: image.version, problem: null, detail: "" } : { python: null, version: null, problem: "not_in_image", detail: image.detail };
  const { interpreter, tried } = resolveProjectPython(env);
  if (!interpreter) return { python: null, version: null, problem: "python_missing", detail: tried.join(", ") };
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(interpreter).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  let hit = known.get(interpreter);
  if (!hit || hit.mtimeMs !== mtimeMs) {
    const r = spawnSync(interpreter, ["-c", "import importlib.metadata as m; print(m.version('mutmut'))"], {
      encoding: "utf8",
      timeout: 30_000,
      env: probeEnv(env, { PATH: env.PATH ?? "", HOME: env.HOME ?? "", PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" }),
      windowsHide: true,
    });
    hit = { mtimeMs, version: r.status === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? null) : null };
    known.set(interpreter, hit);
  }
  if (!hit.version) return { python: interpreter, version: null, problem: "no_mutmut", detail: interpreter };
  // mutmut 3 forks worker processes: it refuses to run natively on Windows.
  if (process.platform === "win32") return { python: interpreter, version: hit.version, problem: "windows", detail: interpreter };
  return { python: interpreter, version: hit.version, problem: null, detail: "" };
}
