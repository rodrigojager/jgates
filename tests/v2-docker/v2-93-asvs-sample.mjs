import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-93 (real engine): the ASVS coverage map of the sample project. The sample (JGATES_SAMPLE_PROJECT, by default the
// maintainer's `D:/projeto-teste-jgates`) is never used in place: the test clones it (`git clone --no-hardlinks`) into
// JGATES_E2E_TMP, by default the `_work/00-tmp` folder of the container that holds this repository when there is one,
// else the system temporary folder. The clone is validated under Balanced (profile `standard`) with the real engine and
// the local development image jgates-tools:dev; then `jgates coverage asvs --level 1 --json` builds the map from that
// run. The examined requirements of the level-1 map are exactly those whose mapped, reviewed deterministic checks
// completed in that run (a capability stage in state `completed`, a Semgrep rule whose stage completed and scanned a
// file of the rule's language), each naming a check that ran; no Semantic run exists, so no requirement is examined by
// an AI review. The map never says "compliant", "conformant" or "certified" and shows no percentage of compliance. The
// sample and the clone's tracked files are byte-identical afterwards, and every engine object the test leaves for its
// workspace is removed by label.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const MAP_DIR = path.join(root, "jgates", "packs", "asvs", "jgates-asvs-map", "5.0.0");
const IMAGE = "jgates-tools:dev";
const DEFAULT_SAMPLE = "D:/projeto-teste-jgates";
const FORBIDDEN = /\b(compliant|compliance|conformant|conformance|certified|certification)\b|\d\s?%/i;

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
      } else if (entry.isSymbolicLink()) hash.update(`l:${next}:${fs.readlinkSync(full)}\0`);
      else hash.update(`f:${next}:${stat.size}:${stat.mtimeMs}\0`).update(fs.readFileSync(full));
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

let scratch = "";
let workspace = "";
test.after(() => {
  if (workspace) {
    const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${workspace}`];
    for (const id of lines(docker(["ps", "-aq", ...filters]).out)) docker(["rm", "-f", id]);
    for (const id of lines(docker(["network", "ls", "-q", ...filters]).out)) docker(["network", "rm", id]);
    for (const name of lines(docker(["volume", "ls", "-q", ...filters]).out)) docker(["volume", "rm", "-f", name]);
  }
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

test("V2-93 (real engine): on a clone of the sample validated under Balanced, the examined requirements of the level-1 ASVS map are exactly those whose mapped checks completed in that run, each naming its check, and the sample is untouched", { timeout: 3_600_000 }, async () => {
  assert.equal(docker(["version", "--format", "{{.Server.Version}}"]).code, 0, "Docker is required for the real-engine acceptance cases (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
  const source = path.resolve(process.env.JGATES_SAMPLE_PROJECT || DEFAULT_SAMPLE);
  assert.ok(fs.existsSync(path.join(source, ".git")), `the sample project ${source} is not a Git repository (set JGATES_SAMPLE_PROJECT to a clone of it)`);
  const { workspaceId } = await import(pathToFileURL(path.join(dist, "core", "ids", "index.js")).href);

  // The clone, in a fresh scratch folder; the sample is only read.
  const sourceBefore = treeHash(source);
  fs.mkdirSync(scratchBase(), { recursive: true });
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(scratchBase(), "v2-93-asvs-")));
  const project = path.join(scratch, "projeto-teste-jgates");
  const home = path.join(scratch, "home");
  git(scratch, ["clone", "--quiet", "--no-hardlinks", source, project]);
  git(project, ["checkout", "--quiet", "master"]);
  fs.mkdirSync(home);
  workspace = workspaceId(project);

  const env = { ...process.env, JGATES_HOME: home, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  // The real engine (the node test runs name a missing engine client by default, tests/setup/in-image.mjs).
  if (env.JGATES_CONTAINER_RUNTIME === "jgates-test-no-engine") delete env.JGATES_CONTAINER_RUNTIME;
  const cli = (args, timeout = 3_000_000) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout, maxBuffer: 256 * 1024 * 1024 });

  // 1. Balanced: the standard profile, then one validation of the clone.
  const init = cli(["init", "--cwd", project, "--profile", "standard", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  const run = cli(["run", "--cwd", project, "--no-interactive", "--json"]);
  assert.ok([0, 1, 2].includes(run.status), `the run ended with ${run.status}: ${run.stderr}`);
  const result = JSON.parse(run.stdout);
  assert.ok(Array.isArray(result.stages) && result.stages.length > 0, "the run has stages");
  const completed = new Map(result.stages.filter((s) => s.state === "completed").map((s) => [s.id, s]));
  const tracked = treeHash(project);

  // 2. The map at level 1, from the run just made, with no Semantic run.
  const asked = cli(["coverage", "asvs", "--cwd", project, "--level", "1", "--json"], 120_000);
  assert.equal(asked.status, 0, asked.stderr + asked.stdout);
  const map = JSON.parse(asked.stdout);
  assert.equal(map.level, 1);
  assert.equal(map.requirements.length, 70, "level 1 has 70 requirements");
  assert.equal(map.runs.semantic.length, 0, "no Semantic run exists in the clone");
  assert.ok(map.runs.quality, "the map reads the run just made");
  assert.equal(map.totals.examinedAiOnly, 0, "nothing is examined by an AI review without a Semantic run");
  assert.equal(map.source.licence, "CC-BY-SA-4.0");
  assert.ok(map.statement.length > 0);

  // 3. Independent expectation: the reviewed mapping entries whose deterministic checks completed in this run.
  const mapped = new Map();
  for (const file of fs.readdirSync(MAP_DIR).filter((f) => /^V\d+\.json$/.test(f))) {
    for (const entry of JSON.parse(fs.readFileSync(path.join(MAP_DIR, file), "utf8")).entries) mapped.set(entry.requirement, entry);
  }
  const ranInThisRun = (row, check) => {
    if (check.unit === "capability") return completed.has(check.id);
    if (check.unit === "semgrep-rule") {
      const stage = completed.get("semgrep#sast");
      return Boolean(stage) && (stage.scannedLanguages?.[row.language ?? ""] ?? 0) > 0;
    }
    return false; // Semantic units need a Semantic run
  };
  const examined = map.requirements.filter((r) => r.state === "examined");
  const expectedIds = [];
  for (const row of map.requirements) {
    const entry = mapped.get(row.id);
    if (!entry || entry.status !== "reviewed" || row.decision) continue;
    const checks = row.checks.filter((c) => c.unit === "capability" || c.unit === "semgrep-rule");
    if (checks.some((c) => ranInThisRun(c, c))) expectedIds.push(row.id);
  }
  assert.deepEqual(examined.map((r) => r.id).sort(), expectedIds.sort(), "the examined requirements are exactly those whose mapped checks completed in this run");
  for (const row of examined) {
    const ran = row.checks.filter((c) => c.ran);
    assert.ok(ran.length > 0, `${row.id} is examined and names the check that ran`);
    assert.equal(row.basis, "deterministic", `${row.id} is examined by a deterministic check`);
    for (const c of ran) {
      assert.ok(c.id && c.covers && c.misses, `${row.id}: the check ${c.id} says what it covers and misses`);
      if (c.unit === "capability") assert.ok(completed.has(c.id), `${row.id}: ${c.id} completed in the run`);
    }
  }
  // Nothing outside the examined set claims a check that ran.
  for (const row of map.requirements.filter((r) => r.state !== "examined")) {
    assert.ok(!row.checks.some((c) => c.ran) || row.state === "not applicable", `${row.id} is ${row.state} and has no check that ran`);
  }
  const counted = map.totals.examined + map.totals.unexamined + map.totals.unsupported + map.totals.notApplicable + map.totals.awaitingEvidence;
  assert.equal(counted, 70, "every requirement is in exactly one state");

  // 4. The text output prints the attribution once and never claims compliance.
  const text = cli(["coverage", "asvs", "--cwd", project, "--level", "1"], 120_000);
  assert.equal(text.status, 0, text.stderr);
  assert.equal((text.stdout.match(/OWASP ASVS 5\.0\.0, © The OWASP Foundation/g) ?? []).length, 1);
  assert.doesNotMatch(text.stdout, FORBIDDEN);
  const jsonWords = [map.statement, ...map.requirements.map((r) => r.reason)].join("\n");
  assert.doesNotMatch(jsonWords, FORBIDDEN);

  // 5. Reading the map changed nothing: not the clone, not the sample, and no container is left.
  assert.equal(treeHash(project), tracked, "the clone is byte for byte the same after the map");
  assert.equal(treeHash(source), sourceBefore, "the sample project was only read");
  assert.deepEqual(lines(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${workspace}`]).out), []);
});
