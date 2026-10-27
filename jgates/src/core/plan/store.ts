import fs from "node:fs";
import path from "node:path";
import { ensureHome, workspaceDir } from "../home/index.js";
import type { Plan } from "./types.js";

/**
 * The last plan of each workspace lives in the data folder, never in the project:
 * <JGATES_HOME>/workspaces/<id>/plans/last-plan.json (0600, folders 0700).
 */
export const PLANS_DIR = "plans";
export const LAST_PLAN_FILE = "last-plan.json";

export function lastPlanFile(home: string, wsId: string): string {
  return path.join(workspaceDir(home, wsId), PLANS_DIR, LAST_PLAN_FILE);
}

/** The previous plan of the workspace, or null when there is none or it cannot be read. */
export function readLastPlan(home: string, wsId: string): Plan | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lastPlanFile(home, wsId), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || typeof (parsed as Plan).planHash !== "string") return null;
    return parsed as Plan;
  } catch {
    return null;
  }
}

function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function writeAtomic(file: string, text: string, mode: number): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

const serialize = (plan: Plan): string => `${JSON.stringify(plan, null, 2)}\n`;

/** Saves the plan as the last plan of its workspace and returns the file. */
export function saveLastPlan(plan: Plan, home: string): string {
  ensureHome(home);
  const file = lastPlanFile(home, plan.workspace.id);
  mkdirPrivate(path.dirname(file));
  writeAtomic(file, serialize(plan), 0o600);
  return file;
}

/** Writes the plan where the user asked (--out); the folder must exist. Returns the absolute path. */
export function writePlanFile(plan: Plan, out: string): string {
  const file = path.resolve(out);
  writeAtomic(file, serialize(plan), 0o644);
  return file;
}

/** Reads a plan file (run --plan). Throws on unreadable or non JSON content. */
export function readPlanFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as unknown;
}
