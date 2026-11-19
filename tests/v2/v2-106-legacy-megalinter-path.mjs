import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertGovernedLinters } from "./fixtures/governed-linters.mjs";

// V2-106 (no engine): the legacy MegaLinter path told as it is. The tools image has no MegaLinter, so the bridge's
// `megalinter` subcheck is superseded by the descriptor tools: it is switched off with a reason when a linter tool
// answers for it and also when none applies (it never runs, so it never shows as "tool not available"). The other
// bridge subchecks keep their own rules.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "jgates", "dist", ...p)).href;
const { supersededPairs, duplicateScanners, SUPERSEDING_ADAPTERS } = await import(dist("adapters", "quality-bridge", "superseded.js"));
const { withLocale } = await import(dist("i18n", "index.js"));

const pair = { subcheck: "megalinter", capability: "lint" };

test("a linter tool that answers for MegaLinter supersedes the subcheck and is named", () => {
  assert.ok(SUPERSEDING_ADAPTERS.megalinter.includes("hadolint"));
  const out = supersededPairs([pair], [{ tool: "hadolint", adapter: "hadolint", capability: "lint" }]);
  const s = out.get("megalinter#lint");
  assert.deepEqual(s.by, ["hadolint#lint"]);
  assert.equal(s.reason.code, "SUPERSEDED");
});

test("with no linter tool in the plan the subcheck is still off, never run and never missing", () => {
  const out = withLocale("en", () => supersededPairs([pair], []));
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

test("V2-106 (fake engine): governed descriptor tools report findings, suppressions, and network exclusions", (t) => {
  assertGovernedLinters(t);
});
