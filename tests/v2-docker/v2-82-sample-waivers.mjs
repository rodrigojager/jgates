import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-82 (real engine): waivers on the sample project. The sample (JGATES_SAMPLE_PROJECT, by default the maintainer's
// `D:/projeto-teste-jgates`, branch `master` with its twelve problems) is never used in place: the test clones it
// (`git clone --no-hardlinks`) into JGATES_E2E_TMP, by default the `_work/00-tmp` folder of the container that holds this
// repository when there is one, else the system temporary folder. With the local development image jgates-tools:dev:
//
//   1. the clone is validated under Balanced (profile `standard`): it fails, with no waiver;
//   2. two findings of that run (the Ruff F401 of hello/cli.py and the Semgrep command injection of
//      hello/infrastructure/system.py) are dismissed until a date with `jgates waivers add`, which writes exactly those
//      two entries to the clone's `.jgates/waivers.json` and changes no other byte of the clone;
//   3. the next validation shows both as dismissed (waived, by the project's file, until that date), `waivers.count` 2,
//      two fewer blocking findings, and every other finding unchanged; the text says "Waivers applied (2)" (pt-BR
//      "Dispensas aplicadas (2)") and never "approved with";
//   4. `jgates run --no-waivers` counts them again: the same findings as the first run, none waived, both waivers listed
//      under `waivers.refused`.
// The runs change nothing in the clone, the sample's tree hash is the same before and after, no container of the clone's
// workspace and no new JGates temporary file (os.tmpdir()/jgates-*) is left. The clone and the engine objects of its
// workspace (by label) are removed by the test's own cleanup.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const IMAGE = "jgates-tools:dev";
const DEFAULT_SAMPLE = "D:/projeto-teste-jgates";
const REASON = "accepted until the refactor of the CLI";
// The two findings to dismiss: one per tool, each a single occurrence on master.
const CHOSEN = [
  { tool: "ruff", rule: "F401", file: "hello/cli.py" },
  { tool: "semgrep", rule: "jgates.python.os-command-injection", file: "hello/infrastructure/system.py" },
];

const docker = (args) => {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** Where the clone goes: JGATES_E2E_TMP, else the container's `_work/00-tmp` next to this repository, else the system temp. */
function scratchBase() {
  if (process.env.JGATES_E2E_TMP) return path.resolve(process.env.JGATES_E2E_TMP);
  const container = path.join(root, "..", "_work", "00-tmp");
  return fs.existsSync(container) ? container : os.tmpdir();
}

/** Every entry of a tree: relative path -> kind, size, mtime and content hash, in a stable order. */
function treeEntries(dir) {
  const out = new Map();
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(full);
      if (entry.isDirectory()) {
        out.set(next, "d");
        walk(full, next);
      } else if (entry.isSymbolicLink()) out.set(next, `l:${fs.readlinkSync(full)}`);
      else out.set(next, `f:${stat.size}:${stat.mtimeMs}:${crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`);
    }
  };
  walk(dir, "");
  return out;
}
/** Hash of the whole tree (paths, kinds, sizes, mtimes and contents). */
const treeHash = (dir) => crypto.createHash("sha256").update(JSON.stringify([...treeEntries(dir)])).digest("hex");
/** The paths whose entry differs between two snapshots (added, removed or changed). */
function changedPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((p) => before.get(p) !== after.get(p)).sort();
}

/** The JGates temporary entries of the system temporary folder. */
const jgatesTemp = () => new Set(fs.readdirSync(os.tmpdir()).filter((name) => /^jgates-/i.test(name)));

/** A local date (YYYY-MM-DD) some days from today, as the dialog's ready dates give it. */
function localDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const fileOf = (f) => (f.location?.path ?? "").replace(/\\/g, "/");
const key = (f) => `${f.fingerprint} ${f.tool} ${f.ruleId} ${fileOf(f)}:${f.location?.line ?? ""}`;
const blocking = (result) => result.findings.filter((f) => f.blocking === true && f.waived !== true);
function summary(result) {
  return JSON.stringify({
    decision: result.decision,
    waivers: result.waivers ? { count: result.waivers.count, applied: result.waivers.applied?.length, refused: result.waivers.refused?.length } : null,
    stages: result.stages.filter((s) => s.state !== "completed").map((s) => `${s.id}=${s.state}`),
    findings: result.findings.map((f) => `${key(f)}${f.waived ? " waived" : ""}${f.blocking ? " *" : ""}`),
  }, null, 1);
}

test("V2-82 (real engine): on a clone of the sample, two findings dismissed until a date show as dismissed in the next validation with waivers.count 2 and the others unchanged, the clone's .jgates/waivers.json has exactly the two entries, --no-waivers counts them again, and the sample is untouched", { timeout: 3_600_000 }, async (t) => {
  let scratch = "";
  let workspace = "";
  // The cleanup belongs to this test (a root `after` hook can run before the test when the harness filters by name).
  t.after(() => {
    if (workspace) {
      const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${workspace}`];
      for (const id of lines(docker(["ps", "-aq", ...filters]).out)) docker(["rm", "-f", id]);
      for (const id of lines(docker(["network", "ls", "-q", ...filters]).out)) docker(["network", "rm", id]);
      for (const name of lines(docker(["volume", "ls", "-q", ...filters]).out)) docker(["volume", "rm", "-f", name]);
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  assert.equal(docker(["version", "--format", "{{.Server.Version}}"]).code, 0, "Docker is required for the real-engine acceptance cases (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
  const source = path.resolve(process.env.JGATES_SAMPLE_PROJECT || DEFAULT_SAMPLE);
  assert.ok(fs.existsSync(path.join(source, ".git")), `the sample project ${source} is not a Git repository (set JGATES_SAMPLE_PROJECT to a clone of it)`);
  const { workspaceId } = await import(pathToFileURL(path.join(dist, "core", "ids", "index.js")).href);

  // The clone, in a fresh scratch folder; the sample is only read (cloned and hashed).
  const sourceBefore = treeHash(source);
  const tempBefore = jgatesTemp();
  fs.mkdirSync(scratchBase(), { recursive: true });
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(scratchBase(), "v2-82-waivers-")));
  const project = path.join(scratch, "projeto-teste-jgates");
  const home = path.join(scratch, "home");
  git(scratch, ["clone", "--quiet", "--no-hardlinks", source, project]);
  git(project, ["checkout", "--quiet", "master"]);
  fs.mkdirSync(home);
  workspace = workspaceId(project);
  const waiverFile = path.join(project, ".jgates", "waivers.json");
  assert.equal(fs.existsSync(waiverFile), false, "the sample commits no waiver file");

  const baseEnv = { ...process.env, JGATES_HOME: home, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  // The real engine (the node test runs name a missing engine client by default, tests/setup/in-image.mjs).
  if (baseEnv.JGATES_CONTAINER_RUNTIME === "jgates-test-no-engine") delete baseEnv.JGATES_CONTAINER_RUNTIME;
  const cli = (args, { locale = "en", timeout = 1_500_000 } = {}) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env: { ...baseEnv, JGATES_LOCALE: locale }, input: "", timeout, maxBuffer: 256 * 1024 * 1024 });
  const runJson = (extra = []) => {
    const r = cli(["run", "--cwd", project, "--no-interactive", ...extra, "--json"]);
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      assert.fail(`no JSON from jgates run ${extra.join(" ")} (exit ${r.status}):\n${r.stdout.slice(0, 2000)}\n${r.stderr.slice(0, 2000)}`);
    }
    return { status: r.status, doc };
  };
  const reportText = (runId, locale) => {
    const r = cli(["report", runId, "--cwd", project, "--format", "text"], { locale, timeout: 120_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };

  // 1. Balanced, then the first validation: it fails on master, with no waiver.
  const init = cli(["init", "--cwd", project, "--profile", "standard", "--no-interactive", "--json"], { timeout: 300_000 });
  assert.equal(init.status, 0, init.stderr + init.stdout);
  const first = runJson();
  const firstSummary = summary(first.doc);
  assert.equal(first.status, 1, firstSummary);
  assert.equal(first.doc.decision, "failed", firstSummary);
  assert.equal(first.doc.waivers.count, 0, firstSummary);
  assert.ok(first.doc.findings.every((f) => f.waived !== true), firstSummary);
  const chosen = CHOSEN.map((c) => {
    const found = first.doc.findings.filter((f) => f.tool === c.tool && f.ruleId === c.rule && fileOf(f) === c.file);
    assert.equal(found.length, 1, `exactly one ${c.tool} ${c.rule} finding in ${c.file}: ${firstSummary}`);
    const finding = found[0];
    assert.match(String(finding.fingerprint), /^jgf1:[0-9a-f]{12,}/, `${c.rule} has a fingerprint`);
    assert.equal(finding.blocking, true, `${c.rule} blocks before it is dismissed`);
    assert.equal(first.doc.stages.find((s) => s.id === finding.stageId)?.state, "completed", `the check of ${c.rule} completed`);
    return finding;
  });
  const chosenFingerprints = new Set(chosen.map((f) => f.fingerprint));
  const others = first.doc.findings.filter((f) => !chosenFingerprints.has(f.fingerprint));
  assert.ok(others.length >= 10, `master keeps its other problems: ${firstSummary}`);

  // 2. Both dismissed until a date, by their short fingerprints: the file gets exactly the two entries and nothing else changes.
  const until = localDate(90);
  const beforeAdd = treeEntries(project);
  const short = (f) => String(f.fingerprint).replace(/^jgf1:/, "").slice(0, 12);
  const add = cli(["waivers", "add", "--cwd", project, "--finding", short(chosen[0]), "--finding", short(chosen[1]), "--until", until, "--reason", REASON, "--json"], { timeout: 120_000 });
  assert.equal(add.status, 0, add.stdout + add.stderr);
  const added = JSON.parse(add.stdout);
  assert.equal(added.created, true, add.stdout);
  assert.equal(added.added.length, 2, add.stdout);
  const expectedChange = beforeAdd.has(".jgates") ? [".jgates/waivers.json"] : [".jgates", ".jgates/waivers.json"];
  assert.deepEqual(changedPaths(beforeAdd, treeEntries(project)), expectedChange, "the dismissal writes only .jgates/waivers.json");
  const doc = JSON.parse(fs.readFileSync(waiverFile, "utf8"));
  const entries = Array.isArray(doc) ? doc : doc.waivers;
  assert.equal(entries.length, 2, `exactly the two entries: ${JSON.stringify(doc)}`);
  assert.deepEqual(
    entries.map((e) => [e.tool, e.rule, e.path, e.fingerprint, e.reason, e.expires]).sort(),
    chosen.map((f) => [f.tool, f.ruleId, fileOf(f), f.fingerprint, REASON, until]).sort(),
  );
  for (const e of entries) assert.match(String(e.anchor), /^jga1:/, `the entry of ${e.rule} points at its occurrence by the anchor`);
  const afterAdd = treeEntries(project);

  // 3. The next validation: both dismissed, waivers.count 2, the others unchanged.
  const second = runJson();
  const secondSummary = summary(second.doc);
  assert.equal(second.doc.decision, "failed", `master still fails on its other problems: ${secondSummary}`);
  assert.equal(second.status, 1, secondSummary);
  assert.equal(second.doc.waivers.count, 2, secondSummary);
  assert.equal(second.doc.waivers.findings, 2, secondSummary);
  assert.deepEqual(second.doc.waivers.refused, []);
  assert.deepEqual([second.doc.waivers.stale.length, second.doc.waivers.expired.length, second.doc.waivers.unmatched.length], [0, 0, 0], secondSummary);
  assert.deepEqual(
    second.doc.waivers.applied.map((w) => [w.source, w.rule, w.path, w.reason, w.expires, w.findings]).sort(),
    chosen.map((f) => ["project", f.ruleId, fileOf(f), REASON, until, 1]).sort(),
  );
  for (const f of chosen) {
    const now = second.doc.findings.filter((x) => x.fingerprint === f.fingerprint);
    assert.equal(now.length, 1, `${f.ruleId} is still found: ${secondSummary}`);
    assert.equal(now[0].waived, true, `${f.ruleId} shows as dismissed`);
    assert.equal(now[0].waiverSource, "project");
    assert.equal(now[0].waiverExpires, until);
    assert.equal(now[0].blocking, false, `${f.ruleId} no longer blocks`);
  }
  const othersNow = second.doc.findings.filter((x) => !chosenFingerprints.has(x.fingerprint));
  assert.deepEqual(othersNow.map(key).sort(), others.map(key).sort(), `the other findings are the same: ${secondSummary}`);
  for (const f of othersNow) {
    const before = others.find((o) => key(o) === key(f));
    assert.equal(f.waived, false, `${key(f)} is not waived`);
    assert.equal(f.blocking, before.blocking, `${key(f)} blocks as before`);
    assert.equal(f.normalizedSeverity, before.normalizedSeverity, `${key(f)} keeps its severity`);
  }
  assert.deepEqual(second.doc.stages.map((s) => `${s.id}=${s.state}`), first.doc.stages.map((s) => `${s.id}=${s.state}`), "a waiver changes no check's state");
  assert.equal(blocking(second.doc).length, blocking(first.doc).length - 2, "two fewer blocking findings");
  const en = reportText(second.doc.runId, "en");
  assert.match(en, /Waivers applied \(2\):/, en);
  assert.match(en, new RegExp(`F401\\s+hello/cli\\.py:\\d+\\s+"${REASON}"\\s+until ${until}`), en);
  const violationsWaived = Number(/Decision: failed \(failed: (\d+) blocking violations?\)/.exec(en)?.[1] ?? NaN);
  assert.ok(violationsWaived > 0, `the text gives the failed decision with its blocking violations:\n${en}`);
  assert.doesNotMatch(en, /approved with/, "a failed run is never worded as an approval");
  const pt = reportText(second.doc.runId, "pt-BR");
  assert.match(pt, /Dispensas aplicadas \(2\):/, pt);
  assert.match(pt, new RegExp(`até ${until}`), pt);
  assert.doesNotMatch(pt, /aprovado com/, pt);
  assert.deepEqual(changedPaths(afterAdd, treeEntries(project)), [], "the validation changed nothing in the clone");

  // 4. --no-waivers counts them again: the findings of the first run, none waived, both waivers refused.
  const third = runJson(["--no-waivers"]);
  const thirdSummary = summary(third.doc);
  assert.equal(third.status, 1, thirdSummary);
  assert.equal(third.doc.decision, "failed", thirdSummary);
  assert.equal(third.doc.waivers.count, 0, thirdSummary);
  assert.deepEqual(third.doc.waivers.applied, []);
  assert.deepEqual(third.doc.waivers.refused.map((w) => [w.source, w.rule, w.path, w.findings]).sort(), chosen.map((f) => ["project", f.ruleId, fileOf(f), 1]).sort(), thirdSummary);
  assert.deepEqual(third.doc.findings.map(key).sort(), first.doc.findings.map(key).sort(), `the same findings as the first run: ${thirdSummary}`);
  assert.ok(third.doc.findings.every((f) => f.waived !== true), thirdSummary);
  for (const f of chosen) assert.equal(third.doc.findings.find((x) => x.fingerprint === f.fingerprint).blocking, true, `${f.ruleId} blocks again`);
  assert.equal(blocking(third.doc).length, blocking(first.doc).length, "the blocking findings count as in the first run");
  const refusedText = reportText(third.doc.runId, "en");
  assert.match(refusedText, /Waivers not accepted \(--no-waivers\): 2 waivers would have applied:/, refusedText);
  assert.ok(refusedText.includes(short(chosen[0])) && refusedText.includes(short(chosen[1])), `both short fingerprints are listed to fix again:\n${refusedText}`);
  const violationsRefused = Number(/Decision: failed \(failed: (\d+) blocking violations?\)/.exec(refusedText)?.[1] ?? NaN);
  assert.equal(violationsRefused, violationsWaived + 2, `--no-waivers counts the two dismissed findings as blocking violations again:\n${refusedText}`);
  assert.deepEqual(changedPaths(afterAdd, treeEntries(project)), [], "the --no-waivers run changed nothing in the clone");

  // The sample was only read; no container of the workspace and no JGates temporary file is left.
  assert.equal(treeHash(source), sourceBefore, "the sample project is byte-identical (tree hash) before and after");
  assert.deepEqual(lines(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${workspace}`]).out), [], "no container of the clone's workspace is left");
  const leftover = [...jgatesTemp()].filter((name) => !tempBefore.has(name));
  assert.deepEqual(leftover, [], `no JGates temporary file is left in ${os.tmpdir()}`);
});
