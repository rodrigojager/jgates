import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const schemaFile = path.resolve(here, "..", "..", "quality-gate", "schemas", "bridge-response.schema.json");
const Ajv2020 = require("ajv/dist/2020").default;

function compile() {
  // Full strict mode: no option turned off.
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  return ajv.compile(JSON.parse(fs.readFileSync(schemaFile, "utf8")));
}

const report = { schemaVersion: "1.0.0", status: "APPROVED", exitCode: 0, mode: "quick", tools: [], findings: [] };
const success = { schemaVersion: 1, ok: true, status: "APPROVED", exitCode: 0, subchecks: [], report, reportPath: "/o/r.json", outputDir: "/o" };
const failure = { schemaVersion: 1, ok: false, status: "ERROR", exitCode: 3, subchecks: [], error: { code: "target-missing", message: "x" } };

test("bridge response schema compiles in full Ajv strict mode", () => {
  assert.equal(typeof compile(), "function");
});

test("success and error responses stay valid", () => {
  const validate = compile();
  assert.equal(validate(success), true, JSON.stringify(validate.errors));
  assert.equal(validate(failure), true, JSON.stringify(validate.errors));
});

test("a success response without report is invalid", () => {
  const validate = compile();
  const { report: _r, ...noReport } = success;
  assert.equal(validate(noReport), false);
  const { reportPath: _p, ...noPath } = success;
  assert.equal(validate(noPath), false);
});

test("an error response without error is invalid", () => {
  const validate = compile();
  const { error: _e, ...noError } = failure;
  assert.equal(validate(noError), false);
});
