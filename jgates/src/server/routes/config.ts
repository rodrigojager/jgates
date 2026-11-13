// Configuração > Perfil: the selected profile's checks by category (capabilities, tools, rules) with the origin of every
// value, "why is this on?" (the same chain `jgates config resolve --explain` prints), granular on/off written into the
// profile by patch, and the policy controls (severity, minimum coverage, missing verification).
//
// The view (GET /api/config/profile) is read from the configuration and the discovery only, through the project cache
// (core/cache/project.ts): it builds no plan and asks the engine nothing, so it answers at once and every write can
// answer with it. What the plan says about each capability here ("vai rodar", "não se aplica") and the mascots come
// from GET /api/config/profile/plan, which the screen asks next and which may wait on the engine.
import { buildPlan, type Plan, type PlanItem } from "../../core/plan/index.js";
import { findNativeMinimum } from "../../adapters/pytest/coverage.js";
import { projectMascots } from "../../core/mascots/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import { cachedProject, invalidateProjectCache, fileDiagnostics, onlyFileProblems, projectInventory, projectResolveReadable } from "../../core/cache/project.js";
import { createCoreCatalog, subcheckLabel } from "../../core/catalog/index.js";
import { encodePointer, type ResolvedField, type ResolveResult } from "../../core/config/resolve/index.js";
import { withEngineFacts } from "../../core/engine/facts.js";
import { listProfiles, setPolicyRules, setProfileChecks, type PolicyChange } from "../../core/profiles/index.js";
import { resolveSelection, type SelectionItem, type SelectionResult } from "../../core/selection/index.js";
import { getLocale, translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { guard } from "./profiles.js";
import { modeOf } from "./workspaces.js";

const t = translator("config-profiles");

const refPattern = "^(builtin:)?[a-z0-9][a-z0-9._-]{0,127}$";
const hashPattern = "^[0-9a-f]{64}$";
const selectorPattern = "^(category|capability|tool|rule|pii|architecture|component):[A-Za-z0-9._/:-]+$";

/** The four levels of the "Quando bloquear a entrega?" control mapped to the severities the policy schema knows. */
export const SEVERITY_LEVELS = { critical: "blocking", high: "error", medium: "warning", low: "info" } as const;
type Level = keyof typeof SEVERITY_LEVELS;
const LEVEL_OF: Record<string, Level> = { blocking: "critical", error: "high", warning: "medium", info: "low" };

/** Policy rule keys the controls write (rules.<key>.<field> in policy.yml). */
export const POLICY_KEYS = {
  severity: { key: "security.block-from", field: "severity" },
  onMissing: { key: "missing-check.block", field: "enabled" },
  coverage: { key: "coverage.minimum", field: "threshold" },
} as const;

interface Resolved {
  ref: string;
  result: ResolveResult;
  selection: SelectionResult;
}

/**
 * The configuration of profile `ref` as the files hold it. A file the schema refuses (a key written by hand that does
 * not exist) does not take the screen away: the view is built from what the files hold and carries the diagnostics
 * (file, key, line). Any other problem (a profile that does not exist, a cycle) is refused.
 */
function resolveProfile(server: ServerContext, ref: string): Resolved {
  const result = projectResolveReadable(server.projectDir, { profile: ref });
  if (!result.ok && !onlyFileProblems(result)) {
    const first = result.errors[0];
    throw new HttpError(422, first?.code ?? "CONFIG_INVALID", first?.message ?? t("cfgp_resolve_failed", { first: "" }), first?.fix ?? null, { errors: result.errors, diagnostics: result.diagnostics });
  }
  // Computed from the cached configuration inside the cached computation, so it depends on everything that one read.
  const selection = cachedProject(`selection:${ref}|${getLocale()}`, [server.projectDir], () =>
    resolveSelection(projectResolveReadable(server.projectDir, { profile: ref }), { inventory: projectInventory(server.projectDir) }),
  );
  return { ref, result, selection };
}


function projectProfileIds(server: ServerContext): { ids: string[]; def: string; file: string } {
  return cachedProject("profile-ids", [server.projectDir], () => {
    const list = listProfiles(server.projectDir);
    const file = list.profiles.find((p) => p.origin === "project")?.file ?? ".jgates/profiles.yml";
    return { ids: list.profiles.filter((p) => p.origin === "project").map((p) => p.id), def: list.default, file };
  });
}

const origin = (f: ResolvedField | undefined) => (f ? { layer: f.layer, source: f.source, file: f.file, path: f.path } : null);

function toolLabels(): Map<string, string> {
  const labels = new Map<string, string>();
  for (const manifest of builtinManifests()) {
    labels.set(manifest.id, manifest.displayName);
    for (const sub of manifest.subchecks ?? []) labels.set(`${manifest.id}.${sub.id}`, subcheckLabel(manifest.id, sub));
  }
  return labels;
}

function itemView(item: SelectionItem | undefined, saveTo: { file: string; path: string } | null) {
  if (!item) return null;
  return {
    selector: item.selector,
    enabled: item.enabled,
    reason: item.reason,
    decision: item.decision,
    locked: item.locked ?? [],
    tie: item.tie === true,
    /** "available": on only where a tool for it exists here; null: on means required (or it is off). */
    when: item.when ?? null,
    saveTo,
  };
}

/**
 * What the plan of the profile says about each capability in this project, for the screen to show "vai rodar",
 * "não se aplica aqui" (with the reason and the action) or "sem verificação": the items that run (trimmed), the
 * when-available requirements without a check and the required ones without a check.
 */
export function planAvailability(plan: Plan | null) {
  if (!plan) return null;
  const brief = (i: PlanItem) => ({ id: i.id, tool: i.tool, adapter: i.adapter, label: i.label, capabilities: i.capabilities, requirement: i.requirement, availability: i.availability, state: { enabled: i.state.enabled, when: i.state.when ?? null } });
  return {
    profile: plan.profile,
    counts: { unit: "steps", steps: plan.groups.willRun.length },
    groups: {
      willRun: plan.groups.willRun.map(brief),
      notApplicableOrDisabled: plan.groups.notApplicableOrDisabled.map(brief),
      uncoveredRequirements: plan.groups.uncoveredRequirements,
      notApplicableRequirements: plan.groups.notApplicableRequirements ?? [],
    },
  };
}

/**
 * The view of the Perfil screen for profile `ref`, from the cache while the configuration and the files discovery read
 * stay the same. Builds no plan and reads nothing from the engine.
 */
export function profileView(server: ServerContext, ref: string): ReturnType<typeof buildView> {
  const mode = modeOf();
  return cachedProject(`config-view:${JSON.stringify([ref, getLocale(), mode.mode, mode.governed])}`, [server.projectDir], () => buildView(server, ref));
}

/** The view after a write: the cache is cleared first (the write may fall in the same clock tick as the last read). */
export function profileViewAfterWrite(server: ServerContext, ref: string): ViewAnswer {
  invalidateProjectCache();
  return profileViewAnswer(server, ref);
}

export type ViewAnswer = { view: ReturnType<typeof buildView> | null; viewError: { code: string; message: string } | null };

/** The view of `ref` for the answer of a write: a configuration the write left unresolvable gives viewError. */
export function profileViewAnswer(server: ServerContext, ref: string): ViewAnswer {
  try {
    return { view: guard(() => profileView(server, ref)), viewError: null };
  } catch (error) {
    // The write went through; a configuration it left unresolvable is what the screen shows next, not a failed write.
    if (error instanceof HttpError) return { view: null, viewError: { code: error.code, message: error.message } };
    throw error;
  }
}

function buildView(server: ServerContext, ref: string) {
  const { ids, def, file } = projectProfileIds(server);
  const { result, selection } = resolveProfile(server, ref);
  const editable = ids.includes(ref);
  const saveFor = (selector: string) => (editable ? { file, path: `profiles.${ref}.checks.${selector}.enabled` } : null);
  const catalog = createCoreCatalog().toDocument();
  const labels = toolLabels();
  const byKey = new Map(selection.items.map((i) => [i.selector, i]));
  const parents = new Set(selection.universe.parents);

  const toolsConfig = (result.config.tools ?? {}) as Record<string, { adapter?: unknown } | undefined>;
  const labelOfTool = (id: string): string => {
    const adapter = toolsConfig[id]?.adapter;
    // An own tool (generic-command) has no catalogue name: its instance id is the name.
    if (typeof adapter === "string" && adapter !== "generic-command") return labels.get(adapter) ?? labels.get(id) ?? id;
    return labels.get(id) ?? id;
  };
  // The capabilities of the catalogue, then the own ones (x-custom:<name>) the universe added to their category.
  const known = new Map(catalog.capabilities.map((c) => [c.id, c] as const));
  const capabilitiesOf = (category: string) =>
    selection.universe.capabilities
      .filter((c) => c.category === category)
      .map((c) => known.get(c.id) ?? { id: c.id, category, label: c.id.replace(/^x-custom:/, ""), description: t("cfgp_custom_capability_description", { id: c.id.replace(/^x-custom:/, "") }) });

  const categories = catalog.categories.map((category) => {
    const capabilities = capabilitiesOf(category.id).map((capability) => {
        const capSelector = `capability:${capability.id}`;
        const capItem = byKey.get(capSelector);
        const tools = selection.universe.tools
          .filter((tool) => !parents.has(tool.id) && tool.capabilities.includes(capability.id))
          .map((tool) => {
            const toolItem = byKey.get(`tool:${tool.id}`);
            const pair = toolItem?.capabilities?.find((p) => p.capability === capability.id);
            const rules = selection.universe.rules
              .filter((r) => r.tool === tool.id)
              .map((r) => {
                const sel = `rule:${r.tool}/${r.id}`;
                return { id: r.id, label: r.id, ...itemView(byKey.get(sel), saveFor(sel)) };
              });
            return {
              id: tool.id,
              label: labelOfTool(tool.id),
              selector: `tool:${tool.id}`,
              enabled: pair?.enabled ?? false,
              reason: pair?.reason ?? "NOT_SELECTED",
              decision: pair?.decision ?? null,
              locked: pair?.locked ?? [],
              saveTo: saveFor(`tool:${tool.id}`),
              // "available" written for the tool itself (on only where it can run): the row offers the three states.
              when: pair?.when ?? null,
              alsoCapabilities: tool.capabilities.filter((c) => c !== capability.id),
              rules,
            };
          });
        return {
          id: capability.id,
          label: capability.label,
          description: capability.description,
          ...itemView(capItem, saveFor(capSelector)),
          selector: capSelector,
          activeTools: capItem?.activeTools ?? [],
          tools,
        };
      });
    const item = byKey.get(`category:${category.id}`);
    return {
      id: category.id,
      label: category.label,
      description: category.description,
      ...itemView(item, saveFor(`category:${category.id}`)),
      selector: `category:${category.id}`,
      capabilities,
    };
  });

  const mode = modeOf();
  const field = (key: string, name: string) => result.fields[encodePointer(["policy", "rules", key, name])];
  const severityField = field(POLICY_KEYS.severity.key, "severity");
  const missingField = field(POLICY_KEYS.onMissing.key, "enabled");
  // The roots of the components, as the plan gives them: from the discovery.
  const roots = new Map<string, string | null>(projectInventory(server.projectDir).classifications.map((c) => [c.id, c.componentRoot]));
  const coverageScopes = [
    { scope: null as string | null, key: POLICY_KEYS.coverage.key },
    ...selection.universe.components.map((c) => ({ scope: c as string | null, key: `${POLICY_KEYS.coverage.key}.${c}` })),
  ].map(({ scope, key }) => {
    const f = field(key, "threshold");
    // Without a minimum of its own, the component's coverage configuration (`fail_under`) is the one that applies.
    const native = findNativeMinimum(server.projectDir, scope === null ? null : (roots.get(scope) ?? null));
    return {
      scope,
      key,
      value: typeof f?.value === "number" ? f.value : null,
      origin: origin(f),
      native: native.value !== null ? native : null,
      saveTo: { file: ".jgates/policy.yml", path: `rules.${key}.threshold` },
    };
  });

  const policy = {
    governed: mode.mode === "governed",
    severity: {
      value: LEVEL_OF[String(severityField?.value)] ?? "critical",
      explicit: severityField !== undefined,
      origin: origin(severityField),
      saveTo: { file: ".jgates/policy.yml", path: `rules.${POLICY_KEYS.severity.key}.severity` },
    },
    onMissing: {
      value: mode.mode === "governed" ? "block" : missingField?.value === false ? "warn" : "block",
      explicit: missingField !== undefined,
      origin: origin(missingField),
      saveTo: { file: ".jgates/policy.yml", path: `rules.${POLICY_KEYS.onMissing.key}.enabled` },
    },
    coverage: { denominator: "lines", scopes: coverageScopes },
  };

  return {
    schemaVersion: 1,
    status: "OK",
    mode: mode.mode,
    governed: mode.governed,
    profile: { ref, id: ref.replace(/^builtin:/, ""), editable, isDefault: def === ref, file },
    categories,
    // The selectors that are not in the category tree: the personal data entities, the architecture rules and the components.
    selectors: (["pii", "architecture", "component"] as const).map((kind) => ({
      kind,
      items: selection.items.filter((i) => i.kind === kind).map((i) => ({ id: i.id, label: i.id, ...itemView(i, saveFor(i.selector)) })),
    })),
    // What the own-tool dialog needs: the components of the project and the instances that already exist.
    universe: { components: [...selection.universe.components].sort(), tools: selection.universe.tools.filter((x) => !parents.has(x.id)).map((x) => x.id) },
    // The number the screen counts here is the capabilities that are on; the plan and the run count steps (`counts.steps`
    // of /api/config/profile/plan, `total` of /api/setup/profiles): both units are returned and named.
    counts: { unit: "capabilities", capabilities: categories.reduce((n, c) => n + c.capabilities.filter((x) => x.enabled).length, 0) },
    policy,
    selectionErrors: selection.errors.map((e) => ({ code: e.code, selector: e.selector, message: e.message, fix: e.fix ?? null })),
    warnings: result.warnings,
    // A file the schema refuses: the view shows what the files hold, and these say where the problem is.
    diagnostics: fileDiagnostics(result),
  };
}

function target(server: ServerContext, requested: string | undefined): string {
  return requested ?? projectProfileIds(server).def;
}

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/config/profile",
    query: { type: "object", properties: { profile: { type: "string", pattern: refPattern } }, additionalProperties: false },
    handler({ query, server }) {
      // From the configuration and the discovery only (cached): no plan, no engine.
      return { status: 200, json: guard(() => profileView(server, target(server, query.profile))) };
    },
  },
  {
    // What the plan of the profile says about each capability here, and the mascots: the part of the Perfil screen that
    // needs a plan. The plan reads the engine facts from their cache (core/engine/facts.ts), never with a blocking call.
    method: "GET",
    path: "/api/config/profile/plan",
    query: { type: "object", properties: { profile: { type: "string", pattern: refPattern } }, additionalProperties: false },
    timeoutMs: 120_000,
    async handler({ query, server }) {
      const ref = guard(() => target(server, query.profile));
      const inventory = projectInventory(server.projectDir);
      const built = await withEngineFacts(() => buildPlan(server.projectDir, { profile: ref, home: server.home, version: server.version, compare: false, inventory }), { prime: { version: server.version } });
      const plan = built.ok ? built.plan : null;
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          profile: ref,
          plan: planAvailability(plan),
          mascots: projectMascots({ plan, invalid: !built.ok }),
          error: built.ok ? null : { code: built.error.code, message: built.error.message, fix: built.error.fix ?? null },
        },
      };
    },
  },
  {
    // The chain of layers that decided one check, as `config resolve --explain` prints it (field.history, weakest first).
    method: "GET",
    path: "/api/config/explain",
    query: {
      type: "object",
      properties: { selector: { type: "string", pattern: selectorPattern }, profile: { type: "string", pattern: refPattern } },
      required: ["selector"],
      additionalProperties: false,
    },
    handler({ query, server }) {
      return guard(() => {
        const ref = target(server, query.profile);
        const { result, selection } = resolveProfile(server, ref);
        const selector = query.selector as string;
        const item = selection.items.find((i) => i.selector === selector);
        if (!item) throw new HttpError(404, "SELECTOR_UNKNOWN", t("cfgp_explain_unknown", { selector }), null);
        const pointer = item.decision?.pointer ? item.decision.pointer : null;
        const field = pointer ? (result.fields[pointer] ?? null) : null;
        const { ids, file } = projectProfileIds(server);
        return {
          status: 200,
          json: {
            schemaVersion: 1,
            status: "OK",
            profile: ref,
            selector,
            enabled: item.enabled,
            reason: item.reason,
            decision: item.decision,
            overridden: item.overridden,
            locked: item.locked ?? [],
            pointer,
            field,
            saveTo: ids.includes(ref) ? { file, path: `profiles.${ref}.checks.${selector}.enabled` } : null,
          },
        };
      });
    },
  },
  {
    // Turns checks on or off in a project profile; the other checks of the category stay as they are.
    method: "PUT",
    path: "/api/config/selection",
    body: {
      type: "object",
      properties: {
        profile: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" },
        changes: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            // when: "available" turns it on only where a tool exists; null makes it required again (see SelectionChange).
            properties: { selector: { type: "string", pattern: selectorPattern }, enabled: { type: "boolean" }, when: { enum: ["available", null] } },
            required: ["selector", "enabled"],
            additionalProperties: false,
          },
        },
        expectedHash: { type: "string", pattern: hashPattern },
      },
      required: ["profile", "changes"],
      additionalProperties: false,
    },
    handler({ body, server }) {
      const input = body as { profile: string; changes: Array<{ selector: string; enabled: boolean; when?: "available" | null }>; expectedHash?: string };
      return guard(() => {
        const result = setProfileChecks(server.projectDir, input.profile, input.changes, input.expectedHash ? { expectedHash: input.expectedHash } : {});
        server.log(`selection ${input.profile} ${input.changes.length} change(s)`);
        // The answer carries the updated view (the same as GET /api/config/profile): the screen does not ask again.
        return { status: 200, json: { schemaVersion: 1, status: "OK", ...result, ...profileViewAfterWrite(server, input.profile) } };
      });
    },
  },
  {
    // Policy controls. In governed mode the policy is fixed outside the checkout, so nothing here writes it.
    method: "PUT",
    path: "/api/config/policy",
    body: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              control: { enum: ["severity", "onMissing", "coverage"] },
              value: { anyOf: [{ type: "string", maxLength: 40 }, { type: "number" }] },
              scope: { type: "string", pattern: "^[A-Za-z0-9._/-]{1,200}$" },
            },
            required: ["control", "value"],
            additionalProperties: false,
          },
        },
        expectedHash: { type: "string", pattern: hashPattern },
      },
      required: ["changes"],
      additionalProperties: false,
    },
    // The profile whose view the answer carries (the default one when absent).
    query: { type: "object", properties: { profile: { type: "string", pattern: refPattern } }, additionalProperties: false },
    handler({ body, query, server }) {
      const input = body as { changes: Array<{ control: "severity" | "onMissing" | "coverage"; value: string | number; scope?: string }>; expectedHash?: string };
      if (modeOf().mode === "governed") throw new HttpError(403, "POLICY_GOVERNED", t("cfgp_policy_governed"), t("cfgp_policy_governed_fix"));
      const bad = (field: string) => new HttpError(400, "POLICY_VALUE_INVALID", t("cfgp_policy_value_invalid", { field }), t("cfgp_policy_value_invalid_fix"));
      const changes: PolicyChange[] = input.changes.map((c) => {
        if (c.control === "severity") {
          if (typeof c.value !== "string" || !Object.hasOwn(SEVERITY_LEVELS, c.value)) throw bad("severity");
          return { key: POLICY_KEYS.severity.key, field: "severity", value: SEVERITY_LEVELS[c.value as Level] };
        }
        if (c.control === "onMissing") {
          if (c.value !== "block" && c.value !== "warn") throw bad("onMissing");
          return { key: POLICY_KEYS.onMissing.key, field: "enabled", value: c.value === "block" };
        }
        if (typeof c.value !== "number" || !Number.isInteger(c.value) || c.value < 0 || c.value > 100) throw bad("coverage");
        return { key: c.scope ? `${POLICY_KEYS.coverage.key}.${c.scope}` : POLICY_KEYS.coverage.key, field: "threshold", value: c.value };
      });
      return guard(() => {
        const result = setPolicyRules(server.projectDir, changes, input.expectedHash ? { expectedHash: input.expectedHash } : {});
        server.log(`policy ${changes.length} change(s)`);
        return { status: 200, json: { schemaVersion: 1, status: "OK", ...result, ...profileViewAfterWrite(server, target(server, query.profile)) } };
      });
    },
  },
];
