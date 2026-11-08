// A deterministic fake auditor for the security-audit module (V2-11, V2-29 and jgates/tests/semantic-cloudflare): a
// scripted model that answers every context of the real phase pipeline (reconnaissance, coverage planning, hunting,
// coverage critic, refutation, verification) through the mock provider. It decides only from what it reads through the
// host tools in that context (the tool results in its own conversation), never from the test: the same script finds the
// SQL injection of a vulnerable fixture and nothing in its clean twin, and its refuter rejects a candidate when the file
// it reads shows a parameterizing guard. No test spends model tokens.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..", "..", "..");
export const load = (rel) => import(pathToFileURL(path.join(ROOT, "jgates", "dist", rel)).href);
export { setupWorkspace, readJson, readEvents } from "../semantic-executor/helpers.mjs";

export const FINGERPRINT = "sqli:src/routes.js:getUser";

const DRIVER = ["exports.exec = (text) => ({ text });", "exports.execPrepared = (text, params) => ({ text, params });", ""].join("\n");

/** A fixture: an HTTP handler that builds a users query, and the database helper it calls. */
export const FIXTURES = {
  // db.raw sends the SQL text as written: the concatenated id becomes SQL.
  vulnerable: {
    "src/routes.js": ['const db = require("./db");', "", "// GET /users?id=<id>", "exports.getUser = (req, res) => {", '  const rows = db.raw("SELECT * FROM users WHERE id = " + req.query.id);', "  res.json(rows);", "};", ""].join("\n"),
    "src/db.js": DB(),
    "src/driver.js": DRIVER,
  },
  // The clean twin binds the id as a parameter.
  clean: {
    "src/routes.js": ['const db = require("./db");', "", "// GET /users?id=<id>", "exports.getUser = (req, res) => {", '  const rows = db.query("SELECT * FROM users WHERE id = ?", [req.query.id]);', "  res.json(rows);", "};", ""].join("\n"),
    "src/db.js": DB(),
    "src/driver.js": DRIVER,
  },
  // Looks like interpolation into SQL text, but the sql tag turns every interpolated value into a bind parameter.
  guarded: {
    "src/routes.js": ['const { sql, run } = require("./db");', "", "// GET /users?id=<id>", "exports.getUser = (req, res) => {", "  const rows = run(sql`SELECT * FROM users WHERE id = ${req.query.id}`);", "  res.json(rows);", "};", ""].join("\n"),
    "src/db.js": [
      'const driver = require("./driver");',
      "",
      "// sql`...`: each interpolated value becomes a numbered bind parameter, never SQL text.",
      "exports.sql = (strings, ...values) => {",
      "  const params = [];",
      '  const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? (params.push(values[i]), "$" + params.length) : ""), "");',
      "  return { text, params };",
      "};",
      "exports.run = (q) => driver.execPrepared(q.text, q.params);",
      "",
    ].join("\n"),
    "src/driver.js": DRIVER,
  },
};

function DB() {
  return [
    'const driver = require("./driver");',
    "",
    "// raw: sends the SQL text exactly as written.",
    "exports.raw = (text) => driver.exec(text);",
    "// query: parameterized; values never become SQL text.",
    "exports.query = (text, params) => driver.execPrepared(text, params);",
    "",
  ].join("\n");
}

// ---- reading the conversation -------------------------------------------------------------------------------------

/** The files this context read through the host tools: path -> lines (from the untrusted-data envelopes). */
function filesRead(request) {
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

/** The workspace paths a brief lists under a heading ("Subjects to examine", "Allowed context"). */
function listed(brief, heading) {
  const at = brief.indexOf(heading);
  if (at < 0) return [];
  const out = [];
  for (const l of brief.slice(at).split("\n").slice(1)) {
    const m = /^ {2}- (.+)$/.exec(l);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

const lineOf = (lines, re) => lines?.findIndex((l) => l !== undefined && re.test(l)) ?? -1;
const read = (paths) => ({ toolCalls: paths.map((p) => ({ name: "read_file", arguments: { path: p } })) });
const answer = (value) => ({ text: JSON.stringify(value), usage: { inputTokens: 100, outputTokens: 50 } });

/** What the routes file does with the request id (from the text this context read). */
function sinkOf(files) {
  const routes = files["src/routes.js"];
  if (!routes) return null;
  const concat = lineOf(routes, /db\.raw\(".*"\s*\+\s*req\.(query|params|body)\./);
  if (concat > 0) return { kind: "concatenation", line: concat, handler: lineOf(routes, /exports\.getUser/) };
  const template = lineOf(routes, /`SELECT[^`]*\$\{req\.(query|params|body)\./);
  if (template > 0) return { kind: "template", line: template, handler: lineOf(routes, /exports\.getUser/) };
  return null;
}

// ---- the records ----------------------------------------------------------------------------------------------------

function confirmedRecord(sink, dbLine) {
  const trace = [
    { kind: "entrypoint", file: "src/routes.js", line: sink.handler, scope: "GET /users getUser", description: "req.query.id comes from the unauthenticated request" },
    { kind: dbLine ? "propagation" : "sink", file: "src/routes.js", line: sink.line, scope: "getUser", description: sink.kind === "template" ? "the id is interpolated into the SQL text" : "the id is concatenated into the SQL text" },
  ];
  if (dbLine) trace.push({ kind: "sink", file: "src/db.js", line: dbLine, scope: "db.raw", description: "the text is executed as written" });
  return {
    fingerprint: FINGERPRINT,
    title: "SQL injection in GET /users",
    description: "The user id from the query string becomes part of the SQL text of the users query.",
    root_cause: "Request input is concatenated into SQL text instead of being bound as a parameter.",
    intended_behavior: "The id is only ever a bound value of the query.",
    impact: "An unauthenticated caller can read or change any row of the users table.",
    trace,
    evidence: [{ file: "src/routes.js", line: sink.line, description: "request input inside the SQL text" }, ...(dbLine ? [{ file: "src/db.js", line: dbLine, description: "raw executes the text unchanged" }] : [])],
    conditions: [{ kind: "authentication_level", description: "no authentication on GET /users" }],
    source_argument: "The handler reads req.query.id and passes it inside the SQL text; nothing on the path escapes or binds it.",
    remediation: { strategy: "Use db.query with a ? placeholder and pass the id as a parameter; add a regression test with a quote in the id." },
    severity: { likelihood: { score: "high", reason: "reachable by any caller" }, impact: { score: "high", reason: "cross-user data read and write" }, overall_severity: "high" },
    confidence: { score: "high", reason: "the whole path is in the source" },
  };
}

// ---- the script -----------------------------------------------------------------------------------------------------

/**
 * The fake auditor. Options: `coverageId` (the module's function), `hunterReads` (files the hunter reads),
 * `extraUnits` (raw units the planner also proposes), `critic` (the critic's answer), `requests` (filled with every
 * request, for assertions).
 */
export function fakeAuditor({ coverageId, hunterReads = ["src/routes.js", "src/db.js"], extraUnits = [], critic = null, requests = [] }) {
  const refs = { surface: "src/routes.js#GET /users", boundary: "src/db.js#bound parameters", subsystem: "src", attack_class: "ATTACK-CLASSES.md#Injection" };
  const unitId = coverageId(refs);
  return (request) => {
    requests.push(JSON.parse(JSON.stringify({ contextLabel: request.contextLabel, system: request.system, messages: request.messages, toolChoice: request.toolChoice, tools: request.tools.map((t) => t.name) })));
    const label = request.contextLabel;
    const stage = label.split(":")[0];
    const turn = request.messages.filter((m) => m.role === "assistant").length;
    const brief = request.messages[0].text;
    const files = filesRead(request);
    switch (stage) {
      case "reconnaissance": {
        if (turn === 0) return read([...listed(brief, "Subjects to examine"), ...listed(brief, "Allowed context")]);
        const surfaces = Object.entries(files).flatMap(([p, lines]) => {
          const i = lineOf(lines, /exports\.\w+ = \(req/);
          return i > 0 ? [{ surface: `${p} handler`, kind: "http", path: p, line: i, sinks: [] }] : [];
        });
        return answer({
          summary: "An HTTP handler reads a user id and queries the users table through a database helper.",
          product: { type: "HTTP API", users: "anonymous callers", trust_sensitive_actions: ["read users"], stack: ["node"], deployment_models: [], comparable: null },
          subsystems: [{ name: "src", paths: Object.keys(files) }],
          principals: [{ principal: "anonymous caller", actions: "GET /users" }],
          trust_boundaries: files["src/db.js"] ? [{ boundary: "SQL text vs bound values", control: { path: "src/db.js", line: 1 }, source_visible: true, description: "the helper decides whether values are bound" }] : [],
          entry_surfaces: surfaces,
          dangerous_operations: [],
          local_validation: { fixtures: [], prohibited_commands: [] },
          deployment_facts_unavailable: ["whether a proxy authenticates GET /users"],
          assumptions: ["the driver executes what it receives"],
          omissions: [],
          companions: [],
        });
      }
      case "coverage-planning":
        return answer({
          architecture: "## Product\nAn HTTP API with one handler, GET /users, reachable by anonymous callers.\n## Boundaries\nSQL text versus bound values in src/db.js.",
          companion_selection: [{ file: "WEB-PROTOCOL-AND-AUTH.md", selected: false, reason: "no session, cookie or federated identity in the source" }],
          units: [
            { canonical_refs: refs, surface: "GET /users", boundary: "bound parameters", subsystem: "src", attack_class: "Injection", starting_paths: ["src/routes.js", "src/db.js"], selected_companion_blocks: [], excluded_blocks: [{ block: "WEB-PROTOCOL-AND-AUTH.md#Ordinary CSRF", reason: "GET only, no ambient credentials" }], status: "planned", priority: 1, priority_rationale: "unauthenticated entry to the data store" },
            { canonical_refs: { ...refs, attack_class: "ATTACK-CLASSES.md#Cryptography and secrets" }, status: "not_applicable", reason: "no key, token or secret handling in the scope", starting_paths: ["src/routes.js"] },
            ...extraUnits,
          ],
        });
      case "hunting": {
        if (turn === 0) return read(hunterReads);
        const sink = sinkOf(files);
        const dbLine = sink?.kind === "concatenation" ? lineOf(files["src/db.js"], /exports\.raw = .*driver\.exec\(text\)/) : -1;
        const reviewed = Object.keys(files).sort();
        const check = { reviewed_paths: reviewed, invariant: "the request id is bound as a parameter, never SQL text", method: "source", result: sink ? `request input reaches the SQL text at src/routes.js:${sink.line}` : "the id is passed as a bound parameter", artifact: null };
        return answer({
          summary: sink ? "One injection candidate." : "The id is bound as a parameter.",
          units: [{ coverage_id: unitId, disposition: sink ? "candidate" : "covered", reviewed_paths: reviewed, checks: [check], candidate_fingerprints: sink ? [FINGERPRINT] : [], unresolved: [] }],
          candidates: sink ? [{ proposed_verdict: "confirmed", ...confirmedRecord(sink, dbLine > 0 ? dbLine : null) }] : [],
          hardening: [],
          uncovered: [],
        });
      }
      case "coverage-critic":
        return answer(critic ?? { summary: "Every entry point of the scope has a unit.", missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: true });
      case "refutation": {
        if (turn === 0) return read(["src/routes.js", "src/db.js"]);
        const sink = sinkOf(files);
        const db = files["src/db.js"] ?? [];
        const guard = lineOf(db, /params\.push\(values\[i\]\)/);
        if (sink?.kind === "template" && guard > 0) {
          return answer({
            decision: "rejected",
            record: {
              fingerprint: FINGERPRINT,
              title: "SQL injection in GET /users",
              description: "The id appears inside a template literal of the users query.",
              claimed_root_cause: "Request input interpolated into SQL text.",
              trace: [
                { kind: "entrypoint", file: "src/routes.js", line: sink.handler, scope: "GET /users getUser", description: "req.query.id from the request" },
                { kind: "sink", file: "src/db.js", line: guard, scope: "sql tag", description: "each interpolated value is pushed to params and replaced by a numbered placeholder" },
              ],
              evidence: [{ file: "src/db.js", line: guard, description: "the sql tag binds every interpolated value as a parameter ($n)" }],
              reason: `The sql tag (src/db.js:${guard}) turns the interpolated id into a bind parameter; the SQL text never contains request input.`,
            },
          });
        }
        const raw = lineOf(db, /exports\.raw = .*driver\.exec\(text\)/);
        if (sink?.kind === "concatenation" && raw > 0) return answer({ decision: "confirmed", record: confirmedRecord(sink, raw) });
        return answer({ decision: "needs_validation", record: { fingerprint: FINGERPRINT, title: "SQL injection in GET /users", description: "Undecided.", claimed_root_cause: "Request input in SQL text.", impact: "users table", priority: "high", trace: [{ kind: "sink", file: "src/routes.js", line: 1, scope: "module", description: "-" }], evidence: [{ file: "src/routes.js", line: 1, description: "-" }], blockers: ["the helper could not be read"], validation_plan: { local: "unit test with a quote in the id" } } });
      }
      case "verification": {
        if (turn === 0) return read(["src/routes.js", "src/db.js"]);
        return answer({ decision: "verified", fingerprint: FINGERPRINT, reason: "Re-read the handler and the helper: the trace and the evidence hold." });
      }
      default:
        return { text: "" };
    }
  };
}

/** Builds the security plan and runs one Semantic run with the registered security-audit module and the fake auditor. */
export async function runAudit(ws, { scope = null, rigor = "standard", budget = null, script, onEvent } = {}) {
  const { buildSemanticPlan, executeSemanticRun } = await load("core/semantic/index.js");
  const plan = buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env: ws.env, scope, rigor, budget, purpose: "security" });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.deepEqual(plan.methods.map((m) => m.id), ["security-audit"]);
  const result = await executeSemanticRun({ workspacePath: ws.dir, home: ws.home, env: ws.env, version: "0.0.0-test", plan, cancelPollMs: 50, investigation: { deps: { script } }, ...(onEvent ? { onEvent } : {}) });
  const outcome = result.semanticRun.outcome;
  const audit = (name) => path.join(result.runDir, "evidence", "security-audit", name);
  const json = (name) => JSON.parse(fs.readFileSync(audit(name), "utf8"));
  return { plan, result, outcome, investigation: outcome.investigation, audit, json };
}
