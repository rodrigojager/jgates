import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const ids = await import(path.join(dist, "core", "ids", "index.js"));
const cat = await import(path.join(dist, "core", "catalog", "index.js"));
const { qualityBridgeManifest } = await import(path.join(dist, "adapters", "quality-bridge", "manifest.js"));

test("tools list --json prints categories, capabilities and the bridge adapter with subchecks", () => {
  const r = spawnSync(process.execPath, [MAIN, "tools", "list", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.status, "OK");
  assert.ok(doc.categories.some((c) => c.id === "security"));
  assert.ok(doc.capabilities.some((c) => c.id === "lint"));
  const bridge = doc.adapters.find((a) => a.id === "quality-bridge");
  assert.equal(bridge.kind, "composite");
  assert.ok(bridge.subchecks.some((s) => s.id === "semgrep"));
  assert.ok(bridge.limitations.length > 0);
});

test("the bridge manifest validates against the manifest schema, and a broken one does not", () => {
  assert.deepEqual(cat.validateManifest(qualityBridgeManifest), { ok: true, errors: [] });
  const broken = { ...qualityBridgeManifest, granularity: ["galaxy"] };
  delete broken.license;
  assert.equal(cat.validateManifest(broken).ok, false);
});

test("workspace id is the same for a symlink and changes for another folder", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ids-"));
  try {
    const a = path.join(base, "a");
    const b = path.join(base, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const link = path.join(base, "link");
    fs.symlinkSync(a, link, "dir");
    assert.equal(ids.workspaceId(link), ids.workspaceId(a));
    assert.notEqual(ids.workspaceId(a), ids.workspaceId(b));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("content hash ignores key order and detects changes; run ids are unique", () => {
  const x = { a: 1, b: { c: [1, { y: 2, x: 1 }], d: null } };
  const y = { b: { d: null, c: [1, { x: 1, y: 2 }] }, a: 1 };
  assert.equal(ids.contentHash(x), ids.contentHash(y));
  assert.notEqual(ids.contentHash(x), ids.contentHash({ ...x, a: 2 }));
  assert.match(ids.contentHash(x), /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(ids.newRunId(), ids.newRunId());
});

test("an extension capability with namespace is accepted without changing the core; bad ids are not", () => {
  const catalog = cat.createCoreCatalog();
  catalog.addCapability({ id: "x-acme:bundle-size", category: "custom", label: "Bundle size", description: "Bundle budget.", unit: "bytes" });
  assert.ok(catalog.hasCapability("x-acme:bundle-size"));
  assert.throws(() => catalog.addCapability({ id: "Bad Id", label: "x", description: "x" }));
  assert.throws(() => catalog.addCapability({ id: "x-acme:bundle-size", label: "x", description: "x" }), /duplicate/);
  const manifest = { ...qualityBridgeManifest, id: "acme-bundle", capabilities: ["x-acme:bundle-size"], subchecks: [] };
  catalog.addAdapter(manifest);
  assert.ok(catalog.toDocument().adapters.some((a) => a.id === "acme-bundle"));
});
