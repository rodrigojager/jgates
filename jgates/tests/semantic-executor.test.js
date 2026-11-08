import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

// The bounded investigation executor (core/semantic-executor) and the tool calling of the semantic-gate package: the
// budget and its validation reserve, the host tools inside the scope guard (sensitive files, settings, masking,
// untrusted-data envelope, unknown tools), artifact validation, the provider tool loop over real HTTP formats
// (Anthropic Messages and OpenAI-compatible chat against a local fake server), the agent CLI wrapper (restricted
// arguments, staged scope, claims only from the validated artifact, real usage) and invalid or unsupported cases.
// Every model is scripted or a local fake: no test spends model tokens.

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const fixtures = await import(pathToFileURL(path.join(ROOT, "tests", "v2", "fixtures", "semantic-executor", "helpers.mjs")).href);
const { load, loadGate, recordingScript, runInvestigation, setupWorkspace, usage, readJson, FIXTURES } = fixtures;
const FAKE_CLI = path.join(FIXTURES, "fake-agent-cli.mjs");

const exec = await load("core/semantic-executor/index.js");
const scopeLib = await load("core/semantic-scope/index.js");

test("budget: the validation reserve is set aside before exploration; validation may spend it; estimates are disclosed", () => {
  const limits = exec.budgetLimits({ rigor: "standard", maxCalls: 10, maxTokens: 1000, maxSeconds: null, callTimeoutSeconds: 30 });
  assert.deepEqual(limits, { maxCalls: 10, maxTokens: 1000, maxSeconds: 300 });
  const reserve = exec.reserveFor(limits, "standard", true);
  assert.deepEqual(reserve, { calls: 4, tokens: 340, seconds: 102 });
  assert.deepEqual(exec.reserveFor(limits, "deep", false), { calls: 0, tokens: 0, seconds: 0 });
  assert.equal(exec.reserveFor({ maxCalls: 2, maxTokens: null, maxSeconds: 10 }, "quick", true).calls, 1, "at least one call is reserved");
  const meter = new exec.BudgetMeter(limits, reserve);
  for (let i = 0; i < 5; i++) assert.equal(meter.check("explore").ok, true);
  const last = meter.check("explore");
  meter.record("hunt", { inputTokens: 100, outputTokens: 10, reported: true });
  for (let i = 0; i < 4; i++) meter.record("hunt", { inputTokens: 10, outputTokens: 1, reported: true });
  assert.equal(last.ok && last.finalCall, false);
  meter.record("hunt", { inputTokens: 10, outputTokens: 1, reported: false });
  const explore = meter.check("explore");
  assert.equal(explore.ok, false);
  assert.equal(explore.dimension, "calls");
  const validate = meter.check("validate");
  assert.equal(validate.ok, true, "validation spends the reserve");
  const snap = meter.snapshot();
  assert.equal(snap.calls, 6);
  assert.equal(snap.tokens.reported, false, "one call had no usage report: the total is not presented as real");
  assert.equal(snap.tokens.estimatedCalls, 1);
  meter.record("validate", { inputTokens: 900, outputTokens: 0, reported: true });
  const spent = meter.check("validate");
  assert.equal(spent.ok, false);
  assert.equal(spent.dimension, "tokens");
});

test("host tools: reads go through the scope guard, sensitive and excluded files are refused, text is masked and wrapped as data", () => {
  const ws = setupWorkspace("jg-exec-tools", {
    "src/app.js": 'const admin = "ops@example.com";\nexports.x = 1;\n',
    "src/b.js": "exports.y = 2; // needle\n",
    ".env": "TOKEN=abc\n",
    "vendor/lib.js": "exports.z = 3; // needle\n",
  });
  try {
    const resolution = scopeLib.resolveSemanticScope({ workspacePath: ws.dir, request: { mode: "selected", subjects: [{ kind: "path", value: "src" }, { kind: "path", value: ".env" }, { kind: "path", value: "vendor" }] }, home: ws.home, env: ws.env, methods: ["general-review"] });
    const guard = scopeLib.createScopeGuard({ workspacePath: ws.dir, resolution, env: ws.env });
    const candidates = [];
    const tools = new exec.HostTools({
      guard,
      masking: { entities: { email: true }, patterns: [] },
      counts: {},
      excludes: ["vendor/**"],
      include: [],
      recommended: [],
      policy: { context: "strict", maxFiles: 25, maxBytes: 1000 },
      onCandidate: (input) => (candidates.push(input), { id: `C${candidates.length}` }),
    });
    const ctx = { stage: "hunt", label: "hunt", seen: new Set(), refused: [] };
    const run = (name, args) => tools.execute({ id: "1", name, arguments: args }, ctx);
    const read = run("read_file", { path: "src/app.js" });
    assert.equal(read.isError, false);
    assert.match(read.content, /^<repository-file path="src\/app\.js" lines="1-3" of="3" trust="untrusted-data">/);
    assert.equal(read.content.includes("ops@example.com"), false, "the e-mail is masked before it leaves");
    assert.match(run("read_file", { path: ".env" }).content, /^REFUSED \(SENSITIVE_FILE\)/);
    assert.match(run("read_file", { path: "vendor/lib.js" }).content, /^REFUSED \(EXCLUDED_BY_SETTINGS\)/);
    assert.match(run("read_file", { path: "../outside.txt" }).content, /^REFUSED \(PATH_ESCAPE\)/);
    assert.match(run("read_file", { path: "jgates.yml" }).content, /^REFUSED \(OUTSIDE_SCOPE\)/);
    assert.match(run("request_context", { path: "jgates.yml", reason: "curious" }).content, /^REFUSED \(OUTSIDE_SCOPE\)/);
    assert.match(run("shell", { command: "cat /etc/passwd" }).content, /^REFUSED \(UNKNOWN_TOOL\)/);
    const search = run("search_files", { query: "needle" });
    assert.match(search.content, /src\/b\.js:1:/);
    assert.equal(search.content.includes("vendor/lib.js"), false, "a search never reaches an excluded file");
    const listing = run("list_files", {});
    assert.equal(listing.content.includes(".env"), false);
    assert.match(run("report_candidate", { title: "t", path: "src/unread.js", severity: "nit", category: "x", rationale: "r" }).content, /^ERROR/);
    assert.match(run("report_candidate", { title: "t", path: "src/app.js", line: 1, severity: "major", category: "x", rationale: "r" }).content, /severity must be one of/);
    assert.match(run("report_candidate", { title: "Hard-coded address", path: "src/app.js", line: 1, severity: "nit", category: "privacy", rationale: "r" }).content, /^RECORDED: candidate C1/);
    assert.deepEqual([...ctx.seen].sort(), ["src/app.js", "src/b.js"]);
    assert.deepEqual(tools.refusals().map((r) => [r.code, r.violation]), [
      ["SENSITIVE_FILE", true],
      ["EXCLUDED_BY_SETTINGS", true],
      ["PATH_ESCAPE", true],
      ["OUTSIDE_SCOPE", true],
      ["OUTSIDE_SCOPE", true],
      ["UNKNOWN_TOOL", true],
    ]);
  } finally {
    ws.cleanup();
  }
});

test("artifacts: only a valid JSON artifact counts; evidence must have been read in the context", () => {
  const candidate = { id: "C1", path: "src/app.js" };
  const ctx = { seen: new Set(["src/app.js"]), candidate, readable: () => true, lines: () => 10 };
  assert.equal(exec.parseArtifactText("").code, "empty-output");
  assert.equal(exec.parseArtifactText("all good").code, "malformed-output");
  assert.equal(exec.parseArtifactText("[1]").code, "not-an-object");
  assert.deepEqual(exec.parseArtifactText('```json\n{"a":1}\n```').value, { a: 1 });
  const verdict = exec.validateArtifact({ kind: "verdict" }, { candidateId: "C1", confirmation: "confirmed", reason: "r", evidence: [{ path: "src/other.js", line: 2 }] }, ctx);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => /never read/.test(p)));
  assert.equal(exec.validateArtifact({ kind: "verdict" }, { candidateId: "C1", confirmation: "rejected", reason: "r", evidence: [] }, ctx).ok, false);
  assert.equal(exec.validateArtifact({ kind: "verdict" }, { candidateId: "C1", confirmation: "confirmed", reason: "r", evidence: [{ path: "src/app.js", line: 11 }] }, ctx).ok, false, "a line beyond the file");
  assert.equal(exec.validateArtifact({ kind: "verdict" }, { candidateId: "C2", confirmation: "needs-validation", reason: "r", evidence: [] }, ctx).ok, false, "another candidate's verdict");
  assert.equal(exec.validateArtifact({ kind: "verdict" }, { candidateId: "C1", confirmation: "needs-validation", reason: "r" }, ctx).ok, true);
  const exploration = exec.validateArtifact({ kind: "exploration" }, { summary: "s", examined: ["src/app.js", "src/never.js"], policy: { context: "unrestricted" } }, { ...ctx, candidate: null });
  assert.equal(exploration.ok, true);
  assert.deepEqual(exploration.value.examined, ["src/app.js"]);
  assert.equal("policy" in exploration.value, false, "fields outside the contract are never taken");
});

/** A local fake provider: answers each request with the next scripted body and records what it received. */
async function fakeServer(answers) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      const next = answers[received.length - 1] ?? answers.at(-1);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(next));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, received, close: () => new Promise((r) => server.close(r)) };
}

test("provider tool turns: Anthropic Messages and OpenAI-compatible formats carry tools, tool results and real usage", async () => {
  const { callProviderTurn, supportsToolCalling } = await loadGate("providers.js");
  const { defaultConfig } = await loadGate("config.js");
  assert.equal(supportsToolCalling("anthropic"), true);
  assert.equal(supportsToolCalling("openrouter"), true);
  assert.equal(supportsToolCalling("ollama"), false);
  assert.equal(supportsToolCalling("ollama", "my-gateway"), true);
  process.env.JG_EXEC_FAKE_KEY = "test-key-not-real";
  const tools = [{ name: "read_file", description: "d", parameters: { type: "object", properties: { path: { type: "string" } } } }];
  const messages = [
    { role: "user", text: "start" },
    { role: "assistant", text: "", toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "a.js" } }] },
    { role: "tool", results: [{ callId: "t1", name: "read_file", content: "<repository-file>", isError: false }] },
  ];
  try {
    const anthropic = await fakeServer([{ content: [{ type: "text", text: "reading" }, { type: "tool_use", id: "tu_2", name: "read_file", input: { path: "b.js" } }], stop_reason: "tool_use", usage: { input_tokens: 120, cache_read_input_tokens: 30, output_tokens: 15 } }]);
    try {
      const r = await callProviderTurn({ system: "sys", messages, tools, toolChoice: "none", config: { ...defaultConfig, provider: "anthropic", baseUrl: anthropic.url, model: "m", apiKeyEnv: "JG_EXEC_FAKE_KEY", secretStore: false } });
      assert.deepEqual(r.toolCalls, [{ id: "tu_2", name: "read_file", arguments: { path: "b.js" } }]);
      assert.deepEqual(r.usage, { inputTokens: 150, outputTokens: 15 });
      const body = anthropic.received[0].body;
      assert.equal(anthropic.received[0].url, "/v1/messages");
      assert.deepEqual(body.tools[0].input_schema, tools[0].parameters);
      assert.deepEqual(body.tool_choice, { type: "none" });
      assert.deepEqual(body.messages[1].content, [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.js" } }]);
      assert.deepEqual(body.messages[2].content, [{ type: "tool_result", tool_use_id: "t1", content: "<repository-file>" }]);
    } finally {
      await anthropic.close();
    }
    const openai = await fakeServer([{ choices: [{ message: { content: null, tool_calls: [{ id: "c9", type: "function", function: { name: "read_file", arguments: '{"path":"c.js"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 80, completion_tokens: 9 } }]);
    try {
      const r = await callProviderTurn({ system: "sys", messages, tools, config: { ...defaultConfig, provider: "openai-compatible", baseUrl: `${openai.url}/v1`, model: "m", apiKeyEnv: "JG_EXEC_FAKE_KEY", secretStore: false } });
      assert.deepEqual(r.toolCalls, [{ id: "c9", name: "read_file", arguments: { path: "c.js" } }]);
      assert.deepEqual(r.usage, { inputTokens: 80, outputTokens: 9 });
      const body = openai.received[0].body;
      assert.equal(openai.received[0].url, "/v1/chat/completions");
      assert.equal(openai.received[0].headers.authorization, "Bearer test-key-not-real");
      assert.deepEqual(body.messages[0], { role: "system", content: "sys" });
      assert.deepEqual(body.messages[2].tool_calls, [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"a.js"}' } }]);
      assert.deepEqual(body.messages[3], { role: "tool", tool_call_id: "t1", content: "<repository-file>" });
      assert.equal(body.tool_choice, "auto");
      assert.equal(body.response_format, undefined);
    } finally {
      await openai.close();
    }
    await assert.rejects(() => callProviderTurn({ system: "s", messages, tools, config: { ...defaultConfig, provider: "ollama", model: "m" } }), /does not support tool calling/);
  } finally {
    delete process.env.JG_EXEC_FAKE_KEY;
  }
});

test("a Semantic run with an OpenAI-compatible provider runs the tool loop over HTTP end to end", async () => {
  const server = await fakeServer([
    { choices: [{ message: { content: "", tool_calls: [{ id: "a1", type: "function", function: { name: "read_file", arguments: '{"path":"src/app.js"}' } }] } }], usage: { prompt_tokens: 300, completion_tokens: 20 } },
    { choices: [{ message: { content: JSON.stringify({ summary: "Nothing wrong in src/app.js.", examined: ["src/app.js"] }) } }], usage: { prompt_tokens: 500, completion_tokens: 40 } },
  ]);
  const ws = setupWorkspace("jg-exec-http", { "src/app.js": "exports.answer = () => 42;\n" }, { provider: "openai-compatible", extra: [`    baseUrl: ${server.url}/v1`, "    apiKeyEnv: JG_EXEC_HTTP_KEY"] });
  process.env.JG_EXEC_HTTP_KEY = "test-key-not-real";
  try {
    const { result, outcome, investigation } = await runInvestigation(ws, { scope: { mode: "selected", subjects: [{ kind: "path", value: "src" }] } });
    assert.equal(outcome.state, "completed", JSON.stringify(outcome.reason));
    assert.equal(result.decision, "passed");
    assert.equal(server.received.length, 2);
    const second = server.received[1].body.messages;
    assert.equal(second.at(-1).role, "tool");
    assert.match(second.at(-1).content, /<repository-file path="src\/app\.js"/);
    assert.deepEqual([investigation.usage.tokens.input, investigation.usage.tokens.output, investigation.usage.tokens.reported], [800, 60, true]);
    assert.equal(investigation.coverage.basis, "host-observed-reads");
    assert.deepEqual(outcome.context.paths, ["src/app.js"]);
    assert.equal(readJson(path.join(result.runDir, "evidence", "scope-ledger.json")).units.find((u) => u.id === "src/app.js").state, "clean");
  } finally {
    delete process.env.JG_EXEC_HTTP_KEY;
    ws.cleanup();
    await server.close();
  }
});

test("agent CLI wrapper: restricted read-only arguments, a staged scope, claims only from the validated artifact, real usage", async () => {
  const ws = setupWorkspace("jg-exec-cli", { "src/app.js": 'exports.find = (db, id) => db.query("SELECT * FROM t WHERE id = " + id);\n', ".env": "TOKEN=abc\n", "docs/readme.md": "# readme\n" }, { provider: "claude-code" });
  const recordFile = path.join(ws.root, "cli-calls.jsonl");
  try {
    const { result, outcome, investigation } = await runInvestigation(ws, { scope: { mode: "selected", subjects: [{ kind: "path", value: "src" }, { kind: "path", value: ".env" }] }, agentCli: { command: process.execPath, prefixArgs: [FAKE_CLI, "--fake-mode=answer", `--fake-record=${recordFile}`] } });
    const calls = fs.readFileSync(recordFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(calls.length, 2, "one process per context: hunting, then the validation of C1");
    for (const c of calls) {
      const argv = c.argv.join(" ");
      assert.match(argv, /--print --output-format json --model scripted-model --tools Read,Grep,Glob --disallowedTools Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task --strict-mcp-config --permission-mode default/);
      assert.deepEqual(c.files, ["src/app.js"], "the CLI sees only the readable, non-sensitive scope");
      assert.match(path.resolve(c.cwd), new RegExp(`${path.join("work", "scope").replace(/\\/g, "\\\\")}$`));
    }
    assert.match(calls[1].prompt, /Candidate C1 \(reported by another context/);
    assert.equal(calls[1].prompt.includes("Read src/app.js; one injection candidate."), false, "the validation process never sees the hunting answer");
    assert.equal(investigation.backend.kind, "agent-cli");
    assert.deepEqual(investigation.candidates.map((c) => [c.id, c.status]), [["C1", "confirmed"]]);
    assert.ok(investigation.stages[0].contexts[0].artifact.problems.some((p) => /src\/not-staged\.js/.test(p)), "a claim about a file outside the staged scope is dropped");
    assert.equal(investigation.coverage.basis, "agent-cli-validated-claims");
    assert.deepEqual([investigation.usage.tokens.input, investigation.usage.tokens.output, investigation.usage.tokens.reported], [3000, 300, true]);
    assert.equal(JSON.stringify(investigation).includes("everything validated"), false, "the CLI's progress claims are never taken");
    // The stages finished, but the selected .env can never be sent to a model: that subject stays unexamined and the
    // run is incomplete, not approved nor merely failed on the finding.
    assert.equal(outcome.state, "completed", JSON.stringify(outcome.reason));
    assert.equal(investigation.complete, false);
    assert.ok(investigation.coverage.gaps.some((g) => g.code === "NOT_EXAMINED" && g.path === ".env"), JSON.stringify(investigation.coverage.gaps));
    assert.equal(outcome.conclusion.status, "INCOMPLETE");
    assert.equal(result.decision, "incomplete");
    assert.deepEqual(outcome.conclusion.findings.map((f) => [f.path, f.confirmation, f.severity]), [["src/app.js", "confirmed", "blocking"]]);
    const events = fs.readFileSync(path.join(result.runDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(events.filter((e) => e.type === "process-finished").map((e) => [e.data.context, e.data.exitCode]), [["version", 0], ["hunt", 0], ["validate:C1", 0]]);
    // The result and every event (stage and process events of the investigation included) follow their schemas.
    const ajv = () => new Ajv2020({ strict: false, allErrors: true });
    const validResult = ajv().compile(readJson(path.join(here, "..", "schemas", "result", "result.schema.json")));
    assert.equal(validResult(readJson(path.join(result.runDir, "result.json"))), true, JSON.stringify(validResult.errors));
    const validEvent = ajv().compile(readJson(path.join(here, "..", "schemas", "events", "event.schema.json")));
    for (const e of events) assert.equal(validEvent(e), true, `${JSON.stringify(e)} ${JSON.stringify(validEvent.errors)}`);
    assert.equal(fs.existsSync(path.join(result.runDir, "work", "scope")), false);

    // The same CLI answering "confirmed" without valid evidence for another candidate ID: the artifact is invalid.
    const bad = await runInvestigation(ws, { scope: { mode: "selected", subjects: [{ kind: "path", value: "src" }] }, agentCli: { command: process.execPath, prefixArgs: [FAKE_CLI, "--fake-mode=answer", "--fake-verdict=probably"] } });
    assert.equal(bad.outcome.state, "invalid");
    assert.equal(bad.result.decision, "invalid");
    assert.equal(bad.result.exitCode, 3);
    assert.equal(bad.investigation.candidates[0].status, "unresolved");
  } finally {
    ws.cleanup();
  }
});

test("invalid artifacts leave the work invalid and incomplete; providers without tools and missing scripts are unavailable", async () => {
  const ws = setupWorkspace("jg-exec-invalid", { "src/app.js": "exports.answer = () => 42;\n" });
  try {
    const { script } = recordingScript({ hunt: [{ toolCalls: [{ name: "read_file", arguments: { path: "src/app.js" } }], usage: usage(10, 5) }, { text: "Looks great, ship it!", usage: usage(10, 5) }] });
    const r = await runInvestigation(ws, { script });
    assert.equal(r.outcome.state, "invalid");
    assert.equal(r.result.decision, "invalid");
    assert.equal(r.result.complete, false);
    assert.equal(r.investigation.stages[0].contexts[0].artifact.code, "malformed-output");
    assert.equal(r.outcome.conclusion.status, "INVALID");

    // A JSON script file named by SEMANTIC_GATE_MOCK_TOOL_SCRIPT drives the mock provider of the package.
    const scriptFile = path.join(ws.root, "script.json");
    fs.writeFileSync(scriptFile, JSON.stringify({ contexts: { hunt: [{ toolCalls: [{ name: "read_file", arguments: { path: "src/app.js" } }, { name: "read_file", arguments: { path: "jgates.yml" } }], usage: usage(20, 5) }, { text: JSON.stringify({ summary: "Clean.", examined: ["src/app.js", "jgates.yml"] }), usage: usage(30, 5) }] } }));
    const fromFile = await runInvestigation({ ...ws, env: { ...ws.env, SEMANTIC_GATE_MOCK_TOOL_SCRIPT: scriptFile } }, {});
    assert.equal(fromFile.outcome.state, "completed", JSON.stringify(fromFile.outcome.reason));
    assert.equal(fromFile.investigation.usage.tokens.total, 60);

    // The mock provider without a script, and a provider without tool calling, send nothing and are never favorable.
    const noScript = await runInvestigation(ws, {});
    assert.equal(noScript.outcome.state, "unavailable");
    assert.match(noScript.outcome.reason, /tool script/);
    assert.notEqual(noScript.result.decision, "passed");
  } finally {
    ws.cleanup();
  }
  const ollama = setupWorkspace("jg-exec-ollama", { "src/app.js": "exports.answer = () => 42;\n" }, { provider: "ollama" });
  try {
    const r = await runInvestigation(ollama, {});
    assert.equal(r.outcome.state, "unavailable");
    assert.equal(r.outcome.code, "NO_TOOL_BACKEND");
    assert.notEqual(r.result.decision, "passed");
  } finally {
    ollama.cleanup();
  }
});

test("modules: the run service picks the module registered for the plan's method", () => {
  assert.equal(exec.investigationModuleFor(["general-review"]), null, "the general review stays a context-only review");
  assert.equal(exec.investigationModuleFor(["investigation"]).id, "investigation");
  const custom = { ...exec.INVESTIGATION_MODULE, id: "custom-test", stages: exec.INVESTIGATION_MODULE.stages.slice(0, 1) };
  exec.registerInvestigationModule("custom-method-test", custom);
  assert.equal(exec.investigationModuleFor(["general-review", "custom-method-test"]).id, "custom-test");
  assert.ok(exec.registeredInvestigationModules().some((m) => m.methodId === "custom-method-test"));
});
