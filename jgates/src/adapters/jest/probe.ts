// Finds the project's Jest without running or installing anything. Jest is not in the tools image: it is the project's
// own dev dependency, installed into the dependency volume by the run's deps phase, so the plan only asks whether the
// component (or the workspace root) declares it, and the step runs `jest` from the volume's node_modules/.bin. Inside the
// image (in-image mode) the installed copy is looked for in node_modules from the component up to the workspace;
// JGATES_JEST names another entry file there.
import fs from "node:fs";
import path from "node:path";
import { findOnPath } from "../../core/runner/path-lookup.js";
import { inImageOverride } from "../../core/tools-image/catalogue.js";
import { stepMode } from "../../core/runner/in-image.js";
import type { RunnerProbe } from "../test-common/index.js";

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readJson(p: string): Record<string, unknown> | null {
  try {
    const doc = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    return isRec(doc) ? doc : null;
  } catch {
    return null;
  }
}

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

/** The version of the `jest` package that holds `file` (walking up), or null. */
function jestPackageVersion(file: string): string | null {
  let dir = path.dirname(file);
  for (let i = 0; i < 12; i++) {
    const pkg = readJson(path.join(dir, "package.json"));
    if (pkg && pkg.name === "jest") return typeof pkg.version === "string" ? pkg.version : null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** The package.json of the folders that declares jest, with the version its lock file pins (when there is one). */
export function declaredJest(scanDir: string, workspace: string): { file: string; version: string | null } | null {
  for (const dir of ancestors(scanDir, workspace)) {
    const pkg = readJson(path.join(dir, "package.json"));
    if (!pkg) continue;
    const declared = ["devDependencies", "dependencies", "optionalDependencies"].some((k) => isRec(pkg[k]) && Object.prototype.hasOwnProperty.call(pkg[k], "jest"));
    if (!declared) continue;
    const lock = readJson(path.join(dir, "package-lock.json"));
    const packages = lock && isRec(lock.packages) ? lock.packages : null;
    const entry = packages && isRec(packages["node_modules/jest"]) ? packages["node_modules/jest"] : null;
    return { file: path.relative(workspace, path.join(dir, "package.json")).split(path.sep).join("/"), version: entry && typeof entry.version === "string" ? entry.version : null };
  }
  return null;
}

export function probeJest(env: NodeJS.ProcessEnv, workspace: string, scanDir: string): RunnerProbe {
  const named = inImageOverride(env, "JGATES_JEST");
  if (named !== null) {
    const abs = findOnPath(named, env);
    if (!abs) return { executable: null, prefix: [], version: null, problem: "not_found", detail: named };
    const version = jestPackageVersion(abs) ?? "0.0.0";
    return /\.(?:mjs|cjs|js)$/i.test(abs) ? { executable: process.execPath, prefix: [abs], version, problem: null, detail: "" } : { executable: abs, prefix: [], version, problem: null, detail: "" };
  }
  if (stepMode(env) === "in-image") {
    for (const dir of ancestors(scanDir, workspace)) {
      const entry = path.join(dir, "node_modules", "jest", "bin", "jest.js");
      if (fs.existsSync(entry)) return { executable: process.execPath, prefix: [entry], version: jestPackageVersion(entry), problem: null, detail: "" };
    }
    return { executable: null, prefix: [], version: null, problem: "not_found", detail: "node_modules/jest" };
  }
  const declared = declaredJest(scanDir, workspace);
  if (!declared) return { executable: null, prefix: [], version: null, problem: "not_found", detail: "package.json (devDependencies.jest)" };
  // The deps phase installs it; the step's PATH starts with the volume's node_modules/.bin.
  return { executable: "jest", prefix: [], version: declared.version, problem: null, detail: "" };
}
