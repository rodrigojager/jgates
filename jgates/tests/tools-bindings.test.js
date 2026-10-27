import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");

function run(dir, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jg-tb-home-"));
  try {
    const r = spawnSync(process.execPath, [MAIN, ...args, "--cwd", dir, "--json"], { encoding: "utf8", env: { ...process.env, JGATES_HOME: home }, timeout: 20000 });
    return { status: r.status, doc: JSON.parse(r.stdout) };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function withProject(files, tools, fn, extra) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jg-tb-")));
  try {
    const all = { "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/tools.yml\n", ".jgates/tools.yml": `schemaVersion: 1\n${tools}`, ...files };
    for (const [name, content] of Object.entries(all)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    if (extra) extra(dir);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SHORT = `tools:
  ruff-api:
    adapter: ruff
    component: api
    runner: local
    config: apps/api/pyproject.toml
  pytest-api:
    adapter: pytest
    component: api
    config: apps/api/pyproject.toml
`;

test("two instances on the same pyproject share one document identity", () => {
  withProject({ "apps/api/pyproject.toml": "[tool.ruff]\n" }, SHORT, (dir) => {
    const a = run(dir, ["tools", "inspect", "ruff-api"]).doc.instance.bindings[0];
    const b = run(dir, ["tools", "inspect", "pytest-api"]).doc.instance.bindings[0];
    assert.equal(a.identity, b.identity);
    assert.equal(a.identity, path.join(dir, "apps/api/pyproject.toml"));
    assert.equal(a.exists, true);
  });
});

test("expanded form with a directory rules binding lists the files matching include", () => {
  const tools = `tools:
  semgrep-repo:
    adapter: semgrep
    runner: container
    configFiles:
      rules:
        path: .jgates/rules
        kind: directory
        role: rules
        access: write
        include: ["**/*.yml", "*.yml"]
`;
  withProject({ ".jgates/rules/a.yml": "a: 1\n", ".jgates/rules/sub/b.yml": "b: 1\n", ".jgates/rules/c.txt": "c\n" }, tools, (dir) => {
    const doc = run(dir, ["tools", "inspect", "semgrep-repo"]).doc;
    const b = doc.instance.bindings[0];
    assert.equal(b.kind, "directory");
    assert.equal(b.role, "rules");
    assert.deepEqual(b.files.map((f) => f.path).sort(), ["a.yml", "sub/b.yml"]);
  });
});

test("a missing file is reported absent and nothing is created", () => {
  withProject({}, SHORT, (dir) => {
    const before = fs.readdirSync(dir, { recursive: true }).sort();
    const b = run(dir, ["tools", "inspect", "ruff-api"]).doc.instance.bindings[0];
    assert.equal(b.exists, false);
    assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), before);
    assert.equal(fs.existsSync(path.join(dir, "apps")), false);
  });
});

test("../ and symlink escapes are refused with a diagnostic", () => {
  const tools = `tools:
  up:
    adapter: x
    config: ../outside.toml
  link:
    adapter: x
    config: linked/secret.toml
`;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jg-tb-out-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.toml"), "x");
    withProject({}, tools, (dir) => {
      const up = run(dir, ["tools", "inspect", "up"]).doc;
      assert.equal(up.instance.bindings[0].refused, true);
      assert.ok(up.diagnostics.some((d) => d.code === "BINDING_OUTSIDE_ROOT"));
      const link = run(dir, ["tools", "inspect", "link"]).doc;
      assert.equal(link.instance.bindings[0].refused, true);
      assert.ok(link.diagnostics.some((d) => d.code === "BINDING_SYMLINK_ESCAPE"));
    }, (dir) => fs.symlinkSync(outside, path.join(dir, "linked")));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a declared external root allows a file outside the workspace", () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jg-tb-ext-")));
  try {
    fs.writeFileSync(path.join(outside, "shared.toml"), "x");
    const tools = `externalRoots:
  - id: shared
    path: ${outside}
tools:
  t:
    adapter: x
    config:
      path: shared.toml
      root: shared
`;
    withProject({}, tools, (dir) => {
      const b = run(dir, ["tools", "inspect", "t"]).doc.instance.bindings[0];
      assert.equal(b.refused, false);
      assert.equal(b.exists, true);
      assert.equal(b.root, "shared");
    });
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("tools list shows each instance with its support level", () => {
  withProject({ "apps/api/pyproject.toml": "" }, SHORT + "  bridge:\n    adapter: quality-bridge\n", (dir) => {
    const r = run(dir, ["tools", "list"]);
    assert.equal(r.status, 0);
    const byId = Object.fromEntries(r.doc.instances.map((i) => [i.id, i]));
    // The Ruff manifest declares the form (Options tab), so the level is "assisted configuration".
    assert.equal(byId["ruff-api"].supportLevel, "assisted");
    assert.equal(byId["ruff-api"].runner, "local");
    assert.equal(byId["ruff-api"].component, "api");
    assert.equal(byId.bridge.supportLevel, "editable-file");
    assert.ok(r.doc.adapters.length > 0);
  });
});

test("an instance without adapter manifest and bindings is unavailable", () => {
  withProject({}, "tools:\n  lonely:\n    adapter: nothing\n", (dir) => {
    assert.equal(run(dir, ["tools", "list"]).doc.instances[0].supportLevel, "unavailable");
  });
});

test("an unknown instance exits 3", () => {
  withProject({}, SHORT, (dir) => {
    const r = run(dir, ["tools", "inspect", "nope"]);
    assert.equal(r.status, 3);
    assert.equal(r.doc.code, "INSTANCE_NOT_FOUND");
  });
});

test("help shows the translated descriptions of tools and workspaces", () => {
  const r = spawnSync(process.execPath, [MAIN, "help"], { encoding: "utf8" });
  assert.ok(!r.stdout.includes("tools_description"));
  assert.ok(!r.stdout.includes("workspaces_description"));
  assert.match(r.stdout, /catálogo de categorias/);
  assert.match(r.stdout, /workspaces conhecidos/);
});
