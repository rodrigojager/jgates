// The ASVS coverage map: for one ASVS version and level, every requirement in exactly one of five states, built each
// time from the stored runs of a workspace, the reviewed mapping and the project's decisions (ADR-0013). It is never
// stored in a run and never rewrites one, and it calls neither the engine nor git (ADR-0010): the CLI (`jgates coverage
// asvs`) and the server route call `buildAsvsMap` with the same request and get the same map.
//
// Order of the decision for a requirement (PLAN-asvs.md section 5):
//   1. the user recorded "not applicable" (the requirement, its section or its chapter): not applicable;
//   2. a mapped, reviewed check ran to completion in the runs read: examined (deterministic, or AI review only);
//   3. a mapped, reviewed check could run on this project and none ran: unexamined, with the reason of each check;
//   4. the entry says the evidence is a deployed system or a person: awaiting evidence;
//   5. otherwise: unsupported (no reviewed check mapped, or the mapped checks exist only for other stacks). A rule of a
//      language the project is known to lack is not relevant to it (`relevant: false`): the screen and the text leave it
//      out, and when only such rules are mapped the reason names the project's languages instead.
// Examined is not satisfied: the map never claims the project meets the standard, has no percentage and no gate.
import fs from "node:fs";
import path from "node:path";
import { bundledPackRulesDir, buildPackIndex, type PackRule } from "../../../adapters/semgrep/index.js";
import { listRuns } from "../../artifacts/index.js";
import { buildMatrix, type MatrixRow } from "../../matrix/index.js";
import { SECURITY_AUDIT_METHOD } from "../../semantic-modules/cloudflare/index.js";
import { findSemanticRun, listSemanticRuns } from "../../semantic/store.js";
import { translator, type Params } from "../../../i18n/index.js";
import { labelOf } from "../../discovery/vocabulary.js";
import { asvsTree, loadAsvs, ASVS_LEVELS, AsvsDataError, type AsvsData, type AsvsLevel, type AsvsRequirement, type AsvsSource } from "./index.js";
import { asvsMapDir, countedChecks, loadMapping, AsvsMappingError, MAPPING_SUBDIMENSIONS, type AsvsMapping, type MappingCheck, type MappingEntry, type MappingStatus } from "./mapping.js";
import {
  collectCheckUnits,
  readQualityRunRecord,
  readSemanticRunRecord,
  scannedLanguagesOf,
  type CheckUnit,
  type CheckUnitBasis,
  type CheckUnitList,
  type QualityRunRecord,
  type SemanticRunRecord,
  type SkippedRule,
} from "./units.js";
import { DEFAULT_ASVS_LEVEL, DEFAULT_ASVS_VERSION, notApplicableFor, readAsvsDecisions, type AsvsDecisionsRead, type NotApplicableEntry } from "./decisions.js";

const t = translator("coverage");

/** Points the map at another mapping pack folder (holding `<version>/V01.json`...): used by the acceptance tests. */
export const ASVS_MAP_DIR_ENV = "JGATES_ASVS_MAP_DIR";

export const ASVS_STATES = ["examined", "unexamined", "unsupported", "not-applicable", "awaiting-evidence"] as const;
export type AsvsState = (typeof ASVS_STATES)[number];

/** What became of one mapped check in the runs read. `excluded`: a Semantic check left out by "deterministic only". */
export type AsvsCheckStatus = "ran" | "not-run" | "unsupported" | "excluded";

export interface AsvsCheckRow {
  unit: MappingCheck["unit"];
  id: string;
  category?: string;
  covers: string;
  misses: string;
  depth: MappingCheck["depth"];
  basis: CheckUnitBasis;
  status: AsvsCheckStatus;
  ran: boolean;
  /** Why the check has this status (RAN, ERROR, PACK_OTHER_VERSION, NO_SEMANTIC_RUN...). */
  code: string;
  /** The status in words, in the language of the call. */
  reason: string;
  /** What the run itself said (English, as stored), when it said something. */
  detail: string | null;
  runId: string | null;
  /** Served from the cache of results: it ran on the same inputs in an earlier run. */
  reused: boolean;
  /** `semgrep-rule`: the pack language of the rule. */
  language?: string;
  /** Findings of this check left open (not waived) in the run that ran it; null when they cannot be told apart. */
  openFindings: number | null;
  /**
   * False when the check cannot bear on this project at all: a rule of a language the project is known to lack
   * (LANGUAGE_ABSENT). Such a check stays in the JSON but the screen and the text leave it out and count nothing for it.
   */
  relevant: boolean;
}

export interface AsvsRequirementRow {
  id: string;
  chapter: string;
  section: string;
  level: AsvsLevel;
  /** The official text, unchanged and in English. */
  text: string;
  textLanguage: "en";
  state: AsvsState;
  code: string;
  reason: string;
  /** examined: how (a deterministic check, or only an AI review of the source); null otherwise. */
  basis: CheckUnitBasis | null;
  evidence: MappingEntry["evidence"];
  subdimensions: string[];
  /** The status of the mapping entry (`none` when the pack has no entry). */
  review: MappingStatus | "none";
  checks: AsvsCheckRow[];
  /** The user's decision that makes it not applicable, when there is one. */
  decision: (NotApplicableEntry & { scope: "requirement" | "section" | "chapter" }) | null;
}

export interface AsvsTotals {
  rows: number;
  examined: number;
  examinedDeterministic: number;
  examinedAiOnly: number;
  unexamined: number;
  unsupported: number;
  notApplicable: number;
  awaitingEvidence: number;
}

export interface AsvsRunRef {
  runId: string;
  startedAt: string | null;
  /** The commit analyzed (with a marker of uncommitted changes), or null when the run did not record it. */
  revision: string | null;
}

export interface AsvsWarning {
  code: "REVISIONS_DIFFER" | "NO_QUALITY_RUN" | "DECISIONS_INVALID" | "DECISIONS_OTHER_VERSION";
  message: string;
  params: Record<string, string>;
}

export interface AsvsMapAnswer {
  schemaVersion: 1;
  kind: "asvs-coverage-map";
  source: AsvsSource;
  asvsVersion: string;
  level: AsvsLevel;
  /** option: asked for this call only; project: the project's recorded level; default: level 1. */
  levelSource: "option" | "project" | "default";
  deterministicOnly: boolean;
  filters: { state: AsvsState | null; chapter: string | null; subdimension: string | null };
  /** "This map shows what was examined, not whether the project meets the standard." */
  statement: string;
  runs: { quality: AsvsRunRef | null; semantic: Array<AsvsRunRef & { methods: string[] }> };
  warnings: AsvsWarning[];
  decisions: { file: string; exists: boolean; revision: string; level: AsvsLevel | null; notApplicable: number; problem: string | null };
  totals: AsvsTotals;
  chapters: Array<{ id: string; name: string; totals: AsvsTotals; sections: Array<{ id: string; name: string; totals: AsvsTotals }> }>;
  requirements: AsvsRequirementRow[];
}

export type AsvsMapCode =
  | "ASVS_RUN_NOT_FOUND"
  | "ASVS_SEMANTIC_RUN_NOT_FOUND"
  | "ASVS_DATA_MISSING"
  | "ASVS_MAPPING_MISSING"
  | "ASVS_LEVEL_INVALID"
  | "ASVS_STATE_INVALID"
  | "ASVS_CHAPTER_UNKNOWN"
  | "ASVS_SUBDIMENSION_UNKNOWN"
  | "ASVS_DECISIONS_UNSAFE";

export interface AsvsMapRefusal {
  ok: false;
  code: AsvsMapCode;
  message: string;
  details: Record<string, string>;
}

const refuse = (code: AsvsMapCode, message: string, details: Record<string, string> = {}): AsvsMapRefusal => ({ ok: false, code, message, details });

// ---- small readers ----------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** The revision a stored run analyzed: the commit of its source identity (run.json), else of its analysis record. */
export function runRevision(dir: string | null, result: unknown): string | null {
  const identity = dir ? readJson(path.join(dir, "run.json")) : null;
  const source = isObj(identity) && isObj(identity.source) ? identity.source : null;
  if (source && str(source.commit)) {
    const dirtyHash = str(source.dirtyContentHash);
    return `${str(source.commit)}${dirtyHash ? `+${dirtyHash.replace(/^sha256:/, "").slice(0, 12)}` : source.dirty === true ? "+dirty" : ""}`;
  }
  const analyzed = isObj(result) && isObj(result.analyzed) ? result.analyzed : null;
  if (analyzed) {
    const snapshot = isObj(analyzed.snapshot) ? analyzed.snapshot : {};
    const git = isObj(analyzed.git) ? analyzed.git : {};
    const commit = str(snapshot.commit) ?? str(git.head);
    if (commit) return `${commit}${analyzed.dirty === true ? "+dirty" : ""}`;
  }
  return null;
}

// ---- which runs the map reads -----------------------------------------------------------------------------------

export interface AsvsRunSelection {
  quality: { runId: string; dir: string } | null;
  semantic: Array<{ runId: string; dir: string; methods: string[] }>;
}

/**
 * The runs of a workspace the map reads: the named Quality run, else the last finished one; the named Semantic runs,
 * else the last finished run of each Semantic method.
 */
export function selectAsvsRuns(home: string, workspaceId: string, request: { runId?: string; semanticRunIds?: readonly string[] }): AsvsRunSelection | AsvsMapRefusal {
  const runs = listRuns(home, workspaceId);
  let quality: AsvsRunSelection["quality"] = null;
  if (request.runId) {
    const hit = runs.find((r) => r.runId === request.runId);
    if (!hit) return refuse("ASVS_RUN_NOT_FOUND", `run ${request.runId} was not found in this workspace`, { runId: request.runId });
    quality = { runId: hit.runId, dir: hit.dir };
  } else {
    const hit = runs.find((r) => !r.partial && r.decision !== null);
    if (hit) quality = { runId: hit.runId, dir: hit.dir };
  }
  const semantic: AsvsRunSelection["semantic"] = [];
  if (request.semanticRunIds && request.semanticRunIds.length > 0) {
    for (const id of request.semanticRunIds) {
      const hit = findSemanticRun(home, workspaceId, id);
      if (!hit) return refuse("ASVS_SEMANTIC_RUN_NOT_FOUND", `Semantic run ${id} was not found in this workspace`, { runId: id });
      if (!semantic.some((s) => s.runId === hit.runId)) semantic.push({ runId: hit.runId, dir: hit.dir, methods: hit.methods });
    }
  } else {
    const covered = new Set<string>();
    for (const run of listSemanticRuns(home, workspaceId)) {
      if (run.partial) continue;
      const fresh = run.methods.filter((m) => !covered.has(m));
      if (fresh.length === 0) continue;
      for (const m of fresh) covered.add(m);
      semantic.push({ runId: run.runId, dir: run.dir, methods: run.methods });
    }
  }
  return { quality, semantic };
}

// ---- evaluating one mapped check --------------------------------------------------------------------------------

interface Context {
  units: CheckUnitList;
  quality: QualityRunRecord | null;
  semantic: SemanticRunRecord[];
  rules: Map<string, PackRule>;
  /** `<adapter>#<capability>` to the stacks of its validated matrix rows. */
  validated: Map<string, Set<string>>;
  /** The languages the Quality run saw in the project (plan items and the scanned-languages record); null when unknown. */
  languages: Set<string> | null;
  deterministicOnly: boolean;
}

/** Whether the project has files of a pack language (`javascript` also serves TypeScript). */
function hasPackLanguage(languages: Set<string>, language: string): boolean {
  if (language === "javascript") return languages.has("javascript") || languages.has("typescript");
  return languages.has(language);
}

function projectLanguages(quality: QualityRunRecord | null): Set<string> | null {
  if (!quality) return null;
  const out = new Set<string>();
  let known = false;
  const plan = isObj(quality.plan) ? quality.plan : null;
  const groups = plan && isObj(plan.groups) ? plan.groups : null;
  if (groups) {
    known = true;
    for (const item of [...objs(groups.willRun), ...objs(groups.notApplicableOrDisabled)]) for (const l of strs(item.languages)) out.add(l);
  }
  const result = isObj(quality.result) ? quality.result : {};
  for (const stage of objs(result.stages)) {
    const scanned = scannedLanguagesOf(stage);
    if (!scanned) continue;
    known = true;
    for (const [language, files] of Object.entries(scanned)) if (files > 0) out.add(language);
  }
  return known ? out : null;
}

const checkMessage = (code: string, params: Params): string => {
  const key = `coverage_check_${code.toLowerCase()}`;
  const out = t(key, params);
  return out === key ? t("coverage_check_other", { code, detail: String(params.detail ?? code) }) : out;
};

/** A completed unit first, else the one of the newest run (the list is in run order: Quality, then Semantic newest first). */
const pick = (units: CheckUnit[]): CheckUnit | undefined => units.find((u) => u.state === "completed") ?? units[0];

function openFindingsOf(check: MappingCheck, unit: CheckUnit, ctx: Context): number | null {
  if (unit.run.gate === "quality") {
    const result = ctx.quality && isObj(ctx.quality.result) ? ctx.quality.result : {};
    const findings = objs(result.findings).filter((f) => f.waived !== true);
    if (check.unit === "semgrep-rule") return findings.filter((f) => f.stageId === unit.stageId && typeof f.ruleId === "string" && (f.ruleId === check.id || f.ruleId.endsWith(`.${check.id}`))).length;
    return findings.filter((f) => f.stageId === unit.stageId).length;
  }
  if (check.unit !== "semantic-method") return null;
  const record = ctx.semantic.find((s) => s.runId === unit.run.runId);
  const result = record && isObj(record.result) ? record.result : null;
  const semanticRun = result && isObj(result.semanticRun) ? result.semanticRun : null;
  // A Semantic finding does not name its method: it can be told apart only in a run of one method.
  if (!result || !semanticRun || strs(semanticRun.methods).length !== 1) return null;
  return objs(result.findings).filter((f) => f.waived !== true).length;
}

interface Evaluated {
  status: AsvsCheckStatus;
  code: string;
  detail: string | null;
  params: Params;
  unit?: CheckUnit;
  language?: string;
}

function evaluateCapability(check: MappingCheck, ctx: Context): Evaluated {
  const stacks = ctx.validated.get(check.id) ?? new Set<string>();
  const units = ctx.units.units.filter((u) => u.unit === "capability" && u.id === check.id);
  const stackOk = (languages: string[]): boolean => stacks.has("any") || languages.some((l) => stacks.has(l));
  const stackList = [...stacks].sort().join(", ") || "-";
  const completed = units.find((u) => u.state === "completed");
  if (completed) {
    const languages = completed.languages && completed.languages.length > 0 ? completed.languages : [...(ctx.languages ?? [])];
    if (stackOk(languages)) return { status: "ran", code: completed.reused ? "RAN_REUSED" : "RAN", detail: null, params: { run: completed.run.runId }, unit: completed };
    return { status: "unsupported", code: "NOT_VALIDATED_FOR_STACK", detail: null, params: { stacks: stackList }, unit: completed };
  }
  const unit = units[0];
  if (unit) {
    if (unit.state === "not-applicable") return { status: "unsupported", code: unit.code ?? "NOT_APPLICABLE", detail: unit.reason, params: { detail: unit.reason ?? "" }, unit };
    return { status: "not-run", code: unit.code ?? "NOT_FINISHED", detail: unit.reason, params: { detail: unit.reason ?? "" }, unit };
  }
  if (stacks.size === 0) return { status: "unsupported", code: "NO_VALIDATED_ROW", detail: null, params: { stacks: stackList } };
  if (!ctx.quality) return { status: "not-run", code: "NO_QUALITY_RUN", detail: null, params: {} };
  if (ctx.languages !== null && !stacks.has("any") && ![...ctx.languages].some((l) => stacks.has(l))) return { status: "unsupported", code: "NO_VALIDATED_ROW", detail: null, params: { stacks: stackList } };
  return { status: "not-run", code: "NOT_IN_PLAN", detail: null, params: {} };
}

function evaluateRule(check: MappingCheck, ctx: Context): Evaluated {
  const rule = ctx.rules.get(check.id);
  if (!rule) return { status: "unsupported", code: "UNKNOWN_RULE", detail: null, params: {} };
  const language = rule.language;
  const lacks = ctx.languages !== null && !hasPackLanguage(ctx.languages, language);
  const unit = ctx.units.units.find((u) => u.unit === "semgrep-rule" && u.id === check.id && u.state === "completed");
  if (unit) return { status: "ran", code: unit.reused ? "RAN_REUSED" : "RAN", detail: null, params: { run: unit.run.runId }, unit, language };
  const skipped: SkippedRule | undefined = ctx.units.skippedRules.find((s) => s.id === check.id);
  if (skipped) {
    // The scan covered no file of the language: a language the project lacks altogether is absent, not unscanned.
    if (skipped.code === "LANGUAGE_NOT_SCANNED" && lacks) return { status: "unsupported", code: "LANGUAGE_ABSENT", detail: null, params: { language }, language };
    if (skipped.code === "LANGUAGE_NOT_SCANNED") return { status: "unsupported", code: skipped.code, detail: skipped.reason, params: { language, detail: skipped.reason }, language };
    if (lacks) return { status: "unsupported", code: "LANGUAGE_ABSENT", detail: null, params: { language }, language };
    return { status: "not-run", code: skipped.code, detail: skipped.reason, params: { language, detail: skipped.reason }, language };
  }
  if (!ctx.quality) return { status: "not-run", code: "NO_QUALITY_RUN", detail: null, params: {}, language };
  if (lacks) return { status: "unsupported", code: "LANGUAGE_ABSENT", detail: null, params: { language }, language };
  return { status: "not-run", code: "NOT_IN_PLAN", detail: null, params: {}, language };
}

function evaluateLedger(check: MappingCheck, ctx: Context): Evaluated {
  const unit = ctx.units.units.find((u) => u.unit === "semantic-ledger" && u.id === check.id && u.state === "completed");
  if (unit) return { status: "ran", code: "RAN", detail: null, params: { run: unit.run.runId }, unit };
  const method = pick(ctx.units.units.filter((u) => u.unit === "semantic-method" && u.id === SECURITY_AUDIT_METHOD && u.category === undefined));
  if (method?.state === "completed") return { status: "not-run", code: "BLOCK_NOT_EXAMINED", detail: null, params: {}, unit: method };
  if (method) return { status: "not-run", code: method.code ?? "NOT_REVIEWED", detail: method.reason, params: { detail: method.reason ?? "" }, unit: method };
  return { status: "not-run", code: "NO_SEMANTIC_RUN", detail: null, params: { method: SECURITY_AUDIT_METHOD } };
}

function evaluateMethod(check: MappingCheck, ctx: Context): Evaluated {
  const unit = pick(ctx.units.units.filter((u) => u.unit === "semantic-method" && u.id === check.id && u.category === check.category));
  if (!unit) return { status: "not-run", code: "NO_SEMANTIC_RUN", detail: null, params: { method: check.id } };
  if (unit.state === "completed") return { status: "ran", code: "RAN", detail: null, params: { run: unit.run.runId }, unit };
  if (unit.state === "not-applicable") return { status: "unsupported", code: unit.code ?? "NOT_APPLICABLE", detail: unit.reason, params: { detail: unit.reason ?? "" }, unit };
  return { status: "not-run", code: unit.code ?? "NOT_REVIEWED", detail: unit.reason, params: { detail: unit.reason ?? "" }, unit };
}

function evaluateCheck(check: MappingCheck, ctx: Context): AsvsCheckRow {
  const semantic = check.unit === "semantic-ledger" || check.unit === "semantic-method";
  const basis: CheckUnitBasis = semantic ? "ai-source-review" : "deterministic";
  let e: Evaluated;
  if (semantic && ctx.deterministicOnly) e = { status: "excluded", code: "DETERMINISTIC_ONLY", detail: null, params: {} };
  else if (check.unit === "capability") e = evaluateCapability(check, ctx);
  else if (check.unit === "semgrep-rule") e = evaluateRule(check, ctx);
  else if (check.unit === "semantic-ledger") e = evaluateLedger(check, ctx);
  else if (check.unit === "semantic-method") e = evaluateMethod(check, ctx);
  else e = { status: "unsupported", code: "UNKNOWN_UNIT", detail: null, params: {} };
  const ran = e.status === "ran";
  return {
    unit: check.unit,
    id: check.id,
    ...(check.category !== undefined ? { category: check.category } : {}),
    covers: check.covers,
    misses: check.misses,
    depth: check.depth,
    basis,
    status: e.status,
    ran,
    code: e.code,
    reason: checkMessage(e.code, e.params),
    detail: e.detail,
    runId: e.unit?.run.runId ?? null,
    reused: ran && e.unit?.reused === true,
    ...(e.language !== undefined ? { language: e.language } : {}),
    openFindings: ran && e.unit ? openFindingsOf(check, e.unit, ctx) : null,
    relevant: e.code !== "LANGUAGE_ABSENT",
  };
}

/** The display name of a language (a JavaScript pack rule also serves TypeScript). */
const languageLabel = (language: string): string => (language === "javascript" ? "JavaScript/TypeScript" : labelOf(language));
const languageList = (languages: Iterable<string>, label: (language: string) => string): string =>
  [...new Set([...languages].map(label))].sort((a, b) => a.localeCompare(b, "en")).join(", ");

// ---- one requirement --------------------------------------------------------------------------------------------

const checkName = (c: AsvsCheckRow): string => (c.category ? `${c.id} (${c.category})` : c.id);

function decideRequirement(requirement: AsvsRequirement, entry: MappingEntry | undefined, decisions: readonly NotApplicableEntry[], ctx: Context): AsvsRequirementRow {
  const checks = entry ? countedChecks(entry).map((c) => evaluateCheck(c, ctx)) : [];
  const na = notApplicableFor(decisions, requirement);
  const base = {
    id: requirement.id,
    chapter: requirement.chapter,
    section: requirement.section,
    level: requirement.level,
    text: requirement.text,
    textLanguage: "en" as const,
    evidence: entry?.evidence ?? null,
    subdimensions: entry?.subdimensions ?? [],
    review: entry?.status ?? ("none" as const),
    checks,
    decision: na ? { ...na, scope: na.id === requirement.id ? ("requirement" as const) : na.id === requirement.section ? ("section" as const) : ("chapter" as const) } : null,
  };
  if (na) return { ...base, state: "not-applicable", code: "NOT_APPLICABLE_RECORDED", reason: t("coverage_reason_not_applicable", { target: na.id, reason: na.reason, recorded: na.recorded || "-" }), basis: null };
  const ran = checks.filter((c) => c.ran);
  if (ran.length > 0) {
    const deterministic = ran.filter((c) => c.basis === "deterministic");
    const names = ran.map(checkName).join(", ");
    if (deterministic.length > 0) return { ...base, state: "examined", code: "EXAMINED", reason: t("coverage_reason_examined", { checks: names }), basis: "deterministic" };
    return { ...base, state: "examined", code: "EXAMINED_AI_ONLY", reason: t("coverage_reason_examined_ai", { checks: names }), basis: "ai-source-review" };
  }
  const couldRun = checks.filter((c) => c.status === "not-run" || c.status === "excluded");
  if (couldRun.length > 0) {
    const details = couldRun.map((c) => `${checkName(c)}: ${c.reason}`).join("; ");
    return { ...base, state: "unexamined", code: "UNEXAMINED", reason: t("coverage_reason_unexamined", { details }), basis: null };
  }
  if (entry?.evidence === "deployment") return { ...base, state: "awaiting-evidence", code: "AWAITING_DEPLOYMENT", reason: t("coverage_reason_awaiting_deployment"), basis: null };
  if (entry?.evidence === "person") return { ...base, state: "awaiting-evidence", code: "AWAITING_PERSON", reason: t("coverage_reason_awaiting_person"), basis: null };
  // Checks of a language the project lacks bear on nothing here: they are left out of the reason, which names the
  // project's languages and the languages the checks exist for instead of listing them one by one.
  const relevant = checks.filter((c) => c.relevant);
  if (relevant.length > 0) {
    const details = relevant.map((c) => `${checkName(c)}: ${c.reason}`).join("; ");
    return { ...base, state: "unsupported", code: "UNSUPPORTED_OTHER_STACKS", reason: t("coverage_reason_unsupported_other_stacks", { details }), basis: null };
  }
  if (checks.length > 0) {
    const others = languageList(checks.map((c) => c.language).filter((l): l is string => l !== undefined), languageLabel);
    const languages = languageList(ctx.languages ?? [], labelOf);
    const reason = languages ? t("coverage_reason_unsupported_no_check_for_languages", { languages, others }) : t("coverage_reason_unsupported_no_check_for_no_languages", { others });
    return { ...base, state: "unsupported", code: "UNSUPPORTED_NO_CHECK_FOR_LANGUAGES", reason, basis: null };
  }
  if (entry?.status === "pending") return { ...base, state: "unsupported", code: "UNSUPPORTED_PENDING_REVIEW", reason: t("coverage_reason_unsupported_pending"), basis: null };
  return { ...base, state: "unsupported", code: "UNSUPPORTED_NO_CHECK", reason: t("coverage_reason_unsupported_no_check"), basis: null };
}

// ---- the whole map ----------------------------------------------------------------------------------------------

const emptyTotals = (): AsvsTotals => ({ rows: 0, examined: 0, examinedDeterministic: 0, examinedAiOnly: 0, unexamined: 0, unsupported: 0, notApplicable: 0, awaitingEvidence: 0 });

function totalsOf(rows: readonly AsvsRequirementRow[]): AsvsTotals {
  const out = emptyTotals();
  for (const r of rows) {
    out.rows++;
    if (r.state === "examined") {
      out.examined++;
      if (r.basis === "deterministic") out.examinedDeterministic++;
      else out.examinedAiOnly++;
    } else if (r.state === "unexamined") out.unexamined++;
    else if (r.state === "unsupported") out.unsupported++;
    else if (r.state === "not-applicable") out.notApplicable++;
    else out.awaitingEvidence++;
  }
  return out;
}

export interface ResolveAsvsInput {
  data: AsvsData;
  mapping: AsvsMapping;
  quality: QualityRunRecord | null;
  /** Semantic runs, newest first. */
  semantic: readonly SemanticRunRecord[];
  /** The revision each run analyzed (by run id), when known. */
  revisions?: Readonly<Record<string, string | null>>;
  /** When each run started (by run id), when known. */
  startedAt?: Readonly<Record<string, string | null>>;
  decisions: Pick<AsvsDecisionsRead, "file" | "exists" | "revision" | "version" | "level" | "notApplicable" | "problem"> | null;
  /** The level of this call; absent: the project's level, else level 1. */
  level?: AsvsLevel;
  deterministicOnly?: boolean;
  state?: AsvsState;
  chapter?: string;
  subdimension?: string;
  /** The rules folder of the JGates Semgrep pack; defaults to the pack of this installation. */
  rulesDir?: string | null;
  /** The matrix rows to judge capabilities by; defaults to the matrix of this installation. */
  matrixRows?: readonly MatrixRow[];
}

/** The map, from records already read. Pure over its input (plus the pack's rule files, to compare hashes). */
export function resolveAsvsMap(input: ResolveAsvsInput): AsvsMapAnswer {
  const { data, mapping } = input;
  const decisions = input.decisions;
  const usableDecisions = decisions && !decisions.problem && decisions.version === data.version ? decisions : null;
  const level: AsvsLevel = input.level ?? usableDecisions?.level ?? DEFAULT_ASVS_LEVEL;
  const levelSource: AsvsMapAnswer["levelSource"] = input.level !== undefined ? "option" : usableDecisions?.level ? "project" : "default";
  const deterministicOnly = input.deterministicOnly === true;

  const rulesDir = input.rulesDir === undefined ? bundledPackRulesDir("jgates") : input.rulesDir;
  const rules = new Map<string, PackRule>();
  if (rulesDir && fs.existsSync(rulesDir)) for (const rule of buildPackIndex(rulesDir).rules) rules.set(rule.id, rule);
  const validated = new Map<string, Set<string>>();
  for (const row of input.matrixRows ?? buildMatrix().rows) {
    if (row.state !== "validated") continue;
    const key = `${row.adapter}#${row.capability}`;
    if (!validated.has(key)) validated.set(key, new Set());
    validated.get(key)!.add(row.stack);
  }
  const units = collectCheckUnits({ quality: input.quality, semantic: input.semantic, ...(input.rulesDir !== undefined ? { rulesDir: input.rulesDir } : {}) });
  const ctx: Context = { units, quality: input.quality, semantic: [...input.semantic], rules, validated, languages: projectLanguages(input.quality), deterministicOnly };

  const entries = new Map(mapping.entries.map((e) => [e.requirement, e]));
  const notApplicable = usableDecisions?.notApplicable ?? [];
  const tree = asvsTree(data, { level, ...(input.chapter ? { chapter: input.chapter } : {}) });
  const chapters: AsvsMapAnswer["chapters"] = [];
  const all: AsvsRequirementRow[] = [];
  for (const chapter of tree) {
    const sections: AsvsMapAnswer["chapters"][number]["sections"] = [];
    const chapterRows: AsvsRequirementRow[] = [];
    for (const section of chapter.sections) {
      const rows = section.requirements
        .map((r) => decideRequirement(r, entries.get(r.id), notApplicable, ctx))
        .filter((r) => !input.subdimension || r.subdimensions.includes(input.subdimension));
      if (rows.length === 0) continue;
      sections.push({ id: section.id, name: section.name, totals: totalsOf(rows) });
      chapterRows.push(...rows);
    }
    if (chapterRows.length === 0) continue;
    chapters.push({ id: chapter.id, name: chapter.name, totals: totalsOf(chapterRows), sections });
    all.push(...chapterRows);
  }

  const revisions = input.revisions ?? {};
  const startedAt = input.startedAt ?? {};
  const resultStart = (result: unknown): string | null => (isObj(result) ? str(result.startedAt) : null);
  const quality: AsvsRunRef | null = input.quality
    ? { runId: input.quality.runId, startedAt: startedAt[input.quality.runId] ?? resultStart(input.quality.result), revision: revisions[input.quality.runId] ?? null }
    : null;
  const semantic = input.semantic.map((s) => {
    const result = isObj(s.result) ? s.result : {};
    const semanticRun = isObj(result.semanticRun) ? result.semanticRun : {};
    return { runId: s.runId, startedAt: startedAt[s.runId] ?? resultStart(result), revision: revisions[s.runId] ?? null, methods: strs(semanticRun.methods) };
  });

  const warnings: AsvsWarning[] = [];
  const warn = (code: AsvsWarning["code"], params: Record<string, string>): void => {
    warnings.push({ code, message: t(`coverage_warning_${code.toLowerCase()}`, params), params });
  };
  if (!quality) warn("NO_QUALITY_RUN", {});
  if (quality?.revision) {
    for (const s of semantic) {
      if (s.revision && s.revision !== quality.revision) warn("REVISIONS_DIFFER", { qualityRun: quality.runId, qualityRevision: quality.revision, semanticRun: s.runId, semanticRevision: s.revision });
    }
  }
  if (decisions?.problem) warn("DECISIONS_INVALID", { file: decisions.file, problem: decisions.problem.message });
  else if (decisions && decisions.exists && decisions.version !== data.version) warn("DECISIONS_OTHER_VERSION", { file: decisions.file, version: decisions.version, asvsVersion: data.version });

  return {
    schemaVersion: 1,
    kind: "asvs-coverage-map",
    source: data.source,
    asvsVersion: data.version,
    level,
    levelSource,
    deterministicOnly,
    filters: { state: input.state ?? null, chapter: input.chapter ?? null, subdimension: input.subdimension ?? null },
    statement: t("coverage_statement"),
    runs: { quality, semantic },
    warnings,
    decisions: {
      file: decisions?.file ?? ".jgates/asvs.json",
      exists: decisions?.exists ?? false,
      revision: decisions?.revision ?? "absent",
      level: usableDecisions?.level ?? null,
      notApplicable: notApplicable.length,
      problem: decisions?.problem?.message ?? null,
    },
    totals: totalsOf(all),
    chapters,
    requirements: input.state ? all.filter((r) => r.state === input.state) : all,
  };
}

export interface AsvsMapRequest {
  home: string;
  workspaceId: string;
  /** The project folder, where `.jgates/asvs.json` lives. */
  projectDir: string;
  level?: unknown;
  runId?: string;
  semanticRunIds?: readonly string[];
  state?: unknown;
  chapter?: string;
  subdimension?: string;
  deterministicOnly?: boolean;
  /** The ASVS version; defaults to the project's, else the default version. */
  version?: string;
  /** The mapping pack folder; defaults to JGATES_ASVS_MAP_DIR, else the pack of this installation. */
  mappingDir?: string;
}

/** Validates a level given as text or number. */
export function parseAsvsLevel(value: unknown): AsvsLevel | null {
  const n = typeof value === "string" && /^\s*[123]\s*$/.test(value) ? Number(value) : value;
  return (ASVS_LEVELS as readonly unknown[]).includes(n) ? (n as AsvsLevel) : null;
}

/**
 * The map of a workspace for one request: reads the stored runs, the mapping and the project's decisions, and resolves.
 * Reads only stored files; never calls the engine or git; never writes.
 */
export function buildAsvsMap(request: AsvsMapRequest): AsvsMapAnswer | AsvsMapRefusal {
  let level: AsvsLevel | undefined;
  if (request.level !== undefined) {
    const parsed = parseAsvsLevel(request.level);
    if (parsed === null) return refuse("ASVS_LEVEL_INVALID", "the level must be 1, 2 or 3", { level: String(request.level) });
    level = parsed;
  }
  let state: AsvsState | undefined;
  if (request.state !== undefined) {
    if (!(ASVS_STATES as readonly unknown[]).includes(request.state)) return refuse("ASVS_STATE_INVALID", `the state must be one of ${ASVS_STATES.join(", ")}`, { state: String(request.state) });
    state = request.state as AsvsState;
  }
  if (request.subdimension !== undefined && !(MAPPING_SUBDIMENSIONS as readonly string[]).includes(request.subdimension)) {
    return refuse("ASVS_SUBDIMENSION_UNKNOWN", `the subdimension must be one of ${MAPPING_SUBDIMENSIONS.join(", ")}`, { subdimension: request.subdimension });
  }
  const read = readAsvsDecisions(request.projectDir);
  if ("code" in read) return refuse("ASVS_DECISIONS_UNSAFE", read.message, { detail: read.message });
  const version = request.version ?? (read.problem ? DEFAULT_ASVS_VERSION : read.version) ?? DEFAULT_ASVS_VERSION;
  let data: AsvsData;
  try {
    data = loadAsvs(version);
  } catch (error) {
    if (error instanceof AsvsDataError && version !== DEFAULT_ASVS_VERSION && request.version === undefined) data = loadAsvs(DEFAULT_ASVS_VERSION);
    else return refuse("ASVS_DATA_MISSING", (error as Error).message, { version });
  }
  const chapter = request.chapter?.trim().replace(/^v/, "V");
  if (chapter && !data.chapters.some((c) => c.id === chapter)) return refuse("ASVS_CHAPTER_UNKNOWN", `ASVS ${data.version} has no chapter ${chapter}`, { chapter });
  let mapping: AsvsMapping;
  try {
    const dir = request.mappingDir ?? (process.env[ASVS_MAP_DIR_ENV]?.trim() || asvsMapDir());
    mapping = loadMapping(data.version, dir);
  } catch (error) {
    if (error instanceof AsvsMappingError) return refuse("ASVS_MAPPING_MISSING", error.message, { detail: error.message });
    throw error;
  }
  const selection = selectAsvsRuns(request.home, request.workspaceId, { ...(request.runId ? { runId: request.runId } : {}), ...(request.semanticRunIds ? { semanticRunIds: request.semanticRunIds } : {}) });
  if ("code" in selection) return selection;
  const quality = selection.quality ? readQualityRunRecord(selection.quality.dir) : null;
  const semantic = selection.semantic.map((s) => ({ s, record: readSemanticRunRecord(s.dir) })).filter((x): x is { s: (typeof selection.semantic)[number]; record: SemanticRunRecord } => x.record !== null);
  const revisions: Record<string, string | null> = {};
  if (quality && selection.quality) revisions[quality.runId] = runRevision(selection.quality.dir, quality.result);
  for (const { s, record } of semantic) revisions[record.runId] = runRevision(s.dir, record.result);
  return resolveAsvsMap({
    data,
    mapping,
    quality,
    semantic: semantic.map((x) => x.record),
    revisions,
    decisions: read,
    ...(level !== undefined ? { level } : {}),
    deterministicOnly: request.deterministicOnly === true,
    ...(state ? { state } : {}),
    ...(chapter ? { chapter } : {}),
    ...(request.subdimension ? { subdimension: request.subdimension } : {}),
  });
}
