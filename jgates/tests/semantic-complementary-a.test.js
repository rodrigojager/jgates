// Complementary Semantic methods A (differential review, variant analysis, insecure defaults, cross-component
// reasoning), the applicability check of the executor, the vendored Trail of Bits material and the root-cause
// correlation. Every model answer is scripted through the real executor and the mock provider; no test spends tokens.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = pathToFileURL(path.resolve(here, "..", "..", "tests", "v2", "fixtures", "complementary-a", "analyst.mjs")).href;
const { IDOR, forbidden, load, priorReviewer, recorder, read, answer, filesRead, runModule, setupWorkspace, variantAnalyst } = await import(FIX);
const modules = await load("core/semantic-modules/index.js");
const { checkPack } = await load("core/distribution/index.js");
const correlation = await load("core/correlation/index.js");
const VENDOR = path.resolve(here, "..", "vendor", "trailofbits-skills");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("the four complementary methods are registered, each with its documented provenance", () => {
  const registered = modules.registeredInvestigationModules();
  for (const [method, id] of [["differential-review", "differential-review"], ["variant-analysis", "variant-analysis"], ["insecure-defaults", "insecure-defaults"], ["cross-component", "cross-component"]]) {
    assert.ok(registered.some((m) => m.methodId === method && m.module === id), method);
  }
  assert.deepEqual(modules.unavailableModules, []);
  for (const m of [modules.differentialReview.differentialReviewModule(), modules.variantAnalysis.variantAnalysisModule(), modules.insecureDefaults.insecureDefaultsModule()]) {
    assert.equal(m.provenance.upstream, "https://github.com/trailofbits/skills");
    assert.equal(m.provenance.revision, "e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff");
    assert.equal(m.provenance.spdx, "CC-BY-SA-4.0");
    assert.equal(typeof m.applicability, "function");
  }
  assert.equal(modules.crossComponent.crossComponentModule().provenance.origin, "original JGates method");
});

test("variant analysis: a route confirmed as IDOR by an earlier run leads to the sibling route with the same missing ownership check; the guarded route is rejected by triage", async () => {
  const ws = setupWorkspace("complementary-variant", IDOR);
  try {
    // The earlier review: a general review that confirms the IDOR in orders only.
    const prior = priorReviewer();
    const first = await runModule(ws, modules.generalReview.generalReviewModule(), { script: prior.script });
    const seed = first.investigation.candidates.find((c) => c.path === "src/routes/orders.js");
    assert.equal(seed?.status, "confirmed", JSON.stringify(first.investigation.candidates));
    assert.equal(first.investigation.candidates.length, 1, "the earlier review found only the orders route");

    // The variant run picks the confirmed root cause from the history and searches the whole scope.
    const analyst = variantAnalyst();
    const { result, outcome, investigation } = await runModule(ws, modules.variantAnalysis.variantAnalysisModule(), { script: analyst.script });
    assert.equal(outcome.state, "completed", JSON.stringify(outcome.reason));
    assert.equal(investigation.module.id, "variant-analysis");
    assert.equal(investigation.applicability.state, "applicable");
    assert.equal(investigation.applicability.seeds[0].source.runId, first.result.runId);
    assert.equal(investigation.applicability.seeds[0].path, "src/routes/orders.js");

    // The root-cause stage was briefed with the seed and calibrated on it.
    const rootBrief = analyst.requests.find((r) => r.contextLabel === "root-cause").messages[0].text;
    assert.match(rootBrief, /Confirmed seeds/);
    assert.match(rootBrief, /IDOR: GET \/orders\/:id/);

    const byPath = Object.fromEntries(investigation.candidates.map((c) => [c.path, c]));
    assert.deepEqual(Object.keys(byPath).sort(), ["src/routes/documents.js", "src/routes/invoices.js"], "the seed itself is never a variant");
    const sibling = byPath["src/routes/invoices.js"];
    assert.equal(sibling.status, "confirmed");
    assert.equal(sibling.category, "variant");
    assert.equal(sibling.line, 5);
    assert.equal(sibling.details.seed_id, "S1");
    assert.equal(sibling.details.verdict.unprotected, true);
    assert.equal(sibling.validation.context, "triage:" + sibling.id, "triaged in its own fresh context");
    const triage = analyst.requests.filter((r) => r.contextLabel === `triage:${sibling.id}`);
    assert.equal(triage[0].messages.length, 1, "a fresh context: only its brief");
    const guarded = byPath["src/routes/documents.js"];
    assert.equal(guarded.status, "rejected");
    assert.equal(guarded.validation.evidence[0].line, 7, "the rejection cites the ownership check");

    // Evidence: seeds with their source run, the methodology table, variants and false positives by reason.
    const doc = readJson(path.join(result.runDir, modules.variantAnalysis.VARIANTS_FILE));
    assert.equal(doc.seeds[0].source.runId, first.result.runId);
    assert.equal(doc.seeds[0].analysis.reproduced, true);
    assert.equal(doc.methodology[0].state, "searched");
    assert.deepEqual(doc.falsePositives, [{ reason: "ownership check before the response", locations: ["src/routes/documents.js:5"] }]);
    assert.ok(result.findings.some((f) => f.location?.path === "src/routes/invoices.js"));

    // The confirmed variant and its seed share the root-cause key: the correlation groups them, the rejected one too,
    // each with its own validation state.
    const report = correlation.correlateRunDirs([first.result.runDir, result.runDir]);
    const group = report.groups.find((g) => g.members.some((m) => m.location.path === "src/routes/invoices.js"));
    assert.deepEqual(group.members.map((m) => [m.location.path, m.validation.state, m.method]).sort(), [
      ["src/routes/documents.js", "rejected", "variant-analysis"],
      ["src/routes/invoices.js", "confirmed", "variant-analysis"],
      ["src/routes/orders.js", "confirmed", "general-review"],
    ]);
    assert.equal(group.disagreement, true, "a rejected look-alike next to confirmed ones is shown, not merged away");
  } finally {
    ws.cleanup();
  }
});

test("each complementary method reports not applicable with the reason when its required input is missing, and sends nothing", async () => {
  // A single file, no configuration, no history, a full scope (no comparison baseline).
  const ws = setupWorkspace("complementary-na", { "src/math.js": "exports.add = (a, b) => a + b;\n" });
  try {
    const cases = [
      [modules.differentialReview.differentialReviewModule(), "DIFFERENTIAL_NO_BASELINE", "comparison baseline", /comparison baseline/],
      [modules.variantAnalysis.variantAnalysisModule(), "VARIANT_NO_CONFIRMED_ROOT_CAUSE", "confirmed root cause", /confirmed root cause/],
      [modules.insecureDefaults.insecureDefaultsModule(), "INSECURE_DEFAULTS_NO_CONFIGURATION", "configuration files", /configuration or initialization paths/],
      [modules.crossComponent.crossComponentModule(), "CROSS_COMPONENT_SINGLE_COMPONENT", "multi-component flow", /at least two components/],
    ];
    for (const [module, code, missing, reason] of cases) {
      const model = forbidden();
      const { result, outcome, investigation } = await runModule(ws, module, { script: model.script });
      assert.deepEqual(model.calls, [], `${module.id}: nothing was sent`);
      assert.equal(outcome.state, "unavailable", module.id);
      assert.equal(outcome.code, "METHOD_NOT_APPLICABLE", module.id);
      assert.match(outcome.reason, reason, module.id);
      assert.equal(outcome.calls, 0);
      assert.deepEqual({ state: investigation.applicability.state, code: investigation.applicability.code, missing: investigation.applicability.missing }, { state: "not-applicable", code, missing });
      assert.ok(investigation.stages.every((s) => s.state === "not-run" && s.reason.startsWith("not applicable:")), module.id);
      assert.equal(investigation.complete, false);
      assert.notEqual(result.decision, "passed", "not applicable is never favorable");
      assert.equal(readJson(path.join(result.runDir, "evidence", "investigation.json")).applicability.code, code);
    }
  } finally {
    ws.cleanup();
  }
});

test("differential review: the host gives the removed guard, the security commit that added it and the callers beyond the diff; the regression is confirmed in a fresh context", async () => {
  const app = ['const orders = require("./routes/orders");', "", "exports.mount = (app) => {", '  app.get("/orders/:id", orders.getOrder);', "};", ""].join("\n");
  const ws = setupWorkspace("complementary-diff", { "src/db.js": IDOR["src/db.js"], "src/app.js": app, "src/routes/orders.js": IDOR["src/routes/orders.js"] });
  try {
    const guarded = IDOR["src/routes/documents.js"].replaceAll("documents", "orders").replace("getDocument", "getOrder");
    fs.writeFileSync(path.join(ws.dir, "src/routes/orders.js"), guarded);
    ws.git("commit", "-q", "-am", "fix(security): check order ownership");
    const base = ws.git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(ws.dir, "src/routes/orders.js"), IDOR["src/routes/orders.js"]);
    ws.git("commit", "-q", "-am", "refactor: simplify order handler");

    const model = recorder((stage, request, turn, brief) => {
      if (stage === "triage") {
        if (turn === 0) return read(["src/routes/orders.js"]);
        return answer({ summary: "The ownership check was removed.", files: [{ path: "src/routes/orders.js", risk: "HIGH", reason: "removes the ownership check added by a security fix", hypotheses: ["any caller reads any order"] }] });
      }
      if (stage === "analysis") {
        if (turn === 0) return read(["src/routes/orders.js", "src/app.js"]);
        const find = filesRead(request)["src/routes/orders.js"].findIndex((l) => l && l.includes("db.find("));
        return answer({
          summary: "Regression of the ownership check.",
          files: [{ path: "src/routes/orders.js", state: "analyzed", callers_checked: ["src/app.js"], tests: [], notes: ["BEFORE: ownerId compared to req.user.id; AFTER: no comparison; the GET /orders/:id mount still exposes it"] }],
          candidates: [{ title: "Removed ownership check re-opens IDOR on GET /orders/:id", path: "src/routes/orders.js", line: find, severity: "blocking", rationale: "The security fix's guard is gone.", change_path: "src/routes/orders.js", kind: "regression", scenario: { goal: "read another user's order", preconditions: "authenticated user", steps: ["GET /orders/<other id>"], why: "the ownership comparison was removed", impact: "cross-user data read" } }],
        });
      }
      if (stage === "challenge") {
        if (turn === 0) return read(["src/routes/orders.js", "src/app.js"]);
        const id = /"candidateId": "([^"]+)"/.exec(brief)[1];
        return answer({ candidateId: id, confirmation: "confirmed", reason: "No other layer compares the owner.", evidence: [{ path: "src/routes/orders.js", line: 5, note: "unchecked lookup" }, { path: "src/app.js", line: 4, note: "mounted for every caller" }] });
      }
      return { text: "" };
    });
    const { result, outcome, investigation } = await runModule(ws, modules.differentialReview.differentialReviewModule(), { script: model.script, scope: { mode: "incremental", base } });
    assert.equal(outcome.state, "completed", JSON.stringify(outcome.reason));
    const brief = model.requests.find((r) => r.contextLabel === "triage").messages[0].text;
    assert.match(brief, /ownerId !== req\.user\.id/, "the removed guard is in the brief");
    assert.match(brief, /fix\(security\): check order ownership/, "with the commit that introduced it");
    assert.match(brief, /"path": "src\/app\.js"/, "and its caller beyond the diff");
    const [c] = investigation.candidates;
    assert.equal(c.status, "confirmed");
    assert.equal(c.details.kind, "regression");
    const doc = readJson(path.join(result.runDir, modules.differentialReview.DIFFERENTIAL_FILE));
    assert.equal(doc.baseline.commit, base);
    assert.equal(doc.changes[0].removedProtections[0].history[0].subject, "fix(security): check order ownership");
    assert.deepEqual(doc.changes[0].callers.map((x) => x.path), ["src/app.js"]);
  } finally {
    ws.cleanup();
  }
});

test("insecure defaults and cross-component find their inputs on the host: seed matches, configuration readers, components and their relations", () => {
  const files = {
    "config/settings.js": 'exports.secret = process.env.SESSION_SECRET || "dev-secret";\nexports.requireAuth = getenv("REQUIRE_AUTH", "false");\n',
    "src/api/orders.js": 'const auth = require("../auth/check");\nexports.list = (req) => auth.allowed(req);\n',
    "src/auth/check.js": "exports.allowed = (req) => !!req.user;\n",
    "tests/orders.test.js": 'require("../src/api/orders");\n',
  };
  const input = { readableFiles: () => Object.keys(files), readFile: (p) => files[p] ?? null };
  const { categories } = modules.complementaryVendor.loadInsecureCategories();
  const facts = modules.insecureDefaults.defaultsFacts(input, categories);
  assert.deepEqual(facts.initializationFiles, ["config/settings.js"]);
  assert.ok(facts.seedMatches["fallback-secrets"].some((m) => m.path === "config/settings.js" && m.line === 1));
  assert.ok(facts.seedMatches["fail-open-security"].some((m) => m.path === "config/settings.js" && m.line === 2));
  assert.equal(JSON.stringify(facts).includes("dev-secret"), false, "quoted literals of matched lines never reach a brief");
  const comp = modules.crossComponent.componentFacts(input);
  assert.deepEqual(comp.components.map((c) => c.id), ["config", "src/api", "src/auth"]);
  assert.deepEqual(comp.edges, [{ from: "src/api/orders.js", to: "src/auth/check.js", via: "../auth/check", line: 1 }]);
});

test("the vendored Trail of Bits material records URL, commit, CC-BY-SA-4.0, obligations and modifications and passes the distribution check", () => {
  const report = checkPack(VENDOR);
  assert.deepEqual(report.problems, []);
  assert.equal(report.ok, true);
  const record = readJson(path.join(VENDOR, "jgates-pack.json"));
  assert.equal(record.source.url, "https://github.com/trailofbits/skills");
  assert.equal(record.source.revision, "e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff");
  assert.equal(record.spdx, "CC-BY-SA-4.0");
  assert.match(record.modifications, /adapted from/);
  assert.ok(record.obligations.attribution && record.obligations.shareAlike);
  assert.match(fs.readFileSync(path.join(VENDOR, "LICENSE"), "utf8"), /Attribution-ShareAlike 4\.0 International/);
  const notice = fs.readFileSync(path.join(VENDOR, "NOTICE.md"), "utf8");
  for (const s of ["https://github.com/trailofbits/skills", "e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff", "CC BY-SA 4.0", "ShareAlike", "What changed"]) assert.ok(notice.includes(s), s);
  // Without its ShareAlike obligations the same pack is refused.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-sharealike-"));
  try {
    fs.cpSync(VENDOR, tmp, { recursive: true });
    const { obligations: _o, artifact: _a, ...rest } = record;
    fs.writeFileSync(path.join(tmp, "jgates-pack.json"), JSON.stringify(rest));
    const refused = checkPack(tmp);
    assert.equal(refused.ok, false);
    assert.ok(refused.problems.some((p) => p.code === "PROVENANCE_INCOMPLETE" && /ShareAlike/.test(p.detail) && /obligations\.attribution/.test(p.detail)), JSON.stringify(refused.problems));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("root-cause correlation keeps unknown-class findings apart and never relabels a validation state", () => {
  const members = [
    ...correlation.qualityMembers({ runId: "run_a", findings: [{ tool: "eslint", ruleId: "no-unused-vars", message: "x is unused", location: { path: "a.js", line: 3 }, waived: false }, { tool: "codeql", ruleId: "js/path-injection", message: "Uncontrolled data used in path expression (path traversal)", location: { path: "b.js", line: 9 }, waived: true, waiverReason: "accepted" }] }),
    ...correlation.semanticMembers({ runId: "sem_b", gate: "semantic", semanticRun: { outcome: { investigation: { module: { id: "general-review" }, candidates: [{ id: "C1", title: "Unused variable x", path: "a.js", line: 3, category: "maintainability", status: "needs-validation" }, { id: "C2", title: "Path traversal in download", path: "b.js", line: 10, category: "security", status: "rejected", validation: { context: "challenge:C2", reason: "normalized", evidence: [] } }] } } } }),
  ];
  const report = correlation.correlateMembers(members);
  assert.equal(report.members, 4);
  const sizes = report.groups.map((g) => g.members.length).sort();
  assert.deepEqual(sizes, [1, 1, 2], "same-line unknown-class findings stay apart; the path traversal pair is one group");
  const pair = report.groups.find((g) => g.members.length === 2);
  assert.equal(pair.rootCause.class, "path-traversal");
  assert.deepEqual(pair.members.map((m) => m.validation.state).sort(), ["rejected", "waived"]);
});
