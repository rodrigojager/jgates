import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DIST, importDist, setupSequenceProject, waitFor } from "./fixtures/sequence/helpers.mjs";

// V2-31: the Semantic/AI area is a separate area of the application. The built UI bundle registers its own screens
// (configuration, setup, run, results, history) under the `semantic` area, apart from the Quality validations. Through the
// server routes those screens call, a Semantic run started from the setup is followed on its run screen (state, events,
// AI mascots projected from the run's own stage records) and lands in the Semantic history, never in the Quality history;
// and in a sequence of both gates the Quality mascot snapshot carries only Quality domains, with no Semantic stage.

/** The `screen` metadata of every screen and the navigation areas, read from the built entry chunk of the UI. */
function builtRegistry() {
  const uiDir = path.join(DIST, "ui");
  const html = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");
  const entry = html.match(/<script[^>]+src="\/?([^"]+\.js)"/);
  assert.ok(entry, "the built index.html loads an entry script");
  const code = fs.readFileSync(path.join(uiDir, entry[1]), "utf8");
  const literal = (text) => new Function(`return (${text});`)();
  const screens = [...code.matchAll(/screen:(\{[^{}]*\})/g)].map((m) => literal(m[1]));
  const areas = [...code.matchAll(/\{id:[`"'](\w+)[`"'],path:[`"']([^`"']+)[`"'],label:[`"'](\w+)[`"'],icon:[`"']([\w-]+)[`"'],block:[`"'](\w+)[`"']\}/g)].map((m) => ({ id: m[1], path: m[2], label: m[3], block: m[5] }));
  return { screens, areas };
}

const SEMANTIC_ROUTES = {
  "semantic-history": "/semantic",
  "semantic-config": "/semantic/config",
  "semantic-setup": "/semantic/setup",
  "semantic-run": "/semantic/runs/:id",
  "semantic-results": "/semantic/results/:id",
};

test("V2-31: the Semantic/AI area has its own screens and runs, and Quality mascots never show Semantic stages", async () => {
  // 1. The built bundle's screen registry: a separate area with config/setup/run/results/history routes.
  const { screens, areas } = builtRegistry();
  assert.ok(screens.length >= 20, `the registry lists the screens (${screens.length})`);
  const semanticArea = areas.find((a) => a.id === "semantic");
  assert.deepEqual(semanticArea && { path: semanticArea.path, block: semanticArea.block }, { path: "/semantic", block: "semantic" }, "the semantic area has its own block");
  const validationsArea = areas.find((a) => a.id === "validations");
  assert.equal(validationsArea?.block, "quality", "the Quality area stays in its own block");
  for (const [id, route] of Object.entries(SEMANTIC_ROUTES)) {
    const meta = screens.find((s) => s.id === id);
    assert.ok(meta, `screen ${id} is registered`);
    assert.equal(meta.path, route, `${id} route`);
    assert.equal(meta.area, "semantic", `${id} belongs to the semantic area`);
  }
  // No Semantic screen sits in the Quality area, and no Quality screen in the Semantic area.
  assert.ok(screens.filter((s) => s.area === "validations").every((s) => !s.path.startsWith("/semantic")));
  assert.ok(screens.filter((s) => s.area === "semantic").every((s) => s.path === "/semantic" || s.path.startsWith("/semantic/")));

  // 2. The routes the screens call, on a real workspace with a scripted (token-free) reviewer.
  const p = setupSequenceProject({ prefix: "v2-31" });
  try {
    const version = JSON.parse(fs.readFileSync(path.join(DIST, "..", "package.json"), "utf8")).version;
    const server = await p.server(version);
    const modules = await Promise.all(["semantic-views.js", "semantic-runs.js", "semantic-scope.js", "history.js", "sequence.js"].map((f) => importDist("server", "routes", f)));
    const all = modules.flatMap((m) => m.routes);
    const call = async (method, routePath, { params = {}, query = {}, body } = {}) => {
      const route = all.find((r) => r.method === method && r.path === routePath);
      assert.ok(route, `route ${method} ${routePath} exists`);
      return route.handler({ params, query, body, server });
    };
    const { mascotForStage, SEMANTIC_MASCOTS } = await importDist("core", "semantic-mascots", "index.js");
    const { MASCOT_DOMAINS } = await importDist("core", "mascots", "index.js");

    // Configuration and setup screens: options, then the impact/context preview (nothing started, nothing written).
    const options = (await call("GET", "/api/semantic/options", { query: { purpose: "general-review" } })).json;
    assert.equal(options.settings.state, "configured");
    assert.equal(options.settings.provider, "mock");
    assert.ok(options.methods.length > 0, "the purpose plans its modules");
    assert.deepEqual(options.rigors.map((r) => r.id), ["quick", "standard", "deep"]);
    assert.ok(options.rigors.every((r) => r.reserve > 0 && r.reserve < 1), "each rigor has a validation reserve");
    const choices = { purpose: "general-review", rigor: "quick", scope: { mode: "full", context: { policy: "strict" } } };
    const preview = (await call("POST", "/api/semantic/scope/preview", { body: choices })).json;
    assert.equal(preview.ready, true, JSON.stringify(preview.blockers));
    assert.equal(preview.resolution.mode, "full");
    assert.ok(preview.resolution.subjects.length > 0, "the preview lists the subjects");
    const semanticDir = path.join(p.home, "workspaces", server.workspace.id, "semantic-runs");
    assert.ok(!fs.existsSync(semanticDir) || fs.readdirSync(semanticDir).length === 0, "the preview starts no run");

    // Start from the setup screen, then follow it as the run screen does.
    const started = await call("POST", "/api/semantic/runs", { body: choices });
    assert.equal(started.status, 202);
    const runId = started.json.run.runId;
    assert.match(runId, /^sem_/);
    const seen = [];
    let cursor = 0;
    let events = [];
    await waitFor(async () => {
      const page = (await call("GET", "/api/semantic/runs/:id/events", { params: { id: runId }, query: { cursor: String(cursor), wait: "500" } })).json;
      cursor = page.cursor;
      events = events.concat(page.events);
      const state = (await call("GET", "/api/semantic/runs/:id", { params: { id: runId } })).json.run;
      try {
        const m = (await call("GET", "/api/semantic/runs/:id/mascots", { params: { id: runId } })).json;
        seen.push(m);
      } catch (error) {
        // Before the child writes its folder the run has no record yet: 404, never an invented snapshot.
        assert.equal(error.status, 404);
      }
      // "interrupted" without a result yet is the moment between the plan and the first checkpoint: keep following.
      return state.lifecycle === "settled" || (state.lifecycle === "interrupted" && state.result !== null);
    }, 120_000, "the Semantic run to settle");
    // The events written between the last page and the settle, as the run screen reads them on its last round.
    for (;;) {
      const page = (await call("GET", "/api/semantic/runs/:id/events", { params: { id: runId }, query: { cursor: String(cursor) } })).json;
      cursor = page.cursor;
      events = events.concat(page.events);
      if (page.done) break;
    }
    assert.ok(events.some((e) => e.type === "run-started") && events.some((e) => e.type === "run-finished"), `the run screen gets the ordered events: ${events.map((e) => e.type).join(",")}`);
    // Every snapshot the run screen got agrees with the run state it was read with.
    for (const m of seen) {
      assert.equal(m.mascots.running, m.lifecycle === "running", "running flag follows the run's lifecycle");
      assert.deepEqual(m.mascots.mascots.map((x) => x.mascot), [...SEMANTIC_MASCOTS]);
      // While it runs, a mascot whose phases have not come yet waits; once settled, nothing waits or works any more.
      if (m.lifecycle === "running") assert.ok(m.mascots.mascots.filter((x) => x.stages.length === 0).every((x) => x.state === "waiting"), "a running run never reads as settled");
      else assert.ok(m.mascots.mascots.every((x) => x.state !== "waiting" && x.state !== "working"), "a settled run shows nothing in progress");
    }

    // The final snapshot reflects the run's own stage records (result.json steps, investigation stages).
    const report = (await call("GET", "/api/semantic/runs/:id/report", { params: { id: runId } })).json;
    const runDir = path.join(semanticDir, runId);
    const result = JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8"));
    assert.equal(result.gate, "semantic");
    assert.equal(report.report.decision, result.decision);
    assert.equal(report.report.decision, "passed", JSON.stringify(result.summary));
    const investigationFile = path.join(runDir, "evidence", "investigation.json");
    const investigation = result.semanticRun.outcome?.investigation ?? (fs.existsSync(investigationFile) ? JSON.parse(fs.readFileSync(investigationFile, "utf8")) : null);
    const moduleStages = (investigation?.stages ?? []).map((s) => ({ id: `${investigation.module.id}/${s.id}`, state: s.state, role: s.role }));
    assert.ok(moduleStages.length > 0, "the review ran as an investigation with stages");
    const expected = [
      ...result.stages.filter((s) => s.id !== "semantic-review").map((s) => ({ id: s.id, state: s.state })),
      ...moduleStages,
    ];
    const snapshot = report.mascots;
    assert.equal(snapshot.runId, runId);
    assert.equal(snapshot.running, false);
    assert.equal(snapshot.cancelled, false);
    for (const view of snapshot.mascots) {
      const owned = expected.filter((s) => mascotForStage(s) === view.mascot);
      assert.deepEqual(view.stages.map((s) => s.id).sort(), owned.map((s) => s.id).sort(), `${view.mascot}: the stages it owns`);
      const want = owned.length === 0 ? "incomplete" : owned.every((s) => s.state === "completed") ? "done" : view.state;
      assert.equal(view.state, want, `${view.mascot}: state from its stages`);
      if (owned.some((s) => s.state !== "completed")) assert.notEqual(view.state, "done", `${view.mascot}: never done with unfinished stages`);
    }
    assert.ok(snapshot.mascots.some((m) => m.state === "done"), "a finished run shows finished mascots");
    // The results screen: units, completion apart from repository coverage, confirmation apart from severity, usage.
    const r = report.report;
    assert.ok(r.units.examinedNow.length > 0, "examined now");
    assert.equal(r.scope.subjects, preview.resolution.completion.subjects);
    assert.equal(r.scope.repositoryFiles, preview.resolution.completion.repositoryFiles);
    assert.ok(r.scope.completion !== null && r.scope.repositoryCoverage !== null);
    assert.deepEqual(Object.keys(r.confirmation).sort(), ["confirmed", "needs-validation", "rejected"]);
    assert.equal(r.usage.calls, result.semanticRun.outcome.calls);

    // History: the Semantic history lists the run; the Quality history never does.
    const semanticHistory = (await call("GET", "/api/semantic/runs")).json.runs;
    assert.ok(semanticHistory.some((x) => x.runId === runId && x.lifecycle === "settled"), "the run is in the Semantic history");
    const qualityHistory = (await call("GET", "/api/history")).json.runs;
    assert.ok(qualityHistory.every((x) => x.runId !== runId && x.runId.startsWith("run_")), "the Quality history has no Semantic run");

    // 3. A sequence of both gates: each gate's mascots come from its own projection.
    const sequenceStart = await call("POST", "/api/sequences", { body: { gates: ["quality", "semantic"], rigor: "quick" } });
    assert.equal(sequenceStart.status, 202, JSON.stringify(sequenceStart.json));
    const sequenceId = sequenceStart.json.sequence.sequenceId;
    let last = null;
    try {
      await waitFor(async () => {
        const view = (await call("GET", "/api/sequences/:id", { params: { id: sequenceId } })).json.sequence;
        last = view;
        return view.record && view.lifecycle === "settled";
      }, 180_000, "the sequence to settle");
    } catch (error) {
      // A sequence that never settles says what state it stopped in.
      throw new Error(`${error.message}: ${JSON.stringify({ lifecycle: last?.lifecycle, record: last?.record, timeline: last?.details?.timeline })}`, { cause: error });
    }
    const both = (await call("GET", "/api/sequences/:id/mascots", { params: { id: sequenceId } })).json;
    assert.ok(both.quality && both.semantic, JSON.stringify(both.runs));
    assert.match(both.quality.runId, /^run_/);
    assert.match(both.semantic.runId, /^sem_/);
    const quality = both.quality.mascots;
    assert.equal(quality.runId, both.quality.runId);
    assert.ok(quality.domains.length > 0 && quality.domains.every((d) => MASCOT_DOMAINS.includes(d.domain)), "only the six Quality domains");
    const semanticStageIds = new Set(both.semantic.mascots.mascots.flatMap((m) => m.stages.map((s) => s.id)));
    assert.ok(semanticStageIds.size > 0);
    for (const domain of quality.domains) {
      for (const check of domain.checks) {
        assert.ok(!semanticStageIds.has(check.id), `Quality check ${check.id} is not a Semantic stage`);
        assert.doesNotMatch(check.id, /^(semantic-(context|review)|sem_)|\//, `Quality check ${check.id} is not a Semantic stage`);
      }
    }
    assert.ok(!SEMANTIC_MASCOTS.some((m) => quality.domains.some((d) => d.domain === m)), "no AI mascot in the Quality panel");
    assert.deepEqual(both.semantic.mascots.mascots.map((m) => m.mascot), [...SEMANTIC_MASCOTS]);
    const qualityHistoryAfter = (await call("GET", "/api/history")).json.runs;
    assert.ok(qualityHistoryAfter.every((x) => x.runId.startsWith("run_")), "the sequence's Semantic run stays out of the Quality history");
    assert.ok((await call("GET", "/api/semantic/runs")).json.runs.some((x) => x.runId === both.semantic.runId), "and is in the Semantic history");
  } finally {
    // A run child the server started may still hold the workspace for a moment on Windows: retry the cleanup briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        p.cleanup();
        break;
      } catch (error) {
        if (attempt >= 50) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
});
