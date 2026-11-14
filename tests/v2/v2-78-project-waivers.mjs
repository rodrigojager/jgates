import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-78 (fake engine): the project's waivers from the terminal (PLAN-waivers.md sections 3 and 5). `jgates waivers add`
// writes one entry of .jgates/waivers.json and changes nothing else in a hand-written file (the list shape and the
// object shape, other entries, unknown keys); a missing file is created as an object with `waivers`; `remove` takes the
// entry out and leaves the rest byte for byte; the entry applies in the next run and an expired one does not. Refusals
// (no date, a past date, a bad reason, an ambiguous or unknown fingerprint, a file that cannot be parsed) exit 3 and write
// nothing; without --yes `add` shows the entry and does not write when there is nobody to ask; `list` shows each entry with
// its state and whether it matched in the last validation; governed (read-only) mode refuses add and remove. Nothing is
// created outside the project folder: the JGates data folder holds no waiver data. `jgates ci` refusing --waiver and
// ignoring the project's file is proved in jgates/tests/ci-governed.test.js.
//
// Most cases take the findings from a stored result written into the data folder of a throwaway workspace (so the
// fingerprints are known); one case runs the real CLI against the fake engine, with the built-in personal-data check
// (the fake engine "detects" a formatted CPF), as V2-61 and V2-77 do.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(root, "jgates", "dist");
const MAIN = path.join(DIST, "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const { workspaceId } = await import(pathToFileURL(path.join(DIST, "core", "ids", "index.js")).href);
const CPF = "529.982.247-25";
const FILE = ".jgates/waivers.json";

const made = [];
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const write = (dir, files) => {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
};

/** Every file under dir (relative path, forward slashes) with its text; `.git` is left out. */
function snapshot(dir) {
  const out = new Map();
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) walk(child);
      else out.set(child, fs.readFileSync(path.join(dir, child), "utf8"));
    }
  };
  walk("");
  return out;
}
const changedFiles = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();

const finding = (n, extra = {}) => ({
  stageId: "scan",
  tool: "scanner",
  ruleId: "scan.risky",
  severity: "high",
  fingerprint: `jgf1:${String(n).padStart(2, "0")}${"ab".repeat(15)}`,
  anchor: `jga1:${String(n).padStart(2, "0")}${"cd".repeat(15)}`,
  location: { path: "src/app.js", line: n * 10 },
  message: "a risky call",
  blocking: true,
  waived: false,
  ...extra,
});

/** A throwaway project and data folder holding one finished run with these findings. */
function crafted(findings = [finding(1), finding(2), finding(3)], runId = "run_20261114T100000Z_aaaaaaaa") {
  const project = tmp("v2-78-project-");
  const home = tmp("v2-78-home-");
  const storeRun = (id, list, startedAt) => {
    const dir = path.join(home, "workspaces", workspaceId(project), "runs", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "result.json"), `${JSON.stringify({ schemaVersion: 1, runId: id, decision: "failed", startedAt, stages: [{ id: "scan", state: "completed" }], findings: list })}\n`);
  };
  storeRun(runId, findings, "2026-11-14T10:00:00.000Z");
  const cli = (args, { locale = "en", env = {} } = {}) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env: { ...process.env, JGATES_HOME: home, JGATES_LOCALE: locale, NO_COLOR: "1", ...env }, input: "", timeout: 120_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const json = (args, options) => {
    const r = cli([...args, "--json"], options);
    try {
      return { ...r, doc: JSON.parse(r.out) };
    } catch {
      assert.fail(`no JSON from ${args.join(" ")}: ${r.out}\n${r.err}`);
    }
  };
  const short = (f) => f.fingerprint.replace(/^jgf1:/, "").slice(0, 12);
  const add = (f, extra = []) => json(["waivers", "add", "--cwd", project, "--finding", short(f), "--until", "2999-12-31", "--reason", "false positive", "--yes", ...extra]);
  return { project, home, cli, json, short, add, storeRun, findings };
}

test("V2-78: add writes one entry in a hand-written object file and nothing else changes; remove gives the file back", () => {
  const before = '{\n  "$comment": "team file",\n  "waivers": [\n    { "rule": "x.y", "path": "legacy/*", "reason": "legacy", "owner": "ana" }\n  ],\n  "note": 1\n}\n';
  const p = crafted();
  write(p.project, { [FILE]: before });
  const r = p.add(p.findings[1]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.doc.added.length, 1);
  const after = fs.readFileSync(path.join(p.project, FILE), "utf8");
  const cut = before.indexOf("\n  ],");
  assert.equal(after.slice(0, cut), before.slice(0, cut), "everything before the end of the list is the same bytes");
  assert.ok(after.endsWith(before.slice(cut)), "everything after the list is the same bytes");
  const middle = after.slice(cut, after.length - (before.length - cut));
  assert.match(middle, /^,\n    \{\n/, "the entry is appended with the indentation of the others");
  const entry = JSON.parse(middle.slice(1));
  assert.deepEqual(entry, { tool: "scanner", rule: "scan.risky", path: "src/app.js", fingerprint: p.findings[1].fingerprint, anchor: p.findings[1].anchor, occurrences: 3, line: 20, reason: "false positive", created: entry.created, expires: "2999-12-31" });
  assert.match(entry.created, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.doc.added[0].id.length, 8);

  const removed = p.json(["waivers", "remove", r.doc.added[0].id, "--cwd", p.project]);
  assert.equal(removed.code, 0, removed.out + removed.err);
  assert.equal(fs.readFileSync(path.join(p.project, FILE), "utf8"), before, "the file is byte for byte what it was");
});

test("V2-78: a hand-written list file keeps its shape, and entries are added and removed at the end and in the middle", () => {
  const before = '[\n  {"rule":"a.b","path":"x/*","reason":"hand","extra":true},\n  {"rule":"c.d","reason":"other"}\n]\n';
  const p = crafted();
  write(p.project, { [FILE]: before });
  const a = p.add(p.findings[0]);
  const b = p.add(p.findings[2]);
  assert.equal(a.code, 0, a.out + a.err);
  assert.equal(b.code, 0, b.out + b.err);
  const after = fs.readFileSync(path.join(p.project, FILE), "utf8");
  assert.ok(after.startsWith(before.slice(0, before.indexOf("\n]"))), "the hand-written entries are untouched");
  const list = JSON.parse(after);
  assert.ok(Array.isArray(list));
  assert.equal(list.length, 4);
  assert.equal(list[2].line, 10);
  assert.equal(list[3].line, 30);
  // Removing the entry that was added first leaves the hand-written ones and the other new one as they were.
  const out = p.json(["waivers", "remove", a.doc.added[0].id, "--cwd", p.project]);
  assert.equal(out.code, 0, out.out + out.err);
  const left = fs.readFileSync(path.join(p.project, FILE), "utf8");
  assert.ok(left.startsWith(before.slice(0, before.indexOf("\n]"))));
  assert.deepEqual(JSON.parse(left).map((e) => e.line), [undefined, undefined, 30]);
  // A unique prefix of the id works.
  const both = p.json(["waivers", "remove", b.doc.added[0].id.slice(0, 5), "--cwd", p.project]);
  assert.equal(both.code, 0, both.out + both.err);
  assert.equal(fs.readFileSync(path.join(p.project, FILE), "utf8"), before);
});

test("V2-78: a missing file is created as an object with waivers; --finding may repeat; --run names the run", () => {
  const p = crafted();
  const older = [finding(7)];
  p.storeRun("run_20261001T100000Z_bbbbbbbb", older, "2026-10-01T10:00:00.000Z");
  assert.equal(fs.existsSync(path.join(p.project, FILE)), false);
  const r = p.json(["waivers", "add", "--cwd", p.project, "--finding", p.short(p.findings[0]), "--finding", `jgf1:${p.short(p.findings[2])}`, "--until", "2999-12-31", "--reason", "two at once", "--yes"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.doc.created, true);
  const text = fs.readFileSync(path.join(p.project, FILE), "utf8");
  assert.ok(text.startsWith('{\n  "waivers": [\n    {\n'), text);
  assert.ok(text.endsWith("\n    }\n  ]\n}\n"), text);
  assert.deepEqual(JSON.parse(text).waivers.map((e) => e.line), [10, 30]);
  // The last validation is the newest run; --run reaches the older one.
  const old = p.json(["waivers", "add", "--cwd", p.project, "--run", "run_20261001T100000Z_bbbbbbbb", "--finding", p.short(older[0]), "--until", "2999-12-31", "--reason", "from an older run", "--yes"]);
  assert.equal(old.code, 0, old.out + old.err);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.project, FILE), "utf8")).waivers[2].line, 70);
  const missing = p.json(["waivers", "add", "--cwd", p.project, "--run", "run_nope", "--finding", p.short(older[0]), "--until", "2999-12-31", "--reason", "from nowhere", "--yes"]);
  assert.equal(missing.code, 3);
  // Removing the only entries leaves an empty list in the same shape.
  const ids = p.json(["waivers", "list", "--cwd", p.project]).doc.waivers.map((w) => w.id);
  const gone = p.json(["waivers", "remove", ...ids, "--cwd", p.project]);
  assert.equal(gone.code, 0, gone.out + gone.err);
  assert.equal(fs.readFileSync(path.join(p.project, FILE), "utf8"), '{\n  "waivers": []\n}\n');
});

test("V2-78: refusals exit 3 with a code and write nothing", () => {
  const twin = finding(1, { fingerprint: "jgf1:01abef" + "ef".repeat(13), anchor: "jga1:" + "ee".repeat(16), location: { path: "src/other.js", line: 5 } });
  const p = crafted([finding(1), twin, finding(2)]);
  const original = '{\n  "waivers": [\n    { "rule": "x.y", "reason": "keep me" }\n  ]\n}\n';
  write(p.project, { [FILE]: original });
  const home = snapshot(p.home);
  const ok = ["--finding", p.short(p.findings[2]), "--until", "2999-12-31", "--reason", "fine reason"];
  const without = (flag) => {
    const out = [...ok];
    const i = out.indexOf(flag);
    out.splice(i, 2);
    return out;
  };
  const cases = [
    ["no date", without("--until"), "WAIVER_UNTIL_REQUIRED"],
    ["a past date", ["--finding", p.short(p.findings[2]), "--until", "2020-01-01", "--reason", "fine reason"], "WAIVER_UNTIL_PAST"],
    ["not a date", ["--finding", p.short(p.findings[2]), "--until", "tomorrow", "--reason", "fine reason"], "WAIVER_UNTIL_INVALID"],
    ["no reason", without("--reason"), "WAIVER_REASON_INVALID"],
    ["a reason of 2 characters", ["--finding", p.short(p.findings[2]), "--until", "2999-12-31", "--reason", "ab"], "WAIVER_REASON_INVALID"],
    ["a reason of 301 characters", ["--finding", p.short(p.findings[2]), "--until", "2999-12-31", "--reason", "x".repeat(301)], "WAIVER_REASON_INVALID"],
    ["a reason with a control character", ["--finding", p.short(p.findings[2]), "--until", "2999-12-31", "--reason", "bad\treason"], "WAIVER_REASON_INVALID"],
    ["no finding", without("--finding"), "WAIVER_FINDING_REQUIRED"],
    ["an ambiguous prefix", ["--finding", "01ab", "--until", "2999-12-31", "--reason", "fine reason"], "WAIVER_FINDING_AMBIGUOUS"],
    ["a fingerprint that is not in the run", ["--finding", "0123456789ab", "--until", "2999-12-31", "--reason", "fine reason"], "WAIVER_FINDING_NOT_FOUND"],
  ];
  for (const [name, args, code] of cases) {
    const r = p.json(["waivers", "add", "--cwd", p.project, "--yes", ...args]);
    assert.equal(r.code, 3, `${name}: ${r.out}${r.err}`);
    assert.equal(r.doc.status, "ERROR", name);
    assert.equal(r.doc.code, code, name);
    assert.equal(fs.readFileSync(path.join(p.project, FILE), "utf8"), original, `${name}: the file is untouched`);
  }
  // The ambiguous prefix names its candidates, in the text too.
  const amb = p.cli(["waivers", "add", "--cwd", p.project, "--yes", "--finding", "01ab", "--until", "2999-12-31", "--reason", "fine reason"]);
  assert.equal(amb.code, 3);
  assert.ok(amb.err.includes(p.short(p.findings[0])) && amb.err.includes(p.short(twin)), amb.err);
  // A refusal in the other language.
  const pt = p.cli(["waivers", "add", "--cwd", p.project, "--yes", "--finding", p.short(p.findings[2]), "--reason", "fine reason"], { locale: "pt-BR" });
  assert.equal(pt.code, 3);
  assert.match(pt.err, /data final é obrigatória/);
  // remove: no id, an unknown id.
  assert.equal(p.json(["waivers", "remove", "--cwd", p.project]).doc.code, "WAIVER_ID_REQUIRED");
  const unknown = p.json(["waivers", "remove", "deadbeef", "--cwd", p.project]);
  assert.equal(unknown.code, 3);
  assert.equal(unknown.doc.code, "WAIVER_NOT_FOUND");
  assert.equal(fs.readFileSync(path.join(p.project, FILE), "utf8"), original);
  assert.deepEqual(changedFiles(home, snapshot(p.home)), [], "the data folder is untouched");
});

test("V2-78: a file that cannot be parsed is reported with where the problem is and is never rewritten", () => {
  const p = crafted();
  const bad = '{\n  "waivers": [\n    { "rule": "a.b", "reason": "broken"\n  ]\n}\n';
  write(p.project, { [FILE]: bad });
  for (const args of [
    ["waivers", "add", "--cwd", p.project, "--finding", p.short(p.findings[0]), "--until", "2999-12-31", "--reason", "fine reason", "--yes"],
    ["waivers", "remove", "abcd1234", "--cwd", p.project],
    ["waivers", "list", "--cwd", p.project],
  ]) {
    const r = p.json(args);
    assert.equal(r.code, 3, args.join(" ") + r.out + r.err);
    assert.equal(r.doc.code, "WAIVER_FILE_INVALID");
    assert.match(r.doc.message, /line 4, column \d+/, r.doc.message);
    assert.equal(fs.readFileSync(path.join(p.project, FILE), "utf8"), bad);
  }
  const pt = p.cli(["waivers", "list", "--cwd", p.project], { locale: "pt-BR" });
  assert.match(pt.err, /linha 4, coluna \d+/);
  // A file that is valid JSON but holds neither a list nor a waivers object is not rewritten either.
  write(p.project, { [FILE]: '{ "other": [] }\n' });
  const odd = p.json(["waivers", "add", "--cwd", p.project, "--finding", p.short(p.findings[0]), "--until", "2999-12-31", "--reason", "fine reason", "--yes"]);
  assert.equal(odd.doc.code, "WAIVER_FILE_INVALID");
  assert.equal(fs.readFileSync(path.join(p.project, FILE), "utf8"), '{ "other": [] }\n');
});

test("V2-78: list and --json show the id, tool, rule, file and line, reason, date, state and the match of the last validation", () => {
  const p = crafted();
  const a = p.add(p.findings[1]);
  const short = p.json(["waivers", "add", "--cwd", p.project, "--finding", p.short(p.findings[2]), "--until", "2999-12-31", "--reason", "will expire", "--yes"]);
  assert.equal(short.code, 0, short.out + short.err);
  // A hand-written entry that matches nothing, an expired one, and one whose line changed (another anchor).
  const doc = JSON.parse(fs.readFileSync(path.join(p.project, FILE), "utf8"));
  doc.waivers[1].expires = "2020-01-01";
  doc.waivers.push({ rule: "hand.rule", path: "docs/*", reason: "hand written", expires: "2999-12-31" });
  doc.waivers.push({ ...doc.waivers[0], anchor: "jga1:" + "00".repeat(16), line: 99, reason: "line moved" });
  write(p.project, { [FILE]: `${JSON.stringify(doc, null, 2)}\n` });

  const r = p.json(["waivers", "list", "--cwd", p.project]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.doc.file, FILE);
  assert.equal(r.doc.runId, "run_20261114T100000Z_aaaaaaaa");
  const rows = r.doc.waivers;
  assert.equal(rows[0].id, a.doc.added[0].id, "the id is the one `add` printed");
  assert.deepEqual(
    rows.map((w) => [w.kind, w.state, w.matched, w.reason]),
    [
      ["occurrence", "live", true, "false positive"],
      ["occurrence", "expired", false, "will expire"],
      ["handwritten", "live", false, "hand written"],
      ["occurrence", "stale", false, "line moved"],
    ],
  );
  assert.deepEqual([rows[0].tool, rows[0].rule, rows[0].path, rows[0].line, rows[0].expires], ["scanner", "scan.risky", "src/app.js", 20, "2999-12-31"]);
  assert.deepEqual([rows[2].rule, rows[2].path], ["hand.rule", "docs/*"]);
  assert.equal(rows[3].cause, "line-changed");
  const again = p.json(["waivers", "list", "--cwd", p.project]);
  assert.deepEqual(
    again.doc.waivers.map((w) => w.id),
    rows.map((w) => w.id),
    "the ids are the same on every call",
  );

  const text = p.cli(["waivers", "list", "--cwd", p.project]);
  assert.equal(text.code, 0, text.err);
  const lines = text.out.trim().split("\n");
  assert.equal(lines.length, 4);
  assert.ok(lines[0].startsWith(rows[0].id) && lines[0].includes("live") && lines[0].includes("scanner/scan.risky") && lines[0].includes("src/app.js:20") && lines[0].includes("until 2999-12-31") && lines[0].includes("false positive") && lines[0].includes("waived 1 finding in the last validation"), lines[0]);
  assert.ok(lines[1].includes("expired") && lines[2].includes("hand.rule") && lines[2].includes("docs/*") && lines[2].includes("matched nothing in the last validation"), text.out);
  assert.ok(lines[3].includes("stale"), lines[3]);
  const pt = p.cli(["waivers", "list", "--cwd", p.project], { locale: "pt-BR" });
  assert.ok(pt.out.includes("até 2999-12-31") && pt.out.includes("vencida") && pt.out.includes("dispensou 1 achado na última validação"), pt.out);
});

test("V2-78: without --yes `add` shows the entry and writes nothing when nobody can be asked; --json never asks", () => {
  const p = crafted();
  const args = ["waivers", "add", "--cwd", p.project, "--finding", p.short(p.findings[0]), "--until", "2999-12-31", "--reason", "fine reason"];
  const r = p.cli(args);
  assert.equal(r.code, 3, r.out + r.err);
  assert.ok(r.out.includes('"rule": "scan.risky"') && r.out.includes("+++ b/.jgates/waivers.json"), "the entry and the change of the file are shown");
  assert.equal(fs.existsSync(path.join(p.project, FILE)), false);
  const json = p.json(args);
  assert.equal(json.code, 0, json.out + json.err);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.project, FILE), "utf8")).waivers.length, 1);
});

test("V2-78: in governed (read-only) mode add and remove are refused with the reason and write nothing", () => {
  const p = crafted();
  const entry = p.add(p.findings[0]);
  const before = fs.readFileSync(path.join(p.project, FILE), "utf8");
  const policy = tmp("v2-78-policy-");
  const env = { JGATES_POLICY_DIR: policy };
  const add = p.json(["waivers", "add", "--cwd", p.project, "--finding", p.short(p.findings[1]), "--until", "2999-12-31", "--reason", "fine reason", "--yes"], { env });
  assert.equal(add.code, 3, add.out + add.err);
  assert.equal(add.doc.code, "WAIVERS_READ_ONLY");
  assert.match(add.doc.message, /governed \(read-only\)/);
  const remove = p.json(["waivers", "remove", entry.doc.added[0].id, "--cwd", p.project], { env });
  assert.equal(remove.code, 3);
  assert.equal(remove.doc.code, "WAIVERS_READ_ONLY");
  assert.equal(fs.readFileSync(path.join(p.project, FILE), "utf8"), before);
  // Listing is still allowed.
  assert.equal(p.json(["waivers", "list", "--cwd", p.project], { env }).code, 0);
});

function cliProject() {
  const project = tmp("v2-78-real-project-");
  const home = tmp("v2-78-real-home-");
  const engine = tmp("v2-78-engine-");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(path.join(engine, "calls.jsonl"))};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", NO_COLOR: "1", JGATES_LOCALE: "en" };
  delete env.JGATES_PYTHON;
  delete env.JGATES_POLICY_DIR;
  const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 240_000 });
  write(project, { "src/app.py": "def add(a, b):\n    return a + b\n", "data/customers.csv": `name,cpf\nAna,${CPF}\n` });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  const init = cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const run = () => {
    const r = cli(["run", "--cwd", project, "--no-interactive", "--only", "tool:builtin-pii", "--json"]);
    try {
      return JSON.parse(r.stdout);
    } catch {
      assert.fail(`no JSON from the run: ${r.stdout}\n${r.stderr}`);
    }
  };
  return { project, home, cli, run };
}

test("V2-78: the entry applies in the next run and an expired one does not; nothing is created outside the project", () => {
  const p = cliProject();
  const first = p.run();
  const cpf = first.findings.find((f) => f.ruleId === "pii.cpf");
  assert.ok(cpf, JSON.stringify(first.findings));
  assert.equal(cpf.waived, false);

  const projectBefore = snapshot(p.project);
  const homeBefore = snapshot(p.home);
  const short = cpf.fingerprint.replace(/^jgf1:/, "").slice(0, 12);
  const added = p.cli(["waivers", "add", "--cwd", p.project, "--finding", short, "--until", "2999-12-31", "--reason", "sample data", "--yes", "--json"]);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  const id = JSON.parse(added.stdout).added[0].id;
  assert.deepEqual(changedFiles(projectBefore, snapshot(p.project)), [FILE], "only the waiver file changed in the project");
  assert.deepEqual(changedFiles(homeBefore, snapshot(p.home)), [], "the data folder holds no waiver data");

  const waived = p.run();
  const hit = waived.findings.find((f) => f.ruleId === "pii.cpf");
  assert.equal(hit.waived, true, JSON.stringify(waived.waivers));
  assert.equal(hit.waiverReason, "sample data");
  assert.equal(waived.waivers.count, 1);
  const live = JSON.parse(p.cli(["waivers", "list", "--cwd", p.project, "--json"]).stdout);
  assert.deepEqual(live.waivers.map((w) => [w.id, w.state, w.matched]), [[id, "live", true]]);

  // The date passes: the entry stays in the file, does not apply, and is listed as expired.
  const file = path.join(p.project, FILE);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"expires": "2999-12-31"', '"expires": "2000-01-01"'));
  const expired = p.run();
  assert.equal(expired.findings.find((f) => f.ruleId === "pii.cpf").waived, false);
  assert.equal(expired.waivers.count, 0);
  assert.equal(expired.waivers.expired.length, 1);
  const lapsed = JSON.parse(p.cli(["waivers", "list", "--cwd", p.project, "--json"]).stdout);
  assert.equal(lapsed.waivers[0].state, "expired");

  // Removing it: the data folder is not touched by the command, and the project changes only in that file.
  const homeMid = snapshot(p.home);
  const projectMid = snapshot(p.project);
  const gone = p.cli(["waivers", "remove", id, "--cwd", p.project, "--json"]);
  assert.equal(gone.status, 0, gone.stdout + gone.stderr);
  assert.deepEqual(changedFiles(homeMid, snapshot(p.home)), []);
  assert.deepEqual(changedFiles(projectMid, snapshot(p.project)), [FILE]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).waivers, []);
  assert.equal(p.run().findings.find((f) => f.ruleId === "pii.cpf").waived, false);
});
