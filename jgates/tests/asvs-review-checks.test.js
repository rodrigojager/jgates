import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as asvs from "../dist/core/coverage/asvs/index.js";
import { withLocale } from "../dist/i18n/index.js";
import { mapText } from "../dist/cli/commands/coverage.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = path.resolve(root, "../_work/00-tmp");
const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020").default;
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const validate = new Ajv({ strict: true, allErrors: true }).compile(json(path.join(root, "jgates/schemas/coverage/asvs.schema.json")));
const validateMappingSchema = new Ajv({ strict: true, allErrors: true }).compile(json(path.join(root, "jgates/schemas/coverage/asvs-map.schema.json")));
const note = (language = "javascript", kind = "protected-by-library", family = "xml") => ({
  language, kind, family, why: "The fixture library does not resolve external entities.",
});
const check = (id) => ({ unit: "semgrep-rule", id, covers: "a local construct", misses: "behaviour elsewhere", depth: "partial" });

function fixture(t) {
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "asvs-review-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rules = path.join(dir, "rules/javascript");
  fs.mkdirSync(rules, { recursive: true });
  const yaml = `rules:
  - id: jgates.js.fixture-review
    languages: [javascript]
    severity: INFO
    message: Look at this default.
    pattern: review($X)
    metadata:
      class: review
      category: xxe
      cwe: CWE-611
      subdimension: injection
      author: JGates
      asvs_requirements: [V1.1.1]
  - id: jgates.js.fixture-blocking
    languages: [javascript]
    severity: WARNING
    message: Explicit unsafe call.
    pattern: unsafe($X)
    metadata:
      category: xxe
      cwe: CWE-611
      subdimension: injection
      author: JGates
      asvs_requirements: [V1.1.1]
`;
  fs.writeFileSync(path.join(rules, "fixture.yaml"), yaml);
  const data = asvs.loadAsvs();
  const target = asvs.asvsRequirements(data, { level: 1 })[0];
  const entry = { requirement: target.id, status: "reviewed", evidence: "repository", subdimensions: ["injection"], checks: [check("jgates.js.fixture-review")], why: "A local signal warrants human attention." };
  const mapping = { version: data.version, files: [], entries: [entry], unmappedRules: { version: data.version, rules: [] } };
  const finding = (ruleId, extra = {}) => ({ ruleId, stageId: "semgrep#sast", blocking: false, ...extra });
  const quality = {
    runId: "fixture",
    plan: { groups: { willRun: [{
      id: "semgrep#sast", adapter: "semgrep", capabilities: ["sast"], languages: ["javascript"],
      configFiles: [{ file: "/opt/jgates/packs/semgrep/jgates-semgrep/rules/javascript/fixture.yaml", sha256: `sha256:${crypto.createHash("sha256").update(yaml).digest("hex")}` }],
    }], notApplicableOrDisabled: [] } },
    result: { stages: [{ id: "semgrep#sast", adapter: "semgrep", state: "completed", interpreted: true, scannedLanguages: { javascript: 1 } }],
      findings: [
        finding("jgates.js.fixture-review", { review: true }),
        finding("jgates.js.fixture-review", { review: true, waived: true }),
        finding("jgates.js.fixture-blocking", { blocking: true }),
        finding("jgates.js.fixture-blocking", { informational: true }),
      ] },
  };
  const input = { data, mapping, quality, semantic: [], decisions: null, rulesDir: path.dirname(rules), matrixRows: [] };
  const map = (patch = {}, locale = "en") => withLocale(locale, () => asvs.resolveAsvsMap({ ...input, ...patch }));
  const row = (doc = map()) => doc.requirements.find((r) => r.id === target.id);
  return { dir, input, entry, quality, map, row };
}

test("Review-only never examines, whether it ran or not; mixed checks examine only through a non-Review check", (t) => {
  const f = fixture(t);
  const only = f.row();
  assert.deepEqual([only.state, only.code, only.basis], ["unsupported", "UNSUPPORTED_REVIEW_ONLY", null]);
  assert.match(only.reason, /jgates\.js\.fixture-review.*ran/);
  assert.equal(only.checks[0].class, "review");
  assert.deepEqual([only.checks[0].openBlocking, only.checks[0].openInformational, only.checks[0].openReview, only.checks[0].openFindings], [0, 0, 1, 1]);
  const none = f.row(f.map({ quality: null }));
  assert.deepEqual([none.state, none.code], ["unsupported", "UNSUPPORTED_REVIEW_ONLY"]);
  assert.match(none.reason, /jgates\.js\.fixture-review/);
  f.entry.checks.push(check("jgates.js.fixture-blocking"));
  const mixed = f.row();
  assert.equal(mixed.state, "examined");
  assert.equal(mixed.code, "EXAMINED");
  assert.doesNotMatch(mixed.reason, /fixture-review/);
  assert.deepEqual(mixed.checks.map((c) => [c.openBlocking, c.openInformational, c.openReview]), [[0, 0, 1], [1, 1, 0]]);
  assert.equal(mixed.checks[1].class, undefined);
  assert.equal(f.row(f.map({ quality: null })).state, "unexamined");
  f.quality.result.findings[0].waived = true;
  assert.equal(f.row().checks[0].openReview, 0);
  const absent = structuredClone(f.quality);
  absent.plan.groups.willRun[0].languages = ["rust"];
  absent.result.stages[0].scannedLanguages = { rust: 1 };
  f.entry.checks = [check("jgates.js.fixture-review")];
  assert.equal(f.row(f.map({ quality: absent })).checks[0].relevant, false);
  assert.equal(f.row(f.map({ quality: absent })).code, "UNSUPPORTED_NO_CHECK_FOR_LANGUAGES");
});

test("reviewed language notes are localized, filtered, hidden while pending and independent of state and totals", (t) => {
  const f = fixture(t);
  const before = f.map();
  f.entry.notes = [note(), note("rust", "not-applicable-to-language")];
  const known = f.map();
  assert.equal(f.row(known).notes.length, 1);
  assert.equal(f.row(known).notes[0].label, "Protected by the library itself (not checked by JGates)");
  assert.equal(f.row(known).notes[0].why, note().why);
  assert.deepEqual(known.totals, before.totals);
  assert.deepEqual([f.row(known).state, f.row(known).code], [f.row(before).state, f.row(before).code]);
  const unknown = f.map({ quality: null }, "pt-BR");
  assert.deepEqual(f.row(unknown).notes.map((n) => n.label), [
    "Protegido pela própria biblioteca (não verificado pelo JGates)", "Não se aplica a esta linguagem",
  ]);
  assert.ok(validate(known), JSON.stringify(validate.errors));
  assert.ok(validate(unknown), JSON.stringify(validate.errors));
  f.entry.status = "pending";
  assert.deepEqual(f.row().notes, []);
  f.entry.status = "owner-reviewed";
  f.entry.checks = [];
  const withNotes = f.map();
  delete f.entry.notes;
  const withoutNotes = f.map();
  assert.deepEqual(withNotes.totals, withoutNotes.totals);
  assert.deepEqual([f.row(withNotes).state, f.row(withNotes).code, f.row(withNotes).suggestion], [f.row(withoutNotes).state, f.row(withoutNotes).code, f.row(withoutNotes).suggestion]);
});

test("the mapping loader and gates reject invalid notes, accept notes without checks and preserve the schema contract", (t) => {
  const f = fixture(t);
  const base = path.join(f.dir, "mapping/5.0.0");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "unmapped-rules.json"), JSON.stringify({ version: "5.0.0", rules: [] }));
  const context = { rules: new Map(), ruleRequirements: new Map(), capabilities: new Set(), attackBlocks: new Set(), methods: new Map() };
  const entry = { ...f.entry, checks: [], notes: [note()] };
  const doc = { version: "5.0.0", chapter: f.input.data.requirements[0].chapter, entries: [entry] };
  const load = () => {
    fs.writeFileSync(path.join(base, "V01.json"), JSON.stringify(doc));
    return asvs.loadMapping("5.0.0", path.dirname(base), ["V1"]);
  };
  assert.ok(validateMappingSchema(doc), JSON.stringify(validateMappingSchema.errors));
  assert.equal(load().entries[0].notes[0].why, note().why);
  const data = { ...f.input.data, requirements: [f.input.data.requirements.find((r) => r.id === entry.requirement)] };
  const gate = () => asvs.validateMapping({ ...f.input.mapping, files: [{ ...doc, file: "V01.json" }], entries: [entry] }, data, context);
  assert.deepEqual(gate(), []);
  for (const notes of [[{ ...note(), language: "unknown" }], [{ ...note(), kind: "safe" }], [{ ...note(), why: "   " }], [{ ...note(), family: "" }], [note(), { ...note(), kind: "not-applicable-to-language" }]]) {
    entry.notes = notes;
    assert.throws(load, asvs.AsvsMappingError);
    assert.ok(gate().length);
  }
  entry.notes = [note(), note("rust")];
  assert.equal(load().entries[0].notes.length, 2);
  assert.ok(validateMappingSchema(doc));
});

test("CLI map text prints the three separate counts, Review label and notes in both languages", (t) => {
  const f = fixture(t);
  f.entry.notes = [note()];
  for (const locale of ["en", "pt-BR"]) {
    let output = "";
    withLocale(locale, () => mapText({ stdout: (text) => { output += text; } }, f.map({}, locale)));
    assert.match(output, locale === "en" ? /\[To review\]/ : /\[Para revisar\]/);
    assert.match(output, locale === "en" ? /0 blocking, 0 informational, 1 to review/ : /0 bloqueantes, 0 informativos, 1 para revisar/);
    assert.ok(output.includes(note().why));
    assert.doesNotMatch(output, /\b(?:compliant|certified)\b|\d+(?:[.,]\d+)?\s*%/i);
  }
});
