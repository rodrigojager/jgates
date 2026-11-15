import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-98 (fake engine): the map's model (PLAN-product-changes.md sections 4 and 8) through `jgates coverage asvs`, on a
// fixture mapping and stored runs written into the data folder of a throwaway workspace:
//   - a capability check with findingRules counts only the named alerts as its open findings; without the field, all
//     the findings of its stage;
//   - a requirement tagged graphql, on a project whose Semgrep step completed with the installed pack, found no GraphQL
//     signal and has a GraphQL signal rule for every scanned language, carries the suggestion "no sign of GraphQL in this
//     project"; with one scanned language that has no signal rule for the tag it carries none; with a match it carries
//     none;
//   - languages.only gives a suggestion when the project has none of those languages, languages.exempt when every
//     language of the project is exempt;
//   - the text prints the suggestions after the totals, a section whose requirements all carry the same suggestion
//     once, and --with-suggestion lists only the rows with one;
//   - confirming a suggestion (not-applicable <id> --from-suggestion) writes exactly one entry to .jgates/asvs.json (the
//     diff is that entry), with a preview and an undo, and is refused in governed mode; nothing is written without the
//     confirmation;
//   - the answer validates against schemas/coverage/asvs.schema.json and no text says compliant, conformant, certified
//     or a percentage, in either language.
// The command reads stored files only: the fake engine named in the environment records no call.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const JGATES = path.join(root, "jgates");
const DIST = path.join(JGATES, "dist");
const MAIN = path.join(DIST, "cli", "main.js");
const FAKE = path.join(JGATES, "tests", "docker", "fake-docker.cjs");
const RULES = path.join(JGATES, "packs", "semgrep", "jgates-semgrep", "rules");
const MAP_PACK = path.join(JGATES, "packs", "asvs", "jgates-asvs-map", "5.0.0");
const SCHEMA = path.join(JGATES, "schemas", "coverage", "asvs.schema.json");
const RECORDED_AT = "/opt/jgates/packs/semgrep/jgates-semgrep/rules/";
const FILE = ".jgates/asvs.json";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const { workspaceId } = await import(pathToFileURL(path.join(DIST, "core", "ids", "index.js")).href);
const asvs = await import(pathToFileURL(path.join(DIST, "core", "coverage", "asvs", "index.js")).href);
const semgrep = await import(pathToFileURL(path.join(DIST, "adapters", "semgrep", "index.js")).href);
const matrix = await import(pathToFileURL(path.join(DIST, "core", "matrix", "index.js")).href);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const made = [];
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validate = ajv.compile(readJson(SCHEMA));
const assertSchema = (doc, what) => assert.ok(validate(doc), `${what}: ${ajv.errorsText(validate.errors)}`);

// ---- the fixture -------------------------------------------------------------------------------------------------

const data = asvs.loadAsvs("5.0.0");
const level1 = asvs.asvsRequirements(data, { level: 1 });
const distinct = [];
for (const r of level1) if (!distinct.some((x) => x.section === r.section)) distinct.push(r);
const R = { named: distinct[0], all: distinct[1], graphql: distinct[2], only: distinct[3], exempt: distinct[4], plain: distinct[5] };
// A section whose requirements (every level) all carry the same suggestion, in a chapter of several sections, away from the rows above.
const OFFERED = data.chapters
  .flatMap((c) => c.sections)
  .find((s) => s.requirements.length >= 2 && s.requirements.some((r) => r.level === 1) && !Object.values(R).some((r) => r.section === s.id) && data.chapters.find((c) => c.id === s.chapter).sections.length > 1);
assert.ok(OFFERED, "a section of two or more requirements with a level-1 row");

const capabilityRow = matrix.buildMatrix().rows.find((r) => r.state === "validated" && r.stack === "any" && r.adapter !== "semgrep");
assert.ok(capabilityRow, "a capability with a validated row for any stack");
const CAPABILITY = `${capabilityRow.adapter}#${capabilityRow.capability}`;
const pack = semgrep.buildPackIndex(RULES);
assert.ok(pack.signals.some((s) => s.language === "javascript" && s.tag === "graphql"), "the pack has a GraphQL signal rule for JavaScript/TypeScript");
assert.ok(!pack.signals.some((s) => s.language === "kotlin"), "the pack has no Kotlin signal rule");
const TAGS = [...new Set(pack.rules.filter((r) => r.signal !== null).map((r) => r.signal))].sort();

const check = (unit, id, extra = {}) => ({ unit, id, covers: "what this check reads", misses: "what it does not model", depth: "partial", ...extra });
const why = "It bears on the requirement for a reason of its own.";
const reviewed = (patch) => ({ status: "reviewed", evidence: "repository", subdimensions: [], checks: [], why, review: { by: "independent context", date: "2026-11-15" }, ...patch });

function fixtureMapping() {
  const dir = tmp("v2-98-map-");
  const versionDir = path.join(dir, "5.0.0");
  fs.cpSync(MAP_PACK, versionDir, { recursive: true });
  const reset = { status: "unmapped", evidence: "repository", subdimensions: [], checks: [], applies: undefined, why: undefined, review: undefined };
  for (const name of fs.readdirSync(versionDir).filter((f) => /^V\d+\.json$/.test(f))) {
    const doc = readJson(path.join(versionDir, name));
    for (const entry of doc.entries) Object.assign(entry, reset);
    writeJson(path.join(versionDir, name), doc);
  }
  const set = (requirement, patch) => {
    const file = path.join(versionDir, `${asvs.chapterFileStem(requirement.chapter)}.json`);
    const doc = readJson(file);
    Object.assign(doc.entries.find((e) => e.requirement === requirement.id), patch);
    writeJson(file, doc);
  };
  set(R.named, reviewed({ subdimensions: ["secrets"], checks: [check("capability", CAPABILITY, { findingRules: ["ALERT-A"] })] }));
  set(R.all, reviewed({ subdimensions: ["secrets"], checks: [check("capability", CAPABILITY)] }));
  set(R.graphql, reviewed({ applies: { technology: ["graphql"] } }));
  set(R.only, reviewed({ applies: { languages: { only: ["java"] } } }));
  set(R.exempt, reviewed({ applies: { languages: { exempt: { languages: ["go", "rust"], reason: "linear-time-regex" } } } }));
  for (const r of OFFERED.requirements) set(r, reviewed({ evidence: "deployment", applies: { technology: ["graphql"] } }));
  return dir;
}

// ---- stored runs ---------------------------------------------------------------------------------------------------

const packRecords = () => semgrep.listPackRuleFiles(RULES).map((rel) => ({ file: `${RECORDED_AT}${rel}`, sha256: `sha256:${sha256(fs.readFileSync(path.join(RULES, ...rel.split("/"))))}` }));
const zero = () => Object.fromEntries(TAGS.map((t) => [t, 0]));

function storeQuality(home, project, runId, startedAt, { scanned = { javascript: 4, typescript: 1 }, languages = ["javascript", "typescript"], signals = zero() } = {}) {
  const dir = path.join(home, "workspaces", workspaceId(project), "runs", runId);
  const semgrepStage = { id: "semgrep#sast", label: "Semgrep", kind: "step", adapter: "semgrep", state: "completed", interpreted: true, scannedLanguages: scanned, signals };
  const semgrepItem = { id: "semgrep#sast", tool: "semgrep", adapter: "semgrep", subcheck: null, capabilities: ["sast"], languages, configFiles: packRecords(), state: { enabled: true, originLabel: "profile Balanced" }, reason: { code: "SELECTED", message: "Selected by capability:sast" } };
  const capItem = { id: CAPABILITY, tool: capabilityRow.adapter, adapter: capabilityRow.adapter, subcheck: null, capabilities: [capabilityRow.capability], languages: [], configFiles: [], state: { enabled: true, originLabel: "profile Balanced" }, reason: { code: "SELECTED", message: "Selected" } };
  const capStage = { id: CAPABILITY, label: capabilityRow.adapter, kind: "step", adapter: capabilityRow.adapter, state: "completed", interpreted: true };
  const finding = (ruleId, waived = false) => ({ stageId: CAPABILITY, tool: capabilityRow.adapter, ruleId, severity: "high", normalizedSeverity: "high", message: "a finding", location: { path: "src/app.js", line: 3 }, blocking: true, waived });
  writeJson(path.join(dir, "result.json"), {
    schemaVersion: 1,
    runId,
    gate: "quality",
    tool: "jgates",
    version: "2.0.0",
    startedAt,
    finishedAt: startedAt,
    decision: "failed",
    complete: true,
    reduced: false,
    exitCode: 1,
    requirements: [],
    stages: [semgrepStage, capStage],
    findings: [finding("ALERT-A"), finding("ALERT-A", true), finding("ALERT-A"), finding("ALERT-B")],
    unsatisfied: [],
    warnings: [],
    blockingViolations: 0,
    disabled: [],
    workspaceChanges: { checked: true, added: [], modified: [], removed: [] },
    artifacts: { result: "result.json", logs: [], outputs: [], plan: "plan.json" },
  });
  writeJson(path.join(dir, "plan.json"), { schemaVersion: 1, kind: "jgates-plan", groups: { willRun: [semgrepItem, capItem], notApplicableOrDisabled: [] } });
  writeJson(path.join(dir, "run.json"), { schemaVersion: 1, gate: "quality", runId, source: { commit: "1111111111111111111111111111111111111111", dirty: false, dirtyContentHash: null } });
}

const RUNS = {
  js: "run_20261115T100000Z_aaaaaaaa",
  kotlin: "run_20261114T100000Z_bbbbbbbb",
  match: "run_20261113T100000Z_cccccccc",
  go: "run_20261112T100000Z_dddddddd",
};

function crafted() {
  const project = tmp("v2-98-project-");
  const home = tmp("v2-98-home-");
  const engine = tmp("v2-98-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(runtime, `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nrequire(${JSON.stringify(FAKE)});\n`);
  const mapDir = fixtureMapping();
  storeQuality(home, project, RUNS.js, "2026-11-15T10:00:00.000Z");
  storeQuality(home, project, RUNS.kotlin, "2026-11-14T10:00:00.000Z", { scanned: { javascript: 4, kotlin: 2 }, languages: ["javascript", "kotlin"] });
  storeQuality(home, project, RUNS.match, "2026-11-13T10:00:00.000Z", { signals: { ...zero(), graphql: 3 } });
  storeQuality(home, project, RUNS.go, "2026-11-12T10:00:00.000Z", { scanned: { go: 3 }, languages: ["go"] });
  const cli = (args, { locale = "en", env = {} } = {}) => {
    const full = { ...process.env, JGATES_HOME: home, JGATES_LOCALE: locale, NO_COLOR: "1", JGATES_ASVS_MAP_DIR: mapDir, JGATES_CONTAINER_RUNTIME: runtime, ...env };
    if (!("JGATES_POLICY_DIR" in env)) delete full.JGATES_POLICY_DIR;
    const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env: full, input: "", timeout: 120_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const json = (args, options) => {
    const r = cli([...args, "--json"], options);
    try {
      return { ...r, doc: JSON.parse(r.out) };
    } catch {
      assert.fail(`no JSON from ${args.join(" ")}: ${r.out}\n${r.err}`);
    }
  };
  const map = (extra = [], options) => {
    const r = json(["coverage", "asvs", "--cwd", project, ...extra], options);
    assert.equal(r.code, 0, `${extra.join(" ")}: ${r.out}${r.err}`);
    assertSchema(r.doc, `coverage asvs ${extra.join(" ")}`);
    return r.doc;
  };
  const engineCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter((l) => l.trim() !== "") : []);
  return { project, home, cli, json, map, engineCalls };
}

const row = (doc, requirement) => {
  const found = doc.requirements.find((r) => r.id === requirement.id);
  assert.ok(found, `${requirement.id} is in the map`);
  return found;
};

// ---- the cases -----------------------------------------------------------------------------------------------------

test("V2-98: a capability check with findingRules counts only the named alerts; without the field, all its findings", () => {
  const p = crafted();
  const doc = p.map();
  assert.deepEqual(row(doc, R.named).checks.map((c) => [c.status, c.openFindings, c.findingRules]), [["ran", 2, ["ALERT-A"]]], "two open ALERT-A; the waived one and ALERT-B are not counted");
  assert.deepEqual(row(doc, R.all).checks.map((c) => [c.status, c.openFindings]), [["ran", 3]]);
  assert.deepEqual(p.engineCalls(), []);
});

test("V2-98: graphql carries a suggestion only when the scan looked in every language and found no sign of it", () => {
  const p = crafted();
  const js = row(p.map(["--run", RUNS.js]), R.graphql);
  assert.equal(js.state, "unsupported");
  assert.deepEqual(js.suggestion, { kind: "technology", tags: ["graphql"], reason: "no sign of GraphQL in this project" });
  assert.equal(row(p.map(["--run", RUNS.kotlin]), R.graphql).suggestion, undefined, "Kotlin was scanned and has no signal rule: absence of knowledge is not absence");
  assert.equal(row(p.map(["--run", RUNS.match]), R.graphql).suggestion, undefined, "a GraphQL match");
  const pt = row(p.map(["--run", RUNS.js], { locale: "pt-BR" }), R.graphql);
  assert.equal(pt.suggestion.reason, "nenhum sinal de GraphQL neste projeto");
});

test("V2-98: languages.only and languages.exempt behave as the plan says", () => {
  const p = crafted();
  const js = p.map(["--run", RUNS.js]);
  assert.deepEqual(row(js, R.only).suggestion, { kind: "languages-only", languages: ["java"], reason: "it concerns only Java, which this project does not use" });
  assert.equal(row(js, R.exempt).suggestion, undefined, "JavaScript is not exempt");
  const go = p.map(["--run", RUNS.go]);
  assert.deepEqual(row(go, R.exempt).suggestion, { kind: "languages-exempt", languages: ["go"], reasonId: "linear-time-regex", reason: "the regular expressions of Go run in linear time" });
  assert.equal(row(go, R.only).suggestion?.kind, "languages-only");
});

test("V2-98: the text prints the suggestions after the totals, a section once; --with-suggestion lists only the rows with one", () => {
  const p = crafted();
  const doc = p.map(["--run", RUNS.js]);
  const section = doc.chapters.find((c) => c.id === OFFERED.chapter).sections.find((s) => s.id === OFFERED.id);
  assert.equal(section.suggestion?.kind, "technology", "the section carries the suggestion once");
  const text = p.cli(["coverage", "asvs", "--cwd", p.project, "--run", RUNS.js]);
  assert.equal(text.code, 0, text.err);
  const lines = text.out.split("\n");
  const totals = lines.findIndex((l) => l.startsWith("Examined:"));
  const title = lines.findIndex((l) => /suggestions? of "not applicable"/.test(l));
  const firstChapter = lines.findIndex((l, i) => i > totals && /^V\d+ /.test(l));
  assert.ok(totals >= 0 && title === totals + 1 && title < firstChapter, `suggestions right after the totals: ${lines.slice(0, title + 8).join("\n")}`);
  const block = lines.slice(title + 1, firstChapter).join("\n");
  assert.ok(block.includes(`${OFFERED.id} (section, every requirement): no sign of GraphQL in this project`), block);
  for (const r of OFFERED.requirements) assert.ok(!block.includes(`  ${r.id}: `), `${r.id} is offered through its section, not again`);
  assert.ok(block.includes(`${R.graphql.id}: no sign of GraphQL in this project`) && block.includes(`${R.only.id}: it concerns only Java`), block);
  assert.ok(block.includes("--from-suggestion"), "how to confirm one");
  assert.ok(text.out.includes("Suggestion: no sign of GraphQL in this project"), "the row says it too");
  const pt = p.cli(["coverage", "asvs", "--cwd", p.project, "--run", RUNS.js], { locale: "pt-BR" });
  assert.ok(pt.out.includes("Sugestão: nenhum sinal de GraphQL neste projeto") && /sugest(ão|ões) de "não se aplica"/.test(pt.out), pt.out.slice(0, 1500));

  const filtered = p.map(["--run", RUNS.js, "--with-suggestion"]);
  assert.equal(filtered.filters.withSuggestion, true);
  assert.ok(filtered.requirements.length > 0 && filtered.requirements.every((r) => r.suggestion), "only rows with a suggestion");
  assert.ok(filtered.requirements.some((r) => r.id === R.graphql.id) && !filtered.requirements.some((r) => r.id === R.plain.id || r.id === R.named.id));
  assert.deepEqual(filtered.totals, doc.totals);
});

test("V2-98: confirming a suggestion writes exactly one entry, with a preview and an undo, and is refused in governed mode", () => {
  const p = crafted();
  const target = path.join(p.project, FILE);
  const before = '{\n  "$comment": "team file",\n  "notApplicable": [\n    { "id": "V17", "reason": "no WebRTC in this product", "recorded": "2026-11-01" }\n  ]\n}\n';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, before);
  const args = ["coverage", "asvs", "not-applicable", R.graphql.id, "--from-suggestion", "--cwd", p.project];

  // The preview: the entry with the suggestion's reason, the diff, nothing written.
  const preview = p.json([...args, "--preview"]);
  assert.equal(preview.code, 0, preview.out + preview.err);
  assert.deepEqual([preview.doc.preview, preview.doc.written, preview.doc.entry.id, preview.doc.entry.reason], [true, false, R.graphql.id, "no sign of GraphQL in this project"]);
  assert.ok(preview.doc.diff.includes(`+++ b/${FILE}`), preview.doc.diff);
  assert.equal(fs.readFileSync(target, "utf8"), before);
  // Without --yes and with nobody to ask: shown, not written.
  const asked = p.cli(args);
  assert.equal(asked.code, 3, asked.out + asked.err);
  assert.ok(asked.out.includes(R.graphql.id) && asked.out.includes("no sign of GraphQL in this project"), asked.out);
  assert.equal(fs.readFileSync(target, "utf8"), before);

  // Governed mode: refused, nothing written.
  const governed = p.json([...args, "--yes"], { env: { JGATES_POLICY_DIR: tmp("v2-98-policy-") } });
  assert.equal(governed.doc.code, "ASVS_READ_ONLY");
  assert.equal(fs.readFileSync(target, "utf8"), before);

  // The write: one entry and nothing else; the row is then not applicable and carries no suggestion.
  const written = p.json([...args, "--yes"]);
  assert.equal(written.code, 0, written.out + written.err);
  const after = fs.readFileSync(target, "utf8");
  const cut = before.indexOf("\n  ]");
  assert.equal(after.slice(0, cut), before.slice(0, cut));
  assert.ok(after.endsWith(before.slice(cut)));
  const entry = JSON.parse(after.slice(cut, after.length - (before.length - cut)).replace(/^,/, ""));
  assert.deepEqual(entry, { id: R.graphql.id, reason: "no sign of GraphQL in this project", recorded: entry.recorded });
  assert.equal(readJson(target).notApplicable.length, 2);
  const naRow = row(p.map(["--run", RUNS.js]), R.graphql);
  assert.deepEqual([naRow.state, naRow.suggestion], ["not-applicable", undefined]);

  // Undo puts the file back byte for byte.
  const undone = p.json(["coverage", "asvs", "undo", written.doc.undo.token, "--cwd", p.project]);
  assert.equal(undone.code, 0, undone.out + undone.err);
  assert.equal(fs.readFileSync(target, "utf8"), before);

  // A section offered once is confirmed once: one entry for the section.
  const sectionWrite = p.json(["coverage", "asvs", "not-applicable", OFFERED.id, "--from-suggestion", "--yes", "--cwd", p.project]);
  assert.equal(sectionWrite.code, 0, sectionWrite.out + sectionWrite.err);
  assert.deepEqual(readJson(target).notApplicable.map((e) => e.id), ["V17", OFFERED.id]);
  const covered = p.map(["--run", RUNS.js, "--level", "3"]).requirements.filter((r) => r.section === OFFERED.id);
  assert.ok(covered.length === OFFERED.requirements.length && covered.every((r) => r.state === "not-applicable" && r.decision.scope === "section"));

  // No suggestion for the target: refused, nothing written.
  const none = p.json(["coverage", "asvs", "not-applicable", R.plain.id, "--from-suggestion", "--yes", "--cwd", p.project]);
  assert.equal(none.code, 3);
  assert.equal(none.doc.code, "ASVS_NO_SUGGESTION");
  assert.deepEqual(readJson(target).notApplicable.map((e) => e.id), ["V17", OFFERED.id]);
  assert.deepEqual(p.engineCalls(), []);
});

test("V2-98: the answer validates and no text says compliant, conformant, certified or a percentage", () => {
  const p = crafted();
  const forbidden = [/\bcompliant\b/i, /\bconformant\b/i, /\bcertified\b/i, /\bcompliance\b/i, /\bconformidade\b/i, /\bcertificad[oa]s?\b/i, /\d+(?:[.,]\d+)?\s*%/];
  for (const locale of ["en", "pt-BR"]) {
    for (const extra of [["--run", RUNS.js], ["--run", RUNS.go, "--level", "3"], ["--run", RUNS.js, "--with-suggestion"]]) {
      const doc = p.map(extra, { locale });
      const own = JSON.stringify({ ...doc, requirements: doc.requirements.map(({ text, ...rest }) => rest) });
      const text = p.cli(["coverage", "asvs", "--cwd", p.project, ...extra], { locale });
      assert.equal(text.code, 0, text.err);
      // The official requirement text is the standard's own: only JGates's words are checked.
      let words = text.out;
      for (const r of data.requirements) words = words.split(r.text).join("");
      for (const word of forbidden) {
        assert.doesNotMatch(own, word, `${locale} ${extra.join(" ")} --json: ${word}`);
        assert.doesNotMatch(words, word, `${locale} ${extra.join(" ")}: ${word}`);
      }
    }
  }
});
