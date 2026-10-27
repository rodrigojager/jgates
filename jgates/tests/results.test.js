import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Findings with a versioned fingerprint, SARIF and JSON export, history, baseline comparison and waivers.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const run = await import(pathToFileURL(path.join(dist, "core", "run", "index.js")).href);
const results = await import(pathToFileURL(path.join(dist, "core", "results", "index.js")).href);

const validateResult = new Ajv2020({ strict: true, allErrors: true }).compile(
  JSON.parse(fs.readFileSync(path.resolve(here, "..", "schemas", "result", "result.schema.json"), "utf8")),
);
// The parts of SARIF 2.1.0 the export promises (the full schema is not shipped offline).
const validateSarif = new Ajv2020({ strict: false, allErrors: true }).compile({
  type: "object",
  required: ["version", "runs"],
  properties: {
    version: { const: "2.1.0" },
    runs: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["tool", "results"],
        properties: {
          tool: { type: "object", required: ["driver"], properties: { driver: { type: "object", required: ["name"] } } },
          results: {
            type: "array",
            items: {
              type: "object",
              required: ["message"],
              properties: {
                level: { enum: ["none", "note", "warning", "error"] },
                message: { type: "object", required: ["text"] },
                locations: { type: "array", items: { type: "object", properties: { physicalLocation: { type: "object", required: ["artifactLocation"] } } } },
              },
            },
          },
        },
      },
    },
  },
});

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (...dirs) => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));

function finding(over = {}) {
  return {
    stageId: "fake",
    tool: "gitleaks",
    ruleId: "generic-api-key",
    severity: "high",
    normalizedSeverity: "high",
    message: "a key was found",
    location: { path: "src/a.ts", line: 10 },
    blocking: false,
    waived: false,
    ...over,
  };
}

async function doRun(ws, home, { findings = [], state = "completed", blockingViolations, disabled, selection, waivers } = {}) {
  return run.executeRun({
    workspacePath: ws,
    home,
    version: "0.0.0-test",
    adapter: "fake",
    options: {},
    env: { ...process.env, JGATES_NO_CACHE: "1" },
    ...(selection ? { selection } : {}),
    ...(disabled ? { disabled } : {}),
    ...(waivers ? { waivers } : {}),
    execute: async () => ({
      stages: [{ id: "fake", kind: "step", adapter: "fake", state, ...(blockingViolations !== undefined ? { blockingViolations } : {}) }],
      requirements: [{ id: "fake", required: true }],
      disabled: [],
      findings,
      logs: [],
      outputs: [],
    }),
  });
}

function cli(args, home) {
  return spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...process.env, JGATES_HOME: home }, timeout: 120_000 });
}

test("fingerprint: stable when lines are inserted above, changes with the rule or the file", () => {
  const [a] = results.assignFingerprints([finding({ location: { path: "src/a.ts", line: 10 } })]);
  const [shifted] = results.assignFingerprints([finding({ location: { path: "src/a.ts", line: 57 } })]);
  const [otherMessage] = results.assignFingerprints([finding({ message: "different words" })]);
  const [otherRule] = results.assignFingerprints([finding({ ruleId: "aws-access-token" })]);
  const [otherFile] = results.assignFingerprints([finding({ location: { path: "src/b.ts", line: 10 } })]);
  const [winPath] = results.assignFingerprints([finding({ location: { path: ".\\src\\a.ts", line: 10 } })]);
  assert.equal(a.fingerprint, shifted.fingerprint);
  assert.equal(a.fingerprint, otherMessage.fingerprint);
  assert.equal(a.fingerprint, winPath.fingerprint);
  assert.notEqual(a.fingerprint, otherRule.fingerprint);
  assert.notEqual(a.fingerprint, otherFile.fingerprint);
  assert.equal(a.fingerprintVersion, 1);
  assert.match(a.fingerprint, /^jgf1:[0-9a-f]{32}$/);
});

test("fingerprint: same rule in the same file never collides, and keeps its order when lines shift", () => {
  const many = Array.from({ length: 200 }, (_, i) => finding({ location: { path: "src/a.ts", line: i + 1 } }));
  const first = results.assignFingerprints(many);
  assert.equal(new Set(first.map((f) => f.fingerprint)).size, 200);
  const shifted = results.assignFingerprints(many.map((f) => ({ ...f, location: { ...f.location, line: f.location.line + 40 } })));
  assert.deepEqual(shifted.map((f) => f.fingerprint), first.map((f) => f.fingerprint));
});

test("fingerprint: holds neither a secret nor PII", () => {
  const secret = "AKIAIOSFODNN7EXAMPLE";
  const cpf = "123.456.789-09";
  const [f] = results.assignFingerprints([
    finding({ message: `key ${secret} and ${cpf}`, evidence: `${secret}`, location: { path: "src/a.ts", line: 3 } }),
  ]);
  assert.ok(!f.fingerprint.includes(secret) && !f.fingerprint.includes("123456789"));
  // The inputs of the hash are the tool, rule, path and occurrence: changing only the value changes nothing.
  const [g] = results.assignFingerprints([finding({ message: "x", evidence: "y", location: { path: "src/a.ts", line: 3 } })]);
  assert.equal(f.fingerprint, g.fingerprint);
});

test("SARIF 2.1.0 export from the CLI is valid, and report --format json is the result.json", async () => {
  const ws = tmp("jg-res-ws-");
  const home = tmp("jg-res-home-");
  const out = tmp("jg-res-out-");
  try {
    const result = await doRun(ws, home, {
      findings: [
        finding({ location: { path: "src/a b.ts", line: 4, column: 2 } }),
        finding({ ruleId: "odd", severity: "weird", normalizedSeverity: "unknown", location: undefined }),
      ],
    });
    assert.ok(validateResult(result), JSON.stringify(validateResult.errors));
    assert.ok(result.findings.every((f) => /^jgf1:/.test(f.fingerprint)));
    assert.ok(result.metrics.some((m) => m.id === "findings.total" && m.value === 2 && m.unit === "count"));
    const sarifFile = path.join(out, "r.sarif");
    const r = cli(["report", result.runId, "--cwd", ws, "--format", "sarif", "--out", sarifFile], home);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const sarif = JSON.parse(fs.readFileSync(sarifFile, "utf8"));
    assert.ok(validateSarif(sarif), JSON.stringify(validateSarif.errors));
    assert.equal(sarif.runs[0].results.length, 2);
    assert.equal(sarif.runs[0].results[0].level, "error");
    assert.equal(sarif.runs[0].results[1].level, "warning", "an unknown severity is never turned into a note");
    assert.ok(sarif.runs[0].results[0].partialFingerprints["jgates/v1"]);
    assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, "src/a%20b.ts");

    const j = cli(["report", result.runId, "--cwd", ws, "--format", "json"], home);
    assert.equal(j.status, 0);
    assert.equal(j.stdout, fs.readFileSync(path.join(result.runDir, "result.json"), "utf8"));
    assert.equal(cli(["report", "run_nope", "--cwd", ws], home).status, 3);
  } finally {
    rm(ws, home, out);
  }
});

test("history --json lists the runs and marks a reduced run as partial", async () => {
  const ws = tmp("jg-res-ws-");
  const home = tmp("jg-res-home-");
  try {
    const full = await doRun(ws, home);
    const reduced = await doRun(ws, home, { disabled: [{ id: "sast", origin: "run", reason: "--skip sast" }] });
    assert.equal(reduced.reduced, true);
    const h = cli(["history", "--cwd", ws, "--json", "--limit", "5"], home);
    assert.equal(h.status, 0, h.stderr);
    const doc = JSON.parse(h.stdout);
    assert.deepEqual(doc.runs.map((r) => r.runId).sort(), [full.runId, reduced.runId].sort());
    const byId = Object.fromEntries(doc.runs.map((r) => [r.runId, r]));
    assert.equal(byId[reduced.runId].partial, true);
    assert.equal(byId[reduced.runId].reduced, true);
    assert.equal(byId[full.runId].partial, false);
  } finally {
    rm(ws, home);
  }
});

test("baseline: the next run separates new, resolved and kept; a scope or policy change warns", async () => {
  const ws = tmp("jg-res-ws-");
  const home = tmp("jg-res-home-");
  try {
    const fa = finding({ ruleId: "rule-a", location: { path: "a.ts", line: 1 } });
    const fb = finding({ ruleId: "rule-b", location: { path: "b.ts", line: 1 } });
    const fc = finding({ ruleId: "rule-c", location: { path: "c.ts", line: 1 } });
    const first = await doRun(ws, home, { findings: [fa, fb], selection: { scope: "workspace" } });
    const set = cli(["baseline", "set", first.runId, "--cwd", ws, "--json"], home);
    assert.equal(set.status, 0, set.stderr);
    assert.equal(JSON.parse(cli(["baseline", "show", "--cwd", ws, "--json"], home).stdout).baseline, first.runId);

    const second = await doRun(ws, home, { findings: [{ ...fb, location: { path: "b.ts", line: 30 } }, fc], selection: { scope: "workspace" } });
    assert.ok(validateResult(second), JSON.stringify(validateResult.errors));
    assert.equal(second.baseline.runId, first.runId);
    assert.equal(second.baseline.new, 1);
    assert.equal(second.baseline.kept, 1);
    assert.deepEqual(second.baseline.resolved.map((r) => r.ruleId), ["rule-a"]);
    assert.equal(second.baseline.comparable, true);
    assert.deepEqual(second.findings.map((f) => f.baselineState), ["unchanged", "new"]);

    const third = await doRun(ws, home, { findings: [fb], selection: { scope: "changed" } });
    assert.equal(third.baseline.comparable, false);
    assert.ok(third.baseline.warnings.some((w) => w.code === "SCOPE_CHANGED"));

    const cmp = JSON.parse(cli(["baseline", "compare", second.runId, "--cwd", ws, "--json"], home).stdout);
    assert.deepEqual([cmp.comparison.new, cmp.comparison.kept, cmp.comparison.resolved.length], [1, 1, 1]);
  } finally {
    rm(ws, home);
  }
});

test("baseline: a different policy or rules between the two results warns", () => {
  const mk = (hashes, extra = {}) => ({ runId: "r", findings: [], reduced: false, selection: { scope: "workspace" }, provenance: { hashes }, ...extra });
  const same = { policy: "p1", config: "c1", templates: "t1", tools: "x1", nativeFiles: "n1" };
  assert.equal(results.compareWithBaseline(mk(same), mk(same)).comparable, true);
  const policy = results.compareWithBaseline(mk(same), mk({ ...same, policy: "p2" }));
  assert.equal(policy.comparable, false);
  assert.deepEqual(policy.warnings.map((w) => w.code), ["POLICY_CHANGED"]);
  const rules = results.compareWithBaseline(mk(same), mk({ ...same, tools: "x2" }));
  assert.deepEqual(rules.warnings.map((w) => w.code), ["RULES_CHANGED"]);
  assert.ok(results.compareWithBaseline(mk(same, { partial: true }), mk(same)).warnings.some((w) => w.code === "BASELINE_PARTIAL"));
});

test("waivers: an expired waiver does not apply, a live one does, and a waiver never turns an error stage into passed", async () => {
  const ws = tmp("jg-res-ws-");
  const home = tmp("jg-res-home-");
  try {
    const blocking = finding({ ruleId: "secret", blocking: true, blockingReason: "blocking-category", location: { path: "k.ts", line: 2 } });
    const expired = [{ rule: "secret", reason: "old", expires: "2000-01-01" }];
    const live = [{ rule: "secret", path: "*.ts", reason: "accepted", expires: "2999-12-31" }];

    const kept = await doRun(ws, home, { findings: [blocking], blockingViolations: 1, waivers: expired });
    assert.equal(kept.findings[0].waived, false);
    assert.equal(kept.decision, "failed");

    const waived = await doRun(ws, home, { findings: [blocking], blockingViolations: 1, waivers: live });
    assert.equal(waived.findings[0].waived, true);
    assert.equal(waived.findings[0].waiverReason, "accepted");
    assert.equal(waived.decision, "passed");

    const failedScanner = await doRun(ws, home, { findings: [blocking], state: "error", waivers: live });
    assert.equal(failedScanner.findings[0].waived, true);
    assert.notEqual(failedScanner.decision, "passed");
    assert.equal(failedScanner.stages[0].state, "error");

    // The sidecar's own waiver ids (its fingerprint) still match through nativeFingerprint.
    const [native] = results.finalizeFindings({ findings: [finding({ fingerprint: "abc123" })], stages: [] }, [{ fingerprint: "abc123", reason: "r" }], new Date()).findings;
    assert.equal(native.waived, true);
    assert.equal(native.nativeFingerprint, "abc123");
  } finally {
    rm(ws, home);
  }
});
