import { translator } from "../../i18n/index.js";
import { decodePointer, encodePointer, LAYER_ORDER, type LayerName, type ResolvedField, type ResolveResult } from "../config/resolve/index.js";
import {
  buildUniverse,
  checkSelector,
  parseSelector,
  SELECTOR_KINDS,
  type Selector,
  type SelectorKind,
  type Universe,
  type UniverseOptions,
} from "./selectors.js";

export * from "./selectors.js";

/**
 * Effective selection: for every check the project can name (category, capability, tool, rule, PII entity,
 * architecture rule, component) it decides on or off, with the origin of the decision.
 *
 * Rules of the granular selection:
 * - the strongest layer wins (defaults < template < profile < project < call);
 * - in the same layer the most specific selector wins (rule > tool > capability or component > category);
 *   a tie between conflicting values at the same specificity goes to "enabled" (fail-closed: more checks run);
 * - turning one check off turns no other off: a tool instance runs each of its capabilities on its own, and an
 *   explicit tool: selector beats a capability: selector of the same layer;
 * - a selector that names nothing is an error with a suggestion;
 * - a requirement locked in the policy (locked: true) cannot be turned off by any layer: the attempt is an error
 *   with the reason, and a locked requirement nothing selected is turned on.
 * Anything no selector covers is off (NOT_SELECTED), except components, which are on.
 */

export type SelectionReason = "EXPLICIT" | "DERIVED" | "NOT_SELECTED" | "DEFAULT" | "LOCKED_REQUIRED";

export interface SelectionDecision {
  selector: string;
  value: boolean | string;
  layer: LayerName;
  source: string;
  file: string | null;
  path: string | null;
  pointer: string;
  specificity: number;
}

export interface LockInfo {
  selector: string;
  reason: string;
  file: string | null;
  path: string | null;
}

/** One capability of a tool instance: the unit that actually runs. */
export interface PairState {
  capability: string | null;
  enabled: boolean;
  reason: SelectionReason;
  decision: SelectionDecision | null;
  overridden: SelectionDecision[];
  intensity?: string;
  locked?: LockInfo[];
  lockViolation?: boolean;
}

export interface SelectionItem {
  selector: string;
  kind: SelectorKind;
  id: string;
  enabled: boolean;
  reason: SelectionReason;
  /** The decision that won; null when nothing covered the check. */
  decision: SelectionDecision | null;
  /** Decisions that lost to the winner, strongest first. */
  overridden: SelectionDecision[];
  intensity?: string;
  locked?: LockInfo[];
  /** The check is off although a lock requires it (also reported in `errors`). */
  lockViolation?: boolean;
  /** Tools: one state per capability. */
  capabilities?: PairState[];
  /** Capabilities: the tool instances running it. */
  activeTools?: string[];
  component?: string | null;
  /** Conflicting decisions of the same layer and specificity were settled in favour of "enabled". */
  tie?: boolean;
}

export interface SelectionIssue {
  code: "SELECTOR_INVALID" | "SELECTOR_UNMATCHED" | "RULE_UNSUPPORTED" | "LOCKED_REQUIREMENT";
  selector: string;
  message: string;
  fix?: string;
  suggestion?: string;
  file?: string | null;
  path?: string | null;
  layer?: LayerName;
  source?: string;
  /** LOCKED_REQUIREMENT: the lock and the decision that tried to turn the check off. */
  lock?: LockInfo;
  disabledBy?: SelectionDecision;
  /** LOCKED_REQUIREMENT: the checks that would be off. */
  items?: string[];
}

export interface SelectionResult {
  ok: boolean;
  items: SelectionItem[];
  errors: SelectionIssue[];
  locks: LockInfo[];
  universe: Universe;
}

export interface SelectionOptions extends UniverseOptions {
  /** Discovery inventory (its classifications name the components). */
  inventory?: { classifications?: Array<{ id?: string | null }> };
  /** A prebuilt universe, instead of building one from the configuration. */
  universe?: Universe;
}

const SPECIFICITY: Record<SelectorKind, number> = { category: 1, capability: 2, component: 2, tool: 3, pii: 3, architecture: 3, rule: 4 };
/** A composite parent (tool:quality-bridge) is more general than an instance but more specific than a capability. */
const PARENT_TOOL_SPECIFICITY = 2.5;

interface Entry {
  selector: string;
  field: "enabled" | "intensity";
  value: boolean | string;
  rank: number;
  decision: Omit<SelectionDecision, "specificity">;
}

interface Cover {
  selector: string;
  specificity: number;
}

interface Candidate {
  entry: Entry;
  specificity: number;
}

const rankOf = (layer: LayerName): number => LAYER_ORDER.indexOf(layer);

function entryOf(selector: string, field: "enabled" | "intensity", f: ResolvedField): Entry | undefined {
  if (field === "enabled" ? typeof f.value !== "boolean" : typeof f.value !== "string") return undefined;
  return {
    selector,
    field,
    value: f.value as boolean | string,
    rank: rankOf(f.layer),
    decision: { selector, value: f.value as boolean | string, layer: f.layer, source: f.source, file: f.file, path: f.path, pointer: f.pointer },
  };
}

/** Where the entries of the selection come from: /checks/<selector>/{enabled,intensity} and the per-kind files. */
function collectEntries(result: ResolveResult): Entry[] {
  const out: Entry[] = [];
  for (const [pointer, f] of Object.entries(result.fields)) {
    const seg = decodePointer(pointer);
    if (!seg) continue;
    const last = seg[seg.length - 1];
    if (last !== "enabled" && last !== "intensity") continue;
    let selector: string | undefined;
    if (seg.length === 3 && seg[0] === "checks") selector = seg[1];
    else if (seg.length === 3 && seg[0] === "tools" && last === "enabled") selector = `tool:${seg[1]}`;
    else if (seg.length === 4 && seg[0] === "pii" && seg[1] === "entities" && last === "enabled") selector = `pii:${seg[2]}`;
    else if (seg.length === 4 && seg[0] === "architecture" && seg[1] === "rules" && last === "enabled") selector = `architecture:${seg[2]}`;
    if (selector === undefined) continue;
    const e = entryOf(selector, last, f);
    if (e) out.push(e);
  }
  return out;
}

/** Locks of the policy: requiredEvidence with locked: true, and policy rules named by a selector. */
function collectLocks(result: ResolveResult): LockInfo[] {
  const t = translator("selection");
  const locks: LockInfo[] = [];
  const policy = result.config.policy as Record<string, unknown> | undefined;
  const add = (selector: string, body: unknown, pointerBase: string[]): void => {
    if (body === null || typeof body !== "object") return;
    const b = body as Record<string, unknown>;
    if (b.locked !== true) return;
    const f = result.fields[encodePointer([...pointerBase, "locked"])];
    locks.push({
      selector,
      reason: typeof b.reason === "string" && b.reason !== "" ? b.reason : t("selection_locked_default_reason"),
      file: f?.file ?? null,
      path: f?.path ?? null,
    });
  };
  const evidence = policy?.requiredEvidence;
  if (evidence !== null && typeof evidence === "object") {
    for (const [check, body] of Object.entries(evidence)) add(check, body, ["policy", "requiredEvidence", check]);
  }
  const rules = policy?.rules;
  if (rules !== null && typeof rules === "object") {
    for (const [key, body] of Object.entries(rules)) if (parseSelector(key)) add(key, body, ["policy", "rules", key]);
  }
  return locks;
}

function pickWinner(covers: Cover[], byField: Map<string, Entry>, probe?: (value: boolean | string) => boolean): { winner?: Candidate; overridden: Candidate[]; tie: boolean } {
  const found: Candidate[] = [];
  for (const cover of covers) {
    const entry = byField.get(cover.selector);
    if (entry && (!probe || probe(entry.value))) found.push({ entry, specificity: cover.specificity });
  }
  found.sort(
    (a, b) =>
      b.entry.rank - a.entry.rank ||
      b.specificity - a.specificity ||
      Number(b.entry.value === true) - Number(a.entry.value === true) ||
      a.entry.selector.localeCompare(b.entry.selector),
  );
  const [winner, ...rest] = found;
  const tie = winner !== undefined && rest.some((c) => c.entry.rank === winner.entry.rank && c.specificity === winner.specificity && c.entry.value !== winner.entry.value);
  return { ...(winner ? { winner } : {}), overridden: rest, tie };
}

const toDecision = (c: Candidate): SelectionDecision => ({ ...c.entry.decision, specificity: c.specificity });

/**
 * Decides the effective selection of a resolved configuration.
 * `result` comes from resolveConfig (with --skip style overrides already applied in the call layer).
 */
export function resolveSelection(result: ResolveResult, options: SelectionOptions = {}): SelectionResult {
  const t = translator("selection");
  const universe = options.universe ?? buildUniverse(result.config, options.inventory, options);
  const entries = collectEntries(result);
  const enabledBy = new Map<string, Entry>();
  const intensityBy = new Map<string, Entry>();
  for (const e of entries) {
    // The same selector may be written in two places (checks: and a tool's own enabled): the stronger layer counts.
    const map = e.field === "enabled" ? enabledBy : intensityBy;
    const known = map.get(e.selector);
    if (!known || e.rank - known.rank > 0 || (e.rank === known.rank && e.decision.pointer.startsWith("/checks/"))) map.set(e.selector, e);
  }
  const locks = collectLocks(result);
  const errors: SelectionIssue[] = [];

  // 1. Selectors must name something (the defaults layer is the engine's own and always valid).
  const checked = new Set<string>();
  const verify = (selector: string, origin: { layer?: LayerName; source?: string; file?: string | null; path?: string | null }): void => {
    if (checked.has(selector)) return;
    checked.add(selector);
    const problem = checkSelector(selector, universe);
    if (!problem) return;
    const where = origin.file ? `${origin.file}${origin.path ? `#${origin.path}` : ""}` : (origin.source ?? "-");
    const suggestion = problem.suggestion;
    let message: string;
    if (problem.code === "SELECTOR_INVALID") message = t("selection_selector_invalid", { selector, kinds: SELECTOR_KINDS.join(", "), where });
    else if (problem.code === "RULE_UNSUPPORTED") message = t("selection_rule_unsupported", { selector, tool: problem.tool, where });
    else message = t("selection_selector_unmatched", { selector, where });
    errors.push({
      code: problem.code,
      selector,
      message,
      fix: suggestion ? t("selection_unmatched_suggest", { suggestion }) : t("selection_unmatched_fix"),
      ...(suggestion ? { suggestion } : {}),
      file: origin.file ?? null,
      path: origin.path ?? null,
      ...(origin.layer ? { layer: origin.layer } : {}),
      ...(origin.source ? { source: origin.source } : {}),
    });
  };
  for (const e of entries) {
    if (e.decision.layer === "defaults") continue;
    if (!e.decision.pointer.startsWith("/checks/")) continue;
    verify(e.selector, e.decision);
  }
  for (const lock of locks) verify(lock.selector, { file: lock.file, path: lock.path, source: "policy" });

  // 2. Coverage and decisions.
  const capCategory = new Map(universe.capabilities.map((c) => [c.id, c.category]));
  const toolById = new Map(universe.tools.map((tool) => [tool.id, tool]));
  const lockedBy = (covers: Cover[]): LockInfo[] => locks.filter((l) => covers.some((c) => c.selector === l.selector));

  const toolCovers = (tool: { id: string; parent: string | null; component: string | null }, capability: string | null): Cover[] => {
    const covers: Cover[] = [{ selector: `tool:${tool.id}`, specificity: SPECIFICITY.tool }];
    if (tool.parent) covers.push({ selector: `tool:${tool.parent}`, specificity: PARENT_TOOL_SPECIFICITY });
    if (capability) {
      covers.push({ selector: `capability:${capability}`, specificity: SPECIFICITY.capability });
      const cat = capCategory.get(capability);
      if (cat) covers.push({ selector: `category:${cat}`, specificity: SPECIFICITY.category });
    }
    if (tool.component) covers.push({ selector: `component:${tool.component}`, specificity: SPECIFICITY.component });
    return covers;
  };

  const violations: Array<{ lock: LockInfo; decision: SelectionDecision; item: string }> = [];

  const decide = (selector: string, covers: Cover[], extra?: Candidate, lockCovers: Cover[] = covers): Omit<SelectionItem, "kind" | "id" | "selector"> & { tie: boolean } => {
    const enabled = pickWinner(covers, enabledBy, (v) => typeof v === "boolean");
    let winner = enabled.winner;
    let overridden = enabled.overridden;
    if (extra) {
      const all = [...(winner ? [winner, ...overridden] : overridden), extra].sort(
        (a, b) => b.entry.rank - a.entry.rank || b.specificity - a.specificity || Number(b.entry.value === true) - Number(a.entry.value === true),
      );
      winner = all[0];
      overridden = all.slice(1);
    }
    const intensity = pickWinner(covers, intensityBy).winner;
    const locked = lockedBy(lockCovers);
    let value = winner ? winner.entry.value === true : false;
    let reason: SelectionReason = winner ? "EXPLICIT" : "NOT_SELECTED";
    let decision: SelectionDecision | null = winner ? toDecision(winner) : null;
    let lockViolation = false;
    if (locked.length > 0) {
      if (!winner) {
        value = true;
        reason = "LOCKED_REQUIRED";
        const l = locked[0] as LockInfo;
        decision = { selector: l.selector, value: true, layer: "project", source: "policy", file: l.file, path: l.path, pointer: "", specificity: 0 };
      } else if (!value) {
        lockViolation = true;
        for (const l of locked) violations.push({ lock: l, decision: decision as SelectionDecision, item: selector });
      }
    }
    return {
      enabled: value,
      reason,
      decision,
      overridden: overridden.map(toDecision),
      ...(intensity ? { intensity: String(intensity.entry.value) } : {}),
      ...(locked.length > 0 ? { locked } : {}),
      ...(lockViolation ? { lockViolation } : {}),
      tie: enabled.tie,
    };
  };

  const items: SelectionItem[] = [];
  const make = (kind: SelectorKind, id: string, body: Omit<SelectionItem, "kind" | "id" | "selector" | "tie"> & { tie?: boolean }): SelectionItem => {
    const { tie, ...rest } = body;
    const item: SelectionItem = { selector: `${kind}:${id}`, kind, id, ...rest, ...(tie ? { tie } : {}) };
    items.push(item);
    return item;
  };

  // Tools: one decision per capability, the tool is on when any of its capabilities runs.
  const toolItems = new Map<string, SelectionItem>();
  for (const tool of universe.tools) {
    const caps: Array<string | null> = tool.capabilities.length > 0 ? tool.capabilities : [null];
    const pairs: PairState[] = [];
    let tie = false;
    for (const cap of caps) {
      const d = decide(`tool:${tool.id}${cap ? `[${cap}]` : ""}`, toolCovers(tool, cap));
      tie ||= d.tie;
      pairs.push({
        capability: cap,
        enabled: d.enabled,
        reason: d.reason,
        decision: d.decision,
        overridden: d.overridden,
        ...(d.intensity ? { intensity: d.intensity } : {}),
        ...(d.locked ? { locked: d.locked } : {}),
        ...(d.lockViolation ? { lockViolation: true } : {}),
      });
    }
    const on = pairs.filter((p) => p.enabled);
    const lead = (on.length > 0 ? on : pairs).slice().sort((a, b) => (b.decision ? rankOf(b.decision.layer) : -1) - (a.decision ? rankOf(a.decision.layer) : -1) || (b.decision?.specificity ?? 0) - (a.decision?.specificity ?? 0))[0] as PairState;
    const intensity = (on[0] ?? lead).intensity;
    const lockedAll = pairs.flatMap((p) => p.locked ?? []);
    const item = make("tool", tool.id, {
      enabled: on.length > 0,
      reason: lead.reason,
      decision: lead.decision,
      overridden: lead.overridden,
      ...(intensity ? { intensity } : {}),
      ...(lockedAll.length > 0 ? { locked: [...new Map(lockedAll.map((l) => [l.selector, l])).values()] } : {}),
      ...(pairs.some((p) => p.lockViolation) ? { lockViolation: true } : {}),
      capabilities: pairs,
      component: tool.component,
      tie,
    });
    toolItems.set(tool.id, item);
  }

  // Rules of tool instances: the rule selector, or what the instance decided.
  for (const rule of universe.rules) {
    const tool = toolById.get(rule.tool);
    const parentItem = toolItems.get(rule.tool);
    const covers: Cover[] = [{ selector: `rule:${rule.tool}/${rule.id}`, specificity: SPECIFICITY.rule }];
    if (tool?.component) covers.push({ selector: `component:${tool.component}`, specificity: SPECIFICITY.component });
    const inherited: Candidate | undefined = parentItem?.decision
      ? {
          entry: {
            selector: `tool:${rule.tool}`,
            field: "enabled",
            value: parentItem.enabled,
            rank: rankOf(parentItem.decision.layer),
            decision: { ...parentItem.decision, value: parentItem.enabled },
          },
          specificity: SPECIFICITY.tool,
        }
      : undefined;
    const lockCovers = tool ? [...covers, ...toolCovers(tool, null)] : covers;
    const d = decide(`rule:${rule.tool}/${rule.id}`, covers, inherited, lockCovers);
    make("rule", `${rule.tool}/${rule.id}`, d);
  }

  for (const id of universe.pii) {
    make("pii", id, decide(`pii:${id}`, [
      { selector: `pii:${id}`, specificity: SPECIFICITY.pii },
      { selector: "capability:pii", specificity: SPECIFICITY.capability },
      ...(capCategory.get("pii") ? [{ selector: `category:${capCategory.get("pii")}`, specificity: SPECIFICITY.category }] : []),
    ]));
  }
  for (const id of universe.architecture) {
    make("architecture", id, decide(`architecture:${id}`, [
      { selector: `architecture:${id}`, specificity: SPECIFICITY.architecture },
      { selector: "capability:architecture", specificity: SPECIFICITY.capability },
      ...(capCategory.get("architecture") ? [{ selector: `category:${capCategory.get("architecture")}`, specificity: SPECIFICITY.category }] : []),
    ]));
  }
  for (const id of universe.components) {
    const d = decide(`component:${id}`, [{ selector: `component:${id}`, specificity: SPECIFICITY.component }]);
    if (d.reason === "NOT_SELECTED") make("component", id, { ...d, enabled: true, reason: "DEFAULT" });
    else make("component", id, d);
  }

  // Capabilities and categories: their own decision; without one, derived from what runs under them.
  const capItems = new Map<string, SelectionItem>();
  for (const cap of universe.capabilities) {
    const covers: Cover[] = [{ selector: `capability:${cap.id}`, specificity: SPECIFICITY.capability }];
    if (cap.category) covers.push({ selector: `category:${cap.category}`, specificity: SPECIFICITY.category });
    const d = decide(`capability:${cap.id}`, covers);
    const activeTools = items.filter((i) => i.kind === "tool" && i.capabilities?.some((p) => p.capability === cap.id && p.enabled)).map((i) => i.id);
    const derived = d.reason === "NOT_SELECTED" && activeTools.length > 0;
    capItems.set(cap.id, make("capability", cap.id, derived ? { ...d, enabled: true, reason: "DERIVED", activeTools } : { ...d, activeTools }));
  }
  for (const category of universe.categories) {
    const d = decide(`category:${category}`, [{ selector: `category:${category}`, specificity: SPECIFICITY.category }]);
    const derived = d.reason === "NOT_SELECTED" && universe.capabilities.some((c) => c.category === category && capItems.get(c.id)?.enabled);
    make("category", category, derived ? { ...d, enabled: true, reason: "DERIVED" } : d);
  }

  // 3. A locked check that is off is an error with the reason; one error per lock and deciding selector.
  const grouped = new Map<string, SelectionIssue>();
  for (const v of violations) {
    const key = `${v.lock.selector}|${v.decision.pointer}`;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.items?.includes(v.item)) existing.items?.push(v.item);
      continue;
    }
    grouped.set(key, {
      code: "LOCKED_REQUIREMENT",
      selector: v.lock.selector,
      message: t("selection_locked_violation", {
        lock: v.lock.selector,
        reason: v.lock.reason,
        by: v.decision.file ? `${v.decision.file}${v.decision.path ? `#${v.decision.path}` : ""}` : v.decision.source,
        selector: v.decision.selector,
      }),
      fix: t("selection_locked_fix"),
      file: v.decision.file,
      path: v.decision.path,
      layer: v.decision.layer,
      source: v.decision.source,
      lock: v.lock,
      disabledBy: v.decision,
      items: [v.item],
    });
  }
  errors.push(...grouped.values());

  return { ok: errors.length === 0, items, errors, locks, universe };
}

/** Overrides of the call layer for `--skip`: each selector turned off, with the flag as the origin. */
export function skipOverrides(selectors: readonly string[]): Array<{ pointer: string; value: boolean; source: string }> {
  return selectors.map((selector) => ({ pointer: encodePointer(["checks", selector, "enabled"]), value: false, source: "--skip" }));
}

/** Splits a --skip value (comma separated) into selectors. */
export function parseSkipList(values: ReadonlyArray<string>): string[] {
  return values.flatMap((v) => v.split(",")).map((s) => s.trim()).filter((s) => s !== "");
}
