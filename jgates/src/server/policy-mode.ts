// The two policy-related modes of the local server.
//  - Governed: the CI policy lives in a folder outside the project (JGATES_POLICY_DIR in the environment of the server).
//    The configuration of the project is then read-only: every route that writes it answers 403.
//  - Policy editing (`jgates ui --policy <folder>`): the server edits the policy folder itself, with the same editors as
//    a project. Nothing here is "governed": the folder is the working area. The screens that validate a project are
//    unavailable, because the folder is not a project.
// This file imports nothing from the server, so the server entry and the route modules can both use it.
import path from "node:path";
import { HttpError } from "./http.js";
import { translator } from "../i18n/index.js";

const t = translator("policy");

export const POLICY_DIR_ENV = "JGATES_POLICY_DIR";
export const POLICY_SHA_ENV = "JGATES_POLICY_SHA256";

// One server edits the policy per process (`jgates ui --policy` serves nothing else), so a module flag is enough.
let editing: string | null = null;

/** Marks this process as the editor of the policy folder `dir` (null clears it). */
export function setPolicyEditing(dir: string | null): void {
  editing = dir;
}

/** The policy folder this process edits, or null. */
export function policyEditingDir(): string | null {
  return editing;
}

export type ModeInfo = { mode: "local" | "governed"; governed: { policy: string; shaPinned: boolean } | null };

export function modeOf(env: NodeJS.ProcessEnv = process.env): ModeInfo {
  if (editing !== null) return { mode: "local", governed: null };
  const dir = env[POLICY_DIR_ENV];
  if (dir === undefined || dir.trim() === "") return { mode: "local", governed: null };
  // Only the folder name goes to the browser: the full path is not needed to explain the lock.
  return { mode: "governed", governed: { policy: path.basename(path.resolve(dir.trim())), shaPinned: (env[POLICY_SHA_ENV] ?? "").trim() !== "" } };
}

/** Paths whose mutations write the configuration of the project (jgates.yml, .jgates/**, tool configuration files). */
const CONFIG_PREFIXES = ["/api/config/", "/api/profiles", "/api/tools", "/api/forms/", "/api/documents/", "/api/pii", "/api/rules/", "/api/workspace/settings", "/api/drafts/"];
/** Mutations under those prefixes that only look at the configuration (or keep a draft outside the project). */
const CONFIG_READ_ONLY = [/\/preview$/, /\/validate$/, /\/check$/, /^\/api\/config\/yaml\/draft$/, /^\/api\/drafts\/[^/]+\/[^/]+$/];

export function writesProjectConfig(method: string, routePath: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  if (!CONFIG_PREFIXES.some((p) => routePath.startsWith(p))) return false;
  return !CONFIG_READ_ONLY.some((re) => re.test(routePath));
}

/** Routes that make no sense when the folder is a policy and not a project: runs, plans of the project, workspaces. */
const PROJECT_ONLY = [/^\/api\/runs(\/|$)/, /^\/api\/plans$/, /^\/api\/validations\/profile$/, /^\/api\/environment\/prepare$/, /^\/api\/workspaces\/open$/];

export function isProjectOnly(method: string, routePath: string): boolean {
  return method !== "GET" && method !== "HEAD" && PROJECT_ONLY.some((re) => re.test(routePath));
}

/** The refusal for a route the current mode does not allow, or null when the route may run. */
export function modeRefusal(method: string, routePath: string): HttpError | null {
  if (editing !== null) {
    if (isProjectOnly(method, routePath)) return new HttpError(409, "POLICY_MODE_UNAVAILABLE", t("policy_mode_unavailable"), t("policy_mode_unavailable_fix"));
    return null;
  }
  const { mode, governed } = modeOf();
  if (mode === "governed" && writesProjectConfig(method, routePath)) {
    return new HttpError(403, "GOVERNED_LOCKED", t("policy_governed_locked", { policy: governed?.policy ?? "" }), t("policy_governed_locked_fix"));
  }
  return null;
}
