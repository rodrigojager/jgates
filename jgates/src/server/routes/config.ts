// Configuração > Perfil: the selected profile's checks by category (capabilities, tools, rules) with the origin of every
// value, "why is this on?" (the same chain `jgates config resolve --explain` prints), granular on/off written into the
// profile by patch, and the policy controls (severity, minimum coverage, missing verification).
import { builtinManifests } from "../../adapters/manifests.js";
import { createCoreCatalog } from "../../core/catalog/index.js";
import { encodePointer, resolveConfig, type ResolvedField, type ResolveResult } from "../../core/config/resolve/index.js";
import { listProfiles, setPolicyRules, setProfileChecks, type PolicyChange } from "../../core/profiles/index.js";
import { resolveSelection, type SelectionItem, type SelectionResult } from "../../core/selection/index.js";
import { translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { guard } from "./profiles.js";
import { modeOf } from "./workspaces.js";

const t = translator("config-profiles");

const refPattern = "^(builtin:)?[a-z0-9][a-z0-9._-]{0,127}$";
const hashPattern = "^[0-9a-f]{64}$";
const selectorPattern = "^(category|capability|tool|rule|pii|architecture|component):[A-Za-z0-9._/-]+$";

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

function resolveProfile(server: ServerContext, ref: string): Resolved {
  const result = resolveConfig(server.projectDir, { profile: ref });
  if (!result.ok) {
    const first = result.errors[0];
    throw new HttpError(422, first?.code ?? "CONFIG_INVALID", first?.message ?? t("cfgp_resolve_failed", { first: "" }), first?.fix ?? null, { errors: result.errors, diagnostics: result.diagnostics });
  }
  return { ref, result, selection: resolveSelection(result) };
}

function projectProfileIds(server: ServerContext): { ids: string[]; def: string; file: string } {
  const list = listProfiles(server.projectDir);
  const file = list.profiles.find((p) => p.origin === "project")?.file ?? ".jgates/profiles.yml";
  return { ids: list.profiles.filter((p) => p.origin === "project").map((p) => p.id), def: list.default, file };
}

const origin = (f: ResolvedField | undefined) => (f ? { layer: f.layer, source: f.source, file: f.file, path: f.path } : null);

function toolLabels(): Map<string, string> {
  const labels = new Map<string, string>();
  for (const manifest of builtinManifests()) {
    labels.set(manifest.id, manifest.displayName);
    for (const sub of manifest.subchecks ?? []) labels.set(`${manifest.id}.${sub.id}`, sub.label);
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
    saveTo,
  };
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

  const categories = catalog.categories.map((category) => {
    const capabilities = catalog.capabilities
      .filter((c) => c.category === category.id)
      .map((capability) => {
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
              label: labels.get(tool.id) ?? tool.id,
              selector: `tool:${tool.id}`,
              enabled: pair?.enabled ?? false,
              reason: pair?.reason ?? "NOT_SELECTED",
              decision: pair?.decision ?? null,
              locked: pair?.locked ?? [],
              saveTo: saveFor(`tool:${tool.id}`),
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
  const coverageScopes = [
    { scope: null as string | null, key: POLICY_KEYS.coverage.key },
    ...selection.universe.components.map((c) => ({ scope: c as string | null, key: `${POLICY_KEYS.coverage.key}.${c}` })),
  ].map(({ scope, key }) => {
    const f = field(key, "threshold");
    return { scope, key, value: typeof f?.value === "number" ? f.value : null, origin: origin(f), saveTo: { file: ".jgates/policy.yml", path: `rules.${key}.threshold` } };
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
    policy,
    selectionErrors: selection.errors.map((e) => ({ code: e.code, selector: e.selector, message: e.message, fix: e.fix ?? null })),
    warnings: result.warnings,
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
      return guard(() => ({ status: 200, json: buildView(server, target(server, query.profile)) }));
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
            properties: { selector: { type: "string", pattern: selectorPattern }, enabled: { type: "boolean" } },
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
      const input = body as { profile: string; changes: Array<{ selector: string; enabled: boolean }>; expectedHash?: string };
      return guard(() => {
        const result = setProfileChecks(server.projectDir, input.profile, input.changes, input.expectedHash ? { expectedHash: input.expectedHash } : {});
        server.log(`selection ${input.profile} ${input.changes.length} change(s)`);
        return { status: 200, json: { schemaVersion: 1, status: "OK", ...result } };
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
    handler({ body, server }) {
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
        return { status: 200, json: { schemaVersion: 1, status: "OK", ...result } };
      });
    },
  },
];
