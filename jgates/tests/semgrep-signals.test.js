import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// The signals of the Semgrep stage (PLAN-product-changes.md section 8): the results of the pack's signal rules
// (`jgates.<prefix>.uses-<tag>`, metadata `signal: <tag>`) are a record of the scan, tag to number of matches, beside the
// scanned-languages record, and never findings. Read from a stored Semgrep output with no engine.

const here = path.dirname(fileURLToPath(import.meta.url));
const JGATES = path.resolve(here, "..");
const dist = path.join(JGATES, "dist");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const semgrep = await import(pathToFileURL(path.join(dist, "adapters", "semgrep", "index.js")).href);

const RULES = path.join(JGATES, "packs", "semgrep", "jgates-semgrep", "rules");
const index = semgrep.buildPackIndex(RULES);
const signalRules = index.rules.filter((r) => r.signal !== null);
const checkRules = index.rules.filter((r) => r.signal === null);
const packSignals = new Map(signalRules.map((r) => [r.id, r.signal]));
const packRules = new Map(checkRules.map((r) => [r.id, r.asvsRequirements]));
const graphql = signalRules.find((r) => r.signal === "graphql" && r.language === "javascript");
const jwt = signalRules.find((r) => r.signal === "jwt");
const check = checkRules.find((r) => r.language === "javascript" && r.severity === "ERROR") ?? checkRules[0];

const result = (ruleId, file, severity = "INFO") => ({ check_id: ruleId, path: file, start: { line: 2, col: 1 }, end: { line: 2, col: 9 }, extra: { message: "m", severity, metadata: {} } });
const output = (results) => JSON.stringify({ results, errors: [], paths: { scanned: ["src/a.js", "src/b.ts"] } });
const parse = (results, extra = {}) => semgrep.parseSemgrepOutput(output(results), { stageId: "semgrep#sast", version: "1.182.1", workspace: "/workspace", cwd: "/workspace", packRules, packSignals, ...extra });

test("the pack has signal rules, and every one carries a tag of the closed list", () => {
  assert.ok(graphql && jwt && check, "a JavaScript graphql signal, a jwt signal and a check rule");
  for (const r of signalRules) assert.ok(semgrep.PACK_LISTS.signalTags.includes(r.signal), `${r.id}: ${r.signal}`);
  assert.ok(index.signals.some((s) => s.language === "javascript" && s.tag === "graphql"), "the index records the (language, tag) pair");
});

test("results of signal rules are counted in the signals record and never become findings", () => {
  const parsed = parse([result(graphql.id, "src/a.js"), result(graphql.id, "src/b.ts"), result(jwt.id, "src/a.js"), result(check.id, "src/a.js", check.severity)]);
  assert.equal(parsed.ok, true, parsed.problem);
  assert.deepEqual(parsed.findings.map((f) => f.ruleId), [check.id], "only the check rule is a finding");
  assert.equal(parsed.signals.graphql, 2);
  assert.equal(parsed.signals.jwt, 1);
  // Every tag of a signal rule of the pack is in the record, 0 when nothing matched.
  const tags = [...new Set(signalRules.map((r) => r.signal))].sort();
  assert.deepEqual(Object.keys(parsed.signals).sort(), tags);
  for (const tag of tags.filter((x) => x !== "graphql" && x !== "jwt")) assert.equal(parsed.signals[tag], 0, tag);
  assert.equal(parsed.findings.some((f) => f.ruleId.includes(".uses-")), false);
});

test("a rule id prefixed with the folders of the rule file is still recognized as a signal", () => {
  const parsed = parse([result(`tmp.rules.${graphql.id}`, "src/a.js")]);
  assert.deepEqual(parsed.findings, []);
  assert.equal(parsed.signals.graphql, 1);
});

test("without the bundled pack there is no signals record, and a signal-looking rule of another config stays a finding", () => {
  const parsed = semgrep.parseSemgrepOutput(output([result(graphql.id, "src/a.js")]), { stageId: "semgrep#sast", version: null, workspace: "/workspace", cwd: "/workspace" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.signals, null);
  assert.equal(parsed.findings.length, 1, "with no pack in the run, nothing is moved out of the findings");
});

test("an empty scan with the pack records every tag at 0", () => {
  const parsed = parse([]);
  assert.deepEqual(parsed.findings, []);
  assert.ok(Object.values(parsed.signals).every((n) => n === 0));
});

test("the result schema takes the signals record of a stage beside the scanned-languages record", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const schema = JSON.parse(fs.readFileSync(path.join(JGATES, "schemas", "result", "result.schema.json"), "utf8"));
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/stage`);
  assert.ok(validate, "the stage definition of the result schema");
  const stage = { id: "semgrep#sast", state: "completed", interpreted: true, scannedLanguages: { javascript: 1, typescript: 1 }, signals: { graphql: 0, jwt: 2 } };
  assert.ok(validate(stage), ajv.errorsText(validate.errors));
  assert.ok(!validate({ ...stage, signals: { graphql: -1 } }), "a count is a non-negative integer");
  assert.ok(!validate({ ...stage, signals: { graphql: "none" } }));
});
