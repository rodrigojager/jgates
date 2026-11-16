import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-89: the ASVS 5.0.0 data and the mapping pack, with no engine.
//   - the data file is the release file (hash), with 345 requirements, 17 chapters, 80 sections and 70 / 253 / 345 rows
//     at levels 1, 2 and 3;
//   - the folder has the license, the notice and a record that passes `jgates tools distribution`; THIRD_PARTY_NOTICES.md
//     names the folder, the commit and CC BY-SA 4.0;
//   - the mapping has exactly one entry per requirement; an entry with checks is reviewed (none is left pending);
//   - an entry naming an unknown rule, capability or attack class is refused; a `pending` entry counts for nothing;
//   - no mapping string repeats a requirement's text; every pack rule is mapped or listed as unmapped with a reason.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const VENDOR = path.join(root, "jgates", "vendor");
const DATA_DIR = path.join(VENDOR, "owasp-asvs");
const DATA_FILE = path.join(DATA_DIR, "5.0.0", "OWASP_Application_Security_Verification_Standard_5.0.0_en.flat.json");
const MAP_ROOT = path.join(root, "jgates", "packs", "asvs");
const asvs = await import(pathToFileURL(path.join(dist, "core", "coverage", "asvs", "index.js")).href);

const data = asvs.loadAsvs("5.0.0");
const context = asvs.buildMappingContext();
const mapping = () => structuredClone(asvs.loadMapping("5.0.0"));
const [ruleId, ruleSubdimension] = [...context.rules.entries()][0];
const entryWith = (m, id, status, check) => {
  const e = m.entries.find((x) => x.requirement === id);
  Object.assign(e, { status, evidence: "repository", subdimensions: [ruleSubdimension], checks: [check], why: "It bears on the requirement for a reason of its own." });
  return m;
};
const rule = (over = {}) => ({ unit: "semgrep-rule", id: ruleId, covers: "a construct the rule matches", misses: "what it does not model", depth: "partial", ...over });
/** The rule ids the entries of a mapping name. */
const namedRules = (m) => new Set(m.entries.flatMap((e) => e.checks.filter((c) => c.unit === "semgrep-rule").map((c) => c.id)));
/** The mapping without any check naming the rule (an entry left without a check goes back to unmapped). */
const withoutRule = (m, id) => {
  for (const e of m.entries) {
    const before = e.checks.length;
    e.checks = e.checks.filter((c) => !(c.unit === "semgrep-rule" && c.id === id));
    // Only an entry that lost its last check goes back to unmapped (a reviewed entry with `applies` and no check stays).
    if (before > 0 && e.checks.length === 0 && e.status !== "unmapped") {
      e.status = "unmapped";
      delete e.why;
      delete e.review;
    }
  }
  return m;
};

test("V2-89: the data file is the release file, with 17 chapters, 80 sections, 345 requirements and 70, 253 and 345 rows at levels 1, 2 and 3", () => {
  const bytes = fs.readFileSync(DATA_FILE);
  const text = bytes.includes(0) ? bytes : Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  assert.equal(crypto.createHash("sha256").update(text).digest("hex"), "8201b20eec2908c3380ac600c91c8ba746346fbb808859366abb232027532311");
  assert.equal(data.chapters.length, 17);
  assert.equal(data.chapters.reduce((n, c) => n + c.sections.length, 0), 80);
  assert.equal(data.requirements.length, 345);
  assert.deepEqual(asvs.asvsLevelCounts(data), { 1: 70, 2: 253, 3: 345 });
  assert.deepEqual(asvs.listAsvsVersions(), ["5.0.0"]);
});

test("V2-89: the folder has its license, notice and record, passes `jgates tools distribution`, and THIRD_PARTY_NOTICES.md names it", () => {
  for (const f of ["LICENSE", "NOTICE.md", "jgates-pack.json"]) assert.ok(fs.existsSync(path.join(DATA_DIR, f)), `${f} exists`);
  const record = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "jgates-pack.json"), "utf8"));
  assert.equal(record.spdx, "CC-BY-SA-4.0");
  assert.equal(record.modifications, "None: the file is the upstream release file, unchanged.");
  const run = spawnSync(process.execPath, [MAIN, "tools", "distribution", "--packs", `${VENDOR},${MAP_ROOT}`, "--json"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const report = JSON.parse(run.stdout).report;
  assert.deepEqual(report.problems, []);
  const ids = report.packs.map((p) => p.id);
  assert.ok(ids.includes("owasp-asvs") && ids.includes("jgates-asvs-map"), `both folders are checked: ${ids.join(", ")}`);
  const notices = fs.readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.ok(notices.includes("`jgates/vendor/owasp-asvs`"));
  assert.match(notices, /5cf9b032440be53ce345ab3c130fda46ba1ce7a2/);
  assert.match(notices, /CC BY-SA 4\.0|CC-BY-SA-4\.0/);
});

test("V2-89: the mapping has exactly one entry per requirement, and every entry that names a check is reviewed", () => {
  const m = mapping();
  assert.equal(m.files.length, 17);
  assert.deepEqual(m.entries.map((e) => e.requirement).sort(), data.requirements.map((r) => r.id).sort());
  for (const e of m.entries) {
    if (e.checks.length === 0) {
      // No check: unmapped, or a reviewed entry that only says which projects the requirement concerns (`applies`).
      assert.ok(e.status === "unmapped" || ((e.status === "reviewed" || e.status === "owner-reviewed") && e.applies), `${e.requirement} has no check, so it is unmapped or a reviewed entry with applies`);
    } else {
      assert.ok(e.status === "reviewed" || e.status === "owner-reviewed", `${e.requirement} is ${e.status}: no entry that names a check is left pending`);
      assert.ok(e.review && /^\d{4}-\d{2}-\d{2}$/.test(e.review.date) && e.review.by.trim() !== "", `${e.requirement} records its review`);
    }
  }
  assert.ok(m.entries.some((e) => e.checks.length > 0), "the mapping names checks");
  assert.deepEqual(asvs.validateMapping(m, data, context), []);
});

test("V2-89: an entry naming an unknown rule, capability or attack class is refused", () => {
  // V1.5.3: no rule states it and no entry names the rule of the fixture beyond it, so replacing its entry unnames nothing.
  const problems = (check) => asvs.validateMapping(entryWith(mapping(), "V1.5.3", "pending", check), data, context).join("\n");
  assert.deepEqual(asvs.validateMapping(entryWith(mapping(), "V1.5.3", "pending", rule()), data, context), []);
  assert.match(problems(rule({ id: "jgates.python.no-such-rule" })), /unknown rule/);
  assert.match(problems(rule({ unit: "capability", id: "nothing#nowhere" })), /unknown capability/);
  assert.match(problems(rule({ unit: "semantic-ledger", id: "ATTACK-CLASSES.md#No such class" })), /unknown attack class/);
});

test("V2-89: a pending entry counts for nothing", () => {
  const pending = entryWith(mapping(), "V1.5.3", "pending", rule()).entries.find((e) => e.requirement === "V1.5.3");
  assert.deepEqual(asvs.countedChecks(pending), []);
  assert.equal(asvs.countedChecks({ ...pending, status: "reviewed" }).length, 1);
});

test("V2-89: no mapping string repeats a requirement's text, and every pack rule is mapped or listed as unmapped with a reason", () => {
  const texts = data.requirements.map((r) => r.text);
  const m = mapping();
  const strings = m.entries.flatMap((e) => [e.why ?? "", ...e.checks.flatMap((c) => [c.covers, c.misses])]).concat(m.unmappedRules.rules.map((r) => r.reason));
  for (const s of strings) assert.equal(asvs.repeatsRequirementText(s, texts), false);
  const quoted = entryWith(mapping(), "V1.2.4", "pending", rule({ covers: data.requirements.find((r) => r.id === "V1.2.4").text }));
  assert.match(asvs.validateMapping(quoted, data, context).join("\n"), /repeats a requirement text/);
  // unmapped-rules.json lists exactly the pack rules no entry names, each with its reason.
  const named = namedRules(m);
  // A whole-rule entry (no `requirement`) lists a rule no entry names; a per-pair refusal does not make the rule unmapped.
  const listed = new Set(m.unmappedRules.rules.filter((r) => !r.requirement).map((r) => r.id));
  for (const id of context.rules.keys()) assert.ok(named.has(id) !== listed.has(id), `${id} is either named by an entry or listed, not both and not neither`);
  for (const r of m.unmappedRules.rules) assert.ok(r.reason.trim() !== "", `${r.id} has a reason`);
  // A rule that loses its last entry and is not listed is refused.
  const forgotten = withoutRule(mapping(), ruleId);
  assert.match(asvs.validateMapping(forgotten, data, context).join("\n"), /neither mapped nor listed/);
  forgotten.unmappedRules.rules.push({ id: ruleId, reason: "No requirement names it." });
  assert.equal(asvs.validateMapping(forgotten, data, context).some((p) => p.includes("neither mapped nor listed")), false);
});
