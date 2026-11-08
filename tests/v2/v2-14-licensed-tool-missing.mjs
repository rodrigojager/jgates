import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-14: a licensed, customer-supplied tool (CodeQL) is missing. With no codeql on the PATH and none configured, the
// real plan service reports the tool as unavailable with structured setup guidance (tool, supported versions, official
// download and setup URLs, the license note), the real run service blocks the stage (never passes it, never claims
// coverage), the run is not complete and nothing is installed or downloaded.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(root, "jgates", "dist");
const FIXTURE = path.join(root, "jgates", "tests", "fixtures", "codeql", "bad");
const load = (...parts) => import(pathToFileURL(path.join(DIST, ...parts)).href);

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

test("V2-14: a missing licensed tool (CodeQL) blocks its stage with setup guidance, the run is not complete and nothing is installed", async () => {
  try {
    const { setLocale } = await load("i18n", "index.js");
    setLocale("en");
    const { planInit, writeInit } = await load("core", "init", "index.js");
    const { buildPlan } = await load("core", "plan", "index.js");
    const { executeRun } = await load("core", "run", "index.js");
    const { planSteps, planDisabled } = await load("core", "run", "plan-run.js");
    const { findOnPath } = await load("core", "bridge", "index.js");

    const dir = tmp("v2-14-ws-");
    const home = tmp("v2-14-home-");
    fs.cpSync(FIXTURE, dir, { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
    writeInit(dir, planInit(dir, "minimal"));
    fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  codeql:\n    adapter: codeql\n    enabled: true\n    capabilities: [dataflow]\n    language: python\n");

    // No codeql anywhere: the PATH holds only the folder of node, JGATES_CODEQL is unset and the JGates home is empty.
    const env = { ...process.env, JGATES_HOME: home, NO_COLOR: "1", PATH: path.dirname(process.execPath) };
    delete env.JGATES_CODEQL;
    delete env.Path;
    assert.equal(findOnPath("codeql", env), null, "codeql must not be on the PATH of this test");

    const built = buildPlan(dir, { only: ["tool:codeql"], env, home, compare: false, version: "test" });
    assert.equal(built.ok, true, JSON.stringify(built.errors ?? built.error));
    const item = built.plan.groups.willRun.find((i) => i.id === "codeql#dataflow");
    assert.ok(item, "the CodeQL stage is in the plan");
    assert.equal(item.category, "security");
    assert.equal(item.availability.status, "unavailable");
    const guidance = item.availability.reason;
    assert.match(guidance, /CodeQL CLI/, "names the tool");
    assert.match(guidance, />=2\.15\.0 <3\.0\.0/, "names the supported versions");
    assert.match(guidance, /https:\/\/github\.com\/github\/codeql-action\/releases/, "official download");
    assert.match(guidance, /https:\/\/docs\.github\.com\/en\/code-security\/codeql-cli/, "official setup guide");
    assert.match(guidance, /customer-supplied/);
    assert.match(guidance, /never installs/);

    const result = await executeRun({
      workspacePath: dir,
      home,
      version: "test",
      adapter: "quality-bridge",
      options: { planHash: built.plan.planHash, planSource: "built", profile: "minimal", scope: "full" },
      plan: built.plan,
      steps: (context) => planSteps(context, built.plan),
      disabled: planDisabled(built.plan),
      env,
      cache: false,
    });
    const stage = result.stages.find((s) => s.id === "codeql#dataflow");
    assert.ok(stage, "the stage is reported");
    assert.equal(stage.state, "blocked");
    assert.equal(stage.reason, guidance, "the stage carries the same setup guidance");
    assert.notEqual(result.decision, "passed");
    assert.equal(result.complete, false, "a run with a blocked required stage is not complete");
    assert.equal(result.findings.filter((f) => f.tool === "codeql").length, 0, "no invented coverage or findings");

    // Nothing was installed or downloaded: no tools folder under the JGates home, no codeql in the run or the workspace.
    const toolsDir = path.join(home, "tools");
    assert.deepEqual(fs.existsSync(toolsDir) ? fs.readdirSync(toolsDir, { recursive: true }).map(String) : [], [], "no tool was installed under the JGates home");
    // Files only: the run folder has an (empty) outputs/codeql folder of the blocked stage, which is not an installation.
    const listed = (d) => fs.readdirSync(d, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(d, f)).isFile());
    assert.equal(listed(home).some((f) => /(^|[\\/])codeql(\.exe)?$/i.test(f)), false);
    assert.equal(listed(dir).some((f) => /(^|[\\/])codeql(\.exe)?$/i.test(f)), false);
  } finally {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  }
});
