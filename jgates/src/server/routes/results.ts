// Results of finished (or partial) runs of this workspace for the Resultado screen: the document, the run before it, the
// logs of the steps (paged), JSON/SARIF export, the safe context for an agent, and opening the run folder.
// Everything is found by run id under the workspace's runs folder; no path comes from the request.
import { localizeResult } from "../../core/results/localize.js";
import { runMascots } from "../mascots.js";
import fs from "node:fs";
import path from "node:path";
import { buildAgentContext, scrub } from "../../core/agent-context/index.js";
import { workspaceDir } from "../../core/home/index.js";
import { listRuns } from "../../core/artifacts/index.js";
import { approvalWording, approvalWordingParams, compareWithPrevious, toSarif } from "../../core/results/index.js";
import { newChecks, toolsOfStages } from "../../core/results/new-checks.js";
import { RESULT_FILE } from "../../core/run/index.js";
import type { RunResult } from "../../core/run/types.js";
import { openInBrowser } from "../browser.js";
import { refuse } from "../http.js";
import { RUN_ID_PATTERN } from "../runs.js";
import type { RouteDefinition, ServerContext } from "../types.js";

const MAX_LOG_PAGE = 64 * 1024;
const LOG_NAME = "^[A-Za-z0-9][A-Za-z0-9._#@-]{0,150}\\.log$";

const runParams = { type: "object", properties: { runId: { type: "string", pattern: RUN_ID_PATTERN } }, required: ["runId"], additionalProperties: false };

function runDirOf(server: ServerContext, runId: string): string {
  const runsDir = path.join(workspaceDir(server.home, server.workspace.id), "runs");
  const dir = path.join(runsDir, runId);
  try {
    if (!fs.lstatSync(dir).isDirectory()) throw refuse(404, "RUN_NOT_FOUND");
  } catch (error) {
    if (error instanceof Error && "status" in error) throw error;
    throw refuse(404, "RUN_NOT_FOUND");
  }
  return dir;
}

function readResult(server: ServerContext, runId: string): { dir: string; result: RunResult } {
  const dir = runDirOf(server, runId);
  try {
    const file = path.join(dir, RESULT_FILE);
    if (!fs.lstatSync(file).isFile()) throw new Error("not a file");
    return { dir, result: JSON.parse(fs.readFileSync(file, "utf8")) as RunResult };
  } catch {
    throw refuse(404, "RUN_NOT_FOUND");
  }
}

/** "Approved with N waivers" for the screens: the kind and its numbers, from the one function every surface uses (also for an old stored result). */
function approvalOf(result: RunResult): { kind: string; waivers: number; findings: number; more: number } {
  const wording = approvalWording(result);
  return { kind: wording.kind, ...approvalWordingParams(wording) };
}

/** The run before this one in the history of the workspace, and whether the policy (or anything else) differs. */
function previousOf(server: ServerContext, result: RunResult): Record<string, unknown> | null {
  const runs = listRuns(server.home, server.workspace.id);
  const index = runs.findIndex((r) => r.runId === result.runId);
  const before = index >= 0 ? runs.slice(index + 1).find((r) => !r.partial) : undefined;
  if (!before) return null;
  let other: RunResult | null = null;
  try {
    other = JSON.parse(fs.readFileSync(path.join(before.dir, RESULT_FILE), "utf8")) as RunResult;
  } catch {
    other = null;
  }
  if (!other) return null;
  // The hashes of the analysis and the waivers in force (core/results/previous.ts).
  const { comparable, changed, policyChanged, waiversChanged } = compareWithPrevious(result, other);
  // The checks this validation ran that the one before did not (named; the screen says "N checks are new").
  const fresh = newChecks(
    (result.stages ?? []).filter((s) => s.kind !== "composite").map((s) => ({ tool: String(s.id).split("#")[0] ?? "", label: typeof s.label === "string" ? s.label : undefined })),
    toolsOfStages(other.stages),
  );
  return { runId: before.runId, startedAt: before.startedAt, decision: before.decision, comparable, changed, policyChanged, waiversChanged, newChecks: fresh };
}

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/results/:runId",
    params: runParams,
    handler({ params, server }) {
      const { result } = readResult(server, params.runId as string);
      return { status: 200, json: { schemaVersion: 1, status: "OK", result: { ...localizeResult(result), approval: approvalOf(result) }, mascots: runMascots(server, result.runId, result, { orphan: result.partial === true }), previous: previousOf(server, result) } };
    },
  },
  {
    method: "GET",
    path: "/api/results/:runId/agent-context",
    params: runParams,
    handler({ params, server }) {
      const { result } = readResult(server, params.runId as string);
      return { status: 200, json: { schemaVersion: 1, status: "OK", agentContext: buildAgentContext(result) } };
    },
  },
  {
    method: "GET",
    path: "/api/results/:runId/export",
    params: runParams,
    query: { type: "object", properties: { format: { enum: ["json", "sarif"] } }, additionalProperties: false },
    handler({ params, query, server }) {
      const { result } = readResult(server, params.runId as string);
      const format = query.format === "sarif" ? "sarif" : "json";
      return { status: 200, json: { schemaVersion: 1, status: "OK", format, filename: `${result.runId}.${format === "sarif" ? "sarif" : "json"}`, document: format === "sarif" ? toSarif(result) : result } };
    },
  },
  {
    method: "GET",
    path: "/api/results/:runId/logs",
    params: runParams,
    handler({ params, server }) {
      const dir = path.join(runDirOf(server, params.runId as string), "logs");
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir).filter((n) => new RegExp(LOG_NAME).test(n));
      } catch {
        names = [];
      }
      const logs = names.sort().flatMap((name) => {
        try {
          const st = fs.lstatSync(path.join(dir, name));
          return st.isFile() ? [{ name, bytes: st.size }] : [];
        } catch {
          return [];
        }
      });
      return { status: 200, json: { schemaVersion: 1, status: "OK", logs } };
    },
  },
  {
    method: "GET",
    path: "/api/results/:runId/logs/:name",
    params: { type: "object", properties: { runId: { type: "string", pattern: RUN_ID_PATTERN }, name: { type: "string", pattern: LOG_NAME } }, required: ["runId", "name"], additionalProperties: false },
    query: { type: "object", properties: { offset: { type: "string", pattern: "^[0-9]{1,12}$" }, limit: { type: "string", pattern: "^[0-9]{1,6}$" } }, additionalProperties: false },
    handler({ params, query, server }) {
      const file = path.join(runDirOf(server, params.runId as string), "logs", params.name as string);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(file);
      } catch {
        throw refuse(404, "RUN_NOT_FOUND");
      }
      if (!st.isFile()) throw refuse(404, "RUN_NOT_FOUND");
      const offset = Math.min(Number(query.offset ?? "0"), st.size);
      const limit = Math.min(Number(query.limit ?? String(MAX_LOG_PAGE)) || MAX_LOG_PAGE, MAX_LOG_PAGE);
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(Math.min(limit, st.size - offset));
        const read = fs.readSync(fd, buf, 0, buf.length, offset);
        const next = offset + read;
        // The page is masked as the agent context is: a log is tool output and may carry secrets or personal data.
        return { status: 200, json: { schemaVersion: 1, status: "OK", name: params.name, offset, next, bytes: st.size, text: scrub(buf.subarray(0, read).toString("utf8")), done: next >= st.size } };
      } finally {
        fs.closeSync(fd);
      }
    },
  },
  {
    method: "POST",
    path: "/api/results/:runId/open-folder",
    params: runParams,
    handler({ params, server }) {
      const dir = runDirOf(server, params.runId as string);
      const opened = openInBrowser(dir);
      return { status: 200, json: { schemaVersion: 1, status: "OK", opened, path: dir } };
    },
  },
];
