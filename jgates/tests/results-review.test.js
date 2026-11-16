import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (...parts) => import(pathToFileURL(path.join(root, "dist", ...parts)).href);
const r = await load("core", "results", "index.js");
const wf = await load("core", "waiver-file", "index.js");
const { translator } = await load("i18n", "index.js");
const { suppressionFinding } = await load("core", "governed", "suppressions.js");
const finding = (ruleId, extra = {}) => ({
  stageId: "semgrep", tool: "semgrep", ruleId, severity: "WARNING", normalizedSeverity: "medium",
  message: "Check the protection", location: { path: "app.py", line: 1 }, blocking: true, waived: false, ...extra,
});
const review = (ruleId = "r.review", extra = {}) => finding(ruleId, { review: true, blocking: false, ...extra });
const info = () => finding("r.info", { informational: true, blocking: false });
const result = (findings, decision = "passed") => ({
  runId: "run_review", version: "test", findings, decision, complete: true, reduced: false,
  disabled: [], unsatisfied: [], blockingViolations: findings.filter((f) => f.blocking).length,
});
const now = new Date("2026-11-16T12:00:00Z");

test("Review has its own open count, three-kind summaries and requirement-bearing text in both languages", () => {
  const findings = [info(), review("r.first", { asvsRequirements: ["V3.3.1"] }), review("r.second")];
  assert.equal(r.reviewCount(result(findings)), 2);
  assert.equal(r.informationalCount(result(findings)), 1);
  assert.equal(r.isReview(review("r.invalid", { blocking: true })), false);
  assert.equal(r.isReview(review("r.done", { waived: true })), false);
  for (const [locale, summary, heading, infoHeading] of [
    ["en", "approved and 1 informational and 2 to review", "To review", "Informational findings"],
    ["pt-BR", "aprovado e 1 informativo e 2 para revisar", "Para revisar", "Achados informativos"],
  ]) {
    const t = translator("run", locale);
    assert.equal(r.resultSummary(result(findings), t), summary);
    assert.match(r.resultSummary(result([finding("r.block"), ...findings], "failed"), t), /1 .*1 .*2 /);
    const lines = r.findingLines(result(findings), t);
    const at = lines.findIndex((line) => line.startsWith(heading));
    assert.ok(at > lines.findIndex((line) => line.startsWith(infoHeading)));
    assert.match(lines[at + 1], /r.first.*ASVS V3\.3\.1/);
    assert.equal(lines.filter((line) => line.includes("r.first")).length, 1);
  }
});

test("SARIF preserves Review's kind as a note even after it is marked as reviewed", () => {
  const doc = r.toSarif(result([review(), review("r.done", { waived: true })]));
  assert.ok(doc.runs[0].results.every((f) => f.level === "note" && f.properties.review === true && !f.properties.informational));
});

test("baseline new, kept and resolved Review counts never leak into blocking or informational counts", () => {
  const before = r.assignFingerprints([finding("r.block"), info(), review("r.kept"), review("r.resolved")]);
  const after = r.assignFingerprints([finding("r.block"), info(), review("r.kept"), review("r.new"), review("r.new2"), review("r.done", { waived: true })]);
  const cmp = r.compareWithBaseline(result(before), result(after));
  assert.deepEqual([cmp.new, cmp.kept], [0, 1]);
  assert.deepEqual([cmp.newInformational, cmp.keptInformational, cmp.resolvedInformational], [0, 1, 0]);
  assert.deepEqual([cmp.newReview, cmp.keptReview, cmp.resolvedReview], [2, 1, 1]);
});

test("per-occurrence marks accept Review, refuse INFO, preserve plain approval, and can be refused or go stale", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jg-review-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const initial = r.finalizeFindings({ findings: [review(), info()], stages: [] }, [], now, { lineOf: () => "original line" });
  const request = (f) => ({ result: initial, findings: [f.fingerprint], reason: "Protection checked by the team", until: "2099-01-01", now });
  assert.equal(wf.prepareAdd(dir, request(initial.findings[1])).code, "WAIVER_FINDING_INFORMATIONAL");
  const prepared = wf.prepareAdd(dir, request(initial.findings[0]));
  assert.equal(prepared.ok, true);
  assert.equal(wf.commitChange(prepared).ok, true);
  const waivers = r.loadWaiverFile(path.join(dir, ".jgates", "waivers.json")).waivers;
  const applied = r.finalizeFindings({ findings: initial.findings, stages: [] }, waivers, now, { lineOf: () => "original line" });
  const approved = { ...result(applied.findings), waivers: applied.waivers };
  assert.equal(r.reviewCount(approved), 0);
  assert.deepEqual([applied.waivers.count, applied.waivers.findings, applied.waivers.applied[0].reviewed], [0, 0, 1]);
  assert.equal(r.approvalWording(approved).kind, "plain");
  assert.equal(r.approvalWording(result(applied.findings)).kind, "plain", "old results without the record also stay plain");
  assert.match(r.waiverLines(approved, {}, translator("run", "en")).join("\n"), /reviewed/);
  assert.match(r.waiverLines(approved, {}, translator("run", "pt-BR")).join("\n"), /revisado/);
  assert.equal(wf.listWaivers(wf.readWaiverFile(dir), applied, "run_review", now).waivers[0].reviewed, 1);
  const refused = r.finalizeFindings({ findings: initial.findings, stages: [] }, waivers, now, { refuse: true, lineOf: () => "original line" });
  assert.equal(r.reviewCount(refused), 1);
  assert.equal(refused.waivers.refused.length, 1);
  const stale = r.finalizeFindings({ findings: initial.findings, stages: [] }, waivers, now, { lineOf: () => "changed line" });
  assert.equal(r.reviewCount(stale), 1);
  assert.equal(stale.waivers.stale.length, 1);
  const expired = r.finalizeFindings({ findings: initial.findings, stages: [] }, waivers, new Date("2100-01-01"), { lineOf: () => "original line" });
  assert.equal(r.reviewCount(expired), 1);
});

test("a broad waiver covering blocking and Review findings words only its blocking side", () => {
  const applied = r.applyWaivers([finding("r.shared"), review("r.shared")], [], [{ rule: "r.shared", reason: "checked" }], now);
  assert.deepEqual([applied.record.count, applied.record.findings, applied.record.applied[0].reviewed], [1, 1, 1]);
  assert.equal(r.approvalWording({ ...result(applied.findings), waivers: applied.record }).kind, "with-waivers");
});

test("governed suppression comments keep their existing policy meaning, never Review", () => {
  for (const status of [{ state: "neutralized", how: "--disable-nosem" }, { state: "honored", by: "scanner", blocking: true }]) {
    const f = suppressionFinding({ kind: "nosem", path: "app.py", line: 1, status });
    assert.equal(f.review, undefined);
    assert.equal(f.blocking, status.state === "honored");
  }
});
