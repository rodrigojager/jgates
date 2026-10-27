import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig, loadEffectiveConfig, readUserPreferences } from "../dist/config.js";
import { callProvider, listProviderModels } from "../dist/providers.js";
import { setStoredSecret } from "../dist/credentials.js";

// The user's provider preferences (D10) in the global config.json: per provider base URL, model and key name, and named
// openai-compatible connections. Every test uses a temporary SEMANTIC_GATE_HOME and a local fake gateway: no real file
// of the user is read, no token is spent.

const VARS = ["SEMANTIC_GATE_HOME", "SEMANTIC_GATE_MODEL", "SEMANTIC_GATE_BASE_URL", "SEMANTIC_GATE_PROVIDER", "SEMANTIC_GATE_API_KEY_ENV", "GATEWAY_KEY", "LOCAL_GW_API_KEY"];

async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-prefs-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-prefs-project-"));
  const saved = Object.fromEntries(VARS.map((n) => [n, process.env[n]]));
  for (const n of VARS) delete process.env[n];
  process.env.SEMANTIC_GATE_HOME = home;
  try {
    return await fn({ home, project, writeGlobal: (doc) => fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(doc)) });
  } finally {
    for (const [n, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
}

async function fakeGateway() {
  const seen = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, auth: request.headers.authorization ?? null, team: request.headers["x-team"] ?? null });
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/models") response.end(JSON.stringify({ data: [{ id: "gw-model" }] }));
      else response.end(JSON.stringify({ choices: [{ message: { content: "{\"status\":\"APPROVED\"}" } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("the preference of the provider fills what the project, the environment and the flags leave out, field by field", async () => {
  await withHome(async ({ project, writeGlobal }) => {
    writeGlobal({
      provider: "openrouter",
      model: "flat-model",
      providers: { openrouter: { baseUrl: "https://proxy.example.com/v1", model: "user-model", apiKeyEnv: "TEAM_OR_KEY" } },
    });
    let config = loadEffectiveConfig(project, {});
    assert.deepEqual([config.provider, config.baseUrl, config.model, config.apiKeyEnv], ["openrouter", "https://proxy.example.com/v1", "user-model", "TEAM_OR_KEY"]);
    assert.equal("providers" in config, false, "the preferences are not config keys");
    fs.writeFileSync(path.join(project, ".semantic-gate.json"), JSON.stringify({ baseUrl: "https://project.example.com/v1" }));
    process.env.SEMANTIC_GATE_MODEL = "env-model";
    config = loadEffectiveConfig(project, { apiKeyEnv: "FLAG_KEY" });
    assert.deepEqual([config.baseUrl, config.model, config.apiKeyEnv], ["https://project.example.com/v1", "env-model", "FLAG_KEY"]);
    // Another provider does not take the preference of openrouter.
    config = loadEffectiveConfig(project, { provider: "anthropic" });
    assert.equal(config.apiKeyEnv, undefined);
  });
});

test("provider: <connection> sends the call to the connection's URL with its key and its extra headers; the listing does the same", async () => {
  const gateway = await fakeGateway();
  try {
    await withHome(async ({ project, writeGlobal }) => {
      writeGlobal({ connections: { "local-gw": { type: "openai-compatible", baseUrl: gateway.url, model: "gw-model", apiKeyEnv: "GATEWAY_KEY", headers: { "X-Team": "core" } } } });
      setStoredSecret("GATEWAY_KEY", "gw-secret-1");
      const config = loadEffectiveConfig(project, { provider: "local-gw" });
      assert.deepEqual([config.connection, config.baseUrl, config.model, config.apiKeyEnv, config.headers], ["local-gw", gateway.url, "gw-model", "GATEWAY_KEY", { "X-Team": "core" }]);
      const response = await callProvider({ prompt: "p", system: "s", config });
      assert.equal(response.text, "{\"status\":\"APPROVED\"}");
      const models = await listProviderModels(config);
      assert.deepEqual(models.map((m) => m.id), ["gw-model"]);
      assert.deepEqual(gateway.seen, [
        { method: "POST", url: "/v1/chat/completions", auth: "Bearer gw-secret-1", team: "core" },
        { method: "GET", url: "/v1/models", auth: "Bearer gw-secret-1", team: "core" },
      ]);
      // A connection that declares no key name uses <NAME>_API_KEY when it exists, and no key at all otherwise.
      gateway.seen.length = 0;
      writeGlobal({ connections: { "local-gw": { type: "openai-compatible", baseUrl: gateway.url, model: "gw-model" } } });
      await callProvider({ prompt: "p", system: "s", config: loadEffectiveConfig(project, { provider: "local-gw" }) });
      setStoredSecret("LOCAL_GW_API_KEY", "derived-secret-1");
      await callProvider({ prompt: "p", system: "s", config: loadEffectiveConfig(project, { provider: "local-gw" }) });
      assert.deepEqual(gateway.seen.map((s) => s.auth), [null, "Bearer derived-secret-1"]);
    });
  } finally {
    await gateway.close();
  }
});

test("a connection whose URL or headers break the rules never reaches the network", async () => {
  await withHome(async () => {
    const base = { ...defaultConfig, provider: "gw", connection: "gw", model: "m", apiKeyEnv: "GATEWAY_KEY" };
    process.env.GATEWAY_KEY = "k";
    await assert.rejects(callProvider({ prompt: "p", system: "s", config: { ...base, baseUrl: "http://10.0.0.1/v1" } }), /clear text/);
    await assert.rejects(callProvider({ prompt: "p", system: "s", config: { ...base, baseUrl: "https://gw.example.com/v1", headers: { "X-Api-Key": "k" } } }), /header X-Api-Key is refused \(CREDENTIAL_HEADER\)/);
    await assert.rejects(listProviderModels({ ...base, baseUrl: "https://u:p@gw.example.com/v1" }), /URL_CREDENTIALS/);
  });
});

test("reading the preferences leaves out the entries that break a rule and names them", () => {
  const { preferences, problems } = readUserPreferences({
    providers: { openrouter: { model: "ok-model" }, claude: { model: "alias" }, "codex-cli": { baseUrl: "https://x.example.com" }, nope: {} },
    connections: {
      openai: { baseUrl: "https://x.example.com/v1" },
      good: { type: "openai-compatible", baseUrl: "http://localhost:4000/v1", headers: { "X-Team": "a" } },
      insecure: { baseUrl: "http://10.1.1.1/v1" },
      confirmed: { baseUrl: "http://10.1.1.1/v1", allowInsecureHttp: true },
      leaky: { baseUrl: "https://x.example.com/v1", headers: { authorization: "Bearer x" } },
    },
  });
  assert.deepEqual(Object.keys(preferences.providers), ["openrouter"]);
  assert.deepEqual(Object.keys(preferences.connections).sort(), ["confirmed", "good"]);
  assert.deepEqual(problems, [
    "providers.claude: UNKNOWN_PROVIDER",
    "providers.codex-cli.baseUrl: FIELD_NOT_SUPPORTED",
    "providers.nope: UNKNOWN_PROVIDER",
    "connections.openai: INVALID_NAME",
    "connections.insecure.baseUrl: INSECURE_HTTP",
    "connections.leaky.headers.authorization: CREDENTIAL_HEADER",
  ]);
});
