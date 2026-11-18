import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-106 (no engine): the legacy MegaLinter path told as it is. The tools image has no MegaLinter, so the bridge's
// `megalinter` subcheck is superseded by the descriptor tools: it is switched off with a reason when a linter tool
// answers for it and also when none applies (it never runs, so it never shows as "tool not available"). The other
// bridge subchecks keep their own rules. The plan-level cases of `jgates ci` (self-reported tools, network refusal,
// suppressions) are covered by the governed tests; the real-engine runs are in the G7 report.
process.env.JGATES_LOCALE = "en";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "jgates", "dist", ...p)).href;
const { supersededPairs, duplicateScanners, SUPERSEDING_ADAPTERS } = await import(dist("adapters", "quality-bridge", "superseded.js"));

const pair = { subcheck: "megalinter", capability: "lint" };

test("a linter tool that answers for MegaLinter supersedes the subcheck and is named", () => {
  assert.ok(SUPERSEDING_ADAPTERS.megalinter.includes("hadolint"));
  const out = supersededPairs([pair], [{ tool: "hadolint", adapter: "hadolint", capability: "lint" }]);
  const s = out.get("megalinter#lint");
  assert.deepEqual(s.by, ["hadolint#lint"]);
  assert.equal(s.reason.code, "SUPERSEDED");
});

test("with no linter tool in the plan the subcheck is still off, never run and never missing", () => {
  const out = supersededPairs([pair], []);
  const s = out.get("megalinter#lint");
  assert.ok(s, "the subcheck is superseded");
  assert.deepEqual(s.by, []);
  assert.match(s.reason.message, /no MegaLinter/);
  assert.deepEqual(duplicateScanners(out, []), [], "nothing is reported as running twice");
});

test("the retirement is only for the megalinter subcheck", () => {
  const out = supersededPairs([{ subcheck: "semgrep", capability: "sast" }, { subcheck: "trivy", capability: "iac" }], []);
  assert.equal(out.size, 0);
});
