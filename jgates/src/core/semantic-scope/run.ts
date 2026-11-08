// What a Semantic run does with its resolved scope: before the review, it opens the target, builds the guard and takes
// the fingerprints of the units it examines and carries; after the review, it writes the scope record (scope.json,
// gate schema "scope") with the units actually examined and the ledger (evidence/scope-ledger.json) a later run may
// reuse after its own current checks.
import path from "node:path";
import { writeGateRecord } from "../gates/read.js";
import type { ScopeSpec } from "../gates/types.js";
import { gitContext } from "../snapshot/index.js";
import { translator } from "../../i18n/index.js";
import { createScopeGuard, fromRepositoryPath, toRepositoryPath, type ScopeAccessGuard } from "./access.js";
import { buildImportGraph } from "./imports.js";
import {
  SCOPE_RECORD_FILE,
  examinedState,
  globalFingerprint,
  methodsHash,
  unitFingerprint,
  writeScopeLedger,
  type LedgerOutcome,
  type LedgerUnit,
  type ScopeLedger,
  type UnitFingerprint,
} from "./ledger.js";
import { openTarget } from "./resolve.js";
import { pathKey } from "./views.js";
import type { SemanticScopeResolution } from "./types.js";

const t = translator("semantic-scope");

/** Above this many paths, the review collects the whole project and the guard filters it (a command line stays short). */
const MAX_SEND_PATHS = 400;

export interface ScopeRunPreparation {
  resolution: SemanticScopeResolution;
  guard: ScopeAccessGuard;
  /** The workspace inside the repository ("" at the root, otherwise "sub/dir/"). */
  prefix: string;
  /** Repository-relative paths the review collects; null: it collects the project and `allow` filters. */
  sendPaths: string[] | null;
  /** Whether a repository-relative path may go to a context-only review (subjects to examine and allowed context). */
  allow(repositoryPath: string): boolean;
  /** Workspace-relative subjects examined now. */
  toExamine: string[];
  fingerprints: Map<string, UnitFingerprint>;
  globalFingerprint: string;
  methodsHash: string;
}

export function prepareScopeRun(options: { workspacePath: string; resolution: SemanticScopeResolution; methods: readonly string[]; env?: NodeJS.ProcessEnv }): ScopeRunPreparation {
  const env = options.env ?? process.env;
  const { resolution } = options;
  const view = openTarget(options.workspacePath, resolution.target, env);
  const graph = buildImportGraph(view);
  const guard = createScopeGuard({ workspacePath: options.workspacePath, resolution, env, view });
  const git = gitContext(options.workspacePath, env);
  const prefix = git.repository ? git.prefix : "";
  const toExamine = resolution.subjects.filter((s) => s.disposition === "examine" && s.change !== "removed").map((s) => s.path);
  const fingerprints = new Map<string, UnitFingerprint>();
  const carried = new Set([...resolution.reuse.reused.map((r) => r.id), ...resolution.reuse.notCarried.map((r) => r.id)]);
  for (const id of [...toExamine, ...carried]) if (view.has(id)) fingerprints.set(id, unitFingerprint(id, view, graph));
  const send = [...toExamine, ...resolution.context.map((c) => c.path)];
  const fullCollection = resolution.mode === "full" && resolution.context.length === 0 && toExamine.length === resolution.subjects.length;
  const sendPaths = fullCollection || send.length > MAX_SEND_PATHS ? null : [...new Set(send)].sort().map((p) => toRepositoryPath(p, prefix));
  return {
    resolution,
    guard,
    prefix,
    sendPaths,
    allow(repositoryPath) {
      const p = fromRepositoryPath(repositoryPath, prefix);
      if (p === null) return false;
      const d = guard.check(p);
      return d.allowed && (d.role === "subject" || d.role === "context");
    },
    toExamine,
    fingerprints,
    globalFingerprint: globalFingerprint(view),
    methodsHash: methodsHash(options.methods),
  };
}

export interface ScopeRunOutcome {
  runId: string;
  now: Date;
  completed: boolean;
  findings: Array<{ path?: unknown; confirmation?: unknown }>;
  /** Repository-relative paths the review received; null when the review did not say. */
  sentRepositoryPaths: string[] | null;
}

/** Writes scope.json and the ledger; returns their paths relative to the run folder. */
export function finishScopeRun(runDir: string, prep: ScopeRunPreparation, outcome: ScopeRunOutcome): string[] {
  const { resolution } = prep;
  const sent = outcome.sentRepositoryPaths ? new Set(outcome.sentRepositoryPaths.map((p) => fromRepositoryPath(p, prep.prefix)).filter((p): p is string => p !== null)) : null;
  const findings = outcome.findings.map((f) => (typeof f.path === "string" ? { ...f, path: fromRepositoryPath(f.path, prep.prefix) ?? f.path } : f));
  const ledgerOutcome: LedgerOutcome = { completed: outcome.completed, findings, sent };
  const units: LedgerUnit[] = [];
  const origin = { runId: outcome.runId, gate: "semantic" as const };
  const empty: UnitFingerprint = { content: null, dependencies: {}, unknownDependencies: true, method: "none" };
  for (const id of prep.toExamine) {
    const { state, reason } = examinedState(id, ledgerOutcome);
    units.push({ id, state, reason, fingerprint: prep.fingerprints.get(id) ?? empty, origin });
  }
  const examined = new Set(prep.toExamine.map(pathKey));
  for (const r of resolution.reuse.reused) {
    if (examined.has(pathKey(r.id))) continue;
    units.push({ id: r.id, state: "clean", reason: r.reasons[0] ?? { code: "REUSED", message: t("scope_reuse_reused", { runId: r.evidence?.runId ?? "-" }) }, fingerprint: prep.fingerprints.get(r.id) ?? empty, origin: r.evidence ?? origin });
  }
  for (const r of resolution.reuse.notCarried) {
    if (examined.has(pathKey(r.id))) continue;
    units.push({ id: r.id, state: "unresolved", reason: r.reasons[0] ?? { code: "PRIOR_UNRESOLVED", message: "-" }, fingerprint: prep.fingerprints.get(r.id) ?? empty, origin: r.evidence ?? origin });
  }
  units.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ledger: ScopeLedger = {
    schemaVersion: 1,
    kind: "semantic-scope-ledger",
    runId: outcome.runId,
    createdAt: outcome.now.toISOString(),
    repositoryId: resolution.repositoryId,
    methodsHash: prep.methodsHash,
    globalFingerprint: prep.globalFingerprint,
    units,
  };
  const files = [writeScopeLedger(runDir, ledger)];
  const actuallyExamined = prep.toExamine.filter((id) => sent?.has(id));
  const notSent = prep.toExamine.filter((id) => !sent?.has(id));
  const spec: ScopeSpec = {
    ...resolution.spec,
    units: {
      ...resolution.spec.units,
      examined: actuallyExamined.map((id) => ({ id, reason: t("scope_record_examined", { runId: outcome.runId }) })),
      omitted: [...resolution.spec.units.omitted, ...notSent.map((id) => ({ id, reason: t("scope_reuse_not_sent") }))],
    },
  };
  writeGateRecord("scope", path.join(runDir, SCOPE_RECORD_FILE), spec);
  files.push(SCOPE_RECORD_FILE);
  return files;
}
