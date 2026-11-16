import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-96: the gates of the bundled Semgrep pack in its nine-language layout, with no engine.
//   - the nine prefixes; every rule's category, subdimension and severity from the closed lists (read from the one file
//     the index and the pack:check command read too);
//   - the same family name has the same category and CWE in every language;
//   - every rule that is not a signal has `asvs_requirements` naming requirements of the vendored data;
//   - a signal rule is INFO, has `signal` from the closed list of tags and `author` and nothing else, and has a fixture
//     with a match and a non-match;
//   - the two-way agreement between `asvs_requirements` and the mapping, with `unmapped-rules.json` for refused pairs;
//   - no forbidden registry key; a rule file under `rules/html/` or `rules/config/` is accepted;
//   - `jgates tools distribution` passes for the pack.
// The two-way agreement of the whole pack is red while the rule tasks of the run write rules and until the mapping tasks
// have mapped them: that is expected until the end of the run.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const PACK_ROOT = path.join(root, "jgates", "packs", "semgrep");
const RULES = path.join(PACK_ROOT, "jgates-semgrep", "rules");
const adapter = await import(pathToFileURL(path.join(dist, "adapters", "semgrep", "index.js")).href);
const asvs = await import(pathToFileURL(path.join(dist, "core", "coverage", "asvs", "index.js")).href);

const LISTS = adapter.PACK_LISTS;
const REQUIREMENTS = new Set(asvs.loadAsvs("5.0.0").requirements.map((r) => r.id));
const NINE = { javascript: "js", python: "python", go: "go", csharp: "csharp", rust: "rust", java: "java", php: "php", html: "html", config: "config" };

/** The problems of a list of indexed rules against the gates of the pack; one line each, empty when sound. */
function gateProblems(rules) {
  const problems = [];
  const families = new Map();
  for (const rule of rules) {
    const prefix = adapter.PACK_LANGUAGE_PREFIX[rule.language];
    if (!prefix) problems.push(`${rule.file}: ${rule.language} is not a language of the pack`);
    else if (!rule.id.startsWith(`jgates.${prefix}.`)) problems.push(`${rule.id}: prefix of ${rule.language}`);
    if (!LISTS.severities.includes(rule.severity)) problems.push(`${rule.id}: severity ${rule.severity}`);
    if (rule.author !== "JGates") problems.push(`${rule.id}: author`);
    for (const key of LISTS.forbiddenMetadata) if (rule.metadataKeys.includes(key)) problems.push(`${rule.id}: forbidden key ${key}`);
    if (rule.signal !== null) {
      if (!LISTS.signalTags.includes(rule.signal)) problems.push(`${rule.id}: signal ${rule.signal} is not in the closed list`);
      if (rule.severity !== "INFO") problems.push(`${rule.id}: a signal rule is INFO`);
      if (JSON.stringify(rule.metadataKeys) !== JSON.stringify([...LISTS.signalMetadata].sort())) problems.push(`${rule.id}: a signal rule carries signal and author only`);
      continue;
    }
    if (!LISTS.categories.includes(rule.category)) problems.push(`${rule.id}: category ${rule.category}`);
    if (!/^CWE-\d+$/.test(rule.cwe)) problems.push(`${rule.id}: CWE ${rule.cwe}`);
    if (!LISTS.subdimensions.includes(rule.subdimension)) problems.push(`${rule.id}: subdimension ${rule.subdimension}`);
    if (JSON.stringify(rule.metadataKeys) !== JSON.stringify([...LISTS.ruleMetadata].sort())) problems.push(`${rule.id}: metadata keys ${rule.metadataKeys.join(",")}`);
    if (rule.asvsRequirements.length === 0) problems.push(`${rule.id}: no asvs_requirements`);
    for (const req of rule.asvsRequirements) if (!REQUIREMENTS.has(req)) problems.push(`${rule.id}: ${req} is not a requirement of the vendored data`);
    const kind = `${rule.category} ${rule.cwe}`;
    if (!families.has(rule.family)) families.set(rule.family, { kind, id: rule.id });
    else if (families.get(rule.family).kind !== kind) problems.push(`${rule.id}: the family ${rule.family} has another category or CWE than ${families.get(rule.family).id}`);
  }
  return problems;
}

const rule = (over = {}) => ({
  id: "jgates.go.sample", language: "go", languages: ["go"], category: "injection", cwe: "CWE-89", subdimension: "injection", author: "JGates", severity: "ERROR",
  file: "go/go-sample.yaml", fixture: "go/go-sample.go", metadataKeys: ["asvs_requirements", "author", "category", "cwe", "subdimension"], family: "sample", asvsRequirements: ["V1.2.4"], signal: null, ...over,
});
const signal = (over = {}) => rule({ id: "jgates.go.uses-jwt", family: "uses-jwt", category: "", cwe: "", subdimension: "", severity: "INFO", metadataKeys: ["author", "signal"], asvsRequirements: [], signal: "jwt", ...over });

/** A throwaway pack folder with the given rule files (relative path to YAML text) and their fixtures. */
function tmpRules(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-v296-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test("V2-96: the nine prefixes, and the closed lists have the new categories, hardening and the three severities", () => {
  assert.deepEqual(adapter.PACK_LANGUAGE_PREFIX, NINE);
  for (const category of ["authentication", "session", "cookie", "cors", "transport", "file-handling", "logging", "error-handling", "configuration", "data-exposure", "availability"]) assert.ok(LISTS.categories.includes(category), category);
  assert.ok(LISTS.subdimensions.includes("hardening"));
  assert.deepEqual(LISTS.severities, ["ERROR", "WARNING", "INFO"]);
  assert.equal(LISTS.signalTags.length, 17);
});

test("V2-96: every rule of the bundled pack passes the gates", () => {
  const index = adapter.buildPackIndex(RULES);
  assert.deepEqual(index.problems, []);
  assert.ok(index.rules.length >= 89);
  assert.deepEqual(gateProblems(index.rules), []);
  for (const r of index.rules) {
    assert.ok(r.fixture, `${r.id}: a fixture beside the rule file`);
    // A rule file may have a fixture per extension (.js, .jsx, .ts): the cases of a rule may sit in any of them.
    const fixture = r.fixtures.map((f) => fs.readFileSync(path.join(RULES, f), "utf8")).join("\n");
    const id = r.id.replace(/[.]/g, "\\.");
    assert.match(fixture, new RegExp(`ruleid:\\s*${id}(?![\\w.-])`), `${r.id}: a match case`);
    assert.match(fixture, new RegExp(`\\bok:\\s*${id}(?![\\w.-])`), `${r.id}: a non-match case`);
  }
});

test("V2-96: the gates refuse an unknown category, subdimension or severity, a stray key, an unknown requirement and a family that changes", () => {
  assert.deepEqual(gateProblems([rule()]), []);
  assert.match(gateProblems([rule({ category: "made-up" })]).join("\n"), /category made-up/);
  assert.match(gateProblems([rule({ subdimension: "made-up" })]).join("\n"), /subdimension made-up/);
  assert.match(gateProblems([rule({ severity: "CRITICAL" })]).join("\n"), /severity CRITICAL/);
  assert.match(gateProblems([rule({ severity: "HIGH" })]).join("\n"), /severity HIGH/);
  assert.match(gateProblems([rule({ metadataKeys: ["asvs_requirements", "author", "category", "confidence", "cwe", "subdimension"] })]).join("\n"), /forbidden key confidence/);
  assert.match(gateProblems([rule({ metadataKeys: ["author", "category", "cwe", "subdimension"], asvsRequirements: [] })]).join("\n"), /no asvs_requirements/);
  assert.match(gateProblems([rule({ asvsRequirements: ["V99.9.9"] })]).join("\n"), /V99\.9\.9 is not a requirement/);
  assert.match(gateProblems([rule({ language: "kotlin" })]).join("\n"), /not a language of the pack/);
  assert.match(gateProblems([rule({ id: "jgates.php.sample" })]).join("\n"), /prefix of go/);
  const sameFamily = [rule(), rule({ id: "jgates.java.sample", language: "java", cwe: "CWE-78" })];
  assert.match(gateProblems(sameFamily).join("\n"), /the family sample has another category or CWE/);
  assert.deepEqual(gateProblems([rule(), rule({ id: "jgates.java.sample", language: "java" })]), []);
});

test("V2-96: a signal rule is INFO with signal and author only, the tag from the closed list", () => {
  assert.deepEqual(gateProblems([signal()]), []);
  assert.match(gateProblems([signal({ signal: "made-up" })]).join("\n"), /not in the closed list/);
  assert.match(gateProblems([signal({ severity: "WARNING" })]).join("\n"), /a signal rule is INFO/);
  assert.match(gateProblems([signal({ metadataKeys: ["author", "category", "signal"] })]).join("\n"), /signal and author only/);
  assert.match(gateProblems([signal({ metadataKeys: ["signal"] })]).join("\n"), /signal and author only/);
});

test("V2-96: the index reads signal rules and a rule file under rules/html/ or rules/config/, and records the signal pairs", () => {
  const dir = tmpRules({
    "html/html-markup.yaml": 'rules:\n  - id: jgates.html.sample-handler\n    message: m\n    severity: WARNING\n    languages: [html]\n    pattern: <b onclick=...>...</b>\n    metadata:\n      category: xss\n      cwe: "CWE-79"\n      author: JGates\n      subdimension: injection\n      asvs_requirements: ["V3.2.2"]\n',
    "html/html-markup.html": "<!-- ruleid: jgates.html.sample-handler -->\n<b onclick=\"x()\">x</b>\n<!-- ok: jgates.html.sample-handler -->\n<b>x</b>\n",
    "config/config-server.yaml": 'rules:\n  - id: jgates.config.sample-flag\n    message: m\n    severity: INFO\n    languages: [generic]\n    pattern: debug = true\n    metadata:\n      category: configuration\n      cwe: "CWE-489"\n      author: JGates\n      subdimension: hardening\n      asvs_requirements: ["V13.4.2"]\n',
    "config/config-server.conf": "# ruleid: jgates.config.sample-flag\ndebug = true\n# ok: jgates.config.sample-flag\ndebug = false\n",
    "go/go-signals.yaml": "rules:\n  - id: jgates.go.uses-jwt\n    message: m\n    severity: INFO\n    languages: [go]\n    pattern: jwt.New(...)\n    metadata:\n      signal: jwt\n      author: JGates\n",
    "go/go-signals.go": "package x\n// ruleid: jgates.go.uses-jwt\nvar a = jwt.New(1)\n// ok: jgates.go.uses-jwt\nvar b = other.New(1)\n",
  });
  try {
    const index = adapter.buildPackIndex(dir);
    assert.deepEqual(index.problems, []);
    assert.deepEqual(index.rules.map((r) => [r.id, r.language]).sort(), [["jgates.config.sample-flag", "config"], ["jgates.go.uses-jwt", "go"], ["jgates.html.sample-handler", "html"]]);
    assert.deepEqual(gateProblems(index.rules), []);
    assert.deepEqual(index.signals, [{ language: "go", tag: "jwt" }]);
    assert.deepEqual(adapter.packLanguagesOf(adapter.listPackRuleFiles(dir)), ["go", "html", "config"]);
    const html = index.rules.find((r) => r.language === "html");
    assert.deepEqual(html.asvsRequirements, ["V3.2.2"]);
    assert.equal(html.family, "sample-handler");
    assert.ok(index.rules.every((r) => r.fixture));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("V2-96: HTML files and configuration files are two kinds of file of the scanned-languages record", () => {
  const counts = adapter.scannedLanguageCounts(["/w/a.html", "/w/b.htm", "/w/nginx.conf", "/w/web.config", "/w/.htaccess", "/w/application.yml", "/w/appsettings.json", "/w/x.json", "/w/y.yml"], ["html", "config", "go"]);
  assert.deepEqual(counts, { html: 2, config: 5, go: 0 });
});

test("V2-96: the two-way agreement between asvs_requirements and the mapping, with unmapped-rules.json for refused pairs", () => {
  const context = asvs.buildMappingContext();
  const mapping = asvs.loadMapping("5.0.0");
  assert.ok(context.ruleRequirements.size > 0);
  assert.deepEqual(asvs.validateRuleRequirements(mapping, context), []);
  const [ruleId, stated] = [...context.ruleRequirements.entries()][0];
  const outside = [...REQUIREMENTS].find((id) => !stated.includes(id));
  const widened = { ...context, ruleRequirements: new Map(context.ruleRequirements).set(ruleId, [...stated, outside]) };
  assert.match(asvs.validateRuleRequirements(mapping, widened).join("\n"), /was written for/);
  const refused = structuredClone(mapping);
  refused.unmappedRules.rules.push({ id: ruleId, requirement: outside, reason: "No check of the rule bears on this requirement." });
  assert.deepEqual(asvs.validateRuleRequirements(refused, widened), []);
  const stray = structuredClone(mapping);
  const entry = stray.entries.find((e) => e.requirement === outside);
  Object.assign(entry, { status: "pending", evidence: "repository", subdimensions: [context.rules.get(ruleId)], why: "It bears on the requirement for a reason of its own.", checks: [{ unit: "semgrep-rule", id: ruleId, covers: "a construct the rule matches", misses: "constructs it does not model", depth: "partial" }] });
  assert.match(asvs.validateRuleRequirements(stray, context).join("\n"), /names rule/);
});

test("V2-96: the distribution check passes for the pack", () => {
  const run = spawnSync(process.execPath, [MAIN, "tools", "distribution", "--packs", PACK_ROOT, "--json"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const pack = (JSON.parse(run.stdout).report?.packs ?? []).find((p) => p.id === "jgates-semgrep-rules");
  assert.ok(pack, run.stdout.slice(0, 400));
  assert.equal(pack.ok, true, JSON.stringify(pack.problems));
});
