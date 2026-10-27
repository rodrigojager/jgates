import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { SUPPORTED_LOCALES, getLocale, translator, withLocale } from "../../i18n/index.js";
import { canonicalJson, canonicalPath } from "../ids/index.js";
import { buildPlan, computePlanHash } from "./build.js";
import { diffPlans } from "./diff.js";
import type { BuildPlanOptions, Plan, PlanChanges } from "./types.js";

/** jgates/schemas/plan, found from dist/core/plan. */
export function planSchemaFile(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "schemas", "plan", "plan.schema.json");
}

type Validator = ((doc: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };
let validator: Validator | null = null;

function planValidator(): Validator {
  if (validator) return validator;
  const require = createRequire(import.meta.url);
  const mod = require("ajv/dist/2020") as { default: new (opts: object) => { compile(schema: unknown): Validator } };
  const ajv = new mod.default({ strict: true, allErrors: true, allowUnionTypes: true });
  validator = ajv.compile(JSON.parse(fs.readFileSync(planSchemaFile(), "utf8")));
  return validator;
}

/** Validates a plan document against schemas/plan/plan.schema.json; returns the problems (empty when valid). */
export function validatePlanDocument(doc: unknown): string[] {
  const validate = planValidator();
  if (validate(doc)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
}

/**
 * Rebuilds a received plan in the language it was made in. A plan carries human text (reasons, labels, messages) in
 * the locale of the process that built it, and that text is part of its hash: a plan made with --locale pt-BR and run
 * with --locale en is still the same plan. The process locale goes first and another supported locale is tried only
 * when the hash differs; the first exact match wins. When none matches, the rebuild in the process locale is returned,
 * so the caller reports what differs.
 */
export function rebuildInPlanLocale<T>(expectedHash: string, build: () => T, hashOf: (built: T) => string | null): T {
  const first = build();
  if (hashOf(first) === expectedHash) return first;
  const processLocale = getLocale();
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === processLocale) continue;
    const other = withLocale(locale, build);
    if (hashOf(other) === expectedHash) return other;
  }
  return first;
}

export type PlanCheckCode = "PLAN_INVALID" | "PLAN_TAMPERED" | "PLAN_WORKSPACE_MISMATCH" | "PLAN_STALE";

export interface PlanCheck {
  ok: boolean;
  code: PlanCheckCode | null;
  message: string | null;
  fix: string | null;
  problems: string[];
  /** What differs between the received plan and the plan the workspace gives now. */
  changes: PlanChanges | null;
  /** The plan rebuilt from the workspace with the same request (absent when it could not be built). */
  current?: Plan;
}

export interface ValidatePlanOptions extends Pick<BuildPlanOptions, "version" | "env"> {}

/**
 * Confronts a received plan (run --plan) with its schema, its hash and the workspace:
 * - PLAN_INVALID: not a plan document;
 * - PLAN_TAMPERED: the hash does not match the content, or the content differs from what the same
 *   configuration gives (an edited command never runs as if it came from the internal plan);
 * - PLAN_WORKSPACE_MISMATCH: the plan belongs to another folder;
 * - PLAN_STALE: the configuration, templates, inventory or versions changed since the plan: a new plan is needed.
 * Never throws for a bad plan; ok is true only when the plan is exactly what the workspace gives now.
 */
export function validatePlanAgainstWorkspace(plan: unknown, projectDir: string, options: ValidatePlanOptions = {}): PlanCheck {
  const t = translator("plan");
  const fail = (code: PlanCheckCode, key: string, problems: string[] = [], extra: Partial<PlanCheck> = {}): PlanCheck => ({
    ok: false,
    code,
    message: t(key, { count: problems.length, detail: problems.slice(0, 3).join("; ") }),
    fix: t(`${key}_fix`),
    problems,
    changes: null,
    ...extra,
  });

  const problems = validatePlanDocument(plan);
  if (problems.length > 0) return fail("PLAN_INVALID", "plan_check_invalid", problems);
  const doc = plan as Plan;
  if (computePlanHash(doc) !== doc.planHash) return fail("PLAN_TAMPERED", "plan_check_hash", ["planHash does not match the content"]);

  const dir = path.resolve(projectDir);
  let samePlace = false;
  try {
    samePlace = canonicalPath(dir) === canonicalPath(doc.workspace.path);
  } catch {
    samePlace = false;
  }
  if (!samePlace) return fail("PLAN_WORKSPACE_MISMATCH", "plan_check_workspace", [`${doc.workspace.path} != ${dir}`]);

  const r = doc.selection.request;
  const rebuilt = rebuildInPlanLocale(
    doc.planHash,
    () =>
      buildPlan(dir, {
        ...(r.profile !== null ? { profile: r.profile } : {}),
        scope: r.scope,
        paths: r.paths,
        ...(r.base !== null ? { base: r.base } : {}),
        ...(r.head !== null ? { head: r.head } : {}),
        skip: r.skip,
        only: r.only,
        templates: r.templates,
        compare: false,
        ...(options.version !== undefined ? { version: options.version } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
      }),
    (built) => (built.ok ? built.plan.planHash : null),
  );
  if (!rebuilt.ok) return fail("PLAN_STALE", "plan_check_stale", [rebuilt.error.message]);
  const current = rebuilt.plan;
  if (current.planHash === doc.planHash) return { ok: true, code: null, message: null, fix: null, problems: [], changes: null, current };

  const changes = diffPlans(doc, current);
  const inputsChanged = canonicalJson(doc.inputs) !== canonicalJson(current.inputs) || canonicalJson(doc.versions) !== canonicalJson(current.versions);
  const detail = [
    ...changes.configFiles.changed.map((f) => `changed: ${f}`),
    ...changes.configFiles.added.map((f) => `added: ${f}`),
    ...changes.configFiles.removed.map((f) => `removed: ${f}`),
    ...changes.versions.map((v) => `version ${v.field}: ${String(v.from)} -> ${String(v.to)}`),
    ...changes.items.changed.map((c) => `${c.id}: ${c.fields.map((f) => f.field).join(", ")}`),
    ...changes.items.added.map((id) => `item added: ${id}`),
    ...changes.items.removed.map((id) => `item removed: ${id}`),
  ];
  if (inputsChanged) return fail("PLAN_STALE", "plan_check_stale", detail, { changes, current });
  return fail("PLAN_TAMPERED", "plan_check_tampered", detail.length > 0 ? detail : ["content differs from the plan the configuration gives"], { changes, current });
}
