// The host record of the dependency volumes of a workspace: which volume is the good one of each unit, with its key and
// when it was installed, and the last failure. It lives in the data folder (never in the project); the key is also
// stored inside the volume (/.jgates-deps.json, written last by the install), so a lost record only costs one
// check container, never a wrong reuse.
import fs from "node:fs";
import path from "node:path";
import { workspaceDir } from "../home/index.js";
import { renameWithRetry } from "../fs-retry/index.js";

export interface UnitRecord {
  /** The volume in use (jgates-<ws>-deps-<unit>-<key12>). */
  volume: string;
  key: string;
  manager: string;
  installRoot: string;
  installedAt: string;
}

export interface UnitFailure {
  key: string;
  at: string;
  code: string;
  message: string;
}

export interface DepsState {
  schemaVersion: 1;
  units: Record<string, UnitRecord>;
  failures: Record<string, UnitFailure>;
}

const EMPTY: DepsState = { schemaVersion: 1, units: {}, failures: {} };

export function depsStateFile(home: string, workspace: string): string {
  return path.join(workspaceDir(home, workspace), "deps", "state.json");
}

export function readDepsState(home: string, workspace: string): DepsState {
  try {
    const doc = JSON.parse(fs.readFileSync(depsStateFile(home, workspace), "utf8")) as Partial<DepsState>;
    return { schemaVersion: 1, units: { ...(doc.units ?? {}) }, failures: { ...(doc.failures ?? {}) } };
  } catch {
    return { ...EMPTY, units: {}, failures: {} };
  }
}

export function writeDepsState(home: string, workspace: string, state: DepsState): void {
  const file = depsStateFile(home, workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameWithRetry(tmp, file);
}

/** Read-modify-write of the record (one unit at a time; the deps of a workspace are prepared sequentially). */
export function updateDepsState(home: string, workspace: string, change: (state: DepsState) => void): DepsState {
  const state = readDepsState(home, workspace);
  change(state);
  writeDepsState(home, workspace, state);
  return state;
}
