import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The tools catalogue says what ships in the image (origin image, with the version, no install instruction) and
// leaves the retired quality bridge out; only what the customer really supplies (CodeQL) and own tools say so.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const imageTools = JSON.parse(fs.readFileSync(path.resolve(here, "..", "release", "image-tools.json"), "utf8")).tools;
const { routes } = await import(pathToFileURL(path.join(dist, "server", "routes", "tools.js")).href);
const route = (p) => routes.find((r) => r.method === "GET" && r.path === p);

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jgates-tools-origin-")));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const server = { projectDir: dir, policyMode: false, workspace: { id: "w", path: dir, name: "w" }, home: dir, log() {} };
const call = (p) => route(p).handler({ params: {}, query: {}, server }).json;

test("every adapter whose tool ships in the image has origin image, its version and no install instruction", () => {
  const { adapters } = call("/api/tool-catalog");
  const shipped = adapters.filter((a) => a.toolName in imageTools && a.adapter !== "codeql");
  assert.ok(shipped.length >= 20, `only ${shipped.length} adapters ship in the image`);
  for (const a of shipped) {
    assert.equal(a.origin.kind, "image", `${a.adapter} (${a.toolName})`);
    assert.equal(a.origin.version, imageTools[a.toolName], a.adapter);
    assert.equal(a.origin.installRequired, false, a.adapter);
  }
});

test("the matrix the Tools screen reads shows no customer-supplied guidance for a tool of the image", () => {
  const { matrix } = call("/api/tool-matrix");
  for (const a of matrix.adapters.filter((m) => m.tool in imageTools && m.distribution && m.id !== "codeql")) {
    assert.notEqual(a.distribution.mode, "customer-supplied", `${a.id} (${a.tool})`);
  }
});

test("only CodeQL and own tools are not from the image", () => {
  const { adapters } = call("/api/tool-catalog");
  const codeql = adapters.find((a) => a.adapter === "codeql");
  assert.equal(codeql.origin.kind, "customer");
  assert.equal(codeql.origin.installRequired, true);
  assert.equal(adapters.find((a) => a.adapter === "generic-command").origin.kind, "own");
  const customers = adapters.filter((a) => a.origin.kind === "customer").map((a) => a.adapter);
  assert.deepEqual(customers, ["codeql"]);
});

test("the quality bridge is not a catalogue entry", () => {
  const { adapters } = call("/api/tool-catalog");
  assert.equal(adapters.some((a) => a.adapter === "quality-bridge" || a.toolName === "quality-gate"), false);
  assert.equal(call("/api/tool-matrix").matrix.adapters.some((a) => a.id === "quality-bridge"), false);
});
