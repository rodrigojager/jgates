import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// Findings that do not block (informational), everywhere but the screens: the summary, the text of a report, SARIF, the
// baseline comparison, the waivers; and the requirement ids a finding of a bundled-pack rule carries.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const results = await load("core", "results", "index.js");
const waiverFile = await load("core", "waiver-file", "index.js");
const semgrep = await load("adapters", "semgrep", "index.js");
const { translator } = await load("i18n", "index.js");

const packDir = semgrep.bundledPackRulesDir("jgates");
const index = semgrep.packRuleIndex(packDir);
const BLOCKING_RULE = index.rules.find((r) => r.id === "jgates.python.weak-hash");
const INFORMATIONAL_RULE = index.rules.find((r) => r.id === "jgates.python.weak-cipher");
assert.ok(BLOCKING_RULE && INFORMATIONAL_RULE && BLOCKING_RULE.asvsRequirements.length > 0 && INFORMATIONAL_RULE.asvsRequirements.length > 0, "the pack rules the test reads exist and carry requirement ids");
const packRules = new Map(index.rules.filter((r) => r.signal === null).map((r) => [r.id, r.asvsRequirements]));

/** A recorded `semgrep scan --json` output: one result per [rule id as Semgrep prints it, native severity, line]. */
function recorded(entries) {
  return JSON.stringify({
    results: entries.map(([checkId, severity, line]) => ({ check_id: checkId, path: "src/app.py", start: { line, col: 1 }, end: { line, col: 9 }, extra: { message: "a message", severity } })),
    errors: [],
    paths: { scanned: ["src/app.py"] },
  });
}
const PREFIX = "tmp.run.rules.";
const parse = (entries) => semgrep.parseSemgrepOutput(recorded(entries), { stageId: "semgrep", version: "1.0.0", workspace: "/w", cwd: "/w", packRules });

const ENTRIES = [
  [PREFIX + BLOCKING_RULE.id, "ERROR", 3],
  [PREFIX + INFORMATIONAL_RULE.id, "INFO", 8],
];

const finding = (extra = {}) => ({ stageId: "s", tool: "semgrep", ruleId: "r.x", severity: "ERROR", normalizedSeverity: "high", message: "m", location: { path: "src/app.py", line: 1 }, blocking: true, waived: false, ...extra });
const info = (extra = {}) => finding({ severity: "INFO", normalizedSeverity: "low", blocking: false, informational: true, ...extra });

const result = (findings, decision) => ({
  runId: "run_x",
  version: "test",
  decision,
  complete: true,
  reduced: false,
  disabled: [],
  unsatisfied: [],
  blockingViolations: findings.filter((f) => f.blocking).length,
  findings,
});
const en = translator("run", "en");
const pt = translator("run", "pt-BR");

test("a recorded output with a blocking and an informational pack finding: only the first blocks", () => {
  const parsed = parse(ENTRIES);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.findings.map((f) => f.blocking), [true, false]);
  assert.equal(parsed.findings.filter((f) => f.blocking).length, 1);
  assert.equal(results.informationalCount({ findings: parsed.findings }), 1);
});

test("a finding of a pack rule carries its requirement ids; a finding of any other rule does not", () => {
  const parsed = parse([...ENTRIES, ["custom.rules.own-rule", "ERROR", 12], ["jgates.python.not-in-the-pack", "ERROR", 14]]);
  const byRule = (needle) => parsed.findings.find((f) => f.ruleId.endsWith(needle));
  assert.deepEqual(byRule(BLOCKING_RULE.id).asvsRequirements, BLOCKING_RULE.asvsRequirements);
  assert.deepEqual(byRule(INFORMATIONAL_RULE.id).asvsRequirements, INFORMATIONAL_RULE.asvsRequirements);
  assert.equal("asvsRequirements" in byRule("own-rule"), false);
  assert.equal("asvsRequirements" in byRule("not-in-the-pack"), false);
  // Without the bundled pack in the run no finding carries them.
  const bare = semgrep.parseSemgrepOutput(recorded(ENTRIES), { stageId: "semgrep", version: null, workspace: "/w", cwd: "/w" });
  assert.ok(bare.findings.every((f) => !("asvsRequirements" in f)));
});

test("the summary counts only the blocking findings and adds 'and N informational'", () => {
  const failed = result([finding(), info()], "failed");
  assert.equal(results.resultSummary(failed, en), "failed: 1 blocking violation and 1 informational");
  assert.equal(results.resultSummary(failed, pt), "reprovado: 1 violação bloqueante e 1 informativo");

  const approved = result([info()], "passed");
  assert.equal(results.resultSummary(approved, en), "approved and 1 informational");
  assert.equal(results.resultSummary(approved, pt), "aprovado e 1 informativo");
  assert.equal(results.resultSummary(result([info(), info({ location: { path: "b.py", line: 2 } })], "passed"), pt), "aprovado e 2 informativos");

  // An approval with nothing informational reads as before.
  assert.equal(results.resultSummary(result([], "passed"), en), "approved");
  // A waived finding is not informational: it blocked before the waiver.
  assert.equal(results.resultSummary(result([finding({ blocking: false, waived: true })], "passed"), en).includes("informational"), false);
});

test("the text lists the informational findings after the blocking ones under their own heading, with the requirement label", () => {
  for (const [t, heading] of [
    [en, "Informational findings"],
    [pt, "Achados informativos"],
  ]) {
    const lines = results.findingLines(
      result([info({ ruleId: "r.info", fingerprint: "jgf1:aaaaaaaaaaaaaaaa", asvsRequirements: ["V3.3.1", "V3.3.2"] }), finding({ ruleId: "r.block", fingerprint: "jgf1:bbbbbbbbbbbbbbbb", asvsRequirements: ["V11.4.1"] })], "failed"),
      t,
    );
    const blockAt = lines.findIndex((l) => l.includes("r.block"));
    const headingAt = lines.findIndex((l) => l.startsWith(heading));
    const infoAt = lines.findIndex((l) => l.includes("r.info"));
    assert.ok(blockAt > 0 && headingAt > blockAt && infoAt > headingAt, `blocking, then the heading, then the informational finding: ${JSON.stringify(lines)}`);
    assert.ok(lines[blockAt].includes("ASVS V11.4.1"));
    assert.ok(lines[infoAt].includes("ASVS V3.3.1, V3.3.2"));
    assert.equal(lines.some((l) => /compl|conform|certif|met\b|cumpr/i.test(l)), false, "the label never says a requirement is or is not met");
  }
  // Only informational findings: no waiver hint.
  const only = results.findingLines(result([info({ fingerprint: "jgf1:cccccccccccccccc" })], "passed"), en);
  assert.equal(only.some((l) => l.includes("waivers add")), false);
  assert.ok(only[0].startsWith("Informational findings"));
});

test("SARIF marks an informational finding as a note and keeps the level of the blocking ones", () => {
  const doc = results.toSarif(result([finding({ ruleId: "r.high" }), finding({ ruleId: "r.medium", severity: "WARNING", normalizedSeverity: "medium" }), info({ ruleId: "r.info" })], "failed"));
  const levelOf = (rule) => doc.runs[0].results.find((r) => r.ruleId.endsWith(rule)).level;
  assert.equal(levelOf("r.high"), "error");
  assert.equal(levelOf("r.medium"), "warning");
  assert.equal(levelOf("r.info"), "note");
});

test("the baseline comparison counts informational findings apart from blocking ones", () => {
  const withPrints = (list) => results.assignFingerprints(list);
  const at = (line, extra = {}) => ({ location: { path: "src/app.py", line }, ...extra });
  const before = withPrints([finding(at(1, { ruleId: "r.b" })), finding(at(2, { ruleId: "r.b" })), info(at(3, { ruleId: "r.i" })), info(at(4, { ruleId: "r.i" }))]);
  const after = withPrints([finding(at(1, { ruleId: "r.b" })), finding(at(9, { ruleId: "r.b2" })), info(at(3, { ruleId: "r.i" })), info(at(7, { ruleId: "r.i2" })), info(at(8, { ruleId: "r.i2" }))]);
  const cmp = results.compareWithBaseline({ runId: "run_base", findings: before, provenance: {}, selection: { scope: "workspace" }, reduced: false }, { findings: after, provenance: {}, selection: { scope: "workspace" }, reduced: false });
  assert.deepEqual([cmp.new, cmp.kept], [1, 1], "blocking: one new, one kept");
  assert.deepEqual([cmp.newInformational, cmp.keptInformational, cmp.resolvedInformational], [2, 1, 1], "informational: two new, one kept, one resolved");
  assert.equal(cmp.resolved.length, 2, "the resolved list holds both sides");
});

test("a waiver is refused on an informational finding and never applied to one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jg-informational-"));
  try {
    const [blocking, informational] = results.assignFingerprints([finding({ ruleId: "r.block", location: { path: "a.py", line: 1 } }), info({ ruleId: "r.info", location: { path: "b.py", line: 2 } })]);
    const request = (f) => ({ result: { findings: [blocking, informational] }, findings: [f.fingerprint], until: "2099-01-01", reason: "reviewed by the team", now: new Date("2026-11-14T12:00:00Z") });
    const refused = waiverFile.prepareAdd(dir, request(informational));
    assert.equal(refused.code, "WAIVER_FINDING_INFORMATIONAL");
    assert.equal(fs.existsSync(path.join(dir, ".jgates", "waivers.json")), false, "nothing was written");
    assert.equal("code" in waiverFile.prepareAdd(dir, request(blocking)), false, "a blocking finding can still be waived");

    // A hand-written waiver that names the informational finding applies to nothing.
    const applied = results.applyWaivers([informational], [], [{ rule: "r.info", path: "b.py", reason: "by hand", expires: "2099-01-01" }], new Date("2026-11-14T12:00:00Z"));
    assert.equal(applied.findings[0].waived, false);
    assert.equal(applied.record.count, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("the refusal reads in both languages", () => {
  for (const [locale, needle] of [
    ["en", "informational"],
    ["pt-BR", "informativo"],
  ]) {
    const t = translator("waivers", locale);
    assert.ok(t("waivers_refused_waiver_finding_informational", { rule: "r.info" }).includes(needle));
    assert.notEqual(t("waivers_refused_waiver_finding_informational_fix"), "waivers_refused_waiver_finding_informational_fix");
  }
});
