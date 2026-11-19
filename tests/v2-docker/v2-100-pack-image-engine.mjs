import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-100 (real engine): the whole bundled Semgrep pack on the Semgrep of the tools image, which is not the version the
// rules were written with. Two cases.
//  1. `semgrep --test` over the pack's rules/ folder, mounted from the repository: no rule fails, no rule is without a test
//     (every kind of rule of the pack, signals, HTML and configuration included, is testable on this engine, so no kind is
//     excepted), no rule file has an error, and the rules that were tested are exactly the rules of the pack index.
//  2. The twins through `jgates run` (the pack staged by the product, in a real container): for every language and every
//     group of fixtures/semgrep-pack/expected the vulnerable twin gives exactly the expected rule ids (or exactly the expected
//     signal tags) in exactly its files, the clean twin gives nothing (no finding, no signal tag), the stage's signals record
//     names the tags the files use, the project folders are byte-identical afterwards and no container is left behind.
// Every object the case creates in the engine carries its workspace id; the cleanup selects by those labels only.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const PACK_RULES = path.join(root, "jgates", "packs", "semgrep", "jgates-semgrep", "rules");
const FIXTURES = path.join(root, "jgates", "tests", "fixtures", "semgrep-pack");
const IMAGE = "jgates-tools:dev";
const SIGNAL_ID = /^jgates\.[a-z0-9]+\.uses-([a-z0-9-]+)$/;
const RULE_ID = /(jgates\.[a-z0-9]+\.[a-z0-9-]+)$/;

const docker = (args, options = {}) => {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: "1" }, ...options });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const workspaces = [];
// Registered per test with t.after, so it runs after the case even when the case runs alone with --test-name-pattern.
const cleanupCase = () => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const workspace of workspaces) {
    const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${workspace}`];
    for (const id of docker(["ps", "-aq", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["rm", "-f", id]);
    for (const name of docker(["volume", "ls", "-q", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["volume", "rm", "-f", name]);
  }
};
const containerIds = () => new Set(docker(["ps", "-aq", "--no-trunc"]).out.split(/\s+/).filter(Boolean));

/** Hash of the whole tree: relative paths, kinds, sizes, mtimes and contents, in a stable order. */
function treeHash(dir) {
  const hash = crypto.createHash("sha256");
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(full);
      if (entry.isDirectory()) {
        hash.update(`d:${next}\0`);
        walk(full, next);
      } else hash.update(`f:${next}:${stat.size}:${stat.mtimeMs}\0`).update(fs.readFileSync(full));
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

const sorted = (values) => [...new Set(values)].sort();
const slash = (p) => p.split(path.sep).join("/");

function requireEngine() {
  assert.equal(docker(["version", "--format", "{{.Server.Version}}"]).code, 0, "Docker is required for the real-engine acceptance cases (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
}

test("V2-100 (real engine): semgrep --test over the whole pack on the image's Semgrep has no failed rule and no rule without a test", async (t) => {
  t.after(cleanupCase);
  requireEngine();
  const before = containerIds();
  const imageTools = JSON.parse(fs.readFileSync(path.join(root, "jgates", "release", "image-tools.json"), "utf8"));
  const version = docker(["run", "--rm", "--label", "jproject.project=jgates", "--entrypoint", "semgrep", IMAGE, "--version"]);
  assert.equal(version.code, 0, version.err);
  assert.equal(version.out.trim(), imageTools.tools.semgrep, "the engine is the Semgrep the image records");

  const run = docker(
    ["run", "--rm", "--label", "jproject.project=jgates", "-v", `${PACK_RULES}:/rules:ro`, "--entrypoint", "semgrep", IMAGE, "--test", "--json", "--jobs=2", "--metrics=off", "--disable-version-check", "/rules"],
    { timeout: 1_200_000 },
  );
  assert.equal(run.code, 0, `${run.out.slice(0, 600)}\n${run.err.slice(-1500)}`);
  const doc = JSON.parse(run.out);
  assert.deepEqual(doc.config_with_errors, [], "no rule file has an error on this engine");
  assert.deepEqual(doc.config_missing_tests, [], "no rule file is without a test");
  assert.deepEqual(doc.config_missing_fixtests ?? [], [], "no rule is without an autofix test");

  const tested = new Map();
  for (const [file, result] of Object.entries(doc.results)) for (const [id, check] of Object.entries(result.checks)) tested.set(id, { file, passed: check.passed });
  const failed = [...tested].filter(([, v]) => !v.passed).map(([id, v]) => `${id} (${v.file})`);
  assert.deepEqual(failed, [], "no rule fails its test");

  // Every rule of the pack index was tested (a rule without a test would be named here); nothing else was.
  const semgrepAdapter = await import(pathToFileURL(path.join(dist, "adapters", "semgrep", "index.js")).href);
  const index = semgrepAdapter.buildPackIndex(PACK_RULES);
  assert.deepEqual(index.problems, []);
  const packIds = index.rules.map((r) => r.id);
  assert.ok(packIds.length >= 430, `the pack holds ${packIds.length} rules`);
  assert.deepEqual(packIds.filter((id) => !tested.has(id)).sort(), [], "rules the engine did not test (the kinds it cannot test)");
  assert.deepEqual([...tested.keys()].filter((id) => !packIds.includes(id)).sort(), [], "rules tested that are not in the pack index");
  assert.equal(tested.size, packIds.length, "one test result per rule");

  assert.deepEqual([...containerIds()].filter((id) => !before.has(id)), [], "no container is left behind");
});

test("V2-100 (real engine): every language and group twin gives exactly its rule ids or signal tags on the image's Semgrep, the clean twins nothing, the projects untouched", async (t) => {
  t.after(cleanupCase);
  requireEngine();
  const before = containerIds();
  const { workspaceId } = await import(pathToFileURL(path.join(dist, "core", "ids", "index.js")).href);

  // The data: expected/<language>.json (a language's own files) and every expected/<language>/<group>.json.
  const expectedDir = path.join(FIXTURES, "expected");
  const entries = fs.readdirSync(expectedDir, { withFileTypes: true });
  const perLanguage = entries.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name.replace(/\.json$/, "")).sort();
  const groupDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const languages = [...new Set([...perLanguage, ...groupDirs])].sort();
  for (const language of ["javascript", "typescript", "python", "go", "csharp", "rust", "java", "php", "html", "config"]) assert.ok(languages.includes(language), `${language} is twinned`);
  const groupsOf = (language) => {
    const dir = path.join(expectedDir, language);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort().map((n) => ({ name: `${language}/${n.replace(/\.json$/, "")}`, ...JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) }));
  };
  // A set to check: a name, the files (relative to the project) it owns, and its rule ids or its signal tags.
  const sets = [];
  for (const language of languages) {
    const grouped = new Set();
    for (const group of groupsOf(language)) {
      for (const file of group.files) grouped.add(file);
      sets.push({ name: group.name, language, files: group.files.filter((f) => !/(^|\/)Cargo\.toml$/.test(f)).map((f) => `${language}/${f}`), ruleIds: group.ruleIds, signals: group.signals });
    }
    if (perLanguage.includes(language)) {
      const own = JSON.parse(fs.readFileSync(path.join(expectedDir, `${language}.json`), "utf8"));
      sets.push({ name: language, language, files: own.files.filter((f) => !grouped.has(f)).map((f) => `${language}/${f}`), ruleIds: own.ruleIds, signals: own.signals });
    }
  }
  // Eight languages with their eleven groups and their own files, the HTML markup group and the two configuration groups.
  assert.equal(sets.length, 8 * 11 + 8 + 1 + 2, `${sets.length} sets of twins to check`);

  const home = tmp("v2-100-home-");
  const env = { ...process.env, JGATES_HOME: home, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  // The real engine (the node test runs name a missing engine client by default, tests/setup/in-image.mjs).
  if (env.JGATES_CONTAINER_RUNTIME === "jgates-test-no-engine") delete env.JGATES_CONTAINER_RUNTIME;

  /** Runs the Semgrep stage on a project made of the twins of every language; returns the stage and the raw results by file. */
  const runProject = (variant) => {
    const project = tmp(`v2-100-${variant}-`);
    workspaces.push(workspaceId(project));
    for (const language of languages) fs.cpSync(path.join(FIXTURES, variant, language), path.join(project, language), { recursive: true });
    const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 1_500_000, maxBuffer: 256 * 1024 * 1024 });
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
    const init = cli(["init", "--cwd", project, "--profile", "standard", "--no-interactive", "--json"]);
    assert.equal(init.status, 0, init.stderr + init.stdout);
    spawnSync("git", ["add", "-A"], { cwd: project });
    const hashBefore = treeHash(project);
    const run = cli(["run", "--cwd", project, "--no-interactive", "--json", "--only", "tool:semgrep"]);
    const doc = JSON.parse(run.stdout);
    const stage = doc.stages.find((s) => s.id === "semgrep#sast");
    assert.ok(stage, JSON.stringify(doc.stages.map((s) => [s.id, s.state, s.reason])));
    assert.equal(stage.state, "completed", `${variant}: ${stage.state} ${stage.reason ?? ""}`);
    assert.equal(treeHash(project), hashBefore, `${variant}: the project is byte-identical after the run`);
    assert.deepEqual(doc.workspaceChanges?.added ?? [], [], `${variant}: the run reports no change in the project`);
    const rawFile = path.join(doc.runDir, "outputs", "semgrep", "semgrep", "semgrep.json");
    assert.ok(fs.existsSync(rawFile), `${variant}: the engine's output is kept at ${rawFile}`);
    const raw = JSON.parse(fs.readFileSync(rawFile, "utf8"));
    assert.deepEqual((raw.errors ?? []).filter((e) => /rule/i.test(String(e.type ?? "")) || /invalid|unknown/i.test(String(e.long_msg ?? e.message ?? ""))), [], `${variant}: the engine accepts every rule`);
    const byFile = new Map();
    for (const r of raw.results ?? []) {
      const full = slash(String(r.path));
      // The engine reports the path inside its container: keep the part from the language folder on.
      const at = full.split("/").findIndex((seg, i, all) => languages.includes(seg) && fs.existsSync(path.join(project, ...all.slice(i))));
      assert.ok(at >= 0, `${variant}: ${full} is a file of the project`);
      const rel = full.split("/").slice(at).join("/");
      const id = RULE_ID.exec(String(r.check_id))?.[1] ?? String(r.check_id);
      if (!byFile.has(rel)) byFile.set(rel, []);
      byFile.get(rel).push(id);
    }
    return { doc, stage, project, byFile };
  };
  const within = (byFile, files) => files.flatMap((f) => byFile.get(f) ?? []);

  // 1. The vulnerable twins: exactly the expected ids (or tags), in exactly the files of each group.
  const bad = runProject("vulnerable");
  const problems = [];
  const expectedTags = [];
  for (const set of sets) {
    const ids = within(bad.byFile, set.files);
    const real = sorted(ids.filter((id) => !SIGNAL_ID.test(id)));
    const tags = sorted(ids.map((id) => SIGNAL_ID.exec(id)?.[1]).filter(Boolean));
    if (set.signals !== undefined) {
      expectedTags.push(...set.signals);
      if (JSON.stringify(tags) !== JSON.stringify(sorted(set.signals))) problems.push(`${set.name}: signal tags differ: missing [${sorted(set.signals).filter((x) => !tags.includes(x))}], unexpected [${tags.filter((x) => !set.signals.includes(x))}]`);
      if (real.length) problems.push(`${set.name}: a signals group has no finding, found ${real}`);
    } else {
      const want = sorted(set.ruleIds);
      if (JSON.stringify(real) !== JSON.stringify(want)) problems.push(`${set.name}: rule ids differ: missing [${want.filter((x) => !real.includes(x))}], unexpected [${real.filter((x) => !want.includes(x))}]`);
      const flagged = sorted(set.files.filter((f) => (bad.byFile.get(f) ?? []).some((id) => !SIGNAL_ID.test(id))));
      if (JSON.stringify(flagged) !== JSON.stringify(sorted(set.files))) problems.push(`${set.name}: no finding in [${set.files.filter((f) => !flagged.includes(f))}]`);
    }
  }
  // No file outside the sets has a finding either (a stray file of a twin would hide a rule that fires where it should not).
  const owned = new Set(sets.flatMap((s) => s.files));
  for (const [file, ids] of bad.byFile) {
    const real = ids.filter((id) => !SIGNAL_ID.test(id));
    if (!owned.has(file) && real.length) problems.push(`${file}: findings ${sorted(real)} in a file no expected file lists`);
  }
  assert.deepEqual(problems, []);
  assert.equal(bad.doc.decision, "failed");
  // The stage's signals record names the tags the twins use: the tags with results are exactly the expected tags.
  const recorded = Object.entries(bad.stage.signals ?? {}).filter(([, n]) => n > 0).map(([tag]) => tag).sort();
  assert.deepEqual(recorded, sorted(expectedTags), "the signals record of the vulnerable project names the tags of the signal twins");
  for (const language of languages) assert.ok((bad.stage.scannedLanguages?.[language] ?? 0) > 0, `${language}: the stage records the files scanned (${JSON.stringify(bad.stage.scannedLanguages)})`);

  // 2. The clean twins: nothing, signals included.
  const clean = runProject("clean");
  // A check gives nothing on any clean file; a signal rule gives nothing on the clean files of a signals group (a clean file of
  // another group may use a technology, so its signal results are a record, not a failure).
  const signalFiles = new Set(sets.filter((s) => s.signals !== undefined).flatMap((s) => s.files));
  const cleanProblems = [];
  for (const [file, ids] of clean.byFile) {
    const unexpected = ids.filter((id) => !SIGNAL_ID.test(id) || signalFiles.has(file));
    if (unexpected.length) cleanProblems.push(`${file}: ${sorted(unexpected)}`);
  }
  assert.deepEqual(cleanProblems, [], "the clean twins give no finding, and no signal in the files of a signals group");
  assert.deepEqual(clean.doc.findings.filter((f) => f.tool === "semgrep").map((f) => f.ruleId), []);

  // No container of either workspace is left behind.
  for (const workspace of workspaces) assert.equal(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${workspace}`]).out.trim(), "", "no container is left");
  assert.deepEqual([...containerIds()].filter((id) => !before.has(id)), [], "no container at all is left behind");
});
