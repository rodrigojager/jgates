// V2-15: restricted rules enter a shipping pack -> the distribution check rejects it.
// The fixtures under fixtures/v2-15 are three rule packs: one whose record claims MIT but that carries a rule copied
// from the official semgrep-rules (its license marker in the rule metadata), one without a provenance record, and an
// MIT pack with full provenance. The check reads the files themselves, so the false record does not save the first.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.join(repo, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const distribution = await import(pathToFileURL(path.join(dist, "core", "distribution", "index.js")).href);
const FIXTURES = path.join(here, "fixtures", "v2-15");

function cli(packs) {
  const r = spawnSync(process.execPath, [MAIN, "tools", "distribution", "--packs", packs, "--json"], { encoding: "utf8" });
  return { code: r.status, doc: JSON.parse(r.stdout), err: r.stderr };
}

test("V2-15: a pack with the Semgrep Rules License marker and a pack without provenance are rejected by the distribution check, while an MIT pack with provenance passes", () => {
  const report = distribution.checkDistribution({ roots: [FIXTURES] });
  const pack = (id) => report.packs.find((p) => p.id === id);
  assert.deepEqual(report.packs.map((p) => p.id).sort(), ["no-provenance-rules", "v2-15-mit-rules", "v2-15-restricted-rules"]);

  const restricted = pack("v2-15-restricted-rules");
  assert.equal(restricted.ok, false);
  const marker = restricted.problems.filter((p) => p.code === "RESTRICTED_MATERIAL");
  assert.ok(marker.length > 0, JSON.stringify(restricted.problems));
  assert.ok(marker.every((p) => p.file === "rules/copied-rule.yml"), JSON.stringify(marker));

  const unprovenanced = pack("no-provenance-rules");
  assert.equal(unprovenanced.ok, false);
  assert.deepEqual(unprovenanced.problems.map((p) => p.code), ["PROVENANCE_MISSING"]);

  const mit = pack("v2-15-mit-rules");
  assert.deepEqual(mit.problems, []);
  assert.equal(mit.ok, true);
  assert.match(mit.identity, /^sha256:[0-9a-f]{64}$/);
  assert.equal(mit.record.spdx, "MIT");
  assert.equal(report.ok, false);

  // The CLI gives the same verdict and fails the shipping folder that holds the rejected packs.
  const all = cli(FIXTURES);
  assert.equal(all.code, 1, all.err);
  assert.equal(all.doc.status, "FAILED");
  assert.deepEqual(all.doc.report.packs.filter((p) => !p.ok).map((p) => p.id).sort(), ["no-provenance-rules", "v2-15-restricted-rules"]);

  // A shipping folder with only the MIT pack passes (the built-in adapters' distribution metadata included).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-v2-15-"));
  try {
    fs.cpSync(path.join(FIXTURES, "mit-rules"), path.join(root, "mit-rules"), { recursive: true });
    const clean = cli(root);
    assert.equal(clean.code, 0, JSON.stringify(clean.doc.report?.problems ?? clean.doc));
    assert.equal(clean.doc.status, "OK");
    assert.deepEqual(clean.doc.report.packs.map((p) => [p.id, p.ok]), [["v2-15-mit-rules", true]]);
    assert.equal(clean.doc.report.packs[0].identity, mit.identity);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
