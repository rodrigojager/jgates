import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-53 (fake engine): the quality bridge is retired from the plans.
//   1. A project whose .jgates/tools.yml still declares the old `quality-bridge` instance loads: the reader replaces it with
//      the individual instances that cover its capabilities (Semgrep, Gitleaks, OSV-Scanner, Trivy, Checkov, jscpd,
//      file-size), the plan says so (CONFIG_MIGRATED, with the replacing instances), and no item of the plan is the bridge.
//   2. The overview (GET /api/overview) reports the same notice.
//   3. A run of the migrated instances starts step containers of the one tools image; no recorded engine call names a
//      MegaLinter image, the sidecar image or any image other than the tools image.
//   4. A project that never had the bridge gets no notice, and the default plan has no bridge item either.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(root, "jgates", "dist");
const MAIN = path.join(DIST, "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
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

const OLD_TOOLS = [
  "schemaVersion: 1",
  "tools:",
  "  quality-bridge:",
  "    adapter: quality-bridge",
  "    enabled: true",
  "    capabilities: [sast, secrets, dependencies, duplication, iac, file-size]",
  "",
].join("\n");
const REPLACING = ["checkov", "file-size", "gitleaks", "jscpd", "osv-scanner", "semgrep", "trivy"];

test("V2-53: an old quality-bridge configuration migrates to individual instances, the overview reports it, and no MegaLinter image is ever used", async () => {
  const project = tmp("v2-53-project-");
  const home = tmp("v2-53-home-");
  const engine = tmp("v2-53-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 240_000 });
  const json = (r) => JSON.parse(r.stdout);
  const dockerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

  fs.writeFileSync(path.join(project, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(project, "app.py"), "def f():\n    return 1\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  assert.equal(cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]).status, 0);

  // Without the old entry: no notice and no bridge in the default plan.
  const clean = json(cli(["plan", "--cwd", project, "--json"]));
  assert.equal(clean.status, "OK");
  assert.deepEqual(clean.plan.warnings.filter((w) => w.code === "CONFIG_MIGRATED"), []);
  assert.ok(clean.plan.groups.willRun.every((i) => i.adapter !== "quality-bridge"), "the default plan has no bridge item");

  // 1. The old bridge instance in tools.yml.
  fs.writeFileSync(path.join(project, ".jgates", "tools.yml"), OLD_TOOLS);
  spawnSync("git", ["add", "-A"], { cwd: project });
  const planned = json(cli(["plan", "--cwd", project, "--json"]));
  assert.equal(planned.status, "OK", JSON.stringify(planned).slice(0, 600));
  const notice = planned.plan.warnings.find((w) => w.code === "CONFIG_MIGRATED");
  assert.ok(notice, JSON.stringify(planned.plan.warnings));
  assert.match(notice.message, /quality bridge \(quality-bridge\) was retired/);
  for (const id of REPLACING) assert.match(notice.message, new RegExp(id), `the notice names ${id}`);
  assert.equal(planned.plan.versions.adapters["quality-bridge"], undefined);
  // The minimal profile switches several of them off: they are still instances of the plan (disabled), never a bridge.
  const items = [...planned.plan.groups.willRun, ...planned.plan.groups.notApplicableOrDisabled];
  assert.ok(items.every((i) => i.adapter !== "quality-bridge" && !String(i.tool).startsWith("quality-bridge")), "no bridge item");
  const byTool = (tool) => items.filter((i) => i.tool === tool).map((i) => i.id.split("#")[1]).sort();
  assert.deepEqual(byTool("gitleaks"), ["secrets"]);
  assert.deepEqual(byTool("osv-scanner"), ["dependencies"]);
  assert.deepEqual(byTool("trivy"), ["dependencies", "iac"]);
  assert.deepEqual(byTool("checkov"), ["iac"]);
  assert.deepEqual(byTool("jscpd"), ["duplication"]);
  assert.deepEqual(byTool("file-size"), ["file-size"]);
  assert.deepEqual(byTool("semgrep"), ["sast"]);

  // The configuration file on disk is not rewritten (the reader migrates in memory); the validator accepts it.
  assert.equal(fs.readFileSync(path.join(project, ".jgates", "tools.yml"), "utf8"), OLD_TOOLS);
  const valid = json(cli(["config", "validate", "--cwd", project, "--json"]));
  assert.equal(valid.valid ?? valid.status === "OK", true, JSON.stringify(valid).slice(0, 400));

  // 2. The overview reports the notice.
  const { routes } = await import(pathToFileURL(path.join(DIST, "server", "routes", "overview.js")).href);
  const route = routes.find((r) => r.method === "GET" && r.path === "/api/overview");
  const { workspaceId } = await import(pathToFileURL(path.join(DIST, "core", "ids", "index.js")).href);
  const overview = await route.handler({ server: { projectDir: project, home, version: CLI_VERSION, workspace: { id: workspaceId(project) }, log: () => undefined } });
  assert.equal(overview.status, 200);
  const migrated = overview.json.notices.filter((n) => n.code === "CONFIG_MIGRATED");
  assert.equal(migrated.length, 1, JSON.stringify(overview.json.notices));
  assert.match(migrated[0].message, /quality-bridge/);

  // 3. A run of the migrated instances: step containers of the tools image only, never a MegaLinter or sidecar image.
  fs.rmSync(calls, { force: true });
  const ran = cli(["run", "--cwd", project, "--no-interactive", "--json", "--only", "tool:file-size", "--only", "tool:gitleaks"]);
  const doc = json(ran);
  assert.ok(Array.isArray(doc.stages), ran.stdout.slice(0, 600) + ran.stderr.slice(0, 600));
  const engineCalls = dockerCalls();
  assert.ok(engineCalls.length > 0, "the run used the engine");
  const flat = engineCalls.flat().map(String);
  assert.equal(flat.some((a) => /megalinter|oxsecurity|quality-sidecar|jgates\/quality/i.test(a)), false, "no MegaLinter or sidecar image in any engine call");
  const stepRuns = engineCalls.filter((c) => c[0] === "run" && c.includes("org.jgates.kind=step"));
  assert.ok(stepRuns.length > 0, "a step container ran");
  for (const call of stepRuns) assert.ok(call.some((a) => /^(jgates-tools:dev|sha256:[0-9a-f]{64})$/.test(a)), `a step runs the tools image: ${call.join(" ").slice(0, 200)}`);
  assert.equal(doc.stages.some((s) => String(s.id).startsWith("quality-bridge")), false, "no bridge stage in the result");
});
