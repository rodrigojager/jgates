// Plans: built by the core exactly as `jgates plan` does (with the switch-offs of this run only), kept by hash.
import fs from "node:fs";
import path from "node:path";
import { BuiltinError } from "../../builtin/index.js";
import { listRuns } from "../../core/artifacts/index.js";
import { patchYamlFile, patchYamlText, readRevision } from "../../core/codecs/yaml/index.js";
import { loadProjectConfig, validateDocument } from "../../core/config/load/index.js";
import { parseYamlText } from "../../core/config/load/yaml.js";
import { encodePointer, resolveConfig, type CallOverride } from "../../core/config/resolve/index.js";
import { discoverWorkspace } from "../../core/discovery/index.js";
import { buildPlan, readLastPlan, saveLastPlan, PLAN_SCOPES, type Plan, type PlanScopeKind } from "../../core/plan/index.js";
import { createProfile, listProfiles, ProfileError, PROFILES_FILE } from "../../core/profiles/index.js";
import { parseSkipList, resolveSelection, skipOverrides } from "../../core/selection/index.js";
import { HttpError, refuse } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";

export const PLAN_HASH_PATTERN = "^sha256:[0-9a-f]{64}$";

const text = { type: "string", minLength: 1, maxLength: 512 };
const list = { type: "array", items: text, maxItems: 200 };

/** A plan this server knows by hash: built here, or the last plan of the workspace. */
export function findPlan(server: ServerContext, hash: string): Plan | null {
  const known = server.plans.get(hash);
  if (known) return known;
  const last = readLastPlan(server.home, server.workspace.id);
  return last && last.planHash === hash ? last : null;
}

/** A request that may carry the switch-offs of one run (what the "Personalizar esta validação" panel sends). */
interface PlanBody {
  profile?: string;
  scope?: PlanScopeKind;
  paths?: string[];
  base?: string;
  head?: string;
  skip?: string[];
  only?: string[];
  templates?: string[];
  preview?: boolean;
}

export interface ReviewTie {
  selector: string;
  kind: string;
  decision: { selector: string; value: boolean | string; layer: string; source: string; file: string | null; path: string | null } | null;
  overridden: Array<{ selector: string; value: boolean | string; layer: string; source: string; file: string | null; path: string | null }>;
}

const brief = (d: { selector: string; value: boolean | string; layer: string; source: string; file: string | null; path: string | null }) => ({
  selector: d.selector,
  value: d.value,
  layer: d.layer,
  source: d.source,
  file: d.file,
  path: d.path,
});

/**
 * What the review shows besides the plan: the ties of the selection (decisions of the same layer and specificity that
 * disagreed and were settled in favour of "enabled") and the execution settings. Neither is part of the plan hash, so
 * they are read again from the same request the plan was built from.
 */
export function selectionReview(projectDir: string, b: PlanBody): { ties: ReviewTie[]; execution: { concurrency: number | null; network: string | null } } {
  const none = { ties: [] as ReviewTie[], execution: { concurrency: null as number | null, network: null as string | null } };
  try {
    const inventory = discoverWorkspace(projectDir).inventory;
    const overrides: CallOverride[] = [
      ...(b.only ?? []).map((selector) => ({ pointer: encodePointer(["checks", selector, "enabled"]), value: true, source: "--only" })),
      ...skipOverrides(b.skip ?? []),
    ];
    const resolved = resolveConfig(projectDir, {
      inventory,
      ...(b.profile !== undefined ? { profile: b.profile } : {}),
      ...((b.templates ?? []).length > 0 ? { templates: b.templates } : {}),
      ...(overrides.length > 0 ? { overrides } : {}),
    });
    if (!resolved.ok) return none;
    const execution = (resolved.config as { execution?: { concurrency?: unknown; network?: unknown } }).execution ?? {};
    const selection = resolveSelection(resolved, { inventory });
    return {
      ties: selection.items
        .filter((i) => i.tie === true)
        .map((i) => ({ selector: i.selector, kind: i.kind, decision: i.decision ? brief(i.decision) : null, overridden: i.overridden.map(brief) })),
      execution: { concurrency: typeof execution.concurrency === "number" ? execution.concurrency : null, network: typeof execution.network === "string" ? execution.network : null },
    };
  } catch {
    return none;
  }
}

/** Median duration of the last finished runs of the workspace; null without history (the review shows no estimate then). */
export function estimateMs(server: ServerContext): { ms: number; runs: number } | null {
  const durations: number[] = [];
  for (const run of listRuns(server.home, server.workspace.id).slice(0, 12)) {
    if (run.partial || run.decision === null) continue;
    try {
      const result = JSON.parse(fs.readFileSync(path.join(run.dir, "result.json"), "utf8")) as { startedAt?: string; finishedAt?: string };
      const ms = Date.parse(result.finishedAt ?? "") - Date.parse(result.startedAt ?? "");
      if (Number.isFinite(ms) && ms > 0) durations.push(ms);
    } catch {
      // A result that cannot be read does not count.
    }
    if (durations.length >= 5) break;
  }
  if (durations.length === 0) return null;
  durations.sort((a, b) => a - b);
  return { ms: durations[Math.floor(durations.length / 2)] as number, runs: durations.length };
}

function profileFailure(error: ProfileError): HttpError {
  const status = error.code === "REVISION_CONFLICT" || error.code === "PROFILE_EXISTS" ? 409 : 422;
  return new HttpError(status, error.code, error.message, error.fix, error.details);
}

const PROFILE_ID = "^[a-z0-9][a-z0-9._-]*$";

export const routes: RouteDefinition[] = [
  {
    method: "POST",
    path: "/api/plans",
    body: {
      type: "object",
      properties: {
        profile: text,
        scope: { enum: [...PLAN_SCOPES] },
        paths: list,
        base: text,
        head: text,
        skip: list,
        only: list,
        templates: list,
        // A preview is the plan of the "Personalizar" panel: built the same way, but not kept as the last plan.
        preview: { type: "boolean" },
      },
      additionalProperties: false,
    },
    timeoutMs: 120_000,
    handler({ body, server }) {
      const b = body as PlanBody;
      let result;
      try {
        result = buildPlan(server.projectDir, {
          ...(b.profile !== undefined ? { profile: b.profile } : {}),
          ...(b.scope !== undefined ? { scope: b.scope } : {}),
          ...(b.base !== undefined ? { base: b.base } : {}),
          ...(b.head !== undefined ? { head: b.head } : {}),
          paths: b.paths ?? [],
          skip: b.skip ?? [],
          only: b.only ?? [],
          templates: b.templates ?? [],
          version: server.version,
          home: server.home,
        });
      } catch (error) {
        if (error instanceof BuiltinError) throw new HttpError(500, "BUILTIN_INVALID", error.message);
        throw error;
      }
      if (!result.ok) {
        const { code, message, fix } = result.error;
        throw new HttpError(422, code, message, fix ?? null, { errors: result.errors, diagnostics: result.diagnostics });
      }
      const plan = result.plan;
      if (b.preview !== true) saveLastPlan(plan, server.home);
      server.plans.set(plan.planHash, plan);
      while (server.plans.size > 20) server.plans.delete(server.plans.keys().next().value as string);
      return { status: 201, json: { schemaVersion: 1, status: plan.blocked ? "BLOCKED" : "OK", planHash: plan.planHash, approvable: plan.approvable, blocked: plan.blocked, plan, review: { ...selectionReview(server.projectDir, b), estimate: estimateMs(server) } } };
    },
  },
  {
    // Escolher: the profiles of the project as cards and the summary of the criteria (policy.yml) in force.
    method: "GET",
    path: "/api/validations/choose",
    handler({ server }) {
      let list;
      try {
        list = listProfiles(server.projectDir);
      } catch (error) {
        if (error instanceof ProfileError) throw profileFailure(error);
        throw error;
      }
      const loaded = loadProjectConfig(server.projectDir);
      const policy = loaded.byKind.policy as { value?: Record<string, unknown> } | undefined;
      const rules = (policy?.value?.rules ?? {}) as Record<string, { enabled?: boolean; severity?: string; locked?: boolean; threshold?: number }>;
      const evidence = Array.isArray(policy?.value?.requiredEvidence) ? (policy?.value?.requiredEvidence as unknown[]).length : 0;
      const exceptions = Array.isArray(policy?.value?.exceptions) ? (policy?.value?.exceptions as unknown[]).length : 0;
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          default: list.default,
          profiles: list.profiles.map((p) => ({ id: p.id, ref: p.ref, origin: p.origin, label: p.label, description: p.description, extends: p.extends, isDefault: p.isDefault, checks: p.checks })),
          criteria: {
            present: policy !== undefined,
            rules: Object.entries(rules).map(([rule, v]) => ({ rule, threshold: v.threshold ?? null, severity: v.severity ?? null, locked: v.locked === true, enabled: v.enabled !== false })),
            requiredEvidence: evidence,
            exceptions,
          },
        },
      };
    },
  },
  {
    // "Salvar como perfil" (create) and "Salvar no perfil atual" (update): the only writes of the panel, always an explicit click.
    method: "POST",
    path: "/api/validations/profile",
    body: {
      type: "object",
      properties: {
        mode: { enum: ["create", "update"] },
        id: { type: "string", pattern: PROFILE_ID, maxLength: 64 },
        from: text,
        label: { type: "string", maxLength: 120 },
        skip: list,
      },
      required: ["mode", "id", "skip"],
      additionalProperties: false,
    },
    handler({ body, server }) {
      const b = body as { mode: "create" | "update"; id: string; from?: string; label?: string; skip: string[] };
      try {
        if (b.mode === "create") {
          const result = createProfile(server.projectDir, b.id, { from: b.from ?? "standard", skip: b.skip, ...(b.label ? { label: b.label } : {}) });
          return { status: 201, json: { schemaVersion: 1, status: "OK", id: result.id, extends: result.extends, file: result.file, checks: result.checks } };
        }
        const list = listProfiles(server.projectDir);
        const current = list.profiles.find((p) => p.origin === "project" && p.id === b.id);
        if (!current) throw new ProfileError("PROFILE_NOT_FOUND", `O perfil ${b.id} não é um perfil do projeto (os perfis iniciais não são alterados).`, "Use Salvar como perfil para criar um perfil novo a partir dele.");
        const selectors = parseSkipList(b.skip);
        const edits = selectors.map((selector) => ({ op: "set" as const, path: ["profiles", b.id, "checks", selector, "enabled"], value: false }));
        const file = current.file ?? PROFILES_FILE;
        const abs = path.join(server.projectDir, file);
        const rev = readRevision(abs);
        const preview = patchYamlText(rev.text, edits);
        const parsed = parseYamlText(preview.text.charCodeAt(0) === 0xfeff ? preview.text.slice(1) : preview.text, file);
        const diagnostics = [...parsed.diagnostics, ...(parsed.diagnostics.length === 0 ? validateDocument("profiles", parsed.value, file, { doc: parsed.doc, lineCounter: parsed.lineCounter }) : [])];
        if (diagnostics.length > 0) throw new ProfileError("PATCH_FAILED", `O ${file} ficaria inválido: ${diagnostics[0]?.message ?? ""}`, null);
        const written = patchYamlFile(abs, edits, { expectedHash: rev.hash });
        return { status: 200, json: { schemaVersion: 1, status: "OK", id: b.id, file, changed: written.changed, checks: Object.fromEntries(selectors.map((s) => [s, { enabled: false }])) } };
      } catch (error) {
        if (error instanceof ProfileError) throw profileFailure(error);
        throw error;
      }
    },
  },
  {
    method: "GET",
    path: "/api/plans/last",
    handler({ server }) {
      const plan = readLastPlan(server.home, server.workspace.id);
      if (!plan) throw refuse(404, "PLAN_NOT_FOUND");
      return { status: 200, json: { schemaVersion: 1, status: "OK", planHash: plan.planHash, plan } };
    },
  },
  {
    method: "GET",
    path: "/api/plans/:hash",
    params: { type: "object", properties: { hash: { type: "string", pattern: PLAN_HASH_PATTERN } }, required: ["hash"], additionalProperties: false },
    handler({ params, server }) {
      const plan = findPlan(server, params.hash as string);
      if (!plan) throw refuse(404, "PLAN_NOT_FOUND");
      return { status: 200, json: { schemaVersion: 1, status: "OK", planHash: plan.planHash, plan } };
    },
  },
];
