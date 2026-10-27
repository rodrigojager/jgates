import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as fx from "./fixtures/discovery/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");
const discovery = await import(pathToFileURL(path.resolve(here, "..", "dist", "core", "discovery", "index.js")).href);
const require = createRequire(import.meta.url);
const mainFixture = require("../../tests/fixtures/jgates/main-fixture.js");

/** Runs fn with a temp tree built from `files`; always removes it. */
function withTree(files, fn) {
  const dir = fx.writeTree(files);
  try {
    return fn(dir);
  } finally {
    fx.removeTree(dir);
  }
}

const discover = (dir, options) => discovery.discoverWorkspace(dir, options).inventory;
const byRoot = (inv, root) => inv.classifications.filter((c) => c.componentRoot === root);
const one = (inv, root) => {
  const list = byRoot(inv, root);
  assert.equal(list.length, 1, `expected one entry at ${root}, got ${JSON.stringify(list)}`);
  return list[0];
};
const workspace = (body) => ({ ".jgates/workspace.yml": fx.workspaceYml(body) });

test("main fixture: web, api and shared library are found with their manifests as evidence", () => {
  const { dir } = mainFixture.createMainFixture();
  try {
    const inv = discover(dir);
    const detected = inv.classifications.filter((c) => c.classificationStatus === "detected");
    assert.deepEqual(detected.map((c) => c.componentRoot), ["api", "libs/shared", "web"]);
    assert.equal(one(inv, "web").language, "typescript");
    assert.deepEqual(one(inv, "web").evidencePaths, ["web/package.json", "web/tsconfig.json"]);
    assert.equal(one(inv, "api").language, "python");
    assert.ok(one(inv, "api").evidencePaths.includes("api/pyproject.toml"));
    assert.equal(one(inv, "libs/shared").language, "typescript");
    assert.deepEqual(one(inv, "libs/shared").evidencePaths, ["libs/shared/package.json", "libs/shared/tsconfig.json"]);
    for (const c of detected) {
      assert.equal(c.detectorVersion, inv.detectorVersion);
      assert.ok(c.detectedBy && c.reasonCode);
      assert.equal(c.approvable, true);
      assert.equal("confidence" in c, false);
    }
    assert.deepEqual(inv.languages, ["python", "typescript"]);
  } finally {
    mainFixture.removeFixture(dir);
  }
});

test("a component declared in workspace.yml is explicit and prevails over detection of the same path", () => {
  const files = {
    ...fx.filterTree(),
    ...workspace("components:\n  - id: storefront\n    path: web\n    language: typescript\n    framework: react\n"),
  };
  withTree(files, (dir) => {
    const r = discovery.discoverWorkspace(dir);
    assert.deepEqual(r.diagnostics, []);
    const web = one(r.inventory, "web");
    assert.equal(web.classificationStatus, "explicit");
    assert.equal(web.id, "storefront");
    assert.equal(web.framework, "react");
    assert.equal(web.reasonCode, "DECLARED_IN_CONFIG");
    assert.ok(web.evidencePaths.includes(".jgates/workspace.yml"));
    assert.ok(web.evidencePaths.includes("web/package.json"));
    assert.equal(one(r.inventory, "api").classificationStatus, "detected");
  });
});

test("a declared path that does not exist is reported as an inconsistency and is not approvable", () => {
  withTree({ ...fx.filterTree(), ...workspace("components:\n  - id: ghost\n    path: nowhere\n") }, (dir) => {
    const inv = discover(dir);
    assert.deepEqual(inv.inconsistencies, [{ code: "DECLARED_PATH_MISSING", componentRoot: "nowhere", id: "ghost" }]);
  });
});

test("an unsupported language is reported with its reason and is never approvable", () => {
  withTree(fx.unsupportedTree(), (dir) => {
    const inv = discover(dir);
    const java = one(inv, "services/legacy");
    assert.equal(java.classificationStatus, "unsupported");
    assert.equal(java.language, "java");
    assert.equal(java.reasonCode, "UNSUPPORTED_LANGUAGE");
    assert.equal(java.approvable, false);
    assert.deepEqual(java.evidencePaths, ["services/legacy/pom.xml"]);
    const ruby = one(inv, "tools");
    assert.equal(ruby.classificationStatus, "unsupported");
    assert.equal(ruby.detectedBy, "unsupported-extension");
    assert.equal(ruby.approvable, false);
    assert.equal(one(inv, "web").approvable, true);
    assert.deepEqual(inv.languages, ["typescript"]);
  });
});

test("exclude wins over include and over detection; include narrows the candidates", () => {
  withTree({ ...fx.filterTree(), ...workspace("include:\n  - libs/**\n  - web\nexclude:\n  - libs/legacy\n") }, (dir) => {
    const inv = discover(dir);
    assert.equal(one(inv, "web").classificationStatus, "detected");
    assert.equal(one(inv, "libs/shared").classificationStatus, "detected");
    const legacy = one(inv, "libs/legacy");
    assert.equal(legacy.classificationStatus, "ignored");
    assert.equal(legacy.reasonCode, "EXCLUDED_BY_RULE");
    assert.equal(legacy.approvable, false);
    const api = one(inv, "api");
    assert.equal(api.classificationStatus, "ignored");
    assert.equal(api.reasonCode, "NOT_INCLUDED");
  });
  withTree({ ...fx.filterTree(), ...workspace("exclude:\n  - web\ncomponents:\n  - id: web\n    path: web\n") }, (dir) => {
    assert.equal(one(discover(dir), "web").classificationStatus, "ignored", "exclude also wins over a declaration");
  });
});

test("report-only reports everything and activates no template", () => {
  withTree({ ...fx.filterTree(), ...workspace("discovery:\n  mode: report-only\n") }, (dir) => {
    const inv = discover(dir);
    assert.equal(inv.mode, "report-only");
    assert.equal(inv.templatesActive, false);
    assert.equal(inv.summary.detected, 4);
    assert.ok(inv.classifications.every((c) => c.approvable === false));
    assert.deepEqual(inv.languages, []);
  });
});

test("explicit mode keeps only the declared components and leaves the rest ignored", () => {
  withTree({ ...fx.filterTree(), ...workspace("discovery:\n  mode: explicit\ncomponents:\n  - id: api\n    path: api\n") }, (dir) => {
    const inv = discover(dir);
    assert.equal(inv.mode, "explicit");
    assert.equal(one(inv, "api").classificationStatus, "explicit");
    const web = one(inv, "web");
    assert.equal(web.classificationStatus, "ignored");
    assert.equal(web.reasonCode, "NOT_DECLARED_IN_EXPLICIT_MODE");
    assert.equal(web.approvable, false);
    assert.deepEqual(inv.languages, ["python"]);
  });
});

test("lockfiles of npm and pnpm in the same root are ambiguous", () => {
  withTree(fx.conflictTree(), (dir) => {
    const web = one(discover(dir), "web");
    assert.equal(web.classificationStatus, "ambiguous");
    assert.equal(web.reasonCode, "CONFLICTING_LOCKFILES");
    assert.equal(web.packageManager, null);
    assert.deepEqual(web.evidencePaths, ["web/package-lock.json", "web/package.json", "web/pnpm-lock.yaml"]);
    assert.equal(web.approvable, false);
  });
});

test("a nested project outside any workspace is ambiguous", () => {
  withTree(fx.nestedTree(), (dir) => {
    const inv = discover(dir);
    assert.equal(one(inv, "app").classificationStatus, "detected");
    assert.equal(one(inv, "app").packageManager, "npm");
    const nested = one(inv, "app/examples/demo");
    assert.equal(nested.classificationStatus, "ambiguous");
    assert.equal(nested.reasonCode, "NESTED_PROJECT");
    assert.ok(nested.evidencePaths.includes("app/package.json"));
  });
});

test("workspace members take the package manager from the root lockfile; the root is not a component", () => {
  withTree(fx.workspaceTree(), (dir) => {
    const inv = discover(dir);
    assert.deepEqual(inv.classifications.map((c) => c.componentRoot), ["packages/a", "packages/b"]);
    const a = one(inv, "packages/a");
    assert.equal(a.packageManager, "pnpm");
    assert.equal(a.reasonCode, "WORKSPACE_MEMBER");
    assert.equal(a.framework, "react");
    assert.ok(a.evidencePaths.includes("pnpm-lock.yaml") && a.evidencePaths.includes("package.json"));
  });
});

test("Go, Cargo, .NET and loose Python manifests are detected", () => {
  withTree(fx.familiesTree(), (dir) => {
    const inv = discover(dir);
    assert.equal(one(inv, "go").language, "go");
    assert.equal(one(inv, "go").framework, "gin");
    assert.equal(one(inv, "rust").language, "rust");
    assert.equal(one(inv, "rust").framework, "axum");
    assert.deepEqual(one(inv, "rust").evidencePaths, ["rust/Cargo.lock", "rust/Cargo.toml"]);
    const app = one(inv, "dotnet/src/App");
    assert.equal(app.language, "csharp");
    assert.equal(app.reasonCode, "SOLUTION_MEMBER");
    assert.ok(app.evidencePaths.includes("dotnet/App.sln"));
    assert.equal(one(inv, "dotnet/src/Lib").language, "fsharp");
    const py = one(inv, "scripts");
    assert.equal(py.language, "python");
    assert.equal(py.framework, "flask");
  });
});

test("node_modules, caches and vendor are not indexed as components", () => {
  withTree(fx.vendorTree(), (dir) => {
    const inv = discover(dir);
    assert.equal(one(inv, "web").classificationStatus, "detected");
    const vendor = one(inv, "vendor");
    assert.equal(vendor.classificationStatus, "ignored");
    assert.equal(vendor.reasonCode, "VENDOR_DIRECTORY");
    assert.equal(inv.classifications.length, 2);
    assert.equal(inv.indexed.entries, 1);
  });
});

test("no process is started: manifests with scripts that would write a marker leave no marker", () => {
  const marker = path.join(os.tmpdir(), `jg-marker-${process.pid}-${Date.now()}`);
  withTree(fx.markerTree(marker), (dir) => {
    const inv = discover(dir);
    assert.ok(inv.classifications.length >= 3);
    const cli = spawnSync(process.execPath, [MAIN, "discover", "--cwd", dir, "--json"], { encoding: "utf8" });
    assert.equal(cli.status, 0);
  });
  assert.equal(fs.existsSync(marker), false);
  const source = fs.readdirSync(path.resolve(here, "..", "dist", "core", "discovery")).filter((f) => f.endsWith(".js"));
  for (const f of source) {
    const text = fs.readFileSync(path.resolve(here, "..", "dist", "core", "discovery", f), "utf8");
    assert.doesNotMatch(text, /child_process/, `${f} must not import child_process`);
  }
});

test("two discoveries of the same tree with the directory order shuffled give identical JSON", () => {
  const files = { ...fx.workspaceTree(), ...fx.familiesTree(), ...fx.unsupportedTree(), ...fx.vendorTree(), ...fx.conflictTree() };
  withTree(files, (dir) => {
    const shuffling = (seed) => (absDir) => {
      let s = seed;
      const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const entries = fs.readdirSync(absDir, { withFileTypes: true }).map((d) => ({ name: d.name, kind: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other" }));
      for (let i = entries.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [entries[i], entries[j]] = [entries[j], entries[i]];
      }
      return entries;
    };
    const a = JSON.stringify(discover(dir, { readDir: shuffling(1) }), null, 2);
    const b = JSON.stringify(discover(dir, { readDir: shuffling(99) }), null, 2);
    const c = JSON.stringify(discover(dir), null, 2);
    assert.equal(a, b);
    assert.equal(a, c);
    const runs = [1, 2].map(() => spawnSync(process.execPath, [MAIN, "discover", "--cwd", dir, "--json"], { encoding: "utf8" }).stdout);
    assert.equal(runs[0], runs[1]);
    assert.ok(runs[0].length > 100);
  });
});

test("CLI: discover --json prints the inventory; an invalid workspace.yml exits 3 with diagnostics", () => {
  withTree(fx.filterTree(), (dir) => {
    const r = spawnSync(process.execPath, [MAIN, "discover", "--cwd", dir, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.status, "OK");
    assert.equal(doc.summary.detected, 4);
    const text = spawnSync(process.execPath, [MAIN, "discover", "--cwd", dir], { encoding: "utf8" });
    assert.equal(text.status, 0);
    assert.match(text.stdout, /detectado/);
  });
  withTree({ ...fx.filterTree(), ...workspace("discovery:\n  mode: sometimes\n") }, (dir) => {
    const r = spawnSync(process.execPath, [MAIN, "discover", "--cwd", dir, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 3);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.status, "INVALID");
    assert.ok(doc.diagnostics.length > 0);
  });
  const missing = spawnSync(process.execPath, [MAIN, "discover", "--cwd", "/nonexistent-jgates-dir", "--json"], { encoding: "utf8" });
  assert.equal(missing.status, 3);
});
