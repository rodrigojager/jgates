import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-88 (real engine): the whole bundled Semgrep pack on the real tools image. One project holds the vulnerable twin of
// every language of the pack (JavaScript, TypeScript, Python, Go, C#, Rust, Java and PHP, with the XSS cases of the
// first three), a second project holds the clean twins. `jgates run` under Balanced runs the Semgrep step with the pack
// in a real container: every rule id listed in expected/<language>.json is found in the vulnerable project, in the file
// of that language; the clean project has no Semgrep finding; the project folders are byte-identical afterwards and no
// container of this workspace is left behind. Every object the case creates in the engine carries its workspace id; the
// cleanup selects by those labels only.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FIXTURES = path.join(root, "jgates", "tests", "fixtures", "semgrep-pack");
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
const workspaces = [];
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  for (const workspace of workspaces) {
    const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${workspace}`];
    for (const id of docker(["ps", "-aq", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["rm", "-f", id]);
    for (const name of docker(["volume", "ls", "-q", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["volume", "rm", "-f", name]);
  }
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

test("V2-88 (real engine): every rule of expected/<language>.json is found in the vulnerable twins, the clean twins have no Semgrep finding, and the projects are untouched", async () => {
  assert.equal(docker(["version", "--format", "{{.Server.Version}}"]).code, 0, "Docker is required for the real-engine acceptance cases (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
  const { workspaceId } = await import(pathToFileURL(path.join(dist, "core", "ids", "index.js")).href);

  const languages = fs.readdirSync(path.join(FIXTURES, "expected")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  for (const language of ["javascript", "typescript", "python", "go", "csharp", "rust", "java", "php"]) assert.ok(languages.includes(language), `${language} is twinned`);

  const home = tmp("v2-88-real-home-");
  const env = { ...process.env, JGATES_HOME: home, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  // The real engine (the node test runs name a missing engine client by default, tests/setup/in-image.mjs).
  if (env.JGATES_CONTAINER_RUNTIME === "jgates-test-no-engine") delete env.JGATES_CONTAINER_RUNTIME;

  const runProject = (variant) => {
    const project = tmp(`v2-88-real-${variant}-`);
    workspaces.push(workspaceId(project));
    for (const language of languages) fs.cpSync(path.join(FIXTURES, variant, language), path.join(project, language), { recursive: true });
    const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 900_000 });
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
    const init = cli(["init", "--cwd", project, "--profile", "standard", "--no-interactive", "--json"]);
    assert.equal(init.status, 0, init.stderr + init.stdout);
    spawnSync("git", ["add", "-A"], { cwd: project });
    const before = treeHash(project);
    const run = cli(["run", "--cwd", project, "--no-interactive", "--json", "--only", "tool:semgrep"]);
    const doc = JSON.parse(run.stdout);
    const stage = doc.stages.find((s) => s.id === "semgrep#sast");
    assert.ok(stage, JSON.stringify(doc.stages.map((s) => [s.id, s.state, s.reason])));
    assert.equal(stage.state, "completed", `${variant}: ${stage.state} ${stage.reason ?? ""}`);
    assert.equal(treeHash(project), before, `${variant}: the project is byte-identical after the run`);
    assert.deepEqual(doc.workspaceChanges?.added ?? [], [], `${variant}: the run reports no change in the project`);
    return { doc, stage, project };
  };

  // 1. The vulnerable twins: every expected rule id, in a file of its language.
  const bad = runProject("vulnerable");
  const found = bad.doc.findings.filter((f) => f.tool === "semgrep");
  for (const language of languages) {
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, "expected", `${language}.json`), "utf8"));
    for (const id of expected.ruleIds) {
      const hit = found.find((f) => f.ruleId === id && f.location.path.startsWith(`${language}/`));
      assert.ok(hit, `${language}: ${id} missing; found ${[...new Set(found.map((f) => f.ruleId))].join(", ")}`);
      assert.ok(hit.location.line > 0, `${language}: ${id} has a line`);
    }
    assert.ok((bad.stage.scannedLanguages?.[language] ?? 0) > 0, `${language}: the stage records the files scanned (${JSON.stringify(bad.stage.scannedLanguages)})`);
  }
  assert.equal(bad.doc.decision, "failed");

  // 2. The clean twins: no Semgrep finding.
  const clean = runProject("clean");
  assert.deepEqual(clean.doc.findings.filter((f) => f.tool === "semgrep").map((f) => f.ruleId), []);

  // No container of either workspace is left behind.
  for (const workspace of workspaces) assert.equal(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${workspace}`]).out.trim(), "", "no container is left");
});
