import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The prerequisites the UI shows on top of the Overview and the Environment (Docker, Git's trust in the folder, the
// tools JGates installs) and the coverage minimum read from the component's own `fail_under`. Pure functions over a
// crafted assessment: no Docker, no pip and no Git repository are needed.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (...p) => pathToFileURL(path.resolve(here, "..", "dist", ...p)).href;
const { listPrerequisites, fixPrerequisite, safeDirectoryOf, PrerequisiteError } = await import(dist("core", "prerequisites", "index.js"));
const { findNativeMinimum } = await import(dist("adapters", "pytest", "coverage.js"));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function recipe(id, kind, commands, extra = {}) {
  return { id, kind, commands, steps: commands.map((c) => c.split(" ")), network: { hosts: [], systemMirrors: false }, writes: [], system: kind.startsWith("docker"), available: true, reason: null, ...extra };
}

/** An assessment with Docker stopped (or absent), two missing Python tools and one tool JGates cannot install. */
function assessment({ docker = "stopped", dockerCommands = ["open -a Docker"] } = {}) {
  const dockerRecipe = recipe(docker === "stopped" ? "docker:start" : "docker:install", docker === "stopped" ? "docker-start" : "docker-install", dockerCommands);
  const ruff = recipe("python:ruff", "python-packages", ["python -m pip install ruff"], { packages: ["ruff"], createEnv: null, network: { hosts: ["pypi.org"], systemMirrors: false } });
  const lint = recipe("python:import-linter", "python-packages", ["python -m pip install import-linter"], { packages: ["import-linter"], createEnv: null, network: { hosts: ["pypi.org"], systemMirrors: false } });
  const preview = (r) => ({ id: r.id, kind: r.kind, commands: r.commands, network: r.network, writes: r.writes, system: r.system, available: r.available, reason: r.reason });
  const items = [
    { key: "runtime:docker", name: "docker", classification: "essential", missing: true, alternative: null, disable: null, recipe: preview(dockerRecipe) },
    { key: "runtime:python", name: "python", classification: "essential", missing: false, alternative: null, disable: null, recipe: null },
    { key: "tool:ruff", name: "ruff", classification: "essential", missing: true, alternative: null, disable: null, recipe: preview(ruff) },
    { key: "tool:import-linter", name: "import-linter", classification: "essential", missing: true, alternative: null, disable: null, recipe: preview(lint) },
    { key: "tool:pytest", name: "pytest", classification: "essential", missing: true, alternative: null, disable: null, recipe: null },
    { key: "tool:semgrep", name: "semgrep", classification: "unused", missing: true, alternative: null, disable: null, recipe: null },
  ];
  return {
    items,
    recipes: new Map([
      ["runtime:docker", dockerRecipe],
      ["tool:ruff", ruff],
      ["tool:import-linter", lint],
    ]),
    report: {
      runtimes: [
        { id: "docker", state: "absent", stopped: docker === "stopped", message: "Docker does not answer.", fix: "Start Docker." },
        { id: "python", state: "ready", message: "", fix: null },
      ],
      tools: [
        { instance: "ruff", message: "ruff is missing", fix: null },
        { instance: "import-linter", message: "lint-imports is missing", fix: null },
        { instance: "pytest", message: "pytest is not installed in the project's Python.", fix: "pip install pytest" },
        { instance: "semgrep", message: "", fix: null },
      ],
    },
  };
}

test("the list orders Docker, then the tools JGates installs, then what only a person can fix, and skips unused items", () => {
  const dir = tmp("jg-prq-");
  const r = listPrerequisites(dir, { assessment: assessment(), platform: "darwin", env: { PATH: "" } });
  assert.deepEqual(r.items.map((i) => i.id), ["docker", "tools", "manual:tool:pytest"]);
  assert.equal(r.ready, false);
  assert.equal(r.platform, "darwin");
  const tools = r.items.find((i) => i.id === "tools");
  assert.deepEqual(tools.names, ["ruff", "import-linter"]);
  assert.equal(tools.action, "run");
  assert.ok(tools.hosts.includes("pypi.org"));
  const pytest = r.items.find((i) => i.id === "manual:tool:pytest");
  assert.equal(pytest.action, null);
  assert.equal(pytest.fix, "pip install pytest");
});

test("Docker that starts with sudo (Linux) is a command to copy, never one the UI runs", () => {
  const dir = tmp("jg-prq-");
  const linux = listPrerequisites(dir, { assessment: assessment({ dockerCommands: ["sudo systemctl start docker"] }), platform: "linux", env: { PATH: "" } });
  const docker = linux.items.find((i) => i.id === "docker");
  assert.equal(docker.kind, "docker-start");
  assert.equal(docker.action, "copy");
  const mac = listPrerequisites(dir, { assessment: assessment(), platform: "darwin", env: { PATH: "" } });
  assert.equal(mac.items.find((i) => i.id === "docker").action, "run");
  const absent = listPrerequisites(dir, { assessment: assessment({ docker: "absent" }), platform: "darwin", env: { PATH: "" } });
  assert.equal(absent.items.find((i) => i.id === "docker").kind, "docker-install");
});

test("fixing the tools runs one merged pip recipe through the executor, and a copy-only item is refused", async () => {
  const dir = tmp("jg-prq-");
  const executor = { run: () => ({ status: 0 }), prepare: async () => {} };
  const home = tmp("jg-prq-home-");
  const outcome = await fixPrerequisite(dir, "tools", { assessment: assessment(), env: { PATH: "", JGATES_HOME: home }, executor, platform: "darwin" });
  // The two Python tools become one pip recipe; without a Python on this PATH it is skipped with its reason.
  assert.deepEqual(outcome.outcomes.map((o) => o.id), ["python:packages"]);
  assert.ok(outcome.status === "done" || (outcome.status === "skipped" && outcome.message));
  const linux = assessment({ dockerCommands: ["sudo systemctl start docker"] });
  await assert.rejects(fixPrerequisite(dir, "docker", { assessment: linux, env: { PATH: "" }, executor, platform: "linux" }), (e) => e instanceof PrerequisiteError && e.code === "PREREQUISITE_NOT_RUNNABLE");
  await assert.rejects(fixPrerequisite(dir, "git", { assessment: assessment(), env: { PATH: "" }, executor }), (e) => e instanceof PrerequisiteError && e.code === "PREREQUISITE_NOT_FOUND");
});

test("the folder in Git's safe.directory hint is read without its quotes, and an option-like value is refused", () => {
  assert.equal(safeDirectoryOf("git config --global --add safe.directory 'D:/p/product'"), "D:/p/product");
  assert.equal(safeDirectoryOf('git config --global --add safe.directory "C:/Program Files/x"'), "C:/Program Files/x");
  assert.equal(safeDirectoryOf("git config --global --add safe.directory /srv/repo"), "/srv/repo");
  assert.equal(safeDirectoryOf("git config --global --add safe.directory --system"), null);
  assert.equal(safeDirectoryOf("git status"), null);
});

test("the coverage minimum falls back to fail_under, read the way coverage.py reads it", () => {
  const dir = tmp("jg-cov-");
  assert.deepEqual(findNativeMinimum(dir, null), { value: null, source: null });
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "x"\n\n[tool.coverage.report]\nshow_missing = true\nfail_under = 99\n\n[tool.ruff]\nline-length = 100\n');
  assert.deepEqual(findNativeMinimum(dir, null), { value: 99, source: "pyproject.toml#tool.coverage.report.fail_under" });
  // .coveragerc comes first in coverage.py's order.
  fs.writeFileSync(path.join(dir, ".coveragerc"), "[run]\nbranch = true\n[report]\nfail_under = 87.5 ; team floor\n");
  assert.deepEqual(findNativeMinimum(dir, null), { value: 87.5, source: ".coveragerc#report.fail_under" });
  // A component in a subfolder reads its own files; a value out of range is ignored.
  fs.mkdirSync(path.join(dir, "api"));
  fs.writeFileSync(path.join(dir, "api", "setup.cfg"), "[coverage:report]\nfail_under = 140\n");
  assert.deepEqual(findNativeMinimum(dir, "api"), { value: null, source: null });
  fs.writeFileSync(path.join(dir, "api", "setup.cfg"), "[coverage:report]\nfail_under = 80\n");
  assert.deepEqual(findNativeMinimum(dir, "api"), { value: 80, source: "api/setup.cfg#coverage:report.fail_under" });
});
