import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fake = fileURLToPath(new URL("./docker/fake-docker.cjs", import.meta.url));
const target = { id: "target-id", name: "jgates-current-gen-b", state: "running", labels: { "org.jgates.managed": "true", "org.jgates.run": "current" } };
const other = { id: "other-id", name: "jgates-other-step", state: "running", labels: { "org.jgates.managed": "true", "org.jgates.run": "other" } };

function machine(t, coordinated = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-kill-order-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const order = path.join(dir, "order.json");
  fs.writeFileSync(path.join(dir, "objects.json"), JSON.stringify({ containers: [target, other], volumes: [], networks: [], images: [] }));
  fs.writeFileSync(path.join(dir, `${target.name}.container`), "running");
  fs.writeFileSync(order, JSON.stringify({ id: target.id, name: target.name, run: "current", waitMs: 100 }));
  const env = { ...process.env, FAKE_DOCKER_STATE: dir, FAKE_DOCKER_LOG: path.join(dir, "calls.jsonl"), FAKE_DOCKER_KILL_BEFORE_RM: coordinated ? order : "" };
  return { dir, invoke: (...args) => spawnSync(process.execPath, [fake, ...args], { env, encoding: "utf8", timeout: 5000 }) };
}

test("fake kill coordination permits removal only after the actual target kill completes", (t) => {
  const m = machine(t);
  assert.equal(m.invoke("kill", target.id).status, 0);
  assert.equal(m.invoke("rm", "--force", target.name).status, 0);
  assert.equal(fs.existsSync(path.join(m.dir, `${target.name}.container`)), false);
  const objects = JSON.parse(fs.readFileSync(path.join(m.dir, "objects.json"), "utf8"));
  assert.deepEqual(objects.containers, [other], "the unrelated running container is untouched");
});

for (const wrongKill of [false, true]) {
  test(`fake kill coordination fails explicitly with ${wrongKill ? "a wrong-target" : "no"} kill`, (t) => {
    const m = machine(t);
    if (wrongKill) assert.equal(m.invoke("kill", other.id).status, 0);
    const removal = m.invoke("rm", "--force", target.name);
    assert.equal(removal.status, 1, removal.stderr);
    assert.match(removal.stderr, /labelled kill did not complete/);
    assert.equal(fs.existsSync(path.join(m.dir, `${target.name}.container`)), true, "failure never falls back to removal");
    const objects = JSON.parse(fs.readFileSync(path.join(m.dir, "objects.json"), "utf8"));
    assert.equal(objects.containers.find((c) => c.id === target.id).state, "running");
  });
}

test("without opt-in, exact-name force removal needs no preceding kill", (t) => {
  const m = machine(t, false);
  assert.equal(m.invoke("rm", "--force", target.name).status, 0);
  const objects = JSON.parse(fs.readFileSync(path.join(m.dir, "objects.json"), "utf8"));
  assert.deepEqual(objects.containers, [other]);
  assert.equal(fs.existsSync(path.join(m.dir, `${target.name}.container`)), false);
});
