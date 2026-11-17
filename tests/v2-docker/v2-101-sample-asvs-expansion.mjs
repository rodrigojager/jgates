import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-101 (real engine): the sample project end to end with the expanded pack. The sample (JGATES_SAMPLE_PROJECT, by
// default the maintainer's `D:/projeto-teste-jgates`) is never used in place: the test clones it (`git clone
// --no-hardlinks`) into JGATES_E2E_TMP, by default the `_work/00-tmp` folder of the container that holds this repository
// when there is one, else the system temporary folder. With the local development image jgates-tools:dev:
//
//   1. the clone, validated under Balanced (profile `standard`), reports the recounted findings of master (the new pack
//      adds none to the sample: its only Semgrep finding is the command injection) and fails on its blocking ones;
//   2. a Python file written to the clone only (an HTTP call without a timeout, a suppressed exception: two pack rules of
//      severity INFO) adds exactly two informational findings, and a second one (a tar archive extracted with no visible
//      filter: one Review rule) adds exactly one finding to review: shown with their requirement ids, none blocking, and
//      the verdict and the count of blocking violations are those of the first run; the text says "and 2 informational
//      and 1 to review" (pt-BR "e 1 para revisar") and lists the finding under its own heading;
//   3. the level-2 map of that run shows no check of a language the project lacks (the Semgrep stage scanned Python files
//      only): each such check is out of the text and carries LANGUAGE_ABSENT; the Python checks ran, the command
//      injection shows as an open blocking finding of the requirement it bears on and the informational findings as open
//      informational ones; the Review rule shows as a Review check with one open finding to review on V5.2.3, which it
//      does not examine (a Review check alone never makes a requirement examined), and no requirement is examined by a
//      Review check alone; the map has at least one suggestion of "not applicable";
//   4. confirming a suggestion (`jgates coverage asvs not-applicable <id> --from-suggestion`) shows the entry first
//      (--preview writes nothing), then writes exactly `.jgates/asvs.json` of the clone, the map shows the requirement as
//      not applicable with the suggestion's reason, and the undo token takes it out;
//   5. the sample's tree hash is the same before and after, no container of the clone's workspace and no new JGates
//      temporary file is left. The clone and the engine objects of its workspace (by label) are removed by the test.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const IMAGE = "jgates-tools:dev";
const DEFAULT_SAMPLE = "D:/projeto-teste-jgates";
const FORBIDDEN = /\b(compliant|compliance|conformant|conformance|certified|certification)\b|\d\s?%/i;
const NEW_FILE = "hello/fetch.py";
// A suppressed broad exception (no `except` clause, so ruff's blind-except and try-except-pass rules stay silent) and a
// call without a timeout: only the two pack rules of severity INFO fire, nothing blocking is added.
const NEW_SOURCE = [
  "import contextlib",
  "",
  "import requests",
  "",
  "",
  "def fetch(url):",
  "    with contextlib.suppress(Exception):",
  "        return requests.get(url).json()",
  "    return None",
  "",
].join("\n");
const INFORMATIONAL = ["jgates.python.http-client-without-timeout", "jgates.python.swallowed-exception"];
// A tar archive extracted with no filter and no member check: the library's default decides, so only the Review half of
// the archive rule fires (the explicit half needs filter="fully_trusted"); nothing blocking or informational is added.
const REVIEW_FILE = "hello/archive.py";
const REVIEW_SOURCE = [
  "import tarfile",
  "",
  "",
  "def unpack(archive, destination):",
  "    with tarfile.open(archive) as bundle:",
  "        bundle.extractall(destination)",
  "",
].join("\n");
const REVIEW = "jgates.python.archive-extraction-unchecked-by-default";
// A requirement of level 2 whose only Python check is that Review rule: listed there, it examines nothing.
const REVIEW_REQUIREMENT = "V5.2.3";
// The findings of master under Balanced: tool, rule, file (no file for a project-wide one); a repeated line is two findings.
const BALANCED = [
  "builtin-pii pii.cpf tests/fixtures/customers.csv",
  "builtin-pii pii.cpf tests/fixtures/customers.csv",
  "checkov CKV_DOCKER_3 Dockerfile",
  "gitleaks stripe-access-token hello/infrastructure/config.py",
  "import-linter The domain must not depend on infrastructure hello/domain/greeting.py",
  "jscpd jscpd.duplicate hello/report.py",
  "osv-scanner PYSEC-2021-142 requirements-dev.txt",
  "osv-scanner PYSEC-2021-142 requirements.txt",
  "pytest test-failed tests/test_greeting.py",
  "ruff F401 hello/cli.py",
  "ruff F841 hello/cli.py",
  "semgrep jgates.python.os-command-injection hello/infrastructure/system.py",
  "trivy CVE-2020-14343 requirements.txt",
  "trivy DS-0002 Dockerfile",
].sort();
// Thirteen findings block; the decision counts twelve violations (the two personal-data rows of one file are one).
const BLOCKING_FINDINGS = 13;
const BLOCKING_VIOLATIONS = 12;

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

const fileOf = (f) => (f.location?.path ?? "").replace(/\\/g, "/");
const keyOf = (f) => `${f.tool} ${f.ruleId} ${fileOf(f)}`.trimEnd();
const summary = (result) => JSON.stringify({ decision: result.decision, stages: result.stages.filter((s) => s.state !== "completed").map((s) => `${s.id}=${s.state}`), findings: result.findings.map((f) => `${keyOf(f)}${f.blocking ? " *" : ""}${f.informational ? " (info)" : ""}${f.review ? " (review)" : ""}`) }, null, 1);

test("V2-101 (real engine): the sample with the expanded pack, Balanced findings recounted, informational findings and a finding to review that leave the verdict alone, a level-2 map without checks of absent languages and with a Review check that examines nothing, a suggestion confirmed in the clone only, and the sample untouched", { timeout: 3_600_000 }, async (t) => {
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
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(scratchBase(), "v2-101-sample-")));
  const project = path.join(scratch, "projeto-teste-jgates");
  const home = path.join(scratch, "home");
  git(scratch, ["clone", "--quiet", "--no-hardlinks", source, project]);
  git(project, ["checkout", "--quiet", "master"]);
  fs.mkdirSync(home);
  workspace = workspaceId(project);

  const baseEnv = { ...process.env, JGATES_HOME: home, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  // The real engine (the node test runs name a missing engine client by default, tests/setup/in-image.mjs).
  if (baseEnv.JGATES_CONTAINER_RUNTIME === "jgates-test-no-engine") delete baseEnv.JGATES_CONTAINER_RUNTIME;
  const cli = (args, { locale = "en", timeout = 3_000_000 } = {}) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env: { ...baseEnv, JGATES_LOCALE: locale }, input: "", timeout, maxBuffer: 256 * 1024 * 1024 });
  const json = (r, what) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      assert.fail(`${what}: no JSON (exit ${r.status}):\n${r.stdout.slice(0, 2000)}\n${r.stderr.slice(0, 2000)}`);
    }
  };
  const runJson = () => {
    const r = cli(["run", "--cwd", project, "--no-interactive", "--json"]);
    return { status: r.status, doc: json(r, "jgates run") };
  };
  const mapJson = (level) => {
    const r = cli(["coverage", "asvs", "--cwd", project, "--level", String(level), "--json"], { timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return json(r, "jgates coverage asvs");
  };
  const reportText = (runId, locale) => {
    const r = cli(["report", runId, "--cwd", project, "--format", "text"], { locale, timeout: 120_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };

  // 1. Balanced: the recounted findings of master.
  const init = cli(["init", "--cwd", project, "--profile", "standard", "--no-interactive", "--json"], { timeout: 300_000 });
  assert.equal(init.status, 0, init.stderr + init.stdout);
  const first = runJson();
  const firstSummary = summary(first.doc);
  assert.equal(first.status, 1, firstSummary);
  assert.equal(first.doc.decision, "failed", firstSummary);
  assert.deepEqual(first.doc.findings.map(keyOf).sort(), BALANCED, `the recounted findings of master under Balanced: ${firstSummary}`);
  assert.equal(first.doc.findings.filter((f) => f.informational === true).length, 0, "the sample has no informational finding of its own");
  assert.equal(first.doc.findings.filter((f) => f.review === true).length, 0, "the sample has no finding to review of its own");
  const blockingFirst = first.doc.findings.filter((f) => f.blocking === true && f.waived !== true);
  assert.equal(blockingFirst.length, BLOCKING_FINDINGS, firstSummary);
  const firstEn = reportText(first.doc.runId, "en");
  assert.match(firstEn, new RegExp(`Decision: failed \\(failed: ${BLOCKING_VIOLATIONS} blocking violations\\)`), firstEn);
  const semgrepFirst = first.doc.stages.find((s) => s.id === "semgrep#sast");
  assert.equal(semgrepFirst?.state, "completed", firstSummary);
  const scanned = Object.entries(semgrepFirst.scannedLanguages ?? {}).filter(([, n]) => n > 0).map(([language]) => language);
  assert.deepEqual(scanned, ["python"], "the Semgrep stage scanned Python files only");

  // 2. Informational findings and a finding to review, from files written to the clone only: the verdict does not change.
  fs.writeFileSync(path.join(project, ...NEW_FILE.split("/")), NEW_SOURCE);
  fs.writeFileSync(path.join(project, ...REVIEW_FILE.split("/")), REVIEW_SOURCE);
  const beforeSecond = treeEntries(project);
  const second = runJson();
  const secondSummary = summary(second.doc);
  assert.equal(second.status, 1, secondSummary);
  assert.equal(second.doc.decision, first.doc.decision, `the verdict is the same: ${secondSummary}`);
  const informational = second.doc.findings.filter((f) => f.informational === true);
  assert.deepEqual(informational.map((f) => f.ruleId).sort(), INFORMATIONAL, secondSummary);
  for (const f of informational) {
    assert.equal(f.tool, "semgrep");
    assert.equal(fileOf(f), NEW_FILE);
    assert.equal(f.blocking, false, `${f.ruleId} does not block`);
    assert.ok(f.asvsRequirements.length > 0 && f.asvsRequirements.every((id) => /^V\d{1,2}\.\d+\.\d+$/.test(id)), `${f.ruleId} carries its requirement ids`);
    assert.notEqual(f.waived, true);
  }
  // Exactly one finding to review, the Review rule's, from the archive file alone; it never blocks and is not informational.
  const review = second.doc.findings.filter((f) => f.review === true);
  assert.deepEqual(review.map(keyOf), [`semgrep ${REVIEW} ${REVIEW_FILE}`], `exactly one finding to review: ${secondSummary}`);
  assert.deepEqual(second.doc.findings.filter((f) => fileOf(f) === REVIEW_FILE).map(keyOf), [`semgrep ${REVIEW} ${REVIEW_FILE}`], `the archive file adds that finding and nothing else: ${secondSummary}`);
  const [toReview] = review;
  assert.equal(toReview.blocking, false, `${REVIEW} does not block`);
  assert.notEqual(toReview.informational, true, `${REVIEW} is to review, not informational`);
  assert.notEqual(toReview.waived, true);
  assert.ok(toReview.asvsRequirements.includes(REVIEW_REQUIREMENT) && toReview.asvsRequirements.every((id) => /^V\d{1,2}\.\d+\.\d+$/.test(id)), `${REVIEW} carries its requirement ids`);
  assert.deepEqual(second.doc.findings.filter((f) => f.informational !== true && f.review !== true).map(keyOf).sort(), BALANCED, "every other finding is as before");
  assert.equal(second.doc.findings.filter((f) => f.blocking === true && f.waived !== true).length, BLOCKING_FINDINGS, "the blocking findings are the same");
  const en = reportText(second.doc.runId, "en");
  assert.match(en, new RegExp(`Decision: failed \\(failed: ${BLOCKING_VIOLATIONS} blocking violations and 2 informational and 1 to review`), en);
  assert.match(en, /Informational findings/, en);
  assert.match(en, /To review \(1; they do not block the validation/, en);
  assert.ok(en.includes(REVIEW), `the text lists the finding to review:\n${en}`);
  assert.doesNotMatch(en, /approved/i, "a failed run is never worded as an approval");
  const pt = reportText(second.doc.runId, "pt-BR");
  assert.match(pt, /informativ/i, pt);
  assert.match(pt, new RegExp(`${BLOCKING_VIOLATIONS} [^\\n]*e 1 para revisar`), pt);
  assert.match(pt, /Para revisar \(1; não bloqueiam a validação/, pt);
  assert.deepEqual(changedPaths(beforeSecond, treeEntries(project)), [], "the validation changed nothing in the clone");

  // 3. The level-2 map of that run.
  const map = mapJson(2);
  assert.equal(map.level, 2);
  assert.equal(map.requirements.length, 253, "level 2 has 253 requirements");
  assert.equal(map.runs.quality?.runId, second.doc.runId, "the map reads the run just made");
  assert.equal(map.totals.notApplicable, 0);
  const checks = map.requirements.flatMap((r) => r.checks.map((c) => ({ row: r, check: c })));
  const ruleChecks = checks.filter(({ check }) => check.unit === "semgrep-rule");
  assert.ok(ruleChecks.length > 0);
  for (const { row, check } of ruleChecks) {
    assert.ok(check.language, `${check.id} names its language`);
    if (scanned.includes(check.language)) {
      assert.equal(check.relevant, true, `${row.id}: ${check.id} is a check of a language the project has`);
      assert.equal(check.status, "ran", `${row.id}: ${check.id} ran`);
    } else {
      assert.equal(check.relevant, false, `${row.id}: ${check.id} is a check of ${check.language}, which the project lacks`);
      assert.equal(check.code, "LANGUAGE_ABSENT", `${row.id}: ${check.id}`);
    }
  }
  assert.ok(ruleChecks.some(({ check }) => check.language === "python" && check.relevant), "a rule of the project's language shows in the map");
  assert.ok(ruleChecks.some(({ check }) => check.language !== "python" && !check.relevant), "the checks of other languages exist in the answer, flagged");
  // The two numbers of a check: open blocking and open informational findings, never added together.
  const injection = checks.find(({ check }) => check.id === "jgates.python.os-command-injection" && check.openBlocking > 0);
  assert.ok(injection, "the command injection is an open blocking finding of a requirement it bears on");
  assert.equal(injection.check.openInformational, 0);
  assert.equal(injection.check.openReview, 0);
  assert.equal(injection.check.openFindings, injection.check.openBlocking + injection.check.openInformational + injection.check.openReview);
  for (const id of INFORMATIONAL) {
    const named = checks.filter(({ check }) => check.id === id);
    assert.ok(named.length > 0, `${id} is a check of the map`);
    assert.ok(named.some(({ check }) => check.openInformational > 0 && check.openBlocking === 0 && check.openReview === 0), `${id} shows as an open informational finding`);
  }
  // The Review rule: a Review check wherever it is listed, one open finding to review, never counted in the two other
  // numbers; on V5.2.3, its only Python check, the requirement is not examined.
  const reviewChecks = checks.filter(({ check }) => check.id === REVIEW);
  assert.ok(reviewChecks.length > 0, `${REVIEW} is a check of the map`);
  for (const { row, check } of reviewChecks) {
    assert.equal(check.class, "review", `${row.id}: ${REVIEW} is a Review check`);
    assert.equal(check.status, "ran", `${row.id}: ${REVIEW} ran`);
    assert.deepEqual([check.openBlocking, check.openInformational, check.openReview, check.openFindings], [0, 0, 1, 1], `${row.id}: one open finding to review`);
    assert.ok(!row.reason.includes(REVIEW), `${row.id}: ${REVIEW} is not named among the checks that examined it: ${row.reason}`);
  }
  const reviewRow = map.requirements.find((r) => r.id === REVIEW_REQUIREMENT);
  assert.ok(reviewRow?.checks.some((c) => c.id === REVIEW), `${REVIEW_REQUIREMENT} lists ${REVIEW}`);
  assert.notEqual(reviewRow.state, "examined", `${REVIEW_REQUIREMENT} is not examined by a Review check: ${reviewRow.code} ${reviewRow.reason}`);
  assert.ok(reviewRow.checks.filter((c) => c.relevant && c.ran).every((c) => c.class === "review"), `${REVIEW_REQUIREMENT}: only Review checks ran`);
  if (reviewRow.checks.filter((c) => c.relevant).every((c) => c.class === "review")) assert.equal(reviewRow.code, "UNSUPPORTED_REVIEW_ONLY", reviewRow.reason);
  // No requirement is examined by a Review check alone.
  for (const row of map.requirements.filter((r) => r.state === "examined")) {
    assert.ok(row.checks.some((c) => c.ran && c.class !== "review"), `${row.id} is examined by a check that is not Review`);
  }
  // The text leaves the checks of absent languages out.
  const text = cli(["coverage", "asvs", "--cwd", project, "--level", "2"], { timeout: 120_000 });
  assert.equal(text.status, 0, text.stderr);
  const absent = ruleChecks.filter(({ check }) => !check.relevant).map(({ check }) => check.id);
  assert.ok(absent.length > 0);
  for (const id of new Set(absent)) assert.ok(!text.stdout.includes(id), `the text names no check of an absent language: ${id}`);
  assert.doesNotMatch(text.stdout, /\bjgates\.(go|java|csharp|rust|php|js|html|config)\./);
  // The text labels the Review check and gives its three numbers apart.
  assert.match(text.stdout, new RegExp(`- ${REVIEW.replace(/\./g, "\\.")}( \\([^)]*\\))? \\[To review\\]:`), text.stdout);
  assert.match(text.stdout, /Open findings: 0 blocking, 0 informational, 1 to review/, text.stdout);
  assert.doesNotMatch(text.stdout, FORBIDDEN);
  assert.doesNotMatch([map.statement, ...map.requirements.map((r) => r.reason)].join("\n"), FORBIDDEN);
  // Suggestions.
  const suggested = map.requirements.filter((r) => r.suggestion);
  assert.ok(suggested.length >= 1, "the map carries at least one suggestion of not applicable");
  assert.match(text.stdout, /suggestions? of "not applicable"/);
  for (const r of suggested) {
    assert.ok(["unsupported", "unexamined", "awaiting-evidence"].includes(r.state), `${r.id}: a suggestion sits on a row with no examination (${r.state})`);
    assert.equal(r.decision, null);
  }
  const pick = suggested.find((r) => r.suggestion.kind === "technology") ?? suggested[0];

  // 4. Confirming a suggestion: the preview writes nothing, the confirmation writes the clone's .jgates/asvs.json alone.
  const beforeConfirm = treeEntries(project);
  const preview = json(cli(["coverage", "asvs", "not-applicable", pick.id, "--from-suggestion", "--preview", "--cwd", project, "--json"], { timeout: 120_000 }), "preview");
  assert.equal(preview.preview, true);
  assert.equal(preview.written, false);
  assert.deepEqual(changedPaths(beforeConfirm, treeEntries(project)), [], "the preview writes nothing");
  const confirmed = cli(["coverage", "asvs", "not-applicable", pick.id, "--from-suggestion", "--yes", "--cwd", project, "--json"], { timeout: 120_000 });
  assert.equal(confirmed.status, 0, confirmed.stdout + confirmed.stderr);
  const written = JSON.parse(confirmed.stdout);
  assert.equal(written.written, true);
  assert.ok(written.undo?.token, "the answer carries an undo token");
  const expectedChange = beforeConfirm.has(".jgates/asvs.json") ? [".jgates/asvs.json"] : [".jgates/asvs.json"].concat(beforeConfirm.has(".jgates") ? [] : [".jgates"]).sort();
  assert.deepEqual(changedPaths(beforeConfirm, treeEntries(project)), expectedChange, "the confirmation writes only .jgates/asvs.json of the clone");
  const doc = JSON.parse(fs.readFileSync(path.join(project, ".jgates", "asvs.json"), "utf8"));
  const entries = doc.notApplicable ?? doc.decisions ?? [];
  assert.ok(JSON.stringify(entries).includes(pick.id), `the file records ${pick.id}: ${JSON.stringify(doc)}`);
  assert.ok(JSON.stringify(entries).includes(pick.suggestion.reason), "the entry carries the suggestion's own reason");
  const after = mapJson(2);
  const row = after.requirements.find((r) => r.id === pick.id);
  assert.equal(row.state, "not-applicable", `${pick.id} shows as not applicable`);
  assert.equal(row.decision?.reason, pick.suggestion.reason);
  assert.ok(after.totals.notApplicable >= 1);
  assert.equal(after.totals.notApplicable + after.totals.examined + after.totals.unexamined + after.totals.unsupported + after.totals.awaitingEvidence, after.totals.rows, "every requirement is in exactly one state");
  // The undo token takes the decision out.
  const undone = cli(["coverage", "asvs", "undo", written.undo.token, "--cwd", project, "--json"], { timeout: 120_000 });
  assert.equal(undone.status, 0, undone.stdout + undone.stderr);
  assert.equal(mapJson(2).totals.notApplicable, 0, "the undo takes the decision out");

  // 5. The sample was only read; no container of the workspace and no new JGates temporary file is left.
  assert.equal(treeHash(source), sourceBefore, "the sample project is byte-identical (tree hash) before and after");
  assert.deepEqual(lines(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${workspace}`]).out), [], "no container of the clone's workspace is left");
  const leftover = [...jgatesTemp()].filter((name) => !tempBefore.has(name));
  assert.deepEqual(leftover, [], `no JGates temporary file is left in ${os.tmpdir()}`);
});
