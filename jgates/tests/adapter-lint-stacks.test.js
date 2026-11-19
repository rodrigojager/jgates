import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Stack lint adapters (golangci-lint, clippy, the .NET analyzers, ShellCheck, Hadolint): for each stack, a fixture with a
// known defect yields a located, blocking finding of the tool, and its clean twin none, through the real init, plan and
// run services. The linters are not on every machine that runs the default suite, so the override of each tool points at
// tests/fixtures/lint-stacks/replay.mjs, which replays what the REAL linter of the tools image printed for the fixture
// (recorded/<stack>.<kind>.json, chosen by the content of the working folder and checked against the plan's command);
// tests/docker/adapters-lint.test.js runs the same fixtures live in the tools image through the real engine. The parsers
// are fail-closed, a linter that is not in the image is a blocked stage, and a strict plan of a Go + Rust + .NET project
// runs these linters instead of the bridge's lint.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const FIXTURES = path.join(here, "fixtures", "lint-stacks");
const REPLAY = path.join(FIXTURES, "replay.mjs");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const { planInit, writeInit } = await load("core", "init", "index.js");
const { buildPlan } = await load("core", "plan", "index.js");
const { executeRun } = await load("core", "run", "index.js");
const { planSteps, planDisabled } = await load("core", "run", "plan-run.js");
const golangci = await load("adapters", "golangci-lint", "index.js");
const clippy = await load("adapters", "clippy", "index.js");
const dotnet = await load("adapters", "dotnet-analyzers", "index.js");
const shellcheck = await load("adapters", "shellcheck", "index.js");
const hadolint = await load("adapters", "hadolint", "index.js");
const manifests = await load("adapters", "manifests.js");
const matrix = await load("core", "matrix", "index.js");
const { imageJsonWithout } = await import(pathToFileURL(path.join(here, "setup", "image-json.mjs")).href);

const made = [];
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const home = tmp("jgates-lint-home-");
const baseEnv = {
  ...process.env,
  JGATES_HOME: home,
  JGATES_NO_CACHE: "1",
  NO_COLOR: "1",
  JGATES_LOCALE: "en",
  JGATES_GOLANGCI_LINT: REPLAY,
  JGATES_CARGO: REPLAY,
  JGATES_DOTNET: REPLAY,
  JGATES_SHELLCHECK: REPLAY,
  JGATES_HADOLINT: REPLAY,
};

function treeHash(root) {
  const h = crypto.createHash("sha256");
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".git" || e.name === ".jgates") continue;
      if (e.isDirectory()) {
        h.update(`d:${next}\0`);
        walk(p, next);
      } else h.update(`f:${next}\0`).update(fs.readFileSync(p));
    }
  };
  walk(root, "");
  return h.digest("hex");
}

/** A workspace with one fixture, initialized by the real init service (the template of the stack comes by its language or its files). */
function workspace(stack, kind) {
  const dir = tmp(`jgates-lint-${stack}-${kind}-`);
  fs.cpSync(path.join(FIXTURES, stack, kind), dir, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  writeInit(dir, planInit(dir, "minimal"));
  return dir;
}

function plan(dir, tool, env) {
  const built = buildPlan(dir, { only: [`tool:${tool}`], env, home, compare: false, version: "test" });
  assert.equal(built.ok, true, JSON.stringify(built.errors ?? built.error));
  return built.plan;
}

function execute(dir, builtPlan, env) {
  return executeRun({
    workspacePath: dir,
    home,
    version: "test",
    adapter: "quality-bridge",
    options: { planHash: builtPlan.planHash, planSource: "built", profile: "minimal", scope: "full" },
    plan: builtPlan,
    steps: (context) => planSteps(context, builtPlan),
    disabled: planDisabled(builtPlan),
    env,
    cache: false,
  });
}

/** The fixture with the defect fails with a located blocking finding of the tool on its file; the clean twin passes with none; neither is rewritten. */
async function proveStack({ stack, tool, adapterId, rule, file, line }) {
  const env = { ...baseEnv };
  const stage = `${tool}#lint`;

  const bad = workspace(stack, "bad");
  const badBefore = treeHash(bad);
  const badPlan = plan(bad, tool, env);
  const item = badPlan.groups.willRun.find((i) => i.id === stage);
  assert.ok(item, `${stage} is in the plan of the ${stack} fixture`);
  assert.equal(item.category, "quality");
  assert.equal(item.adapter, adapterId);
  assert.equal(item.availability.status, "available", item.availability.reason ?? "");
  const failed = await execute(bad, badPlan, env);
  assert.equal(failed.decision, "failed", JSON.stringify(failed.stages));
  const failedStage = failed.stages.find((s) => s.id === stage);
  assert.equal(failedStage.state, "completed", failedStage.reason);
  assert.notEqual(failedStage.interpreted, false);
  const found = failed.findings.filter((f) => f.origin === adapterId);
  assert.ok(found.length >= 1, `the defect is a finding (${JSON.stringify(failed.findings)})`);
  const hit = found.find((f) => f.ruleId === rule && f.location?.path === file);
  assert.ok(hit, `a ${rule} finding on ${file}: ${JSON.stringify(found.map((f) => [f.ruleId, f.location]))}`);
  assert.equal(hit.category, "lint");
  assert.equal(hit.blocking, true);
  assert.equal(hit.tool, tool === "dotnet-analyzers" ? "dotnet-analyzers" : tool);
  assert.equal(hit.location.line, line);
  assert.equal(treeHash(bad), badBefore, "the linter ran read-only: the fixture is byte for byte the same");

  const clean = workspace(stack, "clean");
  const cleanBefore = treeHash(clean);
  const passed = await execute(clean, plan(clean, tool, env), env);
  assert.equal(passed.decision, "passed", JSON.stringify(passed.stages));
  assert.equal(passed.findings.filter((f) => f.origin === adapterId).length, 0);
  const cleanStage = passed.stages.find((s) => s.id === stage);
  assert.equal(cleanStage.state, "completed", cleanStage.reason);
  assert.notEqual(cleanStage.interpreted, false);
  assert.equal(treeHash(clean), cleanBefore);
}

test("golangci-lint go: errcheck flags the unchecked error and the clean twin passes [proves: golangci-lint#lint, golangci-lint#lint@go]", async () => {
  await proveStack({ stack: "go", tool: "golangci-lint", adapterId: "golangci-lint", rule: "errcheck", file: "main.go", line: 6 });
});

test("clippy rust: clippy::len_zero flags the length comparison and the clean twin passes [proves: clippy#lint, clippy#lint@rust]", async () => {
  await proveStack({ stack: "rust", tool: "clippy", adapterId: "clippy", rule: "clippy::len_zero", file: "src/main.rs", line: 3 });
});

test("dotnet-analyzers csharp: CA1806 flags the ignored result and the clean twin passes [proves: dotnet-analyzers#lint, dotnet-analyzers#lint@csharp]", async () => {
  await proveStack({ stack: "csharp", tool: "dotnet-analyzers", adapterId: "dotnet-analyzers", rule: "CA1806", file: "Program.cs", line: 2 });
});

test("shellcheck any: SC2086 flags the unquoted variable and the clean twin passes [proves: shellcheck#lint, shellcheck#lint@any]", async () => {
  await proveStack({ stack: "shell", tool: "shellcheck", adapterId: "shellcheck", rule: "SC2086", file: "deploy.sh", line: 3 });
});

test("hadolint any: DL3007 flags the latest tag and the clean twin passes [proves: hadolint#lint, hadolint#lint@any]", async () => {
  await proveStack({ stack: "docker", tool: "hadolint", adapterId: "hadolint", rule: "DL3007", file: "Dockerfile", line: 1 });
});

test("lint adapters: a linter that is not in the image is a blocked stage with the cause, never a pass", async () => {
  for (const [stack, tool, imageTool] of [["go", "golangci-lint", "golangci-lint"], ["rust", "clippy", "clippy"], ["csharp", "dotnet-analyzers", "dotnet"], ["shell", "shellcheck", "shellcheck"], ["docker", "hadolint", "hadolint"]]) {
    const dir = workspace(stack, "bad");
    const env = { ...baseEnv, JGATES_GOLANGCI_LINT: "", JGATES_CARGO: "", JGATES_DOTNET: "", JGATES_SHELLCHECK: "", JGATES_HADOLINT: "", JGATES_IMAGE_JSON: imageJsonWithout(imageTool) };
    const blockedPlan = plan(dir, tool, env);
    const item = blockedPlan.groups.willRun.find((i) => i.id === `${tool}#lint`);
    assert.ok(item, `${tool} is planned`);
    assert.equal(item.availability.status, "unavailable", tool);
    assert.match(item.availability.reason, /jgates setup/, tool);
    const result = await execute(dir, blockedPlan, env);
    const stage = result.stages.find((s) => s.id === `${tool}#lint`);
    assert.equal(stage.state, "blocked", tool);
    assert.match(stage.reason, /jgates setup/, tool);
    assert.notEqual(result.decision, "passed", tool);
    assert.equal(result.findings.filter((f) => f.origin === tool).length, 0, tool);
  }
});

test("lint adapters: a command or a fixture that is not the recorded one gets no answer, so a drift cannot pass unnoticed", async () => {
  const dir = workspace("go", "clean");
  fs.writeFileSync(path.join(dir, "main.go"), "package main\n\nfunc main() {}\n");
  const env = { ...baseEnv };
  const result = await execute(dir, plan(dir, "golangci-lint", env), env);
  const stage = result.stages.find((s) => s.id === "golangci-lint#lint");
  assert.equal(stage.state, "error", JSON.stringify(stage));
  assert.notEqual(result.decision, "passed");
});

test("lint parsers: each linter's output lists its findings and anything the exit code does not explain is a problem", () => {
  const recorded = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, "recorded", name), "utf8"));

  const go = golangci.parseGolangci(recorded("go.bad.json").stdout, 1);
  assert.deepEqual(go.diagnostics.map((d) => [d.file, d.line, d.column, d.ruleId]), [["main.go", 6, 11, "errcheck"]]);
  assert.equal(golangci.parseGolangci('{"Issues":null,"Report":{}}', 0).ok, true);
  assert.equal(golangci.parseGolangci('{"Issues":[],"Report":{}}', 1).ok, false, "exit 1 with no issue explains nothing");
  assert.equal(golangci.parseGolangci(recorded("go.bad.json").stdout, 0).ok, false, "issues listed on a clean exit contradict each other");
  assert.equal(golangci.parseGolangci("level=error msg=\"config\"", 3).ok, false);
  assert.equal(golangci.parseGolangci('{"Issues":[],"Report":{}}', 3).ok, false);

  const rust = clippy.parseClippy(recorded("rust.bad.json").stdout, 0);
  assert.deepEqual(rust.diagnostics.map((d) => [d.file, d.line, d.ruleId, d.level]), [["src/main.rs", 3, "clippy::len_zero", "warning"]]);
  assert.equal(clippy.parseClippy(recorded("rust.clean.json").stdout, 0).diagnostics.length, 0);
  assert.equal(clippy.parseClippy("", 0).ok, false, "a stream without build-finished is not a result");
  assert.equal(clippy.parseClippy('{"reason":"build-finished","success":false}\n', 101).ok, false, "a crate that does not compile is not a lint result");
  assert.equal(clippy.parseClippy('{"reason":"build-finished","success":true}\n', 101).ok, false);
  assert.equal(clippy.parseClippy("not json\n", 0).ok, false);

  const cs = dotnet.parseDotnetAnalyzers(recorded("csharp.bad.json").stdout, 0);
  assert.deepEqual(cs.diagnostics.map((d) => [d.ruleId, d.line, d.column]).sort(), [["CA1304", 2, 1], ["CA1311", 2, 6], ["CA1806", 2, 1]]);
  assert.equal(dotnet.parseDotnetAnalyzers(recorded("csharp.clean.json").stdout, 0).diagnostics.length, 0);
  assert.equal(dotnet.parseDotnetAnalyzers("Program.cs(1,1): error CS1002: ; expected [/w/App.csproj]\n", 1).ok, false, "a compiler error is not a lint result");
  assert.equal(dotnet.parseDotnetAnalyzers("error NU1101: Unable to find package X\n", 1).ok, false, "a restore error is not a lint result");
  assert.equal(dotnet.parseDotnetAnalyzers("Program.cs(1,1): error CA1806: made an error by the project [/w/App.csproj]\n", 1).ok, true, "an analyzer rule the project made an error is a finding");
  assert.equal(dotnet.parseDotnetAnalyzers("", 1).ok, false, "a failed build with no readable error explains nothing");
  assert.equal(dotnet.parseDotnetAnalyzers("", 145).ok, false);

  const sh = shellcheck.parseShellcheck(recorded("shell.bad.json").stdout, 1);
  assert.deepEqual(sh.diagnostics.map((d) => [d.file, d.line, d.ruleId, d.level]), [["deploy.sh", 3, "SC2086", "info"], ["deploy.sh", 4, "SC2086", "info"]]);
  assert.equal(shellcheck.parseShellcheck('{"comments":[]}', 0).ok, true);
  assert.equal(shellcheck.parseShellcheck('{"comments":[]}', 2).ok, false, "exit 2 is a script ShellCheck could not read");
  assert.equal(shellcheck.parseShellcheck("", 0).ok, false);

  const hl = hadolint.parseHadolint(recorded("docker.bad.json").stdout, 1);
  assert.deepEqual(hl.diagnostics.map((d) => [d.ruleId, d.line, d.level]), [["DL3007", 1, "warning"], ["DL3008", 2, "warning"], ["DL3015", 2, "info"], ["DL3009", 2, "info"]]);
  assert.equal(hadolint.parseHadolint("[]", 0).ok, true);
  assert.equal(hadolint.parseHadolint("[]", 1).ok, false);
  assert.equal(hadolint.parseHadolint("{}", 0).ok, false);
});

test("lint adapters: shell scripts and Dockerfiles come in by their files, listed in the command the plan shows", () => {
  const dir = tmp("jgates-lint-files-");
  fs.mkdirSync(path.join(dir, "scripts", "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docker"), { recursive: true });
  fs.writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\necho ok\n");
  fs.writeFileSync(path.join(dir, "scripts", "build.sh"), "#!/bin/sh\necho ok\n");
  fs.writeFileSync(path.join(dir, "scripts", "node_modules", "skipped.sh"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM alpine:3.20\n");
  fs.writeFileSync(path.join(dir, "docker", "web.Dockerfile"), "FROM alpine:3.20\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  const init = planInit(dir, "minimal");
  assert.ok(init.templates.includes("shell-shellcheck") && init.templates.includes("docker-hadolint"), init.templates.join(", "));
  writeInit(dir, init);
  const env = { ...baseEnv };
  const sh = plan(dir, "shellcheck", env).invocations.find((i) => i.id === "shellcheck");
  assert.deepEqual(sh.command.args.slice(-2), ["run.sh", "scripts/build.sh"], "node_modules is not entered; the files are listed in order");
  const hl = plan(dir, "hadolint", env).invocations.find((i) => i.id === "hadolint");
  assert.deepEqual(hl.command.args.slice(-2), ["Dockerfile", "docker/web.Dockerfile"]);

  const none = tmp("jgates-lint-none-");
  fs.writeFileSync(path.join(none, "README.md"), "# nothing to lint\n");
  assert.equal(planInit(none, "minimal").templates.some((id) => id === "shell-shellcheck" || id === "docker-hadolint"), false);
});

test("lint adapters: shellcheck and hadolint activate on files anywhere, with the extensions, names and shebangs MegaLinter reads", () => {
  const dir = tmp("jgates-lint-anywhere-");
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  put("ci/deep/er/a.dash", "echo a\n");
  put("tools/run", "#!/usr/bin/env bash\necho b\n");
  put("tools/other", "#!/bin/dash\necho c\n");
  put("tools/py", "#!/usr/bin/env python3\nprint(1)\n");
  put("tools/notshell", "echo not a script\n");
  put("svc/api/Containerfile", "FROM alpine:3.20\n");
  put("svc/api/Dockerfile.dev", "FROM alpine:3.20\n");
  put("svc/web/app.Dockerfile", "FROM alpine:3.20\n");
  put("svc/node_modules/x/Dockerfile", "FROM alpine:3.20\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  const init = planInit(dir, "minimal");
  assert.ok(init.templates.includes("shell-shellcheck") && init.templates.includes("docker-hadolint"), init.templates.join(", "));
  writeInit(dir, init);
  const env = { ...baseEnv };
  const sh = plan(dir, "shellcheck", env).invocations.find((i) => i.id === "shellcheck");
  assert.deepEqual(sh.command.args.slice(sh.command.args.indexOf("--") + 1), ["ci/deep/er/a.dash", "tools/other", "tools/run"]);
  const hl = plan(dir, "hadolint", env).invocations.find((i) => i.id === "hadolint");
  assert.deepEqual(hl.command.args.slice(-3), ["svc/api/Containerfile", "svc/api/Dockerfile.dev", "svc/web/app.Dockerfile"]);

  const nested = tmp("jgates-lint-nested-");
  fs.mkdirSync(path.join(nested, "a", "b", "c"), { recursive: true });
  fs.writeFileSync(path.join(nested, "a", "b", "c", "x.sh"), "echo x\n");
  fs.writeFileSync(path.join(nested, "a", "b", "c", "Dockerfile"), "FROM alpine:3.20\n");
  const nestedInit = planInit(nested, "minimal");
  assert.ok(nestedInit.templates.includes("shell-shellcheck") && nestedInit.templates.includes("docker-hadolint"), "a file at any depth activates the templates");
});

test("lint adapters: a strict plan of a Go + Rust + .NET project runs the stack linters and has no bridge lint", () => {
  const dir = tmp("jgates-lint-mixed-");
  for (const stack of ["go", "rust", "csharp"]) fs.cpSync(path.join(FIXTURES, stack, "bad"), dir, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  writeInit(dir, planInit(dir, "strict"));
  const built = buildPlan(dir, { env: baseEnv, home, compare: false, version: "test", profile: "builtin:strict" });
  assert.equal(built.ok, true, JSON.stringify(built.errors ?? built.error));
  for (const id of ["clippy#lint", "dotnet-analyzers#lint", "golangci-lint#lint"]) {
    const item = built.plan.groups.willRun.find((i) => i.id === id);
    assert.ok(item?.capabilities.includes("lint"), `${id} runs lint`);
    assert.equal(item.availability.status, "available", item.availability.reason);
  }
  // The quality bridge (MegaLinter) is retired from the plans: it is neither run nor listed as left out.
  const everyItem = [...built.plan.groups.willRun, ...built.plan.groups.notApplicableOrDisabled];
  assert.equal(everyItem.some((i) => i.adapter === "quality-bridge"), false);
});

test("lint adapters: the support matrix shows lint validated for each stack, with its proof", () => {
  const built = matrix.buildMatrix(manifests.builtinManifests());
  for (const [adapter, stack] of [["golangci-lint", "go"], ["clippy", "rust"], ["dotnet-analyzers", "csharp"], ["shellcheck", "any"], ["hadolint", "any"]]) {
    const rows = built.rows.filter((r) => r.adapter === adapter);
    assert.deepEqual(rows.map((r) => [r.capability, r.stack, r.state]), [["lint", stack, "validated"]], adapter);
    assert.ok(rows[0].evidence.tests.length > 0, `${adapter} has a proving test`);
    assert.deepEqual(matrix.verifyMatrix(built).filter((p) => p.includes(adapter)), [], adapter);
  }
});
