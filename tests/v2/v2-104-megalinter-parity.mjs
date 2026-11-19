import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-104 (no engine): the MegaLinter 9.6.0 parity gate. Each of the 137 linter ids of the reference
// (jgates/parity/megalinter-parity.json) is answered by an existing adapter, a descriptor whose tool
// is in the image with a smoke group, or an exclusion with a reason and the user's decision date.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXPECTED = 137;
// SHA-256 of the sorted, newline-separated IDs verified against the 9.6.0 intake.
const IDS_SHA256 = "bed80e880a9a80319ce8aadcdaea4ad627a595f84289c4605b025303e49389be";
const ref = JSON.parse(fs.readFileSync(path.join(root, "jgates/parity/megalinter-parity.json"), "utf8"));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

function check(entries, ctx) {
  const problems = [];
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.id)) problems.push(`${e.id}: listed twice`);
    seen.add(e.id);
    const a = e.answer ?? {};
    if (a.kind === "adapter") {
      if (!a.adapter || !fs.existsSync(path.join(root, "jgates/src/adapters", a.adapter, "manifest.ts"))) problems.push(`${e.id}: adapter "${a.adapter}" does not exist`);
    } else if (a.kind === "descriptor") {
      const file = path.join(root, "jgates/src/builtin/linters", String(a.descriptor), "linter.json");
      if (!fs.existsSync(file)) { problems.push(`${e.id}: descriptor "${a.descriptor}" is missing`); continue; }
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      const names = [].concat(d.megalinter ?? []).map((m) => (typeof m === "string" ? m : m?.id));
      if (!names.includes(e.id)) problems.push(`${e.id}: descriptor "${a.descriptor}" does not name it`);
      // The image records a program under its own name (code-analyzer-apex runs `sf`, tofu-fmt runs `tofu`).
      const program = d.program?.tool ?? a.descriptor;
      if (!(program in ctx.imageTools)) problems.push(`${e.id}: tool "${program}" of "${a.descriptor}" is not in image-tools.json`);
      if (!ctx.gates.includes(a.descriptor)) problems.push(`${e.id}: no smoke group for "${a.descriptor}"`);
    } else if (a.kind === "excluded") {
      if (!a.reason || !/^\d{4}-\d{2}-\d{2}$/.test(a.decided ?? "")) problems.push(`${e.id}: exclusion needs a reason and the decision date`);
    } else if (a.kind === "planned") {
      problems.push(`${e.id}: still planned (slice ${a.slice})`);
    } else problems.push(`${e.id}: no answer`);
  }
  return problems;
}

// A descriptor's smoke group is derived from the descriptors (linterSmokeGroups of image-gates.mjs): the tool is covered
// when a derived group switches it on; the fixed groups are still found in the text of the script.
const gatesFile = path.join(root, "jgates/scripts/image-gates.mjs");
const gatesText = fs.existsSync(gatesFile) ? fs.readFileSync(gatesFile, "utf8") : "";
const derivedTools = new Set(
  fs.existsSync(gatesFile) ? (await import(pathToFileURL(gatesFile).href)).linterSmokeGroups().flatMap((g) => g.toolsOn ?? []) : [],
);
const ctx = {
  imageTools: JSON.parse(read("jgates/release/image-tools.json")).tools ?? {},
  gates: { includes: (n) => derivedTools.has(n) || gatesText.includes(n) },
};

test("V2-104: every one of the 137 MegaLinter linters is answered", () => {
  assert.equal(ref.entries.length, EXPECTED, `the reference lists ${ref.entries.length} entries, expected ${EXPECTED}`);
  const ids = ref.entries.map((e) => e.id).sort().join("\n");
  assert.equal(createHash("sha256").update(ids).digest("hex"), IDS_SHA256, "the reference IDs differ from MegaLinter 9.6.0");
  assert.ok(!Object.hasOwn(ref, "allowPlanned"), "the finalized reference has no planned override");
  // Kept adapters answer as they were; the E slices completed nine more on existing adapters (the answer names its slice).
  const kept = ref.entries.filter((e) => e.answer.kind === "adapter" && !e.answer.slice);
  assert.equal(kept.length, 17, "the map of kept adapters names 17 linters");
  const completed = ref.entries.filter((e) => e.answer.kind === "adapter" && e.answer.slice);
  assert.ok(completed.every((e) => /^E\d+$/.test(e.answer.slice)), "only an E slice completes an existing adapter");
  // 7 decided outright, plus SQL_TSQLLINT, left out (decided in advance) because it fails the vulnerability gate.
  const excluded = ref.entries.filter((e) => e.answer?.kind === "excluded").map((e) => e.id).sort();
  assert.deepEqual(excluded, [
    "JSON_ESLINT_PLUGIN_JSONC",
    "REPOSITORY_KICS",
    "SALESFORCE_LIGHTNING_FLOW_SCANNER",
    "SALESFORCE_SFDX_SCANNER_APEX",
    "SALESFORCE_SFDX_SCANNER_AURA",
    "SALESFORCE_SFDX_SCANNER_LWC",
    "SQL_TSQLLINT",
    "TERRAFORM_TERRASCAN",
  ], "only the eight approved exclusions are allowed");
  assert.deepEqual(check(ref.entries, ctx), []);
});

test("V2-104: removing an entry or an answer makes the gate fail and name the id", () => {
  const without = ref.entries.slice(1);
  assert.notEqual(without.length, EXPECTED);
  const broken = ref.entries.map((e, i) => (i === 0 ? { ...e, answer: { kind: "adapter", adapter: "no-such-adapter" } } : e));
  assert.match(check(broken, ctx).join("\n"), new RegExp(`^${ref.entries[0].id}:`));
  const unanswered = ref.entries.map((e, i) => (i === 1 ? { id: e.id } : e));
  assert.match(check(unanswered, ctx).join("\n"), new RegExp(`${ref.entries[1].id}: no answer`));
  const planned = { ...ref.entries[0], answer: { kind: "planned", slice: "T01" } };
  assert.match(check([planned], ctx).join("\n"), /still planned/);
});
