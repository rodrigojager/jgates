import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The routes of Preferências > Providers e chaves (D9, D10): GET /api/secrets never carries a value, PUT and DELETE
// write the user's key store, POST .../test lists the models of a fake provider with the key, and the provider
// preferences have a revision. Every answer is searched for the value written; the server log and the project too.
// Writes are refused without a session, from another origin, without the CSRF token, in the governed mode and while
// a CI policy is edited. Every test points SEMANTIC_GATE_HOME (the key store and config.json) and JGATES_HOME at
// temporary folders, and the providers are fake local servers: no real user file is read, no token is spent.

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");

const dirs = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const made = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

// Obviously fake values: long enough to be found anywhere they leak.
const VALUE = "sk-fake-k03-value-0123456789abcdefghijklmnop";
const ENV_VALUE = "sk-fake-k03-env-value-zyxwvutsrqponmlkjihgf";

/** Temporary homes and an environment without any key name or provider variable of the machine. */
function homes(extra = {}) {
  const store = path.join(made("jg-sec-store-"), "semantic-gate");
  const home = made("jg-sec-home-");
  const env = { ...process.env, SEMANTIC_GATE_HOME: store, JGATES_HOME: home, NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  for (const name of Object.keys(env)) if (/_API_KEY$|^SEMANTIC_GATE_(?!HOME$)|^CLAUDE_API_KEY$|^GOOGLE_API_KEY$/.test(name)) delete env[name];
  return { store, home, env: { ...env, ...extra }, vault: path.join(store, "secrets.json"), config: path.join(store, "config.json") };
}

function project(env) {
  const dir = made("jg-sec-proj-");
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"], { encoding: "utf8", env, timeout: 120_000 });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  return dir;
}

function startUi(args, env) {
  const proc = spawn(process.execPath, [MAIN, "ui", ...args, "--no-open", "--port", "0", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const ui = { proc, info: null, out: "", err: "" };
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d) => (ui.err += d));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`jgates ui did not start:\n${ui.out}\n${ui.err}`)), 30_000);
    proc.stdout.on("data", (d) => {
      ui.out += d;
      if (ui.info) return;
      try {
        ui.info = JSON.parse(ui.out);
        clearTimeout(timer);
        resolve(ui);
      } catch {
        // Not complete yet.
      }
    });
    proc.on("exit", (code) => {
      if (ui.info) return;
      clearTimeout(timer);
      reject(new Error(`jgates ui exited with ${code}:\n${ui.out}\n${ui.err}`));
    });
  });
}

async function stopUi(ui) {
  if (!ui || ui.proc.exitCode !== null || ui.proc.signalCode !== null) return;
  const exited = once(ui.proc, "exit");
  ui.proc.kill("SIGTERM");
  await exited;
}

function request(port, method, p, { headers = {}, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? Buffer.from(raw) : body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: "127.0.0.1", port, method, path: p, agent: false, headers: { Host: `127.0.0.1:${port}`, ...(data ? { "Content-Type": "application/json", "Content-Length": String(data.length) } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Opens a session through the launcher; `call` sends Cookie, Origin and the CSRF token, and records every answer. */
async function session(ui) {
  const html = fs.readFileSync(ui.info.launcher, "utf8");
  const href = /href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
  assert.ok(href, "launcher has no bootstrap link");
  const url = new URL(href);
  const port = ui.info.port;
  const boot = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: url.pathname + url.search, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res));
    }).on("error", reject);
  });
  const cookie = String(boot.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  const s = await request(port, "GET", "/api/session", { headers: { Cookie: cookie } });
  assert.equal(s.status, 200, s.text);
  const origin = `http://127.0.0.1:${port}`;
  const answers = [];
  const call = async (method, p, body, options = {}) => {
    const r = await request(port, method, p, { headers: method === "GET" ? { Cookie: cookie } : { Cookie: cookie, Origin: origin, "X-JGates-CSRF": s.json.csrfToken }, body, ...options });
    answers.push(`${method} ${p} ${r.status}\n${r.text}`);
    return r;
  };
  return { call, answers, port, cookie, origin, csrf: s.json.csrfToken };
}

async function withUi(args, env, fn) {
  let ui = null;
  try {
    ui = await startUi(args, env);
    await fn({ ui, ...(await session(ui)) });
  } finally {
    await stopUi(ui);
  }
}

/** A fake OpenAI-compatible provider: GET /v1/models with the expected key lists two models; anything else is refused. */
async function fakeProvider(key) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null });
    if (req.method === "GET" && req.url === "/v1/models" && req.headers.authorization === `Bearer ${key}`) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model-a" }, { id: "fake-model-b" }] }));
      return;
    }
    // A careless provider repeats the key it received in the error: the route must never pass it on.
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `invalid key ${String(req.headers.authorization ?? "").replace(/^Bearer /, "")}` } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

test("no answer of the key routes carries the value written, the log never has it and Testar lists the fake provider's models", async () => {
  const h = homes({ OPENROUTER_API_KEY: ENV_VALUE });
  const proj = project(h.env);
  const fake = await fakeProvider(VALUE);
  try {
    await withUi(["--cwd", proj], h.env, async ({ ui, call, answers }) => {
      const first = await call("GET", "/api/secrets");
      assert.equal(first.status, 200, first.text);
      assert.equal(first.json.writable, true);
      assert.equal(first.json.locked, null);
      const openaiBefore = first.json.secrets.find((s) => s.name === "OPENAI_API_KEY");
      assert.deepEqual([openaiBefore.state, openaiBefore.source, openaiBefore.inVault], ["unset", "none", false]);
      assert.equal(openaiBefore.testable, true);
      assert.ok(openaiBefore.usedBy.includes("openai"));

      // The environment wins over the store, and the listing says so without the value.
      const router = first.json.secrets.find((s) => s.name === "OPENROUTER_API_KEY");
      assert.deepEqual([router.state, router.source, router.envName], ["set", "env", "OPENROUTER_API_KEY"]);
      const shadowed = await call("PUT", "/api/secrets/OPENROUTER_API_KEY", { value: VALUE });
      assert.equal(shadowed.status, 200, shadowed.text);
      assert.equal(shadowed.json.environmentWins, true);
      assert.equal(shadowed.json.secret.inVault, true);

      // Write, then read back: set, from the store, with the date; never the value.
      const saved = await call("PUT", "/api/secrets/OPENAI_API_KEY", { value: VALUE });
      assert.equal(saved.status, 200, saved.text);
      assert.deepEqual([saved.json.secret.state, saved.json.secret.source, saved.json.secret.inVault, saved.json.environmentWins], ["set", "vault", true, false]);
      assert.ok(!Number.isNaN(Date.parse(saved.json.secret.updatedAt)), "the date of the write is reported");
      const listed = await call("GET", "/api/secrets");
      const openai = listed.json.secrets.find((s) => s.name === "OPENAI_API_KEY");
      assert.equal(openai.state, "set");
      assert.equal(openai.updatedAt, saved.json.secret.updatedAt);
      assert.ok(!("value" in openai));

      // A name of the user's own, refused names and values: the answers never repeat the value either.
      assert.equal((await call("PUT", "/api/secrets/MY_TEAM_TOKEN", { value: VALUE })).status, 200);
      assert.ok((await call("GET", "/api/secrets")).json.secrets.some((s) => s.name === "MY_TEAM_TOKEN" && s.state === "set" && s.testable === false));
      assert.equal((await call("PUT", "/api/secrets/lower_case", { value: VALUE })).status, 400);
      const multi = await call("PUT", "/api/secrets/OPENAI_API_KEY", { value: `${VALUE}\n${VALUE}` });
      assert.equal(multi.status, 422, multi.text);
      assert.equal(multi.json.code, "INVALID_VALUE");
      const long = await call("PUT", "/api/secrets/OPENAI_API_KEY", { value: VALUE.repeat(400) });
      assert.equal(long.status, 400, long.text);
      assert.equal((await call("PUT", "/api/secrets/OPENAI_API_KEY", { value: VALUE, extra: VALUE })).status, 400);
      assert.equal((await call("PUT", "/api/secrets/OPENAI_API_KEY", undefined, { raw: `{"value": "${VALUE}"` })).status, 400);
      assert.equal((await call("POST", "/api/secrets/MY_TEAM_TOKEN/test")).json.code, "NOT_TESTABLE");
      assert.equal((await call("POST", "/api/secrets/GEMINI_API_KEY/test")).json.code, "SECRET_NOT_SET");

      // Testar: the provider points at the fake server through the preferences; the key goes only to it.
      const prefs = await call("GET", "/api/providers");
      assert.equal(prefs.status, 200, prefs.text);
      assert.equal(prefs.json.revision, null);
      const pointed = await call("PUT", "/api/providers/openai", { expectedRevision: null, baseUrl: fake.url });
      assert.equal(pointed.status, 200, pointed.text);
      assert.equal(pointed.json.provider.baseUrl.origin, "user");
      const tested = await call("POST", "/api/secrets/OPENAI_API_KEY/test");
      assert.equal(tested.status, 200, tested.text);
      assert.deepEqual(tested.json.models, ["fake-model-a", "fake-model-b"]);
      assert.equal(tested.json.source, "vault");
      const byProvider = await call("POST", "/api/providers/openai/test");
      assert.equal(byProvider.status, 200, byProvider.text);
      assert.deepEqual(byProvider.json.models, ["fake-model-a", "fake-model-b"]);
      assert.ok(fake.seen.every((s) => s.method === "GET" && s.url === "/v1/models"), "only the model listing is called: no prompt, no token");

      // A provider that repeats the key in its error: the failure is reported with the key masked.
      assert.equal((await call("PUT", "/api/secrets/OPENAI_API_KEY", { value: `${VALUE}-wrong` })).status, 200);
      const failed = await call("POST", "/api/providers/openai/test");
      assert.equal(failed.status, 502, failed.text);
      assert.equal(failed.json.code, "PROVIDER_TEST_FAILED");
      assert.ok(fake.seen.some((s) => s.auth === `Bearer ${VALUE}-wrong`), "the fake provider received the key");

      // Remover: the name goes back to unset; removing again says it was not there.
      const removed = await call("DELETE", "/api/secrets/OPENAI_API_KEY");
      assert.equal(removed.status, 200, removed.text);
      assert.equal(removed.json.removed, true);
      assert.equal(removed.json.secret.state, "unset");
      assert.equal((await call("DELETE", "/api/secrets/OPENAI_API_KEY")).json.removed, false);

      // The search: no answer, no line of the server log and no file of the project or of the data folder has the value.
      for (const answer of answers) {
        assert.ok(!answer.includes(VALUE), `an answer carries the value:\n${answer.slice(0, 300)}`);
        assert.ok(!answer.includes(ENV_VALUE), `an answer carries the environment value:\n${answer.slice(0, 300)}`);
      }
      for (const file of [...filesUnder(proj), ...filesUnder(h.home)]) assert.ok(!fs.readFileSync(file, "utf8").includes(VALUE), `${file} has the value`);
      const log = fs.readFileSync(ui.info.log, "utf8");
      assert.ok(log.includes("PUT /api/secrets/OPENAI_API_KEY 200"), "the log has the method, the path and the status");
      // The store has it, owner-only, outside the project.
      assert.ok(fs.readFileSync(h.vault, "utf8").includes(VALUE));
      if (process.platform !== "win32") assert.equal(fs.statSync(h.vault).mode & 0o777, 0o600);
    });
  } finally {
    await fake.close();
  }
});

test("a write of the key routes is refused without a session, from another origin and without the CSRF token", async () => {
  const h = homes();
  const proj = project(h.env);
  await withUi(["--cwd", proj], h.env, async ({ port, cookie, origin, csrf }) => {
    const body = { value: VALUE };
    const tries = [
      ["no session", { Origin: origin }, 401, "SESSION_REQUIRED"],
      ["bogus session", { Cookie: `${cookie.split("=")[0]}=${"A".repeat(43)}`, Origin: origin, "X-JGates-CSRF": csrf }, 401, "SESSION_REQUIRED"],
      ["foreign origin", { Cookie: cookie, Origin: "http://evil.example", "X-JGates-CSRF": csrf }, 403, "ORIGIN_NOT_ALLOWED"],
      ["no origin", { Cookie: cookie, "X-JGates-CSRF": csrf }, 403, "ORIGIN_REQUIRED"],
      ["cross-site fetch", { Cookie: cookie, Origin: origin, "X-JGates-CSRF": csrf, "Sec-Fetch-Site": "cross-site" }, 403, "ORIGIN_NOT_ALLOWED"],
      ["no csrf", { Cookie: cookie, Origin: origin }, 403, "CSRF_INVALID"],
    ];
    const failures = [];
    for (const [label, headers, status, code] of tries) {
      for (const [method, p, b] of [
        ["PUT", "/api/secrets/OPENAI_API_KEY", body],
        ["DELETE", "/api/secrets/OPENAI_API_KEY", undefined],
        ["POST", "/api/secrets/OPENAI_API_KEY/test", undefined],
        ["PUT", "/api/providers/openai", { expectedRevision: null, model: "x" }],
        ["POST", "/api/providers", { expectedRevision: null, name: "gw", baseUrl: "http://127.0.0.1:9/v1" }],
        ["DELETE", "/api/providers/gw", undefined],
      ]) {
        const r = await request(port, method, p, { headers, body: b });
        if (r.status !== status || r.json?.code !== code) failures.push(`${label} ${method} ${p}: ${r.status} ${r.json?.code}`);
        if (r.text.includes(VALUE)) failures.push(`${label} ${method} ${p}: the answer carries the value`);
      }
    }
    assert.deepEqual(failures, []);
    // Reading needs the session too.
    assert.equal((await request(port, "GET", "/api/secrets")).status, 401);
    assert.equal((await request(port, "GET", "/api/providers")).status, 401);
    assert.ok(!fs.existsSync(h.vault), "a refused write created the key store");
    assert.ok(!fs.existsSync(h.config), "a refused write created the preferences");
  });
});

test("in the governed mode and while a CI policy is edited the keys and the provider preferences are read-only", async () => {
  const h = homes();
  const proj = project(h.env);
  const outside = made("jg-sec-policy-");
  const writes = [
    ["PUT", "/api/secrets/OPENAI_API_KEY", { value: VALUE }],
    ["DELETE", "/api/secrets/OPENAI_API_KEY", undefined],
    ["PUT", "/api/providers/openai", { expectedRevision: null, model: "fake-model-a" }],
    ["POST", "/api/providers", { expectedRevision: null, name: "gw", baseUrl: "http://127.0.0.1:9/v1" }],
    ["DELETE", "/api/providers/gw", undefined],
  ];
  const check = async (call, answers, status, code, locked) => {
    const failures = [];
    for (const [method, p, b] of writes) {
      const r = await call(method, p, b);
      if (r.status !== status || r.json?.code !== code || !r.json?.message || !r.json?.fix) failures.push(`${method} ${p}: ${r.status} ${r.json?.code}`);
    }
    assert.deepEqual(failures, []);
    const secrets = await call("GET", "/api/secrets");
    assert.equal(secrets.status, 200);
    assert.deepEqual([secrets.json.writable, secrets.json.locked], [false, locked]);
    const providers = await call("GET", "/api/providers");
    assert.deepEqual([providers.json.writable, providers.json.locked], [false, locked]);
    assert.ok(answers.every((a) => !a.includes(VALUE)));
    assert.ok(!fs.existsSync(h.vault) && !fs.existsSync(h.config), "a refused write created a file of the user");
  };
  await withUi(["--cwd", proj], { ...h.env, JGATES_POLICY_DIR: outside, JGATES_POLICY_SHA256: "a".repeat(64) }, async ({ call, answers }) => {
    await check(call, answers, 403, "GOVERNED_LOCKED", "governed");
    // The card of the semantic gate writes jgates.yml: governed, it is refused like every write of the configuration.
    const card = await call("GET", "/api/semantic");
    assert.equal(card.json.form.editable, false);
    const put = await call("PUT", "/api/config/semantic", { expectedRevision: card.json.form.revision, intents: [{ field: "provider", op: "set", value: "mock" }] });
    assert.equal(put.status, 403);
    assert.equal(put.json.code, "GOVERNED_LOCKED");
  });
  const policy = project(h.env);
  await withUi(["--policy", policy], h.env, async ({ call, answers }) => {
    await check(call, answers, 409, "POLICY_MODE_UNAVAILABLE", "policy");
  });
});

test("connections and preferences carry a revision; the card writes provider: <connection> in jgates.yml by patch, with the revision", async () => {
  const h = homes();
  const proj = project(h.env);
  const rootFile = path.join(proj, "jgates.yml");
  fs.writeFileSync(rootFile, `# team settings: keep this comment\n${fs.readFileSync(rootFile, "utf8")}`);
  await withUi(["--cwd", proj], h.env, async ({ call }) => {
    const before = await call("GET", "/api/providers");
    assert.equal(before.json.revision, null);
    const refused = await call("POST", "/api/providers", { expectedRevision: null, name: "litellm-local", baseUrl: "http://127.0.0.1:4000/v1", headers: { "X-Api-Key": "abc" } });
    assert.equal(refused.status, 422, refused.text);
    assert.deepEqual(refused.json.errors.map((e) => [e.field, e.code]), [["headers.X-Api-Key", "CREDENTIAL_HEADER"]]);
    const collides = await call("POST", "/api/providers", { expectedRevision: null, name: "openai", baseUrl: "http://127.0.0.1:4000/v1" });
    assert.equal(collides.json.errors[0].code, "NAME_COLLIDES");
    const added = await call("POST", "/api/providers", { expectedRevision: null, name: "litellm-local", baseUrl: "http://127.0.0.1:4000/v1", model: "revisao", headers: { "X-Team": "qa" } });
    assert.equal(added.status, 201, added.text);
    assert.equal(added.json.provider.apiKeyEnv.value, "LITELLM_LOCAL_API_KEY");
    assert.match(added.json.revision, /^[0-9a-f]{64}$/);
    // A write from an older reading is a conflict, and nothing changes.
    const stale = await call("PUT", "/api/providers/litellm-local", { expectedRevision: null, model: "outro" });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.json.code, "REVISION_CONFLICT");
    assert.equal(stale.json.currentRevision, added.json.revision);
    const changed = await call("PUT", "/api/providers/litellm-local", { expectedRevision: added.json.revision, model: "outro" });
    assert.equal(changed.status, 200, changed.text);
    assert.equal(changed.json.provider.model.value, "outro");
    const listing = await call("GET", "/api/providers");
    assert.ok(listing.json.providers.some((p) => p.name === "litellm-local" && p.kind === "connection" && p.headers["X-Team"] === "qa"));
    // The key name of the connection is listed among the keys.
    assert.ok((await call("GET", "/api/secrets")).json.secrets.some((s) => s.name === "LITELLM_LOCAL_API_KEY" && s.usedBy.includes("litellm-local")));

    // The card: the connection is offered, and choosing it writes provider: litellm-local by patch.
    const card = await call("GET", "/api/semantic");
    assert.equal(card.status, 200, card.text);
    assert.equal(card.json.state, "off");
    assert.equal(card.json.form.editable, true);
    assert.ok(card.json.form.providers.some((p) => p.name === "litellm-local" && p.kind === "connection"));
    assert.equal(card.json.form.fields.find((f) => f.id === "provider").state, "inherited");
    const saved = await call("PUT", "/api/config/semantic", {
      expectedRevision: card.json.form.revision,
      intents: [
        { field: "provider", op: "set", value: "litellm-local" },
        { field: "scope", op: "set", value: "full" },
        { field: "maxCalls", op: "set", value: 2 },
      ],
    });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.json.save.changes.sort(), ["maxCalls", "provider", "scope"]);
    const text = fs.readFileSync(rootFile, "utf8");
    assert.ok(text.startsWith("# team settings: keep this comment\n"), "the comment stays");
    assert.match(text, /semantic-gate:\n\s+provider: litellm-local\n/);
    assert.equal(saved.json.semantic.state, "configured");
    assert.equal(saved.json.semantic.effective.kind, "connection");
    assert.deepEqual([saved.json.semantic.effective.model.value, saved.json.semantic.effective.model.origin], ["outro", "user"]);

    // Inherit removes the key; the same value again changes nothing.
    const again = await call("PUT", "/api/config/semantic", { expectedRevision: saved.json.semantic.form.revision, intents: [{ field: "provider", op: "set", value: "litellm-local" }, { field: "maxCalls", op: "inherit" }] });
    assert.equal(again.status, 200, again.text);
    assert.deepEqual(again.json.save.changes, ["maxCalls"]);
    assert.ok(!fs.readFileSync(rootFile, "utf8").includes("maxCalls"));

    // A stale revision is REVISION_CONFLICT; a bad value, an unknown field and an unrecognized value are refused.
    const conflict = await call("PUT", "/api/config/semantic", { expectedRevision: card.json.form.revision, intents: [{ field: "model", op: "set", value: "m" }] });
    assert.equal(conflict.status, 409, conflict.text);
    assert.equal(conflict.json.code, "REVISION_CONFLICT");
    const rev = again.json.semantic.form.revision;
    assert.equal((await call("PUT", "/api/config/semantic", { expectedRevision: rev, intents: [{ field: "maxCalls", op: "set", value: 0 }] })).json.code, "FORM_VALUE_INVALID");
    assert.equal((await call("PUT", "/api/config/semantic", { expectedRevision: rev, intents: [{ field: "baseUrl", op: "set", value: "http://gateway.example/v1" }] })).json.code, "FORM_VALUE_INVALID");
    assert.equal((await call("PUT", "/api/config/semantic", { expectedRevision: rev, intents: [{ field: "masking", op: "set", value: {} }] })).json.code, "FORM_FIELD_UNKNOWN");
    fs.writeFileSync(rootFile, fs.readFileSync(rootFile, "utf8").replace("scope: full", "scope: everything"));
    const odd = await call("GET", "/api/semantic");
    assert.equal(odd.json.form.fields.find((f) => f.id === "scope").state, "unrecognized");
    const keep = await call("PUT", "/api/config/semantic", { expectedRevision: odd.json.form.revision, intents: [{ field: "scope", op: "inherit" }] });
    assert.equal(keep.status, 409);
    assert.equal(keep.json.code, "FORM_FIELD_UNRECOGNIZED");
    assert.ok(fs.readFileSync(rootFile, "utf8").includes("scope: everything"), "an unrecognized value is never removed by the form");

    // Removing the connection: by revision, and the listing no longer has it.
    const current = (await call("GET", "/api/providers")).json.revision;
    assert.equal((await call("DELETE", "/api/providers/litellm-local?expectedRevision=none")).status, 409);
    const gone = await call("DELETE", `/api/providers/litellm-local?expectedRevision=${current}`);
    assert.equal(gone.status, 200, gone.text);
    assert.deepEqual([gone.json.removed, gone.json.kind], [true, "connection"]);
    assert.equal((await call("DELETE", "/api/providers/litellm-local")).status, 404);
  });
});
