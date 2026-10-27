import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Architecture coverage in result.json. Built on the dependency-cruiser fixture: the contract of architecture.yml over
// the graph of a TypeScript workspace: the component boundary, cycles, the resolved executable (no download), and
// unresolved imports as a gap.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const adapter = await import(pathToFileURL(path.join(dist, "adapters", "dependency-cruiser", "index.js")).href);
const catalog = await import(pathToFileURL(path.join(dist, "adapters", "manifests.js")).href);
const FIXTURES = path.join(here, "fixtures", "parsers", "dependency-cruiser");

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const TSCONFIG = json({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true } });
const TOOLS = "schemaVersion: 1\ntools:\n  dependency-cruiser:\n    adapter: dependency-cruiser\n    capabilities: [architecture]\n";
const BOUNDARY = `schemaVersion: 1
architecture:
  rules:
    - id: shared-is-independent
      kind: component-boundary
      component: libs-shared
      allowedDependencies: []
      severity: high
      blocking: true
`;
const CYCLES = `schemaVersion: 1
architecture:
  rules:
    - id: no-import-cycles
      kind: no-cycles
      severity: high
      blocking: true
`;

const FILES = {
  "web/package.json": json({ name: "shop-web", version: "0.1.0", private: true }),
  "web/tsconfig.json": TSCONFIG,
  "web/src/app.ts": 'export function render(): string {\n  return "web";\n}\n',
  "libs/shared/package.json": json({ name: "shop-shared", version: "0.1.0", private: true }),
  "libs/shared/tsconfig.json": TSCONFIG,
  "libs/shared/src/format.ts": 'import { render } from "../../../web/src/app.js";\n\nexport function title(): string {\n  return render();\n}\n',
};

function project(files, architectureYml, extraEnv = {}) {
  const dir = tmp("jgates-dc-ws-");
  const home = tmp("jgates-dc-home-");
  const emptyBin = tmp("jgates-dc-bin-");
  for (const [rel, content] of Object.entries({ ...files })) {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_NO_CACHE: "1", PATH: emptyBin, ...extraEnv };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: "", timeout: 240_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const init = cli(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), TOOLS);
  if (architectureYml !== null) fs.writeFileSync(path.join(dir, ".jgates", "architecture.yml"), architectureYml);
  const plan = () => cli(["plan", "--cwd", dir, "--only", "tool:dependency-cruiser", "--json"]);
  const run = () => cli(["run", "--cwd", dir, "--only", "tool:dependency-cruiser", "--no-interactive", "--json"]);
  const item = (planned) => planned.doc.plan.groups.willRun.find((i) => i.id === "dependency-cruiser#architecture");
  const cleanup = () => {
    for (const d of [dir, home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { dir, home, cli, plan, run, item, cleanup };
}


const entry = (doc) => (doc.architecture ?? []).find((a) => a.tool === "dependency-cruiser");
const CLEAN = { ...FILES, "libs/shared/src/format.ts": 'export function title(): string {\n  return "shared";\n}\n' };

test("a complete graph is recorded in result.architecture as complete and verified", () => {
  const p = project(CLEAN, BOUNDARY);
  try {
    const ran = p.run();
    assert.equal(ran.code, 0, ran.out + ran.err);
    const a = entry(ran.doc);
    assert.ok(a, JSON.stringify(ran.doc.architecture));
    assert.equal(a.status, "complete");
    assert.equal(a.verified, true);
    assert.equal(a.unresolved, 0);
    assert.deepEqual(a.unresolvedSample, []);
    assert.ok(a.nodes > 0);
  } finally {
    p.cleanup();
  }
});

test("a partial graph is recorded with the unresolved dependencies, and the run stays incomplete", () => {
  const files = { ...CLEAN, "web/src/alias.ts": 'import { thing } from "@app/missing";\n\nexport const value = thing;\n' };
  const p = project(files, BOUNDARY);
  try {
    const ran = p.run();
    assert.equal(ran.code, 2, ran.out + ran.err);
    assert.equal(ran.doc.decision, "incomplete");
    const a = entry(ran.doc);
    assert.ok(a);
    assert.equal(a.status, "partial");
    assert.equal(a.verified, false);
    assert.ok(a.unresolved >= 1);
    assert.ok(a.unresolvedSample.some((u) => u.specifier === "@app/missing" && u.from === "web/src/alias.ts"));
    // The stored result.json carries the same field.
    const stored = JSON.parse(fs.readFileSync(path.join(ran.doc.runDir, "result.json"), "utf8"));
    assert.deepEqual(stored.architecture, ran.doc.architecture);
  } finally {
    p.cleanup();
  }
});

test("a run without an architecture check has no architecture field", () => {
  const dir = tmp("jgates-dc-none-");
  const home = tmp("jgates-dc-none-home-");
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
    const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_NO_CACHE: "1" };
    const r = spawnSync(process.execPath, [MAIN, "run", "--cwd", dir, "--no-interactive", "--json"], { encoding: "utf8", env, input: "", timeout: 240_000 });
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.architecture, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
