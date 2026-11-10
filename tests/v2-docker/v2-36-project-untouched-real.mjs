import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-36 (real engine): the project folder is untouched by a full run whose tests write files. The Python project below
// is run end to end with `jgates run` against the local development image jgates-tools:dev (the engine is real: the
// sync helper, the ruff step and the pytest step are real containers). Its test writes a report and a generated source
// next to the code and the pytest step would normally leave caches behind. The tree hash of the project (every path,
// its size and mtime and its content) is the same before and after, the files exist only in the source volume, and a
// second run starts from a fresh sync and leaves the project untouched again. Every object this test creates in the
// engine carries its workspace id; the cleanup selects by those labels only.
//
// The two steps are `generic-command` tool instances because the Ruff and pytest adapters still probe the host for their
// tools (until T12 makes the probes read /etc/jgates/image.json); the stand-ins in a temporary PATH folder only let the
// plan call the tools available and are never executed.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const IMAGE = "jgates-tools:dev";

const docker = (args) => {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
let workspace = "";
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  if (!workspace) return;
  const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${workspace}`];
  for (const id of docker(["ps", "-aq", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["rm", "-f", id]);
  for (const name of docker(["volume", "ls", "-q", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["volume", "rm", "-f", name]);
});

/** Hash of the whole tree: relative paths, kinds, sizes, mtimes and contents, in a stable order. */
function treeHash(dir) {
  const hash = crypto.createHash("sha256");
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(full);
      if (entry.isDirectory()) {
        hash.update(`d:${next}\0`);
        walk(full, next);
      } else hash.update(`f:${next}:${stat.size}:${stat.mtimeMs}\0`).update(fs.readFileSync(full));
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

const template = (tool, command, args) =>
  [
    "schemaVersion: 1",
    `id: ${tool}`,
    "extends: [builtin:base]",
    "config:",
    "  tools:",
    `    ${tool}:`,
    "      adapter: generic-command",
    "      enabled: true",
    "      capabilities: [lint]",
    `      command: ${command}`,
    `      args: ${JSON.stringify(args)}`,
    "      config:",
    "        effects: { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false }",
    "        evidence: { kind: exit-code }",
    "",
  ].join("\n");

test("V2-36 (real engine): the project folder is identical before and after a full run whose test step writes files", async () => {
  const docker0 = docker(["version", "--format", "{{.Server.Version}}"]);
  assert.equal(docker0.code, 0, "Docker is required for the real-engine acceptance cases (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
  const { workspaceId } = await import(pathToFileURL(path.join(dist, "core", "ids", "index.js")).href);

  const project = tmp("v2-36-real-project-");
  const home = tmp("v2-36-real-home-");
  const stubs = tmp("v2-36-real-stubs-");
  workspace = workspaceId(project);
  for (const command of ["ruff", "pytest"]) {
    fs.writeFileSync(path.join(stubs, command), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    fs.writeFileSync(path.join(stubs, `${command}.cmd`), "@exit /b 99\r\n");
  }
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const env = { ...process.env, [pathKey]: `${stubs}${path.delimiter}${process.env[pathKey] ?? ""}`, JGATES_HOME: home, JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 600_000 });

  const files = {
    "pyproject.toml": '[tool.ruff]\nline-length = 88\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\npythonpath = ["."]\n',
    "src/__init__.py": "",
    "src/app.py": "def add(a, b):\n    return a + b\n",
    "tests/test_app.py": [
      "from pathlib import Path",
      "",
      "from src.app import add",
      "",
      "",
      "def test_add_writes_next_to_the_code():",
      '    Path("coverage.xml").write_text("<coverage/>")',
      '    Path("src/generated.py").write_text("GENERATED = True\\n")',
      '    Path("tests/__pycache__").mkdir(exist_ok=True)',
      '    Path("tests/__pycache__/leftover.pyc").write_text("x")',
      "    assert add(1, 2) == 3",
      "",
    ].join("\n"),
  };
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
    fs.writeFileSync(path.join(project, name), content);
  }
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  assert.equal(cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]).status, 0);
  const tools = { "ruff-check": ["ruff", ["check", "--no-cache", "."]], "pytest-run": ["pytest", ["-p", "no:cacheprovider", "-q"]] };
  fs.mkdirSync(path.join(project, ".jgates", "templates"), { recursive: true });
  for (const [tool, [command, args]] of Object.entries(tools)) fs.writeFileSync(path.join(project, ".jgates", "templates", `${tool}.yml`), template(tool, command, args));
  fs.appendFileSync(path.join(project, "jgates.yml"), Object.keys(tools).map((t) => `  - id: ${t}\n    source: .jgates/templates/${t}.yml\n    activation: always\n`).join(""));
  spawnSync("git", ["add", "-A"], { cwd: project });

  const before = treeHash(project);
  const only = Object.keys(tools).flatMap((t) => ["--only", `tool:${t}`]);

  // 1. A full run: the project is copied into the volume and the steps run there.
  const run = cli(["run", "--cwd", project, "--no-interactive", "--json", ...only]);
  const doc = JSON.parse(run.stdout);
  for (const stage of doc.stages) assert.equal(stage.state, "completed", `${stage.id}: ${stage.state} ${stage.reason ?? ""}`);
  assert.equal(doc.decision, "passed", JSON.stringify(doc.stages.map((s) => [s.id, s.state, s.reason])));
  const events = fs.readFileSync(path.join(doc.runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const synced = events.find((e) => e.type === "phase-finished" && e.data.phase === "sync");
  assert.equal(synced?.data.status, "succeeded", JSON.stringify(synced));
  const volume = synced.data.details.volume;
  assert.equal(treeHash(project), before, "the project is unchanged after the run");
  assert.deepEqual(doc.workspaceChanges?.added ?? [], [], "the run reports no change in the project");

  // 2. The test step ran in a container of the image and wrote its files in the source volume, not in the project.
  const writes = ["coverage.xml", "src/generated.py", "tests/__pycache__/leftover.pyc"];
  const listing = docker(["run", "--rm", "--pull", "never", "--network", "none", "--label", "org.jgates.managed=true", "--label", `org.jgates.workspace=${workspace}`, "--mount", `type=volume,src=${volume},dst=/workspace,readonly`, IMAGE, "sh", "-c", "cd /workspace && find . -type f | sort"]);
  assert.equal(listing.code, 0, listing.err);
  const inVolume = listing.out.split("\n").map((l) => l.trim().replace(/^\.\//, "")).filter(Boolean);
  for (const rel of writes) {
    assert.ok(inVolume.includes(rel), `${rel} was written in the source volume: ${inVolume.join(", ")}`);
    assert.ok(!fs.existsSync(path.join(project, rel)), `${rel} was not written in the project`);
  }
  const header = fs.readFileSync(path.join(doc.runDir, "logs", "pytest-run.stderr.log"), "utf8").split("\n---\n")[0];
  assert.match(header, /^Comando executado: .*--mount type=volume,src=jgates-ws_[0-9a-f]{16}-src,dst=\/workspace /m, "the log shows the docker run line with the source volume");
  assert.doesNotMatch(header, new RegExp(project.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")), "the project folder is not in the docker run line");

  // 3. The next run starts from a fresh sync (the test's files are not part of the project) and the project is untouched again.
  const again = JSON.parse(cli(["run", "--cwd", project, "--no-interactive", "--json", ...only]).stdout);
  assert.equal(again.decision, "passed");
  assert.equal(treeHash(project), before);
  const syncedAgain = fs.readFileSync(path.join(again.runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === "phase-finished" && e.data.phase === "sync");
  assert.equal(syncedAgain.data.details.changedFiles, 0, "a second sync of an unchanged project copies nothing");

  // No container ever got the project folder, and none is left behind.
  assert.equal(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${workspace}`]).out.trim(), "");
});
