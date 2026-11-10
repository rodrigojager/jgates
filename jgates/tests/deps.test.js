import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Dependency volumes (PLAN-dependencies.md): the install recipe of every manager in local and governed mode, the
// governed blocker of a component without a lockfile, the private registry token (key store -> stdin of the deps
// container, never an argument, a log, a volume file or an outcome), and where `jgates plan --json` says each check's tool
// comes from (the project's pytest, JGates's mypy). Engine calls go to the fake engine (tests/docker/fake-docker.cjs).

const here = path.dirname(fileURLToPath(import.meta.url));
// This file tests the container mode (the default outside the tools image): not the in-image mode of the other tests
// (tests/setup/in-image.mjs); every engine call goes to the fake engine.
const IN_IMAGE_JSON = process.env.JGATES_IMAGE_JSON;
delete process.env.JGATES_IMAGE_JSON;
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FAKE = path.join(here, "docker", "fake-docker.cjs");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const deps = await load("core", "deps", "index.js");
const discovery = await load("core", "discovery", "index.js");
const secrets = await load("core", "secrets", "index.js");
const { buildPlan } = await load("core", "plan", "index.js");
const VERSION = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "package.json"), "utf8")).version;

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
const write = (root, files) => {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
};

/** A fake engine whose settings live in its launcher script (the engine client only gets an allowlisted environment). */
function fakeEngine() {
  const dir = tmp("jgates-deps-engine-");
  const runtime = path.join(dir, "docker.cjs");
  const calls = path.join(dir, "calls.jsonl");
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(dir)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": VERSION }))};\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const read = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, runtime, calls: read };
}

const PKG = (name, extra = {}) => JSON.stringify({ name, version: "1.0.0", private: true, ...extra }, null, 2) + "\n";
const MANAGERS_PROJECT = {
  "uv/pyproject.toml": '[project]\nname = "a"\nversion = "0.1.0"\n',
  "uv/uv.lock": "version = 1\n",
  "poetry/pyproject.toml": '[project]\nname = "b"\nversion = "0.1.0"\n\n[tool.poetry]\npackage-mode = false\n',
  "poetry/poetry.lock": "# lock\n",
  "pip/requirements.txt": "iniconfig==2.0.0\n",
  "pip/requirements-dev.txt": "pytest\n",
  "npm/package.json": PKG("npm"),
  "npm/package-lock.json": "{}\n",
  "npmloose/package.json": PKG("npmloose"),
  "pnpm/package.json": PKG("pnpm"),
  "pnpm/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "yarn/package.json": PKG("yarn"),
  "yarn/yarn.lock": "# yarn lockfile v1\n",
  "berry/package.json": PKG("berry"),
  "berry/yarn.lock": "__metadata:\n  version: 8\n",
  "berry/.yarnrc.yml": "nodeLinker: node-modules\n",
  "gomod/go.mod": "module example.com/x\n\ngo 1.22\n",
  "gomod/go.sum": "",
  "rust/Cargo.toml": '[package]\nname = "r"\nversion = "0.1.0"\n',
  "rust/Cargo.lock": "version = 4\n",
  "rust/src/main.rs": "fn main() {}\n",
  "net/app.csproj": '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  "net/packages.lock.json": "{}\n",
  "netloose/app.csproj": '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  "bunapp/package.json": PKG("bunapp"),
  "bunapp/bun.lock": "{}\n",
};

function unitsOf(project) {
  const { inventory } = discovery.discoverWorkspace(project);
  return deps.installUnits(inventory.classifications.filter((c) => c.approvable)).units;
}
const recipe = (project, unit, governed, installCommand = null) =>
  deps.recipeFor(unit, { governed, files: deps.filesIn(project, unit.installRoot), installCommand, registry: null });
const line = (r) => r.recipe.commands.map((c) => c.join(" ")).join(" && ");

test("local installs use the lockfile when there is one; governed installs are frozen only, and a component without a lockfile is not installed", () => {
  const project = tmp("jgates-deps-managers-");
  write(project, MANAGERS_PROJECT);
  const units = Object.fromEntries(unitsOf(project).map((u) => [u.id, u]));
  for (const id of ["uv", "poetry", "pip", "npm", "npmloose", "pnpm", "yarn", "berry", "gomod", "rust", "net", "netloose", "bunapp"]) assert.ok(units[id], `${id}: ${Object.keys(units).join(", ")}`);

  const local = (id) => recipe(project, units[id], false);
  const governed = (id) => recipe(project, units[id], true);
  assert.match(line(local("uv")), /uv sync --frozen --all-extras --all-groups/);
  assert.match(line(governed("uv")), /uv sync --locked --all-extras --all-groups/);
  assert.equal(local("uv").recipe.target, "/workspace/uv/.venv");
  assert.equal(local("uv").recipe.stepEnv.VIRTUAL_ENV, "/workspace/uv/.venv");
  assert.match(line(governed("poetry")), /poetry check --lock .*poetry sync --no-root/);
  assert.match(line(local("pip")), /uv pip install --python \/workspace\/pip\/\.venv\/bin\/python -r requirements-dev\.txt -r requirements\.txt/);
  assert.equal(local("pip").recipe.mode, "manifest", "requirements files are no lockfile");
  assert.equal(units.pip.info.note, "sem lockfile");
  assert.match(line(local("npm")), /^npm ci$/);
  assert.match(line(governed("npm")), /^npm ci$/);
  assert.match(line(local("npmloose")), /^npm install --no-package-lock$/);
  assert.equal(local("npm").recipe.target, "/workspace/npm/node_modules");
  assert.deepEqual(local("npm").recipe.pathPrefix, ["/workspace/npm/node_modules/.bin"]);
  assert.match(line(governed("pnpm")), /pnpm install --frozen-lockfile --store-dir \/cache\/pnpm-store/);
  assert.match(line(governed("yarn")), /yarn install --frozen-lockfile/);
  assert.match(line(governed("berry")), /yarn install --immutable/);
  assert.equal(governed("berry").recipe.installEnv.YARN_NODE_LINKER, "node-modules");
  assert.match(line(local("gomod")), /^go mod download$/);
  assert.match(line(governed("gomod")), /^go mod download && go mod verify$/);
  assert.match(governed("gomod").recipe.installEnv.GOFLAGS, /-mod=readonly/);
  assert.equal(local("gomod").recipe.stepEnv.GOMODCACHE, "/deps/gomod/gomod");
  assert.match(line(governed("rust")), /^cargo fetch --locked$/);
  assert.equal(local("rust").recipe.stepEnv.CARGO_TARGET_DIR, "/deps/rust/target");
  assert.match(line(governed("net")), /^dotnet restore app\.csproj --locked-mode$/);
  assert.equal(local("net").recipe.stepEnv.BaseIntermediateOutputPath, "/deps/net/obj/");
  assert.equal(local("net").recipe.stepEnv.NUGET_PACKAGES, "/deps/net/nuget");

  // Governed: no lockfile, no install.
  for (const id of ["pip", "npmloose", "netloose"]) {
    const r = governed(id);
    assert.equal(r.ok, false, `${id} is blocked in governed mode`);
    assert.equal(r.code, "DEPENDENCIES_NOT_READY");
    assert.equal(r.reasonKey, "deps_not_ready_governed_lockfile");
  }
  // bun: not supported unless dependencies.yml declares the install command (local mode only).
  assert.equal(local("bunapp").reasonKey, "deps_not_ready_unsupported");
  const custom = recipe(project, units.bunapp, false, "bun install --frozen-lockfile");
  assert.equal(custom.ok, true);
  assert.deepEqual(custom.recipe.commands, [["sh", "-c", "bun install --frozen-lockfile"]]);
  assert.equal(recipe(project, units.bunapp, true, "bun install").reasonKey, "deps_not_ready_governed_custom");

  // The key follows the lockfile and the mode, never the token.
  const keyOf = (unit, governedMode, registryUrl = null) => {
    const r = recipe(project, unit, governedMode);
    return deps.dependencyKey({ projectDir: project, unit, recipe: r.recipe, imageId: "sha256:" + "a".repeat(64), governed: governedMode, registryUrl });
  };
  const before = keyOf(units.npm, false);
  assert.equal(keyOf(units.npm, false), before, "the same inputs give the same key");
  assert.notEqual(keyOf(units.npm, true), before, "governed installs have their own key");
  assert.notEqual(keyOf(units.npm, false, "https://npm.example.com/"), before, "the registry URL is part of the key");
  fs.writeFileSync(path.join(project, "npm", "package-lock.json"), '{"changed": true}\n');
  assert.notEqual(keyOf(units.npm, false), before, "a lockfile change gives a new key");
});

function initProject(project, runtime, template) {
  fs.mkdirSync(path.join(project, ".jgates", "templates"), { recursive: true });
  fs.writeFileSync(path.join(project, ".jgates", "templates", "checks.yml"), template);
  const env = { ...process.env, JGATES_HOME: tmp("jgates-deps-home-"), JGATES_CONTAINER_RUNTIME: runtime, JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "pt-BR", NO_COLOR: "1" };
  const cli = (args, extra = {}) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env: { ...env, ...extra }, input: "", timeout: 180_000 });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  const init = cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  fs.appendFileSync(path.join(project, "jgates.yml"), "  - id: checks\n    source: .jgates/templates/checks.yml\n    activation: always\n");
  return { env, cli };
}

const RUNS_CODE = [
  "schemaVersion: 1",
  "id: checks",
  "extends: [builtin:base]",
  "config:",
  "  tools:",
  "    py-check:",
  "      adapter: generic-command",
  "      enabled: true",
  "      capabilities: [lint]",
  `      command: ${JSON.stringify(process.execPath)}`,
  '      args: ["{workspace}/check.js"]',
  "      config:",
  "        effects: { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false }",
  "        evidence: { kind: exit-code }",
  "",
].join("\n");

test("a governed plan whose check needs a component without a lockfile is blocked; the same project plans fine locally", () => {
  const engine = fakeEngine();
  const project = tmp("jgates-deps-governed-");
  write(project, { "requirements.txt": "iniconfig==2.0.0\n", "check.js": "process.exit(0);\n" });
  const { env } = initProject(project, engine.runtime, RUNS_CODE);
  const options = { env, only: ["tool:py-check"], compare: false, version: VERSION };
  const local = buildPlan(project, options);
  assert.equal(local.ok, true, JSON.stringify(local.error));
  assert.ok(!local.plan.blockers.some((b) => b.code === "DEPENDENCIES_NOT_READY"), JSON.stringify(local.plan.blockers));
  assert.match(local.plan.inputs.container.dependencyKeys.root, /^[0-9a-f]{64}$/);
  const governed = buildPlan(project, { ...options, bridgePolicy: { file: "{runDir}/quality-policy.json", sha256: "0".repeat(64) } });
  assert.equal(governed.ok, true, JSON.stringify(governed.error));
  const blocker = governed.plan.blockers.find((b) => b.code === "DEPENDENCIES_NOT_READY");
  assert.ok(blocker, JSON.stringify(governed.plan.blockers));
  assert.match(blocker.message, /lockfile/);
  assert.deepEqual(blocker.items, governed.plan.groups.willRun.filter((i) => i.tool === "py-check").map((i) => i.id));
  assert.equal(governed.plan.approvable, false);
});

test("a registry token from the key store goes to the deps container on stdin only: never in a docker argument, the log, a volume or the output", () => {
  const engine = fakeEngine();
  const project = tmp("jgates-deps-registry-");
  const vault = tmp("jgates-deps-vault-");
  const token = `npm_${crypto.randomBytes(16).toString("hex")}`;
  secrets.setSecret("NPM_TOKEN", token, { env: { SEMANTIC_GATE_HOME: vault } });
  write(project, {
    "package.json": PKG("web", { devDependencies: { vitest: "^5.0.0" } }),
    "package-lock.json": "{}\n",
  });
  const { cli, env } = initProject(project, engine.runtime, RUNS_CODE);
  // After init (an existing .jgates/dependencies.yml is configuration init does not overwrite).
  write(project, { ".jgates/dependencies.yml": "schemaVersion: 1\nregistries:\n  node:\n    url: https://npm.example.com/registry/\n    tokenSecret: NPM_TOKEN\n" });
  const r = cli(["deps", "prepare", "--cwd", project, "--json"], { SEMANTIC_GATE_HOME: vault, NPM_TOKEN: "" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token), "the output never holds the token");
  const doc = JSON.parse(r.stdout);
  const unit = doc.units[0];
  assert.equal(unit.status, "installed");
  assert.deepEqual(unit.registry, { url: "https://npm.example.com/registry/", tokenSecret: "NPM_TOKEN", source: "vault" });
  const depsRun = engine.calls().find((c) => c[0] === "run" && c.includes("org.jgates.kind=deps"));
  assert.ok(depsRun, "a deps container");
  assert.ok(depsRun.includes("--interactive"), "the deps container reads its standard input");
  for (const call of engine.calls()) assert.ok(!JSON.stringify(call).includes(token), `a docker call carries the token: ${call.slice(0, 3).join(" ")}`);
  // The script writes the registry configuration in /tmp and references the variable; the value came on stdin.
  const script = depsRun[depsRun.indexOf("-c") + 1];
  assert.match(script, /IFS= read -r JGATES_REGISTRY_TOKEN/);
  assert.match(script, /\/tmp\/jgates-registry\/npmrc/);
  assert.match(script, /_authToken=\$\{JGATES_REGISTRY_TOKEN\}/);
  const stdin = fs.readFileSync(path.join(engine.dir, "deps-stdin.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(stdin.map((s) => s.sha256), [crypto.createHash("sha256").update(`${token}\n`).digest("hex")]);
  // No file the engine holds (volumes, records) and no file of the data folder holds it.
  const holders = [];
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (fs.readFileSync(full).includes(token)) holders.push(full);
    }
  };
  scan(engine.dir);
  scan(env.JGATES_HOME);
  scan(project);
  assert.deepEqual(holders, []);
  // A declared secret that is nowhere to be found leaves the dependencies not ready (nothing is started).
  const missing = cli(["deps", "prepare", "--cwd", project, "--json"], { SEMANTIC_GATE_HOME: tmp("jgates-deps-empty-vault-"), NPM_TOKEN: "" });
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).code, "DEPENDENCIES_NOT_READY");
  assert.match(JSON.parse(missing.stdout).units[0].message, /NPM_TOKEN/);
});

test("the masking replaces the token and its URL-encoded form", () => {
  const token = "abc/def+ghi=";
  const text = `token=${token} url=https://__token__:${encodeURIComponent(token)}@host/`;
  const masked = deps.maskSecrets(text, [token]);
  assert.ok(!masked.includes(token) && !masked.includes(encodeURIComponent(token)), masked);
  assert.equal((masked.match(/\*{8}/g) ?? []).length, 2);
});

test("jgates plan --json says the project's pytest runs where the project declares it, and JGates's mypy where it does not", () => {
  const engine = fakeEngine();
  const project = tmp("jgates-deps-tools-");
  write(project, {
    "pyproject.toml": '[project]\nname = "app"\nversion = "0.1.0"\ndependencies = ["requests>=2"]\n\n[dependency-groups]\ndev = ["pytest>=8", "pytest-cov"]\n',
    "uv.lock": "version = 1\n",
    "app/__init__.py": "",
    "tests/test_app.py": "def test_ok():\n    assert True\n",
  });
  const template = [
    "schemaVersion: 1",
    "id: checks",
    "extends: [builtin:base]",
    "config:",
    "  tools:",
    "    pytest:",
    "      adapter: pytest",
    "      enabled: true",
    "      capabilities: [unit]",
    "    mypy:",
    "      adapter: build-check",
    "      enabled: true",
    "      capabilities: [typecheck]",
    "      config:",
    "        checker: mypy",
    "        withoutConfig: defaults",
    "",
  ].join("\n");
  const { cli } = initProject(project, engine.runtime, template);
  const r = cli(["plan", "--cwd", project, "--json", "--only", "tool:pytest", "--only", "tool:mypy"]);
  const doc = JSON.parse(r.stdout);
  assert.ok(doc.plan, r.stdout + r.stderr);
  const items = [...doc.plan.groups.willRun, ...doc.plan.groups.notApplicableOrDisabled];
  const pytest = items.find((i) => i.tool === "pytest");
  const mypy = items.find((i) => i.tool === "mypy");
  assert.ok(pytest && mypy, JSON.stringify(items.map((i) => i.id)));
  assert.deepEqual(
    { origin: pytest.toolSource.origin, package: pytest.toolSource.package, declaredIn: pytest.toolSource.declaredIn },
    { origin: "project", package: "pytest", declaredIn: "pyproject.toml" },
  );
  assert.equal(pytest.toolSource.message, "usa o pytest do projeto (declarado em pyproject.toml)");
  assert.equal(mypy.toolSource.origin, "image");
  assert.equal(mypy.toolSource.declaredIn, null);
  assert.equal(mypy.toolSource.message, "usa o mypy do JGates (o projeto não declara mypy)");
  // Inside the tools image (in-image mode) there are no dependency volumes: the plan says nothing about it.
  const host = cli(["plan", "--cwd", project, "--json", "--only", "tool:pytest", "--only", "tool:mypy"], { JGATES_IMAGE_JSON: IN_IMAGE_JSON });
  const hostItems = [...JSON.parse(host.stdout).plan.groups.willRun, ...JSON.parse(host.stdout).plan.groups.notApplicableOrDisabled];
  assert.ok(hostItems.every((i) => i.toolSource === undefined));
});
