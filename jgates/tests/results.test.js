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

async function doRun(ws, home, { findings = [], state = "completed", blockingViolations, disabled, selection, waivers, policy } = {}) {
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
    ...(policy ? { policy } : {}),
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

// Waivers per occurrence (PLAN-waivers.md sections 2 and 4).

function writeFiles(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
}

const NOW = new Date("2026-11-14T12:00:00Z");
const lint = (line, over = {}) => finding({ tool: "ruff", ruleId: "F401", category: "lint", location: { path: "src/app.py", line }, ...over });

test("anchor: a finding with a file and a line gets jga1; none without a line, for an unreadable file, for secrets and personal data; never the line text", async () => {
  const ws = tmp("jg-res-ws-");
  const home = tmp("jg-res-home-");
  try {
    const source = "import os\nimport sys\nTOKEN = 'abc'\n";
    writeFiles(ws, { "src/app.py": source });
    const findings = [
      lint(1),
      lint(2),
      finding({ tool: "ruff", ruleId: "E999", category: "lint", location: { path: "src/app.py" } }),
      lint(3, { location: { path: "missing/nowhere.py", line: 3 } }),
      finding({ tool: "gitleaks", ruleId: "generic-api-key", category: "secrets", location: { path: "src/app.py", line: 3 } }),
      finding({ tool: "builtin-pii", ruleId: "pii.cpf", category: "pii", location: { path: "src/app.py", line: 3 } }),
    ];
    const result = await doRun(ws, home, { findings });
    assert.ok(validateResult(result), JSON.stringify(validateResult.errors));
    const [a, b, noLine, unreadable, secret, pii] = result.findings;
    assert.match(a.anchor, /^jga1:[0-9a-f]{32}$/);
    assert.match(b.anchor, /^jga1:[0-9a-f]{32}$/);
    assert.notEqual(a.anchor, b.anchor);
    for (const f of [noLine, unreadable, secret, pii]) assert.equal(f.anchor, undefined, JSON.stringify(f));
    // Only the hash is kept: no line text anywhere in the finding.
    const text = JSON.stringify(result.findings);
    for (const line of source.split("\n").filter(Boolean)) assert.ok(!text.includes(line), `the line "${line}" leaked`);
    assert.ok(!text.includes("TOKEN"));
    // The SARIF export does not carry the anchor.
    assert.ok(!JSON.stringify(results.toSarif(result)).includes("jga1:"));
    // Lines inserted above keep the anchors (the text and the position among equal lines are what counts).
    writeFiles(ws, { "src/app.py": `# header\n\n${source}` });
    const shifted = await doRun(ws, home, { findings: [lint(3), lint(4)] });
    assert.deepEqual(shifted.findings.map((f) => f.anchor), [a.anchor, b.anchor]);
  } finally {
    rm(ws, home);
  }
});

test("fingerprint v1: the values of a fixed fixture are byte-identical to those before the anchors existed", () => {
  const fixture = () => [
    finding({ tool: "ruff", ruleId: "F401", location: { path: "src/app.py", line: 9 } }),
    finding({ tool: "ruff", ruleId: "F401", location: { path: "src/app.py", line: 3 } }),
    finding({ tool: "gitleaks", ruleId: "generic-api-key", location: { path: ".\\config\\settings.py", line: 2 } }),
  ];
  const expected = ["jgf1:a632b2cf2e111c9125d719b53bc5b1f8", "jgf1:018fa1ca9562b2de4840beebc7eb4661", "jgf1:9eac7e36d7710eba01b18534ade5424d"];
  assert.deepEqual(results.assignFingerprints(fixture()).map((f) => f.fingerprint), expected);
  // Computing anchors next to them changes nothing.
  const lineOf = () => "import os";
  assert.deepEqual(results.finalizeFindings({ findings: fixture(), stages: [] }, [], NOW, { lineOf }).findings.map((f) => f.fingerprint), expected);
});

test("waivers: by rule and path, by path, and by fingerprint alone match exactly as before", () => {
  const base = [
    finding({ ruleId: "r1", location: { path: "src/a.ts", line: 1 } }),
    finding({ ruleId: "r1", location: { path: "lib/b.ts", line: 1 } }),
    finding({ ruleId: "r2", location: { path: "src/c.ts", line: 4 } }),
  ];
  const waivedBy = (waivers, findings = base) => results.finalizeFindings({ findings, stages: [] }, waivers, NOW).findings.map((f) => f.waived);
  assert.deepEqual(waivedBy([{ rule: "r1", path: "src/*", reason: "x" }]), [true, false, false]);
  assert.deepEqual(waivedBy([{ rule: "r1", reason: "x" }]), [true, true, false]);
  assert.deepEqual(waivedBy([{ path: "src/*", reason: "x" }]), [true, false, true]);
  const ruleAndPath = results.finalizeFindings({ findings: base, stages: [] }, [{ rule: "r1", path: "src/*", reason: "x" }], NOW).findings[0];
  assert.equal(ruleAndPath.waiverId, "r1@src/*");
  assert.equal(ruleAndPath.waiverSource, "project");
  // A hand-written waiver with only a fingerprint has no guard: one more finding of the rule in the file changes nothing.
  const target = results.assignFingerprints(base)[2].fingerprint;
  const more = [...base, finding({ ruleId: "r2", location: { path: "src/c.ts", line: 10 } })];
  const out = results.finalizeFindings({ findings: more, stages: [] }, [{ fingerprint: target, reason: "x" }], NOW);
  assert.deepEqual(out.findings.map((f) => f.waived), [false, false, true, false]);
  assert.deepEqual(out.waivers.stale, []);
  assert.equal(out.findings[2].waiverId, target);
});

test("waivers: the project's file comes before --waiver and the first match wins", () => {
  const findings = [finding({ ruleId: "r1", location: { path: "a.ts", line: 1 } }), finding({ ruleId: "r2", location: { path: "b.ts", line: 1 } })];
  const fileWaivers = results.parseWaivers({ waivers: [{ rule: "r1", reason: "from the file" }] }).waivers;
  const flagOne = results.parseWaiverFlag("rule=r1;reason=from the flag");
  const flagTwo = results.parseWaiverFlag("rule=r2;reason=only the flag");
  assert.equal(flagOne.waiver.source, "flag");
  const combined = results.combineWaivers(fileWaivers, [flagOne.waiver, flagTwo.waiver]);
  assert.deepEqual(combined.map((w) => w.source), ["project", "flag", "flag"]);
  const out = results.finalizeFindings({ findings, stages: [] }, combined, NOW);
  assert.equal(out.findings[0].waiverReason, "from the file");
  assert.equal(out.findings[0].waiverSource, "project");
  assert.equal(out.findings[1].waiverReason, "only the flag");
  assert.equal(out.findings[1].waiverSource, "flag");
  assert.deepEqual(out.waivers.applied.map((e) => [e.source, e.rule, e.findings]), [["project", "r1", 1], ["flag", "r2", 1]]);
  assert.deepEqual(out.waivers.unmatched.map((e) => [e.source, e.reason]), [["flag", "from the flag"]]);
});

test("waivers: result.json records what the waivers did, each waived finding says where its waiver came from, and the document validates", async () => {
  const ws = tmp("jg-res-ws-");
  const home = tmp("jg-res-home-");
  try {
    writeFiles(ws, { "src/a.ts": "one();\ntwo();\n", "src/b.ts": "three();\nfour();\n", "src/c.ts": "five();\n" });
    const findings = [
      finding({ ruleId: "r1", category: "lint", blocking: true, blockingReason: "blocking-category", location: { path: "src/a.ts", line: 1 } }),
      finding({ ruleId: "r1", category: "lint", location: { path: "src/b.ts", line: 2 } }),
      finding({ ruleId: "r3", category: "lint", location: { path: "src/c.ts", line: 1 } }),
    ];
    // An occurrence waiver made from the first run's r3 finding, plus hand-written entries.
    const first = await doRun(ws, home, { findings, blockingViolations: 1 });
    assert.equal(first.waivers.count, 0);
    assert.deepEqual(first.waivers.applied, []);
    const entry = results.occurrenceWaiver(first, first.findings[2], { reason: "false positive", expires: "2999-12-31", created: "2026-11-14" });
    assert.deepEqual(Object.keys(entry), ["tool", "rule", "path", "fingerprint", "anchor", "occurrences", "line", "reason", "created", "expires"]);
    assert.equal(entry.anchor, first.findings[2].anchor);
    assert.equal(entry.occurrences, 1);
    writeFiles(ws, {
      ".jgates/waivers.json": `${JSON.stringify({
        waivers: [
          { rule: "r1", path: "src/*", reason: "accepted", expires: "2999-12-31" },
          entry,
          { rule: "r9", reason: "matches nothing" },
          { rule: "r1", reason: "old", expires: "2000-01-01" },
        ],
      })}\n`,
    });
    const result = await doRun(ws, home, { findings, blockingViolations: 1 });
    assert.equal(result.decision, "passed");
    const w = result.waivers;
    assert.equal(w.count, 2);
    assert.equal(w.findings, 3);
    assert.deepEqual(w.applied.map((e) => [e.source, e.rule, e.findings]), [["project", "r1", 2], ["project", "r3", 1]]);
    assert.deepEqual(w.applied[0], { source: "project", id: "r1@src/*", rule: "r1", path: "src/*", reason: "accepted", expires: "2999-12-31", findings: 2 });
    const occurrence = w.applied[1];
    assert.equal(occurrence.path, "src/c.ts");
    assert.equal(occurrence.line, 1);
    assert.equal(occurrence.reason, "false positive");
    assert.equal(occurrence.expires, "2999-12-31");
    assert.equal(occurrence.created, "2026-11-14");
    assert.deepEqual(w.unmatched.map((e) => e.rule), ["r9"]);
    assert.deepEqual(w.expired.map((e) => e.reason), ["old"]);
    assert.deepEqual(w.stale, []);
    assert.deepEqual(w.refused, []);
    assert.equal(w.problem, undefined);
    for (const f of result.findings) {
      assert.equal(f.waived, true);
      assert.equal(f.waiverSource, "project");
      assert.equal(f.waiverExpires, "2999-12-31");
    }
    // The waivers in force are in the provenance, outside the identity.
    assert.equal(result.provenance.waivers.count, 4);
    assert.match(result.provenance.waivers.sha256, /^sha256:[0-9a-f]{64}$/);
    const onDisk = JSON.parse(fs.readFileSync(path.join(result.runDir, "result.json"), "utf8"));
    assert.deepEqual(onDisk.waivers, w);
    assert.ok(validateResult(onDisk), JSON.stringify(validateResult.errors));

    // A result written before these fields existed still validates and compares.
    const old = structuredClone(onDisk);
    delete old.waivers;
    delete old.provenance.waivers;
    for (const f of old.findings) {
      delete f.anchor;
      delete f.waiverSource;
      delete f.waiverExpires;
    }
    assert.ok(validateResult(old), JSON.stringify(validateResult.errors));
    assert.equal(results.compareWithPrevious(onDisk, old).waiversChanged, false);
    // Different waivers in force between two validations: the comparison says so.
    assert.equal(results.compareWithPrevious(onDisk, first).waiversChanged, true);
    assert.ok(results.compareWithPrevious(onDisk, first).changed.includes("waivers"));
    assert.equal(results.compareWithPrevious(onDisk, onDisk).waiversChanged, false);
  } finally {
    rm(ws, home);
  }
});

test("waivers: an unreadable .jgates/waivers.json is reported in waivers.problem and the findings stay active", async () => {
  const ws = tmp("jg-res-ws-");
  const home = tmp("jg-res-home-");
  try {
    writeFiles(ws, { ".jgates/waivers.json": "{ not json", "k.ts": "x\n" });
    const blocking = finding({ ruleId: "r1", blocking: true, blockingReason: "blocking-category", location: { path: "k.ts", line: 1 } });
    const result = await doRun(ws, home, { findings: [blocking], blockingViolations: 1 });
    assert.equal(result.waivers.problem.file, ".jgates/waivers.json");
    assert.ok(result.waivers.problem.message.length > 0);
    assert.equal(result.findings[0].waived, false);
    assert.equal(result.decision, "failed");
    assert.ok(validateResult(result), JSON.stringify(validateResult.errors));
    // Same with --waiver given: the file's problem is still reported, and the flag still applies.
    const flag = results.parseWaiverFlag("rule=r1;reason=ad hoc").waiver;
    const withFlag = await doRun(ws, home, { findings: [blocking], blockingViolations: 1, waivers: results.combineWaivers([], [flag]) });
    assert.equal(withFlag.waivers.problem.file, ".jgates/waivers.json");
    assert.equal(withFlag.findings[0].waiverSource, "flag");
  } finally {
    rm(ws, home);
  }
});

test("waivers: a governed run marks what the pinned policy waived with waiverSource policy and never reads the project's file", async () => {
  const ws = tmp("jg-res-ws-");
  const home = tmp("jg-res-home-");
  try {
    writeFiles(ws, { ".jgates/waivers.json": "{ not json", "k.ts": "x\n" });
    const policy = { sha256: "a".repeat(64), files: [], source: { dir: ws, from: "option" }, qualityPolicy: { file: null, sha256: "b".repeat(64) } };
    const result = await doRun(ws, home, {
      findings: [finding({ ruleId: "r1", location: { path: "k.ts", line: 1 } })],
      waivers: [{ rule: "r1", reason: "approved by the policy" }],
      policy,
    });
    assert.equal(result.findings[0].waived, true);
    assert.equal(result.findings[0].waiverSource, "policy");
    assert.deepEqual(result.waivers.applied.map((e) => e.source), ["policy"]);
    assert.equal(result.waivers.problem, undefined, "the project's file is not read by a governed run");
    assert.ok(validateResult(result), JSON.stringify(validateResult.errors));
  } finally {
    rm(ws, home);
  }
});

test("waivers: an occurrence waiver without anchor keeps the count guard; an anchored one goes stale when its line changes", () => {
  const secret = (line) => finding({ tool: "gitleaks", ruleId: "generic-api-key", category: "secrets", location: { path: "conf.py", line } });
  const two = results.finalizeFindings({ findings: [secret(2), secret(5)], stages: [] }, [], NOW);
  const entry = results.occurrenceWaiver(two, two.findings[1], { reason: "test key", expires: "2999-12-31", created: "2026-11-14" });
  assert.equal(entry.anchor, undefined);
  assert.equal(entry.occurrences, 2);
  const same = results.classifyWaivers(two, [entry], NOW)[0];
  assert.deepEqual([same.state, same.matched], ["live", 1]);
  const three = results.finalizeFindings({ findings: [secret(2), secret(5), secret(9)], stages: [] }, [entry], NOW);
  assert.deepEqual(three.findings.map((f) => f.waived), [false, false, false]);
  assert.deepEqual(three.waivers.stale.map((e) => e.cause), ["count-changed"]);

  const lines = { 1: "a = 1", 2: "b = 2" };
  const lineOf = (_p, n) => lines[n] ?? null;
  const first = results.finalizeFindings({ findings: [lint(1), lint(2)], stages: [] }, [], NOW, { lineOf });
  const anchored = results.occurrenceWaiver(first, first.findings[1], { reason: "fp", expires: "2999-12-31", created: "2026-11-14" });
  lines[2] = "b = 3";
  const changed = results.finalizeFindings({ findings: [lint(1), lint(2)], stages: [] }, [anchored], NOW, { lineOf });
  assert.deepEqual(changed.findings.map((f) => f.waived), [false, false]);
  assert.deepEqual(changed.waivers.stale.map((e) => e.cause), ["line-changed"]);
});
