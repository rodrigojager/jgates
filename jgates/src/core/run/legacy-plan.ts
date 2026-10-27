// The plan of a project without jgates.yml (the run executes exactly one plan). The option flags of the
// option-driven run (--bridge-mode, --enable-pii, --enable-secrets, --disable-iac, --run-project-tests, --enable-coverage)
// become an equivalent plan: one bridge invocation whose request is exactly what the option-driven run sent, and
// one item per subcheck and capability, on or off as the bridge requirement table decides for those options. The
// run writes it to plan.json and executes it like any other plan; the step keeps the bridge's own answers for a
// missing Python or sidecar (no preflight), so the results of the option-driven run do not change.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { qualityBridgeManifest } from "../../adapters/quality-bridge/manifest.js";
import { normalizeBridge } from "../../adapters/quality-bridge/normalize.js";
import { buildRequest, executeBridge } from "../../adapters/quality-bridge/index.js";
import { requestFromPlan } from "../../adapters/quality-bridge/from-plan.js";
import { ADAPTER_ID, planSubchecks, type BridgeMode, type BridgeSelection, type SubcheckPlan } from "../../adapters/quality-bridge/requirements.js";
import type { BridgeRequest } from "../bridge/index.js";
import { resolvePython, resolveSidecarDir } from "../bridge/index.js";
import { CORE_CAPABILITIES } from "../catalog/index.js";
import { discoverWorkspace } from "../discovery/index.js";
import { canonicalJson, canonicalPath, contentHash, workspaceId } from "../ids/index.js";
import { computePlanHash, diffPlans, rebuildInPlanLocale, RUN_DIR_TOKEN, validatePlanDocument, type PlanCheck, type PlanCheckCode } from "../plan/index.js";
import type { Plan, PlanBody, PlanCommand, PlanItem, PlanRequirement, StateOrigin } from "../plan/types.js";
import type { RunStep } from "../runner/index.js";
import type { AdapterContext, AdapterOutput } from "./types.js";

export const LEGACY_PLAN_WARNING = "PLAN_FROM_OPTIONS";
const BRIDGE_ARGS = ["-m", "quality_sidecar", "bridge"];
const TIMEOUT_SECONDS = 30 * 60;

const subcheckIds = (): string[] => (qualityBridgeManifest.subchecks ?? []).map((s) => s.id);
const categoryOf = new Map(CORE_CAPABILITIES.map((c) => [c.id, c.category ?? null]));

function sidecarVersion(sidecarDir: string | null): string | null {
  if (!sidecarDir) return null;
  try {
    const text = fs.readFileSync(path.join(path.dirname(sidecarDir), "pyproject.toml"), "utf8");
    return /^version\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The option selection a legacy plan was built from, read back from its bridge request. */
export function legacySelection(request: Pick<BridgeRequest, "mode" | "pii" | "secrets" | "iac" | "projectTests" | "coverage">): BridgeSelection {
  return {
    mode: request.mode as BridgeMode,
    pii: request.pii === true,
    secrets: request.secrets === true,
    iac: request.iac !== false,
    projectTests: request.projectTests === true,
    coverage: request.coverage === true,
  };
}

export interface LegacyPlanOptions {
  version: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

/** Builds the plan that stands for the option-driven run of a project without JGates configuration. */
export function legacyPlan(workspacePath: string, selection: BridgeSelection, options: LegacyPlanOptions): Plan {
  const t = translator("run");
  const tp = translator("plan");
  const env = options.env ?? process.env;
  const dir = path.resolve(workspacePath);
  const inventory = discoverWorkspace(dir).inventory;
  const { interpreter } = resolvePython(env);
  const sidecarDir = resolveSidecarDir(env);
  const toolVersion = sidecarVersion(sidecarDir);
  const available = interpreter !== null && sidecarDir !== null;
  const legacy: BridgeSelection = { mode: selection.mode, pii: selection.pii, secrets: selection.secrets, iac: selection.iac, projectTests: selection.projectTests, coverage: selection.coverage };
  const command: PlanCommand = {
    invocation: ADAPTER_ID,
    executable: interpreter ?? env.JGATES_PYTHON ?? "python",
    args: [...BRIDGE_ARGS],
    cwd: RUN_DIR_TOKEN,
    env: sidecarDir ? { PYTHONPATH: sidecarDir } : {},
    stdin: { ...buildRequest(legacy, dir, `${RUN_DIR_TOKEN}/outputs/${ADAPTER_ID}`) },
  };
  const plans = new Map<string, SubcheckPlan>(planSubchecks(legacy, subcheckIds()).map((p) => [p.subcheckId, p]));
  const approvable = inventory.classifications.filter((c) => c.approvable);
  const refs = approvable.map((c) => ({ id: c.id, root: c.componentRoot, language: c.language }));
  const workspaceWrites = [...(qualityBridgeManifest.redirection?.unavoidableWorkspaceWrites ?? [])];

  const willRun: PlanItem[] = [];
  const off: PlanItem[] = [];
  for (const sub of qualityBridgeManifest.subchecks ?? []) {
    const plan = plans.get(sub.id) as SubcheckPlan;
    const on = plan.required;
    const origin: StateOrigin = on ? "defaults" : plan.disabled?.origin === "run" ? "run" : "profile";
    const limitations = [...(sub.limitations ?? [])];
    for (const capability of sub.capabilities) {
      const itemCommand = on ? { ...command, args: [...command.args], env: { ...command.env }, stdin: { ...(command.stdin as Record<string, unknown>) } } : null;
      const tool = `${ADAPTER_ID}.${sub.id}`;
      const item: PlanItem = {
        id: `${tool}#${capability}`,
        identity: contentHash({ tool, capability, adapter: ADAPTER_ID, granularity: "workspace", components: refs.map((c) => c.id), command: itemCommand ? { executable: itemCommand.executable, args: itemCommand.args, stdin: itemCommand.stdin } : null }),
        tool,
        adapter: ADAPTER_ID,
        subcheck: sub.id,
        label: sub.label,
        category: categoryOf.get(capability) ?? null,
        capabilities: [capability],
        components: refs,
        languages: [...new Set(refs.map((c) => c.language).filter((l): l is string => l !== null))].sort(),
        granularity: "workspace",
        scope: { requested: "full", effective: "full", context: [...(qualityBridgeManifest.minimumContext ?? ["workspace"])] },
        requirement: !on ? "optional" : plan.skipMeans === "not_applicable" ? "conditional" : "required",
        conditions: [...(sub.conditions ?? [])],
        limitations,
        reason: { code: on ? "OPTIONS_SELECTED" : "OPTIONS_DISABLED", message: plan.reason },
        origin: { kind: origin, selector: null, layer: null, source: "options", file: null, path: null, pointer: null },
        includedBy: [{ kind: "adapter", entry: null, source: `adapter:${ADAPTER_ID}`, file: null, reason: null, matched: [] }],
        state: {
          enabled: on,
          origin,
          originLabel: tp(`plan_origin_${origin}`, { source: "options", file: "-" }),
          reason: origin === "run" ? "EXPLICIT" : "DEFAULT",
          decision: null,
          overridden: [],
          runOnly: origin === "run",
          locked: [],
        },
        command: itemCommand,
        runtime: { name: "python", interpreter, available },
        versions: { adapter: qualityBridgeManifest.adapterVersion, tool: qualityBridgeManifest.toolName, toolVersion, rules: null },
        configFiles: [],
        network: limitations.some((l) => /network/i.test(l)),
        effects: { readsCode: true, writesOutputs: true, mayChangeCode: false, executesProjectCode: limitations.some((l) => /executes project code/i.test(l)), workspaceWrites: [...workspaceWrites] },
        limits: { timeoutSeconds: TIMEOUT_SECONDS },
        output: { format: "json", schema: "bridge-response.schema.json" },
        dependsOn: [],
        availability: available
          ? { status: "available", reason: null }
          : { status: "unavailable", reason: interpreter === null ? tp("plan_python_missing", { python: env.JGATES_PYTHON ?? "python" }) : tp("plan_sidecar_missing") },
        bridge: { skipMeans: plan.skipMeans, invoked: on },
      };
      (on ? willRun : off).push(item);
    }
  }

  const requirements: PlanRequirement[] = [];
  for (const item of willRun) {
    for (const capability of item.capabilities) {
      const selector = `capability:${capability}`;
      const known = requirements.find((r) => r.selector === selector);
      if (known) known.coveredBy.push(item.id);
      else requirements.push({ selector, kind: "capability", category: categoryOf.get(capability) ?? null, requiredBy: null, coveredBy: [item.id] });
    }
  }
  const networkItems = willRun.filter((i) => i.network).map((i) => i.id);
  const body: PlanBody = {
    schemaVersion: 1,
    kind: "jgates-plan",
    workspace: { path: dir, id: fs.existsSync(dir) ? workspaceId(dir) : "ws_unknown" },
    versions: {
      jgates: options.version,
      detector: inventory.detectorVersion,
      adapters: { [ADAPTER_ID]: qualityBridgeManifest.adapterVersion },
      tools: { [qualityBridgeManifest.toolName]: toolVersion },
    },
    profile: null,
    scope: { requested: "full", effective: "full", paths: [], base: null, head: null, note: null },
    selection: {
      request: { profile: null, scope: "full", paths: [], base: null, head: null, skip: [], only: [], templates: [] },
      overrides: [],
      reduced: off.some((i) => i.state.runOnly),
    },
    components: inventory.classifications.map((c) => ({ id: c.id, root: c.componentRoot, language: c.language, framework: c.framework, status: c.classificationStatus, approvable: c.approvable, templates: [] })),
    templates: { active: [], inactive: [] },
    incompatibilities: [],
    invocations: [{ id: ADAPTER_ID, adapter: ADAPTER_ID, command, subchecks: [...plans.values()].filter((p) => p.required).map((p) => p.subcheckId).sort(), runsAnyway: [] }],
    groups: { willRun, notApplicableOrDisabled: off, uncoveredRequirements: [] },
    requirements,
    network: { policy: "explicit", required: networkItems.length > 0, items: networkItems },
    inputs: {
      configFiles: [],
      inventoryHash: contentHash({
        detectorVersion: inventory.detectorVersion,
        mode: inventory.mode,
        templatesActive: inventory.templatesActive,
        configFile: inventory.configFile,
        classifications: inventory.classifications,
        languages: inventory.languages,
        inconsistencies: inventory.inconsistencies,
      }),
      configHash: contentHash({ source: "options", selection: legacy }),
    },
    approvable: true,
    blocked: null,
    blockers: [],
    warnings: [{ code: LEGACY_PLAN_WARNING, message: t("run_plan_from_options", { mode: legacy.mode }) }],
  };
  const clean = JSON.parse(JSON.stringify(body)) as PlanBody;
  return { ...clean, planHash: computePlanHash(clean), createdAt: (options.now ?? new Date()).toISOString(), changes: null };
}

/** True for a plan assembled from the option flags (planSource options): it has no jgates.yml to be rebuilt from. */
export function isLegacyPlan(doc: Plan): boolean {
  return (doc.warnings ?? []).some((w) => w.code === LEGACY_PLAN_WARNING);
}

/**
 * Confronts a received plan that came from the option flags with the workspace (run --plan). Such a plan cannot be
 * rebuilt from the configuration, so it is rebuilt from the selection recorded in its own bridge request; it is
 * accepted only when the result is the same plan. Returns null when the document is not a valid legacy plan, so the
 * regular validation reports it.
 */
export function validateLegacyPlan(doc: unknown, projectDir: string, options: { version: string; env?: NodeJS.ProcessEnv }): PlanCheck | null {
  if (validatePlanDocument(doc).length > 0) return null;
  const plan = doc as Plan;
  if (!isLegacyPlan(plan)) return null;
  const t = translator("plan");
  const fail = (code: PlanCheckCode, key: string, problems: string[], extra: Partial<PlanCheck> = {}): PlanCheck => ({
    ok: false,
    code,
    message: t(key, { count: problems.length, detail: problems.slice(0, 3).join("; ") }),
    fix: t(`${key}_fix`),
    problems,
    changes: null,
    ...extra,
  });
  if (computePlanHash(plan) !== plan.planHash) return fail("PLAN_TAMPERED", "plan_check_hash", ["planHash does not match the content"]);
  const dir = path.resolve(projectDir);
  let samePlace = false;
  try {
    samePlace = canonicalPath(dir) === canonicalPath(plan.workspace.path);
  } catch {
    samePlace = false;
  }
  if (!samePlace) return fail("PLAN_WORKSPACE_MISMATCH", "plan_check_workspace", [`${plan.workspace.path} != ${dir}`]);
  const stdin = plan.invocations[0]?.command.stdin;
  if (!stdin || typeof stdin !== "object") return fail("PLAN_TAMPERED", "plan_check_tampered", ["the plan has no bridge request"]);
  const selection = legacySelection(stdin as BridgeRequest);
  const current = rebuildInPlanLocale(
    plan.planHash,
    () => legacyPlan(dir, selection, { version: options.version, ...(options.env ? { env: options.env } : {}), now: new Date(plan.createdAt) }),
    (built) => built.planHash,
  );
  if (current.planHash === plan.planHash) return { ok: true, code: null, message: null, fix: null, problems: [], changes: null, current };
  const changes = diffPlans(plan, current);
  const detail = [
    ...changes.versions.map((v) => `version ${v.field}: ${String(v.from)} -> ${String(v.to)}`),
    ...changes.items.changed.map((c) => `${c.id}: ${c.fields.map((f) => f.field).join(", ")}`),
    ...changes.items.added.map((id) => `item added: ${id}`),
    ...changes.items.removed.map((id) => `item removed: ${id}`),
  ];
  const inputsChanged = canonicalJson(plan.inputs) !== canonicalJson(current.inputs) || canonicalJson(plan.versions) !== canonicalJson(current.versions);
  if (inputsChanged) return fail("PLAN_STALE", "plan_check_stale", detail, { changes, current });
  return fail("PLAN_TAMPERED", "plan_check_tampered", detail.length > 0 ? detail : ["content differs from the plan the options give"], { changes, current });
}

/**
 * The one step of a legacy plan: the bridge with the request of the plan, judged by the requirement table of the
 * options it records. No preflight: a missing Python or sidecar is the bridge's own answer, as in the option-driven run.
 */
export function legacySteps(context: AdapterContext, plan: Plan): RunStep[] {
  const request = (): BridgeRequest => {
    const r = requestFromPlan(plan, context);
    if (!r) throw new Error("the plan has no bridge invocation");
    return r;
  };
  const plans = (): SubcheckPlan[] => planSubchecks(legacySelection(request()), subcheckIds());
  return [
    {
      id: ADAPTER_ID,
      label: qualityBridgeManifest.displayName,
      skeleton: (): AdapterOutput => {
        const out = normalizeBridge({ kind: "failure", code: "spawn-failed", message: "not run", interpreter: null, exitCode: null, stdout: "", stderr: "", durationMs: 0 }, plans());
        return { ...out, logs: [], outputs: [] };
      },
      run: () => executeBridge(context, request(), plans()),
    },
  ];
}
