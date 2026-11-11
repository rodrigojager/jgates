import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// V2-45: the strict profile on a Python + TypeScript + Go + Rust + .NET project (plus a Dockerfile, a shell script, a
// Playwright config and a Prisma schema). With the tools always in the image and the quality bridge retired, every
// capability the profile asks for either runs (an available plan item) or is shown as not applicable here with a reason
// code and an action; none is NO_TOOL, none is left uncovered, and no item is "unavailable" without that explanation.
//   - lint: the stack linters (Ruff, golangci-lint, Clippy, .NET analyzers, ShellCheck, Hadolint) run, not a generic bridge;
//   - dataflow is CUSTOMER_SUPPLIED (prepare CodeQL); e2e and migration drift are SERVICES_REQUIRED (configure services);
//   - everything else that needs setup says SETUP_REQUIRED with what to add or configure.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const IMAGE_TOOLS = path.join(root, "jgates", "release", "image-tools.json");

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** The reasons a "when available" capability may be absent with (PLAN-completeness.md section 5); NO_TOOL is not one. */
const REASONS = new Set(["NOT_APPLICABLE_TO_PROJECT", "SETUP_REQUIRED", "SERVICES_REQUIRED", "CUSTOMER_SUPPLIED", "NO_TOOL_FOR_LANGUAGES", "UNSUPPORTED_PLATFORM", "TOOL_MISSING", "CHECKS_DISABLED", "DISABLED_FOR_RUN", "EVIDENCE_MISSING"]);
/** Reasons whose action may be empty (nothing the project can do). */
const NO_ACTION_OK = new Set(["NOT_APPLICABLE_TO_PROJECT", "UNSUPPORTED_PLATFORM"]);

function writeFixture(dir) {
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  put("pyproject.toml", "[project]\nname = 'demo'\nversion = '0.1.0'\n");
  put("app.py", "def f():\n    return 1\n");
  put("package.json", '{"name":"web","version":"1.0.0","scripts":{"test":"echo ok"}}\n');
  put("tsconfig.json", '{"compilerOptions":{"strict":true}}\n');
  put("src/index.ts", "export const a: number = 1;\n");
  put("playwright.config.ts", "export default {};\n");
  put("prisma/schema.prisma", 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n');
  put("go.mod", "module demo\n\ngo 1.22\n");
  put("main.go", "package main\n\nfunc main() {}\n");
  put("Cargo.toml", "[package]\nname = 'demo'\nversion = '0.1.0'\nedition = '2021'\n");
  put("Cargo.lock", "version = 3\n");
  put("src/main.rs", "fn main() {}\n");
  put("App.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n');
  put("Program.cs", "System.Console.WriteLine(1);\n");
  put("Dockerfile", "FROM alpine:3.19\n");
  put("run.sh", "#!/bin/sh\necho hi\n");
}

test("V2-45: strict on a multi-language project runs every capability or shows it not applicable with a reason code and an action, with zero NO_TOOL", () => {
  const project = tmp("v2-45-project-");
  const home = tmp("v2-45-home-");
  writeFixture(project);
  const git = (...args) => spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", ...args], { cwd: project, encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  git("add", "-A");
  assert.equal(git("commit", "-qm", "init").status, 0);

  const env = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_IMAGE_JSON: IMAGE_TOOLS, JGATES_CONTAINER_RUNTIME: "jgates-test-no-engine" };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args, "--json"], { cwd: project, encoding: "utf8", env, input: "", timeout: 240_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    assert.ok(doc, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    return { status: r.status, doc };
  };

  assert.equal(cli(["init", "--cwd", project, "--profile", "strict", "--no-interactive"]).status, 0);
  const planned = cli(["plan", "--cwd", project, "--profile", "strict"]);
  assert.equal(planned.status, 0, JSON.stringify(planned.doc).slice(0, 600));
  const { plan, approvable } = planned.doc;
  assert.equal(planned.doc.status, "OK");

  // The five languages are components of the plan.
  assert.deepEqual([...new Set(plan.components.map((c) => c.language))].sort(), ["csharp", "go", "python", "rust", "typescript"]);

  // The bridge is gone from the plan: no item of it, no version of it.
  const willRun = plan.groups.willRun;
  assert.ok(willRun.every((i) => i.adapter !== "quality-bridge" && !String(i.tool).startsWith("quality-bridge")), "no quality-bridge item");
  assert.equal(plan.versions.adapters["quality-bridge"], undefined);

  // Lint comes from the stack linters of the image.
  const lint = willRun.filter((i) => i.state.enabled && i.id.endsWith("#lint")).map((i) => i.id.split("#")[0]).sort();
  for (const tool of ["clippy", "dotnet-analyzers", "golangci-lint", "hadolint", "ruff", "shellcheck"]) assert.ok(lint.includes(tool), `${tool} runs lint: ${lint.join(", ")}`);

  // Everything that runs is available: the project is the single root the component-scoped tools expect.
  const unavailable = willRun.filter((i) => i.state.enabled && i.availability.status !== "available").map((i) => `${i.id}: ${i.availability.reason}`);
  assert.deepEqual(unavailable, []);

  // Nothing is uncovered, nothing is NO_TOOL; every not-applicable capability has a known reason code and an action.
  assert.deepEqual(plan.groups.uncoveredRequirements, []);
  const notHere = plan.groups.notApplicableRequirements;
  assert.ok(notHere.length > 0, "strict asks for more than this project can run");
  for (const n of notHere) {
    assert.notEqual(n.reasonCode, "NO_TOOL", `${n.selector} must not be NO_TOOL`);
    assert.ok(REASONS.has(n.reasonCode), `${n.selector}: reason ${n.reasonCode}`);
    assert.equal(typeof n.message, "string");
    assert.ok(n.message.length > 0, `${n.selector}: a message`);
    assert.equal(typeof n.action?.kind, "string", `${n.selector}: an action`);
    if (!NO_ACTION_OK.has(n.reasonCode)) assert.notEqual(n.action.kind, "none", `${n.selector} (${n.reasonCode}) offers an action`);
  }
  const by = Object.fromEntries(notHere.map((n) => [n.selector, n]));
  assert.equal(by["capability:dataflow"]?.reasonCode, "CUSTOMER_SUPPLIED");
  assert.equal(by["capability:dataflow"].action.kind, "prepare-codeql");
  for (const selector of ["capability:e2e", "capability:migration"]) {
    assert.equal(by[selector]?.reasonCode, "SERVICES_REQUIRED", selector);
    assert.equal(by[selector].action.kind, "configure-services");
  }
  assert.ok(notHere.some((n) => n.reasonCode === "SETUP_REQUIRED"), "what needs setup says so");

  // Every requirement of the plan is covered by a running item or is on the not-applicable list: no third state.
  const na = new Set(notHere.map((n) => n.selector));
  const loose = plan.requirements.filter((r) => r.coveredBy.length === 0 && !na.has(r.selector)).map((r) => r.selector);
  assert.deepEqual(loose, []);
  assert.equal(approvable, true, "a strict plan with only not-applicable gaps is approvable");
});
