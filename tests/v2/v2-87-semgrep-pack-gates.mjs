import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-87: the gates of the bundled Semgrep pack, with no engine.
//   - every rule file has an annotated fixture beside it (ruleid: and ok: for each of its rules);
//   - every rule has the id prefix of its language, a category, a CWE, a subdimension and the author JGates, and none of
//     the metadata keys typical of registry rules;
//   - the index lists every rule of the rule files once;
//   - `jgates tools distribution` passes for the pack, and the record names the engine version the tools image pins;
//   - the pack has rules for the eight languages and an XSS rule for JavaScript, TypeScript and Python (true once the
//     rule slices of the run have landed).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const PACK_ROOT = path.join(root, "jgates", "packs", "semgrep");
const PACK = path.join(PACK_ROOT, "jgates-semgrep");
const RULES = path.join(PACK, "rules");
const adapter = await import(pathToFileURL(path.join(dist, "adapters", "semgrep", "index.js")).href);
const semver = await import(pathToFileURL(path.join(dist, "core", "prepare", "semver.js")).href);

// The closed lists are the file the index and the pack:check command read too (one place, no copy here).
const LISTS = adapter.PACK_LISTS;
const SUBDIMENSIONS = LISTS.subdimensions;
const CATEGORIES = LISTS.categories;
const FORBIDDEN = LISTS.forbiddenMetadata;
const EIGHT = ["javascript", "typescript", "python", "go", "csharp", "rust", "java", "php"];
const asvs = await import(pathToFileURL(path.join(dist, "core", "coverage", "asvs", "index.js")).href);
const REQUIREMENTS = new Set(asvs.loadAsvs("5.0.0").requirements.map((r) => r.id));

const index = adapter.buildPackIndex(RULES);
const files = adapter.listPackRuleFiles(RULES);

test("V2-87: the nine prefixes and the closed lists, with hardening a Security subdimension", () => {
  assert.deepEqual(Object.values(adapter.PACK_LANGUAGE_PREFIX).sort(), ["config", "csharp", "go", "html", "java", "js", "php", "python", "rust"]);
  assert.ok(SUBDIMENSIONS.includes("hardening"));
  assert.deepEqual(LISTS.severities, ["ERROR", "WARNING", "INFO"]);
});

test("V2-87: every rule file has its fixture and every rule has its prefix, category, CWE, subdimension, author and no registry key", () => {
  const families = new Map();
  assert.deepEqual(index.problems, []);
  assert.ok(files.length >= 8, "the pack keeps its eight JavaScript and Python rule files");
  for (const file of files) {
    const stem = path.posix.basename(file).replace(/\.yaml$/, "");
    const dir = path.join(RULES, path.dirname(file));
    assert.ok(fs.readdirSync(dir).some((n) => n.startsWith(`${stem}.`) && !n.endsWith(".yaml")), `${file} has a fixture beside it`);
  }
  for (const rule of index.rules) {
    const prefix = adapter.PACK_LANGUAGE_PREFIX[rule.language];
    assert.ok(prefix, `${rule.file}: a language of the pack`);
    assert.ok(rule.id.startsWith(`jgates.${prefix}.`), `${rule.id}: prefix of ${rule.language}`);
    assert.ok(LISTS.severities.includes(rule.severity), `${rule.id}: severity ${rule.severity}`);
    assert.equal(rule.author, "JGates", `${rule.id}: author`);
    for (const key of FORBIDDEN) assert.ok(!rule.metadataKeys.includes(key), `${rule.id}: ${key}`);
    if (rule.signal !== null) {
      assert.ok(LISTS.signalTags.includes(rule.signal), `${rule.id}: signal`);
      assert.equal(rule.severity, "INFO", `${rule.id}: a signal rule is INFO`);
      assert.deepEqual(rule.metadataKeys, [...LISTS.signalMetadata].sort(), `${rule.id}: signal and author only`);
    } else {
      assert.ok(CATEGORIES.includes(rule.category), `${rule.id}: category`);
      assert.match(rule.cwe, /^CWE-\d+$/, `${rule.id}: CWE`);
      assert.ok(SUBDIMENSIONS.includes(rule.subdimension), `${rule.id}: subdimension`);
      assert.deepEqual(rule.metadataKeys, [...LISTS.ruleMetadata].sort(), `${rule.id}: the metadata keys of a rule`);
      assert.ok(rule.asvsRequirements.length > 0, `${rule.id}: asvs_requirements`);
      for (const req of rule.asvsRequirements) assert.ok(REQUIREMENTS.has(req), `${rule.id}: ${req} exists in the vendored data`);
      const kind = `${rule.category} ${rule.cwe}`;
      if (!families.has(rule.family)) families.set(rule.family, { kind, id: rule.id });
      assert.equal(families.get(rule.family).kind, kind, `${rule.id}: the family ${rule.family} keeps its category and CWE (see ${families.get(rule.family).id})`);
    }
    assert.ok(rule.fixture, `${rule.id}: fixture`);
    const fixture = fs.readFileSync(path.join(RULES, rule.fixture), "utf8");
    const id = rule.id.replace(/[.]/g, "\\.");
    assert.match(fixture, new RegExp(`ruleid:\\s*${id}(?![\\w.-])`), `${rule.id}: ruleid case`);
    assert.match(fixture, new RegExp(`\\bok:\\s*${id}(?![\\w.-])`), `${rule.id}: ok case`);
  }
});

test("V2-87: the index lists every rule of the rule files once", () => {
  const ids = index.rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "no id twice");
  const declared = files.flatMap((f) => [...fs.readFileSync(path.join(RULES, f), "utf8").matchAll(/^\s*-\s+id:\s*(\S+)/gm)].map((m) => m[1]));
  assert.deepEqual([...ids].sort(), [...declared].sort());
  assert.ok(ids.length >= 24);
  assert.deepEqual([...new Set(index.rules.map((r) => r.file))].sort(), files);
});

test("V2-87: the distribution check passes for the pack and its record names the version the image pins", () => {
  const run = spawnSync(process.execPath, [MAIN, "tools", "distribution", "--packs", PACK_ROOT, "--json"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const pack = (JSON.parse(run.stdout).report?.packs ?? []).find((p) => p.id === "jgates-semgrep-rules");
  assert.ok(pack, run.stdout.slice(0, 400));
  assert.equal(pack.ok, true, JSON.stringify(pack.problems));
  const record = JSON.parse(fs.readFileSync(path.join(PACK, "jgates-pack.json"), "utf8"));
  const pin = JSON.parse(fs.readFileSync(path.join(root, "jgates", "release", "image-tools.json"), "utf8")).tools.semgrep;
  assert.match(pin, /^\d+\.\d+\.\d+$/);
  assert.equal(record.engine.version, pin, "the record names the pinned engine version");
  assert.equal(semver.satisfiesRange(pin, `>=${record.engine.minimum}`), true, "the pin satisfies the pack minimum");
});

test("V2-87: the pack has rules for the eight languages and an XSS rule for JavaScript, TypeScript and Python", () => {
  const covered = new Set(index.rules.flatMap((r) => r.languages));
  for (const language of EIGHT) assert.ok(covered.has(language), `a rule for ${language}`);
  for (const language of ["javascript", "typescript", "python"]) {
    assert.ok(index.rules.some((r) => r.category === "xss" && r.languages.includes(language)), `an XSS rule for ${language}`);
  }
});
