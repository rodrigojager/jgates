import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// The map's model on stored-run records, with no engine (core/coverage/asvs, resolveAsvsMap): a capability check tied to
// named alerts counts only those findings; the AI review of the source against a requirement (`semantic-requirement`,
// `asvs-review`) examines a requirement only through a valid ledger with references that exist, counted apart and left
// out with "deterministic only"; and a row that is unsupported, unexamined or awaiting evidence carries a suggestion of
// "not applicable" only when the evidence holds (the scan looked in every language and found no sign of the technology;
// the project has none of the languages concerned; every language of the project is exempt). Nothing here writes.

const here = path.dirname(fileURLToPath(import.meta.url));
const JGATES = path.resolve(here, "..");
const dist = path.join(JGATES, "dist");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const asvs = await import(pathToFileURL(path.join(dist, "core", "coverage", "asvs", "index.js")).href);
const semgrep = await import(pathToFileURL(path.join(dist, "adapters", "semgrep", "index.js")).href);
const matrix = await import(pathToFileURL(path.join(dist, "core", "matrix", "index.js")).href);
const i18n = await import(pathToFileURL(path.join(dist, "i18n", "index.js")).href);

const RULES = path.join(JGATES, "packs", "semgrep", "jgates-semgrep", "rules");
const RECORDED_AT = "/opt/jgates/packs/semgrep/jgates-semgrep/rules/";
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const data = asvs.loadAsvs("5.0.0");
const packIndex = semgrep.buildPackIndex(RULES);
const signalTags = [...new Set(packIndex.rules.filter((r) => r.signal !== null).map((r) => r.signal))].sort();
const hasSignal = (language, tag) => packIndex.signals.some((s) => s.language === language && s.tag === tag);
assert.ok(hasSignal("javascript", "graphql") && hasSignal("python", "graphql"), "the pack has GraphQL signal rules for JavaScript and Python");

const capabilityRow = matrix.buildMatrix().rows.find((r) => r.state === "validated" && r.stack === "any" && r.adapter !== "semgrep");
assert.ok(capabilityRow, "a capability with a validated row for any stack");
const CAPABILITY = `${capabilityRow.adapter}#${capabilityRow.capability}`;

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateAnswer = ajv.compile(readJson(path.join(JGATES, "schemas", "coverage", "asvs.schema.json")));
const assertSchema = (doc, what) => assert.ok(validateAnswer(doc), `${what}: ${ajv.errorsText(validateAnswer.errors)}`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-asvs-suggestions-"));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const workspace = path.join(tmpRoot, "workspace");
fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
fs.writeFileSync(path.join(workspace, "src", "account.js"), "a\nb\nc\n");

// ---- requirements, the mapping and stored runs ----------------------------------------------------------------

// One level-1 requirement per section, so a section-wide offer never comes from these rows by accident.
const sectionsSeen = new Set();
const picks = [];
for (const r of data.requirements) if (r.level === 1 && !sectionsSeen.has(r.section)) (sectionsSeen.add(r.section), picks.push(r));
const R = { graphql: picks[0], only: picks[1], exempt: picks[2], findingRules: picks[3], allAlerts: picks[4], review: picks[5], notExaminable: picks[6], missingRef: picks[7], unanswered: picks[8], graphqlRan: picks[9], graphqlDecided: picks[10], pendingApplies: picks[11] };
// A section whose requirements all carry the same suggestion; chosen among sections none of the rows above sits in.
const offered = data.chapters.flatMap((c) => c.sections).find((s) => s.requirements.length >= 2 && !Object.values(R).some((r) => r.section === s.id) && data.chapters.find((c) => c.id === s.chapter).sections.length > 1);
assert.ok(offered, "a section of two or more requirements in a chapter of several sections");

const check = (unit, id, extra = {}) => ({ unit, id, covers: "what this check reads", misses: "what it does not model", depth: "partial", ...extra });
const reviewed = (patch) => ({ status: "reviewed", evidence: "repository", subdimensions: [], checks: [], why: "A reason of its own.", review: { by: "independent context", date: "2026-11-15" }, ...patch });

function fixtureMapping() {
  const entries = data.requirements.map((r) => ({ requirement: r.id, status: "unmapped", evidence: "repository", subdimensions: [], checks: [] }));
  const set = (requirement, patch) => Object.assign(entries.find((e) => e.requirement === requirement.id), patch);
  set(R.graphql, reviewed({ applies: { technology: ["graphql"] } }));
  set(R.only, reviewed({ applies: { languages: { only: ["java"] } } }));
  set(R.exempt, reviewed({ applies: { languages: { exempt: { languages: ["go", "rust"], reason: "linear-time-regex" } } } }));
  set(R.findingRules, reviewed({ subdimensions: ["secrets"], checks: [check("capability", CAPABILITY, { findingRules: ["ALERT-A"] })] }));
  set(R.allAlerts, reviewed({ subdimensions: ["secrets"], checks: [check("capability", CAPABILITY)] }));
  for (const r of [R.review, R.notExaminable, R.missingRef, R.unanswered]) set(r, reviewed({ checks: [check("semantic-requirement", "asvs-review")] }));
  set(R.graphqlRan, reviewed({ subdimensions: ["secrets"], checks: [check("capability", CAPABILITY)], applies: { technology: ["graphql"] } }));
  set(R.graphqlDecided, reviewed({ applies: { technology: ["graphql"] } }));
  set(R.pendingApplies, { status: "pending", evidence: "repository", subdimensions: [], checks: [], applies: { technology: ["graphql"] }, why: "Awaits its review." });
  for (const r of offered.requirements) set(r, reviewed({ evidence: "deployment", applies: { technology: ["graphql"] } }));
  return { version: "5.0.0", files: [], entries, unmappedRules: { version: "5.0.0", rules: [] } };
}
const MAPPING = fixtureMapping();

const packRecords = (kind) =>
  semgrep.listPackRuleFiles(RULES).map((rel) => ({ file: `${RECORDED_AT}${rel}`, sha256: kind === "current" ? `sha256:${sha256(fs.readFileSync(path.join(RULES, ...rel.split("/"))))}` : `sha256:${sha256(Buffer.from(`older ${rel}`))}` }));
const zeroSignals = () => Object.fromEntries(signalTags.map((t) => [t, 0]));
const QUALITY_RUN = "run_20261115T100000Z_11111111";

/** A stored Quality run: a Semgrep step with the JGates pack and the step of the capability, with its findings. */
function quality({ scanned = { javascript: 3, typescript: 1 }, signals = zeroSignals(), languages = ["javascript", "typescript"], semgrepState = "completed", pack = "current", findings } = {}) {
  const semgrepStage = { id: "semgrep#sast", label: "Semgrep", kind: "step", adapter: "semgrep", state: semgrepState, interpreted: semgrepState === "completed", ...(scanned ? { scannedLanguages: scanned } : {}), ...(signals ? { signals } : {}) };
  const semgrepItem = { id: "semgrep#sast", tool: "semgrep", adapter: "semgrep", subcheck: null, capabilities: ["sast"], languages, configFiles: packRecords(pack) };
  const capStage = { id: CAPABILITY, label: capabilityRow.adapter, kind: "step", adapter: capabilityRow.adapter, state: "completed", interpreted: true };
  const capItem = { id: CAPABILITY, tool: capabilityRow.adapter, adapter: capabilityRow.adapter, subcheck: null, capabilities: [capabilityRow.capability], languages: [], configFiles: [] };
  const finding = (ruleId, waived = false) => ({ stageId: CAPABILITY, ruleId, severity: "high", message: "m", location: { path: "src/account.js" }, blocking: true, waived });
  return {
    runId: QUALITY_RUN,
    result: { runId: QUALITY_RUN, startedAt: "2026-11-15T10:00:00.000Z", stages: [semgrepStage, capStage], findings: findings ?? [finding("ALERT-A"), finding("ALERT-A", true), finding("ALERT-A"), finding("ALERT-B")] },
    plan: { groups: { willRun: [semgrepItem, capItem], notApplicableOrDisabled: [] } },
  };
}

const reviewLedger = (requirements) => ({ schemaVersion: 1, kind: "asvs-review-ledger", method: "asvs-review", asvsVersion: "5.0.0", level: 1, requirements });
const ref = (p = "src/account.js") => [{ path: p, startLine: 1, endLine: 3 }];
function reviewRun(answers = [
  { id: R.review.id, answer: "examined", references: ref(), outcome: "finding", findings: ["fp-1", "fp-2"] },
  { id: R.notExaminable.id, answer: "not-examinable", reason: "person" },
  { id: R.missingRef.id, answer: "examined", references: ref("src/gone.js"), outcome: "no-violation-found" },
]) {
  return {
    runId: "sem_20261115T110000Z_22222222",
    result: { runId: "sem_20261115T110000Z_22222222", findings: [{ fingerprint: "fp-1", waived: false }, { fingerprint: "fp-2", waived: true }], semanticRun: { methods: ["asvs-review"], outcome: { state: "completed" } } },
    ledger: null,
    defaults: null,
    asvsReview: reviewLedger(answers),
  };
}

/** The map in a given language (English by default, whatever the language of the machine). */
const resolve = (over = {}, locale = "en") => i18n.withLocale(locale, () => asvs.resolveAsvsMap({ data, mapping: MAPPING, quality: quality(), semantic: [], decisions: null, level: 3, workspaceDir: workspace, ...over }));
const row = (map, requirement) => {
  const found = map.requirements.find((r) => r.id === requirement.id);
  assert.ok(found, `${requirement.id} is in the map`);
  return found;
};

// ---- the cases -------------------------------------------------------------------------------------------------

test("a capability check with findingRules counts only the findings of those alerts; without the field, all of the stage's", () => {
  const map = resolve();
  assertSchema(map, "map");
  const named = row(map, R.findingRules).checks[0];
  assert.deepEqual([named.status, named.openFindings, named.findingRules], ["ran", 2, ["ALERT-A"]], "two open ALERT-A (one waived is not counted), ALERT-B is not this check's");
  const all = row(map, R.allAlerts).checks[0];
  assert.deepEqual([all.status, all.openFindings, all.findingRules], ["ran", 3, undefined]);
});

test("a requirement tagged graphql carries a suggestion when the scan looked in every language and found no GraphQL sign", () => {
  const map = resolve();
  const g = row(map, R.graphql);
  assert.equal(g.state, "unsupported");
  assert.deepEqual(g.suggestion, { kind: "technology", tags: ["graphql"], reason: "no sign of GraphQL in this project" });
  const pt = resolve({}, "pt-BR");
  assert.equal(row(pt, R.graphql).suggestion.reason, "nenhum sinal de GraphQL neste projeto");
  assertSchema(pt, "map pt-BR");

  // A Go project: the Go front has a GraphQL signal rule too.
  if (hasSignal("go", "graphql")) assert.equal(row(resolve({ quality: quality({ scanned: { go: 2 }, languages: ["go"] }) }), R.graphql).suggestion?.kind, "technology");
});

test("no technology suggestion without the evidence: a match, a scanned language with no signal rule, a language not scanned, an old or other-pack run, a failed scan", () => {
  const none = (q, what) => assert.equal(row(resolve({ quality: q }), R.graphql).suggestion, undefined, what);
  none(quality({ signals: { ...zeroSignals(), graphql: 1 } }), "a GraphQL match");
  none(quality({ scanned: { javascript: 3, kotlin: 2 }, languages: ["javascript", "kotlin"] }), "Kotlin was scanned and the pack has no Kotlin signal rule: absence of knowledge");
  none(quality({ scanned: { javascript: 3 }, languages: ["javascript", "go"] }), "Go is in the project and the scan covered no Go file");
  none(quality({ signals: null }), "a run made before the signals record");
  none(quality({ signals: Object.fromEntries(Object.entries(zeroSignals()).filter(([t]) => t !== "graphql")) }), "the record does not hold the tag");
  none(quality({ scanned: null }), "no scanned-languages record");
  none(quality({ pack: "stale" }), "another version of the pack");
  none(quality({ semgrepState: "error" }), "the Semgrep step did not complete");
  assert.equal(row(resolve({ quality: null }), R.graphql).suggestion, undefined, "no Quality run");
});

test("a suggestion only on unsupported, unexamined or awaiting-evidence rows of a reviewed entry; a recorded decision stays", () => {
  const map = resolve({ decisions: { file: ".jgates/asvs.json", exists: true, revision: "r", version: "5.0.0", level: null, notApplicable: [{ id: R.graphqlDecided.id, reason: "no GraphQL here", recorded: "2026-11-01" }] } });
  const ran = row(map, R.graphqlRan);
  assert.deepEqual([ran.state, ran.suggestion], ["examined", undefined], "a check ran: examined, no suggestion");
  const decided = row(map, R.graphqlDecided);
  assert.deepEqual([decided.state, decided.suggestion, decided.decision.reason], ["not-applicable", undefined, "no GraphQL here"]);
  assert.equal(row(map, R.pendingApplies).suggestion, undefined, "a pending entry's applies counts for nothing");
  const awaiting = row(map, offered.requirements[0]);
  assert.deepEqual([awaiting.state, awaiting.suggestion?.kind], ["awaiting-evidence", "technology"]);
});

test("languages.only and languages.exempt give a suggestion with a reason from the closed list, only when the project's languages are known", () => {
  const map = resolve();
  assert.deepEqual(row(map, R.only).suggestion, { kind: "languages-only", languages: ["java"], reason: "it concerns only Java, which this project does not use" });
  assert.equal(row(map, R.exempt).suggestion, undefined, "JavaScript is not exempt");
  assert.equal(row(resolve({ quality: quality({ scanned: { java: 4 }, languages: ["java"] }) }), R.only).suggestion, undefined, "a Java project");
  const go = resolve({ quality: quality({ scanned: { go: 2 }, languages: ["go"] }) });
  assert.deepEqual(row(go, R.exempt).suggestion, { kind: "languages-exempt", languages: ["go"], reasonId: "linear-time-regex", reason: "the regular expressions of Go run in linear time" });
  assert.equal(row(resolve({ quality: quality({ scanned: { go: 2, python: 1 }, languages: ["go", "python"] }) }), R.exempt).suggestion, undefined, "Python is not exempt");
  const unknown = resolve({ quality: null });
  assert.equal(row(unknown, R.only).suggestion, undefined, "unknown languages: no suggestion");
  assert.equal(row(unknown, R.exempt).suggestion, undefined);
  const pt = resolve({ quality: quality({ scanned: { go: 2 }, languages: ["go"] }) }, "pt-BR");
  assert.equal(row(pt, R.exempt).suggestion.reason, "as expressões regulares de Go rodam em tempo linear");
});

test("a section whose requirements all carry the same suggestion carries it once; the filter lists only the rows with a suggestion", () => {
  const map = resolve();
  const chapter = map.chapters.find((c) => c.id === offered.chapter);
  const section = chapter.sections.find((s) => s.id === offered.id);
  assert.deepEqual(section.suggestion, { kind: "technology", tags: ["graphql"], reason: "no sign of GraphQL in this project" });
  assert.equal(chapter.suggestion, undefined, "the chapter has other sections without it");
  assert.equal(chapter.sections.filter((s) => s.suggestion).length, 1);
  assert.deepEqual(asvs.suggestionOfTarget(map, offered.id), section.suggestion);
  assert.deepEqual(asvs.suggestionOfTarget(map, R.only.id), row(map, R.only).suggestion);
  assert.equal(asvs.suggestionOfTarget(map, R.findingRules.id), null);
  // A section is offered from all of its requirements, whatever the level shown.
  const level1 = resolve({ level: 1 });
  const s1 = level1.chapters.find((c) => c.id === offered.chapter)?.sections.find((s) => s.id === offered.id);
  if (s1) assert.deepEqual(s1.suggestion, section.suggestion);

  const filtered = resolve({ withSuggestion: true });
  assertSchema(filtered, "filtered map");
  assert.equal(filtered.filters.withSuggestion, true);
  assert.ok(filtered.requirements.length > 0 && filtered.requirements.every((r) => r.suggestion));
  assert.deepEqual(filtered.requirements.map((r) => r.id).sort(), map.requirements.filter((r) => r.suggestion).map((r) => r.id).sort());
  assert.deepEqual(filtered.totals, map.totals, "the filter narrows the rows listed, not the totals");
});

test("asvs-review: an examined answer with existing references examines the requirement as an AI review, counted apart; anything else counts for nothing", () => {
  const map = resolve({ semantic: [reviewRun()] });
  assertSchema(map, "map with the review");
  const ok = row(map, R.review);
  assert.deepEqual([ok.state, ok.code, ok.basis], ["examined", "EXAMINED_AI_ONLY", "ai-source-review"]);
  assert.deepEqual(ok.checks.map((c) => [c.unit, c.id, c.status, c.basis, c.openFindings]), [["semantic-requirement", "asvs-review", "ran", "ai-source-review", 1]], "the finding it raised that is still open");
  assert.match(ok.reason, /AI review of the source/);
  const no = row(map, R.notExaminable);
  assert.deepEqual([no.state, no.code, no.checks[0].code], ["unsupported", "UNSUPPORTED_NOT_EXAMINABLE", "NOT_EXAMINABLE"]);
  const missing = row(map, R.missingRef);
  assert.deepEqual([missing.state, missing.checks[0].status, missing.checks[0].code], ["unexamined", "not-run", "REFERENCE_MISSING"]);
  const unanswered = row(map, R.unanswered);
  assert.deepEqual([unanswered.state, unanswered.checks[0].code], ["unexamined", "REQUIREMENT_NOT_REVIEWED"]);
  assert.equal(map.totals.examinedAiOnly, 1);
  assert.equal(map.totals.examinedDeterministic, 3, "the capability checks (findingRules, all alerts, graphqlRan)");

  // Deterministic only leaves the review out; no workspace: no answer counts; no run of the method: not run.
  const det = resolve({ semantic: [reviewRun()], deterministicOnly: true });
  assert.deepEqual([row(det, R.review).state, row(det, R.review).checks[0].code], ["unexamined", "DETERMINISTIC_ONLY"]);
  assert.equal(det.totals.examinedAiOnly, 0);
  assert.deepEqual(row(resolve({ semantic: [reviewRun()], workspaceDir: null }), R.review).checks[0].code, "REFERENCES_UNVERIFIED");
  assert.deepEqual(row(resolve(), R.review).checks[0].code, "NO_SEMANTIC_RUN");
  // An unfinished run gives nothing.
  const unfinished = reviewRun();
  unfinished.result.partial = true;
  assert.deepEqual(row(resolve({ semantic: [unfinished] }), R.review).checks[0].code, "RUN_UNFINISHED");
});

test("the answer validates, and no text of it says compliant, conformant, certified or a percentage, in either language", () => {
  const forbidden = [/\bcompliant\b/i, /\bconformant\b/i, /\bcertified\b/i, /\bcompliance\b/i, /\bconformidade\b/i, /\bcertificad[oa]s?\b/i, /\d+(?:[.,]\d+)?\s*%/];
  for (const locale of ["en", "pt-BR"]) {
    for (const over of [{}, { semantic: [reviewRun()] }, { quality: quality({ scanned: { go: 2 }, languages: ["go"] }) }, { withSuggestion: true }]) {
      const map = resolve(over, locale);
      assertSchema(map, `${locale} ${JSON.stringify(Object.keys(over))}`);
      // The official requirement text is the standard's own; every other string is JGates's.
      const own = JSON.stringify({ ...map, requirements: map.requirements.map(({ text, ...rest }) => rest) });
      for (const word of forbidden) assert.doesNotMatch(own, word, `${locale}: ${word}`);
    }
  }
});
