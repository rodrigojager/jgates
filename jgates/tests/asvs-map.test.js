import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// The ASVS 5.0.0 data and the mapping pack, with no engine: the official release file is shipped unchanged (hash,
// counts, levels), the loader groups it, the mapping has one entry per requirement and every entry that names a check
// was reviewed, and the gates refuse an entry that names an unknown rule, capability or attack class, count a pending
// entry for nothing, refuse a string that repeats the official text, and make every pack rule mapped or listed with a
// reason (the shipped list names exactly the rules no entry names).

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

test("the mapping has V01 to V17, exactly one entry per requirement, no pending entry with a check, and no gate problem", () => {
  const m = mapping();
  assert.equal(m.files.length, 17);
  assert.equal(m.entries.length, 345);
  assert.deepEqual(m.entries.map((e) => e.requirement).sort(), data.requirements.map((r) => r.id).sort());
  for (const e of m.entries) {
    if (e.checks.length === 0) {
      assert.ok(e.status === "unmapped" || ((e.status === "reviewed" || e.status === "owner-reviewed") && (e.applies || e.notes?.length)), `${e.requirement} has no check, so it is unmapped or a reviewed entry with applies or notes`);
      assert.deepEqual(asvs.countedChecks(e), []);
    } else {
      assert.ok(e.status === "reviewed" || e.status === "owner-reviewed", `${e.requirement} is ${e.status}`);
      assert.ok(e.review && e.review.by.trim() !== "" && /^\d{4}-\d{2}-\d{2}$/.test(e.review.date), `${e.requirement} records its review`);
      assert.equal(asvs.countedChecks(e).length, e.checks.length);
    }
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
  const sound = withEntry(mapping(), "V1.5.3", "pending", [goodCheck()]);
  assert.deepEqual(asvs.validateMapping(sound, data, context), []);
  const bad = (check, subdimensions) => asvs.validateMapping(withEntry(mapping(), "V1.5.3", "pending", [check], subdimensions), data, context);
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
  // The shipped list names exactly the rules no entry names.
  const named = new Set(m.entries.flatMap((e) => e.checks.filter((c) => c.unit === "semgrep-rule").map((c) => c.id)));
  const listed = new Set(m.unmappedRules.rules.filter((r) => !r.requirement).map((r) => r.id));
  for (const id of context.rules.keys()) assert.ok(named.has(id) !== listed.has(id), `${id} is either named by an entry or listed, not both and not neither`);
  for (const r of m.unmappedRules.rules) assert.ok(r.reason.trim().length > 0, `${r.id} has a reason`);
  // A rule no entry names and the list forgets is refused; listed without a reason it is refused too.
  const withoutFirst = () => {
    const out = mapping();
    for (const e of out.entries) {
      const before = e.checks.length;
      e.checks = e.checks.filter((c) => !(c.unit === "semgrep-rule" && c.id === firstRule[0]));
      if (before > 0 && e.checks.length === 0 && e.status !== "unmapped") {
        e.status = "unmapped";
        delete e.why;
        delete e.review;
      }
    }
    out.unmappedRules.rules = out.unmappedRules.rules.filter((r) => r.id !== firstRule[0]);
    return out;
  };
  const forgotten = withoutFirst();
  assert.match(asvs.validateMapping(forgotten, data, context).join("\n"), /neither mapped nor listed/);
  const noReason = withoutFirst();
  noReason.unmappedRules.rules.push({ id: firstRule[0], reason: " " });
  assert.match(asvs.validateMapping(noReason, data, context).join("\n"), /has no reason/);
  const listedWithReason = withoutFirst();
  listedWithReason.unmappedRules.rules.push({ id: firstRule[0], reason: "No requirement names it." });
  assert.deepEqual(asvs.validateMapping(listedWithReason, data, context), []);
  const mapped = withEntry(withoutFirst(), "V1.5.3", "pending", [goodCheck()]);
  assert.equal(asvs.validateMapping(mapped, data, context).some((p) => p.includes("neither mapped nor listed")), false, "a mapped rule needs no listing");
});

test("the two-way gate: a rule's asvs_requirements and the entries that name it agree, or the pair is refused in unmapped-rules.json", () => {
  const gate = (m, ctx = context) => asvs.validateRuleRequirements(m, ctx);
  assert.ok(context.ruleRequirements.size > 0, "the rules of the pack state their requirements");
  assert.deepEqual(gate(mapping()), [], "today's pack and mapping agree");
  const [ruleId, stated] = [...context.ruleRequirements.entries()][0];
  const outside = data.requirements.map((r) => r.id).find((id) => !stated.includes(id));
  // A rule written for a requirement no entry maps to it, and the pair is not refused.
  const widened = { ...context, ruleRequirements: new Map(context.ruleRequirements).set(ruleId, [...stated, outside]) };
  assert.match(gate(mapping(), widened).join("\n"), new RegExp(`${ruleId.replace(/\./g, "\\.")} was written for ${outside.replace(/\./g, "\\.")}`));
  // The pair is listed in unmapped-rules.json: for that requirement only, or for the whole rule.
  const refusedPair = mapping();
  refusedPair.unmappedRules.rules.push({ id: ruleId, requirement: outside, reason: "No check of the rule bears on this requirement." });
  assert.deepEqual(gate(refusedPair, widened), []);
  const refusedOther = mapping();
  refusedOther.unmappedRules.rules.push({ id: ruleId, requirement: stated[0], reason: "Refused for another requirement." });
  assert.match(gate(refusedOther, widened).join("\n"), /was written for/, "a refusal of another requirement does not cover this one");
  const refusedAll = mapping();
  refusedAll.unmappedRules.rules.push({ id: ruleId, reason: "No requirement of the rule is examined by it." });
  assert.deepEqual(gate(refusedAll, widened).filter((p) => p.includes(outside)), []);
  // An entry that names a rule for a requirement outside the rule's asvs_requirements.
  const stray = withEntry(mapping(), outside, "pending", [goodCheck({ id: ruleId })], [context.rules.get(ruleId)]);
  assert.match(gate(stray).join("\n"), new RegExp(`entry ${outside.replace(/\./g, "\\.")} names rule ${ruleId.replace(/\./g, "\\.")}`));
  // A rule that states no requirement cannot be named by any entry.
  const bare = { ...context, ruleRequirements: new Map([...context.ruleRequirements].filter(([id]) => id !== ruleId)) };
  assert.match(gate(mapping(), bare).join("\n"), /whose asvs_requirements do not include/);
});

test("a refused pair names a requirement of the official data, once, and the schema takes the field", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validateRules = ajv.compile(readJson(path.join(JGATES, "schemas", "coverage", "asvs-unmapped-rules.schema.json")));
  const [ruleId] = [...context.rules.keys()];
  const good = { version: "5.0.0", rules: [{ id: ruleId, requirement: "V1.2.4", reason: "Not examined by this rule." }, { id: ruleId, reason: "Whole rule." }] };
  assert.ok(validateRules(good), ajv.errorsText(validateRules.errors));
  assert.ok(!validateRules({ ...good, rules: [{ id: ruleId, requirement: "not-an-id", reason: "x y z" }] }));
  const m = mapping();
  m.unmappedRules.rules.push({ id: ruleId, requirement: "V99.9.9", reason: "Unknown requirement." });
  assert.match(asvs.validateMapping(m, data, context).join("\n"), /unknown requirement V99\.9\.9/);
  const twice = mapping();
  twice.unmappedRules.rules.push({ id: ruleId, requirement: "V1.2.4", reason: "once" }, { id: ruleId, requirement: "V1.2.4", reason: "twice" });
  assert.match(asvs.validateMapping(twice, data, context).join("\n"), /listed twice/);
});

test("hardening is a subdimension the mapping schema and the mapping gates accept", () => {
  assert.ok(asvs.MAPPING_SUBDIMENSIONS.includes("hardening"));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validateMap = ajv.compile(readJson(path.join(JGATES, "schemas", "coverage", "asvs-map.schema.json")));
  const entry = { requirement: "V1.1.1", status: "unmapped", evidence: null, subdimensions: ["hardening"], checks: [] };
  assert.ok(validateMap({ version: "5.0.0", chapter: "V1", entries: [entry] }), ajv.errorsText(validateMap.errors));
});

test("findingRules belongs to a capability check only; semantic-requirement names asvs-review and never a requirement whose evidence is a person", () => {
  const capability = [...context.capabilities][0];
  assert.ok(capability, "a capability with a validated matrix row");
  const gate = (check, subdimensions, patch = {}) => {
    const m = withEntry(mapping(), "V1.1.1", "pending", [check], subdimensions);
    Object.assign(find(m, "V1.1.1"), patch);
    // Only the entry under test: rules other tasks are adding to the pack may be unmapped for a while.
    return asvs.validateMapping(m, data, context).filter((p) => p.includes(" V1.1.1:")).join("\n");
  };
  assert.equal(gate(goodCheck({ unit: "capability", id: capability, findingRules: ["ALERT-1", "ALERT-2"] })), "");
  assert.match(gate(goodCheck({ findingRules: ["ALERT-1"] })), /findingRules is allowed only on a capability check, not on semgrep-rule/);
  assert.match(gate(goodCheck({ unit: "semantic-method", id: "differential-review", findingRules: ["X"] })), /findingRules is allowed only on a capability check/);
  assert.match(gate(goodCheck({ unit: "capability", id: capability, findingRules: [] })), /findingRules must be a list/);
  assert.match(gate(goodCheck({ unit: "capability", id: capability, findingRules: ["A", "A"] })), /findingRules must be a list/);
  assert.equal(gate(goodCheck({ unit: "semantic-requirement", id: "asvs-review" })), "");
  assert.match(gate(goodCheck({ unit: "semantic-requirement", id: "general-review" })), /names the method asvs-review/);
  assert.match(gate(goodCheck({ unit: "semantic-requirement", id: "asvs-review" }), undefined, { evidence: "person" }), /evidence is a person/);

  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validateMap = ajv.compile(readJson(path.join(JGATES, "schemas", "coverage", "asvs-map.schema.json")));
  const entry = (checks, extra = {}) => ({ version: "5.0.0", chapter: "V1", entries: [{ requirement: "V1.1.1", status: "reviewed", evidence: "repository", subdimensions: [], checks, why: "A reason of its own.", ...extra }] });
  assert.ok(validateMap(entry([goodCheck({ unit: "capability", id: capability, findingRules: ["ALERT-1"] })])), ajv.errorsText(validateMap.errors));
  assert.ok(!validateMap(entry([goodCheck({ findingRules: ["ALERT-1"] })])), "the schema refuses findingRules on a rule check");
  assert.ok(validateMap(entry([goodCheck({ unit: "semantic-requirement", id: "asvs-review" })])), ajv.errorsText(validateMap.errors));
  assert.ok(!validateMap(entry([goodCheck({ unit: "semantic-requirement", id: "general-review" })])));
});

test("applies: a reviewed entry may say which projects a requirement concerns, with or without a check; the gates and the schema keep it to the closed lists", () => {
  const withApplies = (status, applies, checks = []) => {
    const m = mapping();
    Object.assign(find(m, "V1.1.1"), { status, evidence: "repository", subdimensions: [], checks, applies, why: "Only projects that use the technology are concerned." });
    return asvs.validateMapping(m, data, context).filter((p) => p.includes(" V1.1.1:")).join("\n");
  };
  assert.equal(withApplies("reviewed", { technology: ["graphql"] }), "", "an entry with only applies is sound");
  assert.equal(withApplies("reviewed", { technology: ["oauth-client", "oauth-authorization-server"], languages: { only: ["java"] } }), "");
  assert.equal(withApplies("reviewed", { languages: { exempt: { languages: ["go", "rust"], reason: "linear-time-regex" } } }), "");
  assert.match(withApplies("reviewed", { technology: ["cobol"] }), /unknown tag cobol/);
  assert.match(withApplies("reviewed", { languages: { only: ["klingon"] } }), /unknown language klingon/);
  assert.match(withApplies("reviewed", { languages: { exempt: { languages: ["rust"], reason: "it is safe" } } }), /exempt\.reason must be one of/);
  assert.match(withApplies("reviewed", {}), /neither a technology nor languages/);
  assert.match(withApplies("unmapped", { technology: ["graphql"] }), /unmapped but has applies/);
  assert.deepEqual(asvs.TECHNOLOGY_TAGS.length, 17);
  assert.deepEqual([...asvs.EXEMPT_REASONS], ["compile-time-format-strings", "linear-time-regex"]);
  // Only a reviewed entry's applies counts, as its checks do.
  const e = { ...find(mapping(), "V1.1.1"), applies: { technology: ["graphql"] } };
  assert.equal(asvs.countedApplies({ ...e, status: "pending" }), null);
  assert.deepEqual(asvs.countedApplies({ ...e, status: "reviewed" }), { technology: ["graphql"] });

  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validateMap = ajv.compile(readJson(path.join(JGATES, "schemas", "coverage", "asvs-map.schema.json")));
  const doc = (status, applies, checks = []) => ({ version: "5.0.0", chapter: "V1", entries: [{ requirement: "V1.1.1", status, evidence: "repository", subdimensions: [], checks, applies, why: "Only projects that use it." }] });
  assert.ok(validateMap(doc("reviewed", { technology: ["graphql"] })), ajv.errorsText(validateMap.errors));
  assert.ok(validateMap(doc("reviewed", { languages: { exempt: { languages: ["rust"], reason: "compile-time-format-strings" } } })), ajv.errorsText(validateMap.errors));
  assert.ok(!validateMap(doc("reviewed", { technology: ["cobol"] })));
  assert.ok(!validateMap(doc("reviewed", { languages: { exempt: { languages: ["rust"] } } })));
  assert.ok(!validateMap({ ...doc("unmapped", { technology: ["graphql"] }), entries: [{ requirement: "V1.1.1", status: "unmapped", evidence: null, subdimensions: [], checks: [], applies: { technology: ["graphql"] } }] }), "an unmapped entry cannot carry applies");
  assert.ok(!validateMap({ version: "5.0.0", chapter: "V1", entries: [{ requirement: "V1.1.1", status: "reviewed", evidence: "repository", subdimensions: [], checks: [], why: "x" }] }), "a reviewed entry needs a check or applies");
});

test("the distribution check accepts the data folder and the mapping pack", () => {
  const report = distribution.checkDistribution({ packs: [DATA_DIR, MAP_DIR] });
  assert.deepEqual(report.problems, []);
  assert.ok(report.ok);
  assert.deepEqual(report.packs.map((p) => p.id), ["owasp-asvs", "jgates-asvs-map"]);
  assert.equal(report.packs[0].record.spdx, "CC-BY-SA-4.0");
  assert.match(fs.readFileSync(path.join(DATA_DIR, "LICENSE"), "utf8"), /Attribution-ShareAlike 4\.0 International/);
});
