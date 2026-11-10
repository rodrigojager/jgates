import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// cargo-test adapter: a Rust crate whose proptest property fails yields cargo-test.property-failed with the minimal
// failing input, an ordinary failing #[test] yields cargo-test.test-failed, and the clean twin yields nothing. The tests
// run with the real cargo of this machine. proptest is fetched ONCE into a temporary CARGO_HOME (the OS temp folder,
// removed when the file ends; nothing global is installed), and every run is offline against that cargo home. Each
// run uses a copy of the fixture in a temp folder, so the repository never gets a target/, Cargo.lock or
// proptest-regressions/ (asserted below on the fixtures themselves).

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FIXTURES = path.join(here, "fixtures", "cargo-test");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const cargoTest = await load("adapters", "cargo-test", "index.js");
const { imageJsonWithout } = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "setup", "image-json.mjs")).href);
const manifests = await load("adapters", "manifests.js");
const matrix = await load("core", "matrix", "index.js");

const probe = cargoTest.probeCargo(process.env);
// In-image mode (tests/setup/in-image.mjs): a tool on this machine's PATH (an absolute executable) stands for the image's.
const CARGO_REAL = probe.executable !== null && path.isAbsolute(probe.executable) && probe.version !== null;

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const cargoHome = tmp("jgates-ct-cargo-home-");
let fetched = null;
/** proptest, fetched once into the temporary CARGO_HOME (needs the network the first time). */
function fetchDependencies() {
  if (fetched !== null) return fetched;
  const dir = tmp("jgates-ct-fetch-");
  fs.cpSync(path.join(FIXTURES, "property-clean"), dir, { recursive: true });
  const r = spawnSync(probe.executable, ["fetch"], { cwd: dir, encoding: "utf8", timeout: 540_000, env: { ...process.env, CARGO_HOME: cargoHome } });
  fetched = r.status === 0 ? { ok: true } : { ok: false, detail: `${r.stderr}`.trim().split(/\r?\n/).slice(-3).join(" ") };
  return fetched;
}

const recorded = (name) => fs.readFileSync(path.join(FIXTURES, "recorded", name), "utf8");

/** A workspace copy of one fixture, initialized by the real CLI (the template comes in by the language). */
function setup(fixture, { env = {}, lock = true } = {}) {
  const dir = tmp("jgates-ct-ws-");
  const home = tmp("jgates-ct-home-");
  fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
  const runEnv = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", NO_COLOR: "1", JGATES_LOCALE: "en", CARGO_HOME: cargoHome, ...env };
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
  if (lock && CARGO_REAL) {
    // Resolve the lock file offline against the cargo home: the run itself is offline.
    const r = spawnSync(probe.executable, ["generate-lockfile", "--offline"], { cwd: dir, encoding: "utf8", timeout: 120_000, env: runEnv });
    assert.equal(r.status, 0, r.stderr);
  }
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const init = cli(["init", "--cwd", dir, "--profile", "standard", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  // These tests are about the whole suite (tests) and proptest: the instance asks for those two, without the coverage of
  // the template (cargo llvm-cov, proven in adapter-test-stacks.test.js).
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  cargo-test:\n    adapter: cargo-test\n    capabilities: [tests, properties]\n");
  return {
    dir,
    cli,
    plan: () => cli(["plan", "--cwd", dir, "--json"]),
    run: () => cli(["run", "--cwd", dir, "--only", "tool:cargo-test", "--no-interactive", "--json"]),
  };
}

const planItem = (planned, id) => [...planned.doc.plan.groups.willRun, ...planned.doc.plan.groups.notApplicableOrDisabled].find((i) => i.id === id);
const metric = (doc, id) => (doc.metrics ?? []).find((m) => m.id === id);
const mine = (doc) => doc.findings.filter((f) => f.tool === "cargo-test");

test("cargo-test fixtures are clean in the repository: no target/, Cargo.lock or proptest-regressions/ is written by a run", () => {
  for (const name of fs.readdirSync(FIXTURES)) {
    if (name === "recorded") continue;
    for (const leftover of ["target", "Cargo.lock", "proptest-regressions"]) {
      assert.equal(fs.existsSync(path.join(FIXTURES, name, leftover)), false, `${name}/${leftover}`);
    }
  }
});

test("cargo-test: a failing proptest property is cargo-test.property-failed with the minimal failing input and the clean twin none [proves: cargo-test#properties, cargo-test#properties@rust]", (t) => {
  if (!CARGO_REAL) {
    t.diagnostic(`cargo is not installed (${probe.detail}): the live run did not execute.`);
    return;
  }
  const deps = fetchDependencies();
  if (!deps.ok) {
    t.diagnostic(`proptest could not be fetched into the temporary CARGO_HOME (the network is needed once): ${deps.detail}`);
    return;
  }
  t.diagnostic(`cargo ${probe.version}; proptest fetched once into a temporary CARGO_HOME (${cargoHome}), runs offline`);
  const bad = setup("property-bad");
  const clean = setup("property-clean");

  const planned = bad.plan();
  assert.equal(planned.code, 0, planned.out + planned.err);
  const item = planItem(planned, "cargo-test#properties");
  assert.ok(item, "cargo-test#properties is in the plan of a Rust workspace (jgates init added rust-cargo-test)");
  assert.equal(item.adapter, "cargo-test");
  assert.equal(item.category, "tests");
  assert.equal(item.availability.status, "available", item.availability.reason ?? "");
  assert.equal(item.effects.executesProjectCode, true);
  assert.match(item.command.env.CARGO_TARGET_DIR, /^\{runDir\}\//, "build artifacts go to the run folder");
  assert.ok(planItem(planned, "cargo-test#tests"));

  const failed = bad.run();
  assert.equal(failed.doc.decision, "failed", failed.out + failed.err);
  const found = mine(failed.doc);
  const property = found.filter((f) => f.ruleId === "cargo-test.property-failed");
  assert.equal(property.length, 1, JSON.stringify(found));
  assert.match(property[0].message, /twice_the_half_never_exceeds_the_input/);
  assert.match(property[0].message, /minimal failing input: x = 100\)/);
  assert.equal(property[0].blocking, true);
  assert.equal(property[0].location.path, "src/lib.rs");
  assert.equal(found.filter((f) => f.ruleId === "cargo-test.test-failed").length, 0, "a property is not reported as an ordinary test");
  assert.ok(metric(failed.doc, "tests.property.failed").value >= 1);
  assert.equal(metric(failed.doc, "tests.property.failed").value, 1);
  assert.equal(metric(failed.doc, "tests.property.total").value, 2);
  const stage = failed.doc.stages.find((s) => s.id === "cargo-test#properties");
  assert.equal(stage.state, "completed", stage.reason);
  assert.equal(stage.blockingViolations, 1);
  // The project stays untouched: no build folder, no regression file next to the sources.
  assert.equal(fs.existsSync(path.join(bad.dir, "target")), false);
  assert.equal(fs.existsSync(path.join(bad.dir, "proptest-regressions")), false);
  assert.equal(fs.existsSync(path.join(bad.dir, "src", "lib.proptest-regressions")), false);

  const passed = clean.run();
  assert.equal(passed.doc.decision, "passed", passed.out + passed.err);
  assert.equal(mine(passed.doc).length, 0);
  assert.equal(metric(passed.doc, "tests.property.failed").value, 0);
  assert.equal(metric(passed.doc, "tests.property.total").value, 2);
  assert.equal(fs.existsSync(path.join(clean.dir, "target")), false);
});

test("cargo-test: an ordinary failing #[test] is cargo-test.test-failed, not a property failure, and a crate without proptest has no property metrics [proves: cargo-test#tests, cargo-test#tests@rust]", (t) => {
  if (!CARGO_REAL) {
    t.diagnostic(`cargo is not installed (${probe.detail}): the live run did not execute.`);
    return;
  }
  // A crate without proptest has no dependency to fetch.
  const plain = setup("plain-bad");
  const planned = plain.plan();
  assert.equal(planned.code, 0, planned.out + planned.err);
  const item = planItem(planned, "cargo-test#tests");
  assert.ok(item);
  assert.equal(item.availability.status, "available", item.availability.reason ?? "");
  const failed = plain.run();
  assert.equal(failed.doc.decision, "failed", failed.out + failed.err);
  const found = mine(failed.doc);
  assert.deepEqual(found.map((f) => f.ruleId), ["cargo-test.test-failed"]);
  assert.match(found[0].message, /halve_of_ten_is_five/);
  assert.equal(found[0].category, "tests");
  assert.equal(found[0].location.path, "src/lib.rs");
  assert.equal(typeof found[0].location.line, "number");
  assert.equal(metric(failed.doc, "tests.executed").value, 2);
  assert.equal(metric(failed.doc, "tests.failed").value, 1);
  assert.equal(metric(failed.doc, "tests.property.total"), undefined);
  assert.equal(metric(failed.doc, "tests.property.failed"), undefined);
  const testsStage = failed.doc.stages.find((s) => s.id === "cargo-test#tests");
  assert.equal(testsStage.state, "completed");
  assert.equal(testsStage.blockingViolations, 1);
  const propertiesStage = failed.doc.stages.find((s) => s.id === "cargo-test#properties");
  assert.equal(propertiesStage.state, "not_applicable", "no proptest: the properties stage is not applicable, never a pass by silence");

  const deps = fetchDependencies();
  if (!deps.ok) {
    t.diagnostic(`proptest could not be fetched: the mixed crate was not run (${deps.detail})`);
    return;
  }
  // A crate with proptest whose property holds but whose ordinary test fails: test-failed only, property metrics at 0 failures.
  const mixed = setup("mixed-bad");
  const result = mixed.run();
  assert.equal(result.doc.decision, "failed", result.out + result.err);
  assert.deepEqual(mine(result.doc).map((f) => f.ruleId), ["cargo-test.test-failed"]);
  assert.equal(metric(result.doc, "tests.property.failed").value, 0);
  assert.equal(metric(result.doc, "tests.property.total").value, 1);
});

test("cargo-test: with cargo absent from the tools image the stage is blocked with the image's cause, never passed", () => {
  const empty = tmp("jgates-ct-nopath-");
  const bad = setup("plain-bad", { env: { PATH: empty, Path: empty, JGATES_CARGO: "", JGATES_IMAGE_JSON: imageJsonWithout("cargo") }, lock: false });
  const planned = bad.plan();
  assert.equal(planned.code, 0, planned.out + planned.err);
  const item = planItem(planned, "cargo-test#tests");
  assert.ok(item);
  assert.equal(item.availability.status, "unavailable");
  assert.match(item.availability.reason, /jgates setup/);
  const blocked = bad.run();
  const stage = blocked.doc.stages.find((s) => s.id === "cargo-test#tests");
  assert.equal(stage.state, "blocked");
  assert.match(stage.reason, /jgates setup/);
  assert.notEqual(blocked.doc.decision, "passed");
  assert.equal(mine(blocked.doc).length, 0);
});

test("cargo-test recorded libtest output: failures, panic location and the proptest minimal input are read; anything else fails closed", () => {
  const report = cargoTest.parseLibtestOutput(recorded("libtest-property-failed.txt"));
  assert.equal(report.ok, true);
  assert.deepEqual(report.counts, { passed: 2, failed: 1, ignored: 0 });
  assert.equal(report.summaries, 2);
  assert.equal(report.failures.length, 1);
  const [failure] = report.failures;
  assert.equal(failure.name, "tests::twice_the_half_never_exceeds_the_input");
  assert.equal(failure.minimalInput, "x = 100");
  assert.equal(failure.line, 15);
  assert.match(failure.file, /lib\.rs$/);
  // No libtest summary: a compilation error proves nothing about the tests.
  const none = cargoTest.parseLibtestOutput("error[E0308]: mismatched types\n");
  assert.equal(none.ok, false);
  assert.match(none.problem, /summary/);
  // An ok binary and a failed one in the same output keep both results.
  const two = cargoTest.parseLibtestOutput("running 1 test\ntest a::x ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\nrunning 1 test\ntest b ... FAILED\n\nfailures:\n\n---- b stdout ----\nthread 'b' panicked at tests/b.rs:3:5:\nboom\n\nfailures:\n    b\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n");
  assert.equal(two.ok, true);
  assert.deepEqual(two.counts, { passed: 1, failed: 1, ignored: 0 });
  assert.equal(two.failures[0].message, "boom");
  assert.equal(two.failures[0].file, "tests/b.rs");
});

test("cargo-test static property detection: proptest! blocks and #[proptest] functions, not comments, strings or nested fns", () => {
  const fns = cargoTest.propertyFunctions;
  assert.deepEqual(fns("proptest! {\n #![proptest_config(ProptestConfig::with_cases(5))]\n #[test]\n fn a(x in 0..5) { prop_assert!(x < 9); fn nested() {} }\n #[test]\n fn b(s in \"[a-z]+\") { let _c = '}'; }\n}\nfn outside() {}"), ["a", "b"]);
  assert.deepEqual(fns("// proptest! { fn commented() {} }\nconst S: &str = \"proptest! { fn quoted() {} }\";\nfn ordinary() {}"), []);
  assert.deepEqual(fns("#[proptest]\nfn attr_style(#[strategy(0..9)] x: u32) {}\n#[test_strategy::proptest(cases = 4)]\n#[ignore]\nfn qualified(x: u8) {}\n#[test]\nfn plain() {}"), ["attr_style", "qualified"]);
  assert.equal(fns("fn main() {}").length, 0);
});

test("cargo-test: the manifest is customer-supplied with rows tests/unit/coverage/integration/properties on rust validated, and init adds rust-cargo-test", () => {
  const manifest = manifests.builtinManifests().find((m) => m.id === "cargo-test");
  assert.ok(manifest);
  assert.equal(manifest.distribution.mode, "customer-supplied");
  assert.ok(manifest.distribution.acquisition.length > 0 && manifest.distribution.setup.length > 0);
  assert.deepEqual(manifest.capabilities, ["tests", "unit", "coverage", "integration", "properties"]);
  assert.deepEqual(manifest.stackSupport.map((r) => `${r.capability}/${r.stack}/${r.state}`), ["tests/rust/validated", "unit/rust/validated", "coverage/rust/validated", "integration/rust/validated", "properties/rust/validated"]);
  assert.deepEqual(matrix.verifyMatrix(matrix.buildMatrix()).filter((p) => /cargo-test/.test(p)), []);

  const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...process.env, JGATES_HOME: tmp("jgates-ct-home-") }, timeout: 120_000 });
  const doc = JSON.parse(cli(["tools", "matrix", "--json"]).stdout);
  for (const key of ["cargo-test#tests@rust", "cargo-test#properties@rust"]) {
    const row = doc.matrix.rows.find((r) => r.key === key);
    assert.ok(row, key);
    assert.equal(row.state, "validated");
    assert.equal(row.distribution, "customer-supplied");
    assert.deepEqual(row.evidence.tests.map((x) => x.file), ["adapter-cargo-test.test.js"]);
  }
  const list = cli(["tools", "list", "--json"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /"cargo-test"/);

  const dir = tmp("jgates-ct-init-");
  fs.cpSync(path.join(FIXTURES, "plain-bad"), dir, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const init = cli(["init", "--cwd", dir, "--profile", "standard", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.match(fs.readFileSync(path.join(dir, "jgates.yml"), "utf8"), /builtin:rust-cargo-test/);
});
