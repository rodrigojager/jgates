// Fixtures and deterministic scripted models of the complementary Semantic methods B (property reasoning, post-patch
// validation, supply-chain assessment), the method selection of `jgates semantic` and the generated regressions
// (jgates/tests/semantic-complementary-b.test.js, tests/v2/v2-20-generated-regression.mjs). In-process scripts answer
// from what each context read through the host tools; CLI runs use JSON tool scripts of the mock provider
// (SEMANTIC_GATE_MOCK_TOOL_SCRIPT). No test spends model tokens.
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, load, setupWorkspace } from "../semantic-executor/helpers.mjs";
import { answer, filesRead, forbidden, lineOf, read, recorder, runModule } from "../complementary-a/analyst.mjs";

export { ROOT, load, setupWorkspace, answer, filesRead, forbidden, lineOf, read, recorder, runModule };
export const MAIN = path.join(ROOT, "jgates", "dist", "cli", "main.js");
const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = here;

// ---- the pagination fixture (a boundary bug: one item too many per page) -------------------------------------------

export const PAGINATE_BAD = ["// One page of a list (pages are 1-based).", "exports.pageItems = (items, page, size) => {", "  const start = (page - 1) * size;", "  const end = start + size + 1;", "  return items.slice(start, end);", "};", ""].join("\n");
export const PAGINATE_GOOD = PAGINATE_BAD.replace("start + size + 1", "start + size");
/** The line of the faulty bound in PAGINATE_BAD. */
export const BOUND_LINE = 4;

/** The property test the scripted analyst proposes (it lives at .jgates/regressions/<name>). */
export const PROPERTY_TEST = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { createRequire } from "node:module";',
  "",
  "const require = createRequire(import.meta.url);",
  'const { pageItems } = require("../../src/paginate.js");',
  "",
  'test("every page holds at most size items and the pages cover the list exactly once", () => {',
  "  const items = Array.from({ length: 23 }, (_, i) => i);",
  "  for (const size of [1, 2, 5, 10]) {",
  "    const seen = [];",
  "    for (let page = 1; page <= Math.ceil(items.length / size); page++) {",
  "      const got = pageItems(items, page, size);",
  "      assert.ok(got.length <= size, `page ${page} of size ${size} has ${got.length} items`);",
  "      seen.push(...got);",
  "    }",
  "    assert.deepEqual(seen, items);",
  "  }",
  "});",
  "",
].join("\n");
export const PROPERTY_TEST_NAME = "paginate-pages.test.mjs";

const INVARIANT = {
  id: "I1",
  kind: "boundary",
  target: { path: "src/paginate.js", line: BOUND_LINE },
  statement: "for every list, page >= 1 and size >= 1, pageItems returns at most size items and consecutive pages never overlap",
  domain: "lists of any length, 1-based page numbers, positive sizes",
  status: "violated",
  severity: "important",
  counterexample: { input: "items = [0..22], page = 1, size = 5", expected: "[0, 1, 2, 3, 4] (5 items)", observed_by_reading: "end = start + size + 1, so slice returns 6 items and page 2 repeats item 5" },
  test: { name: PROPERTY_TEST_NAME, content: PROPERTY_TEST },
};
const FALSIFY = { candidateId: "C1", confirmation: "confirmed", reason: "end adds one past start + size and nothing caps the slice, so every page returns size + 1 items.", evidence: [{ path: "src/paginate.js", line: BOUND_LINE, note: "end = start + size + 1" }], counterexample_holds: true };

/** The property analyst as a JSON tool script (for CLI runs): reads the subjects, states the violated invariant with its test, and the challenge confirms it. */
export function propertyScript(subjects) {
  return {
    contexts: {
      invariants: [read(subjects), answer({ summary: "One pagination helper with an inclusive end bound.", invariants: [INVARIANT], uncovered: [] })],
      falsify: [read(["src/paginate.js"]), answer(FALSIFY)],
    },
  };
}

/** The property analyst in-process: it decides from what it read (the bound line it finds), not from the test. */
export function propertyAnalyst(subjects) {
  return recorder((stage, request, turn) => {
    if (stage === "invariants") {
      if (turn === 0) return read(subjects);
      const lines = filesRead(request)["src/paginate.js"];
      const line = lineOf(lines, /const end = start \+ size/);
      const violated = /\+ size \+ 1/.test(lines?.[line] ?? "");
      return answer({
        summary: "Pagination bound examined.",
        invariants: [{ ...INVARIANT, target: { path: "src/paginate.js", line }, status: violated ? "violated" : "holds", ...(violated ? {} : { counterexample: null }) }],
        uncovered: [],
      });
    }
    if (stage === "falsify") {
      if (turn === 0) return read(["src/paginate.js"]);
      const lines = filesRead(request)["src/paginate.js"];
      return answer({ ...FALSIFY, evidence: [{ path: "src/paginate.js", line: lineOf(lines, /const end = start \+ size/), note: "the end bound" }] });
    }
    return { text: "" };
  });
}

// ---- post-patch fixtures ----------------------------------------------------------------------------------------------

export const FORMAT = ["exports.label = (n) => `Item ${n}`;", ""].join("\n");
export const FORMAT_BROKEN = ["exports.label = (n) => `#${n}`;", ""].join("\n");
export const FORMAT_TEST = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { createRequire } from "node:module";',
  "",
  "const require = createRequire(import.meta.url);",
  'const { label } = require("../src/format.js");',
  "",
  'test("labels name the item", () => {',
  '  assert.equal(label(3), "Item 3");',
  "});",
  "",
].join("\n");

/** The post-patch analyst: reads the patch and the nearby test, proposes the reproducer; the assessment confirms what the host observed. */
export function postPatchAnalyst({ reproducer = PROPERTY_TEST } = {}) {
  return recorder((stage, request, turn, brief) => {
    if (stage === "reproducer") {
      if (turn === 0) return read(["src/paginate.js", "src/format.js", "test/format.test.mjs"]);
      const lines = filesRead(request)["src/paginate.js"];
      return answer({
        summary: "The patch changes the end bound of pageItems.",
        defect: "pageItems returns size + 1 items per page",
        target: { path: "src/paginate.js", line: Math.max(1, lineOf(lines, /const end/)) },
        reproducer: { source: "proposed", name: PROPERTY_TEST_NAME, content: reproducer },
        neighbours: ["test/format.test.mjs"],
      });
    }
    if (stage === "assessment") {
      const p = /"path": "([^"]+)"/.exec(brief)?.[1];
      const id = /"candidateId": "([^"]+)"/.exec(brief)?.[1];
      if (turn === 0) return read([p]);
      return answer({ candidateId: id, confirmation: "confirmed", reason: "The execution records show the failure and the code read explains it.", evidence: [{ path: p, line: 1, note: "read" }], cause: "patch" });
    }
    return { text: "" };
  });
}

// ---- supply chain -----------------------------------------------------------------------------------------------------

export const PACKAGE_JSON = JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "left-pad": "1.3.0", "native-thing": "2.0.0" } }, null, 2) + "\n";
export const LOCK_WITH_SCRIPT =
  JSON.stringify(
    {
      name: "app",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "app", version: "1.0.0", dependencies: { "left-pad": "1.3.0", "native-thing": "2.0.0" } },
        "node_modules/left-pad": { version: "1.3.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", integrity: "sha512-abc" },
        "node_modules/native-thing": { version: "2.0.0", resolved: "https://registry.npmjs.org/native-thing/-/native-thing-2.0.0.tgz", integrity: "sha512-def", hasInstallScript: true },
      },
    },
    null,
    2,
  ) + "\n";
export const LOCK_CLEAN = LOCK_WITH_SCRIPT.replace(',\n      "hasInstallScript": true', "");

export function supplyAnalyst() {
  return recorder((stage, request, turn, brief) => {
    if (stage === "interpret") {
      if (turn === 0) return read(["package-lock.json", "package.json"]);
      const lines = filesRead(request)["package-lock.json"];
      const id = /"id": "(S\d+)"/.exec(brief)?.[1] ?? "S1";
      return answer({
        summary: "One package runs an install script.",
        signals: [{ signal_id: id, assessment: "risk", reason: "native-thing runs code at install time on every developer and CI machine; nothing pins or reviews the script.", read: ["package-lock.json"] }],
        candidates: [{ title: "native-thing runs an install script", path: "package-lock.json", line: lineOf(lines, /hasInstallScript/), severity: "important", rationale: "An install script executes with the installer's rights.", signal_ids: [id], risk: "install-time-execution" }],
      });
    }
    if (stage === "verify") {
      const id = /"candidateId": "([^"]+)"/.exec(brief)?.[1];
      if (turn === 0) return read(["package-lock.json"]);
      const lines = filesRead(request)["package-lock.json"];
      return answer({ candidateId: id, confirmation: "confirmed", reason: "The lockfile marks the package with an install script; no configuration disables scripts.", evidence: [{ path: "package-lock.json", line: lineOf(lines, /hasInstallScript/), note: "hasInstallScript" }], exposure: "install-time", mitigation: "install with --ignore-scripts or pin and review the script" });
    }
    return { text: "" };
  });
}

// ---- IDOR scripts for the CLI (static JSON: the fixture's lines are known) --------------------------------------------

const DIMENSIONS = ["functional-correctness", "tests", "maintainability", "architecture", "performance-reliability", "security"];
/** The general review that confirms the IDOR of src/routes/orders.js (line 5: the lookup by request id). */
export function priorReviewScript() {
  const files = ["src/routes/orders.js"];
  return {
    contexts: {
      "evidence-planning": [read(files), answer({ summary: "One order route.", dimensions: DIMENSIONS.map((id) => ({ id, files, hypotheses: id === "security" ? ["GET /orders/:id returns any order to any caller"] : [] })) })],
      hunting: [
        read(files),
        answer({
          summary: "The order route loads by id without an ownership check.",
          dimensions: DIMENSIONS.map((id) => ({ id, state: "examined", reviewed_paths: files, checks: [`read the handler for ${id}`] })),
          candidates: [{ title: "IDOR: GET /orders/:id returns another user's order", path: "src/routes/orders.js", line: 5, severity: "blocking", category: "security", rationale: "The order is loaded by the request id and returned without comparing its ownerId to req.user.id (missing ownership check).", hypothesis: "GET /orders/:id returns any order to any caller" }],
        }),
      ],
      challenge: [read(files), answer({ candidateId: "C1", confirmation: "confirmed", reason: "Nothing between the lookup and the response compares the record owner with the caller.", evidence: [{ path: "src/routes/orders.js", line: 5, note: "lookup by request id, returned unchecked" }] })],
    },
  };
}

/** Variant analysis from the confirmed seed: invoices is the variant (confirmed), documents is guarded (rejected). */
export function variantScript() {
  const all = ["src/routes/orders.js", "src/routes/invoices.js", "src/routes/documents.js", "src/db.js", "jgates.yml"];
  const variant = (p) => ({ title: `Same missing ownership check in ${p}`, path: p, line: 5, severity: "blocking", rationale: "A record is loaded by the request id like the seed.", seed_id: "S1", axis: "lookup-by-request-id", level: 1, missing_protection: "record.ownerId === req.user.id" });
  return {
    contexts: {
      "root-cause": [
        read(all),
        answer({ summary: "The seed returns a record loaded by request id without an ownership comparison.", seeds: [{ seed_id: "S1", reproduced: true, root_cause: "the request id reaches db.find and the record is returned without comparing record.ownerId to req.user.id", exact_match: { path: "src/routes/orders.js", line: 5 }, axes: [{ id: "lookup-by-request-id", description: "handlers that load a record by req.params.id", constructs: ["db.find(", "req.params.id"], leads: ["src/routes/invoices.js", "src/routes/documents.js"] }] }] }),
      ],
      sweep: [read(all), answer({ summary: "2 variant candidates.", axes: [{ id: "lookup-by-request-id", state: "searched", patterns: [{ level: 1, pattern: "db.find($T, req.params.id)", matches: 3, noise: 0 }] }], candidates: [variant("src/routes/invoices.js"), variant("src/routes/documents.js")] })],
      "triage:C1": [read(["src/routes/invoices.js"]), answer({ candidateId: "C1", confirmation: "confirmed", reason: "Loaded by request id and returned with no ownership comparison, like the seed.", evidence: [{ path: "src/routes/invoices.js", line: 5, note: "lookup by request id" }], severity: "blocking", reachable: true, controllable: true, unprotected: true, confidence: "high" })],
      "triage:C2": [read(["src/routes/documents.js"]), answer({ candidateId: "C2", confirmation: "rejected", reason: "The handler compares the record owner with the caller first.", evidence: [{ path: "src/routes/documents.js", line: 7, note: "ownership check" }], safe_reason: "ownership check before the response", reachable: true, controllable: true, unprotected: false, confidence: "high" })],
    },
  };
}

// ---- running the CLI --------------------------------------------------------------------------------------------------

/** A CLI runner for a workspace: each call may name its own JSON tool script (written next to the workspace). */
export function cliFor(ws) {
  let n = 0;
  return (args, { script, env = {} } = {}) => {
    const extra = {};
    if (script) {
      const file = path.join(ws.root, `script-${++n}.json`);
      fs.writeFileSync(file, JSON.stringify(script));
      extra.SEMANTIC_GATE_MOCK_TOOL_SCRIPT = file;
    }
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...ws.env, JGATES_NO_CACHE: "1", ...extra, ...env }, input: "", timeout: 240_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
}

/** sha256 of every file under a folder (relative path and content), skipping .git: proves a tree did not change. */
export function treeHash(dir) {
  const h = crypto.createHash("sha256");
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".git") continue;
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(next);
      else h.update(`${next}\0`).update(fs.readFileSync(path.join(dir, next))).update("\0");
    }
  };
  walk("");
  return h.digest("hex");
}

/** The Semantic runs of a workspace's data folder with the provider calls each one recorded. */
export function semanticRuns(home) {
  const out = [];
  const root = path.join(home, "workspaces");
  for (const ws of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, ws, "semantic-runs");
    for (const run of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      let calls = 1;
      try {
        calls = Number(JSON.parse(fs.readFileSync(path.join(dir, run, "result.json"), "utf8")).semanticRun?.outcome?.calls ?? 0);
      } catch {
        // A run without a readable result cannot prove it made no call.
      }
      out.push({ runId: run, calls });
    }
  }
  return out;
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
