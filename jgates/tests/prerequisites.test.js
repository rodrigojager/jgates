import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The prerequisites the UI shows on top of the Overview and the Environment (Docker, the JGates tools image, Git's trust
// in the folder, an instance's data) and the coverage minimum read from the component's own `fail_under`. Pure
// functions over a crafted assessment: no Docker and no Git repository are needed. Container-first: no tool is ever
// offered for a host install.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (...p) => pathToFileURL(path.resolve(here, "..", "dist", ...p)).href;
const { listPrerequisites, fixPrerequisite, safeDirectoryOf, PrerequisiteError } = await import(dist("core", "prerequisites", "index.js"));
const { findNativeMinimum } = await import(dist("adapters", "pytest", "coverage.js"));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function recipe(id, kind, commands, extra = {}) {
  return { id, kind, commands, steps: commands.map((c) => c.split(" ")), network: { hosts: [], systemMirrors: false }, writes: [], system: kind.startsWith("docker"), available: true, reason: null, ...extra };
}

/** An assessment with Docker stopped (or absent), the tools image missing, the Semgrep rules to prepare, and one tool
 * the image does not have (its fix is the image, never a host install). */
function assessment({ docker = "stopped", dockerCommands = ["open -a Docker"], image = { available: true } } = {}) {
  const dockerRecipe = recipe(docker === "stopped" ? "docker:start" : "docker:install", docker === "stopped" ? "docker-start" : "docker-install", dockerCommands);
  const pull = recipe("image:pull", "image-pull", ["docker pull ghcr.io/example/jgates-tools@sha256:abc"], { steps: [], image: "ghcr.io/example/jgates-tools@sha256:abc", network: { hosts: ["ghcr.io"], systemMirrors: false }, available: image.available, reason: image.available ? null : "not published" });
  const rules = recipe("prepare:semgrep", "prepare", ["jgates tools prepare --instance semgrep --cwd /p --no-interactive"], { steps: [], instance: "semgrep", projectDir: "/p", network: { hosts: ["semgrep.dev"], systemMirrors: false } });
  const preview = (r) => ({ id: r.id, kind: r.kind, commands: r.commands, network: r.network, writes: r.writes, system: r.system, available: r.available, reason: r.reason });
  const items = [
    { key: "runtime:docker", name: "docker", classification: "essential", missing: true, alternative: null, disable: null, recipe: preview(dockerRecipe) },
    { key: "runtime:image", name: "image", classification: "essential", missing: true, alternative: null, disable: null, recipe: preview(pull) },
    { key: "tool:semgrep", name: "semgrep", classification: "essential", missing: true, alternative: null, disable: null, recipe: preview(rules) },
    { key: "tool:codeql", name: "codeql", classification: "essential", missing: true, alternative: null, disable: null, recipe: null },
    { key: "tool:ruff", name: "ruff", classification: "unused", missing: true, alternative: null, disable: null, recipe: null },
  ];
  return {
    items,
    recipes: new Map([
      ["runtime:docker", dockerRecipe],
      ["runtime:image", pull],
      ["tool:semgrep", rules],
    ]),
    report: {
      runtimes: [
        { id: "docker", state: "absent", stopped: docker === "stopped", message: "Docker does not answer.", fix: "Start Docker." },
        { id: "image", state: "absent", path: "ghcr.io/example/jgates-tools@sha256:abc", message: "The JGates tools have not been downloaded yet.", fix: "jgates setup" },
      ],
      tools: [
        { instance: "semgrep", message: "", fix: null },
        { instance: "codeql", message: "CodeQL is not in the JGates tools image.", fix: "jgates setup" },
        { instance: "ruff", message: "", fix: null },
      ],
    },
  };
}

test("the list orders Docker, then the tools image, then data, then what only a person can fix; no item installs a tool on the host", () => {
  const dir = tmp("jg-prq-");
  const r = listPrerequisites(dir, { assessment: assessment(), platform: "darwin", env: { PATH: "" } });
  assert.deepEqual(r.items.map((i) => i.id), ["docker", "image", "data", "manual:tool:codeql"]);
  assert.deepEqual(r.items.map((i) => i.kind), ["docker-start", "image-pull", "data-prepare", "manual"]);
  assert.equal(r.ready, false);
  assert.equal(r.platform, "darwin");
  const image = r.items.find((i) => i.id === "image");
  assert.equal(image.action, "run");
  assert.deepEqual(image.hosts, ["ghcr.io"]);
  const data = r.items.find((i) => i.id === "data");
  assert.deepEqual(data.names, ["semgrep"]);
  const codeql = r.items.find((i) => i.id === "manual:tool:codeql");
  assert.equal(codeql.action, null);
  assert.equal(codeql.fix, "jgates setup");
  // An image this release cannot pull (not published) is shown, never run.
  const unpublished = listPrerequisites(dir, { assessment: assessment({ image: { available: false } }), platform: "darwin", env: { PATH: "" } });
  assert.equal(unpublished.items.find((i) => i.id === "image").action, null);
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

test("fixing the image pulls it through the executor (the engine), fixing data prepares it, and a copy-only item is refused", async () => {
  const dir = tmp("jg-prq-");
  const pulled = [];
  const prepared = [];
  const executor = { run: () => ({ status: 0 }), prepare: async (_dir, instance) => void prepared.push(instance), pull: async (reference) => (pulled.push(reference), { status: 0 }) };
  const image = await fixPrerequisite(dir, "image", { assessment: assessment(), env: { PATH: "" }, executor, platform: "darwin" });
  assert.equal(image.status, "done", image.message ?? "");
  assert.deepEqual(image.outcomes.map((o) => o.kind), ["image-pull"]);
  assert.deepEqual(pulled, ["ghcr.io/example/jgates-tools@sha256:abc"]);
  const data = await fixPrerequisite(dir, "data", { assessment: assessment(), env: { PATH: "" }, executor, platform: "darwin" });
  assert.equal(data.status, "done", data.message ?? "");
  assert.deepEqual(prepared, ["semgrep"]);
  const linux = assessment({ dockerCommands: ["sudo systemctl start docker"] });
  await assert.rejects(fixPrerequisite(dir, "docker", { assessment: linux, env: { PATH: "" }, executor, platform: "linux" }), (e) => e instanceof PrerequisiteError && e.code === "PREREQUISITE_NOT_RUNNABLE");
  await assert.rejects(fixPrerequisite(dir, "git", { assessment: assessment(), env: { PATH: "" }, executor }), (e) => e instanceof PrerequisiteError && e.code === "PREREQUISITE_NOT_FOUND");
  await assert.rejects(fixPrerequisite(dir, "tools", { assessment: assessment(), env: { PATH: "" }, executor }), (e) => e instanceof PrerequisiteError && e.code === "PREREQUISITE_NOT_FOUND");
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
