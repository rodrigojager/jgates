// Fixtures and deterministic scripted models for the complementary Semantic modules (jgates/tests/
// semantic-complementary-a.test.js). Each script answers the contexts of the real executor through the mock provider
// and decides only from what it read through the host tools in that context (the tool results of its own
// conversation), never from the test. No test spends model tokens.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..", "..", "..");
export const load = (rel) => import(pathToFileURL(path.join(ROOT, "jgates", "dist", rel)).href);
export { setupWorkspace } from "../semantic-executor/helpers.mjs";

const handler = (name, collection, guard) =>
  [
    'const db = require("../db");',
    "",
    `// GET /${collection}/:id`,
    `exports.${name} = (req, res) => {`,
    `  const record = db.find("${collection}", req.params.id);`,
    "  if (!record) return res.status(404).end();",
    ...(guard ? ["  if (record.ownerId !== req.user.id) return res.status(403).end();"] : []),
    "  res.json(record);",
    "};",
    "",
  ].join("\n");

/** Three routes that load a record by id: orders (the confirmed IDOR), invoices (its sibling) and documents (guarded). */
export const IDOR = {
  "src/db.js": ['const tables = { orders: new Map(), invoices: new Map(), documents: new Map() };', "", "exports.find = (table, id) => tables[table].get(String(id)) ?? null;", ""].join("\n"),
  "src/routes/orders.js": handler("getOrder", "orders", false),
  "src/routes/invoices.js": handler("getInvoice", "invoices", false),
  "src/routes/documents.js": handler("getDocument", "documents", true),
};

// ---- reading the conversation -------------------------------------------------------------------------------------

export function filesRead(request) {
  const files = {};
  for (const m of request.messages) {
    if (m.role !== "tool") continue;
    for (const r of m.results) {
      const head = /^<repository-file path="([^"]+)"/.exec(r.content);
      if (!head || r.isError) continue;
      const lines = [];
      for (const l of r.content.split("\n").slice(1)) {
        const mm = /^(\d+): (.*)$/.exec(l);
        if (mm) lines[Number(mm[1])] = mm[2];
      }
      files[head[1]] = lines;
    }
  }
  return files;
}

/** Paths of the search results this context received. */
export function searchHits(request) {
  const out = [];
  for (const m of request.messages) {
    if (m.role !== "tool") continue;
    for (const r of m.results) {
      if (!r.content.startsWith("<search-results")) continue;
      for (const l of r.content.split("\n").slice(1)) {
        const mm = /^([^:\n]+):(\d+): /.exec(l);
        if (mm) out.push({ path: mm[1], line: Number(mm[2]) });
      }
    }
  }
  return out;
}

export const lineOf = (lines, re) => lines?.findIndex((l) => l !== undefined && re.test(l)) ?? -1;
export const read = (paths) => ({ toolCalls: paths.map((p) => ({ name: "read_file", arguments: { path: p } })) });
export const search = (query) => ({ toolCalls: [{ name: "search_files", arguments: { query } }] });
export const answer = (value) => ({ text: JSON.stringify(value), usage: { inputTokens: 100, outputTokens: 50 } });
const turnOf = (request) => request.messages.filter((m) => m.role === "assistant").length;
const briefOf = (request) => request.messages[0].text;

/** A record loaded by request id and returned without comparing its owner to the caller. */
function idorLine(lines) {
  const find = lineOf(lines, /db\.find\([^)]*req\.params\.id/);
  if (find < 0) return null;
  const guard = lineOf(lines, /ownerId\s*!==\s*req\.user\.id/);
  return { find, guard };
}

/** Records every request (for assertions) and dispatches by stage. */
export function recorder(dispatch) {
  const requests = [];
  const script = (request) => {
    requests.push(JSON.parse(JSON.stringify({ contextLabel: request.contextLabel, system: request.system, messages: request.messages, tools: request.tools.map((t) => t.name) })));
    return dispatch(request.contextLabel.split(":")[0], request, turnOf(request), briefOf(request));
  };
  return { script, requests };
}

/** A script that must never be called (a not-applicable method sends nothing). */
export function forbidden() {
  const calls = [];
  return { calls, script: (request) => {
    calls.push(request.contextLabel);
    return { text: "" };
  } };
}

// ---- the earlier general review that confirms the IDOR in orders ----------------------------------------------------

const DIMENSIONS = ["functional-correctness", "tests", "maintainability", "architecture", "performance-reliability", "security"];

export function priorReviewer() {
  return recorder((stage, request, turn, brief) => {
    if (stage === "evidence-planning") {
      if (turn === 0) return read(["src/routes/orders.js"]);
      return answer({ summary: "One order route.", dimensions: DIMENSIONS.map((id) => ({ id, files: ["src/routes/orders.js"], hypotheses: id === "security" ? ["GET /orders/:id returns any order to any caller"] : [] })) });
    }
    if (stage === "hunting") {
      if (turn === 0) return read(["src/routes/orders.js"]);
      const lines = filesRead(request)["src/routes/orders.js"];
      const hit = idorLine(lines);
      return answer({
        summary: "The order route loads by id without an ownership check.",
        dimensions: DIMENSIONS.map((id) => ({ id, state: "examined", reviewed_paths: ["src/routes/orders.js"], checks: [`read the handler for ${id}`] })),
        candidates: hit && hit.guard < 0 ? [{ title: "IDOR: GET /orders/:id returns another user's order", path: "src/routes/orders.js", line: hit.find, severity: "blocking", category: "security", rationale: "The order is loaded by the request id and returned without comparing its ownerId to req.user.id (missing ownership check).", hypothesis: "GET /orders/:id returns any order to any caller" }] : [],
      });
    }
    if (stage === "challenge") {
      const p = /"path": "([^"]+)"/.exec(brief)?.[1];
      const id = /"candidateId": "([^"]+)"/.exec(brief)?.[1];
      if (turn === 0) return read([p]);
      const hit = idorLine(filesRead(request)[p]);
      return answer({ candidateId: id, confirmation: hit && hit.guard < 0 ? "confirmed" : "rejected", reason: "Nothing between the lookup and the response compares the record owner with the caller.", evidence: [{ path: p, line: hit.find, note: "lookup by request id, returned unchecked" }] });
    }
    return { text: "" };
  });
}

// ---- the variant analyst --------------------------------------------------------------------------------------------

export function variantAnalyst() {
  return recorder((stage, request, turn, brief) => {
    if (stage === "root-cause") {
      const seedPath = /"path": "([^"]+)"/.exec(brief.slice(brief.indexOf("Confirmed seeds")))?.[1];
      if (turn === 0) return read([seedPath]);
      if (turn === 1) return search("req.params.id");
      const hit = idorLine(filesRead(request)[seedPath]);
      const leads = [...new Set(searchHits(request).map((h) => h.path))];
      return answer({
        summary: "The seed returns a record loaded by request id without an ownership comparison.",
        seeds: [{ seed_id: "S1", reproduced: !!hit && hit.guard < 0, root_cause: "this exists because the request id reaches db.find and the record is returned without comparing record.ownerId to req.user.id", exact_match: { path: seedPath, line: hit?.find }, axes: [{ id: "lookup-by-request-id", description: "handlers that load a record by req.params.id", constructs: ["db.find(", "req.params.id"], leads }] }],
      });
    }
    if (stage === "sweep") {
      if (turn === 0) return search("req.params.id");
      const hits = [...new Set(searchHits(request).map((h) => h.path))];
      if (turn === 1) return read(hits);
      const files = filesRead(request);
      const candidates = [];
      for (const [p, lines] of Object.entries(files)) {
        const hit = idorLine(lines);
        if (!hit || p === "src/routes/orders.js") continue;
        candidates.push({ title: `Same missing ownership check in ${p}`, path: p, line: hit.find, severity: "blocking", rationale: "A record is loaded by the request id like the seed.", seed_id: "S1", axis: "lookup-by-request-id", level: 1, missing_protection: "record.ownerId === req.user.id" });
      }
      return answer({ summary: `${candidates.length} variant candidate(s).`, axes: [{ id: "lookup-by-request-id", state: "searched", patterns: [{ level: 0, pattern: 'db.find("orders", req.params.id)', matches: 1, noise: 0 }, { level: 1, pattern: "db.find($T, req.params.id)", matches: hits.length, noise: 0 }] }], candidates });
    }
    if (stage === "triage") {
      const p = /"path": "([^"]+)"/.exec(brief)?.[1];
      const id = /"candidateId": "([^"]+)"/.exec(brief)?.[1];
      if (turn === 0) return read([p]);
      const hit = idorLine(filesRead(request)[p]);
      if (hit.guard > 0) return answer({ candidateId: id, confirmation: "rejected", reason: "The handler compares the record owner with the caller before returning it.", evidence: [{ path: p, line: hit.guard, note: "ownership check" }], safe_reason: "ownership check before the response", reachable: true, controllable: true, unprotected: false, confidence: "high" });
      return answer({ candidateId: id, confirmation: "confirmed", reason: "The record is loaded by the request id and returned with no ownership comparison, exactly like the seed.", evidence: [{ path: p, line: hit.find, note: "lookup by request id, returned unchecked" }], severity: "blocking", reachable: true, controllable: true, unprotected: true, confidence: "high" });
    }
    return { text: "" };
  });
}

/** Builds a plan and runs one Semantic run with the given module and scripted model. */
export async function runModule(ws, module, { script, scope = null, rigor = "standard" } = {}) {
  const { buildSemanticPlan, executeSemanticRun } = await load("core/semantic/index.js");
  const plan = buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env: ws.env, scope, rigor });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const result = await executeSemanticRun({ workspacePath: ws.dir, home: ws.home, env: ws.env, version: "0.0.0-test", plan, cancelPollMs: 50, investigation: { module, deps: { script } } });
  return { plan, result, outcome: result.semanticRun.outcome, investigation: result.semanticRun.outcome.investigation };
}
