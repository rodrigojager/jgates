import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-68 (fake engine): the YAML editor round trip (PLAN-config-editing.md section 5). Through the YAML routes, run in
// this process: a file and a key path resolve to a line (the key itself, or its closest section when it is not written);
// the check answers file, key path, line and a plain message for an unknown key, an enum, a type, a pattern, a limit and a
// oneOf; a configuration file that does not exist is offered and created from its template; a write with a stale
// revision is refused with a conflict, and a write with problems is refused unless the caller chooses to save anyway.
// The screen flows are in jgates/tests/ui/yaml-editor.spec.ts.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (p) => pathToFileURL(path.join(root, "jgates", "dist", p)).href;
const VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const made = [];
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const TOOLS = ["schemaVersion: 1", "tools:", "  ruff:", "    adapter: ruff", "  zap:", "    adapter: zap", "    target: https://example.test", ""].join("\n");

function project() {
  const home = tmp("jg-v2-68-home-");
  const projectDir = tmp("jg-v2-68-proj-");
  fs.mkdirSync(path.join(projectDir, ".jgates"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "jgates.yml"), "schemaVersion: 1\n");
  fs.writeFileSync(path.join(projectDir, ".jgates", "tools.yml"), TOOLS);
  return { home, projectDir, server: { projectDir, policyMode: false, workspace: { id: "ws_v268yamlround00000", path: projectDir, name: "v2-68" }, home, version: VERSION, plans: new Map(), log: () => undefined } };
}

let routes;
async function call(server, method, p, { query = {}, body } = {}) {
  routes ??= (await import(dist("server/routes/yaml.js"))).routes;
  const route = routes.find((r) => r.method === method && r.path === p);
  assert.ok(route, `${method} ${p}`);
  try {
    return await route.handler({ params: {}, query, body, session: null, server, raw: null });
  } catch (error) {
    return { status: error.status, json: { code: error.code, message: error.message, details: error.details } };
  }
}

test("V2-68 a file and a key path resolve to the line of the key, or of its closest section when it is not written", async () => {
  const { server } = project();
  const file = ".jgates/tools.yml";
  const at = async (keyPath) => (await call(server, "GET", "/api/config/yaml/file", { query: { file, path: keyPath } })).json.at;
  assert.deepEqual(await at("tools.zap.target"), { path: "tools.zap.target", line: 7, column: 5, resolved: true });
  assert.equal((await at("tools.ruff")).line, 3);
  const near = await at("tools.zap.mode");
  assert.equal(near.line, 5, "a key that is not written lands on its section");
  assert.equal(near.resolved, false);
  const plain = await call(server, "GET", "/api/config/yaml/file", { query: { file } });
  assert.equal(plain.json.at, undefined, "no key asked, no position");

  fs.writeFileSync(path.join(server.projectDir, ".jgates", "architecture.yml"), ["schemaVersion: 1", "architecture:", "  layers:", "    - id: domain", "    - id: infra", "      paths: [\"x/**\"]", ""].join("\n"));
  const layer = (await call(server, "GET", "/api/config/yaml/file", { query: { file: ".jgates/architecture.yml", path: "architecture.layers[1].paths" } })).json.at;
  assert.equal(layer.line, 6);
  assert.equal(layer.resolved, true);
});

test("V2-68 the check answers file, key path, line and a plain message for each kind of problem", async () => {
  const { server } = project();
  const cases = [
    { name: "unknown key", file: "jgates.yml", text: "schemaVersion: 1\nnetwork_typo: true\n", code: "UNKNOWN_KEY", path: "network_typo", line: 2 },
    { name: "enum", file: "jgates.yml", text: "schemaVersion: 1\nexecution:\n  network: sometimes\n", code: "ENUM", path: "execution.network", line: 3, says: /explicit/ },
    { name: "type", file: "jgates.yml", text: "schemaVersion: 1\nexecution:\n  concurrency: many\n", code: "TYPE", path: "execution.concurrency", line: 3, says: /integer/ },
    { name: "limit", file: "jgates.yml", text: "schemaVersion: 1\nexecution:\n  concurrency: 0\n", code: "LIMIT", path: "execution.concurrency", line: 3, says: /at least 1|no mínimo 1/ },
    { name: "pattern", file: ".jgates/dependencies.yml", text: "schemaVersion: 1\nregistries:\n  node:\n    url: http://registry.example.test/npm\n", code: "PATTERN", path: "registries.node.url", line: 4, says: /\^https:\/\// },
    { name: "oneOf", file: ".jgates/tools.yml", text: "schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    config: 42\n", code: "ONE_OF", path: "tools.ruff.config", line: 5 },
  ];
  for (const c of cases) {
    const r = (await call(server, "POST", "/api/config/yaml/check", { body: { file: c.file, text: c.text } })).json;
    assert.equal(r.valid, false, c.name);
    const mine = r.diagnostics.filter((d) => d.inThisFile && d.code === c.code && d.path === c.path);
    assert.equal(mine.length, 1, `${c.name}: one diagnostic ${c.code} at ${c.path}, got ${JSON.stringify(r.diagnostics)}`);
    const d = mine[0];
    assert.equal(d.file, c.file, c.name);
    assert.equal(d.line, c.line, `${c.name}: line`);
    assert.ok(d.message.length > 8 && !/^(must|should|data)\b/.test(d.message) && !/\bmust match\b/.test(d.message), `${c.name}: plain message, got "${d.message}"`);
    if (c.says) assert.match(d.message, c.says, c.name);
    if (c.code === "ONE_OF") assert.equal(r.diagnostics.filter((x) => x.inThisFile && x.path.startsWith("tools.ruff.config")).length, 1, "the branches of a oneOf are not repeated");
  }
  const ok = (await call(server, "POST", "/api/config/yaml/check", { body: { file: "jgates.yml", text: "schemaVersion: 1\nexecution:\n  concurrency: 2\n" } })).json;
  assert.equal(ok.valid, true);
});

test("V2-68 a configuration file that does not exist is offered and created from its template", async () => {
  const { server, projectDir } = project();
  const file = ".jgates/policy.yml";
  const before = (await call(server, "GET", "/api/config/yaml")).json;
  assert.ok(before.missing.includes(file), "the list offers the missing file");
  assert.ok(!before.files.some((f) => f.file === file));
  const made = await call(server, "POST", "/api/config/yaml/create", { body: { file } });
  assert.equal(made.status, 201);
  assert.equal(made.json.exists, true);
  assert.match(fs.readFileSync(path.join(projectDir, file), "utf8"), /schemaVersion: 1/);
  const after = (await call(server, "GET", "/api/config/yaml")).json;
  assert.ok(!after.missing.includes(file));
  assert.ok(after.files.some((f) => f.file === file));
  const again = await call(server, "POST", "/api/config/yaml/create", { body: { file } });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, "FILE_EXISTS");
});

test("V2-68 a write with a stale revision is refused with a conflict, and a write with problems needs the choice to save anyway", async () => {
  const { server, projectDir } = project();
  const file = ".jgates/tools.yml";
  const abs = path.join(projectDir, file);
  const read = (await call(server, "GET", "/api/config/yaml/file", { query: { file } })).json;

  // Another writer changes the file after it was read.
  fs.appendFileSync(abs, "# changed elsewhere\n");
  const stale = await call(server, "PUT", "/api/config/yaml/file", { body: { file, text: `${TOOLS}# mine\n`, expectedRevision: read.revision } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "REVISION_CONFLICT");
  assert.ok(!fs.readFileSync(abs, "utf8").includes("# mine"));

  const fresh = (await call(server, "GET", "/api/config/yaml/file", { query: { file } })).json;
  const broken = `${TOOLS}network_typo: true\n`;
  const refused = await call(server, "PUT", "/api/config/yaml/file", { body: { file, text: broken, expectedRevision: fresh.revision } });
  assert.equal(refused.status, 422);
  assert.equal(refused.json.code, "CONFIG_INVALID");
  assert.ok(refused.json.details.diagnostics.some((d) => d.file === file && d.line > 0));
  assert.ok(!fs.readFileSync(abs, "utf8").includes("network_typo"));

  const anyway = await call(server, "PUT", "/api/config/yaml/file", { body: { file, text: broken, expectedRevision: fresh.revision, allowInvalid: true } });
  assert.equal(anyway.status, 200);
  assert.ok(fs.readFileSync(abs, "utf8").includes("network_typo"));
});
