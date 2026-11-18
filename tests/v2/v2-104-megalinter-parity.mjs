import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// V2-104 (no engine): the MegaLinter 9.6.0 parity gate. Each of the 137 linter ids of the reference
// (jgates/parity/megalinter-parity.json) is answered by an existing adapter, a descriptor whose tool
// is in the image with a smoke group, an exclusion with a reason and the user's decision date, or is
// still `planned` (allowed only while the reference says allowPlanned; slice V6 turns that off).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXPECTED = 137;
const ref = JSON.parse(fs.readFileSync(path.join(root, "jgates/parity/megalinter-parity.json"), "utf8"));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

function check(entries, allowPlanned, ctx) {
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
      if (!(a.descriptor in ctx.imageTools)) problems.push(`${e.id}: tool "${a.descriptor}" is not in image-tools.json`);
      if (!ctx.gates.includes(a.descriptor)) problems.push(`${e.id}: no smoke group for "${a.descriptor}"`);
    } else if (a.kind === "excluded") {
      if (!a.reason || !/^\d{4}-\d{2}-\d{2}$/.test(a.decided ?? "")) problems.push(`${e.id}: exclusion needs a reason and the decision date`);
    } else if (a.kind === "planned") {
      if (!allowPlanned) problems.push(`${e.id}: still planned (slice ${a.slice})`);
      else if (!a.slice) problems.push(`${e.id}: planned without a slice`);
    } else problems.push(`${e.id}: no answer`);
  }
  return problems;
}

const gatesFile = path.join(root, "jgates/scripts/image-gates.mjs");
const gatesText = fs.existsSync(gatesFile) ? fs.readFileSync(gatesFile, "utf8") : "";
const ctx = {
  imageTools: JSON.parse(read("jgates/release/image-tools.json")).tools ?? {},
  gates: { includes: (n) => gatesText.includes(n) },
};

test("V2-104: every one of the 137 MegaLinter linters is answered", () => {
  assert.equal(ref.entries.length, EXPECTED, `the reference lists ${ref.entries.length} entries, expected ${EXPECTED}`);
  const factsFile = path.resolve(root, "../_work/60-intake/megalinter-9.6.0/facts.json");
  if (fs.existsSync(factsFile)) {
    const ids = JSON.parse(fs.readFileSync(factsFile, "utf8")).map((f) => f.id).sort();
    assert.deepEqual(ref.entries.map((e) => e.id).sort(), ids, "the reference ids differ from the facts of MegaLinter 9.6.0");
  }
  const kept = ref.entries.filter((e) => e.answer.kind === "adapter");
  assert.equal(kept.length, 17, "the map of kept adapters names 17 linters");
  assert.equal(ref.entries.filter((e) => e.answer.kind === "excluded").length, 7, "7 exclusions decided on 2026-11-17");
  const problems = check(ref.entries, ref.allowPlanned === true, ctx);
  assert.deepEqual(problems, []);
  const planned = ref.entries.filter((e) => e.answer.kind === "planned");
  console.log(`planned: ${planned.length} of ${EXPECTED}: ${planned.map((e) => `${e.id}(${e.answer.slice})`).join(" ")}`);
});

test("V2-104: removing an entry or an answer makes the gate fail and name the id", () => {
  const without = ref.entries.slice(1);
  assert.notEqual(without.length, EXPECTED);
  const broken = ref.entries.map((e, i) => (i === 0 ? { ...e, answer: { kind: "adapter", adapter: "no-such-adapter" } } : e));
  assert.match(check(broken, true, ctx).join("\n"), new RegExp(`^${ref.entries[0].id}:`));
  const unanswered = ref.entries.map((e, i) => (i === 1 ? { id: e.id } : e));
  assert.match(check(unanswered, true, ctx).join("\n"), new RegExp(`${ref.entries[1].id}: no answer`));
  const planned = ref.entries.find((e) => e.answer.kind === "planned");
  assert.match(check([planned], false, ctx).join("\n"), /still planned/);
});
