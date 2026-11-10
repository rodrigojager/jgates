import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dockerAvailable } from "./dev-docker.mjs";

// The helper container with the real engine (npm run test:docker): the built-in PII detector and the tomlkit editor run
// in a short container of jgates-tools:dev that gets its input on standard input. The staged-file check on a fixture
// repository stays within the 3 s cold target of PLAN.md open point 8 (the time of this run is recorded in PROGRESS.md),
// finds the CPF without ever showing it, and a TOML edit through the helper keeps the comments and the layout.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "..", "dist");
const load = (rel) => import(pathToFileURL(path.join(dist, ...rel.split("/"))).href);
const CPF = "529.982.247-25";
const TARGET_MS = 3000;

const dirs = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const env = { ...process.env, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_LOCALE: "en" };
delete env.JGATES_PYTHON;
delete env.JGATES_CONTAINER_RUNTIME;

before(() => {
  assert.ok(dockerAvailable(), "Docker is required for npm run test:docker (the daemon did not answer)");
});
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function fixtureRepository() {
  const dir = tmp("jgates-helper-repo-");
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "T");
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, `module${i}.txt`), `nothing personal in module ${i}\n`.repeat(20));
  assert.equal(git("add", "-A").status, 0);
  assert.equal(git("commit", "-qm", "base", "--no-verify").status, 0);
  fs.writeFileSync(path.join(dir, "clients.txt"), `client: ${CPF}\n`);
  assert.equal(git("add", "clients.txt").status, 0);
  return dir;
}

test("the staged check of a fixture repository runs in a helper container, finds the CPF without showing it, within the cold target", async () => {
  const { checkPii } = await load("core/pii-fix/index.js");
  const dir = fixtureRepository();
  const home = tmp("jgates-helper-home-");
  const started = Date.now();
  const outcome = await checkPii({ projectDir: dir, scope: { kind: "staged", paths: [] }, env: { ...env, JGATES_HOME: home } });
  const elapsed = Date.now() - started;
  console.log(`# pii check --staged through the helper container: ${elapsed} ms (target ${TARGET_MS} ms)`);
  assert.equal(outcome.decision, "failed", JSON.stringify(outcome.detectors));
  assert.deepEqual(outcome.files.map((f) => [f.path, f.counts]), [["clients.txt", { cpf: 1 }]]);
  assert.ok(!JSON.stringify(outcome).includes(CPF), "the value is never in the outcome");
  assert.ok(elapsed < TARGET_MS, `the staged check took ${elapsed} ms`);
});

test("TOML edited through the helper container keeps the comments, the order and the layout", async () => {
  const { createTomlCodec } = await load("core/codecs/toml/index.js");
  const codec = createTomlCodec({ env });
  const text = ["# project metadata", "[project]", 'name = "demo"   # the name', 'version = "0.1.0"', "", "# tools", "[tool.ruff]", "line-length = 100  # keep short", ""].join("\n");
  const read = codec.read(text);
  assert.equal(read.ok, true, JSON.stringify(read.errors));
  assert.equal(read.value.project.version, "0.1.0");
  const patched = codec.apply(text, [{ op: "set", path: ["project", "version"], value: "0.2.0" }]);
  assert.equal(patched.changed, true);
  assert.equal(patched.text, text.replace('version = "0.1.0"', 'version = "0.2.0"'));
  for (const kept of ["# project metadata", "# the name", "# tools", "# keep short"]) assert.ok(patched.text.includes(kept), kept);
});
