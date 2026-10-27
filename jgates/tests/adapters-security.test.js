import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// The security scanners that left the bridge (Gitleaks, Trivy, OSV-Scanner, Checkov) as adapters of their own: the
// plan builds the container command with the documents chosen in tools.yml, the run normalizes the recorded reports
// of the pinned versions (tests/fixtures/parsers/security/<tool>/<version>), a cut report or one of another version is
// an error and never "zero findings", the bridge leaves out the subcheck an adapter runs (and says why), and the
// vulnerability database of Trivy and OSV-Scanner is recorded. The container runtime is a fake that writes the
// recorded report into the /output mount; npm run test:docker runs the real scanners.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FIXTURES = path.join(here, "fixtures", "parsers", "security");
const FAKE_RUNTIME = path.join(FIXTURES, "fake-runtime.cjs");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const runner = await import(pathToFileURL(path.join(dist, "core", "runner", "index.js")).href);
const { parseGitleaksReport, gitleaksManifest } = await import(pathToFileURL(path.join(dist, "adapters", "gitleaks", "index.js")).href);
const { parseTrivyReport, trivyFacts, databaseSource } = await import(pathToFileURL(path.join(dist, "adapters", "trivy", "index.js")).href);
const { parseOsvReport } = await import(pathToFileURL(path.join(dist, "adapters", "osv-scanner", "index.js")).href);
const { parseCheckovReport } = await import(pathToFileURL(path.join(dist, "adapters", "checkov", "index.js")).href);
const { builtinManifests } = await import(pathToFileURL(path.join(dist, "adapters", "manifests.js")).href);
const catalog = await import(pathToFileURL(path.join(dist, "core", "catalog", "index.js")).href);

const validateResult = new Ajv2020({ strict: true, allErrors: true }).compile(JSON.parse(fs.readFileSync(path.join(here, "..", "schemas", "result", "result.schema.json"), "utf8")));
const validatePlan = new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(fs.readFileSync(path.join(here, "..", "schemas", "plan", "plan.schema.json"), "utf8")));

const POSIX = process.platform !== "win32";
const NO_POSIX = "the fake runtime is a script with a #! line (POSIX only)";
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rm = (...dirs) => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
const fixture = (...p) => path.join(FIXTURES, ...p);
const read = (...p) => fs.readFileSync(fixture(...p), "utf8");
const IMAGE = `registry.example/jgates/security@sha256:${"cd".repeat(32)}`;
const PARSE = (version, capabilities = ["secrets"]) => ({ version, cwd: "/workspace", capabilities });

const TOOLS_YML = `schemaVersion: 1
tools:
  gitleaks:
    adapter: gitleaks
    capabilities: [secrets]
    config: .gitleaks.toml
    configFiles:
      ignore:
        path: .gitleaksignore
        role: ignore
  trivy:
    adapter: trivy
    capabilities: [dependencies, iac]
    config: trivy.yaml
    configFiles:
      ignore:
        path: .trivyignore
        role: ignore
  osv-scanner:
    adapter: osv-scanner
    capabilities: [dependencies]
    config: osv-scanner.toml
  checkov:
    adapter: checkov
    capabilities: [iac]
    config: .checkov.yaml
`;

// ---------------------------------------------------------------------------------------------------------------
// Parsers against the recorded reports of the pinned versions.

test("Gitleaks 8.30.1: the recorded dir report becomes one critical finding with rule, place and the masked value", () => {
  const parsed = parseGitleaksReport(read("gitleaks", "8.30.1", "dir-leak.json"), PARSE("8.30.1"));
  assert.equal(parsed.ok, true, parsed.problem);
  assert.equal(parsed.findings.length, 1);
  const [f] = parsed.findings;
  assert.equal(f.ruleId, "github-pat");
  assert.deepEqual(f.location, { path: "settings.py", line: 1, column: 17 });
  assert.equal(f.normalizedSeverity, "critical");
  assert.equal(f.blocking, true);
  assert.equal(f.capability, "secrets");
  assert.equal(f.evidence, "REDACTED");
  assert.equal(f.nativeFingerprint, "settings.py:github-pat:1");
  assert.equal(parseGitleaksReport(read("gitleaks", "8.30.1", "dir-clean.json"), PARSE("8.30.1")).findings.length, 0);
});

test("Gitleaks: a report that carries the secret anyway is masked by the parser, and a history scan is its own capability [proves: gitleaks#secrets-history]", () => {
  const secret = ["ghp", "_", "synthetic", "0123456789abcdefghijklmnopqrstu"].join("");
  const report = JSON.stringify([{ RuleID: "github-pat", File: "/workspace/a.py", StartLine: 3, Secret: secret, Match: `TOKEN = "${secret}"`, Commit: "0123456789abcdef0123", Fingerprint: "x" }]);
  const parsed = parseGitleaksReport(report, PARSE("8.30.1", ["secrets-history"]));
  assert.equal(parsed.ok, true, parsed.problem);
  assert.equal(parsed.findings[0].evidence, 'TOKEN = "REDACTED"');
  assert.ok(!JSON.stringify(parsed.findings).includes(secret), "the raw value never leaves the parser");
  assert.equal(parsed.findings[0].capability, "secrets-history");
  assert.match(parsed.findings[0].message, /commit 0123456789ab/);
  assert.equal(parsed.findings[0].location.path, "a.py");
});

test("Trivy 0.72.0: vulnerabilities, misconfigurations and secrets go to their capabilities; the database metadata is read [proves: trivy#dependencies, trivy#iac, trivy#secrets]", () => {
  const parsed = parseTrivyReport(read("trivy", "0.72.0", "fs-report.json"), PARSE("0.72.0"));
  assert.equal(parsed.ok, true, parsed.problem);
  assert.equal(parsed.reportedVersion, "0.72.0");
  const by = (cap) => parsed.findings.filter((f) => f.capability === cap);
  assert.deepEqual(by("dependencies").map((f) => [f.ruleId, f.location.path, f.normalizedSeverity]), [
    ["CVE-2020-8203", "package-lock.json", "high"],
    ["CVE-2021-23337", "package-lock.json", "high"],
  ]);
  assert.ok(by("dependencies")[0].message.startsWith("lodash@4.17.15"));
  assert.deepEqual(by("iac").map((f) => [f.ruleId, f.location.path, f.location.line]), [["AWS-0086", "main.tf", 1], ["AWS-0087", "main.tf", 1]]);
  assert.deepEqual(by("secrets").map((f) => [f.ruleId, f.location.path, f.normalizedSeverity, f.evidence]), [["github-pat", "settings.py", "critical", undefined]]);

  const cache = tmp("jgates-sec-trivy-cache-");
  try {
    fs.mkdirSync(path.join(cache, "db"));
    fs.copyFileSync(fixture("trivy", "0.72.0", "db-metadata.json"), path.join(cache, "db", "metadata.json"));
    const stderr = '2026-10-25T21:14:37Z\tINFO\t[vulndb] Downloading artifact...\trepo="mirror.gcr.io/aquasec/trivy-db:2"\n';
    assert.equal(databaseSource(stderr), "mirror.gcr.io/aquasec/trivy-db:2");
    const facts = trivyFacts(cache, stderr);
    assert.equal(facts.database.source, "mirror.gcr.io/aquasec/trivy-db:2");
    assert.equal(facts.database.updatedAt, "2026-10-25T19:10:35.479132794Z");
    assert.equal(facts.database.reported, true);
  } finally {
    rm(cache);
  }
});

test("OSV-Scanner 2.4.0: one finding per advisory group, severity from the CVSS score [proves: osv-scanner#dependencies]", () => {
  const parsed = parseOsvReport(read("osv-scanner", "2.4.0", "source-vulns.json"), PARSE("2.4.0", ["dependencies"]));
  assert.equal(parsed.ok, true, parsed.problem);
  assert.deepEqual(parsed.findings.map((f) => [f.ruleId, f.location.path, f.severity, f.blocking]), [
    ["GHSA-29mw-wpgm-hmr9", "package-lock.json", "MEDIUM", true],
    ["GHSA-35jh-r3h4-6jhm", "package-lock.json", "HIGH", true],
    ["GHSA-f23m-r3pf-42rh", "package-lock.json", "MEDIUM", true],
  ]);
  assert.match(parsed.findings[0].message, /^lodash@4\.17\.15: .*CVE-2020-28500.*\[CVSS 5\.3\]$/);
});

test("Checkov 3.3.8: failed checks become MEDIUM findings with the file and the first line; the empty summary is zero findings [proves: checkov#iac]", () => {
  const parsed = parseCheckovReport(read("checkov", "3.3.8", "terraform-failed.json"), PARSE("3.3.8", ["iac"]));
  assert.equal(parsed.ok, true, parsed.problem);
  assert.deepEqual(parsed.findings.map((f) => [f.ruleId, f.location.path, f.location.line, f.severity]), [
    ["CKV_AWS_144", "main.tf", 1, "MEDIUM"],
    ["CKV_AWS_20", "main.tf", 1, "MEDIUM"],
    ["CKV2_AWS_61", "main.tf", 1, "MEDIUM"],
  ]);
  const empty = parseCheckovReport(read("checkov", "3.3.8", "empty.json"), PARSE("3.3.8", ["iac"]));
  assert.equal(empty.ok, true, empty.problem);
  assert.equal(empty.findings.length, 0);
});

test("a cut report, another shape or a report of a version outside the parser's range proves nothing", () => {
  const cut = (text) => text.slice(0, Math.floor(text.length / 2));
  const cases = [
    ["gitleaks cut", parseGitleaksReport(cut(read("gitleaks", "8.30.1", "dir-leak.json")), PARSE("8.30.1"))],
    ["gitleaks object", parseGitleaksReport("{}", PARSE("8.30.1"))],
    ["gitleaks 7", parseGitleaksReport(read("gitleaks", "8.30.1", "dir-leak.json"), PARSE("7.6.1"))],
    ["trivy cut", parseTrivyReport(cut(read("trivy", "0.72.0", "fs-report.json")), PARSE("0.72.0"))],
    ["trivy schema 1", parseTrivyReport(JSON.stringify({ ...JSON.parse(read("trivy", "0.72.0", "fs-report.json")), SchemaVersion: 1 }), PARSE("0.72.0"))],
    ["trivy 1.2.0", parseTrivyReport(JSON.stringify({ ...JSON.parse(read("trivy", "0.72.0", "fs-report.json")), Trivy: { Version: "1.2.0" } }), PARSE("0.72.0"))],
    ["osv cut", parseOsvReport(cut(read("osv-scanner", "2.4.0", "source-vulns.json")), PARSE("2.4.0"))],
    ["osv v1", parseOsvReport(read("osv-scanner", "2.4.0", "source-vulns.json"), PARSE("1.9.2"))],
    ["checkov cut", parseCheckovReport(cut(read("checkov", "3.3.8", "terraform-failed.json")), PARSE("3.3.8"))],
    ["checkov {}", parseCheckovReport("{}", PARSE("3.3.8"))],
    ["checkov 4", parseCheckovReport(read("checkov", "3.3.8", "empty.json").replace("3.3.8", "4.0.1"), PARSE("3.3.8"))],
  ];
  for (const [name, parsed] of cases) {
    assert.equal(parsed.ok, false, name);
    assert.equal(parsed.findings.length, 0, name);
    assert.ok(parsed.problem, name);
  }
});

test("the four manifests are registered, valid and known to the catalog (secrets-history is its own capability)", () => {
  const ids = builtinManifests().map((m) => m.id);
  for (const id of ["gitleaks", "trivy", "osv-scanner", "checkov"]) assert.ok(ids.includes(id), id);
  const cat = catalog.createCoreCatalog();
  for (const m of builtinManifests().filter((x) => ["gitleaks", "trivy", "osv-scanner", "checkov"].includes(x.id))) {
    assert.deepEqual(catalog.validateManifest(m).errors, [], m.id);
    cat.addAdapter(m);
    assert.deepEqual(m.runtimes, ["container"], m.id);
  }
  assert.ok(gitleaksManifest.capabilities.includes("secrets-history"));
});

// ---------------------------------------------------------------------------------------------------------------
// Plan and run through the CLI with the fake container runtime.

/** An executable Node script (#! with the absolute node path), so it runs without PATH and without a shell. */
function script(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function cliIn(env) {
  return (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, timeout: 600_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
}

function project({ profile = "standard", tools = TOOLS_YML } = {}) {
  const dir = tmp("jgates-sec-ws-");
  const home = tmp("jgates-sec-home-");
  const bin = tmp("jgates-sec-bin-");
  const log = path.join(bin, "calls.jsonl");
  /** Points the runtime at a scenario: what it answers and which recorded report it writes. */
  const runtime = (vars = {}) => script(bin, "docker", `Object.assign(process.env, ${JSON.stringify({ FAKE_LOG: log, ...vars })});\nrequire(${JSON.stringify(FAKE_RUNTIME)});`);
  runtime();
  // No JGATES_*_IMAGE: each instance's image is pinned in .jgates/lock.json by `tools prepare` (below).
  const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_CONTAINER_RUNTIME: path.join(bin, "docker"), JGATES_NO_CACHE: "1", PATH: bin };
  for (const name of Object.keys(env)) if (/^JGATES_.*_IMAGE$/.test(name)) delete env[name];
  const cli = cliIn(env);
  const init = cli(["init", "--cwd", dir, "--profile", profile, "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  const files = {
    ".gitleaks.toml": '[extend]\nuseDefault = true\n',
    ".gitleaksignore": "",
    "trivy.yaml": "severity:\n  - HIGH\n  - CRITICAL\n",
    ".trivyignore": "",
    "osv-scanner.toml": "",
    ".checkov.yaml": "framework:\n  - terraform\n",
    "main.tf": 'resource "aws_s3_bucket" "data" {\n  bucket = "demo"\n}\n',
    "package-lock.json": '{"lockfileVersion":3,"packages":{}}\n',
    "app.py": "value = 1\n",
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), tools);
  for (const [, instance] of tools.matchAll(/^ {2}([a-z0-9-]+):\n {4}adapter: (?:gitleaks|trivy|osv-scanner|checkov)$/gm)) {
    const prepared = cli(["tools", "prepare", "--cwd", dir, "--instance", instance, "--image", IMAGE, "--no-interactive", "--json"]);
    assert.equal(prepared.code, 0, prepared.out + prepared.err);
  }
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, home, bin, env, cli, runtime, calls, cleanup: () => rm(dir, home, bin) };
}

const itemOf = (plan, id) => [...plan.groups.willRun, ...plan.groups.notApplicableOrDisabled].find((i) => i.id === id);
const stageOf = (result, id) => result.stages.find((s) => s.id === id);

test("each adapter plans the container command with the documents chosen in tools.yml (fake runtime)", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = project();
  try {
    const planned = p.cli(["plan", "--cwd", p.dir, "--json"]);
    assert.equal(planned.code, 0, planned.out + planned.err);
    const plan = planned.doc.plan;
    assert.ok(validatePlan(plan), JSON.stringify(validatePlan.errors));
    const expected = {
      "gitleaks#secrets": ["dir", "--redact=100", "--no-banner", "--no-color", "--log-level", "warn", "--exit-code", "3", "--report-format", "json", "--report-path", "/output/report.json", "--config", "/workspace/.gitleaks.toml", "--gitleaks-ignore-path", "/workspace/.gitleaksignore", "."],
      "trivy#dependencies": ["--config", "/workspace/trivy.yaml", "fs", "--scanners", "vuln,misconfig", "--format", "json", "--output", "/output/report.json", "--exit-code", "0", "--cache-dir", "/output/cache", "--skip-version-check", "--disable-telemetry", "--no-progress", "--ignorefile", "/workspace/.trivyignore", "."],
      "osv-scanner#dependencies": ["scan", "source", "--recursive", "--allow-no-lockfiles", "--format", "json", "--output-file", "/output/report.json", "--config", "/workspace/osv-scanner.toml", "."],
      "checkov#iac": ["--config-file", "/workspace/.checkov.yaml", "--directory", ".", "--output", "json", "--output-file-path", "/output", "--quiet", "--compact", "--skip-download"],
    };
    for (const [id, args] of Object.entries(expected)) {
      const item = plan.groups.willRun.find((i) => i.id === id);
      assert.ok(item, `${id} in ${JSON.stringify(plan.groups.willRun.map((i) => i.id))}`);
      assert.equal(item.availability.status, "available", item.availability.reason);
      assert.deepEqual(item.command.args, args, id);
      assert.equal(item.command.container.image, IMAGE);
      assert.deepEqual(item.command.container.mounts[0], { source: "{workspace}", target: "/workspace", readOnly: true });
      assert.equal(item.command.container.mounts[1].target, "/output");
      assert.equal(item.runtime.name, "container");
      assert.ok(item.versions.toolVersion, "the version comes from the image label");
    }
    // The documents are hashed into the plan; the network need is declared.
    assert.deepEqual(itemOf(plan, "gitleaks#secrets").configFiles.map((f) => f.file).filter((f) => !f.startsWith(".jgates") && !f.startsWith("builtin:") && f !== "jgates.yml"), [".gitleaks.toml", ".gitleaksignore"]);
    assert.equal(itemOf(plan, "trivy#iac").command.container.network, "bridge");
    assert.equal(itemOf(plan, "checkov#iac").command.container.network, "none");
    assert.ok(plan.network.items.includes("trivy#dependencies") && plan.network.items.includes("osv-scanner#dependencies"));
    assert.ok(itemOf(plan, "gitleaks#secrets").conditions.some((c) => c.includes("--redact=100")), "the plan says the redaction is fixed");
    assert.equal(p.calls().filter((c) => c[0] === "run").length, 0, "planning starts no container");
  } finally {
    p.cleanup();
  }
});

test("with the Gitleaks adapter on, the bridge's gitleaks subcheck is left out of the plan and the JSON says why", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = project();
  try {
    const plan = p.cli(["plan", "--cwd", p.dir, "--json"]).doc.plan;
    for (const [sub, cap, by] of [["gitleaks", "secrets", "gitleaks#secrets"], ["trivy", "dependencies", "trivy#dependencies"], ["trivy", "iac", "trivy#iac"], ["osv-scanner", "dependencies", "osv-scanner#dependencies"], ["checkov", "iac", "checkov#iac"]]) {
      const id = `quality-bridge.${sub}#${cap}`;
      assert.equal(plan.groups.willRun.find((i) => i.id === id), undefined, `${id} does not run`);
      const off = plan.groups.notApplicableOrDisabled.find((i) => i.id === id);
      assert.ok(off, id);
      assert.equal(off.reason.code, "SUPERSEDED", id);
      assert.ok(off.reason.message.includes(by), off.reason.message);
      assert.equal(off.state.enabled, false);
    }
    const bridge = plan.invocations.find((i) => i.adapter === "quality-bridge");
    for (const sub of ["gitleaks", "trivy", "osv-scanner", "checkov"]) {
      assert.ok(!bridge || !bridge.subchecks.includes(sub), `the bridge does not invoke ${sub}`);
      assert.ok(!bridge || !bridge.command.stdin.subchecks.includes(sub), `the bridge request leaves ${sub} out`);
    }
    assert.ok(!plan.warnings.some((w) => w.code === "SCANNER_RUNS_TWICE"), JSON.stringify(plan.warnings));
    assert.equal(plan.selection.reduced, false, "a replaced subcheck does not reduce the run");
  } finally {
    p.cleanup();
  }
});

test("a Trivy instance with only dependencies leaves Trivy's iac in the bridge, and the plan says the tool runs twice", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = project({ tools: "schemaVersion: 1\ntools:\n  trivy:\n    adapter: trivy\n    capabilities: [dependencies]\n" });
  try {
    const plan = p.cli(["plan", "--cwd", p.dir, "--json"]).doc.plan;
    assert.equal(itemOf(plan, "quality-bridge.trivy#dependencies").reason.code, "SUPERSEDED");
    assert.ok(plan.groups.willRun.some((i) => i.id === "quality-bridge.trivy#iac"));
    const warning = plan.warnings.find((w) => w.code === "SCANNER_RUNS_TWICE");
    assert.ok(warning, JSON.stringify(plan.warnings));
    assert.match(warning.message, /trivy/);
  } finally {
    p.cleanup();
  }
});

test("Gitleaks runs in the container and its finding comes out with the masked value [proves: gitleaks#secrets]", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = project();
  try {
    p.runtime({ FAKE_REPORT: fixture("gitleaks", "8.30.1", "dir-leak.json"), FAKE_EXIT: "3", FAKE_STDERR: "WRN leaks found: 1\n" });
    const ran = p.cli(["run", "--cwd", p.dir, "--only", "tool:gitleaks", "--no-interactive", "--json"]);
    const result = ran.doc;
    assert.ok(result, ran.out + ran.err);
    assert.ok(validateResult(result), JSON.stringify(validateResult.errors));
    const stage = stageOf(result, "gitleaks#secrets");
    assert.equal(stage.state, "completed", JSON.stringify(stage));
    assert.equal(stage.nativeStatus, "exit 3");
    const findings = result.findings.filter((f) => f.tool === "gitleaks");
    assert.deepEqual(findings.map((f) => [f.ruleId, f.location.path, f.location.line, f.normalizedSeverity, f.evidence]), [["github-pat", "settings.py", 1, "critical", "REDACTED"]]);
    assert.equal(result.decision, "failed");
    const call = p.calls().find((c) => c[0] === "run");
    assert.ok(call.includes("--read-only") && call.includes("none"), "read-only root, no network");
    assert.ok(call.includes("--redact=100"));
    assert.ok(call.some((a) => a === `type=bind,src=${p.dir},dst=/workspace,readonly` || a.endsWith(",dst=/workspace,readonly")));
    assert.ok(result.artifacts.logs.includes("logs/gitleaks.stdout.log"));
    assert.match(fs.readFileSync(path.join(result.runDir, "logs", "gitleaks.stderr.log"), "utf8"), /leaks found/);
  } finally {
    p.cleanup();
  }
});

test("Trivy and OSV-Scanner record the source and the date of the vulnerability database in the result", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = project();
  try {
    p.runtime({
      FAKE_REPORT: fixture("trivy", "0.72.0", "fs-report.json"),
      FAKE_DB_META: fixture("trivy", "0.72.0", "db-metadata.json"),
      FAKE_STDERR: '2026-10-25T21:14:51Z\tINFO\t[vulndb] Artifact successfully downloaded\trepo="mirror.gcr.io/aquasec/trivy-db:2"\n',
    });
    const ran = p.cli(["run", "--cwd", p.dir, "--only", "tool:trivy", "--no-interactive", "--json"]);
    const result = ran.doc;
    assert.ok(result, ran.out + ran.err);
    assert.ok(validateResult(result), JSON.stringify(validateResult.errors));
    const deps = stageOf(result, "trivy#dependencies");
    assert.equal(deps.state, "completed", JSON.stringify(deps));
    assert.match(deps.reason, /mirror\.gcr\.io\/aquasec\/trivy-db:2/);
    assert.match(deps.reason, /2026-10-25T19:10:35/);
    // The stage itself carries the database it read (result.json, $defs.stage.analysisInput).
    for (const id of ["trivy#dependencies", "trivy#iac"]) {
      const db = stageOf(result, id).analysisInput?.database;
      assert.ok(db, `${id}: ${JSON.stringify(stageOf(result, id))}`);
      assert.deepEqual({ source: db.source, updatedAt: db.updatedAt, reported: db.reported, networkRequired: db.networkRequired }, { source: "mirror.gcr.io/aquasec/trivy-db:2", updatedAt: "2026-10-25T19:10:35.479132794Z", reported: true, networkRequired: true }, id);
    }
    assert.equal(deps.findings, 2);
    assert.equal(stageOf(result, "trivy#iac").findings, 2);
    // The recorded report also has a secret, a capability this instance does not run: left out, and said so.
    assert.match(deps.reason, /1 achado\(s\) de uma capacidade que o plano não pediu/);
    assert.equal(result.findings.filter((f) => f.tool === "trivy" && f.ruleId === "github-pat").length, 0);
    const out = path.join(result.runDir, "outputs", "trivy", "trivy");
    const facts = JSON.parse(fs.readFileSync(path.join(out, "analysis-input.json"), "utf8"));
    assert.deepEqual(
      { source: facts.database.source, updatedAt: facts.database.updatedAt, reported: facts.database.reported },
      { source: "mirror.gcr.io/aquasec/trivy-db:2", updatedAt: "2026-10-25T19:10:35.479132794Z", reported: true },
    );
    assert.ok(!fs.existsSync(path.join(out, "cache", "db", "trivy.db")), "the database file does not stay in the run folder");
    assert.ok(fs.existsSync(path.join(out, "cache", "db", "metadata.json")), "its metadata does");

    p.runtime({ FAKE_REPORT: fixture("osv-scanner", "2.4.0", "source-vulns.json"), FAKE_EXIT: "1" });
    const osv = p.cli(["run", "--cwd", p.dir, "--only", "tool:osv-scanner", "--no-interactive", "--json"]).doc;
    assert.ok(validateResult(osv), JSON.stringify(validateResult.errors));
    const stage = stageOf(osv, "osv-scanner#dependencies");
    assert.equal(stage.state, "completed", JSON.stringify(stage));
    assert.equal(stage.findings, 3);
    assert.match(stage.reason, /api\.osv\.dev/);
    assert.match(stage.reason, /não informa a data/);
    assert.deepEqual(stage.analysisInput, { database: { source: "https://api.osv.dev", updatedAt: null, reported: false, networkRequired: true } });
    const osvFacts = JSON.parse(fs.readFileSync(path.join(osv.runDir, "outputs", "osv-scanner", "osv-scanner", "analysis-input.json"), "utf8"));
    assert.deepEqual(osvFacts.database, { source: "https://api.osv.dev", updatedAt: null, reported: false, networkRequired: true });
  } finally {
    p.cleanup();
  }
});

test("Checkov reads its results_json.json from the output mount", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = project();
  try {
    p.runtime({ FAKE_REPORT: fixture("checkov", "3.3.8", "terraform-failed.json"), FAKE_REPORT_NAME: "results_json.json", FAKE_EXIT: "1" });
    const result = p.cli(["run", "--cwd", p.dir, "--only", "tool:checkov", "--no-interactive", "--json"]).doc;
    assert.ok(validateResult(result), JSON.stringify(validateResult.errors));
    const stage = stageOf(result, "checkov#iac");
    assert.equal(stage.state, "completed", JSON.stringify(stage));
    assert.deepEqual(result.findings.filter((f) => f.tool === "checkov").map((f) => f.ruleId), ["CKV_AWS_144", "CKV_AWS_20", "CKV2_AWS_61"]);
  } finally {
    p.cleanup();
  }
});

test("a cut report, a report of another version, a missing report or an error exit is an error in the stage, never zero findings", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = project();
  const scratch = tmp("jgates-sec-bad-");
  try {
    const newer = path.join(scratch, "trivy-1.2.json");
    fs.writeFileSync(newer, JSON.stringify({ ...JSON.parse(read("trivy", "0.72.0", "fs-report.json")), Trivy: { Version: "1.2.0" } }));
    const scenarios = [
      ["tool:gitleaks", "gitleaks#secrets", { FAKE_REPORT: fixture("gitleaks", "8.30.1", "dir-leak.json"), FAKE_REPORT_BYTES: "60", FAKE_EXIT: "3" }, /não pôde ser interpretado/],
      ["tool:trivy", "trivy#dependencies", { FAKE_REPORT: newer }, /1\.2\.0/],
      ["tool:osv-scanner", "osv-scanner#dependencies", { FAKE_EXIT: "1" }, /não deixou o relatório/],
      ["tool:checkov", "checkov#iac", { FAKE_REPORT: fixture("checkov", "3.3.8", "empty.json"), FAKE_REPORT_NAME: "results_json.json", FAKE_EXIT: "2", FAKE_STDERR: "Traceback: boom\n" }, /código 2/],
    ];
    for (const [only, id, vars, reason] of scenarios) {
      p.runtime(vars);
      const result = p.cli(["run", "--cwd", p.dir, "--only", only, "--no-interactive", "--json"]).doc;
      assert.ok(result && validateResult(result), `${id}: ${JSON.stringify(validateResult.errors)}`);
      const stage = stageOf(result, id);
      assert.equal(stage.state, "error", `${id}: ${JSON.stringify(stage)}`);
      assert.equal(stage.interpreted, false, id);
      assert.match(stage.reason, reason, id);
      assert.notEqual(result.decision, "passed", id);
      assert.equal(result.findings.filter((f) => f.stageId === id).length, 0, id);
    }
    // An image whose label says a version outside the manifest's range is never pinned (prepare refuses it), and a
    // pinned image that now says another version never runs (blocked, not passed).
    p.runtime({ FAKE_LABELS: JSON.stringify({ "org.jgates.tool.gitleaks.version": "9.1.0" }) });
    const refused = p.cli(["tools", "prepare", "--cwd", p.dir, "--instance", "gitleaks", "--image", IMAGE, "--no-interactive", "--json"]);
    assert.equal(refused.code, 3, refused.out);
    assert.equal(refused.doc.error.code, "IMAGE_INCOMPATIBLE");
    assert.match(refused.doc.error.message, /9\.1\.0/);
    const blocked = p.cli(["run", "--cwd", p.dir, "--only", "tool:gitleaks", "--no-interactive", "--json"]).doc;
    assert.equal(stageOf(blocked, "gitleaks#secrets").state, "blocked");
    assert.match(stageOf(blocked, "gitleaks#secrets").reason, /9\.1\.0/);
    assert.notEqual(blocked.decision, "passed");
    // The same version range check holds for a pinned version outside it (an adapter upgraded after the prepare).
    const lockFile = path.join(p.dir, ".jgates", "lock.json");
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    lock.tools.gitleaks.toolVersion = "9.1.0";
    fs.writeFileSync(lockFile, JSON.stringify(lock));
    const outOfRange = p.cli(["run", "--cwd", p.dir, "--only", "tool:gitleaks", "--no-interactive", "--json"]).doc;
    assert.equal(stageOf(outOfRange, "gitleaks#secrets").state, "blocked");
    assert.notEqual(outOfRange.decision, "passed");
  } finally {
    p.cleanup();
    rm(scratch);
  }
});

test("a bound document that does not exist blocks the plan instead of falling back to another one", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = project({ tools: "schemaVersion: 1\ntools:\n  gitleaks:\n    adapter: gitleaks\n    capabilities: [secrets]\n    config: missing.toml\n" });
  try {
    const planned = p.cli(["plan", "--cwd", p.dir, "--json"]);
    const plan = planned.doc.plan;
    assert.equal(plan.approvable, false);
    const item = itemOf(plan, "gitleaks#secrets");
    assert.equal(item.availability.status, "unavailable");
    assert.match(item.availability.reason, /missing\.toml/);
  } finally {
    p.cleanup();
  }
});

test("the bridge writes the sidecar's logs through the runner's stdoutFile/stderrFile, cut at JGATES_MAX_LOG_BYTES", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = project({ profile: "minimal", tools: "schemaVersion: 1\ntools: {}\n" });
  try {
    const cli = cliIn({ ...p.env, JGATES_MAX_LOG_BYTES: "300" });
    const ran = cli(["run", "--cwd", p.dir, "--only", "tool:quality-bridge.file-size", "--no-interactive", "--json"]);
    const result = ran.doc;
    assert.ok(result, ran.out + ran.err);
    assert.ok(validateResult(result), JSON.stringify(validateResult.errors));
    // The response is read from the in-memory capture: the file-size subcheck completed.
    assert.equal(stageOf(result, "quality-bridge.file-size")?.state, "completed", JSON.stringify(result.stages));
    const out = fs.readFileSync(path.join(result.runDir, "logs", "quality-bridge.stdout.log"), "utf8");
    const err = fs.readFileSync(path.join(result.runDir, "logs", "quality-bridge.stderr.log"), "utf8");
    assert.ok(out.includes(runner.TRUNCATION_MARKER), "the stdout log was cut on disk by the runner");
    assert.ok(Buffer.byteLength(out) < 600, `stdout log at the limit (${Buffer.byteLength(out)} bytes)`);
    assert.match(err, /^executable: /, "the runner's own header opens the stderr log");
    assert.match(err, /--- jgates ---\ninterpreter: /);
    assert.equal(fs.statSync(path.join(result.runDir, "logs", "quality-bridge.stdout.log")).mode & 0o077, 0, "private log");
  } finally {
    p.cleanup();
  }
});
