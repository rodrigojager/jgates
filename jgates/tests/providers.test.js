import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The user's provider preferences and the named connections (D10). Every test points SEMANTIC_GATE_HOME (the
// preferences and the key store) and JGATES_HOME (the data folder) at temporary folders: the real user's files are never
// read nor written. The providers are fakes (a local HTTP server that speaks the OpenAI API), so no test spends tokens.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const DIST = path.join(repo, "jgates", "dist");
const MAIN = path.join(DIST, "cli", "main.js");
const SG_DIST = path.join(repo, "semantic-gate", "dist");
const SG_CLI = path.join(SG_DIST, "cli.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const require = createRequire(import.meta.url);
const { createPiiFixture, removePiiFixture } = require(path.join(repo, "tests", "fixtures", "jgates", "pii-fixture.js"));
const mod = (p) => import(pathToFileURL(path.join(DIST, p)).href);

const cleanups = [];
test.after(() => {
  for (const fn of cleanups.reverse()) fn();
});
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** An environment with temporary homes and none of the key names or provider variables of the machine. */
function homes() {
  const store = path.join(tmp("jgates-providers-store-"), "semantic-gate");
  const data = tmp("jgates-providers-data-");
  const env = { ...process.env, SEMANTIC_GATE_HOME: store, JGATES_HOME: data, JGATES_PYTHON: PYTHON, NO_COLOR: "1" };
  for (const name of Object.keys(env)) if (/_API_KEY$|^SEMANTIC_GATE_(?!HOME$)|^LITELLM_|^OLLAMA_HOST$/.test(name)) delete env[name];
  return { store, data, env, config: path.join(store, "config.json") };
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

/** Runs a CLI without blocking this process, so the fake server of the test can answer it. */
function runAsync(file, env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
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

const APPROVED = JSON.stringify({ status: "APPROVED", score: 100, findings: [], hardBlockers: [], requiredFixPlan: [], approvalNotes: "Fake gateway approved." });

/** A fake OpenAI-compatible gateway on loopback: records method, path, key and extra header of every request. */
async function fakeGateway() {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (c) => (body += c));
    request.on("end", () => {
      let json = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {
        json = null;
      }
      seen.push({ method: request.method, url: request.url, auth: request.headers.authorization ?? null, team: request.headers["x-team"] ?? null, model: json?.model ?? null });
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && request.url === "/v1/models") {
        response.end(JSON.stringify({ data: [{ id: "gateway-model-a" }, { id: "gateway-model-b" }] }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        response.end(JSON.stringify({ choices: [{ message: { content: APPROVED } }] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => new Promise((resolve) => server.close(resolve));
  return { seen, url: `http://127.0.0.1:${server.address().port}/v1`, close };
}

/** A project of the PII fixture with a git repository and a semantic-gate block appended to jgates.yml. */
function project(env, blockLines) {
  const fixture = createPiiFixture();
  cleanups.push(() => removePiiFixture(fixture.dir));
  const init = jgates(env, ["init", "--cwd", fixture.dir, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  const configFile = path.join(fixture.dir, "jgates.yml");
  fs.writeFileSync(configFile, `${fs.readFileSync(configFile, "utf8").replace(/\n*$/, "\n")}${["extensions:", "  semantic-gate:", ...blockLines.map((l) => `    ${l}`), ""].join("\n")}`);
  spawnSync("git", ["init", "-q"], { cwd: fixture.dir });
  return fixture.dir;
}

// ---- a connection from jgates.yml to the gateway ----------------------------------------------------------------------------

test("a connection litellm-local with a base URL and a key of the store sends the review to that URL with that key, from provider: litellm-local", async () => {
  const h = homes();
  const gateway = await fakeGateway();
  try {
    const value = "litellm-vault-key-T7q2Mx9Pz4";
    const add = jgates(h.env, ["providers", "add", "litellm-local", "--base-url", gateway.url, "--key-env", "LITELLM_API_KEY", "--model", "gateway-model-a", "--header", "X-Team=core", "--json"]);
    assert.equal(add.code, 0, add.out + add.err);
    assert.equal(add.doc.provider.kind, "connection");
    assert.deepEqual(add.doc.provider.baseUrl, { value: gateway.url, origin: "user" });
    assert.equal(jgates(h.env, ["secrets", "set", "LITELLM_API_KEY"], { input: `${value}\n` }).code, 0);
    // The preferences are in the global config.json next to the key store, and carry no value of a key.
    const saved = fs.readFileSync(h.config, "utf8");
    assert.ok(!saved.includes(value));
    assert.deepEqual(JSON.parse(saved).connections["litellm-local"], { type: "openai-compatible", baseUrl: gateway.url, model: "gateway-model-a", apiKeyEnv: "LITELLM_API_KEY", headers: { "X-Team": "core" } });

    const dir = project(h.env, ["provider: litellm-local", "timeoutSeconds: 60"]);
    const r = await runAsync(MAIN, h.env, ["run", "--cwd", dir, "--no-interactive", "--json", "--only", "tool:builtin-pii", "--semantic"]);
    assert.ok(r.doc, r.out + r.err);
    assert.equal(r.doc.semantic.state, "completed", JSON.stringify(r.doc.semantic));
    const calls = gateway.seen.filter((s) => s.method === "POST");
    assert.ok(calls.length >= 1, JSON.stringify(gateway.seen));
    for (const call of calls) assert.deepEqual(call, { method: "POST", url: "/v1/chat/completions", auth: `Bearer ${value}`, team: "core", model: "gateway-model-a" });
    assert.equal(r.doc.semantic.provider, "litellm-local");
    assert.equal(r.doc.semantic.model, "gateway-model-a");
    assert.deepEqual(r.doc.semantic.effective, {
      provider: "litellm-local",
      kind: "connection",
      preferences: "used",
      baseUrl: { value: gateway.url, origin: "user" },
      model: { value: "gateway-model-a", origin: "user" },
      apiKeyEnv: { value: "LITELLM_API_KEY", origin: "user" },
      headers: ["X-Team"],
      allowInsecureHttp: false,
    });
    assert.ok(!r.out.includes(value) && !r.err.includes(value), "the key never reaches the output");
  } finally {
    await gateway.close();
  }
});

// ---- precedence and origins ---------------------------------------------------------------------------------------------------

test("project > user > default holds field by field, and the state (GET /api/semantic and the result) shows the origin of each value", async () => {
  const h = homes();
  const set = jgates(h.env, ["providers", "set", "openrouter", "--base-url", "https://proxy.example.com/api/v1", "--model", "user-model", "--json"]);
  assert.equal(set.code, 0, set.out + set.err);
  assert.deepEqual(set.doc.provider.apiKeyEnv, { value: "OPENROUTER_API_KEY", origin: "default" });
  const dir = project(h.env, ["provider: openrouter", "model: project-model"]);

  process.env.SEMANTIC_GATE_HOME = h.store;
  const { readSemanticState, runSemanticReview, loadGate } = await mod("adapters/semantic-gate/index.js");
  const { routes } = await mod("server/routes/semantic.js");
  const route = routes.find((r) => r.path === "/api/semantic");
  const answer = await route.handler({ server: { projectDir: dir } });
  assert.equal(answer.json.state, "configured", JSON.stringify(answer.json.problems));
  assert.equal(answer.json.model, "project-model");
  assert.deepEqual(
    { baseUrl: answer.json.effective.baseUrl, model: answer.json.effective.model, apiKeyEnv: answer.json.effective.apiKeyEnv, kind: answer.json.effective.kind },
    { baseUrl: { value: "https://proxy.example.com/api/v1", origin: "user" }, model: { value: "project-model", origin: "project" }, apiKeyEnv: { value: "OPENROUTER_API_KEY", origin: "default" }, kind: "provider" },
  );

  // Each field on its own: the project's key name over the default, the user's model when the project has none.
  fs.writeFileSync(path.join(dir, "jgates.yml"), fs.readFileSync(path.join(dir, "jgates.yml"), "utf8").replace("    model: project-model\n", "    apiKeyEnv: TEAM_OPENROUTER_KEY\n"));
  const second = readSemanticState(dir, { env: h.env });
  assert.deepEqual(
    [second.effective.baseUrl.origin, second.effective.model, second.effective.apiKeyEnv],
    ["user", { value: "user-model", origin: "user" }, { value: "TEAM_OPENROUTER_KEY", origin: "project" }],
  );
  // Without the preferences only the project and the defaults are left.
  const bare = readSemanticState(dir, { env: h.env, preferences: false });
  assert.deepEqual([bare.effective.baseUrl, bare.effective.model, bare.effective.preferences], [{ value: "https://openrouter.ai/api/v1", origin: "default" }, { value: null, origin: "unset" }, "ignored"]);

  // The run hands the package the values of the project and of the user (the defaults stay with the package), and the
  // result carries the origins.
  const real = await loadGate();
  const gate = { ...real, collectGitReviewContext: async () => ({ ...real.defaultConfig, repoRoot: dir, changedFiles: [{ path: "a.js", diff: "+x\n", changeKinds: ["unstaged"] }], warnings: [], commandsExecuted: [], statusShort: "", diffStat: "", stagedDiffStat: "" }) };
  let seenConfig = null;
  const outcome = await runSemanticReview(dir, { env: h.env }, { loadGate: async () => gate, callProvider: async (request) => ((seenConfig = request.config), { text: APPROVED, raw: null }) });
  assert.equal(outcome.state, "completed", JSON.stringify(outcome));
  assert.deepEqual([seenConfig.provider, seenConfig.baseUrl, seenConfig.model, seenConfig.apiKeyEnv], ["openrouter", "https://proxy.example.com/api/v1", "user-model", "TEAM_OPENROUTER_KEY"]);
  assert.equal(outcome.model, "user-model");
  assert.deepEqual(outcome.effective.model, { value: "user-model", origin: "user" });
  assert.deepEqual(outcome.effective.apiKeyEnv, { value: "TEAM_OPENROUTER_KEY", origin: "project" });

  // The result is valid against the result schema with the new block.
  const schema = JSON.parse(fs.readFileSync(path.join(repo, "jgates", "schemas", "result", "result.schema.json"), "utf8"));
  assert.ok(schema.properties.semantic.properties.effective, "the result schema documents semantic.effective");
});

// ---- validation -----------------------------------------------------------------------------------------------------------------

test("plain http to a host that is not loopback without confirmation, a header with a credential name and a name of a known provider are refused, with the field", () => {
  const h = homes();
  const fieldsOf = (r) => r.doc.errors.map((e) => [e.field, e.code]);

  const insecure = jgates(h.env, ["providers", "add", "team-gw", "--base-url", "http://10.20.30.40:4000/v1", "--json"]);
  assert.equal(insecure.code, 3, insecure.out + insecure.err);
  assert.deepEqual(fieldsOf(insecure), [["baseUrl", "INSECURE_HTTP"]]);
  assert.ok(!fs.existsSync(h.config), "nothing is written when a field is refused");
  const setInsecure = jgates(h.env, ["providers", "set", "openai", "--base-url", "http://proxy.internal/v1", "--json"]);
  assert.deepEqual(fieldsOf(setInsecure), [["baseUrl", "INSECURE_HTTP"]]);
  // Loopback needs no confirmation; any other host is accepted with --allow-http, and the entry says so.
  assert.equal(jgates(h.env, ["providers", "add", "local-gw", "--base-url", "http://localhost:4000/v1", "--json"]).code, 0);
  const confirmed = jgates(h.env, ["providers", "add", "team-gw", "--base-url", "http://10.20.30.40:4000/v1", "--allow-http", "--json"]);
  assert.equal(confirmed.code, 0, confirmed.out + confirmed.err);
  assert.equal(confirmed.doc.provider.allowInsecureHttp, true);
  // A new base URL drops the confirmation given for the old one.
  const moved = jgates(h.env, ["providers", "set", "team-gw", "--base-url", "http://10.20.30.41:4000/v1", "--json"]);
  assert.deepEqual(fieldsOf(moved), [["baseUrl", "INSECURE_HTTP"]]);
  const userInUrl = jgates(h.env, ["providers", "add", "with-user", "--base-url", "https://user:pass@gw.example.com/v1", "--json"]);
  assert.deepEqual(fieldsOf(userInUrl), [["baseUrl", "URL_CREDENTIALS"]]);
  assert.ok(!userInUrl.out.includes("pass@"), "a refused URL is never repeated");

  for (const name of ["Authorization", "X-Api-Key", "X-Auth-Token", "api-key", "X-Client-Secret"]) {
    const r = jgates(h.env, ["providers", "add", "hdr-gw", "--base-url", "https://gw.example.com/v1", "--header", `${name}=sk-header-value-1`, "--json"]);
    assert.equal(r.code, 3, `${name}: ${r.out}`);
    assert.deepEqual(fieldsOf(r), [[`headers.${name}`, "CREDENTIAL_HEADER"]]);
    assert.ok(!r.out.includes("sk-header-value-1"), "a refused header value is never repeated");
  }
  const bearer = jgates(h.env, ["providers", "add", "hdr-gw", "--base-url", "https://gw.example.com/v1", "--header", "X-Forward=Bearer abc", "--json"]);
  assert.deepEqual(fieldsOf(bearer), [["headers.X-Forward", "CREDENTIAL_HEADER"]]);

  for (const name of ["openai", "claude", "ollama", "command", "mock", "codex-cli"]) {
    const r = jgates(h.env, ["providers", "add", name, "--base-url", "https://gw.example.com/v1", "--json"]);
    assert.deepEqual(fieldsOf(r), [["name", "NAME_COLLIDES"]], name);
  }
  assert.deepEqual(fieldsOf(jgates(h.env, ["providers", "add", "Bad_Name", "--base-url", "https://gw.example.com/v1", "--json"])), [["name", "INVALID_NAME"]]);
  // Several refused fields are reported at once.
  const many = jgates(h.env, ["providers", "add", "openai", "--base-url", "http://10.0.0.5/v1", "--header", "Authorization=x", "--key-env", "lower", "--json"]);
  assert.deepEqual(fieldsOf(many), [["name", "NAME_COLLIDES"], ["baseUrl", "INSECURE_HTTP"], ["apiKeyEnv", "INVALID_KEY_NAME"], ["headers.Authorization", "CREDENTIAL_HEADER"]]);
  // A CLI provider has no base URL nor key name.
  assert.deepEqual(fieldsOf(jgates(h.env, ["providers", "set", "codex-cli", "--base-url", "https://x.example.com", "--json"])), [["baseUrl", "FIELD_NOT_SUPPORTED"]]);

  const saved = JSON.parse(fs.readFileSync(h.config, "utf8"));
  assert.deepEqual(Object.keys(saved.connections).sort(), ["local-gw", "team-gw"]);
  assert.equal(saved.connections["team-gw"].baseUrl, "http://10.20.30.40:4000/v1");

  // The project's own base URL follows the same rule (allowInsecureHttp: true confirms it).
  const dir = project(h.env, ["provider: openai-compatible", "baseUrl: http://10.20.30.40:4000/v1"]);
  const state = jgates(h.env, ["run", "--cwd", dir, "--no-interactive", "--json", "--only", "tool:builtin-pii", "--semantic"]);
  assert.ok(state.doc, state.out + state.err);
  assert.equal(state.doc.semantic.state, "not-configured");
  assert.match(state.doc.semantic.reason, /baseUrl is refused \(INSECURE_HTTP\)/);
});

test("removing a connection and resetting a provider; the other keys of config.json are kept on every write", () => {
  const h = homes();
  fs.mkdirSync(h.store, { recursive: true });
  fs.writeFileSync(h.config, JSON.stringify({ provider: "openrouter", threshold: 80 }));
  assert.equal(jgates(h.env, ["providers", "add", "gw", "--base-url", "https://gw.example.com/v1"]).code, 0);
  assert.equal(jgates(h.env, ["providers", "set", "claude", "--model", "claude-model-1"]).code, 0);
  let saved = JSON.parse(fs.readFileSync(h.config, "utf8"));
  assert.deepEqual([saved.provider, saved.threshold, saved.providers.anthropic], ["openrouter", 80, { model: "claude-model-1" }]);
  const removed = jgates(h.env, ["providers", "remove", "gw", "--json"]);
  assert.deepEqual([removed.doc.kind, removed.doc.removed], ["connection", true]);
  assert.equal(jgates(h.env, ["providers", "remove", "gw", "--json"]).doc.code, "NOT_FOUND");
  assert.equal(jgates(h.env, ["providers", "remove", "anthropic", "--json"]).doc.removed, true);
  saved = JSON.parse(fs.readFileSync(h.config, "utf8"));
  assert.deepEqual(saved, { provider: "openrouter", threshold: 80, connections: {}, providers: {} });
  // An entry broken by a hand edit is left out of the listing and named with its field.
  fs.writeFileSync(h.config, JSON.stringify({ connections: { bad: { baseUrl: "http://10.1.1.1/v1" }, ok: { type: "openai-compatible", baseUrl: "https://ok.example.com/v1", headers: { "x-api-key": "k" } } } }));
  const listing = jgates(h.env, ["providers", "list", "--json"]);
  assert.equal(listing.code, 0, listing.out + listing.err);
  assert.equal(listing.doc.providers.some((p) => p.kind === "connection"), false);
  assert.deepEqual(listing.doc.problems.map((p) => [p.field, p.code]), [["connections.bad.baseUrl", "INSECURE_HTTP"], ["connections.ok.headers.x-api-key", "CREDENTIAL_HEADER"]]);
});

// ---- jgates ci ----------------------------------------------------------------------------------------------------------------

test("jgates ci ignores the user's preferences: the process blocks them before anything runs", () => {
  const h = homes();
  assert.equal(jgates(h.env, ["providers", "add", "litellm-local", "--base-url", "http://127.0.0.1:4000/v1"]).code, 0);
  assert.equal(jgates(h.env, ["providers", "set", "openrouter", "--model", "user-model"]).code, 0);
  const workspace = tmp("jgates-providers-ci-");
  const script = path.join(tmp("jgates-providers-ci-script-"), "probe.mjs");
  const url = (p) => JSON.stringify(pathToFileURL(path.join(DIST, p)).href);
  fs.writeFileSync(
    script,
    `import fs from "node:fs";
import path from "node:path";
const providers = await import(${url("core/providers/index.js")});
const { command } = await import(${url("cli/commands/ci.js")});
const adapter = await import(${url("adapters/semantic-gate/index.js")});
const ws = ${JSON.stringify(workspace)};
const yml = (provider) => fs.writeFileSync(path.join(ws, "jgates.yml"), "schemaVersion: 1\\nextensions:\\n  semantic-gate:\\n    provider: " + provider + "\\n");
yml("litellm-local");
const before = adapter.readSemanticState(ws).effective.kind;
const sink = { stdout: () => {}, stderr: () => {} };
const code = await command.run({ args: [], options: { cwd: ws }, lists: {}, json: true, version: "0", commands: [], t: (k) => k, ...sink });
const after = adapter.readSemanticState(ws);
yml("openrouter");
const openrouter = adapter.readSemanticState(ws).effective;
let setError = null;
try { providers.setProvider("openrouter", { model: "x" }); } catch (e) { setError = e.code; }
let called = false;
yml("litellm-local");
const outcome = await adapter.runSemanticReview(ws, { env: process.env }, { callProvider: async () => { called = true; return { text: "{}", raw: null }; } });
process.stdout.write(JSON.stringify({
  before, code, blocked: providers.userPreferencesBlocked(),
  afterState: after.state, afterKind: after.effective.kind, afterPreferences: after.effective.preferences, afterProblem: after.problems.some((p) => /jgates ci uses only the project/.test(p)),
  openrouterModel: openrouter.model, openrouterBase: openrouter.baseUrl.origin, listed: providers.readPreferences().connections,
  setError, called, outcomeState: outcome.state,
}));
`,
  );
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: h.env, timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    before: "connection",
    code: 3,
    blocked: true,
    afterState: "invalid",
    afterKind: "unknown",
    afterPreferences: "ignored",
    afterProblem: true,
    openrouterModel: { value: null, origin: "unset" },
    openrouterBase: "default",
    listed: {},
    setError: "PREFERENCES_BLOCKED",
    called: false,
    outcomeState: "not-configured",
  });
});

// ---- jgates providers test --------------------------------------------------------------------------------------------------------

test("providers test lists the models of a connection or of a provider with its preferences, with the key, and spends no token", async () => {
  const h = homes();
  const gateway = await fakeGateway();
  try {
    const value = "gateway-test-key-W5n1Rk8Hc3";
    assert.equal(jgates(h.env, ["providers", "add", "litellm-local", "--base-url", gateway.url, "--key-env", "LITELLM_API_KEY", "--model", "gateway-model-b", "--header", "X-Team=qa"]).code, 0);
    assert.equal(jgates(h.env, ["secrets", "set", "LITELLM_API_KEY"], { input: `${value}\n` }).code, 0);
    const ok = await runAsync(MAIN, h.env, ["providers", "test", "litellm-local", "--json"]);
    assert.equal(ok.code, 0, ok.out + ok.err);
    assert.deepEqual([ok.doc.models, ok.doc.sample, ok.doc.defaultModelListed], [2, ["gateway-model-a", "gateway-model-b"], true]);
    assert.deepEqual(gateway.seen, [{ method: "GET", url: "/v1/models", auth: `Bearer ${value}`, team: "qa", model: null }]);

    // A known provider pointed at the gateway by the preferences (the base URL of a proxy).
    assert.equal(jgates(h.env, ["providers", "set", "openai", "--base-url", gateway.url, "--key-env", "LITELLM_API_KEY"]).code, 0);
    const known = await runAsync(MAIN, h.env, ["providers", "test", "openai"]);
    assert.equal(known.code, 0, known.out + known.err);
    assert.match(known.out, /2 model/);
    assert.equal(gateway.seen.length, 2);
    assert.ok(gateway.seen.every((s) => s.method === "GET" && s.url === "/v1/models"), "only the model listing is called: no prompt, no token");
    for (const out of [ok.out, ok.err, known.out, known.err]) assert.ok(!out.includes(value));

    const unknown = await runAsync(MAIN, h.env, ["providers", "test", "nope", "--json"]);
    assert.equal(unknown.doc.code, "UNKNOWN_PROVIDER");
    const noBase = await runAsync(MAIN, h.env, ["providers", "test", "openai-compatible", "--json"]);
    assert.equal(noBase.doc.code, "NEEDS_BASE_URL");
  } finally {
    await gateway.close();
  }
});

// ---- the two implementations --------------------------------------------------------------------------------------------------

test("both packages share the preferences: semantic-gate uses what jgates wrote, jgates lists what semantic-gate wrote, with the same rules", async () => {
  const h = homes();
  const gateway = await fakeGateway();
  try {
    const value = "shared-key-B2v7Ls4Qd9";
    assert.equal(jgates(h.env, ["providers", "add", "litellm-local", "--base-url", gateway.url, "--key-env", "LITELLM_API_KEY", "--header", "X-Team=shared"]).code, 0);
    assert.equal(jgates(h.env, ["secrets", "set", "LITELLM_API_KEY"], { input: `${value}\n` }).code, 0);
    const listed = await runAsync(SG_CLI, h.env, ["models", "list", "litellm-local", "--json"]);
    assert.equal(listed.code, 0, listed.out + listed.err);
    assert.deepEqual(listed.doc.map((m) => m.id), ["gateway-model-a", "gateway-model-b"]);
    assert.deepEqual(gateway.seen, [{ method: "GET", url: "/v1/models", auth: `Bearer ${value}`, team: "shared", model: null }]);
  } finally {
    await gateway.close();
  }
  const sgSet = spawnSync(process.execPath, [SG_CLI, "config", "set", "connections", JSON.stringify({ "from-sg": { type: "openai-compatible", baseUrl: "https://sg.example.com/v1", model: "m1" } })], { encoding: "utf8", env: h.env });
  assert.equal(sgSet.status, 0, sgSet.stderr);
  const list = jgates(h.env, ["providers", "list", "--json"]);
  const fromSg = list.doc.providers.find((p) => p.name === "from-sg");
  assert.deepEqual([fromSg.kind, fromSg.baseUrl, fromSg.model, fromSg.apiKeyEnv], ["connection", { value: "https://sg.example.com/v1", origin: "user" }, { value: "m1", origin: "user" }, { value: "FROM_SG_API_KEY", origin: "default" }]);

  // The same table of providers and the same verdicts on the same inputs.
  const jg = await mod("core/providers/index.js");
  const sg = await import(pathToFileURL(path.join(SG_DIST, "config.js")).href);
  assert.deepEqual(JSON.parse(JSON.stringify(jg.PROVIDERS)), JSON.parse(JSON.stringify(sg.PROVIDER_DEFAULTS)));
  assert.deepEqual(jg.RESERVED_NAMES, sg.RESERVED_PROVIDER_NAMES);
  const urls = ["http://localhost:4000/v1", "http://127.0.0.9/v1", "http://[::1]:8080", "http://gw.localhost/v1", "http://10.0.0.1/v1", "https://gw.example.com/v1", "ftp://x", "not a url", "https://u:p@x.example.com", "https://x.example.com/v1?key=1", ""];
  for (const url of urls) for (const allow of [false, true]) assert.equal(jg.baseUrlProblem(url, allow) ?? null, sg.baseUrlProblem(url, allow) ?? null, `${url} ${allow}`);
  const headers = [["X-Team", "core"], ["Authorization", "x"], ["x-api-key", "x"], ["X-Auth-Token", "x"], ["OpenAI-Organization", "org"], ["HTTP-Referer", "https://x"], ["X-Title", "jgates"], ["Content-Type", "x"], ["Bad Name", "x"], ["X-Forward", "Bearer abc"], ["X-Long", "x".repeat(2000)], ["Cookie", "a=b"]];
  for (const [name, val] of headers) assert.equal(jg.headerProblem(name, val) ?? null, sg.headerProblem(name, val) ?? null, name);
  assert.equal(jg.headerProblem("X-Team", "core"), undefined);
  assert.equal(jg.headerProblem("OpenAI-Organization", "org"), undefined);
});
