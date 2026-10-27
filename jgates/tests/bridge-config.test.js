// The configuration files chosen in .jgates/tools.yml reach the bridge scanners (local mode only): the plan
// carries them in the bridge request and shows the effective command; the request names the subchecks to run; the
// sidecar answers with the command it really ran. Also the default access of a binding.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const require = createRequire(import.meta.url);
const mainFixture = require("../../tests/fixtures/jgates/main-fixture.js");
const bridgeApi = await import(pathToFileURL(path.join(dist, "core", "bridge", "index.js")).href);
const toolsApi = await import(pathToFileURL(path.join(dist, "core", "tools", "index.js")).href);
const documentsApi = await import(pathToFileURL(path.join(dist, "core", "documents", "index.js")).href);
const planApi = await import(pathToFileURL(path.join(dist, "core", "plan", "index.js")).href);

const VENV_PYTHON = path.resolve(here, "..", "..", ".venv", "bin", process.platform === "win32" ? "python.exe" : "python");

function requirePython() {
  assert.ok(fs.existsSync(VENV_PYTHON), `the repository .venv is required: python3 -m venv .venv && .venv/bin/pip install -e quality-gate (looked for ${VENV_PYTHON})`);
  return VENV_PYTHON;
}

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function cli(home, args) {
  const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...process.env, JGATES_HOME: home, JGATES_PYTHON: requirePython() } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function json(r) {
  try {
    return JSON.parse(r.out);
  } catch (error) {
    throw new Error(`stdout is not one JSON document (${error.message}):\n${r.out}\n${r.err}`);
  }
}

const TOOLS_YML = (bindings) =>
  [
    "schemaVersion: 1",
    "tools:",
    "  quality-bridge:",
    "    adapter: quality-bridge",
    "    configFiles:",
    ...Object.entries(bindings).flatMap(([id, spec]) => [`      ${id}:`, ...Object.entries(spec).map(([k, v]) => `        ${k}: ${v}`)]),
    "",
  ].join("\n");

/** The main fixture after `jgates init`, with scanner configs in the workspace and the given bridge bindings. */
async function withProject(bindings, fn) {
  const { dir } = mainFixture.createMainFixture();
  const home = tmp("jgates-bridge-config-home-");
  try {
    const init = cli(home, ["init", "--cwd", dir, "--profile", "standard", "--no-interactive", "--json"]);
    assert.equal(init.code, 0, init.out + init.err);
    fs.writeFileSync(path.join(dir, ".gitleaks.toml"), 'title = "project rules"\n');
    fs.writeFileSync(path.join(dir, "trivy.yaml"), "severity:\n  - HIGH\n");
    fs.writeFileSync(path.join(dir, "osv-scanner.toml"), '[[IgnoredVulns]]\nid = "GHSA-0000-0000-0000"\n');
    if (bindings) fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), TOOLS_YML(bindings));
    return await fn({ dir, home, plan: (...args) => cli(home, ["plan", "--cwd", dir, ...args]) });
  } finally {
    mainFixture.removeFixture(dir);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const allItems = (p) => [...p.groups.willRun, ...p.groups.notApplicableOrDisabled];
const item = (p, id) => allItems(p).find((i) => i.id === id);
const bridgeInvocation = (p) => p.invocations.find((i) => i.adapter === "quality-bridge");
const flag = (args, name) => args[args.indexOf(name) + 1];

test("the plan carries the chosen .gitleaks.toml to the bridge request and shows the effective command", async () => {
  await withProject({ gitleaks: { path: ".gitleaks.toml" } }, ({ plan }) => {
    const r = plan("--json");
    assert.equal(r.code, 0, r.out + r.err);
    const p = json(r).plan;
    assert.deepEqual(planApi.validatePlanDocument(p), []);
    const stdin = bridgeInvocation(p).command.stdin;
    assert.deepEqual(stdin.toolConfigs, { gitleaks: ".gitleaks.toml" });
    assert.ok(stdin.subchecks.includes("gitleaks"));
    const gitleaks = item(p, "quality-bridge.gitleaks#secrets");
    assert.ok(p.groups.willRun.some((i) => i.id === gitleaks.id), "gitleaks runs in the standard profile");
    const effective = gitleaks.bridge.effectiveCommand;
    assert.equal(effective.executable, "gitleaks");
    assert.equal(flag(effective.args, "--config"), ".gitleaks.toml");
    assert.deepEqual(effective.config, { source: "project", file: ".gitleaks.toml" });
    // Redaction and the refusal of inline allows are never switched off by a chosen file.
    assert.ok(effective.args.includes("--redact=100") && effective.args.includes("--ignore-gitleaks-allow"));
    // The chosen file is an input of the plan (its hash makes an edited file a stale plan).
    const ref = gitleaks.configFiles.find((f) => f.file === ".gitleaks.toml");
    assert.match(ref?.sha256 ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.ok(p.inputs.configFiles.some((f) => f.file === ".gitleaks.toml"));
    // Scanners without a binding keep the package file.
    const trivy = item(p, "quality-bridge.trivy#dependencies").bridge.effectiveCommand;
    assert.deepEqual(trivy.config, { source: "package", file: "trivy-ci.yaml" });
    assert.equal(flag(trivy.args, "--config"), "{sidecarConfig}/trivy-ci.yaml");

    const text = plan();
    assert.equal(text.code, 0, text.out + text.err);
    assert.match(text.out, /comando efetivo: gitleaks .*--config \.gitleaks\.toml .*\(configuração: \.gitleaks\.toml, do projeto\)/);
  });
});

test("without a chosen configuration the effective command uses the package file and the request carries none", async () => {
  await withProject(null, ({ plan }) => {
    const p = json(plan("--json")).plan;
    const stdin = bridgeInvocation(p).command.stdin;
    assert.equal(stdin.toolConfigs, undefined);
    const effective = item(p, "quality-bridge.gitleaks#secrets").bridge.effectiveCommand;
    assert.deepEqual(effective.config, { source: "package", file: "gitleaks-ci.toml" });
    assert.equal(flag(effective.args, "--config"), "{sidecarConfig}/gitleaks-ci.toml");
  });
});

test("a bound configuration outside the workspace or missing blocks the plan with the binding", async () => {
  await withProject({ gitleaks: { path: "../outside-gitleaks.toml" }, trivy: { path: "missing-trivy.yaml" } }, ({ plan }) => {
    const r = plan("--json");
    const p = json(r).plan;
    assert.equal(p.approvable, false);
    const codes = p.blockers.map((b) => b.code);
    assert.ok(codes.includes("BRIDGE_CONFIG_OUTSIDE_WORKSPACE"), JSON.stringify(p.blockers));
    assert.ok(codes.includes("BRIDGE_CONFIG_MISSING"), JSON.stringify(p.blockers));
    const outside = p.blockers.find((b) => b.code === "BRIDGE_CONFIG_OUTSIDE_WORKSPACE");
    assert.match(outside.message, /outside-gitleaks\.toml/);
    assert.deepEqual(outside.items, ["quality-bridge.gitleaks#secrets"]);
    assert.equal(bridgeInvocation(p).command.stdin.toolConfigs, undefined, "a refused file never reaches the request");
  });
});

test("the bridge refuses a configuration path outside the workspace root with a structured error", async () => {
  const python = requirePython();
  const work = tmp("jgates-bridge-outside-");
  try {
    const target = path.join(work, "target");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "app.py"), "print('x')\n");
    fs.writeFileSync(path.join(work, "outside.toml"), 'title = "outside"\n');
    const request = { schemaVersion: 1, target, outputDir: path.join(work, "out"), mode: "full", secrets: true, subchecks: ["gitleaks"], toolConfigs: { gitleaks: "../outside.toml" } };
    const outcome = await bridgeApi.callBridge(request, { cwd: work, env: { PATH: "/usr/bin:/bin", JGATES_PYTHON: python } });
    assert.equal(outcome.kind, "response", outcome.message);
    assert.equal(outcome.exitCode, 3);
    assert.equal(outcome.response.ok, false);
    assert.deepEqual(outcome.response.error, {
      code: "config-outside-target",
      message: outcome.response.error.message,
      tool: "gitleaks",
      path: "../outside.toml",
    });
    assert.match(outcome.response.error.message, /outside the workspace root/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("a subcheck the plan turned off is left out of the request, and BRIDGE_RUNS_DISABLED is gone", async () => {
  await withProject(null, ({ plan }) => {
    const before = json(plan("--json")).plan;
    assert.ok(bridgeInvocation(before).command.stdin.subchecks.includes("semgrep"));
    const r = plan("--json", "--skip", "tool:quality-bridge.semgrep");
    assert.equal(r.code, 0, r.out + r.err);
    const p = json(r).plan;
    const invocation = bridgeInvocation(p);
    assert.ok(!invocation.command.stdin.subchecks.includes("semgrep"));
    assert.ok(!invocation.subchecks.includes("semgrep"));
    assert.deepEqual(invocation.runsAnyway, []);
    assert.equal(item(p, "quality-bridge.semgrep#sast").bridge.invoked, false);
    assert.ok(!p.warnings.some((w) => w.code === "BRIDGE_RUNS_DISABLED"), JSON.stringify(p.warnings));
    // The subchecks that stay on are still requested; the default-off ones (project tests, coverage) are not.
    for (const sub of ["file-size", "gitleaks", "trivy", "osv-scanner", "jscpd", "megalinter"]) assert.ok(invocation.command.stdin.subchecks.includes(sub), sub);
    for (const sub of ["project-tests", "coverage"]) assert.ok(!invocation.command.stdin.subchecks.includes(sub), sub);
  });
});

test("with scope changed or paths the bridge still analyzes the workspace, and the plan says so (SCOPE_WIDENED)", async () => {
  await withProject(null, ({ plan }) => {
    for (const args of [["--scope", "changed"], ["--scope", "paths", "--path", "api"]]) {
      const r = plan("--json", ...args);
      assert.equal(r.code, 0, r.out + r.err);
      const p = json(r).plan;
      assert.equal(p.scope.requested, args[1]);
      assert.equal(p.scope.effective, "full");
      const widened = p.warnings.find((w) => w.code === "SCOPE_WIDENED");
      assert.ok(widened, `${args.join(" ")}: ${JSON.stringify(p.warnings)}`);
      assert.equal(p.scope.note, widened.message);
      const stdin = bridgeInvocation(p).command.stdin;
      assert.equal(stdin.scopeManifest, undefined, "the bridge receives no scope: the warning is the honest statement");
    }
  });
});

const FAKE_SCANNER = (log) => `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: name, argv: args }) + "\\n");
const at = (f) => args[args.indexOf(f) + 1];
if (name === "gitleaks") fs.writeFileSync(at("--report-path"), "[]\\n");
if (name === "trivy") fs.writeFileSync(at("--output"), '{"Results": []}\\n');
if (name === "osv-scanner") process.stdout.write('{"results": []}\\n');
`;

test("the effective command of the plan is the argv the sidecar runs with the chosen files", async () => {
  const python = requirePython();
  const bin = tmp("jgates-fake-scanners-");
  const runDir = tmp("jgates-bridge-run-");
  const log = path.join(bin, "calls.jsonl");
  try {
    for (const name of ["gitleaks", "trivy", "osv-scanner"]) {
      fs.writeFileSync(path.join(bin, name), FAKE_SCANNER(log), { mode: 0o755 });
    }
    const bindings = { gitleaks: { path: ".gitleaks.toml" }, trivy: { path: "trivy.yaml" }, "osv-scanner": { path: "osv-scanner.toml" } };
    await withProject(bindings, async ({ dir, plan }) => {
      const p = json(plan("--json")).plan;
      const ids = { gitleaks: "quality-bridge.gitleaks#secrets", trivy: "quality-bridge.trivy#dependencies", "osv-scanner": "quality-bridge.osv-scanner#dependencies" };
      const stdin = bridgeInvocation(p).command.stdin;
      // The request of the plan, restricted to the three scanners (the others are not installed here).
      const request = JSON.parse(JSON.stringify(stdin).split("{runDir}").join(runDir));
      request.subchecks = Object.keys(ids);
      const outcome = await bridgeApi.callBridge(request, { cwd: runDir, env: { PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, JGATES_PYTHON: python } });
      assert.equal(outcome.kind, "response", outcome.message ?? outcome.stderr);
      assert.equal(outcome.response.ok, true, outcome.stderr);
      const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const real = fs.realpathSync(dir);
      for (const [sub, id] of Object.entries(ids)) {
        const planned = item(p, id).bridge.effectiveCommand;
        const answered = outcome.response.subchecks.find((s) => s.id === sub);
        assert.deepEqual(answered.config, { source: "project", path: planned.config.file }, sub);
        // Public form on both sides: tokens of the plan and paths outside the target reduce to the file name.
        const publicArg = (a) => (a.startsWith("{runDir}/") || a.startsWith("{sidecarConfig}/") ? path.posix.basename(a) : a);
        assert.deepEqual(answered.command, [planned.executable, ...planned.args.map(publicArg)], sub);
        // And the process itself received the chosen file inside the workspace.
        const call = calls.find((c) => c.tool === sub);
        assert.equal(flag(call.argv, "--config"), path.join(real, planned.config.file), sub);
      }
    });
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("access of a binding: write unless it declares access: read", async () => {
  await withProject({ gitleaks: { path: ".gitleaks.toml" }, trivy: { path: "trivy.yaml", access: "read" } }, ({ dir }) => {
    const instance = toolsApi.resolveToolBindings(dir, { skipInventory: true }).instances.find((i) => i.id === "quality-bridge");
    const binding = (id) => instance.bindings.find((b) => b.id === id);
    assert.equal(binding("gitleaks").access, "write");
    assert.equal(binding("trivy").access, "read");
    assert.equal(documentsApi.openDocument(dir, "quality-bridge", "gitleaks").state, "editable");
    assert.equal(documentsApi.openDocument(dir, "quality-bridge", "trivy").state, "read-only");
  });
});
