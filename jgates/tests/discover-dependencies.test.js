import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fx from "./fixtures/discovery/index.js";
import * as deps from "./fixtures/deps/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");

/** Runs `jgates discover --json` on a temp tree built from `files` and returns the parsed document. */
function discoverCli(files) {
  const dir = fx.writeTree(files);
  try {
    const r = spawnSync(process.execPath, [MAIN, "discover", "--cwd", dir, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    fx.removeTree(dir);
  }
}

const dependenciesOf = (doc, root) => {
  const list = doc.classifications.filter((c) => c.componentRoot === root);
  assert.equal(list.length, 1, `expected one entry at ${root}`);
  return list[0].dependencies;
};

const CASES = [
  { tree: "uv", root: "app", manager: "uv", lockfile: "app/uv.lock", version: ">=3.11", sourceKind: "requires-python", source: "app/pyproject.toml", groups: ["main", "test"] },
  { tree: "poetry", root: "app", manager: "poetry", lockfile: "app/poetry.lock", version: "3.12.4", sourceKind: "python-version", source: "app/.python-version", groups: ["dev", "main"] },
  { tree: "pdm", root: "app", manager: "pdm", lockfile: "app/pdm.lock", version: ">=3.10", sourceKind: "requires-python", source: "app/pyproject.toml" },
  { tree: "pipenv", root: "app", manager: "pipenv", lockfile: "app/Pipfile.lock", version: "3.9.18", sourceKind: "runtime-txt", source: "app/runtime.txt" },
  { tree: "pip", root: "app", manager: "pip", lockfile: null, version: null, sourceKind: null, source: null, note: "sem lockfile" },
  { tree: "npm", root: "web", manager: "npm", lockfile: "web/package-lock.json", version: ">=20", sourceKind: "engines-node", source: "web/package.json", groups: ["devDependencies"] },
  { tree: "pnpm", root: "web", manager: "pnpm", lockfile: "web/pnpm-lock.yaml", version: "v20.11.1", sourceKind: "nvmrc", source: "web/.nvmrc" },
  { tree: "yarn-classic", root: "web", manager: "yarn", variant: "classic", lockfile: "web/yarn.lock", version: "18.19.0", sourceKind: "node-version", source: "web/.node-version" },
  { tree: "yarn-berry", root: "web", manager: "yarn", variant: "berry", lockfile: "web/yarn.lock", version: null, sourceKind: null, source: null },
  { tree: "go", root: "svc", manager: "go", lockfile: "svc/go.sum", version: "1.22.3", sourceKind: "go-mod-toolchain", source: "svc/go.mod" },
  { tree: "cargo", root: "crate", manager: "cargo", lockfile: "crate/Cargo.lock", version: "1.75.0", sourceKind: "rust-toolchain", source: "crate/rust-toolchain.toml" },
  { tree: "dotnet", root: "svc", manager: "dotnet", lockfile: "svc/packages.lock.json", version: "8.0.100", sourceKind: "global-json", source: "svc/global.json" },
];

for (const c of CASES) {
  test(`discover --json reports ${c.tree}: manager, lockfile, install root and language version source`, () => {
    const d = dependenciesOf(discoverCli(deps.managerTrees[c.tree]), c.root);
    assert.equal(d.state, "detected");
    assert.equal(d.manager, c.manager);
    assert.equal(d.variant ?? null, c.variant ?? null);
    assert.equal(d.lockfile, c.lockfile);
    assert.equal(d.installRoot, c.root);
    assert.equal(d.language.version, c.version);
    assert.equal(d.language.sourceKind, c.sourceKind);
    assert.equal(d.language.source, c.source);
    assert.equal(d.note, c.note ?? null);
    assert.equal(d.chosenBy, "detected");
    if (c.groups) assert.deepEqual(d.groups, c.groups);
  });
}

test("a pnpm workspace member installs from the container root, where the lockfile is", () => {
  const doc = discoverCli(deps.nodeWorkspaceTree());
  for (const root of ["packages/a", "packages/b"]) {
    const d = dependenciesOf(doc, root);
    assert.equal(d.manager, "pnpm");
    assert.equal(d.lockfile, "pnpm-lock.yaml");
    assert.equal(d.installRoot, ".");
    assert.equal(d.language.sourceKind, "engines-node");
    assert.equal(d.language.source, "package.json");
  }
});

test("uv.lock and poetry.lock together make the manager ambiguous, with both offered", () => {
  const d = dependenciesOf(discoverCli(deps.ambiguousTree()), "app");
  assert.equal(d.state, "ambiguous");
  assert.equal(d.manager, null);
  assert.deepEqual(d.candidates, ["poetry", "uv"]);
  assert.equal(d.reasonCode, "CONFLICTING_LOCKFILES");
  assert.equal(d.note, null);
});

test("bun.lockb is unsupported with a reason", () => {
  const d = dependenciesOf(discoverCli(deps.bunTree()), "web");
  assert.equal(d.state, "unsupported");
  assert.equal(d.manager, "bun");
  assert.equal(d.reasonCode, "BUN_UNSUPPORTED");
});

test("components[].dependencies.manager in workspace.yml overrides detection", () => {
  const ws = (body) => ({ ".jgates/workspace.yml": fx.workspaceYml(body) });
  const doc = discoverCli({
    ...deps.ambiguousTree(),
    ...ws("components:\n  - id: app\n    path: app\n    language: python\n    dependencies:\n      manager: poetry\n"),
  });
  const d = dependenciesOf(doc, "app");
  assert.equal(d.state, "configured");
  assert.equal(d.manager, "poetry");
  assert.equal(d.chosenBy, "workspace-config");
  assert.equal(d.lockfile, "app/poetry.lock");
  assert.deepEqual(d.candidates, []);

  const bun = discoverCli({
    ...deps.bunTree(),
    ...ws("components:\n  - id: web\n    path: web\n    language: typescript\n    dependencies:\n      manager: pnpm\n"),
  });
  const w = dependenciesOf(bun, "web");
  assert.equal(w.manager, "pnpm");
  assert.equal(w.state, "configured");
  assert.equal(w.note, "sem lockfile");
});

test("an unknown manager id in workspace.yml is rejected by the schema", () => {
  const dir = fx.writeTree({
    ...deps.noLockfileTree(),
    ".jgates/workspace.yml": fx.workspaceYml("components:\n  - id: web\n    path: web\n    dependencies:\n      manager: conda\n"),
  });
  try {
    const r = spawnSync(process.execPath, [MAIN, "discover", "--cwd", dir, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 3);
    assert.equal(JSON.parse(r.stdout).status, "INVALID");
  } finally {
    fx.removeTree(dir);
  }
});

test("a component without a lockfile carries the note 'sem lockfile' and still has a manager", () => {
  const d = dependenciesOf(discoverCli(deps.noLockfileTree()), "web");
  assert.equal(d.state, "detected");
  assert.equal(d.manager, "npm");
  assert.equal(d.lockfile, null);
  assert.equal(d.note, "sem lockfile");
});

test("detection spawns no process", async () => {
  const calls = [];
  const names = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
  const originals = {};
  for (const n of names) {
    originals[n] = childProcess[n];
    childProcess[n] = (...args) => {
      calls.push(`${n}:${String(args[0])}`);
      throw new Error(`process spawned: ${n}`);
    };
  }
  try {
    const { discoverWorkspace } = await import("../dist/core/discovery/index.js");
    for (const tree of [...Object.values(deps.managerTrees), deps.ambiguousTree(), deps.bunTree(), deps.noLockfileTree(), deps.nodeWorkspaceTree()]) {
      const dir = fx.writeTree(tree);
      try {
        const { inventory } = discoverWorkspace(dir);
        assert.ok(inventory.classifications.some((c) => c.dependencies !== null));
      } finally {
        fx.removeTree(dir);
      }
    }
  } finally {
    for (const n of names) childProcess[n] = originals[n];
  }
  assert.deepEqual(calls, []);
});
