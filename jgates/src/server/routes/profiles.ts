// Project profiles (Configuração > Perfil): list with what each one changes against its parent, create from an existing
// one (or duplicate), rename, delete (refused with the reason) and mark as default. All writes go through the same
// core functions as `jgates profiles`, by patch on .jgates/profiles.yml and jgates.yml.
import fs from "node:fs";
import path from "node:path";
import { listRuns } from "../../core/artifacts/index.js";
import { resolveConfig } from "../../core/config/resolve/index.js";
import {
  ProfileError,
  createProfile,
  deleteProfile,
  listProfiles,
  renameProfile,
  setDefaultProfile,
  type ProfileInfo,
  type ProfileList,
} from "../../core/profiles/index.js";
import { resolveSelection } from "../../core/selection/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";

const STATUS: Record<string, number> = {
  CONFIG_INVALID: 422,
  PROFILE_ID_INVALID: 400,
  PROFILE_EXISTS: 409,
  PROFILE_NOT_FOUND: 404,
  PROFILE_FROM_NOT_FOUND: 404,
  PROFILE_CYCLE: 409,
  PROFILE_IN_USE: 409,
  SKIP_REJECTED: 422,
  REVISION_CONFLICT: 409,
  ROOT_MISSING: 422,
  PATCH_FAILED: 422,
  PROFILE_READONLY: 403,
  SELECTION_REJECTED: 422,
  POLICY_REJECTED: 422,
};

/** Turns a core refusal into the HTTP answer; the message and the fix are the CLI's. */
export function profileHttpError(error: ProfileError): HttpError {
  return new HttpError(STATUS[error.code] ?? 422, error.code, error.message, error.fix, error.details);
}

export function guard<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ProfileError) throw profileHttpError(error);
    throw error;
  }
}

const idPattern = "^[a-z0-9][a-z0-9._-]{0,127}$";
const refPattern = "^(builtin:)?[a-z0-9][a-z0-9._-]{0,127}$";
const hashPattern = "^[0-9a-f]{64}$";

export interface ProfileChange {
  selector: string;
  value: boolean | string;
  /** What the parent profile resolves for the same selector (null when it resolves nothing). */
  parentValue: boolean | null;
}

export interface ProfileEstimate {
  state: "not-estimated" | "estimated";
  /** Median duration (ms) of comparable runs. */
  ms?: number;
  runs: number;
}

export interface ProfileCard extends ProfileInfo {
  changes: ProfileChange[];
  estimate: ProfileEstimate;
}

const MIN_COMPARABLE_RUNS = 3;

/** Durations of finished, complete runs by the profile they were planned from. */
function durationsByProfile(server: ServerContext): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let runs;
  try {
    runs = listRuns(server.home, server.workspace.id).slice(0, 60);
  } catch {
    return out;
  }
  for (const run of runs) {
    if (run.partial || run.reduced || (run.decision !== "passed" && run.decision !== "failed")) continue;
    try {
      const result = JSON.parse(fs.readFileSync(path.join(run.dir, "result.json"), "utf8")) as Record<string, any>;
      const profile = result.selection?.profile;
      const started = Date.parse(result.startedAt);
      const finished = Date.parse(result.finishedAt);
      if (typeof profile !== "string" || !Number.isFinite(started) || !Number.isFinite(finished) || finished < started) continue;
      const list = out.get(profile) ?? [];
      list.push(finished - started);
      out.set(profile, list);
    } catch {
      // A run folder without a readable result does not count.
    }
  }
  return out;
}

function estimateOf(ref: string, id: string, durations: Map<string, number[]>): ProfileEstimate {
  const list = durations.get(ref) ?? durations.get(id) ?? [];
  if (list.length < MIN_COMPARABLE_RUNS) return { state: "not-estimated", runs: list.length };
  const sorted = [...list].sort((a, b) => a - b);
  return { state: "estimated", ms: sorted[Math.floor(sorted.length / 2)] as number, runs: list.length };
}

/** What a profile resolves per selector, to compare each of its own entries with the parent's value. */
function resolvedEnabled(dir: string, profile: string): Map<string, boolean> {
  const result = resolveConfig(dir, { profile });
  const map = new Map<string, boolean>();
  if (!result.ok) return map;
  for (const item of resolveSelection(result).items) map.set(item.selector, item.enabled);
  return map;
}

export function describeProfiles(server: ServerContext): { list: ProfileList; cards: ProfileCard[] } {
  const list = listProfiles(server.projectDir);
  const durations = durationsByProfile(server);
  const parents = new Map<string, Map<string, boolean>>();
  const cards: ProfileCard[] = list.profiles
    .filter((p) => p.origin === "project")
    .map((p) => {
      const changes: ProfileChange[] = [];
      let parent: Map<string, boolean> | undefined;
      if (p.extends) {
        parent = parents.get(p.extends) ?? resolvedEnabled(server.projectDir, p.extends);
        parents.set(p.extends, parent);
      }
      for (const [selector, body] of Object.entries(p.checks)) {
        const value = body.enabled ?? body.intensity;
        if (value === undefined) continue;
        changes.push({ selector, value, parentValue: typeof body.enabled === "boolean" ? (parent?.get(selector) ?? null) : null });
      }
      return { ...p, changes, estimate: estimateOf(p.ref, p.id, durations) };
    });
  return { list, cards };
}

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/profiles",
    handler({ server }) {
      return guard(() => {
        const { list, cards } = describeProfiles(server);
        const starters = list.profiles.filter((p) => p.origin === "builtin").map((p) => ({ id: p.id, ref: p.ref, label: p.label, description: p.description }));
        return { status: 200, json: { schemaVersion: 1, status: "OK", default: list.default, profiles: cards, starters, revisions: list.revisions } };
      });
    },
  },
  {
    // Create from an existing profile (project or starter); "duplicate" is the same call with the profile's own id as source.
    method: "POST",
    path: "/api/profiles",
    body: {
      type: "object",
      properties: {
        id: { type: "string", pattern: idPattern },
        from: { type: "string", pattern: refPattern },
        label: { type: "string", maxLength: 120 },
        description: { type: "string", maxLength: 400 },
        expectedHash: { type: "string", pattern: hashPattern },
      },
      required: ["id", "from"],
      additionalProperties: false,
    },
    handler({ body, server }) {
      const input = body as { id: string; from: string; label?: string; description?: string; expectedHash?: string };
      return guard(() => {
        const result = createProfile(server.projectDir, input.id, {
          from: input.from,
          ...(input.label ? { label: input.label } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.expectedHash ? { expectedHash: input.expectedHash } : {}),
        });
        server.log(`profile created ${result.id}`);
        return { status: 201, json: { schemaVersion: 1, status: "OK", ...result } };
      });
    },
  },
  {
    method: "PUT",
    path: "/api/profiles/:id/default",
    params: { type: "object", properties: { id: { type: "string", pattern: refPattern } }, required: ["id"], additionalProperties: false },
    body: { type: "object", properties: { expectedHash: { type: "string", pattern: hashPattern } }, additionalProperties: false },
    handler({ params, body, server }) {
      const input = body as { expectedHash?: string };
      return guard(() => {
        const result = setDefaultProfile(server.projectDir, params.id as string, input.expectedHash ? { expectedHash: input.expectedHash } : {});
        server.log(`profile default ${result.default}`);
        return { status: 200, json: { schemaVersion: 1, status: "OK", ...result } };
      });
    },
  },
  {
    method: "PUT",
    path: "/api/profiles/:id/rename",
    params: { type: "object", properties: { id: { type: "string", pattern: idPattern } }, required: ["id"], additionalProperties: false },
    body: {
      type: "object",
      properties: { to: { type: "string", pattern: idPattern }, expectedHash: { type: "string", pattern: hashPattern } },
      required: ["to"],
      additionalProperties: false,
    },
    handler({ params, body, server }) {
      const input = body as { to: string; expectedHash?: string };
      return guard(() => {
        const result = renameProfile(server.projectDir, params.id as string, input.to, input.expectedHash ? { expectedHash: input.expectedHash } : {});
        server.log(`profile renamed ${result.id} ${result.to}`);
        return { status: 200, json: { schemaVersion: 1, status: "OK", ...result } };
      });
    },
  },
  {
    // Refused with the reason (and the file untouched) when another profile extends it or it is the default.
    method: "DELETE",
    path: "/api/profiles/:id",
    params: { type: "object", properties: { id: { type: "string", pattern: idPattern } }, required: ["id"], additionalProperties: false },
    handler({ params, server }) {
      return guard(() => {
        const result = deleteProfile(server.projectDir, params.id as string);
        server.log(`profile deleted ${result.id}`);
        return { status: 200, json: { schemaVersion: 1, status: "OK", ...result } };
      });
    },
  },
];
