import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// dependency-cruiser adapter: the contract of architecture.yml over the graph of a TypeScript workspace:
// the component boundary, cycles, the resolved executable (no download), and unresolved imports as a gap.

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

const found = (result) => result.findings.filter((f) => f.tool === "dependency-cruiser");
const outputsOf = (result) => path.join(result.runDir, "outputs", "dependency-cruiser", "dependency-cruiser");

test("the manifest is registered with the architecture capability and TS/JS languages", () => {
  const manifest = catalog.builtinManifests().find((m) => m.id === "dependency-cruiser");
  assert.ok(manifest);
  assert.deepEqual(manifest.capabilities, ["architecture"]);
  assert.deepEqual(manifest.languages, ["javascript", "typescript"]);
  assert.equal(manifest.effects.usesNetwork, false);
});

test("the shared library importing the web component is the finding of the declared boundary rule; the command is the resolved binary and nothing is downloaded [proves: dependency-cruiser#architecture]", () => {
  const p = project(FILES, BOUNDARY);
  try {
    const planned = p.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = p.item(planned);
    assert.ok(item, JSON.stringify(planned.doc.plan.groups.willRun.map((i) => i.id)));
    assert.equal(item.adapter, "dependency-cruiser");
    assert.equal(item.network, false);
    assert.match(item.versions.toolVersion, /^\d+\.\d+\.\d+/);
    // The executable is Node running the resolved script of the dependency; never npx, never a download.
    const command = item.command;
    const everything = [command.executable, ...command.args].join(" ");
    assert.doesNotMatch(everything, /npx|npm exec|https?:/);
    assert.equal(command.executable, process.execPath);
    assert.match(command.args[0], /node_modules[\\/]dependency-cruiser[\\/]bin[\\/]dependency-cruiser\.mjs$/);
    assert.ok(fs.existsSync(command.args[0]));
    assert.equal(command.args[command.args.indexOf("--output-type") + 1], "json");
    assert.equal(command.args[command.args.indexOf("--config") + 1], "{runDir}/outputs/dependency-cruiser/dependency-cruiser/depcruise.config.cjs");
    assert.ok(item.configFiles.some((f) => f.file === ".jgates/architecture.yml" && f.sha256 !== null));

    const before = fs.readdirSync(p.dir).sort();
    const ran = p.run();
    assert.equal(ran.code, 1, ran.out + ran.err);
    assert.equal(ran.doc.decision, "failed");
    const list = found(ran.doc);
    assert.deepEqual(list.map((f) => f.ruleId), ["shared-is-independent"]);
    assert.equal(list[0].location.path, "libs/shared/src/format.ts");
    assert.equal(list[0].blocking, true);
    assert.equal(list[0].origin, ".jgates/architecture.yml");
    assert.deepEqual(fs.readdirSync(p.dir).sort(), before, "nothing is left in the workspace");
    // The generated configuration lives in the run folder and says it is generated.
    const config = fs.readFileSync(path.join(outputsOf(ran.doc), "depcruise.config.cjs"), "utf8");
    assert.match(config, /Generated by JGates/);
    const coverage = JSON.parse(fs.readFileSync(path.join(outputsOf(ran.doc), "coverage.json"), "utf8"));
    assert.equal(coverage.coverage.status, "complete");
    assert.equal(coverage.coverage.extractor, "dependency-cruiser");
  } finally {
    p.cleanup();
  }
});

test("a clean workspace passes with a complete graph", () => {
  const files = { ...FILES, "libs/shared/src/format.ts": 'export function title(): string {\n  return "shared";\n}\n' };
  const p = project(files, BOUNDARY);
  try {
    const ran = p.run();
    assert.equal(ran.code, 0, ran.out + ran.err);
    assert.equal(ran.doc.decision, "passed");
    assert.deepEqual(found(ran.doc), []);
    const coverage = JSON.parse(fs.readFileSync(path.join(outputsOf(ran.doc), "coverage.json"), "utf8"));
    assert.equal(coverage.verified, true);
  } finally {
    p.cleanup();
  }
});

test("a cycle between two TS modules is a finding of the cycles rule", () => {
  const files = {
    ...FILES,
    "libs/shared/src/format.ts": 'export function title(): string {\n  return "shared";\n}\n',
    "web/src/a.ts": 'import { b } from "./b.js";\n\nexport const a = (): string => b();\n',
    "web/src/b.ts": 'import { a } from "./a.js";\n\nexport const b = (): string => a();\n',
  };
  const p = project(files, CYCLES);
  try {
    const ran = p.run();
    assert.equal(ran.code, 1, ran.out + ran.err);
    const list = found(ran.doc);
    assert.ok(list.length >= 1, JSON.stringify(ran.doc.findings));
    assert.ok(list.every((f) => f.ruleId === "no-import-cycles"));
    assert.ok(list.some((f) => /web\/src\/[ab]\.ts/.test(f.location.path)));
  } finally {
    p.cleanup();
  }
});

test("a TS alias the tool does not resolve is an unresolved dependency in the coverage, and a required check over it is not passed", () => {
  const files = {
    ...FILES,
    "libs/shared/src/format.ts": 'export function title(): string {\n  return "shared";\n}\n',
    "web/src/alias.ts": 'import { thing } from "@app/missing";\n\nexport const value = thing;\n',
  };
  const p = project(files, BOUNDARY);
  try {
    const ran = p.run();
    assert.equal(ran.code, 2, ran.out + ran.err);
    assert.equal(ran.doc.decision, "incomplete");
    const coverage = JSON.parse(fs.readFileSync(path.join(outputsOf(ran.doc), "coverage.json"), "utf8"));
    assert.equal(coverage.coverage.status, "partial");
    assert.equal(coverage.verified, false);
    assert.ok(coverage.coverage.unresolved >= 1);
    assert.ok(coverage.coverage.unresolvedSample.some((u) => u.specifier === "@app/missing" && u.from === "web/src/alias.ts"), JSON.stringify(coverage.coverage.unresolvedSample));
    const stage = ran.doc.stages.find((s) => s.id === "dependency-cruiser#architecture");
    assert.notEqual(stage.state, "passed");
    assert.match(stage.reason ?? "", /@app|n[ãa]o resolvid|Arquitetura n[ãa]o provada/);
  } finally {
    p.cleanup();
  }
});

test("without architecture.yml the instance is unavailable and the run is not passed", () => {
  const p = project(FILES, null);
  try {
    const planned = p.plan();
    const item = p.item(planned);
    assert.ok(item, planned.out + planned.err);
    assert.equal(item.availability.status, "unavailable");
    assert.match(item.availability.reason, /architecture\.yml/);
    const ran = p.run();
    assert.notEqual(ran.doc.decision, "passed");
  } finally {
    p.cleanup();
  }
});

test("JGATES_DEPCRUISE points at another executable and a missing one blocks with the instruction, never npx", () => {
  const p = project(FILES, BOUNDARY, { JGATES_DEPCRUISE: path.join(os.tmpdir(), "jgates-no-such-depcruise") });
  try {
    const item = p.item(p.plan());
    assert.equal(item.availability.status, "unavailable");
    assert.match(item.availability.reason, /dependency-cruiser/);
    assert.match(item.availability.reason, /nunca baixa|JGATES_DEPCRUISE/);
    const ran = p.run();
    assert.notEqual(ran.doc.decision, "passed");
    assert.notEqual(ran.doc.decision, "failed");
  } finally {
    p.cleanup();
  }
});

test("parser: the sample output becomes nodes, edges, unresolved imports and ignores packages and core modules", () => {
  const text = fs.readFileSync(path.join(FIXTURES, "sample.json"), "utf8");
  const parsed = adapter.parseDepcruiseOutput(text, { version: "18.7.0", components: [{ id: "web", root: "web" }, { id: "libs-shared", root: "libs/shared" }] });
  assert.equal(parsed.ok, true);
  const g = parsed.graph;
  assert.deepEqual(g.nodes.map((n) => [n.id, n.component, n.language]), [
    ["libs/shared/src/format.ts", "libs-shared", "typescript"],
    ["web/src/app.ts", "web", "typescript"],
    ["web/src/util.js", "web", "javascript"],
  ]);
  assert.deepEqual(g.edges.map((e) => [e.from, e.to]), [["libs/shared/src/format.ts", "web/src/app.ts"], ["web/src/app.ts", "web/src/util.js"]]);
  assert.deepEqual(g.unresolved.map((u) => [u.from, u.specifier]), [["web/src/app.ts", "@app/missing"]]);
  assert.equal(g.coverage.extractor, "dependency-cruiser");
  assert.equal(g.coverage.complete, true);
});

test("parser: output that is not the expected shape is not a graph", () => {
  for (const text of ["not json", "{}", '{"modules":[{"dependencies":[]}]}', '{"modules":[{"source":"a.ts","dependencies":[{"resolved":"b.ts"}]}]}']) {
    const parsed = adapter.parseDepcruiseOutput(text, { version: null, components: [] });
    assert.equal(parsed.ok, false, text);
    assert.ok(parsed.problem);
  }
});
