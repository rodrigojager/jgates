import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Language versions and Playwright (PLAN-dependencies.md section 3), the pure part: which version request is the image's
// default, which one is fetched into the toolchain volume, which one cannot be fetched (with its two actions), what the
// recipe becomes with a pin (the virtual environment on the pinned interpreter, the environment and PATH of both
// containers), and the host record. The engine part is tests/v2/v2-40-toolchain-shared.mjs (fake engine) and
// tests/docker/toolchains.test.js (real engine).

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const deps = await import(pathToFileURL(path.join(dist, "core", "deps", "index.js")).href);
const { setLocale } = await import(pathToFileURL(path.join(dist, "i18n", "index.js")).href);
setLocale("pt-BR");

const unitOf = (ecosystem, version, source, sourceKind, installRoot = ".") => ({
  id: "root",
  installRoot,
  components: ["root"],
  info: { ecosystem, state: "detected", manager: null, variant: null, candidates: [], lockfile: null, installRoot, language: { version, source, sourceKind }, groups: [], note: null, reasonCode: null, chosenBy: "detected" },
});
const resolve = (ecosystem, version, source, sourceKind, env = {}) => deps.resolveToolchain(unitOf(ecosystem, version, source, sourceKind), { env });
const kindOf = (r) => (r.kind === "pinned" ? `pin:${r.pin.request}` : r.kind);

test("Python: the image's default needs no toolchain, another version is pinned, an unknown one is invalid", () => {
  assert.equal(kindOf(resolve("python", null, null, null)), "default");
  assert.equal(kindOf(resolve("python", "3.15", ".python-version", "python-version")), "default");
  assert.equal(kindOf(resolve("python", "3.15.2", ".python-version", "python-version")), "default");
  assert.equal(kindOf(resolve("python", "cpython-3.15", ".python-version", "python-version")), "default");
  assert.equal(kindOf(resolve("python", "3.11", ".python-version", "python-version")), "pin:3.11");
  assert.equal(kindOf(resolve("python", "3.11.4", ".python-version", "python-version")), "pin:3.11.4");
  assert.equal(kindOf(resolve("python", "3.15.1", ".python-version", "python-version")), "pin:3.15.1");
  // requires-python: satisfied by the default -> no pin; excluding it -> pinned to the specifier.
  assert.equal(kindOf(resolve("python", ">=3.10", "pyproject.toml", "requires-python")), "default");
  assert.equal(kindOf(resolve("python", ">=3.10,<4", "pyproject.toml", "requires-python")), "default");
  assert.equal(kindOf(resolve("python", "~=3.11.0", "pyproject.toml", "requires-python")), "pin:~=3.11.0");
  assert.equal(kindOf(resolve("python", ">=3.9,<3.13", "pyproject.toml", "requires-python")), "pin:>=3.9,<3.13");
  assert.equal(kindOf(resolve("python", "==3.15.*", "pyproject.toml", "requires-python")), "default");
});

test("an unknown Python version is invalid with the actions 'Usar a versão padrão' and 'Corrigir .python-version'", () => {
  for (const version of ["2.5", "2.7", "3.2", "1"]) {
    const r = resolve("python", version, ".python-version", "python-version");
    assert.equal(r.kind, "invalid", version);
    assert.equal(r.reasonKey, "toolchain_unknown_version");
    assert.deepEqual(r.actions.map((a) => a.id), ["use-default-version", "fix-version-file"]);
    assert.equal(r.actions[0].label, "Usar a versão padrão 3.15.2 desta vez");
    assert.equal(r.actions[1].label, "Corrigir .python-version");
    assert.equal(r.actions[1].file, ".python-version");
    assert.deepEqual(r.actions[0].env, { JGATES_TOOLCHAIN_DEFAULT: "python" });
  }
  const garbage = resolve("python", "pypy3.10", "api/.python-version", "python-version");
  assert.equal(garbage.kind, "invalid");
  assert.equal(garbage.reasonKey, "toolchain_invalid_request");
  assert.equal(garbage.actions[1].label, "Corrigir .python-version", "the file name, not the folder");
  // Giving up the pinned version for this run turns every case into the default.
  assert.equal(resolve("python", "2.5", ".python-version", "python-version", { JGATES_TOOLCHAIN_DEFAULT: "python" }).kind, "default");
  assert.equal(resolve("python", "3.11", ".python-version", "python-version", { JGATES_TOOLCHAIN_DEFAULT: "1" }).kind, "default");
  assert.equal(resolve("python", "3.11", ".python-version", "python-version", { JGATES_TOOLCHAIN_DEFAULT: "node" }).kind, "pinned");
});

test("Node, Go, Rust and .NET: pinned only when the requirement is not met by the image", () => {
  assert.equal(kindOf(resolve("node", "26", ".nvmrc", "nvmrc")), "default");
  assert.equal(kindOf(resolve("node", "v26.13.0", ".nvmrc", "nvmrc")), "default");
  assert.equal(kindOf(resolve("node", "lts/*", ".nvmrc", "nvmrc")), "default");
  assert.equal(kindOf(resolve("node", ">=18", "package.json", "engines-node")), "default");
  assert.equal(kindOf(resolve("node", "^26.1.0", "package.json", "engines-node")), "default");
  assert.equal(kindOf(resolve("node", "20", ".nvmrc", "nvmrc")), "pin:20");
  assert.equal(kindOf(resolve("node", "v20.11.0", ".node-version", "node-version")), "pin:20.11.0");
  assert.equal(kindOf(resolve("node", ">=18 <22", "package.json", "engines-node")), "pin:>=18 <22");
  assert.equal(kindOf(resolve("node", "^18 || ^20", "package.json", "engines-node")), "pin:^18 || ^20");
  assert.equal(kindOf(resolve("node", "something odd", "package.json", "engines-node")), "default", "engines is a hint");
  assert.equal(resolve("node", "something odd", ".nvmrc", "nvmrc").kind, "invalid");
  assert.equal(kindOf(resolve("go", "1.22", "go.mod", "go-mod-go")), "default");
  assert.equal(kindOf(resolve("go", "1.27.3", "go.mod", "go-mod-toolchain")), "default");
  assert.equal(kindOf(resolve("go", "1.28.1", "go.mod", "go-mod-toolchain")), "pin:1.28.1");
  assert.equal(kindOf(resolve("rust", "stable", "rust-toolchain.toml", "rust-toolchain")), "default");
  assert.equal(kindOf(resolve("rust", "1.70", "Cargo.toml", "rust-version")), "default");
  assert.equal(kindOf(resolve("rust", "1.75.0", "rust-toolchain.toml", "rust-toolchain")), "pin:1.75.0");
  assert.equal(kindOf(resolve("rust", "nightly-2025-01-01", "rust-toolchain.toml", "rust-toolchain")), "pin:nightly-2025-01-01");
  assert.equal(kindOf(resolve("dotnet", "10.0.100", "global.json", "global-json")), "default");
  assert.equal(kindOf(resolve("dotnet", "8.0.404", "global.json", "global-json")), "pin:8.0.404");
  assert.equal(kindOf(resolve("dotnet", "11.0.100", "global.json", "global-json")), "pin:11.0.100");
});

test("version expressions: PEP 440 specifiers and npm ranges", () => {
  const py = (v, spec) => deps.satisfiesSpecifier(v, spec);
  assert.equal(py([3, 11, 4], ">=3.10,<3.13"), true);
  assert.equal(py([3, 13, 0], ">=3.10,<3.13"), false);
  assert.equal(py([3, 11, 4], "~=3.11"), true);
  assert.equal(py([3, 12, 0], "~=3.11.2"), false);
  assert.equal(py([3, 11, 4], "==3.11.*"), true);
  assert.equal(py([3, 12, 1], "!=3.12.*"), false);
  assert.equal(py([3, 11], "nonsense"), null);
  const npm = (v, range) => deps.satisfiesRange(v, range);
  assert.equal(npm([20, 11, 0], "^20.1.0"), true);
  assert.equal(npm([21, 0, 0], "^20.1.0"), false);
  assert.equal(npm([0, 2, 5], "^0.2.3"), true);
  assert.equal(npm([0, 3, 0], "^0.2.3"), false);
  assert.equal(npm([20, 1, 9], "~20.1"), true);
  assert.equal(npm([20, 2, 0], "~20.1"), false);
  assert.equal(npm([18, 2, 0], "18.x"), true);
  assert.equal(npm([19, 0, 0], "18.x"), false);
  assert.equal(npm([20, 0, 0], ">=18 <22"), true);
  assert.equal(npm([22, 0, 0], ">= 18 < 22"), false);
  assert.equal(npm([16, 0, 0], "^18 || ^20"), false);
  assert.equal(npm([20, 0, 0], "18 - 20"), true);
  assert.equal(npm([20, 0, 0], "banana"), null);
});

test("a pinned Python moves the virtual environments to the pinned interpreter; the environment of both containers comes from the pins", () => {
  const image = "/usr/local/bin/python3";
  const recipe = {
    manager: "uv",
    target: "/workspace/.venv",
    commands: [["uv", "venv", "--allow-existing", "--python", image, "/workspace/.venv"], ["uvx", "--python", image, "--from", "poetry>=2,<3", "poetry", "sync"], ["uv", "sync"]],
    installEnv: { UV_PYTHON_DOWNLOADS: "never" },
    stepEnv: { VIRTUAL_ENV: "/workspace/.venv" },
    pathPrefix: ["/workspace/.venv/bin"],
    keyFiles: [],
    mode: "frozen",
  };
  const r = resolve("python", "3.11", ".python-version", "python-version");
  const out = deps.withToolchains(recipe, [r.pin]);
  assert.deepEqual(out.commands[0], ["uv", "venv", "--allow-existing", "--python", "3.11", "/workspace/.venv"]);
  assert.equal(out.commands[1][2], image, "the manager's own interpreter stays the image's");
  assert.equal(out.installEnv.UV_PYTHON_INSTALL_DIR, "/toolchains/uv-python");
  assert.equal(out.installEnv.UV_PYTHON_DOWNLOADS, "never", "the install container never downloads");
  assert.equal(out.stepEnv.UV_PYTHON_INSTALL_DIR, "/toolchains/uv-python");
  assert.equal(out.stepEnv.VIRTUAL_ENV, "/workspace/.venv");
  assert.equal(recipe.commands[0][4], image, "the input recipe is not changed");
  assert.equal(deps.withToolchains(recipe, []), recipe);
  // The fetch container is the one allowed to download, into the toolchain volume.
  assert.equal(r.pin.fetchEnv.UV_PYTHON_DOWNLOADS, "automatic");
  assert.match(r.pin.script, /uv python install '3\.11'/);
  // Node puts the pinned distribution first on PATH in both containers.
  const node = resolve("node", "20", ".nvmrc", "nvmrc").pin;
  assert.deepEqual(node.pathPrefix, ["/toolchains/node/by-request/20/bin"]);
  assert.match(node.script, /sha256sum -c/);
});

test("Playwright is detected from package.json and its browsers use a shared path in the toolchain volume", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-pw-"));
  try {
    fs.mkdirSync(path.join(dir, "web"));
    fs.writeFileSync(path.join(dir, "web", "package.json"), JSON.stringify({ devDependencies: { "@playwright/test": "^1.50.0" } }));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { left: "1" } }));
    assert.equal(deps.declaresPlaywright(unitOf("node", null, null, null, "web"), dir), true);
    assert.equal(deps.declaresPlaywright(unitOf("node", null, null, null, "."), dir), false);
    assert.equal(deps.declaresPlaywright(unitOf("python", null, null, null, "web"), dir), false);
    const pin = deps.playwrightPin("web", "/workspace/web/node_modules");
    assert.equal(pin.phase, "after-install");
    assert.equal(pin.stepEnv.PLAYWRIGHT_BROWSERS_PATH, "/toolchains/playwright");
    assert.equal(pin.installEnv.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, "1");
    assert.match(pin.script, /cd '\/workspace\/web'/);
    assert.match(pin.script, /install chromium/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the host record of fetched toolchains is machine-wide and tolerates a missing or damaged file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-tc-home-"));
  try {
    assert.deepEqual(deps.readToolchainState(home), { schemaVersion: 1, entries: {} });
    fs.writeFileSync(deps.toolchainStateFile(home), "{ not json");
    assert.deepEqual(deps.readToolchainState(home).entries, {});
    assert.equal(path.dirname(deps.toolchainStateFile(home)), home, "one file per machine, not per workspace");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
