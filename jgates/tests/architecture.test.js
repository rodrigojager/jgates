import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// architecture.yml and the normalized graph evaluator.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const architecture = await import(pathToFileURL(path.join(dist, "core", "architecture", "index.js")).href);

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const ROOT_YML = "schemaVersion: 1\nextends:\n  - .jgates/architecture.yml\n";
const ARCHITECTURE_YML = `schemaVersion: 1
architecture:
  layers:
    - id: domain
      paths: ["api/src/domain/**"]
    - id: application
      paths: ["api/src/application/**"]
    - id: infrastructure
      paths: ["api/src/infrastructure/**"]
  rules:
    - id: domain-independent
      kind: forbidden-dependency
      from: domain
      to: [infrastructure]
      enabled: true
      severity: high
      blocking: true
      owner: source
    - id: api-boundary
      kind: component-boundary
      component: api
      allowedDependencies: [shared]
    - id: no-cycles
      kind: no-cycles
      severity: medium
      blocking: false
    - id: domain-fan-out
      kind: fan-limit
      layer: domain
      maxFanOut: 10
      owner: generated
`;

function project(architectureYml) {
  const dir = tmp("jg-arch-");
  fs.mkdirSync(path.join(dir, ".jgates"), { recursive: true });
  fs.writeFileSync(path.join(dir, "jgates.yml"), ROOT_YML);
  fs.writeFileSync(path.join(dir, ".jgates", "architecture.yml"), architectureYml);
  return dir;
}

function validate(dir) {
  const home = tmp("jg-arch-home-");
  try {
    const r = spawnSync(process.execPath, [MAIN, "config", "validate", "--cwd", dir, "--json"], {
      encoding: "utf8",
      env: { ...process.env, JGATES_HOME: home },
      timeout: 30000,
    });
    return { status: r.status, doc: JSON.parse(r.stdout) };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("config validate accepts architecture.yml with the three families of rule", () => {
  const dir = project(ARCHITECTURE_YML);
  try {
    const { status, doc } = validate(dir);
    assert.equal(status, 0, JSON.stringify(doc.diagnostics));
    assert.equal(doc.valid, true);
    const file = doc.files.find((f) => f.file === ".jgates/architecture.yml");
    assert.equal(file.kind, "architecture");
    assert.equal(file.schemaPending, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config validate refuses a rule that points at a layer that does not exist, with file and field", () => {
  const dir = project(ARCHITECTURE_YML.replace("to: [infrastructure]", "to: [infrastucture]"));
  try {
    const { status, doc } = validate(dir);
    assert.equal(status, 3);
    assert.equal(doc.valid, false);
    const problem = doc.diagnostics.find((d) => d.code === "REF_LAYER_UNKNOWN");
    assert.ok(problem, JSON.stringify(doc.diagnostics));
    assert.equal(problem.file, ".jgates/architecture.yml");
    assert.equal(problem.path, "architecture.rules[0].to[0]");
    assert.equal(problem.suggestion, "infrastructure");
    assert.match(problem.message, /infrastucture/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config validate refuses a fan-limit layer, a within layer and an unknown rule kind", () => {
  const cases = [
    [ARCHITECTURE_YML.replace("layer: domain", "layer: nowhere"), "REF_LAYER_UNKNOWN", "architecture.rules[3].layer"],
    [ARCHITECTURE_YML.replace("kind: no-cycles", "kind: no-cycles\n      within: ghost"), "REF_LAYER_UNKNOWN", "architecture.rules[2].within"],
    [ARCHITECTURE_YML.replace("kind: fan-limit", "kind: sideways"), "ENUM", "architecture.rules[3].kind"],
    [ARCHITECTURE_YML.replace("- id: api-boundary", "- id: domain-independent"), "REF_DUPLICATE_ID", "architecture.rules[1].id"],
    [ARCHITECTURE_YML.replace("      from: domain\n", ""), "REQUIRED", "architecture.rules[0].from"],
  ];
  for (const [text, code, where] of cases) {
    const dir = project(text);
    try {
      const { doc } = validate(dir);
      const problem = doc.diagnostics.find((d) => d.code === code && d.path === where);
      assert.ok(problem, `${code} ${where}: ${JSON.stringify(doc.diagnostics)}`);
      assert.equal(problem.file, ".jgates/architecture.yml");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("readArchitecture returns the declaration of a valid file and the problems of an invalid one", () => {
  const good = project(ARCHITECTURE_YML);
  const bad = project(ARCHITECTURE_YML.replace("from: domain", "from: dommain"));
  try {
    const ok = architecture.readArchitecture(good);
    assert.equal(ok.declaration.file, ".jgates/architecture.yml");
    assert.equal(ok.declaration.contract.rules.length, 4);
    const broken = architecture.readArchitecture(bad);
    assert.equal(broken.declaration, null);
    assert.equal(broken.problems[0].code, "REF_LAYER_UNKNOWN");
  } finally {
    fs.rmSync(good, { recursive: true, force: true });
    fs.rmSync(bad, { recursive: true, force: true });
  }
});

const node = (id, file, component = "api") => ({ id, kind: "module", language: "python", component, path: file });

function graph(extra = {}) {
  return {
    nodes: [node("shop.domain.order", "api/src/domain/order.py"), node("shop.infrastructure.db", "api/src/infrastructure/db.py")],
    edges: [{ from: "shop.domain.order", to: "shop.infrastructure.db", origin: "api/src/domain/order.py:3" }],
    unresolved: [],
    coverage: { extractor: "test" },
    ...extra,
  };
}

const bridgeEnv = { ...process.env, JGATES_PYTHON: PYTHON, PATH: VENV_BIN };

async function evaluate(g, { required = true } = {}) {
  const dir = project(ARCHITECTURE_YML);
  const cwd = tmp("jg-arch-run-");
  try {
    const { declaration } = architecture.readArchitecture(dir);
    assert.ok(declaration);
    return await architecture.evaluateArchitecture({ graph: g, declaration, required, cwd, env: bridgeEnv });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test("a domain to infrastructure edge yields a finding that names the declared rule and architecture.yml", async () => {
  const result = await evaluate(graph());
  assert.equal(result.state, "failed");
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding.ruleId, "domain-independent");
  assert.equal(finding.file, ".jgates/architecture.yml");
  assert.equal(finding.severity, "high");
  assert.equal(finding.blocking, true);
  assert.equal(finding.path, "api/src/domain/order.py");
  assert.equal(result.verified, true);
  assert.equal(result.coverage.status, "complete");
});

test("a complete graph without violations passes and is verified", async () => {
  const result = await evaluate(graph({ edges: [{ from: "shop.infrastructure.db", to: "shop.domain.order" }] }));
  assert.equal(result.state, "passed");
  assert.equal(result.verified, true);
  assert.deepEqual(result.findings, []);
});

test("unresolved dependencies return partial coverage and a required check is incomplete, not passed", async () => {
  const partial = graph({ edges: [], unresolved: [{ from: "shop.domain.order", specifier: "shop.missing", reason: "not-found" }] });
  const required = await evaluate(partial, { required: true });
  assert.equal(required.state, "incomplete");
  assert.equal(required.verified, false);
  assert.equal(required.coverage.status, "partial");
  assert.equal(required.coverage.unresolved, 1);
  assert.deepEqual(required.coverage.unresolvedSample[0], { from: "shop.domain.order", specifier: "shop.missing", reason: "not-found" });

  const optional = await evaluate(partial, { required: false });
  assert.equal(optional.state, "passed");
  assert.equal(optional.verified, false, "an optional check still reports that nothing was proven");
  assert.equal(optional.coverage.status, "partial");
});

test("an empty graph is never verified", async () => {
  const result = await evaluate({ nodes: [], edges: [], unresolved: [], coverage: {} });
  assert.equal(result.state, "incomplete");
  assert.equal(result.coverage.status, "empty");
  assert.equal(result.verified, false);
});

test("a violation in a partial graph still fails", async () => {
  const result = await evaluate(graph({ unresolved: [{ from: "shop.domain.order", specifier: "x" }] }));
  assert.equal(result.state, "failed");
  assert.equal(result.verified, false);
});

test("without Python the evaluation is incomplete, never passed", async () => {
  const dir = project(ARCHITECTURE_YML);
  const cwd = tmp("jg-arch-run-");
  const empty = tmp("jg-arch-bin-");
  try {
    const { declaration } = architecture.readArchitecture(dir);
    const result = await architecture.evaluateArchitecture({ graph: graph(), declaration, required: true, cwd, env: { PATH: empty } });
    assert.equal(result.state, "incomplete");
    assert.equal(result.findings.length, 0);
  } finally {
    for (const d of [dir, cwd, empty]) fs.rmSync(d, { recursive: true, force: true });
  }
});
