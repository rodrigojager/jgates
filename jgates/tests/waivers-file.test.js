import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The project's waiver file (core/waiver-file): reading it, adding entries with a preview that writes nothing, removing
// them, and undoing a write. The edits splice the original text, so the difference in bytes is the entry and nothing else.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const wf = await import(pathToFileURL(path.join(dist, "core", "waiver-file", "index.js")).href);

const made = [];
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
function project(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jg-waiver-file-"));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
const FILE = ".jgates/waivers.json";
const read = (dir) => fs.readFileSync(path.join(dir, FILE), "utf8");
const exists = (dir) => fs.existsSync(path.join(dir, FILE));
const NOW = new Date("2026-11-14T12:00:00Z");

const finding = (n, extra = {}) => ({
  stageId: "scan",
  tool: "scanner",
  ruleId: "scan.risky",
  fingerprint: `jgf1:${String(n).padStart(2, "0")}${"ab".repeat(15)}`,
  anchor: `jga1:${String(n).padStart(2, "0")}${"cd".repeat(15)}`,
  location: { path: "src/app.js", line: n * 10 },
  ...extra,
});
const result = { findings: [finding(1), finding(2), finding(3)] };
const add = (dir, extra = {}) => wf.prepareAdd(dir, { result, findings: [wf.shortFingerprint(result.findings[1].fingerprint)], until: "2999-12-31", reason: "false positive", now: NOW, ...extra });
const commit = (prepared) => {
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const out = wf.commitChange(prepared);
  assert.equal(out.ok, true, JSON.stringify(out));
  return out;
};

test("a missing file is created as an object with waivers, two-space indentation and a final newline", () => {
  const dir = project();
  const prepared = add(dir);
  assert.equal(prepared.ok, true);
  assert.equal(exists(dir), false, "the preview writes nothing");
  assert.match(prepared.diff, /^\+\+\+ b\/\.jgates\/waivers\.json/m);
  commit(prepared);
  const text = read(dir);
  assert.ok(text.startsWith('{\n  "waivers": [\n    {\n      "tool": "scanner",'), text);
  assert.ok(text.endsWith("\n    }\n  ]\n}\n"), text);
  const entry = JSON.parse(text).waivers[0];
  assert.deepEqual(Object.keys(entry), ["tool", "rule", "path", "fingerprint", "anchor", "occurrences", "line", "reason", "created", "expires"]);
  assert.equal(entry.created, "2026-11-14");
  assert.equal(entry.expires, "2999-12-31");
  assert.equal(entry.occurrences, 3);
  assert.equal(entry.line, 20);
});

test("adding to an object file changes only the end of its list: other entries and unknown keys stay byte for byte", () => {
  const before = '{\n  "$comment": "team file",\n  "waivers": [\n    { "rule": "x.y", "path": "legacy/*", "reason": "legacy", "owner": "ana" }\n  ],\n  "note": 1\n}\n';
  const dir = project({ [FILE]: before });
  commit(add(dir));
  const after = read(dir);
  const cut = before.indexOf("\n  ],");
  assert.equal(after.slice(0, cut), before.slice(0, cut));
  assert.ok(after.endsWith(before.slice(cut)));
  const middle = after.slice(cut, after.length - (before.length - cut));
  assert.match(middle, /^,\n    \{\n/);
  assert.equal(JSON.parse(middle.slice(1)).rule, "scan.risky");
  assert.equal(JSON.parse(after).note, 1);
});

test("adding to a list file keeps the list shape and its layout", () => {
  const before = '[\n  {"rule":"a.b","path":"x/*","reason":"hand","extra":true}\n]\n';
  const dir = project({ [FILE]: before });
  commit(add(dir));
  const after = read(dir);
  assert.ok(after.startsWith(before.slice(0, before.indexOf("\n]"))));
  assert.ok(after.endsWith("\n  }\n]\n"), after);
  const list = JSON.parse(after);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { rule: "a.b", path: "x/*", reason: "hand", extra: true });
});

test("a file with CRLF line breaks and an empty list keeps its line breaks", () => {
  const before = '{\r\n  "waivers": []\r\n}\r\n';
  const dir = project({ [FILE]: before });
  commit(add(dir));
  const after = read(dir);
  assert.ok(!/[^\r]\n/.test(after), "every line break is CRLF");
  assert.equal(JSON.parse(after).waivers.length, 1);
  assert.ok(after.endsWith("\r\n  ]\r\n}\r\n"), JSON.stringify(after));
});

test("remove takes one entry out and leaves the rest byte for byte; add then remove gives back the file", () => {
  for (const before of [
    '{\n  "waivers": [\n    { "rule": "a.b", "reason": "one" },\n    { "rule": "c.d", "reason": "two", "extra": [1, 2] }\n  ],\n  "keep": true\n}\n',
    '[\n  { "rule": "a.b", "reason": "one" }\n]\n',
  ]) {
    const dir = project({ [FILE]: before });
    commit(add(dir));
    const added = wf.readWaiverFile(dir);
    const id = added.entries.at(-1).id;
    commit(wf.prepareRemove(dir, { ids: [id], now: NOW }));
    assert.equal(read(dir), before);
  }
});

test("remove of the first, a middle and the last entry, and of the only one", () => {
  const entries = ["one", "two", "three"].map((r) => `    { "rule": "r.${r}", "reason": "${r} reason" }`);
  const mk = (list) => `{\n  "waivers": [\n${list.join(",\n")}\n  ]\n}\n`;
  const dir = project({ [FILE]: mk(entries) });
  const ids = wf.readWaiverFile(dir).entries.map((e) => e.id);
  assert.equal(new Set(ids).size, 3);
  commit(wf.prepareRemove(dir, { ids: [ids[1]], now: NOW }));
  assert.equal(read(dir), mk([entries[0], entries[2]]));
  commit(wf.prepareRemove(dir, { ids: [ids[0]], now: NOW }));
  assert.equal(read(dir), mk([entries[2]]));
  commit(wf.prepareRemove(dir, { ids: [ids[2]], now: NOW }));
  assert.equal(read(dir), '{\n  "waivers": []\n}\n');
  const again = wf.prepareRemove(dir, { ids: [ids[2]], now: NOW });
  assert.equal(again.code, "WAIVER_NOT_FOUND");
});

test("the id of an entry comes from the entry, not from its position, and a prefix of it works", () => {
  const before = '[\n  { "rule": "a.b", "reason": "one" },\n  { "rule": "c.d", "reason": "two" }\n]\n';
  const dir = project({ [FILE]: before });
  const first = wf.readWaiverFile(dir).entries.map((e) => e.id);
  assert.match(first[0], /^[0-9a-f]{8}$/);
  commit(wf.prepareRemove(dir, { ids: [first[0]], now: NOW }));
  assert.equal(wf.readWaiverFile(dir).entries[0].id, first[1], "the second entry keeps its id after the first is gone");
  const prepared = wf.prepareRemove(dir, { ids: [first[1].slice(0, 5)], now: NOW });
  assert.equal(prepared.ok, true);
  assert.equal(wf.prepareRemove(dir, { ids: ["zz"], now: NOW }).code, "WAIVER_NOT_FOUND");
});

test("refusals write nothing: no date, a past date, a bad date, a bad reason, no finding, an unknown or ambiguous prefix", () => {
  const dir = project();
  const code = (extra) => add(dir, extra).code;
  assert.equal(code({ until: undefined }), "WAIVER_UNTIL_REQUIRED");
  assert.equal(code({ until: "" }), "WAIVER_UNTIL_REQUIRED");
  assert.equal(code({ until: "2026-11-13" }), "WAIVER_UNTIL_PAST");
  assert.equal(code({ until: "2026-02-30" }), "WAIVER_UNTIL_INVALID");
  assert.equal(code({ until: "soon" }), "WAIVER_UNTIL_INVALID");
  assert.equal(add(dir, { until: "2026-11-14" }).ok, true, "today is allowed");
  assert.equal(code({ reason: undefined }), "WAIVER_REASON_INVALID");
  assert.equal(code({ reason: "ab" }), "WAIVER_REASON_INVALID");
  assert.equal(code({ reason: "  a  " }), "WAIVER_REASON_INVALID");
  assert.equal(code({ reason: "x".repeat(301) }), "WAIVER_REASON_INVALID");
  assert.equal(add(dir, { reason: "x".repeat(300) }).ok, true);
  assert.equal(code({ reason: "bad\treason" }), "WAIVER_REASON_INVALID");
  assert.equal(code({ reason: "bad\nreason" }), "WAIVER_REASON_INVALID");
  assert.equal(code({ findings: [] }), "WAIVER_FINDING_REQUIRED");
  assert.equal(code({ findings: ["ffffffffffff"] }), "WAIVER_FINDING_NOT_FOUND");
  assert.equal(code({ findings: ["not-hex"] }), "WAIVER_FINDING_NOT_FOUND");
  // Two findings whose fingerprints start with the same digits: each is named by a longer prefix, both by a shared one.
  const ambiguous = wf.prepareAdd(dir, { result: { findings: [finding(1), { ...finding(1), fingerprint: "jgf1:01abef" + "ef".repeat(13), anchor: "jga1:x", location: { path: "src/b.js", line: 1 } }] }, findings: ["01abab", "01abef"], until: "2999-12-31", reason: "ok ok", now: NOW });
  assert.equal(ambiguous.ok, true, "01abab and 01abef each name one finding");
  const both = wf.prepareAdd(dir, { result: { findings: [finding(1), { ...finding(1), fingerprint: "jgf1:01abef" + "ef".repeat(13), anchor: "jga1:x", location: { path: "src/b.js", line: 1 } }] }, findings: ["jgf1:01ab"], until: "2999-12-31", reason: "ok ok", now: NOW });
  assert.equal(both.code, "WAIVER_FINDING_AMBIGUOUS");
  assert.equal(both.details.candidates.length, 2);
  assert.ok(both.details.candidates.every((c) => c.rule === "scan.risky" && c.path));
  assert.equal(exists(dir), false);
});

test("a finding without a file or a fingerprint cannot be waived by occurrence", () => {
  const dir = project();
  const bare = { stageId: "s", tool: "t", ruleId: "r", fingerprint: "jgf1:" + "12".repeat(16) };
  const r = wf.prepareAdd(dir, { result: { findings: [bare] }, findings: ["1212121212"], until: "2999-12-31", reason: "ok ok", now: NOW });
  assert.equal(r.code, "WAIVER_FINDING_NOT_WAIVABLE");
});

test("a file that cannot be parsed is reported with where, and never rewritten", () => {
  const bad = '{\n  "waivers": [\n    { "rule": "a.b", "reason": "broken"\n  ]\n}\n';
  const dir = project({ [FILE]: bad });
  const read1 = wf.readWaiverFile(dir);
  assert.ok(read1.problem);
  assert.equal(read1.problem.line, 4);
  assert.ok(read1.problem.column >= 1);
  const refused = add(dir);
  assert.equal(refused.code, "WAIVER_FILE_INVALID");
  assert.equal(refused.details.problem.line, 4);
  assert.equal(wf.prepareRemove(dir, { ids: ["abcd"], now: NOW }).code, "WAIVER_FILE_INVALID");
  assert.equal(read(dir), bad);
  for (const text of ['{"other": 1}', "[]x", "42", ""]) {
    fs.writeFileSync(path.join(dir, FILE), text);
    assert.equal(add(dir).code, "WAIVER_FILE_INVALID", JSON.stringify(text));
    assert.equal(read(dir), text);
  }
});

test("a file changed since it was read is not overwritten", () => {
  const before = '{\n  "waivers": [\n    { "rule": "a.b", "reason": "one" }\n  ]\n}\n';
  const dir = project({ [FILE]: before });
  const prepared = add(dir);
  assert.equal(prepared.ok, true);
  const changed = before.replace("one", "edited by hand meanwhile");
  fs.writeFileSync(path.join(dir, FILE), changed);
  const out = wf.commitChange(prepared);
  assert.equal(out.ok, false);
  assert.equal(out.code, "WAIVER_FILE_CHANGED");
  assert.equal(read(dir), changed);
  assert.equal(fs.readdirSync(path.join(dir, ".jgates")).length, 1, "no temporary file is left");

  // The caller's own revision: a request prepared against an older read is refused before anything is prepared.
  const stale = add(dir, { expectedRevision: prepared.revision });
  assert.equal(stale.code, "WAIVER_FILE_CHANGED");

  // A file created between the read and the write (the file was absent) is not overwritten either.
  const empty = project();
  const preparedNew = add(empty);
  fs.mkdirSync(path.join(empty, ".jgates"));
  fs.writeFileSync(path.join(empty, FILE), "[]\n");
  assert.equal(wf.commitChange(preparedNew).code, "WAIVER_FILE_CHANGED");
  assert.equal(read(empty), "[]\n");
});

test("undo puts the file back, and refuses when the file moved on; undo of a created file removes it", () => {
  const before = '[\n  { "rule": "a.b", "reason": "one" }\n]\n';
  const dir = project({ [FILE]: before });
  const out = commit(add(dir));
  assert.notEqual(read(dir), before);
  assert.deepEqual(wf.undoChange(dir, out.undo), { ok: true, revision: wf.readWaiverFile(dir).revision });
  assert.equal(read(dir), before);

  const out2 = commit(add(dir));
  fs.appendFileSync(path.join(dir, FILE), "\n");
  const refused = wf.undoChange(dir, out2.undo);
  assert.equal(refused.code, "WAIVER_FILE_CHANGED");

  const fresh = project();
  const created = commit(add(fresh));
  assert.equal(exists(fresh), true);
  assert.equal(wf.undoChange(fresh, created.undo).ok, true);
  assert.equal(exists(fresh), false);
});

test("a file mode and a byte order mark are kept", { skip: process.platform === "win32" ? "file modes are not meaningful here" : false }, () => {
  const dir = project({ [FILE]: "[]\n" });
  fs.chmodSync(path.join(dir, FILE), 0o640);
  commit(add(dir));
  assert.equal(fs.statSync(path.join(dir, FILE)).mode & 0o777, 0o640);
});

test("a byte order mark is kept", () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, ".jgates"));
  fs.writeFileSync(path.join(dir, FILE), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{\n  "waivers": []\n}\n')]));
  commit(add(dir));
  const bytes = fs.readFileSync(path.join(dir, FILE));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(JSON.parse(bytes.subarray(3).toString("utf8")).waivers.length, 1);
});

test("an entry that is already live is refused; an expired one can be made again", () => {
  const dir = project();
  commit(add(dir));
  assert.equal(add(dir).code, "WAIVER_ALREADY_EXISTS");
  const later = new Date("3000-06-01T00:00:00Z");
  assert.equal(wf.prepareAdd(dir, { result, findings: [wf.shortFingerprint(result.findings[1].fingerprint)], until: "3001-01-01", reason: "again", now: later }).ok, true);
});

test("listing shows the state of every entry and whether it matched something in the last validation", () => {
  const dir = project();
  commit(add(dir));
  commit(add(dir, { findings: [wf.shortFingerprint(result.findings[2].fingerprint)], until: "2026-11-20", reason: "short lived" }));
  fs.writeFileSync(
    path.join(dir, FILE),
    JSON.stringify({ waivers: [...JSON.parse(read(dir)).waivers, { rule: "hand.rule", path: "docs/*", reason: "hand written" }, { rule: "old.rule", reason: "old", expires: "2020-01-01" }] }, null, 2) + "\n",
  );
  const readBack = wf.readWaiverFile(dir);
  const listing = wf.listWaivers(readBack, result, "run_1", NOW);
  assert.equal(listing.runId, "run_1");
  assert.deepEqual(listing.waivers.map((w) => [w.kind, w.state, w.matched, w.matchedFindings]), [
    ["occurrence", "live", true, 1],
    ["occurrence", "live", true, 1],
    ["handwritten", "live", false, 0],
    ["handwritten", "expired", false, 0],
  ]);
  assert.deepEqual([listing.waivers[0].tool, listing.waivers[0].rule, listing.waivers[0].path, listing.waivers[0].line], ["scanner", "scan.risky", "src/app.js", 20]);
  assert.deepEqual([listing.waivers[2].rule, listing.waivers[2].path, listing.waivers[2].line], ["hand.rule", "docs/*", undefined]);

  // The flagged line changed (the anchors of the run are different): the entries are stale.
  const moved = { findings: result.findings.map((f) => ({ ...f, anchor: f.anchor + "0" })) };
  const stale = wf.listWaivers(readBack, moved, "run_2", NOW);
  assert.deepEqual(stale.waivers.slice(0, 2).map((w) => [w.state, w.cause]), [["stale", "line-changed"], ["stale", "line-changed"]]);
  // Without a validation nothing can be said about a match.
  assert.equal(wf.listWaivers(readBack, null, null, NOW).waivers[0].matched, null);
  assert.equal(wf.listWaivers(readBack, result, "r", NOW).waivers.map((w) => w.id).join(), listing.waivers.map((w) => w.id).join(), "ids are stable across calls");
});

test("a link in place of the waiver file or of .jgates is not followed", { skip: process.platform === "win32" ? "symbolic links need privileges here" : false }, () => {
  const outside = project({ "elsewhere.json": "[]\n" });
  const dir = project({ ".jgates/placeholder": "" });
  fs.symlinkSync(path.join(outside, "elsewhere.json"), path.join(dir, FILE));
  assert.equal(add(dir).code, "WAIVER_FILE_UNSAFE");
  assert.equal(fs.readFileSync(path.join(outside, "elsewhere.json"), "utf8"), "[]\n");
});
