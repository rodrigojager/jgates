// The scope ledger of a Semantic run (evidence/scope-ledger.json) and the reuse of prior evidence. Each unit (a file)
// is recorded with the state the run left it in (clean, findings or unresolved) and its fingerprint: the content, the
// files of its import closure with their content, whether that closure has unknowns, the workspace-wide configuration
// and dependency manifests, and the methods. A later run reuses a unit only when the prior state is clean and every
// part of the fingerprint still matches the current source (current checks, never an inherited blanket status).
// Unresolved or finding-bearing units are never carried as covered.
import fs from "node:fs";
import path from "node:path";
import { contentHash } from "../ids/index.js";
import { translator } from "../../i18n/index.js";
import { categoriesOf, isGlobalConfiguration, isJs, isManifest, isPython } from "./classify.js";
import { importClosure, type ImportGraph } from "./imports.js";
import type { FileView } from "./views.js";
import type { Reason, ReuseEntry, ReuseReport } from "./types.js";
import { renameWithRetry } from "../fs-retry/index.js";

const t = translator("semantic-scope");

export const SCOPE_LEDGER_FILE = "evidence/scope-ledger.json";
export const SCOPE_RECORD_FILE = "scope.json";
/** Depth of the import closure a fingerprint covers. */
export const FINGERPRINT_DEPTH = 3;

export type UnitState = "clean" | "findings" | "unresolved";

export interface UnitFingerprint {
  content: string | null;
  dependencies: Record<string, string | null>;
  /** The closure has a computed import, an unparseable file or an unresolved relative import. */
  unknownDependencies: boolean;
  method: "ast" | "regex" | "none";
}

export interface LedgerUnit {
  id: string;
  state: UnitState;
  reason: Reason;
  fingerprint: UnitFingerprint;
  /** The run whose examination produced the evidence (the first one, for a unit carried forward). */
  origin: { runId: string; gate: "semantic" };
}

export interface ScopeLedger {
  schemaVersion: 1;
  kind: "semantic-scope-ledger";
  runId: string;
  createdAt: string;
  repositoryId: string | null;
  methodsHash: string;
  globalFingerprint: string;
  units: LedgerUnit[];
}

/** Hash of the methods that produced or would reuse evidence. */
export const methodsHash = (methods: readonly string[]): string => contentHash({ v: 1, methods: [...methods].sort() });

/** Workspace-wide configuration and dependency manifests: a change there revalidates every unit. */
export function globalFingerprint(view: FileView): string {
  const files = view.files.filter((f) => isManifest(f) || isGlobalConfiguration(f));
  return contentHash({ v: 1, files: files.map((f) => [f, view.sha(f)]) });
}

export function unitFingerprint(file: string, view: FileView, graph: ImportGraph | null): UnitFingerprint {
  const content = view.sha(file);
  if (!graph || !(isJs(file) || isPython(file))) return { content, dependencies: {}, unknownDependencies: false, method: "none" };
  const closure = importClosure(graph, file, FINGERPRINT_DEPTH);
  const dependencies: Record<string, string | null> = {};
  for (const d of closure) dependencies[d] = view.sha(d);
  const members = new Set([file, ...closure]);
  const unknownDependencies =
    graph.unknowns.some((u) => members.has(u.path) && u.code !== "FILE_TOO_LARGE") || graph.unresolved.some((u) => members.has(u.from) && u.candidate !== null);
  return { content, dependencies, unknownDependencies, method: graph.methods.get(file) ?? "none" };
}

export function writeScopeLedger(runDir: string, ledger: ScopeLedger): string {
  const file = path.join(runDir, SCOPE_LEDGER_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  renameWithRetry(tmp, file);
  return SCOPE_LEDGER_FILE;
}

/** Reads a ledger; null when absent or not a ledger of this version. */
export function readScopeLedger(runDir: string): ScopeLedger | null {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(runDir, SCOPE_LEDGER_FILE), "utf8")) as ScopeLedger;
    if (doc?.schemaVersion !== 1 || doc.kind !== "semantic-scope-ledger" || !Array.isArray(doc.units)) return null;
    return doc;
  } catch {
    return null;
  }
}

const reason = (code: string, params: Record<string, string | number> = {}, via?: string): Reason => ({ code, message: t(`scope_reuse_${code.toLowerCase()}`, params), ...(via ? { via } : {}) });

export interface ReuseInput {
  ledger: ScopeLedger;
  view: FileView;
  graph: ImportGraph | null;
  methodsHash: string;
  globalFingerprint: string;
  /** Units that may be checked (files at the target that are not excluded). */
  candidates: Set<string>;
}

export interface ReuseCheck extends ReuseReport {
  /** Current fingerprints of the reused units, for the ledger of the new run. */
  fingerprints: Map<string, UnitFingerprint>;
  /** Prior units left unresolved or with findings, by id. */
  pending: Set<string>;
}

/** Checks every unit of the prior ledger against the current source. */
export function checkReuse(input: ReuseInput): ReuseCheck {
  const { ledger, view, graph } = input;
  const out: ReuseCheck = { baselineRunId: ledger.runId, reused: [], invalidated: [], notCarried: [], fingerprints: new Map(), pending: new Set() };
  const evidence = (u: LedgerUnit): NonNullable<ReuseEntry["evidence"]> => ({ runId: u.origin.runId, gate: "semantic" });
  for (const unit of [...ledger.units].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!input.candidates.has(unit.id)) continue;
    if (unit.state !== "clean") {
      out.pending.add(unit.id);
      out.notCarried.push({ id: unit.id, reasons: [reason(unit.state === "findings" ? "PRIOR_FINDINGS" : "PRIOR_UNRESOLVED", { runId: ledger.runId })], evidence: evidence(unit) });
      continue;
    }
    const reasons: Reason[] = [];
    if (ledger.methodsHash !== input.methodsHash) reasons.push(reason("METHOD_CHANGED"));
    const current = unitFingerprint(unit.id, view, graph);
    if (current.content !== unit.fingerprint.content) reasons.push(reason("CONTENT_CHANGED"));
    if (ledger.globalFingerprint !== input.globalFingerprint) reasons.push(reason("CONFIG_OR_DEPENDENCIES_CHANGED"));
    const deps = new Set([...Object.keys(unit.fingerprint.dependencies), ...Object.keys(current.dependencies)]);
    for (const d of [...deps].sort()) {
      const before = unit.fingerprint.dependencies[d];
      const now = current.dependencies[d];
      if (before === now) continue;
      const guard = categoriesOf(d).includes("shared-guard");
      if (before === undefined) reasons.push(reason("DEPENDENCY_ADDED", { path: d }, d));
      else if (now === undefined || now === null) reasons.push(reason(guard ? "PROTECTION_REMOVED" : "DEPENDENCY_REMOVED", { path: d }, d));
      else reasons.push(reason(guard ? "PROTECTION_CHANGED" : "DEPENDENCY_CHANGED", { path: d }, d));
    }
    if (current.unknownDependencies) reasons.push(reason("DEPENDENCIES_UNKNOWN"));
    if (reasons.length > 0) {
      out.invalidated.push({ id: unit.id, reasons, evidence: evidence(unit) });
      continue;
    }
    out.fingerprints.set(unit.id, current);
    out.reused.push({
      id: unit.id,
      reasons: [reason(current.method === "regex" ? "REUSED_REGEX_DEPENDENCIES" : "REUSED", { runId: unit.origin.runId })],
      evidence: evidence(unit),
    });
  }
  return out;
}

/** A finding as the review outcome gives it (only the fields the ledger needs). */
export interface OutcomeFinding {
  path?: unknown;
  confirmation?: unknown;
}

export interface LedgerOutcome {
  /** true only when the review completed and the run was neither cancelled nor partial. */
  completed: boolean;
  findings: OutcomeFinding[];
  /** Workspace-relative paths the review actually received; null when unknown (then nothing is clean). */
  sent: Set<string> | null;
}

/** The state each examined unit is left in by one run. */
export function examinedState(unit: string, outcome: LedgerOutcome): { state: UnitState; reason: Reason } {
  if (!outcome.completed) return { state: "unresolved", reason: reason("REVIEW_INCOMPLETE") };
  if (!outcome.sent || !outcome.sent.has(unit)) return { state: "unresolved", reason: reason("NOT_SENT") };
  const live = outcome.findings.filter((f) => f.confirmation !== "rejected");
  if (live.some((f) => typeof f.path !== "string" || f.path === "")) return { state: "unresolved", reason: reason("UNLOCATED_FINDING") };
  const mine = live.filter((f) => typeof f.path === "string" && f.path.replace(/\\/g, "/").replace(/^\.\//, "") === unit);
  if (mine.some((f) => f.confirmation !== "confirmed")) return { state: "unresolved", reason: reason("FINDING_NEEDS_VALIDATION") };
  if (mine.length > 0) return { state: "findings", reason: reason("CONFIRMED_FINDING") };
  return { state: "clean", reason: reason("EXAMINED_NO_FINDINGS") };
}
