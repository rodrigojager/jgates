import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Core behavior around images, caches, templates and the matrix:
// - container images come only from .jgates/lock.json, pinned by `tools prepare` (no JGATES_*_IMAGE);
// - the sidecar image (quality-gate/Dockerfile) declares one version label per scanner and is accepted as is;
// - Trivy's vulnerability database is cached in the data folder between runs, with its dates recorded;
// - ESLint, pytest and Vitest enter the plan by the evidence of their configuration (match.files);
// - the matrix accepts a test as proof only when its title says it exercises the capability ([proves: ...]).
// The container runtime is always a fake (a Node script); npm run test:docker covers the real one.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FAKE_DOCKER = path.join(here, "docker", "fake-docker.cjs");
const SECURITY_FIXTURES = path.join(here, "fixtures", "parsers", "security");
const FAKE_SECURITY_RUNTIME = path.join(SECURITY_FIXTURES, "fake-runtime.cjs");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const mainFixture = require(path.join(repo, "tests", "fixtures", "jgates", "main-fixture.js"));
const mx = await import(pathToFileURL(path.join(dist, "core", "matrix", "index.js")).href);
const { parseTrivyReport } = await import(pathToFileURL(path.join(dist, "adapters", "trivy", "index.js")).href);
const { builtinManifests } = await import(pathToFileURL(path.join(dist, "adapters", "manifests.js")).href);
const prepare = await import(pathToFileURL(path.join(dist, "core", "prepare", "index.js")).href);

const validateResult = new Ajv2020({ strict: true, allErrors: true }).compile(JSON.parse(fs.readFileSync(path.join(here, "..", "schemas", "result", "result.schema.json"), "utf8")));

const POSIX = process.platform !== "win32";
const NO_POSIX = "the fake container runtime is a script with a #! line (POSIX only)";
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rm = (...dirs) => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const NO_DOCKER = { DOCKER_HOST: "tcp://127.0.0.1:1", DOCKER_CONTEXT: "" };
const IMAGE_VARS = /^JGATES_.*_IMAGE$/;

function script(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function cliIn(env) {
  return (args, input = "") => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input, timeout: 600_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
}

/** A workspace, a data folder and a bin folder with a fake runtime; the environment has no JGATES_*_IMAGE. */
function workspace({ runtime = FAKE_DOCKER, prefix = "FAKE_DOCKER_", vars = {} } = {}) {
  const dir = tmp("jgates-cf-ws-");
  const home = tmp("jgates-cf-home-");
  const bin = tmp("jgates-cf-bin-");
  const log = path.join(bin, "calls.jsonl");
  const setRuntime = (extra = {}) =>
    script(bin, "docker", `Object.assign(process.env, ${JSON.stringify({ [`${prefix}LOG`]: log, FAKE_LOG: log, ...vars, ...extra })});\nrequire(${JSON.stringify(runtime)});`);
  setRuntime();
  const env = { ...process.env, ...NO_DOCKER, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_CONTAINER_RUNTIME: path.join(bin, "docker"), JGATES_NO_CACHE: "1", PATH: bin };
  for (const name of Object.keys(env)) if (IMAGE_VARS.test(name)) delete env[name];
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, home, bin, env, cli: cliIn(env), setRuntime, calls, cleanup: () => rm(dir, home, bin) };
}

const allItems = (plan) => [...plan.groups.willRun, ...plan.groups.notApplicableOrDisabled];
const itemOf = (plan, id) => allItems(plan).find((i) => i.id === id);
const lockOf = (dir) => readJson(path.join(dir, ".jgates", "lock.json"));

// ---------------------------------------------------------------------------------------------------------------
// Images by the lock file.

test("tools prepare pins the image of a container instance by digest with its version in .jgates/lock.json, and the next plan runs it with no JGATES_*_IMAGE", { skip: POSIX ? false : NO_POSIX }, () => {
  const id = `sha256:${"e1".repeat(32)}`;
  const p = workspace({ vars: { FAKE_DOCKER_IMAGE_ID: id } });
  try {
    assert.ok(!Object.keys(p.env).some((k) => IMAGE_VARS.test(k)), "no image variable in the environment");
    write(p.dir, "mod.py", "import os\n");
    assert.equal(p.cli(["init", "--cwd", p.dir, "--profile", "minimal", "--no-interactive", "--json"]).code, 0);
    write(p.dir, ".jgates/tools.yml", "schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    capabilities: [lint]\n    runner: container\n");

    // Not prepared: the item is unavailable and says how to prepare it.
    const before = p.cli(["plan", "--cwd", p.dir, "--only", "tool:ruff", "--json"]).doc.plan;
    const unprepared = itemOf(before, "ruff#lint");
    assert.equal(unprepared.availability.status, "unavailable");
    assert.match(unprepared.availability.reason, /jgates tools prepare --instance ruff/);
    const doctor = p.cli(["doctor", "--cwd", p.dir, "--json"]).doc;
    const status = doctor.tools.find((t) => t.instance === "ruff");
    assert.deepEqual([status.state, status.preparation.supported, status.preparation.kind, status.preparation.state], ["absent", true, "image", "none"]);

    // A tag is resolved to the image id (a local build has no repository digest); the tag itself is never what runs.
    const dry = p.cli(["tools", "prepare", "--cwd", p.dir, "--instance", "ruff", "--image", "jgates-dev/ruff:0.17.2", "--dry-run", "--json"]);
    assert.equal(dry.code, 0, dry.out + dry.err);
    assert.deepEqual([dry.doc.preview.kind, dry.doc.preview.image.present, dry.doc.preview.network.required, dry.doc.preview.versions.installed], ["image", true, false, "0.17.2"]);
    assert.ok(!fs.existsSync(path.join(p.dir, ".jgates", "lock.json")), "a dry run writes nothing");
    const prepared = p.cli(["tools", "prepare", "--cwd", p.dir, "--instance", "ruff", "--image", "jgates-dev/ruff:0.17.2", "--no-interactive", "--json"]);
    assert.equal(prepared.code, 0, prepared.out + prepared.err);
    assert.equal(p.calls().filter((c) => c[0] === "pull").length, 0, "an image the runtime has is not pulled");
    const locked = lockOf(p.dir).tools.ruff;
    assert.deepEqual(locked.image, { reference: "jgates-dev/ruff:0.17.2", id, pinned: id, versionLabel: "org.jgates.tool.version" });
    assert.equal(locked.toolVersion, "0.17.2");
    assert.equal(locked.adapter, "ruff");

    const plan = p.cli(["plan", "--cwd", p.dir, "--only", "tool:ruff", "--json"]).doc.plan;
    const item = itemOf(plan, "ruff#lint");
    assert.equal(item.availability.status, "available", item.availability.reason);
    assert.equal(item.command.container.image, id, "the plan runs the pinned image");
    assert.equal(item.versions.toolVersion, "0.17.2");
    assert.notEqual(plan.planHash, before.planHash);
    assert.equal(p.cli(["doctor", "--cwd", p.dir, "--json"]).doc.tools.find((t) => t.instance === "ruff").preparation.state, "ready");

    // A registry image is pinned by its repository digest; a second prepare of the same image changes nothing.
    const repoDigest = `registry.example/jgates/ruff@sha256:${"f2".repeat(32)}`;
    p.setRuntime({ FAKE_DOCKER_IMAGE_ID: id, FAKE_DOCKER_REPO_DIGESTS: JSON.stringify([`other.example/x@sha256:${"aa".repeat(32)}`, repoDigest]) });
    const byRegistry = p.cli(["tools", "prepare", "--cwd", p.dir, "--instance", "ruff", "--image", "registry.example/jgates/ruff:0.17.2", "--no-interactive", "--json"]);
    assert.equal(byRegistry.code, 0, byRegistry.out);
    assert.equal(byRegistry.doc.result.image.pinned, repoDigest);
    const again = p.cli(["tools", "prepare", "--cwd", p.dir, "--instance", "ruff", "--no-interactive", "--json"]);
    assert.equal(again.code, 0, again.out);
    assert.equal(again.doc.result.image.reference, "registry.example/jgates/ruff:0.17.2", "without --image the lock's reference is prepared again");
    assert.equal(again.doc.result.changed, false);
    assert.equal(itemOf(p.cli(["plan", "--cwd", p.dir, "--only", "tool:ruff", "--json"]).doc.plan, "ruff#lint").command.container.image, repoDigest);

    // An image without the version label is refused, and the lock keeps what it had.
    p.setRuntime({ FAKE_DOCKER_LABELS: JSON.stringify({ "org.jgates.dev": "true" }) });
    const unlabeled = p.cli(["tools", "prepare", "--cwd", p.dir, "--instance", "ruff", "--image", "jgates-dev/ruff:other", "--no-interactive", "--json"]);
    assert.equal(unlabeled.code, 3);
    assert.equal(unlabeled.doc.error.code, "IMAGE_NO_VERSION");
    assert.equal(lockOf(p.dir).tools.ruff.image.pinned, repoDigest);
  } finally {
    p.cleanup();
  }
});

test("a scanner instance without a prepared image is unavailable with the instruction, and a local Ruff instance has nothing to prepare", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = workspace();
  try {
    assert.equal(p.cli(["init", "--cwd", p.dir, "--profile", "minimal", "--no-interactive", "--json"]).code, 0);
    write(p.dir, ".jgates/tools.yml", "schemaVersion: 1\ntools:\n  gitleaks:\n    adapter: gitleaks\n    capabilities: [secrets]\n  ruff:\n    adapter: ruff\n    capabilities: [lint]\n");
    const plan = p.cli(["plan", "--cwd", p.dir, "--only", "tool:gitleaks", "--json"]).doc.plan;
    const item = itemOf(plan, "gitleaks#secrets");
    assert.equal(item.availability.status, "unavailable");
    assert.match(item.availability.reason, /jgates tools prepare --instance gitleaks/);
    assert.equal(item.command.container.image, "");
    const ran = p.cli(["run", "--cwd", p.dir, "--only", "tool:gitleaks", "--no-interactive", "--json"]).doc;
    assert.equal(ran.stages.find((s) => s.id === "gitleaks#secrets").state, "blocked");
    assert.notEqual(ran.decision, "passed");
    assert.equal(p.calls().filter((c) => c[0] === "run").length, 0);
    const local = p.cli(["tools", "prepare", "--cwd", p.dir, "--instance", "ruff", "--no-interactive", "--json"]);
    assert.equal(local.code, 3);
    assert.equal(local.doc.error.code, "PREPARE_NOT_SUPPORTED");
  } finally {
    p.cleanup();
  }
});

/** The labels of the final stage of quality-gate/Dockerfile, with the build arguments resolved to their defaults. */
function sidecarLabels() {
  const text = fs.readFileSync(path.join(repo, "quality-gate", "Dockerfile"), "utf8").replace(/\\\r?\n/g, " ");
  const args = {};
  for (const m of text.matchAll(/^ARG\s+([A-Z0-9_]+)=(\S+)/gm)) if (!(m[1] in args)) args[m[1]] = m[2];
  const labels = {};
  for (const line of text.split(/\r?\n/).filter((l) => /^LABEL\s/.test(l))) {
    for (const m of line.matchAll(/([a-z0-9.\-]+)="([^"]*)"/g)) labels[m[1]] = m[2].replace(/\$\{(\w+)\}/g, (_, n) => args[n] ?? "");
  }
  return { labels, args };
}

test("quality-gate/Dockerfile declares org.jgates.tool.<tool>.version for each scanner, and the scanners accept the sidecar image as is", { skip: POSIX ? false : NO_POSIX }, () => {
  const { labels, args } = sidecarLabels();
  const expected = { gitleaks: "GITLEAKS_INSTALL_VERSION", trivy: "TRIVY_INSTALL_VERSION", "osv-scanner": "OSV_SCANNER_INSTALL_VERSION", checkov: "CHECKOV_INSTALL_VERSION", semgrep: "SEMGREP_INSTALL_VERSION", jscpd: "JSCPD_INSTALL_VERSION" };
  for (const [tool, arg] of Object.entries(expected)) {
    assert.match(args[arg] ?? "", /^\d+\.\d+\.\d+$/, arg);
    assert.equal(labels[`org.jgates.tool.${tool}.version`], args[arg], `${tool} label`);
  }
  const manifests = new Map(builtinManifests().map((m) => [m.id, m]));
  // The fake runtime answers with exactly those labels for the default reference (the sidecar image).
  const p = workspace({ runtime: FAKE_SECURITY_RUNTIME, prefix: "FAKE_", vars: { FAKE_LABELS: JSON.stringify(labels) } });
  try {
    assert.equal(p.cli(["init", "--cwd", p.dir, "--profile", "standard", "--no-interactive", "--json"]).code, 0);
    write(p.dir, ".jgates/tools.yml", "schemaVersion: 1\ntools:\n  gitleaks:\n    adapter: gitleaks\n    capabilities: [secrets]\n  trivy:\n    adapter: trivy\n    capabilities: [dependencies]\n  osv-scanner:\n    adapter: osv-scanner\n    capabilities: [dependencies]\n  checkov:\n    adapter: checkov\n    capabilities: [iac]\n");
    for (const tool of ["gitleaks", "trivy", "osv-scanner", "checkov"]) {
      const prepared = p.cli(["tools", "prepare", "--cwd", p.dir, "--instance", tool, "--no-interactive", "--json"]);
      assert.equal(prepared.code, 0, `${tool}: ${prepared.out}${prepared.err}`);
      assert.equal(prepared.doc.result.image.reference, prepare.SIDECAR_IMAGE, "the default image is the sidecar's");
      assert.equal(prepared.doc.result.toolVersion, args[expected[tool]]);
      assert.equal(prepared.doc.result.image.versionLabel, `org.jgates.tool.${tool}.version`);
      assert.equal(prepare.satisfiesRange(prepared.doc.result.toolVersion, manifests.get(tool).toolVersionRange), true, `${tool} of the sidecar fits the adapter range`);
    }
    assert.equal(p.calls().filter((c) => c[0] === "pull").length, 0, "the default sidecar name is never pulled from a registry");
    const plan = p.cli(["plan", "--cwd", p.dir, "--json"]).doc.plan;
    for (const id of ["gitleaks#secrets", "trivy#dependencies", "osv-scanner#dependencies", "checkov#iac"]) {
      const item = itemOf(plan, id);
      assert.equal(item.availability.status, "available", `${id}: ${item.availability.reason}`);
      assert.match(item.command.container.image, /^sha256:[0-9a-f]{64}$/, id);
    }
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Trivy: database cache and licenses.

const TRIVY_TOOLS = (capabilities) => `schemaVersion: 1\ntools:\n  trivy:\n    adapter: trivy\n    capabilities: [${capabilities.join(", ")}]\n`;

function trivyWorkspace(capabilities, vars = {}) {
  const p = workspace({ runtime: FAKE_SECURITY_RUNTIME, prefix: "FAKE_", vars });
  assert.equal(p.cli(["init", "--cwd", p.dir, "--profile", "standard", "--no-interactive", "--json"]).code, 0);
  write(p.dir, "package-lock.json", '{"lockfileVersion":3,"packages":{}}\n');
  write(p.dir, ".jgates/tools.yml", TRIVY_TOOLS(capabilities));
  const prepared = p.cli(["tools", "prepare", "--cwd", p.dir, "--instance", "trivy", "--image", `registry.example/jgates/security@sha256:${"cd".repeat(32)}`, "--no-interactive", "--json"]);
  assert.equal(prepared.code, 0, prepared.out + prepared.err);
  return p;
}

test("Trivy's vulnerability database stays in the data folder between runs with its dates, and the second run does not download it again", { skip: POSIX ? false : NO_POSIX }, () => {
  const scratch = tmp("jgates-cf-db-");
  const meta = path.join(scratch, "metadata.json");
  const next = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  fs.writeFileSync(meta, JSON.stringify({ Version: 2, NextUpdate: next, UpdatedAt: "2026-10-25T19:10:35.479132794Z", DownloadedAt: "2026-10-25T21:14:51.366240096Z" }));
  const downloads = path.join(scratch, "downloads.log");
  const count = () => (fs.existsSync(downloads) ? fs.readFileSync(downloads, "utf8").split("\n").filter(Boolean).length : 0);
  const p = trivyWorkspace(["dependencies"], {
    FAKE_REPORT: path.join(SECURITY_FIXTURES, "trivy", "0.72.0", "fs-report.json"),
    FAKE_DB_META: meta,
    FAKE_DOWNLOADS: downloads,
    FAKE_STDERR: '2026-10-25T21:14:51Z\tINFO\t[vulndb] Artifact successfully downloaded\trepo="mirror.gcr.io/aquasec/trivy-db:2"\n',
  });
  const cacheDir = path.join(p.home, "tools", "cache", "trivy-db");
  const runs = () => p.calls().filter((c) => c[0] === "run");
  try {
    const run = () => {
      const r = p.cli(["run", "--cwd", p.dir, "--only", "tool:trivy", "--no-interactive", "--json"]);
      assert.ok(r.doc, r.out + r.err);
      assert.ok(validateResult(r.doc), JSON.stringify(validateResult.errors));
      const stage = r.doc.stages.find((s) => s.id === "trivy#dependencies");
      assert.equal(stage.state, "completed", JSON.stringify(stage));
      return { doc: r.doc, stage };
    };
    // First run: Trivy downloads, and the copy moves into the data folder with the record of its dates.
    const first = run();
    assert.equal(count(), 1);
    assert.ok(!runs()[0].includes("--skip-db-update"));
    assert.ok(fs.existsSync(path.join(cacheDir, "trivy.db")) && fs.existsSync(path.join(cacheDir, "metadata.json")));
    const record = readJson(path.join(cacheDir, "jgates-cache.json"));
    assert.deepEqual(
      { source: record.source, updatedAt: record.updatedAt, nextUpdate: record.nextUpdate, downloadedAt: record.downloadedAt },
      { source: "mirror.gcr.io/aquasec/trivy-db:2", updatedAt: "2026-10-25T19:10:35.479132794Z", nextUpdate: next, downloadedAt: "2026-10-25T21:14:51.366240096Z" },
    );
    assert.ok(Date.parse(record.storedAt) > 0);
    assert.equal(first.stage.analysisInput.database.networkRequired, true);
    assert.match(first.stage.reason, /guardada em cache/);
    assert.ok(!fs.existsSync(path.join(first.doc.runDir, "outputs", "trivy", "trivy", "cache", "db", "trivy.db")), "the database is not left in the run folder");

    // Second run: the fresh copy is used, Trivy is told not to download, and the dates are the recorded ones.
    const second = run();
    assert.equal(count(), 1, "the second run does not download the database again");
    const call = runs()[1];
    assert.ok(call.includes("--skip-db-update"), call.join(" "));
    assert.equal(call[call.length - 1], ".", "the scan target stays last");
    const db = second.stage.analysisInput.database;
    assert.deepEqual({ source: db.source, updatedAt: db.updatedAt, downloadedAt: db.downloadedAt, networkRequired: db.networkRequired }, { source: "mirror.gcr.io/aquasec/trivy-db:2", updatedAt: record.updatedAt, downloadedAt: record.downloadedAt, networkRequired: false });
    assert.match(second.stage.reason, /cache na pasta de dados, baixada em 2026-10-25T21:14:51/);
    assert.equal(second.stage.findings, first.stage.findings);
    assert.ok(fs.existsSync(path.join(cacheDir, "trivy.db")), "the cached copy stays after the run");
    assert.ok(Date.parse(readJson(path.join(cacheDir, "jgates-cache.json")).lastUsedAt) >= Date.parse(record.lastUsedAt));
    // The plan is the same for both runs: the cache is a decision of the run, never a change of the plan.
    assert.equal(second.doc.selection.planHash, first.doc.selection.planHash);

    // A copy past its next update is downloaded again (and replaces the cached one).
    const stale = readJson(path.join(cacheDir, "jgates-cache.json"));
    fs.writeFileSync(path.join(cacheDir, "jgates-cache.json"), JSON.stringify({ ...stale, nextUpdate: "2020-01-01T00:00:00Z" }));
    run();
    assert.equal(count(), 2);
    assert.ok(!runs()[2].includes("--skip-db-update"));
    assert.equal(readJson(path.join(cacheDir, "jgates-cache.json")).nextUpdate, next);
  } finally {
    p.cleanup();
    rm(scratch);
  }
});

test("Trivy licenses: the recorded license report of 0.72.0 becomes a finding of the licenses capability, in the parser and in a run [proves: trivy#licenses]", { skip: POSIX ? false : NO_POSIX }, () => {
  // Recorded with `trivy fs --scanners license` of jgates-dev/security-scanners (Trivy 0.72.0) on a package-lock.json
  // whose only dependency is GPL-3.0-only.
  const report = path.join(SECURITY_FIXTURES, "trivy", "0.72.0", "fs-licenses.json");
  const parsed = parseTrivyReport(fs.readFileSync(report, "utf8"), { version: "0.72.0", cwd: "/workspace", capabilities: ["licenses"] });
  assert.equal(parsed.ok, true, parsed.problem);
  assert.deepEqual(parsed.findings.map((f) => [f.capability, f.ruleId, f.location.path, f.normalizedSeverity, f.blocking]), [["licenses", "license:GPL-3.0-only", "package-lock.json", "high", true]]);

  const p = trivyWorkspace(["licenses"], { FAKE_REPORT: report });
  try {
    const plan = p.cli(["plan", "--cwd", p.dir, "--only", "tool:trivy", "--json"]).doc.plan;
    const item = itemOf(plan, "trivy#licenses");
    assert.equal(item.availability.status, "available", item.availability.reason);
    assert.deepEqual(item.command.args.slice(item.command.args.indexOf("--scanners"), item.command.args.indexOf("--scanners") + 2), ["--scanners", "license"]);
    const ran = p.cli(["run", "--cwd", p.dir, "--only", "tool:trivy", "--no-interactive", "--json"]).doc;
    assert.ok(validateResult(ran), JSON.stringify(validateResult.errors));
    const stage = ran.stages.find((s) => s.id === "trivy#licenses");
    assert.equal(stage.state, "completed", JSON.stringify(stage));
    assert.equal(stage.findings, 1);
    assert.deepEqual(ran.findings.filter((f) => f.stageId === "trivy#licenses").map((f) => [f.ruleId, f.location.path, f.normalizedSeverity]), [["license:GPL-3.0-only", "package-lock.json", "high"]]);
    assert.equal(ran.decision, "failed", "a restricted license blocks");
    // The license scan reads no vulnerability database: nothing is cached and no update flag is added.
    assert.ok(!p.calls().find((c) => c[0] === "run").includes("--skip-db-update"));
    assert.ok(!fs.existsSync(path.join(p.home, "tools", "cache", "trivy-db")));
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The bridge's own file-size budget, run for real (the sidecar's Python code, no external tool).

test("the bridge's file-size budget: a file over the line limit is a finding of the file-size subcheck [proves: quality-bridge#file-size]", { skip: fs.existsSync(PYTHON) ? false : "the repository .venv is missing (python3 -m venv .venv && .venv/bin/pip install -e quality-gate)" }, () => {
  const dir = tmp("jgates-cf-size-");
  const home = tmp("jgates-cf-size-home-");
  const bin = tmp("jgates-cf-size-bin-");
  try {
    write(dir, "small.py", "value = 1\n");
    write(dir, "big.py", "x = 1\n".repeat(12_001));
    const env = { ...process.env, ...NO_DOCKER, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_NO_CACHE: "1", PATH: bin };
    const r = spawnSync(process.execPath, [MAIN, "run", "--cwd", dir, "--bridge-mode", "quick", "--json"], { encoding: "utf8", env, timeout: 600_000 });
    const doc = JSON.parse(r.stdout);
    assert.ok(validateResult(doc), JSON.stringify(validateResult.errors));
    const stage = doc.stages.find((s) => s.id === "quality-bridge.file-size");
    assert.equal(stage.state, "completed", JSON.stringify(stage));
    const findings = doc.findings.filter((f) => f.stageId === "quality-bridge.file-size");
    assert.ok(findings.some((f) => f.ruleId === "budget.file-lines" && f.location?.path === "big.py"), JSON.stringify(findings));
    assert.ok(!findings.some((f) => f.location?.path === "small.py"));
  } finally {
    rm(dir, home, bin);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Templates by configuration evidence (match.files).

function tsProject() {
  const dir = tmp("jgates-cf-ts-");
  write(dir, "package.json", JSON.stringify({ name: "demo", version: "1.0.0", type: "module" }, null, 2) + "\n");
  write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }) + "\n");
  write(dir, "src/index.ts", "export const one = 1;\n");
  return dir;
}

function quietCli() {
  const home = tmp("jgates-cf-tpl-home-");
  const bin = tmp("jgates-cf-tpl-bin-");
  const cli = cliIn({ ...process.env, ...NO_DOCKER, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_NO_CACHE: "1", PATH: bin });
  return { cli, cleanup: () => rm(home, bin) };
}

const toolItems = (plan, tool) => allItems(plan).filter((i) => i.tool === tool);

test("with match.files a TypeScript project without eslint.config gets no eslint#lint, and one with eslint.config gets it from typescript-eslint", () => {
  const dir = tsProject();
  const q = quietCli();
  try {
    assert.equal(q.cli(["init", "--cwd", dir, "--profile", "standard", "--no-interactive", "--json"]).code, 0);
    const without = q.cli(["plan", "--cwd", dir, "--json"]).doc.plan;
    assert.deepEqual(toolItems(without, "eslint"), [], "no ESLint step without its configuration");
    assert.ok(!without.warnings.some((w) => /eslint/i.test(w.message)), JSON.stringify(without.warnings));
    assert.ok(without.templates.active.some((t) => t.id === "typescript"), "the typescript template itself stays");
    assert.deepEqual(toolItems(without, "dependency-cruiser"), [], "no architecture contract: no dependency-cruiser step either");

    write(dir, "eslint.config.js", "export default [];\n");
    const withConfig = q.cli(["plan", "--cwd", dir, "--json"]).doc.plan;
    const items = toolItems(withConfig, "eslint");
    assert.deepEqual(items.map((i) => i.id), ["eslint#lint"]);
    const included = items[0].includedBy.find((i) => i.kind === "template");
    assert.equal(included.entry, "typescript-eslint");
    assert.ok(included.matched.includes("eslint.config.js"), JSON.stringify(included));
    assert.notEqual(withConfig.planHash, without.planHash);
  } finally {
    q.cleanup();
    rm(dir);
  }
});

test("pytest and Vitest enter the plan by the evidence of their configuration (a section of a shared file counts only when it is there)", () => {
  const py = tmp("jgates-cf-py-");
  const ts = tsProject();
  const q = quietCli();
  try {
    write(py, "pyproject.toml", '[project]\nname = "demo"\nversion = "0.1.0"\n');
    write(py, "demo/__init__.py", "");
    write(py, "tests/test_demo.py", "def test_one():\n    assert True\n");
    for (const dir of [py, ts]) assert.equal(q.cli(["init", "--cwd", dir, "--profile", "strict", "--no-interactive", "--json"]).code, 0);
    assert.deepEqual(toolItems(q.cli(["plan", "--cwd", py, "--json"]).doc.plan, "pytest"), [], "a pyproject.toml without the pytest section is no evidence");
    assert.deepEqual(toolItems(q.cli(["plan", "--cwd", ts, "--json"]).doc.plan, "vitest"), []);

    fs.appendFileSync(path.join(py, "pyproject.toml"), '\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
    const pyPlan = q.cli(["plan", "--cwd", py, "--json"]).doc.plan;
    assert.deepEqual(toolItems(pyPlan, "pytest").map((i) => i.id).sort(), ["pytest#coverage", "pytest#unit"]);
    assert.ok(pyPlan.templates.active.find((t) => t.id === "python-pytest").matched.includes("pyproject.toml"));

    write(ts, "vitest.config.ts", "export default {};\n");
    const tsPlan = q.cli(["plan", "--cwd", ts, "--json"]).doc.plan;
    assert.deepEqual(toolItems(tsPlan, "vitest").map((i) => i.id).sort(), ["vitest#coverage", "vitest#unit"]);
    assert.ok(tsPlan.templates.active.find((t) => t.id === "typescript-vitest").matched.includes("vitest.config.ts"));
  } finally {
    q.cleanup();
    rm(py, ts);
  }
});

test("match.files is a path inside the project: a project template that points outside it is refused by the schema", () => {
  const dir = tsProject();
  const q = quietCli();
  try {
    write(dir, "jgates.yml", "schemaVersion: 1\ntemplates:\n  - id: mine\n    source: .jgates/templates/mine.yml\n    activation: detected\n");
    write(dir, ".jgates/templates/mine.yml", "schemaVersion: 1\nid: mine\nmatch:\n  files:\n    - ../outside.cfg\n");
    const resolved = q.cli(["config", "resolve", "--cwd", dir, "--json"]);
    assert.equal(resolved.code, 3, resolved.out);
    assert.ok(resolved.out.includes("TEMPLATE_INVALID"), resolved.out);
  } finally {
    q.cleanup();
    rm(dir);
  }
});

const CONFIG_MISSING = [/eslint\.config/i, /contrato/i, /architecture\.yml/i];

test("init --profile standard on the main fixture plans and runs with no step blocked for a missing configuration", () => {
  const { dir } = mainFixture.createMainFixture();
  const q = quietCli();
  try {
    const init = q.cli(["init", "--cwd", dir, "--profile", "standard", "--no-interactive", "--json"]);
    assert.equal(init.code, 0, init.out);
    const plan = q.cli(["plan", "--cwd", dir, "--json"]).doc.plan;
    assert.deepEqual(toolItems(plan, "eslint"), [], "no eslint.config in the fixture: no ESLint step");
    const configProblems = (text) => CONFIG_MISSING.some((re) => re.test(text ?? ""));
    for (const item of plan.groups.willRun) {
      if (item.availability.status !== "available") assert.ok(!configProblems(item.availability.reason), `${item.id}: ${item.availability.reason}`);
    }
    assert.ok(!plan.warnings.some((w) => w.code === "TOOL_UNAVAILABLE" && configProblems(w.message)), JSON.stringify(plan.warnings));

    const r = q.cli(["run", "--cwd", dir, "--no-interactive", "--json"]);
    assert.ok(r.doc, r.out + r.err);
    const blocked = r.doc.stages.filter((s) => s.state === "blocked");
    for (const s of blocked) assert.ok(!configProblems(s.reason), `${s.id} blocked for a configuration: ${s.reason}`);
    assert.ok(!r.doc.stages.some((s) => /^(eslint|import-linter|dependency-cruiser)#/.test(s.id) && s.state === "blocked"), JSON.stringify(blocked.map((s) => s.id)));
  } finally {
    q.cleanup();
    mainFixture.removeFixture(dir);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The matrix accepts only tests that say they exercise the capability.

test("verifyMatrix refuses a cited test whose title does not say it exercises the capability, and the bridge scanners without a real proof are declared with the reason", () => {
  const matrix = mx.buildMatrix();
  assert.deepEqual(mx.verifyMatrix(matrix), []);
  const ruff = matrix.adapters.find((a) => a.id === "ruff");
  // A real test of the Ruff adapter, but one that does not claim the capability.
  ruff.capabilities[0].tests = [{ file: "adapter-ruff.test.js", test: "the manifest is valid for the catalog" }];
  const problems = mx.verifyMatrix(matrix);
  assert.ok(problems.some((p) => p.startsWith("ruff#lint") && p.includes("[proves: ruff#lint]")), problems.join("\n"));
  // A marker of another capability does not count either.
  ruff.capabilities[0].tests = [{ file: "adapters-security.test.js", test: "Checkov 3.3.8" }];
  assert.ok(mx.verifyMatrix(matrix).some((p) => p.startsWith("ruff#lint")));

  const fresh = mx.buildMatrix();
  const bridge = fresh.adapters.find((a) => a.id === "quality-bridge");
  const status = Object.fromEntries(bridge.capabilities.map((c) => [c.id, c.status]));
  assert.equal(status["file-size"], "integrated");
  for (const id of ["lint", "sast", "secrets", "dependencies", "duplication", "iac", "coverage", "unit"]) {
    const c = bridge.capabilities.find((x) => x.id === id);
    assert.equal(c.status, "declared", id);
    assert.match(c.note.ptBR, /smoke com Docker da ponte/, id);
    assert.match(c.note.en, /Docker smoke of the bridge/, id);
  }
  assert.equal(fresh.adapters.find((a) => a.id === "trivy").capabilities.find((c) => c.id === "licenses").status, "integrated");
  // The titles parse as the test runner sees them.
  assert.deepEqual(mx.provedBy("x [proves: trivy#dependencies, trivy#iac] y"), ["trivy#dependencies", "trivy#iac"]);
  assert.deepEqual(mx.testTitles('test("a \\"b\\" [proves: x#y]", () => {});'), ['a "b" [proves: x#y]']);
});
