// What the review shows besides the plan (PLAN-guided-flows.md section 4): every check that will not run as one item
// with the check and tool name, its category, the reason (code and sentence from the plan and the reasons catalogue),
// a suggestion when there is one and typed actions; grouped by the kind of reason (needs a preparation, needs
// configuration, does not apply to this project, turned off). A check that cannot apply to the project carries no
// action. The preparations the run still needs (the tools image, the advisory data, the dependencies) are listed apart,
// one per pending item, each with the network it uses.
//
// Pure: it reads a plan and, for the preparations, the environment state the server already holds. No engine call.
import { databaseOfItem, DATABASES, type DatabaseId } from "../data/index.js";
import { translator, type Translator } from "../../i18n/index.js";
import type { NotApplicableAction, NotApplicableRequirement, Plan, PlanItem, UncoveredRequirement } from "./types.js";

/** The kinds of reason a check that will not run is grouped by, in the order the review lists them. */
export const NOT_RUNNING_KINDS = ["preparation", "configuration", "not-applicable", "turned-off"] as const;
export type NotRunningKind = (typeof NOT_RUNNING_KINDS)[number];

/** What a button of an item does; the UI maps each type to its control. */
export const REVIEW_ACTION_TYPES = ["prepare-tools", "prepare-tool", "prepare-data", "prepare-codeql", "prepare-dependencies", "start-services", "configure", "add-tool", "enable", "include-in-run", "learn-more"] as const;
export type ReviewActionType = (typeof REVIEW_ACTION_TYPES)[number];

export interface ReviewAction {
  type: ReviewActionType;
  /** The control's text, in the language of the plan. */
  label: string;
  /** The UI route that does it (hash path without "#"), when it is a screen. */
  route?: string;
  /** configure: the setting to focus in the options form (the first one the check needs). */
  field?: string | null;
  /** configure: every setting the check still needs. */
  fields?: string[];
  /** The tool instances (prepare-tool, configure, enable) the action is about. */
  tools?: string[];
  adapter?: string | null;
  /** configure: a built-in template that declares the instance and is not in jgates.yml yet. */
  template?: string | null;
  /** configure: evidence files one of which must exist. */
  files?: string[];
  /** enable, include-in-run: the selectors it turns on. */
  selectors?: string[];
  /** learn-more: the official page. */
  url?: string;
}

export interface ReviewTool {
  id: string;
  /** The adapter's name as its manifest gives it (English); the UI shows its own translation when it has one. */
  name: string;
}

export interface NotRunningItem {
  id: string;
  /** The selector of what is checked (capability:mutation) or the check id of a tool instance. */
  selector: string;
  /** What is checked, by name ("Mutação"), never the tool's. */
  check: string;
  /** The tool or tools that would do it, by name (empty when JGates has none for this stack). */
  tools: ReviewTool[];
  category: string | null;
  kind: NotRunningKind;
  reasonCode: string;
  /** The reason in one sentence. */
  reason: string;
  suggestion: string | null;
  actions: ReviewAction[];
}

export interface PendingPreparation {
  id: "tools" | "data" | "dependencies";
  label: string;
  /** What it does and for which checks, in one sentence. */
  detail: string;
  /** The network the step uses: none, or the bridge (downloads and package registries). */
  network: "none" | "bridge";
  /** The checks that wait for it. */
  affects: string[];
  action: ReviewAction;
}

export interface ReviewItems {
  notRunning: {
    total: number;
    groups: Array<{ kind: NotRunningKind; count: number; items: NotRunningItem[] }>;
  };
  preparations: PendingPreparation[];
}

/** The part of the environment state the preparations are read from (GET /api/environment/state). */
export interface EnvironmentFacts {
  mode?: string;
  sections?: {
    image?: { state?: string };
    data?: { databases?: Array<{ id: string; state: string }> };
    dependencies?: { units?: Array<{ components: string[]; state: string }> };
  };
}

const httpUrl = (value: string): boolean => /^https?:\/\//.test(value);
const unique = <T>(values: T[]): T[] => [...new Set(values)];

function toolsOf(plan: Plan, ids: string[], adapters: Array<{ id: string; label: string }>): ReviewTool[] {
  const byTool = new Map<string, PlanItem>();
  for (const item of [...plan.groups.willRun, ...plan.groups.notApplicableOrDisabled]) if (!byTool.has(item.tool)) byTool.set(item.tool, item);
  const out: ReviewTool[] = [];
  for (const id of ids) {
    const item = byTool.get(id);
    const adapter = adapters.find((a) => a.id === (item?.adapter ?? id));
    out.push({ id, name: adapter?.label ?? item?.label ?? id });
  }
  return out;
}

function learnMore(urls: string[], t: Translator): ReviewAction[] {
  const url = urls.find(httpUrl);
  return url ? [{ type: "learn-more", label: t("plan_review_action_learn_more"), url }] : [];
}

/** The item of a capability the plan reports as "not applicable here" (never a blocker). */
function fromNotApplicable(plan: Plan, na: NotApplicableRequirement, t: Translator): NotRunningItem {
  const action: NotApplicableAction = na.action;
  const applicable = na.adapters.filter((a) => a.applicable);
  const nameOfAdapters = (applicable.length > 0 ? applicable : na.adapters).map((a) => ({ id: a.id, label: a.label }));
  const candidateTools = unique(na.candidates.map((id) => id.split("#")[0] ?? id));
  const toolIds = action.tools.length > 0 ? action.tools : candidateTools.length > 0 ? candidateTools : nameOfAdapters.map((a) => a.id);
  const tools = toolsOf(plan, toolIds, nameOfAdapters);
  const docs = action.docs.length > 0 ? action.docs : na.adapters.flatMap((a) => a.docs);
  const base = { id: na.selector, selector: na.selector, check: na.label, tools, category: na.category, reasonCode: na.reasonCode, reason: na.message };
  const names = tools.map((x) => x.name).join(", ");
  const settings = action.settings ?? [];

  switch (na.reasonCode) {
    case "TOOL_MISSING":
      return {
        ...base,
        kind: "preparation",
        suggestion: t(action.kind === "prepare-image" ? "plan_review_suggest_prepare_image" : "plan_review_suggest_prepare_tool", { tools: names }),
        actions: [{ type: action.kind === "prepare-image" ? "prepare-tools" : "prepare-tool", label: t(action.kind === "prepare-image" ? "plan_review_action_prepare_tools" : "plan_review_action_prepare_tool", { tools: names }), tools: action.tools, adapter: action.adapter }, ...learnMore(docs, t)],
      };
    case "CUSTOMER_SUPPLIED":
      return {
        ...base,
        kind: "preparation",
        suggestion: t("plan_review_suggest_codeql"),
        actions: [{ type: "prepare-codeql", label: action.label || t("plan_review_action_prepare_codeql"), route: "environment", tools: action.tools, adapter: action.adapter }, ...learnMore(docs, t)],
      };
    case "SERVICES_REQUIRED":
      return {
        ...base,
        kind: "configuration",
        suggestion: t("plan_review_suggest_services"),
        actions: [{ type: "start-services", label: action.label || t("plan_review_action_start_services"), route: action.route ?? "config/services", tools: action.tools, adapter: action.adapter }, ...learnMore(docs, t)],
      };
    case "SETUP_REQUIRED": {
      const configure: ReviewAction = {
        type: "configure",
        label: t(action.tools.length > 0 ? "plan_review_action_configure" : "plan_review_action_declare", { tools: names }),
        route: action.tools.length > 0 ? `tools/${encodeURIComponent(action.tools[0] as string)}` : "tools",
        field: settings[0] ?? null,
        fields: settings,
        tools: action.tools,
        adapter: action.adapter,
        template: action.template !== null && action.templateState !== "active" ? action.template : null,
        files: action.files,
      };
      const suggestion = action.kind === "add-files" ? t("plan_review_suggest_add_files", { files: action.files.slice(0, 4).join(", ") }) : settings.length > 0 ? t("plan_review_suggest_settings", { settings: settings.join(", ") }) : action.kind === "add-template" ? t("plan_review_suggest_add_template", { template: action.template ?? "" }) : t("plan_review_suggest_declare", { tools: names });
      return { ...base, kind: "configuration", suggestion, actions: [configure, ...learnMore(docs, t)] };
    }
    case "EVIDENCE_MISSING":
      return {
        ...base,
        kind: "configuration",
        suggestion: t("plan_review_suggest_evidence"),
        actions: [{ type: "configure", label: t("plan_review_action_configure", { tools: names }), route: action.tools.length > 0 ? `tools/${encodeURIComponent(action.tools[0] as string)}` : "tools", field: null, fields: [], tools: action.tools, adapter: action.adapter }],
      };
    case "CHECKS_DISABLED":
      return {
        ...base,
        kind: "turned-off",
        suggestion: t("plan_review_suggest_enable", { tools: names }),
        actions: [{ type: "enable", label: t("plan_review_action_enable"), tools: action.tools, selectors: action.tools.length > 0 ? action.tools.map((x) => `tool:${x}`) : [na.selector] }],
      };
    case "DISABLED_FOR_RUN":
      return {
        ...base,
        kind: "turned-off",
        suggestion: t("plan_review_suggest_include_run"),
        actions: [{ type: "include-in-run", label: t("plan_review_action_include_run"), tools: action.tools, selectors: [na.selector, ...action.tools.map((x) => `tool:${x}`)] }],
      };
    case "NO_TOOL":
      // JGates has no tool for it at all: the person's own tool can cover it.
      return { ...base, kind: "configuration", suggestion: t("plan_review_suggest_add_tool"), actions: [{ type: "add-tool", label: t("plan_review_action_add_tool"), route: action.route ?? "tools" }] };
    default:
      // NO_TOOL_FOR_LANGUAGES: tools exist, none for the languages of this project; nothing to do here, so no action.
      return { ...base, kind: "not-applicable", suggestion: null, actions: [] };
  }
}

/** A required capability with no check (the plan blocks on it): the reason it has none and what turns it on. */
function fromUncovered(plan: Plan, u: UncoveredRequirement, labels: Map<string, string>, t: Translator): NotRunningItem {
  const capability = u.selector.startsWith("capability:") ? u.selector.slice("capability:".length) : u.selector;
  const tools = toolsOf(plan, unique(u.candidates.map((id) => id.split("#")[0] ?? id)), []);
  const base = { id: u.selector, selector: u.selector, check: labels.get(capability) ?? u.selector, tools, category: u.category, reasonCode: u.reason, reason: u.message };
  switch (u.reason) {
    case "DISABLED_FOR_RUN":
      return { ...base, kind: "turned-off", suggestion: t("plan_review_suggest_include_run"), actions: [{ type: "include-in-run", label: t("plan_review_action_include_run"), selectors: [u.selector, ...u.candidates.map((id) => `tool:${id.split("#")[0]}`)] }] };
    case "CHECKS_DISABLED":
      return { ...base, kind: "turned-off", suggestion: t("plan_review_suggest_enable", { tools: tools.map((x) => x.name).join(", ") }), actions: [{ type: "enable", label: t("plan_review_action_enable"), selectors: u.candidates.length > 0 ? unique(u.candidates.map((id) => `tool:${id.split("#")[0]}`)) : [u.selector] }] };
    case "EVIDENCE_MISSING":
      return { ...base, kind: "configuration", suggestion: t("plan_review_suggest_evidence"), actions: [{ type: "configure", label: t("plan_review_action_configure", { tools: tools.map((x) => x.name).join(", ") }), route: "tools", field: null, fields: [] }] };
    default:
      return { ...base, kind: "configuration", suggestion: t("plan_review_suggest_add_tool"), actions: [{ type: "add-tool", label: t("plan_review_action_add_tool"), route: "tools" }] };
  }
}

/** A check the profile or the project turned off by hand (DISABLED, ONLY_EXCLUDED), apart from what the requirements cover. */
function fromDisabledItem(item: PlanItem, labels: Map<string, string>, t: Translator): NotRunningItem {
  const forRun = item.state.runOnly || item.reason.code === "ONLY_EXCLUDED";
  const selectors = [`tool:${item.tool}`];
  return {
    id: item.id,
    selector: item.id,
    // Named by what is checked (two checks of one tool are two items, never two rows of the same name).
    check: labels.get(item.capabilities[0] ?? "") ?? item.label,
    tools: [{ id: item.tool, name: item.label }],
    category: item.category,
    kind: "turned-off",
    reasonCode: item.reason.code,
    reason: item.reason.message,
    suggestion: t(forRun ? "plan_review_suggest_include_run" : "plan_review_suggest_enable", { tools: item.label }),
    actions: [forRun ? { type: "include-in-run", label: t("plan_review_action_include_run"), selectors } : { type: "enable", label: t("plan_review_action_enable"), tools: [item.tool], selectors }],
  };
}

function preparationsOf(plan: Plan, facts: EnvironmentFacts | null, labels: Map<string, string>, t: Translator): PendingPreparation[] {
  // Only container-first plans have preparations; a plan without the container inputs runs somewhere else.
  const container = plan.inputs.container;
  if (!container || !facts) return [];
  const out: PendingPreparation[] = [];
  const inImage = facts.mode === "in-image";
  const willRun = plan.groups.willRun;
  const checkNames = (items: PlanItem[]): string[] => unique(items.map((i) => labels.get(i.capabilities[0] ?? "") ?? i.label));

  const imageState = facts.sections?.image?.state;
  if (!inImage && imageState !== undefined && imageState !== "ready") {
    out.push({
      id: "tools",
      label: t("plan_review_prep_tools"),
      detail: t("plan_review_prep_tools_detail", { count: willRun.length }),
      network: "bridge",
      affects: checkNames(willRun),
      action: { type: "prepare-tools", label: t("plan_review_action_prepare_tools") },
    });
  }

  if (!inImage) {
    const ages = new Map((facts.sections?.data?.databases ?? []).map((d) => [d.id, d.state]));
    const needing = new Map<DatabaseId, PlanItem[]>();
    for (const item of willRun) {
      const db = databaseOfItem(item);
      if (db && ages.has(db) && ages.get(db) !== "fresh") needing.set(db, [...(needing.get(db) ?? []), item]);
    }
    if (needing.size > 0) {
      const dbs = [...needing.keys()];
      out.push({
        id: "data",
        label: t("plan_review_prep_data"),
        detail: t("plan_review_prep_data_detail", { databases: dbs.map((d) => DATABASES[d].tool).join(", ") }),
        network: "bridge",
        affects: checkNames([...needing.values()].flat()),
        action: { type: "prepare-data", label: t("plan_review_action_prepare_data") },
      });
    }
  }

  const components = Object.keys(container.dependencyKeys ?? {});
  if (components.length > 0 && !inImage) {
    const units = facts.sections?.dependencies?.units ?? [];
    const pending = components.filter((component) => !units.some((u) => u.components.includes(component) && u.state === "ready"));
    if (pending.length > 0) {
      out.push({
        id: "dependencies",
        label: t("plan_review_prep_dependencies"),
        detail: t("plan_review_prep_dependencies_detail", { components: pending.join(", ") }),
        network: "bridge",
        affects: checkNames(willRun.filter((i) => i.toolSource?.origin === "project" || i.effects.executesProjectCode)),
        action: { type: "prepare-dependencies", label: t("plan_review_action_prepare_dependencies") },
      });
    }
  }
  return out;
}

/** Every check that will not run, grouped by the kind of reason, and the preparations still pending. */
export function reviewItemsOf(plan: Plan, facts: EnvironmentFacts | null, labels: Map<string, string>, translate: Translator = translator("plan-review")): ReviewItems {
  const t = translate;
  const items: NotRunningItem[] = [];
  const claimed = new Set<string>();
  for (const na of plan.groups.notApplicableRequirements ?? []) {
    items.push(fromNotApplicable(plan, na, t));
    for (const id of na.candidates) claimed.add(id);
  }
  for (const u of plan.groups.uncoveredRequirements) {
    items.push(fromUncovered(plan, u, labels, t));
    for (const id of u.candidates) claimed.add(id);
  }
  for (const item of plan.groups.notApplicableOrDisabled) {
    if (claimed.has(item.id)) continue;
    // Not selected by the profile, or without an adapter that runs, is not something the person turned off.
    if (item.reason.code === "DISABLED" || item.reason.code === "ONLY_EXCLUDED") items.push(fromDisabledItem(item, labels, t));
  }
  const groups = NOT_RUNNING_KINDS.map((kind) => {
    const list = items.filter((i) => i.kind === kind).sort((a, b) => String(a.category).localeCompare(String(b.category)) || a.check.localeCompare(b.check));
    return { kind, count: list.length, items: list };
  }).filter((g) => g.count > 0);
  return { notRunning: { total: items.length, groups }, preparations: preparationsOf(plan, facts, labels, t) };
}
