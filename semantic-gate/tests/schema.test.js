import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("semantic result schema fixes semantic gate invariants", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/semantic-result.schema.json", "utf8"));
  assert.equal(schema.properties.gate.const, "semantic");
  assert.equal(schema.properties.deterministicSummaryUsed.const, false);
  assert.deepEqual(schema.properties.status.enum, ["APPROVED", "NEEDS_CHANGES", "REJECTED", "INVALID"]);
  assert.ok(schema.properties.reasonCode.enum.includes("unknown-evidence"));
  assert.deepEqual(schema.properties.findings.items.properties.confirmation.enum, ["confirmed", "needs-validation", "rejected"]);
  assert.deepEqual(schema.then.required, ["reasonCode", "reasons"]);
  assert.deepEqual(schema.properties.scoreAppliesTo.enum, ["changed-files", "entire-project", "selected-paths"]);
  assert.ok(schema.required.includes("scoreAppliesTo"));
  assert.ok(schema.required.includes("findings"));
  assert.ok(schema.required.includes("requiredFixPlan"));
});
