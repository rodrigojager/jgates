// What ran: the check units of a stored Quality run and of stored Semantic runs, as one list with the state of each
// unit and, for a unit that did not run, why. This is the evidence the ASVS map reads (ADR-0013: a unit counts only
// when it ran); it decides no requirement and no state of the map. It reads stored files only and never calls the
// engine or git (ADR-0010).
//
// Units:
// - `capability`: one per Quality stage (and per plan item that did not run), `<adapter>#<capability>`.
// - `semgrep-rule`: one rule of the bundled JGates pack, only when it really ran: the Semgrep stage completed and was
//   interpreted, the pack was selected, the rule file recorded in the run's plan has the hash of the file in this
//   JGates, and the stage's scanned-languages record shows at least one file of the rule's language. Any other rule
//   gives no unit, only an entry of `skippedRules` with the reason (so a reader can say "validate again").
// - `semantic-ledger`: one attack-class block of a security-audit run whose ledger is valid, only when at least one
//   ledger unit of that block is `examined`; pending, unsupported, not applicable and out of scope give nothing.
// - `semantic-method`: one Semantic method run (and, for insecure-defaults, one per category of its record).
//
// The scanned-languages record (PLAN-semgrep-pack.md section 3) is the optional field `scannedLanguages` of the
// Semgrep stage: how many files of each language the scan covered, `{ "<language>": <files> }`, the language being
// the pack language (`javascript`, `python`, `go`, `csharp`, `rust`, `java`, `php`) or a Semgrep language name.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BUNDLED_RULE_PACKS, bundledPackRulesDir, buildPackIndex, semgrepManifest, type PackRule } from "../../../adapters/semgrep/index.js";
import { INSECURE_CATEGORY_IDS } from "../../semantic-modules/complementary/vendor.js";
import { DEFAULTS_FILE, INSECURE_DEFAULTS_METHOD } from "../../semantic-modules/insecure-defaults/index.js";
import { SECURITY_AUDIT_METHOD } from "../../semantic-modules/cloudflare/index.js";
import { validateLedger, type LedgerUnit } from "../../semantic-modules/cloudflare/ledger.js";
import { LEDGER_FILE } from "../../semantic-modules/cloudflare/prior.js";
import type { MappingUnit } from "./mapping.js";

export const CHECK_UNIT_STATES = ["completed", "off", "error", "timed-out", "blocked", "not-selected", "not-applicable"] as const;
export type CheckUnitState = (typeof CHECK_UNIT_STATES)[number];

/** How a unit examined the code: a deterministic tool, or a model reading the source. */
export type CheckUnitBasis = "deterministic" | "ai-source-review";
/** The words of each basis (the map shows them; a Semantic unit always says "AI review of the source"). */
export const CHECK_UNIT_BASIS_LABELS: Readonly<Record<CheckUnitBasis, string>> = {
  deterministic: "deterministic check",
  "ai-source-review": "AI review of the source",
};

export interface CheckUnitRun {
  gate: "quality" | "semantic";
  runId: string;
}

export interface CheckUnit {
  unit: MappingUnit;
  /** `<adapter>#<capability>`, a rule id, an attack-class block `FILE.md#Class`, or a Semantic method id. */
  id: string;
  /** `semantic-method` of insecure-defaults: the category. */
  category?: string;
  state: CheckUnitState;
  /** Why the unit did not run (or what limited it); null when it completed. */
  code: string | null;
  reason: string | null;
  basis: CheckUnitBasis;
  run: CheckUnitRun;
  /** Quality units: the stage (or plan item) the unit comes from, the tool instance and the languages it covered. */
  stageId?: string;
  tool?: string;
  languages?: string[];
  /** Served from the cache of results: it ran on the same inputs in an earlier run. */
  reused?: boolean;
  /** `semgrep-rule`: the pack language of the rule, the files of that language the scan covered, the rule file. */
  language?: string;
  scannedFiles?: number;
  ruleFile?: string;
  /** `semantic-ledger`: how many ledger units of the block were examined. */
  examinedUnits?: number;
}

export const RULE_SKIP_CODES = ["PLAN_MISSING", "STAGE_NOT_COMPLETED", "PACK_NOT_SELECTED", "PACK_OTHER_VERSION", "NO_SCANNED_LANGUAGES", "LANGUAGE_NOT_SCANNED"] as const;
export type RuleSkipCode = (typeof RULE_SKIP_CODES)[number];

/** A rule of the pack that gives no unit in a Semgrep stage, and why. */
export interface SkippedRule {
  id: string;
  language: string;
  run: CheckUnitRun;
  stageId: string;
  code: RuleSkipCode;
  reason: string;
}

export interface CheckUnitList {
  runs: CheckUnitRun[];
  units: CheckUnit[];
  skippedRules: SkippedRule[];
}

/** A stored Quality run: its result.json and its plan.json (null when the run stored no plan). */
export interface QualityRunRecord {
  runId: string;
  result: unknown;
  plan: unknown;
}

/** A stored Semantic run: its result.json and the method records the units are read from. */
export interface SemanticRunRecord {
  runId: string;
  result: unknown;
  /** evidence/security-audit/coverage-ledger.json, when present. */
  ledger: unknown;
  /** evidence/insecure-defaults/defaults.json, when present. */
  defaults: unknown;
}

export interface CheckUnitsInput {
  quality?: QualityRunRecord | null;
  semantic?: readonly SemanticRunRecord[];
  /** The rules folder of the JGates pack to compare with; defaults to the pack of this installation. */
  rulesDir?: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
};

/** Reads a stored Quality run folder (result.json and plan.json); null when it has no readable result. */
export function readQualityRunRecord(dir: string): QualityRunRecord | null {
  const result = readJson(path.join(dir, "result.json"));
  if (!isObj(result)) return null;
  return { runId: str(result.runId) ?? path.basename(dir), result, plan: readJson(path.join(dir, "plan.json")) };
}

/** Reads a stored Semantic run folder (result.json and the method records); null when it has no readable result. */
export function readSemanticRunRecord(dir: string): SemanticRunRecord | null {
  const result = readJson(path.join(dir, "result.json"));
  if (!isObj(result)) return null;
  return {
    runId: str(result.runId) ?? path.basename(dir),
    result,
    ledger: readJson(path.join(dir, ...LEDGER_FILE.split("/"))),
    defaults: readJson(path.join(dir, ...DEFAULTS_FILE.split("/"))),
  };
}

/** The scanned-languages record of a stage (`{ language: files }`), or null when the stage has none. */
export function scannedLanguagesOf(stage: unknown): Record<string, number> | null {
  if (!isObj(stage)) return null;
  const raw = stage.scannedLanguages;
  const out: Record<string, number> = {};
  if (isObj(raw)) {
    for (const [language, files] of Object.entries(raw)) if (typeof files === "number" && Number.isFinite(files)) out[language] = files;
    return out;
  }
  if (Array.isArray(raw)) {
    for (const entry of objs(raw)) {
      const language = str(entry.language);
      if (language && typeof entry.files === "number" && Number.isFinite(entry.files)) out[language] = (out[language] ?? 0) + entry.files;
    }
    return out;
  }
  return null;
}

/** Files of the rule's language that a scan covered: the pack language, or any Semgrep language of the rule. */
function filesOfRule(rule: PackRule, scanned: Record<string, number>): number {
  return Math.max(0, scanned[rule.language] ?? 0, ...rule.languages.map((l) => scanned[l] ?? 0));
}

const capabilityOf = (id: string): string | null => {
  const at = id.lastIndexOf("#");
  return at > 0 && at < id.length - 1 ? id.slice(at + 1) : null;
};

/** The state of a stored stage as a unit state; a completed stage proves something only when its output was interpreted. */
function stageUnitState(stage: Obj): { state: CheckUnitState; code: string | null; reason: string | null } {
  const reason = str(stage.reason);
  switch (stage.state) {
    case "completed":
      if (stage.interpreted !== true) return { state: "error", code: "NOT_INTERPRETED", reason: reason ?? "the stage completed but its output was not interpreted, so it proves nothing" };
      return { state: "completed", code: null, reason: null };
    case "disabled":
      return { state: "off", code: "DISABLED", reason: reason ?? "switched off" };
    case "not_applicable":
      return { state: "not-applicable", code: "NOT_APPLICABLE", reason: reason ?? "not applicable to this project" };
    case "blocked":
      return { state: "blocked", code: "BLOCKED", reason: reason ?? "blocked before it could run" };
    case "timeout":
      return { state: "timed-out", code: "TIMEOUT", reason: reason ?? "timed out" };
    case "error":
      return { state: "error", code: "ERROR", reason: reason ?? "ended in error" };
    case "cancelled":
      return { state: "blocked", code: "CANCELLED", reason: reason ?? "the run was cancelled before this check finished" };
    default:
      return { state: "blocked", code: "NOT_FINISHED", reason: reason ?? "the run ended before this check finished" };
  }
}

/** The state of a plan item that did not run, from the reason the plan gives. */
function itemUnitState(item: Obj): { state: CheckUnitState; code: string; reason: string } {
  const reason = isObj(item.reason) ? item.reason : {};
  const code = str(reason.code) ?? "DISABLED";
  const state = isObj(item.state) ? item.state : {};
  const label = str(state.originLabel);
  const message = str(reason.message) ?? code;
  const text = label ? `${message} (${label})` : message;
  if (code === "NOT_SELECTED") return { state: "not-selected", code, reason: text };
  if (code === "NOT_AVAILABLE_HERE" || code === "NO_EXECUTABLE_ADAPTER") return { state: "not-applicable", code, reason: text };
  return { state: state.enabled === true ? "not-applicable" : "off", code, reason: text };
}

/** The pack-relative path of a recorded rule file (`rules/<rel>` of the JGates pack folder), or null. */
function packRelative(file: string, folder: string): string | null {
  const norm = file.replace(/\\/g, "/");
  const marker = `/${folder}/rules/`;
  const at = norm.lastIndexOf(marker);
  if (at >= 0) return norm.slice(at + marker.length);
  return norm.startsWith(`${folder}/rules/`) ? norm.slice(folder.length + 7) : null;
}

const hashFile = (file: string): string | null => {
  try {
    return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
  } catch {
    return null;
  }
};

interface PackState {
  dir: string;
  folder: string;
  rules: PackRule[];
  hashes: Map<string, string | null>;
}

function packState(rulesDir: string | null | undefined): PackState | null {
  const dir = rulesDir === undefined ? bundledPackRulesDir("jgates") : rulesDir;
  if (!dir || !fs.existsSync(dir)) return null;
  const folder = BUNDLED_RULE_PACKS.jgates ?? "jgates-semgrep";
  const rules = buildPackIndex(dir).rules;
  const hashes = new Map<string, string | null>();
  for (const file of new Set(rules.map((r) => r.file))) hashes.set(file, hashFile(path.join(dir, ...file.split("/"))));
  return { dir, folder, rules, hashes };
}

/** The `semgrep-rule` units of one Semgrep stage, and the rules that give none with the reason. */
function ruleUnits(stage: Obj, item: Obj | null, hasPlan: boolean, pack: PackState, run: CheckUnitRun, out: CheckUnitList): void {
  const stageId = str(stage.id) ?? "-";
  const skipAll = (code: RuleSkipCode, reason: string): void => {
    for (const rule of pack.rules) out.skippedRules.push({ id: rule.id, language: rule.language, run, stageId, code, reason });
  };
  if (stage.state !== "completed" || stage.interpreted !== true) {
    skipAll("STAGE_NOT_COMPLETED", stageUnitState(stage).reason ?? "the Semgrep stage did not complete");
    return;
  }
  if (!item) {
    skipAll(hasPlan ? "PACK_NOT_SELECTED" : "PLAN_MISSING", hasPlan ? "the plan item of the Semgrep stage is not in the stored plan" : "the run stored no plan, so the rule files it used are unknown");
    return;
  }
  const recorded = new Map<string, string | null>();
  for (const f of objs(item.configFiles)) {
    const file = str(f.file);
    const rel = file ? packRelative(file, pack.folder) : null;
    if (rel) recorded.set(rel, typeof f.sha256 === "string" ? f.sha256 : null);
  }
  if (recorded.size === 0) {
    skipAll("PACK_NOT_SELECTED", "the JGates rule pack was not selected for this Semgrep step");
    return;
  }
  const scanned = scannedLanguagesOf(stage);
  for (const rule of pack.rules) {
    const skip = (code: RuleSkipCode, reason: string): void => {
      out.skippedRules.push({ id: rule.id, language: rule.language, run, stageId, code, reason });
    };
    const current = pack.hashes.get(rule.file) ?? null;
    const used = recorded.get(rule.file);
    if (used === undefined || current === null || used !== current) {
      skip("PACK_OTHER_VERSION", `the run used another version of the rule pack (${rule.file} ${used === undefined ? "was not in it" : "differs"}): validate again`);
      continue;
    }
    if (scanned === null) {
      skip("NO_SCANNED_LANGUAGES", "the run was made before JGates recorded which languages Semgrep scanned: validate again");
      continue;
    }
    const files = filesOfRule(rule, scanned);
    if (files <= 0) {
      skip("LANGUAGE_NOT_SCANNED", `the scan covered no ${rule.language} file`);
      continue;
    }
    out.units.push({
      unit: "semgrep-rule",
      id: rule.id,
      state: "completed",
      code: null,
      reason: null,
      basis: "deterministic",
      run,
      stageId,
      tool: str(item.tool) ?? semgrepManifest.id,
      ...(isObj(stage.cache) && stage.cache.status === "reused" ? { reused: true } : {}),
      language: rule.language,
      scannedFiles: files,
      ruleFile: rule.file,
    });
  }
}

function qualityUnits(record: QualityRunRecord, pack: PackState | null, out: CheckUnitList): void {
  const run: CheckUnitRun = { gate: "quality", runId: record.runId };
  out.runs.push(run);
  const result = isObj(record.result) ? record.result : {};
  const plan = isObj(record.plan) ? record.plan : null;
  const groups = plan && isObj(plan.groups) ? plan.groups : {};
  const willRun = objs(groups.willRun);
  const notRun = objs(groups.notApplicableOrDisabled);
  const allItems = [...willRun, ...notRun];
  const used = new Set<Obj>();
  const itemOf = (stage: Obj): Obj | null => {
    const id = str(stage.id);
    const direct = allItems.find((i) => i.id === id);
    if (direct) return direct;
    // A subcheck of the composite bridge: stage `quality-bridge.<subcheck>`, item with that subcheck.
    const adapter = str(stage.adapter);
    const sub = id && adapter && id.startsWith(`${adapter}.`) ? id.slice(adapter.length + 1) : null;
    return sub ? (allItems.find((i) => i.adapter === adapter && i.subcheck === sub) ?? null) : null;
  };
  const seenStages = new Set<string>();
  for (const stage of objs(result.stages)) {
    if (stage.kind === "composite") continue;
    const stageId = str(stage.id);
    if (!stageId) continue;
    seenStages.add(stageId);
    const item = itemOf(stage);
    if (item) used.add(item);
    const adapter = (item ? str(item.adapter) : null) ?? str(stage.adapter);
    const capabilities = item && strs(item.capabilities).length > 0 ? strs(item.capabilities) : [capabilityOf(stageId)].filter((c): c is string => c !== null);
    if (!adapter || capabilities.length === 0) continue;
    const { state, code, reason } = stageUnitState(stage);
    const languages = item ? strs(item.languages) : [];
    const tool = (item ? str(item.tool) : null) ?? stageId.split("#")[0] ?? adapter;
    for (const capability of capabilities) {
      out.units.push({
        unit: "capability",
        id: `${adapter}#${capability}`,
        state,
        code,
        reason,
        basis: "deterministic",
        run,
        stageId,
        tool,
        languages,
        ...(isObj(stage.cache) && stage.cache.status === "reused" ? { reused: true } : {}),
      });
    }
    if (adapter === semgrepManifest.id && pack) ruleUnits(stage, item && willRun.includes(item) ? item : null, plan !== null, pack, run, out);
  }
  // Plan items that never became a stage: off, not selected or not applicable, with the plan's reason.
  for (const item of notRun) {
    if (used.has(item)) continue;
    const id = str(item.id);
    const adapter = str(item.adapter);
    if (!id || !adapter || seenStages.has(id)) continue;
    const { state, code, reason } = itemUnitState(item);
    for (const capability of strs(item.capabilities)) {
      out.units.push({ unit: "capability", id: `${adapter}#${capability}`, state, code, reason, basis: "deterministic", run, stageId: id, tool: str(item.tool) ?? adapter, languages: strs(item.languages) });
    }
    if (adapter === semgrepManifest.id && pack) {
      for (const rule of pack.rules) out.skippedRules.push({ id: rule.id, language: rule.language, run, stageId: id, code: "STAGE_NOT_COMPLETED", reason });
    }
  }
  // Without a stored plan, what the run recorded as switched off is all there is.
  if (!plan) {
    for (const d of objs(result.disabled)) {
      const id = str(d.id);
      const capability = id ? capabilityOf(id) : null;
      if (!id || !capability || seenStages.has(id)) continue;
      const tool = id.slice(0, id.lastIndexOf("#"));
      out.units.push({ unit: "capability", id: `${tool}#${capability}`, state: "off", code: "DISABLED", reason: str(d.reason) ?? "switched off", basis: "deterministic", run, stageId: id, tool, languages: [] });
    }
  }
}

/** The state of a Semantic run as a whole: finished and reviewed, or why not. */
function semanticRunState(result: Obj): { state: CheckUnitState; code: string | null; reason: string | null } {
  if (result.partial === true) return { state: "error", code: "RUN_UNFINISHED", reason: "the Semantic run did not finish" };
  const stopped = isObj(result.stopped) ? result.stopped : null;
  if (stopped?.cause === "cancelled") return { state: "error", code: "RUN_CANCELLED", reason: "the Semantic run was cancelled" };
  const semanticRun = isObj(result.semanticRun) ? result.semanticRun : {};
  const outcome = isObj(semanticRun.outcome) ? semanticRun.outcome : null;
  if (!outcome) return { state: "error", code: "NOT_REVIEWED", reason: "the Semantic run reviewed nothing" };
  const reason = str(outcome.reason);
  switch (outcome.state) {
    case "completed":
      return { state: "completed", code: null, reason: null };
    case "timeout":
      return { state: "timed-out", code: "TIMEOUT", reason: reason ?? "the review timed out" };
    case "budget-exhausted":
      return { state: "error", code: "BUDGET_EXHAUSTED", reason: reason ?? "the review ran out of budget" };
    case "blocked":
      return { state: "blocked", code: "MASKING_BLOCKED", reason: reason ?? "nothing was sent: the masking blocked the review" };
    case "not-configured":
      return { state: "blocked", code: "NOT_CONFIGURED", reason: reason ?? "no model provider is configured" };
    case "unavailable":
      return { state: "blocked", code: "UNAVAILABLE", reason: reason ?? "the model provider was unavailable" };
    case "invalid":
      return { state: "error", code: "INVALID", reason: reason ?? "the model's answer was not valid" };
    default:
      return { state: "error", code: "NOT_REVIEWED", reason: reason ?? "the review did not complete" };
  }
}

const AI = "ai-source-review" as const;

/** The ledger units of a security-audit run, or the problem that makes the ledger unusable. */
function readLedger(raw: unknown): { units: LedgerUnit[] } | { code: string; reason: string } {
  if (!Array.isArray(raw)) return { code: "LEDGER_MISSING", reason: "the run has no coverage ledger" };
  const units = raw.filter(isObj) as unknown as LedgerUnit[];
  if (units.length !== raw.length) return { code: "LEDGER_INVALID", reason: "the coverage ledger is not valid: an entry is not a unit" };
  let problems: string[];
  try {
    problems = validateLedger(units);
  } catch (error) {
    problems = [(error as Error).message];
  }
  if (problems.length > 0) return { code: "LEDGER_INVALID", reason: `the coverage ledger is not valid: ${problems.slice(0, 3).join("; ")}` };
  return { units };
}

function semanticUnits(record: SemanticRunRecord, out: CheckUnitList): void {
  const run: CheckUnitRun = { gate: "semantic", runId: record.runId };
  out.runs.push(run);
  const result = isObj(record.result) ? record.result : {};
  const semanticRun = isObj(result.semanticRun) ? result.semanticRun : {};
  const runState = semanticRunState(result);
  for (const method of strs(semanticRun.methods)) {
    let { state, code, reason } = runState;
    if (method === SECURITY_AUDIT_METHOD && state === "completed") {
      const ledger = readLedger(record.ledger);
      if ("code" in ledger) {
        ({ code, reason } = ledger);
        state = "error";
      } else {
        // Only examined units count; a block whose units are all pending, unsupported, not applicable or out of scope gives nothing.
        const examined = new Map<string, number>();
        for (const u of ledger.units) {
          const block = isObj(u.canonical_refs) ? str(u.canonical_refs.attack_class) : null;
          if (block && u.state === "examined") examined.set(block, (examined.get(block) ?? 0) + 1);
        }
        for (const [block, count] of [...examined].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
          out.units.push({ unit: "semantic-ledger", id: block, state: "completed", code: null, reason: null, basis: AI, run, examinedUnits: count });
        }
      }
    }
    out.units.push({ unit: "semantic-method", id: method, state, code, reason, basis: AI, run });
    if (method === INSECURE_DEFAULTS_METHOD) {
      const doc = isObj(record.defaults) ? record.defaults : null;
      const categories = objs(doc?.categories);
      for (const id of INSECURE_CATEGORY_IDS) {
        const base = { unit: "semantic-method" as const, id: method, category: id, basis: AI, run };
        if (state !== "completed") {
          out.units.push({ ...base, state, code, reason });
          continue;
        }
        const c = categories.find((x) => x.id === id);
        if (!doc) out.units.push({ ...base, state: "error", code: "RECORD_MISSING", reason: "the run has no record of the categories it searched" });
        else if (!c) out.units.push({ ...base, state: "error", code: "CATEGORY_NOT_REPORTED", reason: "the category was not reported by the sweep" });
        else if (c.state !== "searched") out.units.push({ ...base, state: "error", code: "CATEGORY_PENDING", reason: str(c.reason) ?? "the category was left pending" });
        else if (c.files_scanned === 0) out.units.push({ ...base, state: "not-applicable", code: "NO_FILE_SCANNED", reason: "the sweep scanned no file for this category" });
        else out.units.push({ ...base, state: "completed", code: null, reason: null });
      }
    }
  }
}

/**
 * The check units of a stored Quality run and of stored Semantic runs, as one list: every unit with its state and,
 * when it did not run, why. Pure over the stored records (plus the rule files of this JGates, to compare hashes).
 */
export function collectCheckUnits(input: CheckUnitsInput): CheckUnitList {
  const out: CheckUnitList = { runs: [], units: [], skippedRules: [] };
  if (input.quality) qualityUnits(input.quality, packState(input.rulesDir), out);
  for (const record of input.semantic ?? []) semanticUnits(record, out);
  return out;
}
