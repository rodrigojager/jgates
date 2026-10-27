import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listStoredApiKeys,
  readStoredSecret,
  resolveApiKey,
  resolveApiKeySource,
  setStoredSecret,
  unsetStoredSecret,
} from "../dist/credentials.js";
import { callProvider } from "../dist/providers.js";
import { defaultConfig } from "../dist/config.js";

// The user key store (D9): one file outside every project, by variable name, 0700/0600, never shown back.
// Every test uses a temporary SEMANTIC_GATE_HOME: the real user's store is never read nor written.

const CLI = path.resolve("dist/cli.js");
const POSIX = process.platform !== "win32";

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-store-"));
  const saved = { home: process.env.SEMANTIC_GATE_HOME };
  process.env.SEMANTIC_GATE_HOME = home;
  const restore = () => {
    if (saved.home === undefined) delete process.env.SEMANTIC_GATE_HOME;
    else process.env.SEMANTIC_GATE_HOME = saved.home;
    fs.rmSync(home, { recursive: true, force: true });
  };
  try {
    const out = fn(home);
    if (out && typeof out.then === "function") return out.finally(restore);
    restore();
    return out;
  } catch (error) {
    restore();
    throw error;
  }
}

function withoutEnv(names, fn) {
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  const restore = () => {
    for (const [n, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === "function") return out.finally(restore);
    restore();
    return out;
  } catch (error) {
    restore();
    throw error;
  }
}

const cli = (home, args, input = "", extraEnv = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, SEMANTIC_GATE_HOME: home, ...extraEnv },
  });

test("set writes the store by name, 0600 in a 0700 folder, with the date of the write", () =>
  withHome((home) => {
    const file = setStoredSecret("MY_GATEWAY_KEY", "  gw-value-123  ", new Date("2026-10-27T10:00:00.000Z"));
    assert.equal(file, path.join(home, "secrets.json"));
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(doc, { schemaVersion: 2, secrets: { MY_GATEWAY_KEY: { value: "gw-value-123", updatedAt: "2026-10-27T10:00:00.000Z" } } });
    if (POSIX) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    }
    assert.deepEqual(fs.readdirSync(home), ["secrets.json"], "no temporary file is left behind");
    assert.equal(readStoredSecret("MY_GATEWAY_KEY"), "gw-value-123");
    const listed = listStoredApiKeys({}).find((e) => e.name === "MY_GATEWAY_KEY");
    assert.deepEqual(listed, { name: "MY_GATEWAY_KEY", configured: true, state: "set", source: "stored", envName: "MY_GATEWAY_KEY", stored: true, updatedAt: "2026-10-27T10:00:00.000Z", masked: "********" });
    assert.deepEqual(unsetStoredSecret("MY_GATEWAY_KEY").removed, true);
    assert.equal(readStoredSecret("MY_GATEWAY_KEY"), undefined);
    assert.equal(unsetStoredSecret("MY_GATEWAY_KEY").removed, false);
  }));

test("invalid names and unsafe values are refused", () =>
  withHome(() => {
    for (const name of ["my_key", "1KEY", "A-B", "A B", ""]) assert.throws(() => setStoredSecret(name, "x"), /Invalid key name/, name);
    assert.throws(() => setStoredSecret("GOOD_NAME", "   "), /empty/);
    assert.throws(() => setStoredSecret("GOOD_NAME", "one\ntwo"), /control character/);
  }));

test("an entry of the first format (by provider) is read and rewritten in the new format on the next write", () =>
  withHome((home) =>
    withoutEnv(["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_API_KEY"], () => {
      const file = path.join(home, "secrets.json");
      fs.writeFileSync(file, JSON.stringify({ openrouter: "legacy-or", anthropic: "legacy-an", "my-gateway": "legacy-gw" }), { mode: 0o600 });
      assert.equal(resolveApiKey({ provider: "openrouter" }), "legacy-or");
      assert.equal(resolveApiKey({ provider: "claude" }), "legacy-an");
      assert.equal(resolveApiKey({ provider: "openai-compatible", keyProvider: "my-gateway" }), "legacy-gw");
      const listed = listStoredApiKeys({});
      assert.equal(listed.find((e) => e.name === "OPENROUTER_API_KEY").source, "stored");
      assert.equal(listed.find((e) => e.name === "MY_GATEWAY_API_KEY").state, "set");
      // Reading never rewrites; the next write does.
      assert.ok("openrouter" in JSON.parse(fs.readFileSync(file, "utf8")));
      setStoredSecret("NEW_KEY", "fresh");
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepEqual(Object.keys(doc).sort(), ["schemaVersion", "secrets"]);
      assert.deepEqual(Object.keys(doc.secrets), ["ANTHROPIC_API_KEY", "MY_GATEWAY_API_KEY", "NEW_KEY", "OPENROUTER_API_KEY"]);
      assert.equal(doc.secrets.OPENROUTER_API_KEY.value, "legacy-or");
      assert.equal(typeof doc.secrets.OPENROUTER_API_KEY.updatedAt, "string");
      assert.equal(resolveApiKey({ provider: "openrouter" }), "legacy-or");
    }),
  ));

test("the environment wins over the store and the listing says so; store: false reads only the environment", () =>
  withHome(() =>
    withoutEnv(["OPENAI_API_KEY"], () => {
      setStoredSecret("OPENAI_API_KEY", "from-store");
      assert.deepEqual(resolveApiKeySource({ provider: "openai" }), { value: "from-store", source: "stored", name: "OPENAI_API_KEY" });
      assert.equal(resolveApiKey({ provider: "openai", store: false }), undefined);
      const env = { OPENAI_API_KEY: "from-env" };
      assert.deepEqual(resolveApiKeySource({ provider: "openai", env }), { value: "from-env", source: "env", name: "OPENAI_API_KEY" });
      const entry = listStoredApiKeys(env).find((e) => e.name === "OPENAI_API_KEY");
      assert.equal(entry.source, "env");
      assert.equal(entry.stored, true);
      assert.equal(entry.provider, "openai");
    }),
  ));

test("semantic-gate auth list never shows a character of the key", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-store-cli-"));
  try {
    // A key made of characters nothing else in the output has, and a realistic one.
    const odd = "ǁǂǃѦѨѪѬѮѰ";
    const real = "sk-or-v1-q7Wz3Kp9Xb";
    assert.equal(cli(home, ["auth", "set", "ODD_KEY", "--key-stdin"], `${odd}\n`).status, 0);
    const set = cli(home, ["auth", "set", "openrouter", "--key-stdin"], `${real}\n`);
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stdout, /OPENROUTER_API_KEY/);
    const list = cli(home, ["auth", "list"], "", { OPENROUTER_API_KEY: "" });
    assert.equal(list.status, 0, list.stderr);
    for (const ch of odd) assert.ok(!list.stdout.includes(ch), `the listing shows ${ch}`);
    for (let i = 0; i + 4 <= real.length; i++) assert.ok(!list.stdout.includes(real.slice(i, i + 4)), `the listing shows ${real.slice(i, i + 4)}`);
    const doc = JSON.parse(list.stdout);
    assert.equal(doc.find((e) => e.name === "ODD_KEY").masked, "********");
    assert.equal(doc.find((e) => e.name === "OPENROUTER_API_KEY").source, "stored");
    // The key is never an argument; an invalid name is refused.
    const arg = cli(home, ["auth", "set", "ODD_KEY", "the-value", "--key-stdin"], "x\n");
    assert.equal(arg.status, 3);
    assert.match(arg.stderr, /never taken as an argument/);
    assert.ok(!arg.stderr.includes("the-value"));
    assert.equal(cli(home, ["auth", "set", "bad name", "--key-stdin"], "x\n").status, 3);
    const unset = cli(home, ["auth", "unset", "ODD_KEY"]);
    assert.equal(unset.status, 0, unset.stderr);
    assert.ok(!JSON.parse(cli(home, ["auth", "list"]).stdout).some((e) => e.name === "ODD_KEY"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an HTTP provider gets the stored key of its apiKeyEnv; with secretStore false it does not", async () =>
  withHome(async () => {
    setStoredSecret("MY_GATEWAY_KEY", "gateway-secret-1");
    const seen = [];
    const server = http.createServer((request, response) => {
      seen.push(request.headers.authorization ?? null);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const config = { ...defaultConfig, provider: "openai-compatible", baseUrl, apiKeyEnv: "MY_GATEWAY_KEY", model: "m" };
      await withoutEnv(["MY_GATEWAY_KEY", "SEMANTIC_GATE_API_KEY"], async () => {
        await callProvider({ prompt: "p", system: "s", config });
        assert.deepEqual(seen, ["Bearer gateway-secret-1"]);
        await assert.rejects(callProvider({ prompt: "p", system: "s", config: { ...config, secretStore: false } }), /Missing API key/);
        assert.equal(seen.length, 1, "nothing is sent without a key");
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }));

test("a command provider gets only the stored name it declares in apiKeyEnv", async () =>
  withHome(async (home) => {
    setStoredSecret("FAKE_PROVIDER_KEY", "declared-value");
    setStoredSecret("OTHER_SECRET", "undeclared-value");
    const script = path.join(home, "fake.mjs");
    fs.writeFileSync(
      script,
      `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ declared: process.env.FAKE_PROVIDER_KEY ?? null, other: process.env.OTHER_SECRET ?? null })));`,
    );
    const config = { ...defaultConfig, provider: "command", command: process.execPath, commandArgs: [script], commandPromptMode: "stdin", commandOutput: "text", timeoutMs: 20000 };
    await withoutEnv(["FAKE_PROVIDER_KEY", "OTHER_SECRET"], async () => {
      const declared = JSON.parse((await callProvider({ prompt: "p", system: "s", config: { ...config, apiKeyEnv: "FAKE_PROVIDER_KEY" }, cwd: home })).text);
      assert.deepEqual(declared, { declared: "declared-value", other: null });
      const none = JSON.parse((await callProvider({ prompt: "p", system: "s", config, cwd: home })).text);
      assert.deepEqual(none, { declared: null, other: null });
      const ci = JSON.parse((await callProvider({ prompt: "p", system: "s", config: { ...config, apiKeyEnv: "FAKE_PROVIDER_KEY", secretStore: false }, cwd: home })).text);
      assert.deepEqual(ci, { declared: null, other: null });
    });
  }));

test("status reports where the key comes from without the value", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-store-status-"));
  try {
    assert.equal(cli(home, ["auth", "set", "OPENROUTER_API_KEY", "--key-stdin"], "status-secret-xyz\n").status, 0);
    const status = cli(home, ["status", "--provider", "openrouter", "--json"], "", { OPENROUTER_API_KEY: "" });
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).credential, { required: true, configured: true, source: "stored", envName: "OPENROUTER_API_KEY" });
    assert.ok(!status.stdout.includes("status-secret"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});


test("auth set and unset refuse a key-like name without storing or echoing it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sg-keylike-"));
  try {
    const fake = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV0123456789";
    for (const args of [["auth", "set", fake, "--key-stdin"], ["auth", "unset", fake]]) {
      const r = cli(home, args, "x\n");
      assert.notEqual(r.status, 0, args.join(" "));
      assert.ok(!r.stdout.includes(fake) && !r.stderr.includes(fake) && !r.stderr.includes("ABCDEFGH"), args.join(" "));
    }
    const list = JSON.parse(cli(home, ["auth", "list"]).stdout);
    assert.ok(!list.some((e) => e.stored));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
