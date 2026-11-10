import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Stack extensions: govulncheck (Go dependency vulnerabilities) and cargo-audit (RustSec advisories), both
// customer-supplied binaries. Each is proven on a known-bad and a clean twin fixture (tests/fixtures/stack-extensions):
// the bad Go module calls yaml.v2 2.2.2 (GO-2020-0036 and others), its twin uses 2.4.0; the bad crate locks time 0.1.43
// (RUSTSEC-2020-0071), its twin time 0.3.47. The real tool runs through the real CLI plan and run when it is installed
// (PATH, JGATES_GOVULNCHECK / JGATES_CARGO_AUDIT, or where go install / cargo install put it); otherwise the test says so
// and asserts the customer-setup-required behaviour (unavailable, with the way to get the tool, stage blocked) while the
// parsers read the recorded real output of govulncheck 1.9.0 and cargo-audit 0.22.2. The live runs need the network
// (the Go vulnerability database, the RustSec advisory database, the modules of the Go fixture).

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FIXTURES = path.join(here, "fixtures", "stack-extensions");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const govulncheck = await load("adapters", "govulncheck", "index.js");
const cargoAudit = await load("adapters", "cargo-audit", "index.js");
const manifests = await load("adapters", "manifests.js");
const matrix = await load("core", "matrix", "index.js");

const goProbe = govulncheck.probeGovulncheck(process.env);
// In-image mode (tests/setup/in-image.mjs): a tool on this machine's PATH (an absolute executable) stands for the image's.
const GO_REAL = goProbe.executable !== null && path.isAbsolute(goProbe.executable) && goProbe.version !== null && goProbe.go !== null && path.isAbsolute(goProbe.go);
const cargoProbe = cargoAudit.probeCargoAudit(process.env);
const CARGO_REAL = cargoProbe.executable !== null && path.isAbsolute(cargoProbe.executable) && cargoProbe.version !== null;

const recorded = (name) => fs.readFileSync(path.join(FIXTURES, "recorded", name), "utf8");

/** A workspace copy of one fixture, initialized by the real CLI (the template comes in by the language). */
function setup(fixture, { env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-stack-ws-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-stack-home-"));
  fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
  const runEnv = {
    ...process.env,
    JGATES_HOME: home,
    JGATES_NO_CACHE: "1",
    NO_COLOR: "1",
    JGATES_GOVULNCHECK: GO_REAL ? goProbe.executable : path.join(home, "no-govulncheck"),
    JGATES_CARGO_AUDIT: CARGO_REAL ? cargoProbe.executable : path.join(home, "no-cargo-audit"),
    ...env,
  };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: runEnv, input: "", timeout: 540_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const init = cli(["init", "--cwd", dir, "--profile", "standard", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  return {
    dir,
    home,
    cli,
    plan: () => cli(["plan", "--cwd", dir, "--json"]),
    run: (tool) => cli(["run", "--cwd", dir, "--only", `tool:${tool}`, "--no-interactive", "--json"]),
    cleanup: () => [dir, home].forEach((d) => fs.rmSync(d, { recursive: true, force: true })),
  };
}

const planItem = (planned, id) => [...planned.doc.plan.groups.willRun, ...planned.doc.plan.groups.notApplicableOrDisabled].find((i) => i.id === id);

const goOpts = { stageId: "govulncheck#dependencies", version: "1.9.0", root: "." };
const rustOpts = { stageId: "cargo-audit#dependencies", version: "0.22.2", root: "." };

test("govulncheck: a vulnerable yaml.v2 the code calls is a normalized finding and the patched twin none [proves: govulncheck#dependencies]", (t) => {
  if (!GO_REAL) t.diagnostic(`govulncheck (or Go) is not installed (${goProbe.detail}): the live scan did not run; customer-setup-required is asserted and the recorded govulncheck 1.9.0 output is parsed. It is in the tools image; put govulncheck and Go on the PATH to run it here.`);
  const bad = setup("go-bad");
  const clean = setup("go-clean");
  try {
    // The template comes in by the language; the tool is in the plan of both modules.
    const planned = bad.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = planItem(planned, "govulncheck#dependencies");
    assert.ok(item, "govulncheck#dependencies is in the plan of a Go module");
    assert.equal(item.adapter, "govulncheck");
    assert.equal(item.category, "dependencies");
    assert.deepEqual(item.command.args, ["-format", "json", "./..."]);
    assert.equal(item.network, true);
    if (!GO_REAL) {
      assert.equal(item.availability.status, "unavailable");
      assert.match(item.availability.reason, /jgates setup/);
      const blocked = bad.run("govulncheck");
      const stage = blocked.doc.stages.find((s) => s.id === "govulncheck#dependencies");
      assert.equal(stage.state, "blocked");
      assert.notEqual(blocked.doc.decision, "passed");
      assert.equal(blocked.doc.findings.filter((f) => f.tool === "govulncheck").length, 0);
      return;
    }
    assert.equal(item.availability.status, "available");
    const failed = bad.run("govulncheck");
    assert.equal(failed.doc.decision, "failed", failed.out + failed.err);
    const found = failed.doc.findings.filter((f) => f.tool === "govulncheck");
    assert.ok(found.length >= 1, "the reachable yaml.v2 vulnerability is a finding");
    const yaml = found.find((f) => f.ruleId === "GO-2020-0036");
    assert.ok(yaml, `GO-2020-0036 is among: ${found.map((f) => f.ruleId).join(", ")}`);
    assert.equal(yaml.category, "dependencies");
    assert.equal(yaml.blocking, true);
    assert.equal(yaml.location.path, "main.go");
    assert.equal(yaml.location.line, 11);
    assert.match(yaml.message, /gopkg\.in\/yaml\.v2 v2\.2\.2/);
    assert.match(yaml.message, /Unmarshal/);
    const stage = failed.doc.stages.find((s) => s.id === "govulncheck#dependencies");
    assert.equal(stage.state, "completed");
    assert.equal(stage.interpreted, true);

    const passed = clean.run("govulncheck");
    assert.equal(passed.doc.decision, "passed", passed.out + passed.err);
    assert.equal(passed.doc.findings.filter((f) => f.tool === "govulncheck").length, 0);
    assert.equal(passed.doc.stages.find((s) => s.id === "govulncheck#dependencies").state, "completed");
  } finally {
    bad.cleanup();
    clean.cleanup();
  }
});

test("govulncheck recorded output (1.9.0): called vulnerabilities are findings, uncalled ones only counted, anything else fails closed", () => {
  const bad = govulncheck.parseGovulncheckOutput(recorded("govulncheck-go-bad.json"), goOpts);
  assert.equal(bad.ok, true, bad.problem);
  assert.deepEqual(bad.findings.map((f) => f.ruleId).sort(), ["GO-2020-0036", "GO-2021-0061", "GO-2022-0956"]);
  const [first] = bad.findings.filter((f) => f.ruleId === "GO-2020-0036");
  assert.equal(first.tool, "govulncheck");
  assert.equal(first.blocking, true);
  assert.equal(first.normalizedSeverity, "unknown");
  assert.deepEqual(first.location, { path: "main.go", line: 11, column: 26 });
  assert.match(first.message, /Excessive resource consumption in YAML parsing/);
  assert.match(first.message, /fixed in v2\.2\.8/);
  assert.equal(first.docsUrl, "https://pkg.go.dev/vuln/GO-2020-0036");
  // The package-level record of the bad module is not a finding.
  assert.equal(bad.notCalled, 1);
  // The twin records module-level and package-level vulnerabilities in code the program never calls: none is a finding.
  const clean = govulncheck.parseGovulncheckOutput(recorded("govulncheck-go-clean.json"), goOpts);
  assert.equal(clean.ok, true, clean.problem);
  assert.deepEqual(clean.findings, []);
  assert.ok(clean.notCalled >= 1);
  // A component root prefixes the location.
  assert.equal(govulncheck.parseGovulncheckOutput(recorded("govulncheck-go-bad.json"), { ...goOpts, root: "svc/api" }).findings[0].location.path, "svc/api/main.go");
  // Fail-closed: not a stream, no config message, a finding without its OSV entry or without a module proves nothing.
  const good = recorded("govulncheck-go-bad.json");
  for (const broken of ["", "not json", "[]", '{"progress":{"message":"x"}}', '{"config":{"scanner_name":"other"}}', good.slice(0, good.length - 40)]) {
    assert.equal(govulncheck.parseGovulncheckOutput(broken, goOpts).ok, false, `accepted: ${broken.slice(0, 40)}`);
  }
  const config = '{"config":{"scanner_name":"govulncheck","scanner_version":"v1.9.0"}}\n';
  assert.equal(govulncheck.parseGovulncheckOutput(`${config}{"finding":{"osv":"GO-X","trace":[{"module":"m","function":"F"}]}}`, goOpts).ok, false);
  assert.equal(govulncheck.parseGovulncheckOutput(`${config}{"finding":{"osv":"GO-X","trace":[]}}`, goOpts).ok, false);
  assert.equal(govulncheck.parseGovulncheckOutput(config, goOpts).ok, true);
});

test("cargo-audit: a RustSec-advised crate in Cargo.lock is a normalized finding and the clean twin none [proves: cargo-audit#dependencies]", (t) => {
  if (!CARGO_REAL) t.diagnostic(`cargo-audit is not installed (${cargoProbe.detail}): the live audit did not run; customer-setup-required is asserted and the recorded cargo-audit 0.22.2 output is parsed. It is in the tools image; put cargo-audit on the PATH to run it here.`);
  const bad = setup("rust-bad");
  const clean = setup("rust-clean");
  try {
    const planned = bad.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = planItem(planned, "cargo-audit#dependencies");
    assert.ok(item, "cargo-audit#dependencies is in the plan of a Rust workspace");
    assert.equal(item.adapter, "cargo-audit");
    assert.equal(item.category, "dependencies");
    assert.equal(item.command.args[0], "audit");
    assert.ok(item.command.args.includes("--json"));
    assert.equal(item.network, true);
    if (!CARGO_REAL) {
      assert.equal(item.availability.status, "unavailable");
      assert.match(item.availability.reason, /jgates setup/);
      const blocked = bad.run("cargo-audit");
      assert.equal(blocked.doc.stages.find((s) => s.id === "cargo-audit#dependencies").state, "blocked");
      assert.notEqual(blocked.doc.decision, "passed");
      return;
    }
    assert.equal(item.availability.status, "available");
    const failed = bad.run("cargo-audit");
    assert.equal(failed.doc.decision, "failed", failed.out + failed.err);
    const found = failed.doc.findings.filter((f) => f.tool === "cargo-audit");
    const time = found.find((f) => f.ruleId === "RUSTSEC-2020-0071");
    assert.ok(time, `RUSTSEC-2020-0071 is among: ${found.map((f) => f.ruleId).join(", ")}`);
    assert.equal(time.category, "dependencies");
    assert.equal(time.blocking, true);
    assert.equal(time.location.path, "Cargo.lock");
    assert.match(time.message, /time 0\.1\.43/);
    assert.match(time.message, /patched in >=0\.2\.23/);
    const stage = failed.doc.stages.find((s) => s.id === "cargo-audit#dependencies");
    assert.equal(stage.state, "completed");
    assert.equal(stage.interpreted, true);

    const passed = clean.run("cargo-audit");
    assert.equal(passed.doc.decision, "passed", passed.out + passed.err);
    assert.equal(passed.doc.findings.filter((f) => f.tool === "cargo-audit").length, 0);
    // The advisory database lives in the run folder, never in the workspace.
    assert.equal(fs.existsSync(path.join(clean.dir, "advisory-db")), false);
  } finally {
    bad.cleanup();
    clean.cleanup();
  }
});

test("cargo-audit recorded output (0.22.2): vulnerabilities block, warnings never do, anything else fails closed", () => {
  const bad = cargoAudit.parseCargoAuditOutput(recorded("cargo-audit-rust-bad.json"), rustOpts);
  assert.equal(bad.ok, true, bad.problem);
  assert.equal(bad.findings.length, 1);
  const [finding] = bad.findings;
  assert.equal(finding.tool, "cargo-audit");
  assert.equal(finding.ruleId, "RUSTSEC-2020-0071");
  assert.equal(finding.blocking, true);
  assert.equal(finding.location.path, "Cargo.lock");
  assert.match(finding.message, /Potential segfault in the time crate \(time 0\.1\.43; patched in >=0\.2\.23; CVE-2020-26235, GHSA-wcg3-cvx6-7396\)/);
  assert.equal(finding.docsUrl, "https://github.com/time-rs/time/issues/293");
  assert.equal(bad.dependencyCount, 6);
  const clean = cargoAudit.parseCargoAuditOutput(recorded("cargo-audit-rust-clean.json"), rustOpts);
  assert.equal(clean.ok, true, clean.problem);
  assert.deepEqual(clean.findings, []);
  assert.equal(cargoAudit.parseCargoAuditOutput(recorded("cargo-audit-rust-bad.json"), { ...rustOpts, root: "crates/app" }).findings[0].location.path, "crates/app/Cargo.lock");
  // Warnings (unmaintained, unsound) are findings that do not block.
  const withWarnings = JSON.parse(recorded("cargo-audit-rust-clean.json"));
  withWarnings.warnings = {
    unmaintained: [{ kind: "unmaintained", package: { name: "atty", version: "0.2.14" }, advisory: { id: "RUSTSEC-2024-0375", title: "`atty` is unmaintained", url: "https://github.com/softprops/atty/issues/57" }, versions: { patched: [], unaffected: [] } }],
    yanked: [{ kind: "yanked", package: { name: "old", version: "1.0.0" }, advisory: null, versions: null }],
  };
  const warned = cargoAudit.parseCargoAuditOutput(JSON.stringify(withWarnings), rustOpts);
  assert.equal(warned.ok, true, warned.problem);
  assert.equal(warned.warnings, 2);
  assert.ok(warned.findings.every((f) => f.blocking === false));
  // Fail-closed: not the audit document, or a flag that contradicts the list.
  const doc = JSON.parse(recorded("cargo-audit-rust-bad.json"));
  const mismatch = { ...doc, vulnerabilities: { ...doc.vulnerabilities, found: false } };
  const noPackage = { ...doc, vulnerabilities: { found: true, count: 1, list: [{ advisory: doc.vulnerabilities.list[0].advisory }] } };
  for (const broken of ["", "not json", "[]", "{}", '{"database":{},"lockfile":{},"vulnerabilities":{}}', JSON.stringify(mismatch), JSON.stringify(noPackage)]) {
    assert.equal(cargoAudit.parseCargoAuditOutput(broken, rustOpts).ok, false, `accepted: ${broken.slice(0, 40)}`);
  }
});

test("stack extensions: the matrix rows of Go and Rust state validated vs customer-setup-required, and the distribution is customer-supplied", () => {
  const all = manifests.builtinManifests();
  const go = all.find((m) => m.id === "govulncheck");
  const rust = all.find((m) => m.id === "cargo-audit");
  for (const m of [go, rust]) {
    assert.equal(m.distribution.mode, "customer-supplied");
    assert.ok(m.distribution.acquisition.length > 0 && m.distribution.setup.length > 0);
    assert.deepEqual(m.capabilities, ["dependencies"]);
  }
  assert.deepEqual(go.stackSupport.map((r) => `${r.capability}/${r.stack}/${r.state}`), ["dependencies/go/validated"]);
  assert.deepEqual(rust.stackSupport.map((r) => `${r.capability}/${r.stack}/${r.state}`), ["dependencies/rust/validated"]);
  assert.ok(go.stackSupport[0].prerequisites.some((p) => /customer-supplied/.test(p)));
  assert.ok(rust.stackSupport[0].prerequisites.some((p) => /customer-supplied/.test(p)));
  // verifyMatrix checks the cited tests of this file exist and carry the proves tag.
  const problems = matrix.verifyMatrix(matrix.buildMatrix());
  assert.deepEqual(problems.filter((p) => /govulncheck|cargo-audit/.test(p)), []);
});
