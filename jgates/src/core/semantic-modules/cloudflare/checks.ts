// The artifact contracts of the security-audit stages and their host checks. Each stage ends with one JSON object; the
// host keeps only what validates: references to files the context read, block references that exist in the vendored
// attack-class files, coverage units whose IDs the host derives, dispositions that satisfy the ledger state table and
// records that satisfy their verdict branch (upstream validate-coverage-ledger.cjs and validate-findings.cjs roles).
import { normalizeScopePath } from "../../semantic-scope/index.js";
import type { ArtifactCandidate, ArtifactCheck, ArtifactCheckContext, Candidate, Evidence } from "../../semantic-executor/index.js";
import { PLAN_STATUSES, QUICK_SUBSYSTEM, refProblems, seedUnit, semanticKey, sortUnits, validateLedger, type CanonicalRefs, type LedgerCheck, type LedgerUnit, type UnitStatus } from "./ledger.js";
import { analyzePrior, type PriorAnalysis } from "./prior.js";
import { checkRecord, CONFIRMED_SHAPE, materialChange, NEEDS_VALIDATION_SHAPE, recordFiles, recordLocation, recordSeverity, REJECTED_SHAPE, toConfirmation, VERDICTS, type EvidenceEntry, type Verdict } from "./records.js";
import { companionCompanions, type VendoredMaterial } from "./source.js";

export const STAGE = { recon: "reconnaissance", plan: "coverage-planning", hunt: "hunting", critic: "coverage-critic", refute: "refutation", verify: "verification" } as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 2000): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown, max = 1000): string[] => [...new Set(list(v).map((s) => text(s, max)).filter((s) => s !== ""))];

// ---- shapes shown to the models ---------------------------------------------------------------------------------

const REF = `{"path": "workspace-relative path you read", "line": 12}`;
export const RECON_SHAPE = `{"summary": "...", "product": {"type": "...", "users": "...", "trust_sensitive_actions": ["..."], "stack": ["..."], "deployment_models": ["..."], "comparable": "source-grounded comparable or null"}, "subsystems": [{"name": "...", "paths": ["..."]}], "principals": [{"principal": "...", "actions": "..."}], "trust_boundaries": [{"boundary": "...", "control": ${REF}, "source_visible": true, "description": "..."}], "entry_surfaces": [{"surface": "...", "kind": "http|rpc|file|cli|plugin|ci|cloud|model|mobile|ipc|other", "path": "...", "line": 12, "sinks": [{"path": "...", "line": 12, "operation": "..."}]}], "dangerous_operations": [{"path": "...", "line": 12, "operation": "..."}], "local_validation": {"fixtures": [{"path": "...", "use": "..."}], "prohibited_commands": ["..."]}, "deployment_facts_unavailable": ["..."], "assumptions": ["..."], "omissions": [{"area": "...", "reason": "..."}], "companions": [{"file": "COMPANION.md", "reason": "source fact that requires it"}]}`;
const UNIT_SHAPE = `{"canonical_refs": {"surface": "src/router.ts#POST /users/:id", "boundary": "src/authz.ts#requireOwner", "subsystem": "packages/api", "attack_class": "ATTACK-CLASSES.md#Access control", "lifecycle": "optional"}, "surface": "label", "boundary": "label", "subsystem": "label", "attack_class": "label", "lifecycle": "optional label", "starting_paths": ["workspace-relative path"], "selected_companion_blocks": ["FILE.md#Class name"], "excluded_blocks": [{"block": "FILE.md#...", "reason": "source fact that excludes it"}]`;
export const PLAN_SHAPE = `{"architecture": "markdown summary, about 1,000 words at most", "companion_selection": [{"file": "COMPANION.md", "selected": true, "reason": "..."}], "units": [${UNIT_SHAPE}, "status": "planned|not_applicable|out_of_scope|unsupported", "reason": "required unless planned", "priority": 1, "priority_rationale": "..."}]}`;
export const HUNT_SHAPE = `{"summary": "...", "units": [{"coverage_id": "one assigned ID", "disposition": "covered|candidate|blocked", "reviewed_paths": ["files you read"], "checks": [{"reviewed_paths": ["files this check read"], "invariant": "specific control checked", "method": "source", "result": "what the source established", "artifact": null}], "candidate_fingerprints": [], "unresolved": []}], "candidates": [{"proposed_verdict": "confirmed", ...${CONFIRMED_SHAPE.slice(1)}, {"proposed_verdict": "needs_validation", ...${NEEDS_VALIDATION_SHAPE.slice(1)}], "hardening": ["concrete non-finding note"], "uncovered": [{"surface": "...", "boundary": "...", "subsystem": "...", "attack_class": "FILE.md#block", "starting_paths": ["..."], "reason": "why this needs its own coverage unit"}]}`;
export const CRITIC_SHAPE = `{"summary": "...", "missing_units": [${UNIT_SHAPE}, "reason": "source-backed coverage gap"}], "reassign_ids": ["existing coverage_id that did not close"], "resolved_prior_leads": [{"fingerprint": "...", "reason": "..."}], "stop": false}`;
export const REFUTE_SHAPE = `{"decision": "confirmed|needs_validation|rejected", "record": <the record of that branch: confirmed ${CONFIRMED_SHAPE} | needs_validation ${NEEDS_VALIDATION_SHAPE} | rejected ${REJECTED_SHAPE}>}`;
export const VERIFY_SHAPE = `{"decision": "verified", "fingerprint": "...", "reason": "what you re-checked"} or {"decision": "replace", "reason": "...", "record": {"verdict": "confirmed|needs_validation|rejected", ...the complete record of that branch}}`;

// ---- accepted values --------------------------------------------------------------------------------------------

export interface PlanValue {
  architecture: string;
  companion_selection: Array<{ file: string; selected: boolean; reason: string }>;
  units: LedgerUnit[];
  profile: string;
  prior: { baselineRunId: string | null; state: PriorAnalysis["state"]; message: string; units: number; records: number };
  /** Carried same-source confirmed roots (hunters exclude them) and unchanged rejected claims (only that claim). */
  exclusions: Array<{ fingerprint: string; title: string; root_cause: string; kind: "carried" | "prior-rejected" }>;
  ledgerProblems: string[];
}

export interface HuntUnit {
  coverage_id: string;
  disposition: "covered" | "candidate" | "blocked";
  reviewed_paths: string[];
  checks: LedgerCheck[];
  candidate_fingerprints: string[];
  unresolved: string[];
}

export interface HuntValue {
  summary: string;
  agent: string;
  units: HuntUnit[];
  candidates: Array<Record<string, unknown>>;
  hardening: string[];
  uncovered: Array<{ surface: string; boundary: string; subsystem: string; attack_class: string; starting_paths: string[]; reason: string }>;
}

export interface CriticValue {
  summary: string;
  agent: string;
  missing_units: LedgerUnit[];
  reassign_ids: string[];
  resolved_prior_leads: Array<{ fingerprint: string; reason: string }>;
  stop: boolean;
}

// ---- reconnaissance ---------------------------------------------------------------------------------------------

export function checkReconnaissance(material: VendoredMaterial) {
  return (value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck => {
    const problems: string[] = [];
    const summary = text(value.summary, 4000);
    if (!summary) return { ok: false, problems: ["summary is required"] };
    const examined = new Set<string>();
    const ref = (p: unknown, line: unknown, where: string): { path: string; line?: number } | null => {
      const n = typeof p === "string" ? normalizeScopePath(p) : null;
      if (!n || !ctx.seen.has(n)) {
        problems.push(`${where}: ${String(p).slice(0, 120)} is dropped: this context never read it`);
        return null;
      }
      if (line !== undefined && line !== null) {
        const total = ctx.lines(n);
        if (typeof line !== "number" || !Number.isInteger(line) || line < 1 || (total !== null && line > total)) {
          problems.push(`${where}: ${n}:${String(line)} points to no line`);
          return null;
        }
        examined.add(n);
        return { path: n, line };
      }
      examined.add(n);
      return { path: n };
    };
    const product = isObj(value.product) ? value.product : {};
    const out: Record<string, unknown> = {
      summary,
      product: {
        type: text(product.type, 300),
        users: text(product.users, 500),
        trust_sensitive_actions: strings(product.trust_sensitive_actions, 300),
        stack: strings(product.stack, 200),
        deployment_models: strings(product.deployment_models, 300),
        comparable: text(product.comparable, 500) || null,
      },
      subsystems: list(value.subsystems).filter(isObj).map((s) => ({ name: text(s.name, 200), paths: strings(s.paths, 300).map((p) => normalizeScopePath(p)).filter((p): p is string => !!p) })).filter((s) => s.name),
      principals: list(value.principals).filter(isObj).map((p) => ({ principal: text(p.principal, 200), actions: text(p.actions, 1000) })).filter((p) => p.principal),
      trust_boundaries: list(value.trust_boundaries).filter(isObj).flatMap((b, i) => {
        const c = isObj(b.control) ? b.control : {};
        const r = ref(c.path, c.line, `trust_boundaries[${i}]`);
        return r ? [{ boundary: text(b.boundary, 300), control: r, source_visible: b.source_visible !== false, description: text(b.description, 1000) }] : [];
      }),
      entry_surfaces: list(value.entry_surfaces).filter(isObj).flatMap((s, i) => {
        const r = ref(s.path, s.line, `entry_surfaces[${i}]`);
        if (!r) return [];
        const sinks = list(s.sinks).filter(isObj).flatMap((k, j) => {
          const kr = ref(k.path, k.line, `entry_surfaces[${i}].sinks[${j}]`);
          return kr ? [{ ...kr, operation: text(k.operation, 300) }] : [];
        });
        return [{ surface: text(s.surface, 300), kind: text(s.kind, 30) || "other", ...r, sinks }];
      }),
      dangerous_operations: list(value.dangerous_operations).filter(isObj).flatMap((d, i) => {
        const r = ref(d.path, d.line, `dangerous_operations[${i}]`);
        return r ? [{ ...r, operation: text(d.operation, 300) }] : [];
      }),
      local_validation: {
        fixtures: list(isObj(value.local_validation) ? value.local_validation.fixtures : []).filter(isObj).flatMap((f, i) => {
          const r = ref(f.path, undefined, `local_validation.fixtures[${i}]`);
          return r ? [{ path: r.path, use: text(f.use, 500) }] : [];
        }),
        prohibited_commands: strings(isObj(value.local_validation) ? value.local_validation.prohibited_commands : [], 300),
      },
      deployment_facts_unavailable: strings(value.deployment_facts_unavailable),
      assumptions: strings(value.assumptions),
      omissions: list(value.omissions).filter(isObj).map((o) => ({ area: text(o.area, 300), reason: text(o.reason, 1000) })).filter((o) => o.area && o.reason),
      companions: list(value.companions).filter(isObj).flatMap((c, i) => {
        const file = text(c.file, 120);
        if (!material.companions.some((m) => m.file === file)) {
          problems.push(`companions[${i}]: ${file} is not a vendored companion file`);
          return [];
        }
        return [{ file, reason: text(c.reason, 1000) }];
      }),
    };
    const omissions = out.omissions as Array<{ area: string; reason: string }>;
    return { ok: true, problems, value: out, examined: [...examined], gaps: omissions.map((o) => ({ reason: `reconnaissance omission (${o.area}): ${o.reason}` })) };
  };
}

// ---- coverage units -----------------------------------------------------------------------------------------------

interface UnitParse {
  unit?: LedgerUnit;
  problem?: string;
}

/** Parses one proposed unit (coverage planning or a critic's missing unit) into a seeded ledger unit. */
function parseUnit(raw: unknown, where: string, material: VendoredMaterial, ctx: ArtifactCheckContext, status: UnitStatus, reason: string, addedBy: NonNullable<LedgerUnit["added_by"]>): UnitParse {
  if (!isObj(raw)) return { problem: `${where} is not an object` };
  const r = isObj(raw.canonical_refs) ? raw.canonical_refs : {};
  const quick = ctx.run?.rigor === "quick";
  const refs: CanonicalRefs = {
    surface: String(r.surface ?? ""),
    boundary: String(r.boundary ?? ""),
    subsystem: quick ? QUICK_SUBSYSTEM : String(r.subsystem ?? ""),
    attack_class: String(r.attack_class ?? ""),
    ...(typeof r.lifecycle === "string" && r.lifecycle !== "" ? { lifecycle: r.lifecycle } : {}),
  };
  for (const [k, v] of Object.entries(refs)) {
    const p = refProblems(v);
    if (p) return { problem: `${where}: canonical_refs.${k}: ${p}` };
  }
  const block = material.blocks.get(refs.attack_class);
  if (!block || block.kind === "section") return { problem: `${where}: canonical_refs.attack_class ${JSON.stringify(refs.attack_class.slice(0, 120))} is not an attack-class block of the vendored files` };
  const problems: string[] = [];
  const selected = new Set<string>();
  for (const b of strings(raw.selected_companion_blocks, 300)) {
    const known = material.blocks.get(b);
    if (!known || known.kind === "ordinary") problems.push(`${where}: selected block ${b} is not a companion block`);
    else selected.add(b);
  }
  if (block.kind === "class") selected.add(block.ref);
  for (const file of new Set([...selected].map((b) => b.split("#")[0] ?? ""))) for (const s of companionCompanions(material, file)) selected.add(s);
  const excluded = list(raw.excluded_blocks)
    .filter(isObj)
    .map((e) => ({ block: text(e.block, 300), reason: text(e.reason, 1000) }))
    .filter((e) => {
      if (!material.blocks.has(e.block) || !e.reason) {
        problems.push(`${where}: excluded block ${e.block || "(empty)"} is unknown or has no reason`);
        return false;
      }
      return !selected.has(e.block);
    });
  const starting = [...new Set(strings(raw.starting_paths, 400).map((p) => normalizeScopePath(p)).filter((p): p is string => !!p))].sort();
  let finalStatus = status;
  let finalReason = reason;
  const subjects = new Set(ctx.run?.scope.toExamine ?? []);
  if (status === "planned" || status === "deferred") {
    if (!starting.some((p) => subjects.has(p))) {
      // Reading supporting context does not make it a review subject: outside the subjects it is out of scope.
      finalStatus = "out_of_scope";
      finalReason = starting.length === 0 ? "the unit names no starting path among the subjects of the resolved scope (host)" : `its starting paths are outside the subjects of the resolved scope (host): ${starting.slice(0, 5).join(", ")}`;
    }
  }
  const label = (k: string, fallback: string): string => text(raw[k], 300) || fallback;
  const unit = seedUnit({
    canonical_refs: refs,
    surface: label("surface", refs.surface),
    boundary: label("boundary", refs.boundary),
    subsystem: quick ? "all in-scope subsystems" : label("subsystem", refs.subsystem),
    attack_class: label("attack_class", block.name),
    ...(refs.lifecycle ? { lifecycle: label("lifecycle", refs.lifecycle) } : {}),
    starting_paths: starting,
    ordinary_attack_class_block: block.kind === "ordinary" ? block.ref : null,
    selected_companion_blocks: [...selected].sort(),
    excluded_blocks: excluded,
    prior_status: "none",
    status: finalStatus,
    unresolved: finalStatus === "planned" ? [] : [finalReason || `${finalStatus}: no reason given`],
    added_by: addedBy,
    ...(typeof raw.priority === "number" && Number.isFinite(raw.priority) ? { priority: raw.priority } : {}),
    ...(text(raw.priority_rationale) ? { priority_rationale: text(raw.priority_rationale) } : {}),
  });
  return { unit, ...(problems.length > 0 ? { problem: problems.join("; ") } : {}) };
}

// ---- coverage planning ------------------------------------------------------------------------------------------

export function checkCoveragePlan(material: VendoredMaterial) {
  return (value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck => {
    const problems: string[] = [];
    let architecture = typeof value.architecture === "string" ? value.architecture.trim() : "";
    if (!architecture) return { ok: false, problems: ["architecture is required"] };
    const words = architecture.split(/\s+/);
    if (words.length > 1200) {
      architecture = `${words.slice(0, 1200).join(" ")} [truncated by the host at the architecture cap]`;
      problems.push(`architecture has ${words.length} words; the cap is about 1,000 (truncated at 1,200)`);
    }
    const byId = new Map<string, LedgerUnit>();
    for (const [i, raw] of list(value.units).entries()) {
      const statusRaw = isObj(raw) ? String(raw.status ?? "planned") : "planned";
      if (!(PLAN_STATUSES as readonly string[]).includes(statusRaw)) {
        problems.push(`units[${i}]: status must be one of ${PLAN_STATUSES.join(", ")}`);
        continue;
      }
      const reason = isObj(raw) ? text(raw.reason, 1000) : "";
      if (statusRaw !== "planned" && !reason) {
        problems.push(`units[${i}]: a ${statusRaw} unit needs its reason`);
        continue;
      }
      const parsed = parseUnit(raw, `units[${i}]`, material, ctx, statusRaw as UnitStatus, reason, "coverage-planning");
      if (parsed.problem) problems.push(parsed.problem);
      if (!parsed.unit) continue;
      const u = parsed.unit;
      const same = byId.get(u.coverage_id);
      if (same) {
        if (semanticKey(same) !== semanticKey(u)) return { ok: false, problems: [...problems, `units[${i}]: canonical identity collision on ${u.coverage_id} (never merged)`] };
        problems.push(`units[${i}]: duplicate of ${u.coverage_id} dropped`);
        continue;
      }
      byId.set(u.coverage_id, u);
    }
    const prior = ctx.run ? analyzePrior(ctx.run) : { baselineRunId: null, state: "none" as const, message: "No prior ledger.", units: [], records: [] };
    const exclusions: PlanValue["exclusions"] = [];
    const carried: ArtifactCandidate[] = [];
    if (prior.state === "read") {
      for (const u of byId.values()) u.prior_status = "new";
      const subjects = new Set(ctx.run?.scope.toExamine ?? []);
      const current = (prev: LedgerUnit, priorStatus: LedgerUnit["prior_status"]): LedgerUnit => {
        const inScope = prev.starting_paths.some((p) => subjects.has(p));
        const existing = byId.get(prev.coverage_id);
        const status: UnitStatus = inScope ? "planned" : "out_of_scope";
        const unresolved = inScope ? [] : [`prior unit outside the subjects of the current scope (${priorStatus})`];
        if (existing) {
          existing.prior_status = priorStatus;
          if (inScope) {
            existing.status = "planned";
            existing.state = "pending";
            existing.unresolved = [];
          }
          return existing;
        }
        const seeded = seedUnit({
          canonical_refs: prev.canonical_refs,
          surface: prev.surface,
          boundary: prev.boundary,
          subsystem: prev.subsystem,
          attack_class: prev.attack_class,
          ...(prev.lifecycle ? { lifecycle: prev.lifecycle } : {}),
          starting_paths: [...prev.starting_paths],
          ordinary_attack_class_block: prev.ordinary_attack_class_block && material.blocks.has(prev.ordinary_attack_class_block) ? prev.ordinary_attack_class_block : null,
          selected_companion_blocks: (prev.selected_companion_blocks ?? []).filter((b) => material.blocks.has(b)),
          excluded_blocks: (prev.excluded_blocks ?? []).filter((e) => material.blocks.has(e.block)),
          prior_status: priorStatus,
          status,
          unresolved,
          added_by: "prior-run",
        });
        byId.set(seeded.coverage_id, seeded);
        return seeded;
      };
      for (const { unit: prev, source } of prior.units) {
        const st = prev.status;
        if (st === "covered" || st === "candidate") current(prev, source === "same" ? "prior_covered_same_source" : "prior_covered_changed_source");
        else if (st === "blocked") current(prev, "prior_blocked");
        else if (st === "out_of_scope") current(prev, "prior_out_of_scope");
        else if (st === "deferred" || st === "planned" || st === "in_progress") current(prev, "prior_deferred");
      }
      for (const { record, source, readable } of prior.records) {
        const fp = String(record.fingerprint);
        const verdict = String(record.verdict) as Verdict;
        const ids = Array.isArray(record.coverage_ids) ? (record.coverage_ids as unknown[]).map(String) : [];
        const prevUnit = prior.units.find((x) => ids.includes(x.unit.coverage_id) || (x.unit.result_fingerprints ?? []).includes(fp))?.unit ?? null;
        if (verdict === "rejected") {
          if (source === "same") exclusions.push({ fingerprint: fp, title: text(record.title, 300), root_cause: text(record.claimed_root_cause, 1000), kind: "prior-rejected" });
          else if (prevUnit) current(prevUnit, "prior_rejected_claim_changed");
          continue;
        }
        if (source === "same" && readable && prevUnit) {
          const unit = current(prevUnit, verdict === "confirmed" ? "prior_confirmed_same_source" : "prior_needs_validation");
          if (unit.status !== "planned") continue;
          unit.carried = { fingerprint: fp, verdict, baselineRunId: prior.baselineRunId ?? "" };
          if (verdict === "confirmed") exclusions.push({ fingerprint: fp, title: text(record.title, 300), root_cause: text(record.root_cause, 1000), kind: "carried" });
          const { source_fingerprints: _s, coverage_ids: _c, ...rest } = record;
          const loc = recordLocation(rest);
          carried.push({
            title: text(rest.title, 200),
            path: loc.path,
            line: loc.line,
            severity: recordSeverity(rest),
            category: "security",
            rationale: text(rest.description, 1000),
            details: { proposed_verdict: verdict, record: rest, coverage_ids: [unit.coverage_id], reported_by: `prior:${prior.baselineRunId}`, carried: unit.carried },
          });
        } else if (prevUnit) {
          current(prevUnit, verdict === "confirmed" ? "prior_confirmed_changed_source" : "prior_needs_validation");
        }
      }
    }
    const units = sortUnits([...byId.values()]);
    if (units.length === 0) return { ok: false, problems: [...problems, "the coverage plan has no unit"] };
    const ledgerProblems = validateLedger(units);
    const companion_selection = list(value.companion_selection)
      .filter(isObj)
      .map((c) => ({ file: text(c.file, 120), selected: c.selected === true, reason: text(c.reason, 1000) }))
      .filter((c) => material.companions.some((m) => m.file === c.file));
    const out: PlanValue = {
      architecture,
      companion_selection,
      units,
      profile: ctx.run?.rigor ?? "standard",
      prior: { baselineRunId: prior.baselineRunId, state: prior.state, message: prior.message, units: prior.units.length, records: prior.records.length },
      exclusions,
      ledgerProblems,
    };
    return { ok: true, problems: [...problems, ...ledgerProblems], value: out as unknown as Record<string, unknown>, candidates: carried };
  };
}

// ---- hunting ------------------------------------------------------------------------------------------------------

export const planOf = (accepted: ArtifactCheckContext["accepted"]): PlanValue | null => (accepted?.[STAGE.plan] as unknown as PlanValue | undefined) ?? null;

export function checkHunting() {
  return (value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck => {
    const problems: string[] = [];
    const plan = planOf(ctx.accepted);
    if (!plan) return { ok: false, problems: ["no coverage plan was accepted: hunting results cannot be attributed to coverage units"] };
    const agent = ctx.agentId ?? "hunting";
    const assigned = new Set(plan.units.filter((u) => u.status === "planned" && !u.carried).map((u) => u.coverage_id));
    const excluded = new Set(plan.exclusions.map((e) => e.fingerprint));
    const records = new Map<string, Record<string, unknown>>();
    for (const [i, raw] of list(value.candidates).entries()) {
      if (!isObj(raw)) {
        problems.push(`candidates[${i}] is not an object`);
        continue;
      }
      const proposed = String(raw.proposed_verdict ?? "");
      if (proposed !== "confirmed" && proposed !== "needs_validation") {
        problems.push(`candidates[${i}]: proposed_verdict must be confirmed or needs_validation`);
        continue;
      }
      const { proposed_verdict: _p, ...body } = raw;
      const r = checkRecord(body, proposed, { seen: ctx.seen, lines: ctx.lines });
      if ("problems" in r) {
        problems.push(`candidates[${i}] is dropped: ${r.problems.join("; ")}`);
        continue;
      }
      const fp = String(r.record.fingerprint);
      if (excluded.has(fp)) {
        problems.push(`candidates[${i}]: ${fp} is a carried or unchanged prior record; it is not re-reported`);
        continue;
      }
      if (records.has(fp)) {
        problems.push(`candidates[${i}]: duplicate fingerprint ${fp} consolidated`);
        continue;
      }
      records.set(fp, r.record);
    }
    const units: HuntUnit[] = [];
    const seenIds = new Set<string>();
    for (const [i, raw] of list(value.units).entries()) {
      if (!isObj(raw)) continue;
      const id = String(raw.coverage_id ?? "");
      const where = `units[${i}] (${id.slice(0, 80)})`;
      if (!assigned.has(id)) {
        problems.push(`${where}: not an assigned coverage ID`);
        continue;
      }
      if (seenIds.has(id)) {
        problems.push(`${where}: appears more than once`);
        continue;
      }
      seenIds.add(id);
      const disposition = String(raw.disposition ?? "");
      if (!["covered", "candidate", "blocked"].includes(disposition)) {
        problems.push(`${where}: disposition must be covered, candidate or blocked`);
        continue;
      }
      const unitPaths = strings(raw.reviewed_paths, 400).map((p) => normalizeScopePath(p) ?? p);
      const unread = unitPaths.filter((p) => !ctx.seen.has(p));
      if (unread.length > 0) {
        problems.push(`${where}: reviewed paths never read by this context: ${unread.slice(0, 5).join(", ")}`);
        continue;
      }
      const checks: LedgerCheck[] = [];
      for (const c of list(raw.checks).filter(isObj)) {
        if (c.method !== "source" || (c.artifact !== null && c.artifact !== undefined)) {
          problems.push(`${where}: a check that is not a source check is dropped (no local execution in this run)`);
          continue;
        }
        const paths = strings(c.reviewed_paths, 400).map((p) => normalizeScopePath(p) ?? p);
        if (paths.length === 0 || paths.some((p) => !ctx.seen.has(p))) {
          problems.push(`${where}: a check whose reviewed paths were not read is dropped`);
          continue;
        }
        const invariant = text(c.invariant, 1000);
        const result = text(c.result, 2000);
        if (!invariant || !result) {
          problems.push(`${where}: a check without invariant or result is dropped`);
          continue;
        }
        checks.push({ agent_id: agent, reviewed_paths: [...new Set(paths)].sort(), invariant, method: "source", result, artifact: null });
      }
      const reviewed = [...new Set([...checks.flatMap((c) => c.reviewed_paths)])].sort();
      const fps = strings(raw.candidate_fingerprints, 200);
      const unknownFp = fps.filter((f) => !records.has(f));
      const unresolved = strings(raw.unresolved);
      const bad =
        reviewed.length === 0 || checks.length === 0
          ? "it has no owned evidence (reviewed paths and checks)"
          : disposition === "covered" && (unresolved.length > 0 || fps.length > 0)
            ? "a covered unit has nothing unresolved and no candidate"
            : disposition === "candidate" && (fps.length === 0 || unknownFp.length > 0)
              ? `a candidate unit links accepted candidate fingerprints${unknownFp.length > 0 ? ` (unknown: ${unknownFp.join(", ")})` : ""}`
              : disposition === "blocked" && (unresolved.length === 0 || fps.length > 0)
                ? "a blocked unit has an unresolved blocker and no fingerprint"
                : null;
      if (bad) {
        problems.push(`${where}: not accepted, ${bad}; it stays open`);
        continue;
      }
      units.push({ coverage_id: id, disposition: disposition as HuntUnit["disposition"], reviewed_paths: reviewed, checks, candidate_fingerprints: fps, unresolved });
    }
    for (const id of assigned) if (!seenIds.has(id)) problems.push(`assigned unit ${id.slice(0, 120)} has no result; it stays open`);
    const candidates: ArtifactCandidate[] = [];
    for (const [fp, record] of records) {
      const linked = units.filter((u) => u.candidate_fingerprints.includes(fp)).map((u) => u.coverage_id);
      if (linked.length === 0) problems.push(`candidate ${fp} is linked to no candidate unit`);
      const loc = recordLocation(record);
      candidates.push({
        title: text(record.title, 200),
        path: loc.path,
        line: loc.line,
        severity: recordSeverity(record),
        category: "security",
        rationale: text(`${String(record.description)} Impact: ${String(record.impact ?? "")}`, 1000),
        details: { proposed_verdict: record.verdict, record, coverage_ids: linked, reported_by: agent },
      });
    }
    const uncovered = list(value.uncovered)
      .filter(isObj)
      .map((u) => ({ surface: text(u.surface, 300), boundary: text(u.boundary, 300), subsystem: text(u.subsystem, 300), attack_class: text(u.attack_class, 300), starting_paths: strings(u.starting_paths, 400), reason: text(u.reason, 1000) }))
      .filter((u) => u.reason);
    const out: HuntValue = { summary: text(value.summary, 4000), agent, units, candidates: [...records.values()], hardening: strings(value.hardening), uncovered };
    return {
      ok: true,
      problems,
      value: out as unknown as Record<string, unknown>,
      candidates,
      examined: [...new Set(units.flatMap((u) => u.reviewed_paths))],
      gaps: [...units.filter((u) => u.disposition === "blocked").flatMap((u) => u.unresolved.map((r) => ({ reason: `blocked unit ${u.coverage_id}: ${r}` }))), ...uncovered.map((u) => ({ reason: `uncovered boundary (${u.attack_class || "unclassified"}): ${u.reason}` }))],
    };
  };
}

// ---- coverage critic ----------------------------------------------------------------------------------------------

export function checkCritic(material: VendoredMaterial) {
  return (value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck => {
    const problems: string[] = [];
    const plan = planOf(ctx.accepted);
    if (!plan) return { ok: false, problems: ["no coverage plan was accepted: the critic has no ledger to judge"] };
    const existing = new Set(plan.units.map((u) => u.coverage_id));
    const missing: LedgerUnit[] = [];
    for (const [i, raw] of list(value.missing_units).entries()) {
      const reason = isObj(raw) ? text(raw.reason, 1000) : "";
      if (!reason) {
        problems.push(`missing_units[${i}] has no source-backed reason`);
        continue;
      }
      const parsed = parseUnit(raw, `missing_units[${i}]`, material, ctx, "deferred", `single_wave_final_critic: ${reason}`, "coverage-critic");
      if (parsed.problem) problems.push(parsed.problem);
      if (!parsed.unit) continue;
      if (existing.has(parsed.unit.coverage_id) || missing.some((m) => m.coverage_id === parsed.unit!.coverage_id)) {
        problems.push(`missing_units[${i}] duplicates ${parsed.unit.coverage_id}`);
        continue;
      }
      missing.push(parsed.unit);
    }
    const reassign = strings(value.reassign_ids, 2000).filter((id) => {
      if (existing.has(id)) return true;
      problems.push(`reassign_ids: ${id.slice(0, 120)} is not a unit of the ledger`);
      return false;
    });
    const resolved = list(value.resolved_prior_leads)
      .map((r) => (isObj(r) ? { fingerprint: text(r.fingerprint, 200), reason: text(r.reason, 1000) } : { fingerprint: text(r, 200), reason: "" }))
      .filter((r) => r.fingerprint);
    const stop = value.stop === true;
    if (stop && (missing.length > 0 || reassign.length > 0)) problems.push("stop is true while the critic proposes work; the host follows the proposed work");
    const out: CriticValue = { summary: text(value.summary, 4000), agent: ctx.agentId ?? "coverage-critic", missing_units: missing, reassign_ids: reassign, resolved_prior_leads: resolved, stop };
    return { ok: true, problems, value: out as unknown as Record<string, unknown> };
  };
}

// ---- refutation and verification ----------------------------------------------------------------------------------

const evidenceOf = (record: Record<string, unknown>): Evidence[] => ((record.evidence as EvidenceEntry[] | undefined) ?? []).map((e) => ({ path: e.file, line: e.line, note: e.description }));
export const recordOf = (c: Candidate | null): Record<string, unknown> | null => ((c?.details as { record?: Record<string, unknown> } | undefined)?.record ?? null);

export function checkRefutation() {
  return (value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck => {
    const candidate = ctx.candidate;
    const current = recordOf(candidate);
    if (!candidate || !current) return { ok: false, problems: ["the refutation has no candidate record"] };
    const decision = String(value.decision ?? "") as Verdict;
    if (!VERDICTS.includes(decision)) return { ok: false, problems: [`decision must be one of ${VERDICTS.join(", ")}`] };
    const r = checkRecord(value.record, decision, { seen: ctx.seen, lines: ctx.lines });
    if ("problems" in r) return { ok: false, problems: r.problems };
    if (r.record.fingerprint !== current.fingerprint) return { ok: false, problems: [`the record's fingerprint ${String(r.record.fingerprint)} is not the candidate's ${String(current.fingerprint)}: a separate root cause needs its own candidate validation`] };
    const reason = decision === "rejected" ? String(r.record.reason) : decision === "confirmed" ? String(r.record.root_cause) : `blocked: ${(r.record.blockers as string[]).join("; ")}`;
    return {
      ok: true,
      problems: [],
      value: { decision, record: r.record },
      verdict: {
        confirmation: toConfirmation(decision),
        reason,
        evidence: evidenceOf(r.record),
        ...(decision !== "rejected" ? { severity: recordSeverity(r.record) } : {}),
        details: { ...(candidate.details ?? {}), record: r.record, decided_by: ctx.agentId ?? "refutation" },
      },
    };
  };
}

export function checkVerification() {
  return (value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck => {
    const candidate = ctx.candidate;
    const current = recordOf(candidate);
    if (!candidate || !current || !candidate.confirmation) return { ok: false, problems: ["the verification has no decided record"] };
    const decision = String(value.decision ?? "");
    const agent = ctx.agentId ?? "verification";
    if (decision === "verified") {
      if (String(value.fingerprint ?? "") !== current.fingerprint) return { ok: false, problems: [`fingerprint must be ${String(current.fingerprint)}`] };
      const unread = recordFiles(current).filter((f) => !ctx.seen.has(f));
      if (unread.length > 0) return { ok: false, problems: [`verified needs every cited file read in this context; not read: ${unread.join(", ")}`] };
      return {
        ok: true,
        problems: [],
        value: { decision, fingerprint: current.fingerprint, reason: text(value.reason, 2000) },
        verdict: { confirmation: candidate.confirmation, reason: text(value.reason, 2000) || "verified with fresh eyes against the current source", evidence: evidenceOf(current), details: { ...(candidate.details ?? {}), verified_by: agent } },
      };
    }
    if (decision !== "replace") return { ok: false, problems: ["decision must be verified or replace"] };
    const reason = text(value.reason, 2000);
    if (!reason) return { ok: false, problems: ["a replacement needs its reason"] };
    const raw = isObj(value.record) ? value.record : null;
    const verdict = String(raw?.verdict ?? "") as Verdict;
    if (!raw || !VERDICTS.includes(verdict)) return { ok: false, problems: ["a replacement record names its verdict branch"] };
    const { verdict: _v, ...body } = raw;
    const r = checkRecord(body, verdict, { seen: ctx.seen, lines: ctx.lines });
    if ("problems" in r) return { ok: false, problems: r.problems };
    const material = materialChange(current, r.record);
    const sameVerdict = r.record.verdict === current.verdict;
    return {
      ok: true,
      problems: [],
      value: { decision, reason, record: r.record, material },
      verdict: {
        confirmation: toConfirmation(verdict),
        reason,
        evidence: evidenceOf(r.record),
        details: { ...(candidate.details ?? {}), record: r.record, replaced_by: agent, replacement_reason: reason },
        ...(material && sameVerdict ? { disputes: `material replacement: ${material}` } : {}),
      },
    };
  };
}
