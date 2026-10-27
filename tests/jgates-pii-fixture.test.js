"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  PII_FILE,
  createPiiFixture,
  isValidCpf,
  isValidCnpj,
  isValidLuhn,
  removePiiFixture
} = require("./fixtures/jgates/pii-fixture.js");
const { listTree } = require("./fixtures/jgates/main-fixture.js");

const SIDECAR = path.resolve(__dirname, "..", "quality-gate", "sidecar");

// Runs the bundled sidecar locally (no Docker) with the PII detector on.
function runSidecar(target) {
  return spawnSync(
    "python",
    ["-B", "-m", "quality_sidecar", "check", target, "--mode", "quick", "--format", "json,md", "--threshold", "99", "--enable-pii"],
    { cwd: SIDECAR, encoding: "utf8", env: { ...process.env, PYTHONPATH: SIDECAR, PYTHONDONTWRITEBYTECODE: "1" } }
  );
}

function readReports(dir) {
  const base = path.join(dir, ".quality", "reports");
  return {
    jsonText: fs.readFileSync(path.join(base, "quality-report.json"), "utf8"),
    mdText: fs.readFileSync(path.join(base, "quality-report.md"), "utf8")
  };
}

// The sidecar writes its reports under .quality; the fixture itself must stay untouched.
function withoutReports(tree) {
  return Object.fromEntries(Object.entries(tree).filter(([rel]) => !rel.startsWith(".quality/")));
}

test("pii fixture carries valid synthetic values, one per line", () => {
  const { dir, values, lines, files } = createPiiFixture();
  try {
    assert.ok(isValidCpf(values.cpf));
    assert.ok(isValidCnpj(values.cnpj));
    assert.ok(isValidLuhn(values.card));
    assert.match(values.phone, /^\(\d{2}\) 9\d{4}-\d{4}$/);
    assert.equal(new Set(Object.values(lines)).size, 4);
    assert.equal(fs.readFileSync(path.join(dir, PII_FILE), "utf8"), files[PII_FILE]);
  } finally {
    removePiiFixture(dir);
  }
});

test("local sidecar with --enable-pii finds cpf, cnpj and credit-card on the expected lines", () => {
  const { dir, lines } = createPiiFixture();
  try {
    const before = listTree(dir);
    const result = runSidecar(dir);
    assert.equal(result.status, 1, result.stdout + result.stderr);

    const report = JSON.parse(readReports(dir).jsonText);
    const found = new Set(
      report.findings.filter((f) => f.category === "pii" && f.path === PII_FILE).map((f) => `${f.rule}@${f.line}`)
    );
    for (const [rule, key] of [["pii.cpf", "cpf"], ["pii.cnpj", "cnpj"], ["pii.credit-card", "card"]]) {
      assert.ok(found.has(`${rule}@${lines[key]}`), `${rule} expected on line ${lines[key]}, got ${[...found].join(", ")}`);
    }
    // Nothing is asserted about the phone line: the phone detector is off by default.

    assert.deepEqual(withoutReports(listTree(dir)), before);
  } finally {
    removePiiFixture(dir);
  }
});

test("sidecar reports never contain the raw fixture values", () => {
  const { dir, values } = createPiiFixture();
  try {
    runSidecar(dir);
    const { jsonText, mdText } = readReports(dir);
    const digitsOnly = (v) => v.replace(/\D/g, "");
    for (const [name, value] of Object.entries(values)) {
      for (const needle of [value, digitsOnly(value)]) {
        assert.ok(!jsonText.includes(needle), `${name} leaked into the JSON report`);
        assert.ok(!mdText.includes(needle), `${name} leaked into the Markdown report`);
      }
    }
  } finally {
    removePiiFixture(dir);
  }
});
