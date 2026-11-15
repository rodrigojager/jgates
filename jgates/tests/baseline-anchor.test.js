import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// The baseline comparison matches findings by the anchor (per tool, rule and file) when both sides have one, and by the
// fingerprint v1 otherwise. One matcher serves the counts and the marks.

const here = path.dirname(fileURLToPath(import.meta.url));
const results = await import(pathToFileURL(path.join(here, "..", "dist", "core", "results", "index.js")).href);

const FILE = "src/app.js";

/** Findings of one rule in one file, one per [line, text]; anchors computed as the run does (position among equal lines). */
function group(entries, { rule = "r.risky", file = FILE, category, anchored = true } = {}) {
  const seen = new Map();
  const list = entries.map(([line, text]) => {
    const position = seen.get(text) ?? 0;
    seen.set(text, position + 1);
    return {
      stageId: "s",
      tool: "scan",
      ruleId: rule,
      severity: "high",
      normalizedSeverity: "high",
      message: "m",
      location: { path: file, line },
      blocking: false,
      waived: false,
      ...(category ? { category } : {}),
      ...(anchored ? { anchor: results.anchorOf({ tool: "scan", ruleId: rule, path: file, lineText: text, position }) } : {}),
    };
  });
  return list;
}

const withFingerprints = (...groups) => results.assignFingerprints(groups.flat());
const stripAnchors = (findings) => findings.map(({ anchor: _a, ...rest }) => rest);

const base = (findings) => ({ runId: "run_base", findings, provenance: {}, selection: { scope: "workspace" }, reduced: false });
const now = (findings) => ({ findings, provenance: {}, selection: { scope: "workspace" }, reduced: false });

/** What the comparison gives, with the check that the marks agree with the counts. */
function compare(before, after) {
  const cmp = results.compareWithBaseline(base(before), now(after));
  const marked = results.markBaselineState(after, base(before));
  assert.equal(marked.filter((f) => f.baselineState === "new").length, cmp.new, "the new marks equal the new count");
  assert.equal(marked.filter((f) => f.baselineState === "unchanged").length, cmp.kept, "the kept marks equal the kept count");
  assert.equal(cmp.new + cmp.kept, after.length);
  return { cmp, marked };
}

/** The comparison of the code before the anchor existed: by fingerprint v1 alone. */
function legacy(before, after) {
  const known = new Map(before.filter((f) => f.fingerprint).map((f) => [f.fingerprint, f]));
  const kept = after.filter((f) => f.fingerprint && known.has(f.fingerprint));
  const keptSet = new Set(kept.map((f) => f.fingerprint));
  return { new: after.length - kept.length, kept: kept.length, resolved: [...known.values()].filter((f) => !keptSet.has(f.fingerprint)).length };
}

test("anchors on both sides: one fixed and one introduced in the same file are one resolved and one new, the right ones", () => {
  const before = withFingerprints(group([[1, "risky(1);"], [2, "risky(2);"], [3, "risky(3);"]]));
  const after = withFingerprints(group([[1, "risky(2);"], [2, "risky(3);"], [3, "risky(4);"]]));
  const { cmp, marked } = compare(before, after);
  assert.equal(cmp.matchedBy, "anchor");
  assert.equal(cmp.new, 1);
  assert.equal(cmp.kept, 2);
  assert.equal(cmp.resolved.length, 1);
  assert.equal(cmp.resolved[0].line, 1, "the resolved entry is the first finding of the baseline, with its line");
  assert.equal(cmp.resolved[0].fingerprint, before[0].fingerprint, "it keeps the fingerprint v1 as its id");
  assert.equal(cmp.resolved[0].path, FILE);
  assert.deepEqual(marked.map((f) => f.baselineState), ["unchanged", "unchanged", "new"]);
  // The fingerprint alone would have said nothing new and nothing resolved: the positions are the same.
  assert.deepEqual(legacy(before, after), { new: 0, kept: 3, resolved: 0 });
});

test("a new finding above the others carries the new mark", () => {
  const before = withFingerprints(group([[1, "risky(1);"], [2, "risky(2);"]]));
  const after = withFingerprints(group([[1, "risky(0);"], [2, "risky(1);"], [3, "risky(2);"]]));
  const { cmp, marked } = compare(before, after);
  assert.equal(cmp.new, 1);
  assert.equal(cmp.kept, 2);
  assert.deepEqual(cmp.resolved, []);
  assert.deepEqual(marked.map((f) => f.baselineState), ["new", "unchanged", "unchanged"]);
});

test("lines inserted above leave every finding kept", () => {
  const before = withFingerprints(group([[1, "risky(1);"], [2, "risky(2);"]]));
  const after = withFingerprints(group([[11, "risky(1);"], [12, "risky(2);"]]));
  const { cmp, marked } = compare(before, after);
  assert.deepEqual([cmp.new, cmp.kept, cmp.resolved.length], [0, 2, 0]);
  assert.equal(cmp.matchedBy, "anchor");
  assert.ok(marked.every((f) => f.baselineState === "unchanged"));
});

test("a flagged line whose text changed is one resolved and one new", () => {
  const before = withFingerprints(group([[1, "risky(1);"]]));
  const after = withFingerprints(group([[1, "risky(1, true);"]]));
  const { cmp } = compare(before, after);
  assert.deepEqual([cmp.new, cmp.kept, cmp.resolved.length], [1, 0, 1]);
});

test("a baseline stored without anchors gives the numbers of the fingerprint comparison", () => {
  const before = withFingerprints(stripAnchors(group([[1, "risky(1);"], [2, "risky(2);"], [3, "risky(3);"]])));
  const after = withFingerprints(group([[1, "risky(2);"], [2, "risky(3);"], [3, "risky(4);"]]));
  const { cmp } = compare(before, after);
  const old = legacy(before, after);
  assert.deepEqual([cmp.new, cmp.kept, cmp.resolved.length], [old.new, old.kept, old.resolved]);
  assert.equal(cmp.matchedBy, "fingerprint");
  // Neither side with anchors: the same.
  const plainAfter = stripAnchors(after);
  const plain = compare(before, plainAfter);
  assert.equal(plain.cmp.matchedBy, "fingerprint");
  assert.deepEqual([plain.cmp.new, plain.cmp.kept, plain.cmp.resolved.length], [old.new, old.kept, old.resolved]);
});

test("a group of the secrets category has no anchor and uses the fingerprint v1", () => {
  const secrets = (lines) => group(lines, { rule: "r.key", category: "secrets", anchored: false });
  const before = withFingerprints(secrets([[1, "k1"], [2, "k2"]]));
  const after = withFingerprints(secrets([[5, "k1"], [6, "k2"], [7, "k3"]]));
  const { cmp } = compare(before, after);
  assert.equal(cmp.matchedBy, "fingerprint");
  assert.deepEqual([cmp.new, cmp.kept, cmp.resolved.length], [1, 2, 0]);
});

test("a run with groups of both kinds says mixed, and the groups are never mixed inside", () => {
  const code = (lines) => group(lines);
  const secrets = (lines) => group(lines, { rule: "r.key", category: "secrets", anchored: false });
  const before = withFingerprints(code([[1, "risky(1);"], [2, "risky(2);"]]), secrets([[9, "k1"]]));
  const after = withFingerprints(code([[1, "risky(2);"], [2, "risky(3);"]]), secrets([[9, "k1"]]));
  const { cmp, marked } = compare(before, after);
  assert.equal(cmp.matchedBy, "mixed");
  assert.equal(cmp.new, 1);
  assert.equal(cmp.kept, 2);
  assert.deepEqual(cmp.resolved.map((r) => [r.ruleId, r.line]), [["r.risky", 1]]);
  assert.deepEqual(marked.map((f) => f.baselineState), ["unchanged", "new", "unchanged"]);

  // One finding of a group without an anchor sends that whole group to the fingerprint.
  const partial = group([[1, "risky(1);"], [2, "risky(2);"]]);
  delete partial[1].anchor;
  const mixedGroup = compare(withFingerprints(code([[1, "risky(1);"], [2, "risky(2);"]])), withFingerprints(partial));
  assert.equal(mixedGroup.cmp.matchedBy, "fingerprint");
  assert.deepEqual([mixedGroup.cmp.new, mixedGroup.cmp.kept, mixedGroup.cmp.resolved.length], [0, 2, 0]);
});

test("the groups are told apart by tool, rule and path", () => {
  const before = withFingerprints(group([[1, "risky(1);"]], { file: "a.js" }), group([[1, "risky(1);"]], { file: "b.js" }));
  const after = withFingerprints(group([[1, "risky(1);"]], { file: "a.js" }));
  const { cmp } = compare(before, after);
  assert.deepEqual([cmp.new, cmp.kept], [0, 1]);
  assert.deepEqual(cmp.resolved.map((r) => r.path), ["b.js"]);
});
