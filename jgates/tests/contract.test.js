import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const { computeDecision, exitCodeFor, EXIT_CODES } = await import(
  pathToFileURL(path.resolve(here, "..", "dist", "core", "contract", "index.js")).href
);
const schema = JSON.parse(fs.readFileSync(path.resolve(here, "..", "schemas", "result", "result.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

const reqs = [
  { id: "lint", required: true },
  { id: "tests", required: true },
  { id: "extra", required: false },
];
const done = (id, extra = {}) => ({ id, state: "completed", ...extra });
const allDone = () => [done("lint"), done("tests")];

function compute(over = {}) {
  return computeDecision({ resolved: true, requirements: reqs, stages: allDone(), ...over });
}

function asResult(outcome, stages) {
  return {
    schemaVersion: 1,
    runId: "run-1",
    decision: outcome.decision,
    complete: outcome.complete,
    reduced: outcome.reduced,
    exitCode: outcome.exitCode,
    stages,
    unsatisfied: outcome.unsatisfied,
    warnings: outcome.warnings,
    blockingViolations: outcome.blockingViolations,
    disabled: outcome.disabled,
  };
}

test("missing required stage gives incomplete", () => {
  const o = compute({ stages: [done("lint")] });
  assert.equal(o.decision, "incomplete");
  assert.equal(o.complete, false);
  assert.deepEqual(o.unsatisfied, [{ requirementId: "tests", state: "missing" }]);
});

test("error and timeout stages give incomplete", () => {
  for (const state of ["error", "timeout", "blocked", "pending", "running", "cancelled"]) {
    const o = compute({ stages: [done("lint"), { id: "tests", state }] });
    assert.equal(o.decision, "incomplete", state);
  }
});

test("uninterpreted output never passes", () => {
  const o = compute({ stages: [done("lint"), done("tests", { interpreted: false })] });
  assert.equal(o.decision, "incomplete");
});

test("blocking violation with another stage in timeout gives failed with complete false", () => {
  const o = compute({ stages: [done("lint", { blockingViolations: 2 }), { id: "tests", state: "timeout" }] });
  assert.equal(o.decision, "failed");
  assert.equal(o.complete, false);
  assert.equal(o.exitCode, 1);
});

test("everything satisfied gives passed", () => {
  const o = compute();
  assert.equal(o.decision, "passed");
  assert.equal(o.complete, true);
  assert.equal(o.reduced, false);
  assert.equal(o.exitCode, 0);
});

test("not_applicable counts as satisfied; optional error only warns", () => {
  const o = compute({ stages: [done("lint"), { id: "tests", state: "not_applicable" }, { id: "extra", state: "error" }] });
  assert.equal(o.decision, "passed");
  assert.deepEqual(o.warnings, [{ stageId: "extra", state: "error" }]);
});

test("check disabled only in this run passes as reduced with the list", () => {
  const disabled = [{ id: "tests", origin: "run" }];
  const o = compute({ stages: [done("lint"), { id: "tests", state: "disabled" }], disabled });
  assert.equal(o.decision, "passed");
  assert.equal(o.reduced, true);
  assert.deepEqual(o.disabled, disabled);
  assert.equal(o.exitCode, 0);
});

test("check disabled in the profile is not required and not reduced", () => {
  const disabled = [{ id: "tests", origin: "profile" }];
  const o = compute({ stages: [done("lint")], disabled });
  assert.equal(o.decision, "passed");
  assert.equal(o.reduced, false);
  assert.deepEqual(o.disabled, disabled);
});

test("unresolved configuration gives invalid", () => {
  const o = compute({ resolved: false, stages: [] });
  assert.equal(o.decision, "invalid");
  assert.equal(o.exitCode, 3);
});

test("cancelled run gives cancelled", () => {
  const o = compute({ cancelled: true, stages: [done("lint")] });
  assert.equal(o.decision, "cancelled");
  assert.equal(o.exitCode, 130);
});

test("a result with no stages and required requirements is never passed", () => {
  const o = compute({ stages: [] });
  assert.notEqual(o.decision, "passed");
  assert.equal(o.decision, "incomplete");
});

test("exit code mapping", () => {
  assert.equal(exitCodeFor("passed"), 0);
  assert.equal(exitCodeFor("failed"), 1);
  assert.equal(exitCodeFor("incomplete"), 2);
  assert.equal(exitCodeFor("invalid"), 3);
  assert.equal(exitCodeFor("cancelled"), 130);
  assert.equal(EXIT_CODES.internal, 4);
});

test("schema validates a sample of each decision in strict Ajv", () => {
  const samples = [
    [compute(), allDone()],
    [compute({ stages: [done("lint", { blockingViolations: 1 }), { id: "tests", state: "timeout" }] }), [done("lint", { blockingViolations: 1 }), { id: "tests", state: "timeout" }]],
    [compute({ stages: [] }), []],
    [compute({ resolved: false, stages: [] }), []],
    [compute({ cancelled: true }), allDone()],
    [
      compute({ stages: [done("lint"), { id: "tests", state: "disabled" }], disabled: [{ id: "tests", origin: "run" }] }),
      [done("lint"), { id: "tests", state: "disabled" }],
    ],
  ];
  const seen = new Set();
  for (const [outcome, stages] of samples) {
    const doc = asResult(outcome, stages);
    assert.ok(validate(doc), JSON.stringify(validate.errors));
    seen.add(doc.decision);
  }
  assert.deepEqual([...seen].sort(), ["cancelled", "failed", "incomplete", "invalid", "passed"]);
});

test("schema rejects inconsistent results", () => {
  const bad = asResult(compute({ stages: [] }), []);
  assert.equal(validate({ ...bad, decision: "passed" }), false);
  assert.equal(validate({ ...bad, extra: 1 }), false);
});
