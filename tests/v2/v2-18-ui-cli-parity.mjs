import assert from "node:assert/strict";
import test from "node:test";
import { importDist, setupSequenceProject, waitFor } from "./fixtures/sequence/helpers.mjs";

// V2-18: the screens (through the server routes) and the CLI build the same plan for the same request: the same gates
// and origins, the same Quality capabilities, settings, omissions and policy, the same Semantic plan. A sequence started
// through the API executes exactly the plan the CLI shows for that request.

/** The plan without the moments it was built (the only fields allowed to differ). */
function strip(plan) {
  const copy = structuredClone(plan);
  if (copy.quality) delete copy.quality.createdAt;
  if (copy.semantic) delete copy.semantic.createdAt;
  return copy;
}

const REQUESTS = [
  { label: "both gates", flags: ["--gates", "quality,semantic"], body: { gates: ["quality", "semantic"] } },
  {
    label: "both gates, scoped, a check off for the run, deep review",
    flags: ["--gates", "quality,semantic", "--scope", "paths", "--path", "src/core", "--skip", "tool:seq-extra", "--rigor", "deep"],
    body: { gates: ["quality", "semantic"], scope: "paths", paths: ["src/core"], skip: ["tool:seq-extra"], rigor: "deep" },
  },
  { label: "Semantic only", flags: ["--gates", "semantic", "--purpose", "general-review", "--rigor", "quick"], body: { gates: ["semantic"], purpose: "general-review", rigor: "quick" } },
  { label: "Quality only", flags: ["--gates", "quality"], body: { gates: ["quality"] } },
];

test("V2-18: the plan built through the server route equals the CLI plan for the same request", async () => {
  const p = setupSequenceProject({ prefix: "v2-18" });
  try {
    const { routes } = await importDist("server", "routes", "sequence.js");
    const route = (method, path) => routes.find((x) => x.method === method && x.path === path);
    let server = null;
    let firstCli = null;
    for (const req of REQUESTS) {
      const cli = p.cli("run", "--cwd", p.dir, "--dry-run", "--json", ...req.flags);
      assert.ok(cli.doc, `${req.label}: ${cli.out}${cli.err}`);
      server ??= await p.server(cli.doc.version);
      const api = await route("POST", "/api/sequence/plan").handler({ body: req.body, query: {}, params: {}, server });
      const a = cli.doc.plan;
      const b = api.json.plan;
      // Same gates and origins, capabilities, settings, omissions and policy, and the same hashes.
      assert.deepEqual(b.selection, a.selection, req.label);
      assert.equal(b.quality?.planHash ?? null, a.quality?.planHash ?? null, req.label);
      assert.equal(b.semantic?.planHash ?? null, a.semantic?.planHash ?? null, req.label);
      assert.deepEqual(b.quality?.groups.willRun.map((i) => i.id), a.quality?.groups.willRun.map((i) => i.id), `${req.label}: capabilities`);
      assert.deepEqual(b.quality?.inputs.configHash, a.quality?.inputs.configHash, `${req.label}: settings`);
      assert.deepEqual(b.quality?.groups.notApplicableOrDisabled.map((i) => i.id), a.quality?.groups.notApplicableOrDisabled.map((i) => i.id), `${req.label}: omissions`);
      assert.deepEqual(b.quality?.selection, a.quality?.selection, `${req.label}: run-only reductions`);
      assert.deepEqual(b.advancement, a.advancement, `${req.label}: sequence policy`);
      assert.deepEqual(strip(b), strip(a), `${req.label}: the whole plan`);
      firstCli ??= cli.doc.plan;
    }
    // The scoped request: both gates got the same subjects, and the run-only reduction is in the plan.
    const scoped = p.cli("run", "--cwd", p.dir, "--dry-run", "--json", ...REQUESTS[1].flags).doc.plan;
    assert.equal(scoped.quality.scope.requested, "paths");
    assert.deepEqual(scoped.semanticRequest.scope, { mode: "selected", subjects: [{ kind: "path", value: "src/core" }] });
    assert.equal(scoped.quality.selection.reduced, true);

    // A sequence started through the API runs exactly the plan the CLI showed for the same request.
    const start = await route("POST", "/api/sequences").handler({ body: REQUESTS[0].body, query: {}, params: {}, server });
    assert.equal(start.status, 202);
    const sequenceId = start.json.sequence.sequenceId;
    assert.match(sequenceId, /^seq_/);
    assert.equal(start.json.sequence.qualityPlanHash, firstCli.quality.planHash);
    assert.equal(start.json.sequence.semanticPlanHash, firstCli.semantic.planHash);
    const one = route("GET", "/api/sequences/:id");
    await waitFor(async () => {
      const view = await one.handler({ params: { id: sequenceId }, query: {}, server });
      return view.json.sequence.record && view.json.sequence.lifecycle === "settled";
    }, 120_000, "the API sequence to settle");
    const view = (await one.handler({ params: { id: sequenceId }, query: {}, server })).json.sequence;
    assert.equal(view.record.status, "completed", JSON.stringify(view.record));
    assert.equal(view.details.plans.quality.planHash, firstCli.quality.planHash);
    assert.equal(view.details.plans.semantic.settingsHash, firstCli.semanticSettingsHash);
    assert.deepEqual(view.details.selection, firstCli.selection);
    assert.equal(p.reviews(), 1);
    const list = await route("GET", "/api/sequences").handler({ query: {}, params: {}, server });
    assert.deepEqual(list.json.sequences.map((s) => s.sequenceId), [sequenceId]);
  } finally {
    p.cleanup();
  }
});
