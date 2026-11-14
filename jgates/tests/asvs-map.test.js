import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// The ASVS 5.0.0 data and the mapping pack, with no engine: the official release file is shipped unchanged (hash,
// counts, levels), the loader groups it, the skeleton mapping has one entry per requirement and claims nothing, and
// the gates refuse an entry that names an unknown rule, capability or attack class, count a pending entry for
// nothing, refuse a string that repeats the official text, and make every pack rule mapped or listed with a reason.

const here = path.dirname(fileURLToPath(import.meta.url));
const JGATES = path.resolve(here, "..");
const dist = path.join(JGATES, "dist");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const asvs = await import(pathToFileURL(path.join(dist, "core", "coverage", "asvs", "index.js")).href);
const distribution = await import(pathToFileURL(path.join(dist, "core", "distribution", "index.js")).href);

const DATA_DIR = path.join(JGATES, "vendor", "owasp-asvs");
const DATA_FILE = path.join(DATA_DIR, "5.0.0", "OWASP_Application_Security_Verification_Standard_5.0.0_en.flat.json");
const MAP_DIR = path.join(JGATES, "packs", "asvs", "jgates-asvs-map");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const data = asvs.loadAsvs("5.0.0");
const context = asvs.buildMappingContext();
const mapping = () => structuredClone(asvs.loadMapping("5.0.0"));
const find = (m, id) => m.entries.find((e) => e.requirement === id);

const firstRule = [...context.rules.entries()][0];
const goodCheck = (over = {}) => ({ unit: "semgrep-rule", id: firstRule[0], covers: "a construct the rule matches", misses: "constructs it does not model", depth: "partial", ...over });
const withEntry = (m, id, status, checks, subdimensions = [firstRule[1]]) => {
  const e = find(m, id);
  Object.assign(e, { status, checks, subdimensions, evidence: "repository", why: "The rule flags a construct that bears on the requirement." });
  return m;
};

test("the release file is the pinned one: hash in the loader, in the record and on disk", () => {
  const bytes = fs.readFileSync(DATA_FILE);
  assert.equal(sha256(bytes.includes(0) ? bytes : Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")), "8201b20eec2908c3380ac600c91c8ba746346fbb808859366abb232027532311");
  assert.equal(asvs.ASVS_RELEASES["5.0.0"].sha256, "8201b20eec2908c3380ac600c91c8ba746346fbb808859366abb232027532311");
  assert.equal(readJson(path.join(DATA_DIR, "jgates-pack.json")).release.fileSha256, asvs.ASVS_RELEASES["5.0.0"].sha256);
  assert.match(fs.readFileSync(path.join(DATA_DIR, "NOTICE.md"), "utf8"), /8201b20eec2908c3380ac600c91c8ba746346fbb808859366abb232027532311/);
});

test("a data file that is not the pinned release file is refused", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-asvs-"));
  try {
    fs.mkdirSync(path.join(tmp, "5.0.0"));
    const text = fs.readFileSync(DATA_FILE, "utf8").replace("Verify that", "Verify what");
    fs.writeFileSync(path.join(tmp, "5.0.0", path.basename(DATA_FILE)), text);
    assert.throws(() => asvs.loadAsvs("5.0.0", tmp), asvs.AsvsDataError);
    assert.throws(() => asvs.loadAsvs("9.9.9"), asvs.AsvsDataError);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the loader returns the versions, 17 chapters, 80 sections, 345 requirements and 70, 253 and 345 rows at levels 1, 2 and 3", () => {
  assert.deepEqual(asvs.listAsvsVersions(), ["5.0.0"]);
  assert.equal(data.chapters.length, 17);
  assert.equal(data.chapters.reduce((n, c) => n + c.sections.length, 0), 80);
  assert.equal(data.requirements.length, 345);
  assert.deepEqual(asvs.asvsLevelCounts(data), { 1: 70, 2: 253, 3: 345 });
  assert.deepEqual(data.requirements.map((r) => r.level).filter((l, i, a) => a.indexOf(l) === i).sort(), [1, 2, 3]);
  assert.equal(new Set(data.requirements.map((r) => r.id)).size, 345);
  assert.equal(data.source.licence, "CC BY-SA 4.0");
  assert.match(data.source.attribution, /OWASP ASVS 5\.0\.0.*The OWASP Foundation.*CC BY-SA 4\.0/);
});

test("the loader filters by level and chapter, and drops the sections that end up empty", () => {
  const v6 = asvs.asvsRequirements(data, { chapter: "V6" });
  assert.equal(v6.length, 47);
  assert.ok(v6.every((r) => r.chapter === "V6"));
  assert.ok(asvs.asvsRequirements(data, { chapter: "V6", level: 1 }).length < 47);
  const tree = asvs.asvsTree(data, { level: 1 });
  assert.equal(tree.flatMap((c) => c.sections.flatMap((s) => s.requirements)).length, 70);
  assert.ok(tree.every((c) => c.sections.length > 0 && c.sections.every((s) => s.requirements.length > 0)));
  assert.ok(tree.flatMap((c) => c.sections.flatMap((s) => s.requirements)).every((r) => r.level === 1));
});

test("the mapping has V01 to V17, exactly one entry per requirement, none with a check, and no gate problem", () => {
  const m = mapping();
  assert.equal(m.files.length, 17);
  assert.equal(m.entries.length, 345);
  assert.deepEqual(m.entries.map((e) => e.requirement).sort(), data.requirements.map((r) => r.id).sort());
  for (const e of m.entries) {
    assert.deepEqual(e.checks, []);
    assert.equal(e.status, "unmapped");
    assert.deepEqual(asvs.countedChecks(e), []);
  }
  assert.deepEqual(asvs.validateMapping(m, data, context), []);
});

test("the chapter files and the unmapped-rules file validate against their schemas", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validateMap = ajv.compile(readJson(path.join(JGATES, "schemas", "coverage", "asvs-map.schema.json")));
  const validateRules = ajv.compile(readJson(path.join(JGATES, "schemas", "coverage", "asvs-unmapped-rules.schema.json")));
  for (let n = 1; n <= 17; n++) {
    const file = `V${String(n).padStart(2, "0")}.json`;
    assert.ok(validateMap(readJson(path.join(MAP_DIR, "5.0.0", file))), `${file}: ${ajv.errorsText(validateMap.errors)}`);
  }
  assert.ok(validateRules(readJson(path.join(MAP_DIR, "5.0.0", "unmapped-rules.json"))), ajv.errorsText(validateRules.errors));
  const ok = { version: "5.0.0", chapter: "V1", entries: [{ requirement: "V1.1.1", status: "unmapped", evidence: null, subdimensions: [], checks: [] }] };
  assert.ok(validateMap(ok));
  assert.ok(!validateMap({ ...ok, entries: [{ ...ok.entries[0], checks: [goodCheck()] }] }), "an unmapped entry cannot carry a check");
  assert.ok(!validateMap({ ...ok, entries: [{ ...ok.entries[0], status: "pending" }] }), "a pending entry needs a check");
  assert.ok(!validateMap({ ...ok, entries: [{ ...ok.entries[0], text: "x" }] }), "an entry has no text field");
});

test("an entry naming an unknown rule, capability or attack class is refused; a sound one is accepted", () => {
  const sound = withEntry(mapping(), "V1.1.1", "pending", [goodCheck()]);
  assert.deepEqual(asvs.validateMapping(sound, data, context), []);
  const bad = (check, subdimensions) => asvs.validateMapping(withEntry(mapping(), "V1.1.1", "pending", [check], subdimensions), data, context);
  assert.match(bad(goodCheck({ id: "jgates.python.no-such-rule" })).join("\n"), /unknown rule jgates\.python\.no-such-rule/);
  assert.match(bad(goodCheck({ unit: "capability", id: "nothing#nowhere" })).join("\n"), /unknown capability nothing#nowhere/);
  assert.match(bad(goodCheck({ unit: "semantic-ledger", id: "ATTACK-CLASSES.md#No such class" })).join("\n"), /unknown attack class/);
  assert.match(bad(goodCheck({ unit: "semantic-method", id: "no-such-method" })).join("\n"), /unknown Semantic method/);
  assert.match(bad(goodCheck({ unit: "semantic-method", id: "insecure-defaults", category: "no-such-category" })).join("\n"), /no category/);
  assert.match(bad(goodCheck(), []).join("\n"), /subdimension/, "a rule's own subdimension must be carried by the entry");
  assert.match(bad(goodCheck({ covers: "" })).join("\n"), /missing covers/);
  const known = [...context.attackBlocks][0];
  if (known) assert.deepEqual(bad(goodCheck({ unit: "semantic-ledger", id: known })), []);
  const capability = [...context.capabilities][0];
  if (capability) assert.deepEqual(bad(goodCheck({ unit: "capability", id: capability })), []);
  assert.match(asvs.validateMapping(withEntry(mapping(), "V1.1.1", "unmapped", [goodCheck()]), data, context).join("\n"), /unmapped but has checks/);
  const unknown = mapping();
  unknown.files[0].entries.push({ requirement: "V1.99.99", status: "unmapped", evidence: null, subdimensions: [], checks: [] });
  assert.match(asvs.validateMapping(unknown, data, context).join("\n"), /V1\.99\.99: unknown requirement/);
  const missing = mapping();
  missing.files[0].entries.pop();
  missing.entries = missing.files.flatMap((f) => f.entries);
  assert.match(asvs.validateMapping(missing, data, context).join("\n"), /no entry/);
});

test("a pending entry counts for nothing; reviewed and owner-reviewed entries count their checks", () => {
  const m = withEntry(mapping(), "V1.1.1", "pending", [goodCheck()]);
  assert.deepEqual(asvs.countedChecks(find(m, "V1.1.1")), []);
  assert.equal(asvs.countedChecks(withEntry(mapping(), "V1.1.1", "reviewed", [goodCheck()]).entries.find((e) => e.requirement === "V1.1.1")).length, 1);
  assert.equal(asvs.countedChecks(withEntry(mapping(), "V1.1.1", "owner-reviewed", [goodCheck()]).entries.find((e) => e.requirement === "V1.1.1")).length, 1);
  assert.deepEqual(asvs.countedChecks({ ...find(mapping(), "V1.1.1"), status: "unmapped" }), []);
});

test("no mapping string repeats a requirement's text, and one that does is refused", () => {
  const texts = data.requirements.map((r) => r.text);
  for (const e of asvs.loadMapping("5.0.0").entries) for (const v of [e.why ?? "", ...e.checks.flatMap((c) => [c.covers, c.misses])]) assert.equal(asvs.repeatsRequirementText(v, texts), false);
  const text = data.requirements.find((r) => r.id === "V1.2.4").text;
  const quoted = withEntry(mapping(), "V1.2.4", "pending", [goodCheck({ covers: `The rule makes sure that: ${text}` })]);
  assert.match(asvs.validateMapping(quoted, data, context).join("\n"), /repeats a requirement text/);
  const partial = withEntry(mapping(), "V1.2.4", "pending", [goodCheck({ misses: text.split(" ").slice(2, 14).join(" ") })]);
  assert.match(asvs.validateMapping(partial, data, context).join("\n"), /repeats a requirement text/);
  assert.equal(asvs.repeatsRequirementText("SQL text built by formatting and passed to execute()", texts), false);
});

test("every pack rule is mapped or listed in unmapped-rules.json with a reason", () => {
  const m = mapping();
  assert.ok(context.rules.size > 0, "the pack has rules");
  const listed = new Set(m.unmappedRules.rules.map((r) => r.id));
  for (const id of context.rules.keys()) assert.ok(listed.has(id), `${id} is listed as unmapped`);
  for (const r of m.unmappedRules.rules) assert.ok(r.reason.trim().length > 0, `${r.id} has a reason`);
  const forgotten = mapping();
  forgotten.unmappedRules.rules.shift();
  assert.match(asvs.validateMapping(forgotten, data, context).join("\n"), /neither mapped nor listed/);
  const noReason = mapping();
  noReason.unmappedRules.rules[0].reason = " ";
  assert.match(asvs.validateMapping(noReason, data, context).join("\n"), /has no reason/);
  const mapped = withEntry(mapping(), "V1.1.1", "pending", [goodCheck()]);
  mapped.unmappedRules.rules = mapped.unmappedRules.rules.filter((r) => r.id !== firstRule[0]);
  assert.equal(asvs.validateMapping(mapped, data, context).some((p) => p.includes("neither mapped nor listed")), false, "a mapped rule needs no listing");
});

test("the distribution check accepts the data folder and the mapping pack", () => {
  const report = distribution.checkDistribution({ packs: [DATA_DIR, MAP_DIR] });
  assert.deepEqual(report.problems, []);
  assert.ok(report.ok);
  assert.deepEqual(report.packs.map((p) => p.id), ["owasp-asvs", "jgates-asvs-map"]);
  assert.equal(report.packs[0].record.spdx, "CC-BY-SA-4.0");
  assert.match(fs.readFileSync(path.join(DATA_DIR, "LICENSE"), "utf8"), /Attribution-ShareAlike 4\.0 International/);
});
