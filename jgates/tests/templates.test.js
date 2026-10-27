import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Built-in templates per stack: Python and TypeScript compose the new adapters in the right components,
// ESLint, pytest and Vitest only by the evidence of their configuration (match.files) or by explicit choice,
// .NET declares its partial support, and no template installs anything.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");
const mainFixture = createRequire(import.meta.url)(path.join(repo, "tests", "fixtures", "jgates", "main-fixture.js"));

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

function cli(dir, args) {
  const home = tmp("jgates-tpl-home-");
  const bin = tmp("jgates-tpl-bin-");
  try {
    const r = spawnSync(process.execPath, [MAIN, ...args, "--cwd", dir, "--json"], {
      encoding: "utf8",
      input: "",
      timeout: 120_000,
      env: { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", PATH: bin },
    });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout + r.stderr, doc };
  } finally {
    for (const d of [home, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
}

function root(templates) {
  const list = templates.map((t) => `  - id: ${t}\n    source: builtin:${t}\n    activation: ${t === "base" || t === "python-typescript" ? "always" : "detected"}\n`).join("");
  return `schemaVersion: 1\nselection:\n  profile: builtin:strict\ntemplates:\n${list}`;
}

function planOf(dir) {
  const r = cli(dir, ["plan"]);
  assert.ok(r.doc?.plan ?? r.doc?.items ?? r.doc, r.out);
  return r.doc.plan ?? r.doc;
}

const allItems = (plan) => [...plan.groups.willRun, ...plan.groups.notApplicableOrDisabled];
const itemsOf = (plan, tool) => allItems(plan).filter((i) => i.tool === tool);
const templateOf = (item) => item.includedBy.filter((i) => i.kind === "template").map((i) => i.entry);

test("the main fixture gets Ruff, pytest, Import Linter, ESLint, Vitest and dependency-cruiser in the right components", () => {
  const { dir } = mainFixture.createMainFixture();
  try {
    // The configuration evidence of ESLint, pytest and Vitest (match.files of their templates).
    fs.appendFileSync(path.join(dir, "api", "pyproject.toml"), '\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
    write(dir, "eslint.config.js", "export default [];\n");
    write(dir, "web/vitest.config.ts", "export default {};\n");
    write(dir, ".jgates/architecture.yml", "schemaVersion: 1\narchitecture:\n  layers:\n    - id: domain\n      paths: [\"api/src/shop_api/domain/**\"]\n    - id: infrastructure\n      paths: [\"api/src/shop_api/infrastructure/**\"]\n  rules:\n    - id: domain-independent\n      kind: forbidden-dependency\n      from: domain\n      to: [infrastructure]\n");
    write(dir, "jgates.yml", root(["base", "python", "python-import-linter", "python-pytest", "typescript", "typescript-dependency-cruiser", "typescript-eslint", "typescript-vitest"]));
    const plan = planOf(dir);
    const expected = {
      ruff: { components: ["api"], template: "python" },
      "import-linter": { components: ["api"], template: "python-import-linter" },
      pytest: { components: ["api"], template: "python-pytest" },
      eslint: { components: ["libs-shared", "web"], template: "typescript-eslint" },
      "dependency-cruiser": { components: ["libs-shared", "web"], template: "typescript-dependency-cruiser" },
      vitest: { components: ["libs-shared", "web"], template: "typescript-vitest" },
    };
    for (const [tool, want] of Object.entries(expected)) {
      const found = itemsOf(plan, tool);
      assert.ok(found.length > 0, `${tool} is not in the plan`);
      for (const item of found) {
        assert.deepEqual(item.components.map((c) => c.id).sort(), want.components, `${tool} components`);
        assert.ok(templateOf(item).includes(want.template), `${tool} should come from ${want.template}, got ${templateOf(item)}`);
      }
    }
  } finally {
    mainFixture.removeFixture(dir);
  }
});

test("a Python repository without pytest configured does not get pytest, nor Vitest on a TypeScript one", () => {
  const { dir } = mainFixture.createMainFixture();
  try {
    // The default templates (no pytest/Vitest entry) are what init writes.
    const init = cli(dir, ["init", "--profile", "strict", "--no-interactive"]);
    assert.equal(init.code, 0, init.out);
    const plan = planOf(dir);
    assert.deepEqual(itemsOf(plan, "pytest"), []);
    assert.deepEqual(itemsOf(plan, "vitest"), []);
    assert.ok(itemsOf(plan, "ruff").length > 0);
    assert.ok(!JSON.stringify(plan.templates.active).includes("python-pytest"));
    // The explicit choice (a tool instance of the project) is what brings it in.
    write(dir, ".jgates/tools.yml", "schemaVersion: 1\ntools:\n  pytest:\n    adapter: pytest\n    component: api\n    capabilities: [unit]\n");
    const chosen = planOf(dir);
    assert.ok(itemsOf(chosen, "pytest").length > 0);
  } finally {
    mainFixture.removeFixture(dir);
  }
});

test("a minimal .NET repository gets the dotnet template with the declared support and what it does not cover", () => {
  const dir = tmp("jgates-tpl-dotnet-");
  try {
    write(dir, "App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n');
    write(dir, "App/Program.cs", "System.Console.WriteLine(\"hi\");\n");
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const init = cli(dir, ["init", "--no-interactive"]);
    assert.equal(init.code, 0, init.out);
    assert.match(fs.readFileSync(path.join(dir, "jgates.yml"), "utf8"), /builtin:dotnet/);
    const plan = planOf(dir);
    const active = plan.templates.active.find((t) => t.id === "dotnet");
    assert.ok(active, JSON.stringify(plan.templates));
    assert.equal(active.source, "builtin:dotnet");
    assert.equal(active.support.level, "partial");
    for (const word of ["dotnet build", "dotnet test", "Cobertura", "Roslyn"]) {
      assert.ok(active.support.uncovered.some((u) => u.includes(word)), `uncovered should mention ${word}: ${active.support.uncovered}`);
    }
    // The chain that exists today (the bridge) is what runs; nothing .NET specific is invented.
    assert.ok(allItems(plan).some((i) => i.adapter === "quality-bridge"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no built-in template installs or migrates a framework: the plan has no installation step", () => {
  const { dir } = mainFixture.createMainFixture();
  try {
    write(dir, "jgates.yml", root(["base", "python", "python-pytest", "python-typescript", "typescript", "typescript-vitest", "go", "rust", "dotnet"]));
    const plan = planOf(dir);
    const commands = plan.invocations.map((i) => [i.command.executable, ...i.command.args].join(" "));
    for (const c of commands) assert.doesNotMatch(c, /\b(install|add|npx|npm i|pip|uv sync|migrate|init)\b/, c);
    for (const item of allItems(plan)) assert.equal(item.effects?.mayChangeCode ?? false, false, `${item.id} may change code`);
    assert.ok(plan.templates.active.some((t) => t.id === "python-typescript"));
  } finally {
    mainFixture.removeFixture(dir);
  }
});
