import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Full spawn audit (V2-35 widened, fake engine): a project with every supported stack runs under the strict profile through
// the real CLI, with child_process wrapped in the CLI process by a preload module. The plan holds every adapter that applies
// to the project; the run starts the engine CLI (one `docker run` per step) and git (discovery and the state of the project)
// and nothing else: no tool, no Python, no shell is a host process. The control run (the same preload around a program that
// spawns a host tool) shows the audit would notice one.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(here, "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const PRELOAD = `
const cp = require("node:child_process");
const fs = require("node:fs");
const log = process.env.JGATES_SPAWN_AUDIT_LOG;
const record = (fn, file, args) => fs.appendFileSync(log, JSON.stringify({ fn, file: String(file), args: Array.isArray(args) ? args.map(String) : [] }) + "\\n");
for (const fn of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) {
  const original = cp[fn];
  cp[fn] = function (file, args, ...rest) {
    record(fn, file, Array.isArray(args) ? args : []);
    return original.call(this, file, args, ...rest);
  };
}
for (const fn of ["exec", "execSync"]) {
  const original = cp[fn];
  cp[fn] = function (command, ...rest) {
    record(fn, command, []);
    return original.call(this, command, ...rest);
  };
}
`;

/** One small project per supported stack, plus the files the CI, container, IaC and API checks look at. */
const FILES = {
  "app.py": "def add(a: int, b: int) -> int:\n    return a + b\n",
  "tests/test_app.py": "from app import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n",
  "pyproject.toml": "[project]\nname = 'demo'\nversion = '0.1.0'\nrequires-python = '>=3.11'\ndependencies = []\n[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
  "requirements.txt": "requests==2.31.0\n",
  "package.json": JSON.stringify({ name: "web", version: "1.0.0", scripts: { test: "vitest run", lint: "eslint ." }, devDependencies: { vitest: "1.0.0", typescript: "5.0.0", eslint: "9.0.0" } }),
  "package-lock.json": JSON.stringify({ name: "web", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "web", version: "1.0.0" } } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, outDir: "dist" }, include: ["src"] }),
  "src/index.ts": "export const total: number = 42;\n",
  "src/index.test.ts": "import { test, expect } from 'vitest';\ntest('x', () => expect(1).toBe(1));\n",
  "eslint.config.js": "export default [];\n",
  "go/go.mod": "module example.com/demo\n\ngo 1.22\n",
  "go/main.go": "package main\n\nfunc main() {}\n",
  "go/main_test.go": 'package main\n\nimport "testing"\n\nfunc TestX(t *testing.T) {}\n',
  "rust/Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
  "rust/Cargo.lock": 'version = 3\n\n[[package]]\nname = "demo"\nversion = "0.1.0"\n',
  "rust/src/lib.rs": "pub fn add(a: i32, b: i32) -> i32 { a + b }\n",
  "dotnet/App.csproj": '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
  "dotnet/Program.cs": "System.Console.WriteLine(1);\n",
  Dockerfile: "FROM alpine:3.19\nRUN echo hi\n",
  ".github/workflows/ci.yml": "name: ci\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n",
  "openapi.yaml": "openapi: 3.0.0\ninfo: {title: x, version: '1'}\npaths: {}\n",
};

/** The adapters the strict plan of this project has to hold (the ones that apply to the stacks above). */
const EXPECTED_ADAPTERS = ["build-check", "builtin-pii", "checkov", "eslint", "file-size", "gitleaks", "jscpd", "mutation", "oasdiff", "osv-scanner", "pytest", "ruff", "semgrep", "supply-chain", "trivy", "zizmor"];

test("a strict plan with every adapter that applies runs with the fake engine and spawns only the engine CLI and git", () => {
  const project = tmp("spawn-full-project-");
  const home = tmp("spawn-full-home-");
  const engine = tmp("spawn-full-engine-");
  const audit = path.join(engine, "spawn-audit.jsonl");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  const preload = path.join(engine, "preload.cjs");
  fs.writeFileSync(preload, PRELOAD);
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_SPAWN_AUDIT_LOG: audit };
  for (const name of ["JGATES_PYTHON", "JGATES_RUFF", "JGATES_SEMGREP", "JGATES_SIDECAR_DIR"]) delete env[name];
  const cli = (args) => spawnSync(process.execPath, ["--require", preload, MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 300_000 });

  for (const [rel, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), text);
  }
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  const init = cli(["init", "--cwd", project, "--profile", "strict", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  spawnSync("git", ["add", "-A"], { cwd: project });
  fs.rmSync(audit, { force: true });
  fs.rmSync(calls, { force: true });

  const run = cli(["run", "--cwd", project, "--no-interactive", "--json"]);
  let doc;
  try {
    doc = JSON.parse(run.stdout);
  } catch {
    assert.fail(`the run printed no JSON: ${run.stdout.slice(0, 600)}${run.stderr.slice(0, 600)}`);
  }

  // The plan holds every adapter that applies, and those steps were launched.
  const planned = new Set((doc.stages ?? []).map((s) => s.adapter).filter(Boolean));
  for (const adapter of EXPECTED_ADAPTERS) assert.ok(planned.has(adapter), `${adapter} is in the strict run: ${[...planned].join(", ")}`);

  const spawned = fs.readFileSync(audit, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const engineCalls = spawned.filter((s) => s.file === runtime || s.args[0] === runtime);
  const gitCalls = spawned.filter((s) => path.basename(s.file).replace(/\.exe$/i, "") === "git");
  const others = spawned.filter((s) => !engineCalls.includes(s) && !gitCalls.includes(s));
  assert.ok(engineCalls.length > 0, "the engine CLI was spawned");
  assert.deepEqual(others, [], `host processes other than the engine CLI and git: ${JSON.stringify(others)}`);

  // Every engine call is a docker command of the contract: runs carry the JGates labels and never mount the project.
  const dockerCalls = fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const runs = dockerCalls.filter((c) => c[0] === "run");
  assert.ok(runs.length >= EXPECTED_ADAPTERS.length, `one container per step: ${runs.length} runs`);
  // Each step that started ran as one container named after it; only the lockfile analysis of supply-chain and the file-size analysis are in-process.
  // A not-applicable stage starts nothing (an integration step without integration tests).
  const names = runs.map((c) => c[c.indexOf("--name") + 1]);
  const started = [...new Set(doc.stages.filter((s) => !["blocked", "disabled", "skipped", "not_applicable"].includes(s.state) && s.execution?.step && !["supply-chain", "file-size"].includes(s.adapter)).map((s) => s.execution.step))];
  assert.ok(started.length >= 10, `steps that started: ${started.join(", ")}`);
  for (const step of started) assert.ok(names.some((n) => n.startsWith(`jgates-${doc.runId}-${step}`)), `step ${step} ran in a container (${names.join(", ")})`);
  assert.ok(started.includes("builtin-pii"), "the PII check is a container step too");
  for (const c of runs) {
    assert.ok(c.includes("org.jgates.managed=true"), `labelled: ${c.join(" ")}`);
    assert.ok(!c.some((a) => a.includes(project)), "no host project path reached a container");
    assert.ok(!c.includes("--privileged"));
  }
});

test("control: the audit sees a tool started as a host process", () => {
  const engine = tmp("spawn-full-control-");
  const audit = path.join(engine, "spawn-audit.jsonl");
  const preload = path.join(engine, "preload.cjs");
  fs.writeFileSync(preload, PRELOAD);
  const r = spawnSync(process.execPath, ["--require", preload, "-e", `require("node:child_process").spawnSync(process.execPath, ["-e", "0"])`], { env: { ...process.env, JGATES_SPAWN_AUDIT_LOG: audit } });
  assert.equal(r.status, 0);
  const spawned = fs.readFileSync(audit, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(spawned.some((s) => s.file === process.execPath));
});
