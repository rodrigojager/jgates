import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Semantic gate as an optional integration. The provider is always a fake: a script that records what
// it receives and answers like the mock provider of the semantic-gate package, so no test spends model tokens.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const DIST = path.join(repo, "jgates", "dist");
const MAIN = path.join(DIST, "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const require = createRequire(import.meta.url);
const { createPiiFixture, removePiiFixture } = require(path.join(repo, "tests", "fixtures", "jgates", "pii-fixture.js"));

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};

const APPROVED = JSON.stringify({
  status: "APPROVED",
  score: 100,
  findings: [],
  hardBlockers: [],
  requiredFixPlan: [],
  approvalNotes: "Fake provider approved the semantic review.",
});

/** The fake provider: appends the prompt it received to a file (so a call is visible) and answers (or hangs, or fails). */
function fakeProviderScript(dir, mode) {
  const script = path.join(dir, `fake-provider-${mode}.mjs`);
  const calls = path.join(dir, "provider-calls.log");
  fs.writeFileSync(
    script,
    [
      `import fs from "node:fs";`,
      `const chunks = [];`,
      `for await (const c of process.stdin) chunks.push(c);`,
      `fs.appendFileSync(${JSON.stringify(calls)}, Buffer.concat(chunks).toString("utf8") + "\\n=====CALL=====\\n");`,
      mode === "timeout" ? `await new Promise((r) => setTimeout(r, 20000));` : "",
      mode === "fail" ? `process.stderr.write("provider offline"); process.exit(3);` : "",
      `process.stdout.write(${JSON.stringify(APPROVED)});`,
    ].join("\n"),
  );
  return { script, calls };
}

function project({ mode = "ok", configure = true, timeoutSeconds = 30 } = {}) {
  const fixture = createPiiFixture();
  const home = tmp("jgates-semantic-home-");
  const aux = tmp("jgates-semantic-aux-");
  const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: "", timeout: 120_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const init = cli(["init", "--cwd", fixture.dir, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  const fake = fakeProviderScript(aux, mode);
  const configFile = path.join(fixture.dir, "jgates.yml");
  const freshConfig = fs.readFileSync(configFile, "utf8");
  if (configure) {
    const block = [
      "extensions:",
      "  semantic-gate:",
      "    provider: command",
      `    command: ${JSON.stringify(process.execPath)}`,
      `    commandArgs: [${JSON.stringify(fake.script)}]`,
      "    model: fake-model",
      `    timeoutSeconds: ${timeoutSeconds}`,
      "    costPerCall: 0.01",
      "",
    ].join("\n");
    assert.ok(!/^extensions:/m.test(freshConfig), "init must not write extensions");
    fs.writeFileSync(configFile, `${freshConfig.replace(/\n*$/, "\n")}${block}`);
  }
  git(fixture.dir, "init", "-q");
  const providerCalls = () => (fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, "utf8").split("=====CALL=====").filter((c) => c.trim() !== "") : []);
  return {
    ...fixture,
    cli,
    freshConfig,
    providerCalls,
    // Only the PII instance runs: the other stages need tools the test machine does not have.
    run: (...more) => cli(["run", "--cwd", fixture.dir, "--no-interactive", "--json", "--only", "tool:builtin-pii", ...more]),
    cleanup() {
      removePiiFixture(fixture.dir);
      for (const d of [home, aux]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

const core = (doc) => ({ decision: doc.decision, exitCode: doc.exitCode, complete: doc.complete, blocking: doc.blockingViolations, stages: doc.stages.map((s) => `${s.id}:${s.state}`), findings: doc.findings.length });

test("jgates init writes no semantic-gate configuration and the card data says off", async () => {
  const p = project({ configure: false });
  try {
    assert.ok(!/semantic/i.test(p.freshConfig), "a fresh jgates.yml has no semantic-gate block");
    const { routes } = await import(pathToFileURL(path.join(DIST, "server", "routes", "semantic.js")).href);
    const route = routes.find((r) => r.path === "/api/semantic");
    const answer = await route.handler({ server: { projectDir: p.dir } });
    assert.equal(answer.json.state, "off");
    assert.equal(answer.json.provider, null);
  } finally {
    p.cleanup();
  }
});

test("run without the request never calls the provider, even when one is configured, and the result has no semantic block", () => {
  const p = project();
  try {
    const r = p.run();
    assert.ok(r.doc, r.out + r.err);
    assert.equal(r.doc.semantic, undefined);
    assert.equal(p.providerCalls().length, 0);
  } finally {
    p.cleanup();
  }
});

test("run that asks for the semantic gate without a provider configured sends nothing and says so", () => {
  const p = project({ configure: false });
  try {
    const baseline = p.run();
    const r = p.run("--semantic");
    assert.equal(r.doc.semantic.state, "not-configured");
    assert.equal(r.doc.semantic.separateFromDecision, true);
    assert.equal(p.providerCalls().length, 0);
    assert.deepEqual(core(r.doc), core(baseline.doc));
  } finally {
    p.cleanup();
  }
});

test("configured and requested: the semantic conclusion is apart from the decision, which equals the run without it", () => {
  const p = project();
  try {
    const baseline = p.run();
    assert.ok(baseline.doc, baseline.out + baseline.err);
    const r = p.run("--semantic");
    assert.ok(r.doc, r.out + r.err);
    const s = r.doc.semantic;
    assert.equal(s.state, "completed");
    assert.equal(s.provider, "command");
    assert.equal(s.model, "fake-model");
    assert.equal(s.scope, "changed");
    assert.equal(s.conclusion.status, "APPROVED");
    assert.equal(s.calls, 1);
    assert.equal(s.cost.reported, true);
    assert.equal(s.cost.total, 0.01);
    assert.ok(s.limits.timeoutSeconds > 0 && s.limits.maxCalls > 0);
    assert.equal(p.providerCalls().length, 1);
    assert.deepEqual(core(r.doc), core(baseline.doc));
    // The PII builtin blocks the fixture: an approving semantic conclusion does not turn it into passed.
    assert.equal(r.doc.decision, "failed");
  } finally {
    p.cleanup();
  }
});

test("the context sent to the provider holds no PII value of the fixture", () => {
  const p = project();
  try {
    const r = p.run("--semantic");
    assert.equal(r.doc.semantic.state, "completed", r.out + r.err);
    const sent = p.providerCalls().join("\n");
    assert.ok(sent.includes("customers/sample.txt"), "the file with the values is part of the review");
    for (const [entity, value] of Object.entries(p.values)) {
      assert.ok(!sent.includes(value), `the raw ${entity} value reached the provider`);
      assert.ok(!sent.replace(/\D/g, "").includes(value.replace(/\D/g, "")), `the digits of ${entity} reached the provider`);
    }
    assert.ok(sent.includes("[MASKED:cpf]"));
    assert.ok(r.doc.semantic.context.masked.total >= 4);
    // The result carries the counts, never the values.
    const text = JSON.stringify(r.doc.semantic);
    for (const value of Object.values(p.values)) assert.ok(!text.includes(value));
  } finally {
    p.cleanup();
  }
});

test("a provider that does not answer in time leaves the decision as it was and the result shows the timeout", () => {
  const p = project({ mode: "timeout", timeoutSeconds: 1 });
  try {
    const baseline = p.run();
    const r = p.run("--semantic");
    assert.ok(r.doc, r.out + r.err);
    assert.equal(r.doc.semantic.state, "timeout");
    assert.equal(r.doc.semantic.conclusion, undefined);
    assert.ok(r.doc.semantic.reason);
    assert.deepEqual(core(r.doc), core(baseline.doc));
    assert.equal(r.code, baseline.code);
  } finally {
    p.cleanup();
  }
});

test("a provider that is down shows unavailability and does not change the decision", () => {
  const p = project({ mode: "fail" });
  try {
    const baseline = p.run();
    const r = p.run("--semantic");
    assert.equal(r.doc.semantic.state, "unavailable");
    assert.deepEqual(core(r.doc), core(baseline.doc));
  } finally {
    p.cleanup();
  }
});

test("the budget of calls is enforced before anything is sent", () => {
  const p = project();
  try {
    const file = path.join(p.dir, "jgates.yml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8") + "    maxContextChars: 2500\n    maxCalls: 1\n");
    // Many changed files make the context need more than one call.
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(p.dir, `big${i}.txt`), `line ${i} ${"x".repeat(900)}\n`);
    const r = p.run("--semantic");
    assert.equal(r.doc.semantic.state, "budget-exhausted", JSON.stringify(r.doc.semantic));
    assert.equal(p.providerCalls().length, 0);
  } finally {
    p.cleanup();
  }
});

test("the mock provider of the semantic-gate package answers through the adapter", async () => {
  const p = project({ configure: false });
  try {
    const file = path.join(p.dir, "jgates.yml");
    fs.writeFileSync(file, `${p.freshConfig.replace(/\n*$/, "\n")}extensions:\n  semantic-gate:\n    provider: mock\n    model: mock-1\n`);
    const { runSemanticReview } = await import(pathToFileURL(path.join(DIST, "adapters", "semantic-gate", "index.js")).href);
    const outcome = await runSemanticReview(p.dir, { env: process.env });
    assert.equal(outcome.state, "completed", JSON.stringify(outcome));
    assert.equal(outcome.conclusion.status, "APPROVED");
    assert.equal(outcome.provider, "mock");
  } finally {
    p.cleanup();
  }
});
