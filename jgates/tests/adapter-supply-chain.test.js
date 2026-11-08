import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// Supply-chain check: install scripts, missing integrity, untrusted registries and deprecated packages from npm and
// Python lockfiles, offline, with what it cannot decide reported as unknown (never clean).

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const FIXTURES = path.join(here, "fixtures", "supply-chain");
const { analyzeSupplyChain } = await import(pathToFileURL(path.join(dist, "adapters", "supply-chain", "index.js")).href);
const { translator } = await import(pathToFileURL(path.join(dist, "i18n", "index.js")).href);

const signals = (r) => r.findings.map((f) => `${f.signal}:${f.package}`).sort();

test("supply-chain: a postinstall dependency without integrity is a finding and a clean lockfile none", () => {
  const risky = analyzeSupplyChain(path.join(FIXTURES, "npm-risky"));
  assert.deepEqual(signals(risky), ["install-script:shady", "missing-integrity:shady"]);
  assert.equal(risky.network, false);
  assert.ok(risky.findings.every((f) => f.file === "package-lock.json" && f.ecosystem === "npm"));

  const clean = analyzeSupplyChain(path.join(FIXTURES, "npm-clean"));
  assert.deepEqual(clean.findings, []);
  assert.deepEqual(clean.unknown, []);
});

test("supply-chain: untrusted registries, git sources and deprecated packages are findings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-sc-"));
  fs.writeFileSync(
    path.join(dir, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/a": { version: "1.0.0", resolved: "https://evil.example/a.tgz", integrity: "sha512-x" },
        "node_modules/b": { version: "1.0.0", resolved: "git+ssh://git@github.com/x/b.git#main" },
        "node_modules/c": { version: "1.0.0", resolved: "https://registry.npmjs.org/c/-/c-1.0.0.tgz", integrity: "sha512-x", deprecated: "use d" },
      },
    }),
  );
  const r = analyzeSupplyChain(dir);
  assert.deepEqual(signals(r), ["deprecated:c", "missing-integrity:b", "unpinned-registry:a", "unpinned-registry:b"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("supply-chain: Python requirements without hashes or from an untrusted index are findings; deprecation is unknown", () => {
  const risky = analyzeSupplyChain(path.join(FIXTURES, "python-risky"));
  assert.deepEqual(signals(risky), ["missing-integrity:requests", "unpinned-registry:http://packages.internal.example/simple"]);
  assert.ok(risky.unknown.some((u) => u.signal === "deprecated"), "offline deprecation must be unknown, not clean");

  const clean = analyzeSupplyChain(path.join(FIXTURES, "python-clean"));
  assert.deepEqual(clean.findings, []);
  assert.ok(clean.unknown.some((u) => u.signal === "deprecated"));
});

test("supply-chain: no lockfile and an unreadable lockfile are unknown, never clean", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-sc-"));
  const none = analyzeSupplyChain(dir);
  assert.deepEqual(none.findings, []);
  assert.deepEqual(none.unknown.map((u) => u.signal), ["lockfile"]);
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{ not json");
  const broken = analyzeSupplyChain(dir);
  assert.deepEqual(broken.findings, []);
  assert.equal(broken.unknown[0].signal, "lockfile");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("supply-chain: messages exist in both languages", () => {
  const en = translator("supply-chain", "en");
  const pt = translator("supply-chain", "pt-BR");
  assert.notEqual(en("sc_no_lockfile"), pt("sc_no_lockfile"));
  const keys = (l) => Object.keys(JSON.parse(fs.readFileSync(path.join(dist, "i18n", `supply-chain.${l}.json`), "utf8"))).sort();
  assert.deepEqual(keys("en"), keys("pt-BR"));
});
