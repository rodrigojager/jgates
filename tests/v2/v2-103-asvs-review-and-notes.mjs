import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as asvs from "../../jgates/dist/core/coverage/asvs/index.js";
import { withLocale } from "../../jgates/dist/i18n/index.js";
import { mapText } from "../../jgates/dist/cli/commands/coverage.js";

// V2-103 (no engine): a fixture pack and mapping, and Quality records read from disk.
// Review-only never examines, mixed blocking/Review does; all three counts are separate,
// reviewed occurrences are not open, and notes are reviewed, localized language information
// that never changes state, code, suggestions or totals. Unknown project languages hide nothing.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020").default;
const schema = JSON.parse(fs.readFileSync(path.join(root, "jgates/schemas/coverage/asvs.schema.json"), "utf8"));
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);

test("V2-103: stored runs, Review-only and mixed checks, reviewed findings and language notes", (t) => {
  const scratch = path.resolve(root, "../_work/00-tmp");
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "v2-103-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const rulesDir = path.join(dir, "rules");
  const ruleFile = path.join(rulesDir, "javascript/fixture.yaml");
  const yaml = `rules:
  - id: jgates.js.fixture-default
    languages: [javascript]
    severity: INFO
    pattern: defaultCall($X)
    message: Inspect the default.
    metadata: {class: review, category: xxe, subdimension: injection, cwe: CWE-611, author: JGates}
  - id: jgates.js.fixture-explicit
    languages: [javascript]
    severity: WARNING
    pattern: unsafeCall($X)
    message: Explicit unsafe call.
    metadata: {category: xxe, subdimension: injection, cwe: CWE-611, author: JGates}
`;
  fs.mkdirSync(path.dirname(ruleFile), { recursive: true });
  fs.writeFileSync(ruleFile, yaml);
  const data = asvs.loadAsvs();
  const target = asvs.asvsRequirements(data, { level: 1 })[0];
  const check = (id) => ({ unit: "semgrep-rule", id: `jgates.js.fixture-${id}`, covers: "a local construct", misses: "behaviour elsewhere", depth: "partial" });
  const notes = [
    { language: "javascript", family: "xml", kind: "protected-by-library", why: "The fixture parser does not resolve external entities." },
    { language: "rust", family: "format", kind: "not-applicable-to-language", why: "The fixture language checks format strings at compile time." },
  ];
  const entry = { requirement: target.id, status: "reviewed", evidence: "repository", subdimensions: ["injection"], checks: [check("default")], notes, why: "A default needs human attention." };
  const mapDir = path.join(dir, "mapping");
  const saveMapping = () => {
    write(path.join(mapDir, "5.0.0/V01.json"), { version: "5.0.0", chapter: "V1", entries: [entry] });
    write(path.join(mapDir, "5.0.0/unmapped-rules.json"), { version: "5.0.0", rules: [] });
    return asvs.loadMapping("5.0.0", mapDir, ["V1"]);
  };
  const runDir = path.join(dir, "stored-run");
  const finding = (id, extra) => ({ stageId: "semgrep#sast", ruleId: `jgates.js.fixture-${id}`, ...extra });
  const result = {
    runId: "fixture-run", decision: "passed", complete: true,
    stages: [{ id: "semgrep#sast", adapter: "semgrep", state: "completed", interpreted: true, scannedLanguages: { javascript: 1 } }],
    findings: [finding("default", { review: true, blocking: false }), finding("default", { review: true, blocking: false, waived: true }), finding("explicit", { blocking: true })],
  };
  write(path.join(runDir, "result.json"), result);
  write(path.join(runDir, "plan.json"), { groups: { willRun: [{
    id: "semgrep#sast", adapter: "semgrep", capabilities: ["sast"], languages: ["javascript"],
    configFiles: [{ file: "/opt/jgates/packs/semgrep/jgates-semgrep/rules/javascript/fixture.yaml", sha256: `sha256:${crypto.createHash("sha256").update(yaml).digest("hex")}` }],
  }], notApplicableOrDisabled: [] } });
  const resolve = (locale = "en", quality = asvs.readQualityRunRecord(runDir)) => withLocale(locale, () => {
    const map = asvs.resolveAsvsMap({ data, mapping: saveMapping(), quality, semantic: [], decisions: null, rulesDir, matrixRows: [] });
    assert.ok(validate(map), JSON.stringify(validate.errors));
    return map;
  });
  const row = (map) => map.requirements.find((r) => r.id === target.id);
  const only = resolve();
  assert.deepEqual([row(only).state, row(only).code], ["unsupported", "UNSUPPORTED_REVIEW_ONLY"]);
  assert.match(row(only).reason, /fixture-default.*ran/);
  assert.deepEqual([row(only).checks[0].class, row(only).checks[0].openBlocking, row(only).checks[0].openInformational, row(only).checks[0].openReview], ["review", 0, 0, 1]);
  assert.deepEqual(row(only).notes.map((n) => [n.language, n.label, n.why]), [["javascript", "Protected by the library itself (not checked by JGates)", notes[0].why]]);
  const unknown = resolve("pt-BR", null);
  assert.deepEqual(row(unknown).notes.map((n) => n.label), ["Protegido pela própria biblioteca (não verificado pelo JGates)", "Não se aplica a esta linguagem"]);
  delete entry.notes;
  const without = resolve();
  assert.deepEqual(only.totals, without.totals);
  assert.deepEqual([row(only).state, row(only).code, row(only).suggestion], [row(without).state, row(without).code, row(without).suggestion]);
  entry.notes = notes;
  entry.status = "pending";
  assert.deepEqual(row(resolve()).notes, []);
  entry.status = "reviewed";
  entry.checks.push(check("explicit"));
  assert.equal(row(resolve()).state, "examined");
  result.findings[0].waived = true;
  write(path.join(runDir, "result.json"), result);
  assert.equal(row(resolve()).checks[0].openReview, 0);
  result.findings[0].waived = false;
  write(path.join(runDir, "result.json"), result);
  for (const locale of ["en", "pt-BR"]) {
    let output = "";
    withLocale(locale, () => mapText({ stdout: (line) => { output += line; } }, resolve(locale)));
    assert.match(output, locale === "en" ? /\[To review\]/ : /\[Para revisar\]/);
    assert.match(output, locale === "en" ? /0 blocking, 0 informational, 1 to review/ : /0 bloqueantes, 0 informativos, 1 para revisar/);
    assert.doesNotMatch(output, /\b(?:compliant|certified)\b|\d+(?:[.,]\d+)?\s*%/i);
  }
});
