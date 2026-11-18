// The per-tool proof of the linter engine, shared by tests/linters.test.js (the descriptors of src/builtin/linters, one
// named test each) and tests/linter-engine.test.js (the engine's own invented descriptors). Each tool has, under its
// fixtures folder <root>/<id>/: bad/ (the smallest files that make the tool report a known rule), clean/ (the same
// files, fixed), recorded/bad.json and recorded/clean.json (the tool's real output, replayed by
// tests/fixtures/linters/replay.mjs through the tool's JGATES_LINTER_<ID> override) and expected.json:
//   { "files": ["<the files of bad/ the activation picks>"], "findings": [{ "rule": "..", "file": "..", "line": 1 }] }
// The proof goes through the real init, plan and run services: the bad side gives exactly the expected findings, the
// clean side none, neither is rewritten, the tool missing from the image is a blocked stage with the TOOL_MISSING
// cause, an output longer than the runner keeps is an error stage, and the activation picks the fixture's files and
// nothing else.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DIST = path.resolve(here, "..", "..", "dist");
export const REPLAY = path.resolve(here, "..", "fixtures", "linters", "replay.mjs");
export const BUILTIN_FIXTURES = path.resolve(here, "..", "fixtures", "linters");
const load = (...parts) => import(pathToFileURL(path.join(DIST, ...parts)).href);

/** A file no descriptor activates on: the activation must leave it out. */
const DECOY = "jgates-decoy.no-linter-reads-this";

export async function linterHarness() {
  const { planInit, writeInit } = await load("core", "init", "index.js");
  const { buildPlan } = await load("core", "plan", "index.js");
  const { executeRun } = await load("core", "run", "index.js");
  const { planSteps, planDisabled } = await load("core", "run", "plan-run.js");
  const engine = await load("adapters", "linter", "index.js");
  const { imageJsonWithout, releaseImageJson, writeImageJson } = await import(pathToFileURL(path.join(here, "image-json.mjs")).href);
  const gates = await import(pathToFileURL(path.resolve(here, "..", "..", "scripts", "image-gates.mjs")).href);
  const installs = await import(pathToFileURL(path.resolve(here, "..", "..", "scripts", "image-installs.mjs")).href);

  const made = [];
  const tmp = (prefix) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };
  const cleanup = () => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  };
  const home = tmp("jgates-linters-home-");

  const envFor = (id, extra = {}) => ({
    ...process.env,
    JGATES_HOME: home,
    JGATES_NO_CACHE: "1",
    NO_COLOR: "1",
    JGATES_LOCALE: "en",
    [engine.linterOverrideEnv(id)]: REPLAY,
    ...extra,
  });

  function treeHash(root) {
    const h = crypto.createHash("sha256");
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = path.join(d, e.name);
        const next = rel ? `${rel}/${e.name}` : e.name;
        if (e.name === ".git" || e.name === ".jgates") continue;
        if (e.isDirectory()) {
          h.update(`d:${next}\0`);
          walk(p, next);
        } else h.update(`f:${next}\0`).update(fs.readFileSync(p));
      }
    };
    walk(root, "");
    return h.digest("hex");
  }

  /** A git repository initialized by the real init service (the minimal profile). */
  function init(dir) {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
    writeInit(dir, planInit(dir, "minimal"));
    return dir;
  }

  /** A workspace holding one fixture side, initialized by the real init service; `extra` files are added after. */
  function workspace(fixtures, id, kind, extra = {}) {
    const dir = tmp(`jgates-linter-${id}-${kind}-`);
    fs.cpSync(path.join(fixtures, id, kind), dir, { recursive: true });
    for (const [file, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, file), text);
    return init(dir);
  }

  function plan(dir, id, env) {
    const built = buildPlan(dir, { only: [`tool:${id}`], env, home, compare: false, version: "test" });
    assert.equal(built.ok, true, JSON.stringify(built.errors ?? built.error));
    return built.plan;
  }

  function execute(dir, builtPlan, env) {
    return executeRun({
      workspacePath: dir,
      home,
      version: "test",
      adapter: "quality-bridge",
      options: { planHash: builtPlan.planHash, planSource: "built", profile: "minimal", scope: "full" },
      plan: builtPlan,
      steps: (context) => planSteps(context, builtPlan),
      disabled: planDisabled(builtPlan),
      env,
      cache: false,
    });
  }

  /** The descriptor's parts a tool cannot lack: fixtures, recordings, the expected findings, texts in both languages. */
  function assertComplete(descriptor, fixtures) {
    const root = path.join(fixtures, descriptor.id);
    for (const part of ["bad", "clean", "recorded/bad.json", "recorded/clean.json", "expected.json"]) assert.ok(fs.existsSync(path.join(root, ...part.split("/"))), `${descriptor.id}: ${part} is missing under ${root}`);
    for (const lang of ["en", "pt-BR"]) for (const key of ["label", "purpose", "limitation", "needs"]) assert.ok(descriptor.text?.[lang]?.[key]?.trim(), `${descriptor.id}: text.${lang}.${key}`);
    const expected = JSON.parse(fs.readFileSync(path.join(root, "expected.json"), "utf8"));
    assert.ok(Array.isArray(expected.files), `${descriptor.id}: expected.json has the files list`);
    assert.ok(Array.isArray(expected.findings) && expected.findings.length > 0, `${descriptor.id}: expected.json names at least one finding`);
    for (const f of expected.findings) assert.ok(typeof f.rule === "string" && typeof f.file === "string", `${descriptor.id}: every expected finding has a rule and a file`);
    return expected;
  }

  const key = (f) => `${f.rule}|${f.file}|${f.line ?? ""}`;

  /**
   * The image side of a tool (PLAN-image.md sections 3 and 4): its install entry exists and provides the program, and
   * its declared license passes the image's license policy.
   */
  function assertShippable(descriptor) {
    const { entries } = installs.readInstalls();
    const install = gates.checkDescriptorInstalls({ descriptors: [descriptor], entries });
    assert.deepEqual(install.findings.map((f) => f.message), [], `${descriptor.id}: its install entry`);
    const license = gates.checkDescriptorLicenses({ descriptors: [descriptor], policy: gates.loadPolicy(), entries });
    assert.deepEqual(license.findings.map((f) => f.message), [], `${descriptor.id}: its license against jgates/docker/tools/license-policy.json`);
  }

  /**
   * The environment of the proof. A tool the package's image.json mirror does not list yet (it reaches
   * release/image-tools.json with the next image build, in the integration slices) gets the version its probe recorded.
   */
  function proofEnv(descriptor, fixtures) {
    const tool = descriptor.program.tool;
    if (releaseImageJson().tools[tool] !== undefined) return envFor(descriptor.id);
    const recorded = JSON.parse(fs.readFileSync(path.join(fixtures, descriptor.id, "recorded", "bad.json"), "utf8"));
    // Without a recorded version (the engine's invented tools) the override's version stands in (0.0.0).
    if (typeof recorded.version !== "string" || recorded.version === "") return envFor(descriptor.id);
    return envFor(descriptor.id, { JGATES_IMAGE_JSON: writeImageJson({ [tool]: recorded.version }) });
  }

  /** The whole proof of one tool. */
  async function prove(descriptor, fixtures) {
    const id = descriptor.id;
    const expected = assertComplete(descriptor, fixtures);
    if (fixtures === BUILTIN_FIXTURES) assertShippable(descriptor);
    const env = proofEnv(descriptor, fixtures);
    const stage = `${id}#${descriptor.place.capability}`;

    // The bad side: exactly the expected findings, located, blocking; the activation picks the fixture's files only.
    const bad = workspace(fixtures, id, "bad", { [DECOY]: "decoy\n" });
    const badBefore = treeHash(bad);
    const badPlan = plan(bad, id, env);
    const item = badPlan.groups.willRun.find((i) => i.id === stage);
    assert.ok(item, `${stage} is in the plan of the bad fixture (${JSON.stringify(badPlan.groups.willRun.map((i) => i.id))})`);
    assert.equal(item.adapter, id);
    assert.equal(item.availability.status, "available", item.availability.reason ?? "");
    const invocation = badPlan.invocations.find((i) => i.id === id);
    assert.deepEqual(invocation.contract.files, [...expected.files].sort(), `${id}: the activation picks the fixture's files and nothing else`);
    assert.ok(!invocation.contract.files.includes(DECOY));
    const failed = await execute(bad, badPlan, env);
    const failedStage = failed.stages.find((s) => s.id === stage);
    assert.equal(failedStage.state, "completed", failedStage.reason);
    assert.notEqual(failedStage.interpreted, false);
    assert.equal(failed.decision, "failed", JSON.stringify(failed.stages));
    const found = failed.findings.filter((f) => f.origin === id);
    for (const f of found) {
      assert.equal(f.blocking, true);
      assert.equal(f.tool, id);
    }
    assert.deepEqual(
      found.map((f) => key({ rule: f.ruleId, file: f.location?.path, line: expected.findings.some((e) => e.line !== undefined) ? f.location?.line : undefined })).sort(),
      expected.findings.map((e) => key(e)).sort(),
      `${id}: the bad fixture gives exactly the expected findings`,
    );
    assert.equal(treeHash(bad), badBefore, `${id} ran read-only: the fixture is byte for byte the same`);

    // The clean side: none.
    const clean = workspace(fixtures, id, "clean");
    const cleanBefore = treeHash(clean);
    const passed = await execute(clean, plan(clean, id, env), env);
    const cleanStage = passed.stages.find((s) => s.id === stage);
    assert.equal(cleanStage.state, "completed", cleanStage.reason);
    assert.equal(passed.findings.filter((f) => f.origin === id).length, 0, JSON.stringify(passed.findings));
    assert.equal(passed.decision, "passed", JSON.stringify(passed.stages));
    assert.equal(treeHash(clean), cleanBefore);

    // The tool missing from the image: blocked with the shared cause, never a pass.
    const missingEnv = envFor(id, { [engine.linterOverrideEnv(id)]: "", JGATES_IMAGE_JSON: imageJsonWithout(descriptor.program.tool) });
    const missingPlan = plan(bad, id, missingEnv);
    const missingItem = missingPlan.groups.willRun.find((i) => i.id === stage);
    assert.equal(missingItem.availability.status, "unavailable");
    assert.match(missingItem.availability.reason, /jgates setup/);
    assert.ok(JSON.stringify(missingPlan).includes("TOOL_MISSING"), `${id}: the plan names the TOOL_MISSING cause`);
    const blocked = await execute(bad, missingPlan, missingEnv);
    assert.equal(blocked.stages.find((s) => s.id === stage).state, "blocked");
    assert.notEqual(blocked.decision, "passed");

    // An output longer than the runner keeps (truncated): an error stage, never a pass.
    const flood = workspace(fixtures, id, "bad", { ".jgates-replay-flood": "" });
    const flooded = await execute(flood, plan(flood, id, env), env);
    const floodStage = flooded.stages.find((s) => s.id === stage);
    assert.equal(floodStage.state, "error", floodStage.reason);
    assert.notEqual(flooded.decision, "passed");
  }

  return { prove, plan, execute, init, workspace, treeHash, envFor, home, tmp, cleanup, engine };
}
