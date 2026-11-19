import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-32: stack support is declared per capability and stack, with evidence, and a mixed repository gets it per unit.
// The fixture is a TypeScript package (web/), a Python package (api/) and a plain JavaScript folder (scripts/). The
// real discovery, matrix, plan and run services (and the CLI and the tools API over them) must agree: web and api are
// units of the build/type-check capability (tsc, mypy and pyright), scripts is a visible
// gap, the plan lists exactly the units the matrix says apply, and the run turns each unit's type error into a finding
// located inside that unit. The Python checkers come from a throwaway virtual environment unless JGATES_MYPY and
// JGATES_PYRIGHT name existing installations.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(root, "jgates", "dist");
const FIXTURE = path.join(root, "tests", "v2", "fixtures", "v2-32");
const MAIN = path.join(DIST, "cli", "main.js");
const load = (...parts) => import(pathToFileURL(path.join(DIST, ...parts)).href);

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

function pythonCheckerEnv() {
  if (process.env.JGATES_MYPY && process.env.JGATES_PYRIGHT) return {};
  const venv = path.join(tmp("v2-32-venv-"), "venv");
  const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", timeout: 600_000 });
  assert.equal(run(process.platform === "win32" ? "python" : "python3", ["-m", "venv", venv]).status, 0, "python -m venv");
  const bin = path.join(venv, process.platform === "win32" ? "Scripts" : "bin");
  const py = path.join(bin, process.platform === "win32" ? "python.exe" : "python");
  const installed = run(py, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "mypy", "pyright"]);
  assert.equal(installed.status, 0, `pip install mypy pyright failed: ${installed.stderr}`);
  const exe = process.platform === "win32" ? ".exe" : "";
  return {
    JGATES_MYPY: process.env.JGATES_MYPY ?? path.join(bin, `mypy${exe}`),
    JGATES_PYRIGHT: process.env.JGATES_PYRIGHT ?? path.join(bin, `pyright${exe}`),
  };
}

test("V2-32: a mixed TypeScript and Python repository gets per-unit build and type-check applicability, and the matrix, the CLI plan JSON and the tools API agree", async () => {
  try {
    const home = tmp("v2-32-home-");
    const dir = tmp("v2-32-ws-");
    const env = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", NO_COLOR: "1", ...pythonCheckerEnv() };
    fs.cpSync(FIXTURE, dir, { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
    const { planInit, writeInit } = await load("core", "init", "index.js");
    writeInit(dir, planInit(dir, "minimal"));
    const cli = (args) => {
      const r = spawnSync(process.execPath, [MAIN, ...args, "--json"], { encoding: "utf8", env, input: "", timeout: 240_000 });
      let doc = null;
      try {
        doc = JSON.parse(r.stdout);
      } catch {
        doc = null;
      }
      assert.ok(doc, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      return { code: r.status, doc };
    };

    // Discovery and the matrix: per-unit applicability.
    const { discoverWorkspace } = await load("core", "discovery", "index.js");
    const { buildMatrix, unitApplicability, verifyMatrix } = await load("core", "matrix", "index.js");
    const inventory = discoverWorkspace(dir).inventory;
    const matrix = buildMatrix();
    assert.deepEqual(verifyMatrix(matrix), []);
    const units = unitApplicability(inventory, matrix);
    const unit = (root) => units.find((u) => u.componentRoot === root);
    const web = unit("web");
    const api = unit("api");
    const scripts = unit("scripts");
    assert.deepEqual([web?.language, api?.language, scripts?.language], ["typescript", "python", "javascript"]);
    assert.ok(web.validated.includes("typecheck"), "web gets the validated typecheck row");
    assert.ok(api.validated.includes("typecheck"), "api gets the validated typecheck row");
    assert.ok(scripts.gaps.includes("typecheck"), "plain JavaScript is a visible typecheck gap");
    assert.deepEqual(web.rows.filter((r) => r.capability === "typecheck").map((r) => r.key), ["build-check#typecheck@typescript"]);
    assert.deepEqual(api.rows.filter((r) => r.capability === "typecheck").map((r) => r.key), ["build-check#typecheck@python"]);
    assert.deepEqual(scripts.rows.filter((r) => r.capability === "typecheck").map((r) => `${r.key}:${r.state}`), ["build-check#typecheck@javascript:unsupported"], "the JavaScript unit only gets an unsupported typecheck row");
    const expected = new Map(units.filter((u) => u.validated.includes("typecheck")).map((u) => [u.componentRoot, u.language]));
    assert.deepEqual([...expected.keys()].sort(), ["api", "web"]);

    // The CLI (tools matrix --units) and the tools API (GET /api/tool-matrix) report the same matrix and applicability.
    const viaCli = cli(["tools", "matrix", "--units", "--cwd", dir]).doc;
    assert.equal(viaCli.status, "OK");
    assert.deepEqual(viaCli.problems, []);
    assert.deepEqual(viaCli.applicability, units);
    const { routes } = await load("server", "routes", "tools.js");
    const route = routes.find((r) => r.method === "GET" && r.path === "/api/tool-matrix");
    const viaApi = await route.handler({ server: { projectDir: dir, home, log: () => undefined } });
    assert.equal(viaApi.status, 200);
    assert.deepEqual(viaApi.json.applicability, units);
    const rowKeys = (m) => m.rows.filter((r) => r.adapter === "build-check").map((r) => `${r.key}:${r.state}`);
    assert.deepEqual(rowKeys(viaCli.matrix), rowKeys(matrix));
    assert.deepEqual(rowKeys(viaApi.json.matrix), rowKeys(matrix));
    for (const stack of ["typescript", "python", "go", "rust", "csharp"]) {
      assert.ok(rowKeys(matrix).includes(`build-check#typecheck@${stack}:validated`), `${stack} is declared validated`);
    }

    // The CLI plan JSON lists exactly the units the matrix says apply, per checker.
    const planned = cli(["plan", "--cwd", dir, "--only", "capability:typecheck"]).doc;
    assert.equal(planned.status, "OK");
    const willRun = planned.plan.groups.willRun.filter((i) => i.adapter === "build-check");
    const checkers = ["mypy", "pyright", "tsc"];
    assert.deepEqual(willRun.map((i) => i.id).sort(), checkers.map((checker) => `${checker}#typecheck`));
    assert.ok(willRun.every((i) => i.availability.status === "available"), JSON.stringify(willRun.map((i) => i.availability)));
    const contractUnits = planned.plan.invocations.filter((i) => i.adapter === "build-check").flatMap((i) => i.contract.units.map((u) => ({ checker: i.contract.checker, root: u.root, language: u.language })));
    assert.deepEqual([...new Set(contractUnits.map((u) => u.root))].sort(), [...expected.keys()].sort());
    for (const u of contractUnits) assert.equal(u.language, expected.get(u.root), `${u.root}: the plan and the matrix agree on the stack`);
    assert.deepEqual(contractUnits.map((u) => `${u.root}:${u.checker}`).sort(), ["api:mypy", "api:pyright", "web:tsc"]);
    assert.ok(planned.plan.invocations.every((i) => !i.contract?.skipped?.length), "no unit with a checker is skipped here");
    // The plan names the components of the repository, scripts included: it is not a unit of any build-check instance.
    assert.ok(planned.plan.components.some((c) => c.root === "scripts"));
    assert.equal(contractUnits.some((u) => u.root === "scripts"), false);

    // The same plan through the service, and the run: each unit's error is a finding located inside that unit.
    const { buildPlan } = await load("core", "plan", "index.js");
    const { executeRun } = await load("core", "run", "index.js");
    const { planSteps, planDisabled } = await load("core", "run", "plan-run.js");
    const plan = () => {
      const built = buildPlan(dir, { only: ["capability:typecheck"], env, home, compare: false, version: "test" });
      assert.equal(built.ok, true, JSON.stringify(built.errors ?? built.error));
      return built.plan;
    };
    const run = (p) =>
      executeRun({
        workspacePath: dir,
        home,
        version: "test",
        adapter: "quality-bridge",
        options: { planHash: p.planHash, planSource: "built", profile: "minimal", scope: "full" },
        plan: p,
        steps: (context) => planSteps(context, p),
        disabled: planDisabled(p),
        env,
        cache: false,
      });
    const failed = await run(plan());
    assert.equal(failed.decision, "failed");
    for (const { id } of willRun) assert.equal(failed.stages.find((s) => s.id === id)?.state, "completed", id);
    const found = failed.findings.filter((f) => f.origin === "build-check");
    const at = (tool) => found.filter((f) => f.tool === tool);
    assert.equal(at("tsc").length, 1);
    assert.equal(at("mypy").length, 1);
    assert.equal(at("tsc")[0].location.path, "web/src/index.ts");
    assert.equal(at("tsc")[0].location.line, 1);
    assert.equal(at("tsc")[0].ruleId, "TS2322");
    assert.equal(at("mypy")[0].location.path, "api/app.py");
    assert.equal(at("mypy")[0].location.line, 5);
    assert.equal(at("mypy")[0].ruleId, "arg-type");
    assert.equal(at("pyright").length, 1);
    assert.equal(at("pyright")[0].location.path, "api/app.py");
    assert.equal(at("pyright")[0].location.line, 5);
    assert.equal(at("pyright")[0].ruleId, "reportArgumentType");
    assert.ok(found.every((f) => f.blocking && f.category === "typecheck"));
    assert.equal(found.some((f) => f.location.path.startsWith("scripts/")), false, "the JavaScript unit is never reported as checked");

    // The clean twin of both units: no finding, and the decision turns favorable only now.
    fs.writeFileSync(path.join(dir, "web", "src", "index.ts"), "export const total: number = 42;\n");
    fs.writeFileSync(path.join(dir, "api", "app.py"), "def double(value: int) -> int:\n    return value * 2\n\n\nresult: int = double(21)\n");
    const passed = await run(plan());
    assert.equal(passed.decision, "passed", JSON.stringify(passed.stages));
    assert.equal(passed.findings.filter((f) => f.origin === "build-check").length, 0);
    for (const { id } of willRun) assert.equal(passed.stages.find((s) => s.id === id)?.state, "completed", id);
  } finally {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
