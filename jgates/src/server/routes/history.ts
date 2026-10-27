// History of the open workspace: its local runs with the filters of the screen, the comparison of two runs and the marks
// (baseline, preserved). It reads the data folder only; nothing here touches the project.
import fs from "node:fs";
import path from "node:path";
import { listRuns, markRun, type RunInfo } from "../../core/artifacts/index.js";
import { discoverWorkspace } from "../../core/discovery/index.js";
import { assignFingerprints, compareWithBaseline } from "../../core/results/index.js";
import type { ResultFinding, RunResult } from "../../core/run/types.js";
import { translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";

const t = translator("history");
const RUN_ID = "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$";
const LIST_CAP = 500;

function readResult(run: RunInfo): RunResult | null {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(run.dir, "result.json"), "utf8")) as unknown;
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as RunResult) : null;
  } catch {
    return null;
  }
}

/** Component of a finding: the inventory component whose root holds the file (the longest root wins). */
function componentResolver(projectDir: string): (file: string | undefined) => string | null {
  let roots: Array<{ id: string; root: string }> = [];
  try {
    roots = discoverWorkspace(projectDir)
      .inventory.classifications.filter((c) => c.componentRoot !== ".")
      .map((c) => ({ id: c.id, root: c.componentRoot.replace(/\\/g, "/").replace(/\/+$/, "") }))
      .sort((a, b) => b.root.length - a.root.length);
  } catch {
    roots = [];
  }
  return (file) => {
    if (!file) return null;
    const normalized = file.replace(/\\/g, "/");
    return roots.find((r) => normalized === r.root || normalized.startsWith(`${r.root}/`))?.id ?? null;
  };
}

const distinct = (values: Array<string | null | undefined>): string[] => [...new Set(values.filter((v): v is string => typeof v === "string" && v !== ""))].sort();

function summary(run: RunInfo, result: RunResult | null, componentOf: (file: string | undefined) => string | null) {
  const findings: ResultFinding[] = result?.findings ?? [];
  const active = findings.filter((f) => !f.waived);
  const started = result?.startedAt ? Date.parse(result.startedAt) : NaN;
  const finished = result?.finishedAt ? Date.parse(result.finishedAt) : NaN;
  const hashes = (result?.provenance as { hashes?: Record<string, string> } | undefined)?.hashes;
  return {
    runId: run.runId,
    workspaceId: run.workspaceId,
    startedAt: run.startedAt,
    durationMs: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : null,
    decision: run.decision,
    complete: result?.complete ?? false,
    // A reduced run is a partial round (not the full profile); an unfinished one has no final result.
    partial: run.partial || run.reduced,
    reduced: run.reduced,
    unfinished: run.partial,
    bytes: run.bytes,
    baseline: run.marks.baseline,
    preserved: run.marks.preserved,
    profile: result?.selection?.profile ?? null,
    scope: result?.selection?.scope ?? null,
    commit: result?.analyzed?.snapshot?.commit ?? null,
    policyHash: hashes?.policy ?? null,
    findings: { total: findings.length, active: active.length, blocking: findings.filter((f) => f.blocking).length },
    severities: distinct(active.map((f) => f.normalizedSeverity)),
    categories: distinct(active.map((f) => f.category)),
    components: distinct(active.map((f) => componentOf(f.location?.path))),
  };
}

function findRun(server: ServerContext, runId: string): RunInfo {
  const run = listRuns(server.home, server.workspace.id).find((r) => r.runId === runId);
  if (!run) throw new HttpError(404, "RUN_NOT_FOUND", t("history_run_not_found", { runId }), t("history_run_not_found_fix"));
  return run;
}

const brief = (f: ResultFinding) => ({
  fingerprint: f.fingerprint ?? null,
  tool: f.tool,
  ruleId: f.ruleId,
  severity: f.normalizedSeverity,
  category: f.category ?? null,
  message: f.message,
  path: f.location?.path ?? null,
  line: f.location?.line ?? null,
  blocking: f.blocking,
});

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/history",
    handler({ server }) {
      const componentOf = componentResolver(server.projectDir);
      const runs = listRuns(server.home, server.workspace.id)
        .slice(0, LIST_CAP)
        .map((run) => summary(run, readResult(run), componentOf));
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          workspace: server.workspace,
          runs,
          filters: {
            severities: distinct(runs.flatMap((r) => r.severities)),
            categories: distinct(runs.flatMap((r) => r.categories)),
            components: distinct(runs.flatMap((r) => r.components)),
          },
        },
      };
    },
  },
  {
    // The run `head` against the run `base`: new, resolved and kept findings, with the warnings that say when the two
    // are not a like-for-like comparison (policy, rules or scope changed, a reduced or partial run).
    method: "GET",
    path: "/api/history/compare",
    query: {
      type: "object",
      properties: { base: { type: "string", pattern: RUN_ID }, head: { type: "string", pattern: RUN_ID } },
      required: ["base", "head"],
      additionalProperties: false,
    },
    handler({ query, server }) {
      if (query.base === query.head) throw new HttpError(400, "COMPARE_SAME_RUN", t("history_compare_same"), t("history_compare_same_fix"));
      const baseRun = findRun(server, query.base as string);
      const headRun = findRun(server, query.head as string);
      const base = readResult(baseRun);
      const head = readResult(headRun);
      for (const [run, result] of [[baseRun, base], [headRun, head]] as const) {
        if (!result || run.partial) throw new HttpError(422, "RUN_UNFINISHED", t("history_run_unfinished", { runId: run.runId }), t("history_run_unfinished_fix"));
      }
      // Results written before the fingerprints get them now, so both sides speak the same language.
      const before = { ...(base as RunResult), findings: assignFingerprints((base as RunResult).findings ?? []) };
      const after = { ...(head as RunResult), findings: assignFingerprints((head as RunResult).findings ?? []) };
      const cmp = compareWithBaseline(before, after);
      const known = new Set(before.findings.map((f) => f.fingerprint));
      const present = new Set(after.findings.map((f) => f.fingerprint));
      const added = after.findings.filter((f) => !known.has(f.fingerprint));
      const kept = after.findings.filter((f) => known.has(f.fingerprint));
      const resolved = before.findings.filter((f) => !present.has(f.fingerprint));
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          base: baseRun.runId,
          head: headRun.runId,
          comparable: cmp.comparable,
          warnings: cmp.warnings,
          counts: { new: added.length, resolved: resolved.length, kept: kept.length },
          new: added.slice(0, LIST_CAP).map(brief),
          resolved: resolved.slice(0, LIST_CAP).map(brief),
          kept: kept.slice(0, LIST_CAP).map(brief),
        },
      };
    },
  },
  {
    // baseline is one per workspace (setting it clears the other); preserved keeps a run out of the retention.
    method: "POST",
    path: "/api/history/:runId/marks",
    params: { type: "object", properties: { runId: { type: "string", pattern: RUN_ID } }, required: ["runId"] },
    body: {
      type: "object",
      properties: { baseline: { type: "boolean" }, preserved: { type: "boolean" } },
      additionalProperties: false,
      minProperties: 1,
    },
    handler({ params, body, server }) {
      const patch = body as { baseline?: boolean; preserved?: boolean };
      const run = findRun(server, params.runId as string);
      if (patch.baseline === true && run.partial) throw new HttpError(422, "RUN_UNFINISHED", t("history_run_unfinished", { runId: run.runId }), t("history_run_unfinished_fix"));
      if (patch.baseline === true) {
        for (const other of listRuns(server.home, server.workspace.id)) {
          if (other.marks.baseline && other.runId !== run.runId) markRun(server.home, other.workspaceId, other.runId, { baseline: false });
        }
      }
      const marks = markRun(server.home, run.workspaceId, run.runId, patch);
      server.log(`marks ${run.runId} baseline=${marks.baseline} preserved=${marks.preserved}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", runId: run.runId, baseline: marks.baseline, preserved: marks.preserved } };
    },
  },
];
