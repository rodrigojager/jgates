import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The user key store and jgates secrets (D9). Every test points SEMANTIC_GATE_HOME (the store) and JGATES_HOME (the data
// folder) at temporary folders: the real user's files are never read nor written. The providers are fakes (a script
// for the command provider, a local HTTP server for the model listing), so no test spends model tokens.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const DIST = path.join(repo, "jgates", "dist");
const MAIN = path.join(DIST, "cli", "main.js");
const SG_CLI = path.join(repo, "semantic-gate", "dist", "cli.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const POSIX = process.platform !== "win32";
const require = createRequire(import.meta.url);
const { createPiiFixture, removePiiFixture } = require(path.join(repo, "tests", "fixtures", "jgates", "pii-fixture.js"));

const cleanups = [];
test.after(() => {
  for (const fn of cleanups.reverse()) fn();
});
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** An environment with temporary homes and none of the names the tests use (whatever the machine has). */
function homes() {
  const store = path.join(tmp("jgates-secrets-store-"), "semantic-gate");
  const data = tmp("jgates-secrets-data-");
  const env = { ...process.env, SEMANTIC_GATE_HOME: store, JGATES_HOME: data, JGATES_PYTHON: PYTHON, NO_COLOR: "1" };
  for (const name of Object.keys(env)) if (/_API_KEY$|^SEMANTIC_GATE_BASE_URL$|^JGATES_TEST_|^FAKE_PROVIDER_KEY$|^PII_TOOL_KEY$|^CI_PROBE_KEY$/.test(name)) delete env[name];
  return { store, data, env, file: path.join(store, "secrets.json") };
}

function jgates(env, args, { input = "", cwd } = {}) {
  const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input, cwd, timeout: 120_000 });
  let doc = null;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    doc = null;
  }
  return { code: r.status, out: r.stdout, err: r.stderr, doc };
}

function jgatesAsync(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (out += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      let doc = null;
      try {
        doc = JSON.parse(out);
      } catch {
        doc = null;
      }
      resolve({ code, out, err, doc });
    });
  });
}

/** Every file under a folder, as one text (to look for a value anywhere: results, logs, events, caches). */
function allText(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(`${full}\n${fs.readFileSync(full, "latin1")}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

const listed = (doc, name) => doc.secrets.find((s) => s.name === name);

test("set stores 0600 outside the project; list shows state, source and date without the value (text and JSON); unset removes", () => {
  const h = homes();
  const project = tmp("jgates-secrets-project-");
  const value = "sk-or-v1-Zq81Wm4Xc7Tn2Lp9";
  const set = jgates(h.env, ["secrets", "set", "OPENROUTER_API_KEY", "--json"], { input: `${value}\n`, cwd: project });
  assert.equal(set.code, 0, set.out + set.err);
  assert.equal(set.doc.vault, h.file);
  assert.equal(set.doc.secret.state, "set");
  assert.equal(set.doc.secret.source, "vault");
  assert.ok(!set.out.includes(value) && !set.err.includes(value));
  // The file is the store, outside the project and outside the JGates data folder.
  const doc = JSON.parse(fs.readFileSync(h.file, "utf8"));
  assert.equal(doc.schemaVersion, 2);
  assert.equal(doc.secrets.OPENROUTER_API_KEY.value, value);
  assert.match(doc.secrets.OPENROUTER_API_KEY.updatedAt, /^\d{4}-\d\d-\d\dT/);
  if (POSIX) {
    assert.equal(fs.statSync(h.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(h.store).mode & 0o777, 0o700);
  }
  assert.deepEqual(fs.readdirSync(project), [], "nothing is written in the project");
  assert.ok(!allText(h.data).includes(value), "nothing of the value is in the JGates data folder");

  const json = jgates(h.env, ["secrets", "list", "--json"]);
  assert.equal(json.code, 0, json.err);
  const entry = listed(json.doc, "OPENROUTER_API_KEY");
  assert.deepEqual(
    { state: entry.state, source: entry.source, inVault: entry.inVault, provider: entry.provider, environmentWins: entry.environmentWins },
    { state: "set", source: "vault", inVault: true, provider: "openrouter", environmentWins: false },
  );
  assert.equal(entry.updatedAt, doc.secrets.OPENROUTER_API_KEY.updatedAt);
  assert.equal(listed(json.doc, "ANTHROPIC_API_KEY").state, "unset");
  const text = jgates(h.env, ["secrets", "list", "--locale", "en"]);
  assert.equal(text.code, 0, text.err);
  const line = text.out.split("\n").find((l) => l.startsWith("OPENROUTER_API_KEY"));
  assert.match(line, /\bset\b.*\*{8}.*\d{4}-\d\d-\d\d.*key store/);
  for (const out of [json.out, text.out]) for (let i = 0; i + 4 <= value.length; i++) assert.ok(!out.includes(value.slice(i, i + 4)), `the listing shows ${value.slice(i, i + 4)}`);

  const unset = jgates(h.env, ["secrets", "unset", "OPENROUTER_API_KEY", "--json"]);
  assert.equal(unset.code, 0, unset.err);
  assert.equal(unset.doc.removed, true);
  assert.equal(listed(jgates(h.env, ["secrets", "list", "--json"]).doc, "OPENROUTER_API_KEY").state, "unset");
  assert.ok(!fs.readFileSync(h.file, "utf8").includes(value));
  assert.equal(jgates(h.env, ["secrets", "unset", "OPENROUTER_API_KEY", "--json"]).doc.removed, false);
});

test("an invalid name and a value given as an argument are refused, and the value is never repeated", () => {
  const h = homes();
  for (const name of ["openrouter_api_key", "1KEY", "MY-KEY"]) {
    const r = jgates(h.env, ["secrets", "set", name, "--json"], { input: "x\n" });
    assert.equal(r.code, 3, name);
    assert.equal(r.doc.code, "INVALID_NAME");
  }
  const arg = jgates(h.env, ["secrets", "set", "MY_KEY", "value-in-argv-123", "--json"], { input: "x\n" });
  assert.equal(arg.code, 3);
  assert.equal(arg.doc.code, "VALUE_AS_ARGUMENT");
  assert.ok(!arg.out.includes("value-in-argv-123") && !arg.err.includes("value-in-argv-123"));
  const flag = jgates(h.env, ["secrets", "set", "MY_KEY", "--value", "value-in-flag-123", "--json"]);
  assert.equal(flag.code, 3);
  assert.ok(!flag.out.includes("value-in-flag-123"));
  assert.equal(jgates(h.env, ["secrets", "set", "MY_KEY", "--json"], { input: "\n" }).doc.code, "INVALID_VALUE");
  assert.equal(jgates(h.env, ["secrets", "nope", "--json"]).doc.code, "UNKNOWN_ACTION");
  assert.ok(!fs.existsSync(h.file), "nothing was stored");
});

test("the environment wins over the store and the listing and set say so", () => {
  const h = homes();
  assert.equal(jgates(h.env, ["secrets", "set", "ANTHROPIC_API_KEY"], { input: "from-the-store-1\n" }).code, 0);
  const env = { ...h.env, ANTHROPIC_API_KEY: "from-the-env-1" };
  const entry = listed(jgates(env, ["secrets", "list", "--json"]).doc, "ANTHROPIC_API_KEY");
  assert.deepEqual({ source: entry.source, envName: entry.envName, inVault: entry.inVault, environmentWins: entry.environmentWins }, { source: "env", envName: "ANTHROPIC_API_KEY", inVault: true, environmentWins: true });
  // An alternate the provider also reads counts as the environment of the provider's name.
  const alternate = listed(jgates({ ...h.env, CLAUDE_API_KEY: "alt" }, ["secrets", "list", "--json"]).doc, "ANTHROPIC_API_KEY");
  assert.equal(alternate.source, "env");
  assert.equal(alternate.envName, "CLAUDE_API_KEY");
  const text = jgates(env, ["secrets", "list", "--locale", "en"]).out;
  assert.match(text, /environment \(ANTHROPIC_API_KEY\)/);
  assert.match(text, /wins over the stored value/);
  const set = jgates(env, ["secrets", "set", "ANTHROPIC_API_KEY", "--locale", "en"], { input: "from-the-store-2\n" });
  assert.equal(set.code, 0);
  assert.match(set.err, /environment variable ANTHROPIC_API_KEY is set and wins/);
  for (const out of [text, set.out, set.err]) assert.ok(!/from-the-(store|env)/.test(out));
});

test("an entry of the first format (by provider) is read and rewritten in the new format on the next write; both packages share the file", () => {
  const h = homes();
  fs.mkdirSync(h.store, { recursive: true });
  fs.writeFileSync(h.file, JSON.stringify({ openrouter: "legacy-openrouter-1", claude: "legacy-claude-1" }), { mode: 0o600 });
  const before = jgates(h.env, ["secrets", "list", "--json"]).doc;
  assert.equal(listed(before, "OPENROUTER_API_KEY").source, "vault");
  assert.equal(listed(before, "ANTHROPIC_API_KEY").source, "vault");
  assert.ok("openrouter" in JSON.parse(fs.readFileSync(h.file, "utf8")), "a read does not rewrite the file");
  assert.equal(jgates(h.env, ["secrets", "set", "MY_GATEWAY_KEY"], { input: "gateway-1\n" }).code, 0);
  const doc = JSON.parse(fs.readFileSync(h.file, "utf8"));
  assert.deepEqual(Object.keys(doc).sort(), ["schemaVersion", "secrets"]);
  assert.deepEqual(Object.keys(doc.secrets), ["ANTHROPIC_API_KEY", "MY_GATEWAY_KEY", "OPENROUTER_API_KEY"]);
  assert.equal(doc.secrets.OPENROUTER_API_KEY.value, "legacy-openrouter-1");
  // The semantic-gate package reads what JGates wrote, and JGates lists what semantic-gate wrote.
  const status = spawnSync(process.execPath, [SG_CLI, "status", "--provider", "openrouter", "--json"], { encoding: "utf8", env: h.env, cwd: h.data });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).credential.source, "stored");
  const sgSet = spawnSync(process.execPath, [SG_CLI, "auth", "set", "OPENAI_API_KEY", "--key-stdin"], { encoding: "utf8", env: h.env, input: "from-semantic-gate-1\n" });
  assert.equal(sgSet.status, 0, sgSet.stderr);
  assert.equal(listed(jgates(h.env, ["secrets", "list", "--json"]).doc, "OPENAI_API_KEY").source, "vault");
});

// ---- a run with a key of the store ---------------------------------------------------------------------------------------

const APPROVED = JSON.stringify({ status: "APPROVED", score: 100, findings: [], hardBlockers: [], requiredFixPlan: [], approvalNotes: "Fake provider approved." });

test("a run gets the stored key only in the processes that declare it, and no value reaches result, logs or events", () => {
  const h = homes();
  const providerValue = "vault-provider-Q8x2Lm7Zp4";
  const toolValue = "vault-pii-tool-R3k9Vn6Yw1";
  assert.equal(jgates(h.env, ["secrets", "set", "FAKE_PROVIDER_KEY"], { input: `${providerValue}\n` }).code, 0);
  assert.equal(jgates(h.env, ["secrets", "set", "PII_TOOL_KEY"], { input: `${toolValue}\n` }).code, 0);

  const fixture = createPiiFixture();
  cleanups.push(() => removePiiFixture(fixture.dir));
  const aux = tmp("jgates-secrets-aux-");
  const seen = path.join(aux, "seen.jsonl");
  // The fakes record only whether each name arrived with the right value: no value is ever written by them.
  const provider = path.join(aux, "fake-provider.mjs");
  fs.writeFileSync(
    provider,
    `import fs from "node:fs";
for await (const _ of process.stdin) {}
fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ who: "provider", declared: process.env.FAKE_PROVIDER_KEY === ${JSON.stringify(providerValue)}, other: process.env.PII_TOOL_KEY === undefined }) + "\\n");
process.stdout.write(${JSON.stringify(APPROVED)});
`,
  );
  const tool = path.join(aux, "fake-tool.mjs");
  fs.writeFileSync(
    tool,
    `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ who: process.argv[2], declared: process.env.PII_TOOL_KEY === ${JSON.stringify(toolValue)}, absent: process.env.PII_TOOL_KEY === undefined, other: process.env.FAKE_PROVIDER_KEY === undefined }) + "\\n");
process.stdout.write(JSON.stringify({ jgatesMask: 1, status: "ok", detected: false, changed: false }) + "\\n");
`,
  );
  const init = jgates(h.env, ["init", "--cwd", fixture.dir, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  const configFile = path.join(fixture.dir, "jgates.yml");
  const block = [
    "extensions:",
    "  semantic-gate:",
    "    provider: command",
    `    command: ${JSON.stringify(process.execPath)}`,
    `    commandArgs: [${JSON.stringify(provider)}]`,
    "    apiKeyEnv: FAKE_PROVIDER_KEY",
    "    model: fake-model",
    "    timeoutSeconds: 60",
    "    masking:",
    "      tools: [declares, undeclared]",
    "",
  ].join("\n");
  fs.writeFileSync(configFile, `${fs.readFileSync(configFile, "utf8").replace(/\n*$/, "\n")}${block}`);
  fs.mkdirSync(path.join(fixture.dir, ".jgates"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.dir, ".jgates", "pii.yml"),
    [
      "schemaVersion: 1",
      "tools:",
      `  declares: { command: ${JSON.stringify(process.execPath)}, args: ${JSON.stringify([tool, "declares"])}, passEnv: [PII_TOOL_KEY] }`,
      `  undeclared: { command: ${JSON.stringify(process.execPath)}, args: ${JSON.stringify([tool, "undeclared"])} }`,
      "",
    ].join("\n"),
  );
  spawnSync("git", ["init", "-q"], { cwd: fixture.dir });
  const events = path.join(aux, "events.jsonl");
  const r = jgates(h.env, ["run", "--cwd", fixture.dir, "--no-interactive", "--json", "--only", "tool:builtin-pii", "--semantic", "--events-jsonl", events]);
  assert.ok(r.doc, r.out + r.err);
  assert.equal(r.doc.semantic.state, "completed", JSON.stringify(r.doc.semantic));
  const records = fs.readFileSync(seen, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(records.find((x) => x.who === "provider"), { who: "provider", declared: true, other: true });
  assert.deepEqual(records.find((x) => x.who === "declares"), { who: "declares", declared: true, absent: false, other: true });
  assert.deepEqual(records.find((x) => x.who === "undeclared"), { who: "undeclared", declared: false, absent: true, other: true });

  // No value anywhere: the answer, the events, the data folder (result.json, logs, caches) and the project.
  assert.ok(fs.existsSync(events));
  // (The fake scripts themselves hold the values to compare with; what the run wrote next to them is checked.)
  const everything = [r.out, r.err, allText(h.data), allText(fixture.dir), fs.readFileSync(events, "utf8"), fs.readFileSync(seen, "utf8")].join("\n");
  assert.ok(everything.includes("result.json"), "the run left its result in the data folder");
  for (const value of [providerValue, toolValue]) assert.ok(!everything.includes(value), `${value} leaked`);
});

// ---- jgates ci ---------------------------------------------------------------------------------------------------------

test("jgates ci never uses the store: the process blocks it before anything runs", () => {
  const h = homes();
  const workspace = tmp("jgates-secrets-ci-");
  const script = path.join(tmp("jgates-secrets-ci-script-"), "probe.mjs");
  const mod = (p) => JSON.stringify(pathToFileURL(path.join(DIST, p)).href);
  fs.writeFileSync(
    script,
    `import fs from "node:fs";
import path from "node:path";
const secrets = await import(${mod("core/secrets/index.js")});
const tools = await import(${mod("core/mask-tools/index.js")});
const { command } = await import(${mod("cli/commands/ci.js")});
const { runSemanticReview, loadGate } = await import(${mod("adapters/semantic-gate/index.js")});
secrets.setSecret("CI_PROBE_KEY", "ci-probe-value-1");
const before = secrets.resolveSecret("CI_PROBE_KEY")?.source ?? null;
const sink = { stdout: () => {}, stderr: () => {} };
const code = await command.run({ args: [], options: { cwd: ${JSON.stringify(workspace)} }, lists: {}, json: true, version: "0", commands: [], t: (k) => k, ...sink });
let setError = null;
try { secrets.setSecret("CI_PROBE_KEY", "x"); } catch (e) { setError = e.code; }
const listed = secrets.listSecrets().find((s) => s.name === "CI_PROBE_KEY") ?? null;
// A PII tool that declares the name gets nothing from the store.
const toolFile = path.join(${JSON.stringify(workspace)}, "tool.mjs");
fs.writeFileSync(toolFile, "process.stdout.write(JSON.stringify({ jgatesMask: 1, status: 'ok', detected: false, changed: process.env.CI_PROBE_KEY !== undefined }) + '\\\\n');");
const ws = tools.createMaskWorkspace([{ path: "a.txt", content: "x" }]);
const outcome = await tools.runMaskTool({ id: "t", command: process.execPath, args: [toolFile], timeoutSeconds: 30, passEnv: ["CI_PROBE_KEY"] }, ws, { mode: "context" });
ws.cleanup();
// The provider is told to use only the environment.
fs.writeFileSync(path.join(${JSON.stringify(workspace)}, "jgates.yml"), "schemaVersion: 1\\nextensions:\\n  semantic-gate:\\n    provider: command\\n    apiKeyEnv: CI_PROBE_KEY\\n");
let secretStore = "not-called";
const real = await loadGate();
const gate = { ...real, collectGitReviewContext: async () => ({ ...real.defaultConfig, changedFiles: [{ path: "a.js", diff: "+x\\n", changeKinds: ["unstaged"] }], warnings: [], commandsExecuted: [], statusShort: "", diffStat: "", stagedDiffStat: "" }) };
await runSemanticReview(${JSON.stringify(workspace)}, { env: process.env }, { loadGate: async () => gate, callProvider: async (request) => { secretStore = request.config.secretStore ?? null; return { text: ${JSON.stringify(APPROVED)}, raw: null }; } });
process.stdout.write(JSON.stringify({ before, code, blocked: secrets.vaultBlocked(), after: secrets.resolveSecret("CI_PROBE_KEY") ?? null, setError, listedSource: listed?.source ?? null, toolOk: outcome.ok, toolGotValue: outcome.ok ? outcome.status.changed : null, secretStore }));
`,
  );
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: h.env, timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(doc, { before: "vault", code: 3, blocked: true, after: null, setError: "VAULT_BLOCKED", listedSource: null, toolOk: true, toolGotValue: false, secretStore: false });
  // With the variable in the environment of the pipeline, the governed path still has it.
  assert.equal(r.stdout.includes("ci-probe-value"), false);
});

// ---- jgates secrets test -------------------------------------------------------------------------------------------------

test("secrets test lists the provider's models with the stored key and never shows it, also when the provider fails", async () => {
  const h = homes();
  const value = "sk-test-openai-K4n8Bq2Vx6";
  assert.equal(jgates(h.env, ["secrets", "set", "OPENAI_API_KEY"], { input: `${value}\n` }).code, 0);
  const seen = [];
  let fail = false;
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url, auth: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    if (fail) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${value}` } }));
      return;
    }
    response.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const env = { ...h.env, SEMANTIC_GATE_BASE_URL: `http://127.0.0.1:${server.address().port}` };
    const ok = await jgatesAsync(env, ["secrets", "test", "OPENAI_API_KEY", "--json"]);
    assert.equal(ok.code, 0, ok.out + ok.err);
    assert.deepEqual({ models: ok.doc.models, sample: ok.doc.sample, source: ok.doc.source, provider: ok.doc.provider }, { models: 2, sample: ["model-a", "model-b"], source: "vault", provider: "openai" });
    assert.deepEqual(seen, [{ url: "/models", auth: `Bearer ${value}` }]);
    fail = true;
    const bad = await jgatesAsync(env, ["secrets", "test", "OPENAI_API_KEY", "--json"]);
    assert.equal(bad.code, 1, bad.out + bad.err);
    assert.equal(bad.doc.code, "TEST_FAILED");
    for (const out of [ok.out, ok.err, bad.out, bad.err]) assert.ok(!out.includes(value));
    const unknown = await jgatesAsync(env, ["secrets", "test", "MY_OWN_KEY", "--json"]);
    assert.equal(unknown.doc.code, "NOT_TESTABLE");
    const missing = await jgatesAsync(env, ["secrets", "test", "GEMINI_API_KEY", "--json"]);
    assert.equal(missing.doc.code, "SECRET_NOT_SET");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an invalid name that looks like a key is refused and never echoed", () => {
  const h = homes();
  const fake = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV0123456789";
  for (const action of ["set", "unset", "test"]) {
    for (const json of [false, true]) {
      const r = jgates(h.env, ["secrets", action, fake, ...(json ? ["--json"] : [])], { input: "x\n" });
      assert.equal(r.code, 3, `${action} json=${json}`);
      assert.ok(!r.out.includes("ABCDEFGH") && !r.err.includes("ABCDEFGH") && !r.out.includes("sk-ant") && !r.err.includes("sk-ant"), `${action} json=${json}`);
      if (json) assert.equal(r.doc.code, "INVALID_NAME");
    }
  }
  assert.ok(!fs.existsSync(h.file), "nothing was stored");
});
