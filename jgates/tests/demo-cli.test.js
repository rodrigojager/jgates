import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Main demonstration through the CLI: on the main fixture, init, discover,
// plan and run fail with exactly the two planted findings (the domain imports the infrastructure; the API coverage is
// under the minimum), the correction passes against the NEW state (another input hash), a reduced run (--skip) leaves the
// configuration untouched, and in the end the fixture holds only the JGates configuration, with the runs in the home.
//
// Decision about the profile: the demonstration only requires steps that run locally (Ruff, Import Linter, pytest with
// coverage). The quality bridge (MegaLinter, scanners: container and network) and the JS tools are turned off in the
// fixture configuration itself (.jgates/tools.yml and the profile), and the file is declared there: a TypeScript project
// without an `eslint.config` would leave `eslint#lint` blocked, so the demonstration declares the choice in the
// configuration instead of adding a file to the fixture. Every other capability of the profile is explicitly off.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const MAIN = path.join(here, "..", "dist", "cli", "main.js");
const WIN = process.platform === "win32";
const VENV_BIN = path.join(repo, ".venv", WIN ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, WIN ? "python.exe" : "python");
const fixture = createRequire(import.meta.url)(path.join(repo, "tests", "fixtures", "jgates", "main-fixture.js"));

const CONFIG_FILES = ["jgates.yml", ".jgates/profiles.yml", ".jgates/tools.yml", ".jgates/policy.yml", ".jgates/architecture.yml"];

const JGATES_YML = `schemaVersion: 1
extends:
  - .jgates/profiles.yml
selection:
  profile: demo
templates:
  - id: base
    source: builtin:base
    activation: always
  - id: python
    source: builtin:python
    activation: detected
    match:
      languages:
        - python
  - id: python-pytest
    source: builtin:python-pytest
    activation: detected
    match:
      languages:
        - python
`;

// Only steps that run locally are required; the typescript template is not listed (no eslint.config in the fixture).
const PROFILES_YML = `schemaVersion: 1
profiles:
  demo:
    label: Demonstração local
    description: Lint, arquitetura, testes e cobertura do Python, tudo local e sem Docker.
    checks:
      capability:lint: { enabled: true }
      capability:architecture: { enabled: true }
      capability:unit: { enabled: true }
      capability:coverage: { enabled: true }
      capability:file-size: { enabled: false }
      capability:secrets: { enabled: false }
      capability:sast: { enabled: false }
      capability:dependencies: { enabled: false }
      capability:duplication: { enabled: false }
      capability:iac: { enabled: false }
      capability:pii: { enabled: false }
      tool:quality-bridge: { enabled: false }
      tool:builtin-pii: { enabled: false }
`;

const TOOLS_YML = `schemaVersion: 1
tools:
  ruff:
    adapter: ruff
    component: api
    capabilities: [lint]
  import-linter:
    adapter: import-linter
    component: api
    capabilities: [architecture]
  pytest:
    adapter: pytest
    component: api
    capabilities: [unit, coverage]
`;

const POLICY_YML = `schemaVersion: 1
rules:
  coverage.minimum:
    threshold: ${fixture.MIN_API_COVERAGE}
`;

const ARCHITECTURE_YML = `schemaVersion: 1
architecture:
  layers:
    - id: domain
      paths: ["api/src/shop_api/domain/**"]
    - id: infrastructure
      paths: ["api/src/shop_api/infrastructure/**"]
  rules:
    - id: domain-independent
      kind: forbidden-dependency
      from: domain
      to: [infrastructure]
      enabled: true
      severity: high
      blocking: true
      owner: generated
`;

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const git = (dir, args) => {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

function setup() {
  for (const tool of ["python", "ruff", "lint-imports"]) {
    const bin = tool === "python" ? PYTHON : path.join(VENV_BIN, WIN ? `${tool}.exe` : tool);
    assert.ok(fs.existsSync(bin), `${tool} is not in the repository .venv: run \`npm --prefix jgates run setup:dev-tools\``);
  }
  const probe = spawnSync(PYTHON, ["-c", "import pytest, pytest_cov"], { encoding: "utf8" });
  assert.equal(probe.status, 0, `pytest and pytest-cov are missing in the repository .venv: run \`npm --prefix jgates run setup:dev-tools\`\n${probe.stderr}`);
  const { dir } = fixture.createMainFixture();
  const home = tmp("jgates-demo-home-");
  const emptyBin = tmp("jgates-demo-bin-");
  // The default cache stays ON: the correction must change the input hash and so invalidate any reuse (checked below).
  const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, PATH: emptyBin, DOCKER_HOST: "tcp://127.0.0.1:1" };
  delete env.JGATES_NO_CACHE;
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: "", timeout: 300_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const cleanup = () => {
    fixture.removeFixture(dir);
    for (const d of [home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { dir, home, cli, cleanup };
}

const readConfig = (dir) => Object.fromEntries(CONFIG_FILES.map((f) => [f, fs.readFileSync(path.join(dir, f))]));

test("main demonstration: fail with the two findings, fix, pass on the new state, reduced run, clean tree", () => {
  const { dir, home, cli, cleanup } = setup();
  try {
    // init + discover: three components with their evidence.
    const init = cli(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]);
    assert.equal(init.code, 0, init.out + init.err);
    const found = cli(["discover", "--cwd", dir, "--json"]);
    assert.equal(found.code, 0, found.out + found.err);
    const comps = found.doc.classifications;
    assert.deepEqual(comps.map((c) => c.id).sort(), ["api", "libs-shared", "web"]);
    for (const c of comps) assert.ok(c.evidencePaths.length > 0, `${c.id} has evidence`);

    // The demonstration declares its own configuration (profile with only local steps).
    fs.writeFileSync(path.join(dir, "jgates.yml"), JGATES_YML);
    fs.writeFileSync(path.join(dir, ".jgates", "profiles.yml"), PROFILES_YML);
    fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), TOOLS_YML);
    fs.writeFileSync(path.join(dir, ".jgates", "policy.yml"), POLICY_YML);
    fs.writeFileSync(path.join(dir, ".jgates", "architecture.yml"), ARCHITECTURE_YML);
    const validate = cli(["config", "validate", "--cwd", dir, "--json"]);
    assert.equal(validate.code, 0, validate.out + validate.err);

    // plan: approvable, with the local steps only.
    const planned = cli(["plan", "--cwd", dir, "--json"]);
    assert.equal(planned.code, 0, planned.out + planned.err);
    const willRun = planned.doc.plan.groups.willRun.map((i) => i.id).sort();
    assert.deepEqual(willRun, ["import-linter#architecture", "pytest#coverage", "pytest#unit", "ruff#lint"]);

    // run 1: failed, exactly the two findings, exit 1.
    const first = cli(["run", "--cwd", dir, "--no-interactive", "--json"]);
    assert.equal(first.code, 1, first.out + first.err);
    assert.equal(first.doc.decision, "failed");
    const blocking = first.doc.findings.filter((f) => f.blocking !== false);
    assert.equal(first.doc.findings.length, 2, JSON.stringify(first.doc.findings.map((f) => [f.tool, f.ruleId])));
    assert.deepEqual(first.doc.findings.map((f) => f.tool).sort(), ["import-linter", "pytest"]);
    assert.equal(blocking.length, 2);
    const arch = first.doc.findings.find((f) => f.tool === "import-linter");
    assert.match(JSON.stringify(arch), /domain/);
    const cov = first.doc.findings.find((f) => f.tool === "pytest");
    assert.match(cov.ruleId, /coverage/);
    assert.ok(first.doc.analyzed.inputs.hash, "the run records the input hash");
    const firstHash = first.doc.analyzed.inputs.hash;

    // Correct the code (a new commit); the configuration stays out of the commit.
    fixture.fixMainFixture(dir);
    git(dir, ["rm", "-r", "-q", "--cached", "jgates.yml", ".jgates"]);
    git(dir, ["commit", "-q", "--amend", "--no-edit"]);
    assert.deepEqual(fixture.findDomainInfraImports(dir), []);

    // run 2: passed, exit 0, another input hash, and nothing reused from the failed run.
    const second = cli(["run", "--cwd", dir, "--no-interactive", "--json"]);
    assert.equal(second.code, 0, second.out + second.err);
    assert.equal(second.doc.decision, "passed");
    assert.equal(second.doc.findings.length, 0);
    assert.notEqual(second.doc.analyzed.inputs.hash, firstHash);
    assert.notEqual(second.doc.runId, first.doc.runId);
    for (const stage of second.doc.stages) assert.notEqual(stage.cache?.status, "reused", `${stage.id} was reused`);

    // reduced run: --skip capability:unit leaves every configuration file byte for byte.
    const before = readConfig(dir);
    const reduced = cli(["run", "--cwd", dir, "--no-interactive", "--skip", "capability:unit", "--json"]);
    assert.equal(reduced.doc?.reduced, true, reduced.out + reduced.err);
    assert.deepEqual(readConfig(dir), before);

    // the tree: only the JGates configuration shows in git status.
    const status = git(dir, ["status", "--porcelain", "--untracked-files=all"])
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3));
    assert.ok(status.length > 0);
    for (const f of status) assert.ok(f === "jgates.yml" || f.startsWith(".jgates/"), `unexpected entry in git status: ${f}`);

    // the runs live in the workspace folder of the temporary home.
    const wsDirs = fs.readdirSync(path.join(home, "workspaces"));
    assert.equal(wsDirs.length, 1);
    const runsDir = path.join(home, "workspaces", wsDirs[0], "runs");
    for (const doc of [first.doc, second.doc, reduced.doc]) {
      assert.ok(fs.existsSync(path.join(runsDir, doc.runId, "result.json")), `${doc.runId} is under ${runsDir}`);
    }
  } finally {
    cleanup();
  }
});
