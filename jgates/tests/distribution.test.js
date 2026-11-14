import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const d = await import(pathToFileURL(path.join(dist, "core", "distribution", "index.js")).href);
const { builtinManifests } = await import(pathToFileURL(path.join(dist, "adapters", "manifests.js")).href);

const MIT_TEXT = "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n";
const RECORD = {
  schemaVersion: 1,
  id: "sample-rules",
  kind: "rules",
  distribution: "shipped",
  source: { url: "https://example.com/sample-rules", revision: "v1.2.3" },
  spdx: "MIT",
  notices: ["LICENSE"],
  dependencies: [],
  review: "approved",
};

/** A pack folder in a temporary root: files maps relative paths to text; record null leaves the record out. */
function pack(files, record = RECORD) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-dist-"));
  const dir = path.join(root, "pack");
  const all = { LICENSE: MIT_TEXT, "rules/a.yml": "rules:\n  - id: a\n    pattern: eval(...)\n", ...files };
  if (record) all["jgates-pack.json"] = JSON.stringify(record, null, 2);
  for (const [rel, text] of Object.entries(all)) {
    if (text === null) continue;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return { root, dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const codes = (report) => report.problems.map((p) => p.code);

test("an MIT pack with provenance and its notice passes, and its identity ignores CRLF line endings", () => {
  const lf = pack({});
  const crlf = pack({ "rules/a.yml": "rules:\r\n  - id: a\r\n    pattern: eval(...)\r\n" });
  try {
    const a = d.checkPack(lf.dir);
    assert.deepEqual(a.problems, []);
    assert.equal(a.ok, true);
    assert.equal(a.id, "sample-rules");
    assert.deepEqual(a.files, ["LICENSE", "jgates-pack.json", "rules/a.yml"]);
    assert.equal(d.checkPack(crlf.dir).identity, a.identity);
    // A pinned identity must match the content.
    const pinned = pack({}, { ...RECORD, artifact: { sha256: a.identity } });
    try {
      assert.deepEqual(d.checkPack(pinned.dir).problems, []);
    } finally {
      pinned.cleanup();
    }
    const wrong = pack({}, { ...RECORD, artifact: { sha256: "sha256:" + "0".repeat(64) } });
    try {
      assert.deepEqual(codes(d.checkPack(wrong.dir)), ["ARTIFACT_MISMATCH"]);
    } finally {
      wrong.cleanup();
    }
  } finally {
    lf.cleanup();
    crlf.cleanup();
  }
});

test("restricted material is rejected wherever it is: rule metadata, a license file, the Commons Clause condition or the official source", () => {
  const cases = [
    [{ "rules/b.yml": "metadata:\n  license: Semgrep Rules License v1.0\n" }, RECORD, "RESTRICTED_MATERIAL"],
    [{ "NOTICE.txt": "See https://semgrep.dev/legal/rules-license/ for the terms." }, RECORD, "RESTRICTED_MATERIAL"],
    [{ "rules/c.yml": "# license: Commons Clause License Condition v1.0[LGPL-2.1-only]\n" }, RECORD, "RESTRICTED_MATERIAL"],
    [{}, { ...RECORD, source: { url: "https://github.com/semgrep/semgrep-rules", revision: "abc" } }, "RESTRICTED_SOURCE"],
    [{}, { ...RECORD, source: { url: "https://github.com/returntocorp/semgrep-rules.git", revision: "abc" } }, "RESTRICTED_SOURCE"],
  ];
  for (const [files, record, code] of cases) {
    const p = pack(files, record);
    try {
      const report = d.checkPack(p.dir);
      assert.equal(report.ok, false);
      assert.ok(codes(report).includes(code), `${code}: ${JSON.stringify(report.problems)}`);
    } finally {
      p.cleanup();
    }
  }
});

test("missing or incomplete provenance, an ineligible license, a missing notice, an unapproved review and a non-shipped mode keep a pack out", () => {
  const cases = [
    [null, ["PROVENANCE_MISSING"]],
    [{ ...RECORD, source: { url: "https://example.com/x" } }, ["PROVENANCE_INCOMPLETE"]],
    [{ ...RECORD, spdx: "LicenseRef-Proprietary" }, ["LICENSE_NOT_ELIGIBLE"]],
    [{ ...RECORD, spdx: "MIT AND LicenseRef-Proprietary" }, ["LICENSE_NOT_ELIGIBLE"]],
    [{ ...RECORD, dependencies: [{ name: "dep", spdx: "SSPL-1.0" }] }, ["LICENSE_NOT_ELIGIBLE"]],
    [{ ...RECORD, notices: ["THIRD_PARTY_NOTICES"] }, ["NOTICE_MISSING"]],
    [{ ...RECORD, notices: [] }, ["NOTICE_MISSING"]],
    [{ ...RECORD, review: "candidate" }, ["REVIEW_PENDING"]],
    [{ ...RECORD, distribution: "customer-supplied" }, ["NOT_SHIPPABLE"]],
    [{ ...RECORD, schemaVersion: 2 }, ["PROVENANCE_INVALID"]],
  ];
  for (const [record, expected] of cases) {
    const p = pack({}, record);
    try {
      assert.deepEqual(codes(d.checkPack(p.dir)), expected, JSON.stringify(record));
    } finally {
      p.cleanup();
    }
  }
});

test("SPDX expressions: OR needs one eligible side, AND needs both, WITH keeps the license", () => {
  assert.equal(d.spdxEligible("MIT"), true);
  assert.equal(d.spdxEligible("Apache-2.0 OR LicenseRef-X"), true);
  assert.equal(d.spdxEligible("(MIT AND BSD-3-Clause)"), true);
  assert.equal(d.spdxEligible("MIT AND LicenseRef-X"), false);
  assert.equal(d.spdxEligible("LGPL-2.1-only WITH Classpath-exception-2.0"), true);
  assert.equal(d.spdxEligible(""), false);
  assert.equal(d.spdxEligible("Semgrep-Rules-1.0"), false);
});

test("a shipping root treats each folder as a pack and a loose file as content without provenance", () => {
  const p = pack({});
  try {
    fs.writeFileSync(path.join(p.root, "stray.yml"), "rules: []\n");
    const reports = d.checkPackRoot(p.root);
    assert.deepEqual(reports.map((r) => [r.id, r.ok]), [["sample-rules", true], ["stray.yml", false]]);
    assert.deepEqual(codes(reports[1]), ["PROVENANCE_MISSING"]);
  } finally {
    p.cleanup();
  }
});

test("every built-in adapter has distribution metadata that passes the check, and each mode demands what it needs", () => {
  for (const m of builtinManifests()) assert.deepEqual(d.checkAdapterDistribution(m).problems, [], m.id);
  const ruff = builtinManifests().find((m) => m.id === "ruff");
  const check = (patch) => d.checkAdapterDistribution({ ...ruff, ...patch }).problems.map((p) => p.code);
  const { distribution, ...noDistribution } = ruff;
  assert.deepEqual(d.checkAdapterDistribution(noDistribution).problems.map((p) => p.code), ["DISTRIBUTION_MISSING"]);
  assert.deepEqual(check({ distribution: { mode: "customer-supplied", sourceUrl: "https://example.com" } }), ["ACQUISITION_MISSING"]);
  assert.deepEqual(check({ toolVersionRange: "*" }), ["VERSIONS_MISSING"]);
  assert.deepEqual(check({ distribution: { mode: "shipped", spdx: "LicenseRef-X", notices: ["LICENSE"] } }), ["LICENSE_NOT_ELIGIBLE"]);
  assert.deepEqual(check({ distribution: { mode: "shipped", spdx: "MIT", sourceUrl: "https://github.com/semgrep/semgrep-rules", revision: "x", notices: ["LICENSE"] } }), ["RESTRICTED_SOURCE"]);
  assert.deepEqual(check({ distribution: { mode: "shipped", spdx: "MIT" } }), ["NOTICE_MISSING"]);
  // CodeQL-like: customer supplied with official links and supported versions is accepted.
  assert.deepEqual(check({ distribution: { mode: "customer-supplied", sourceUrl: "https://github.com/github/codeql-cli-binaries", acquisition: ["https://github.com/github/codeql-cli-binaries/releases"] } }), []);
});

test("tools distribution prints the problems in text mode and exits 1, in the chosen language", () => {
  const p = pack({ "rules/b.yml": "license: Semgrep Rules License v1.0\n" });
  try {
    const r = spawnSync(process.execPath, [MAIN, "tools", "distribution", "--packs", p.root, "--locale", "en"], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /Distribution check failed with 1 problem./);
    assert.match(r.stdout, /RESTRICTED_MATERIAL {2}sample-rules: rules\/b\.yml carries restricted material/);
    const ok = spawnSync(process.execPath, [MAIN, "tools", "distribution"], { encoding: "utf8", env: { ...process.env, JGATES_LOCALE: "en" } });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /Distribution check passed: \d+ adapters, 0 packs/);
  } finally {
    p.cleanup();
  }
});
