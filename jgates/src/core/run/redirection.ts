// What an adapter's manifest says it writes instead of the workspace (redirection.outputPaths): folders of the run
// folder, created before the tool starts, with the variables that point the tool at them. The plan shows them with
// the {runDir} placeholder; the run turns that into the run folder of this run (nothing lands in the project).
import fs from "node:fs";
import path from "node:path";
import type { AdapterManifest, OutputPath } from "../catalog/index.js";

export const RUN_DIR_TOKEN = "{runDir}";

export function outputPathsOf(manifest: AdapterManifest): OutputPath[] {
  return manifest.redirection?.outputPaths ?? [];
}

/** The folder of an output path under a root: the {runDir} placeholder in the plan, a real folder in the run. */
export function outputPathUnder(root: string, entry: OutputPath): string {
  return `${root}/${entry.path}`;
}

/** The output path of the manifest with that purpose (the first one), or undefined. */
export function outputPathFor(manifest: AdapterManifest, purpose: OutputPath["purpose"]): OutputPath | undefined {
  return outputPathsOf(manifest).find((p) => p.purpose === purpose);
}

/**
 * Variables that point the tool at its output paths, under `root` ({runDir} by default). `map` lets a runner put an
 * output path somewhere else (the container sees its output mount, not the host folder).
 */
export function redirectionEnv(manifest: AdapterManifest, root: string = RUN_DIR_TOKEN, map?: (entry: OutputPath) => string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of outputPathsOf(manifest)) {
    const where = map ? map(entry) : outputPathUnder(root, entry);
    for (const name of entry.env ?? []) env[name] = where;
  }
  return env;
}

/** Creates the output paths of the manifest in the run folder (private to the user) and returns their absolute paths. */
export function createOutputPaths(manifest: AdapterManifest, runDir: string): string[] {
  const created: string[] = [];
  for (const entry of outputPathsOf(manifest)) {
    const dir = path.join(runDir, ...entry.path.split("/"));
    const rel = path.relative(runDir, dir);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`output path leaves the run folder: ${entry.path}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    created.push(dir);
  }
  return created;
}
