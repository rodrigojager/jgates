import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The linter engine itself (ADR-0021), with invented descriptors (tests/fixtures/linter-engine/descriptors/): a files
// mode tool read by a pattern, a project mode tool that writes SARIF to the run folder with JGates' default
// configuration, and an each-file tool with no location in its output. Through the real init, plan and run services
// each gives its expected findings on the bad fixture and none on the clean twin (tests/setup/linter-harness.mjs); the
// tables the engine derives (registries, trust, suppressions, evidence, the bridge's superseded list, the implicit
// templates) hold them; the census activates on files anywhere; every reader is fail-closed; a half-added descriptor
// is refused by the scan.

const here = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(here, "fixtures", "linter-engine");
const DESCRIPTORS = path.join(ENGINE, "descriptors");
const FIXTURES = path.join(ENGINE, "fixtures");
// Read when the descriptors are first asked for: set before anything of JGates loads them.
process.env.JGATES_LINTERS_EXTRA_DIR = DESCRIPTORS;

const { DIST, linterHarness } = await import(pathToFileURL(path.join(here, "setup", "linter-harness.mjs")).href);
const load = (...parts) => import(pathToFileURL(path.join(DIST, ...parts)).href);
const engine = await load("adapters", "linter", "index.js");
const readers = await load("adapters", "linter", "readers.js");
const { externalAdapterIds, externalAdapter } = await load("core", "plan", "adapters.js");
const { builtinManifests } = await load("adapters", "manifests.js");
const { ADAPTER_TRUST, adapterTreatment } = await load("core", "governed", "trust.js");
const { suppressionKinds } = await load("core", "governed", "suppressions.js");
const { SUPERSEDING_ADAPTERS } = await load("adapters", "quality-bridge", "superseded.js");
const { ADAPTER_EVIDENCE } = await load("core", "matrix", "evidence.js");
const builtin = await load("builtin", "index.js");
const { buildPlan } = await load("core", "plan", "index.js");

const harness = await linterHarness();
after(() => harness.cleanup());
const linter = (id) => engine.linterById(id);

test("linter engine: a files mode tool read by a pattern gives the expected findings on the bad fixture and none on the clean twin", async () => {
  await harness.prove(linter("demo-files-lint").descriptor, FIXTURES);
});

test("linter engine: a project mode tool writing SARIF to the run folder, with JGates' default configuration, gives the expected findings and none on the clean twin", async () => {
  await harness.prove(linter("demo-project-scan").descriptor, FIXTURES);
  // The project has no demo-scan.toml: the plan passes the descriptor's default, copied into the run folder.
  const dir = harness.workspace(FIXTURES, "demo-project-scan", "bad");
  const env = harness.envFor("demo-project-scan");
  const plan = harness.plan(dir, "demo-project-scan", env);
  const inv = plan.invocations.find((i) => i.id === "demo-project-scan");
  assert.equal(inv.contract.defaultConfig, "default.toml");
  assert.deepEqual(inv.command.args.slice(-8), ["--config", "{runDir}/linters/demo-project-scan/default.toml", "scan", "--format", "sarif", "--output", "{runDir}/linters/demo-project-scan/report.sarif", "{workspace}"]);
  // With its own configuration, the project's file is used (and hashed into the plan) and no default is passed.
  fs.writeFileSync(path.join(dir, "demo-scan.toml"), "rules = \"some\"\n");
  const own = harness.plan(dir, "demo-project-scan", env);
  const ownInv = own.invocations.find((i) => i.id === "demo-project-scan");
  assert.equal(ownInv.contract.defaultConfig, undefined);
  assert.ok(!ownInv.command.args.includes("--config"));
  const item = own.groups.willRun.find((i) => i.id === "demo-project-scan#secrets");
  assert.equal(item.category, "security");
});

test("linter engine: an each-file tool with no location in its output gives one finding on the file that failed and none on the clean twin", async () => {
  await harness.prove(linter("demo-each-check").descriptor, FIXTURES);
});

test("linter engine: the descriptors enter the registries and every derived table", () => {
  for (const id of ["demo-files-lint", "demo-project-scan", "demo-each-check"]) {
    assert.ok(externalAdapterIds().includes(id), id);
    assert.equal(externalAdapter(id)?.manifest.id, id);
    const manifest = builtinManifests().find((m) => m.id === id);
    assert.ok(manifest, `${id} manifest`);
    assert.equal(manifest.effects.onlyReadsProject, true, `${id} only reads the project`);
    assert.equal(ADAPTER_TRUST[id]?.treatment, "self-reported", id);
    assert.ok(Object.keys(ADAPTER_TRUST).includes(id));
    assert.equal(adapterTreatment(id, false), "self-reported");
    assert.ok(ADAPTER_EVIDENCE[id], `${id} evidence`);
  }
  // The hand tables are still there.
  assert.equal(ADAPTER_TRUST.ruff.treatment, "trusted");
  assert.ok(SUPERSEDING_ADAPTERS.megalinter.includes("hadolint"));
  assert.deepEqual(SUPERSEDING_ADAPTERS.gitleaks, ["gitleaks"]);
  // The tools that answer for a MegaLinter id supersede the bridge's megalinter subcheck; one without does not.
  assert.ok(SUPERSEDING_ADAPTERS.megalinter.includes("demo-files-lint"));
  assert.ok(!SUPERSEDING_ADAPTERS.megalinter.includes("demo-project-scan"));
  // The secrets tool's capability and category come from the catalogue.
  const scan = builtinManifests().find((m) => m.id === "demo-project-scan");
  assert.deepEqual(scan.capabilities, ["secrets"]);
  assert.deepEqual(scan.categories, ["security"]);
  // An in-code suppression of a tool that honours them is a kind jgates ci reports.
  const kind = suppressionKinds().find((k) => k.id === "linter-demo-files-lint");
  assert.ok(kind && kind.pattern.test("x: 1 # demo-lint: disable") && kind.files.test("a/b.demo") && !kind.files.test("a.md"));
  assert.equal(suppressionKinds().some((k) => k.id === "linter-demo-project-scan"), false);
  // The evidence cites the per-tool test of linters.test.js.
  assert.equal(ADAPTER_EVIDENCE["demo-files-lint"].capabilities.lint.tests[0].file, "linters.test.js");
  assert.ok(engine.linterTestTitle(linter("demo-files-lint").descriptor).startsWith(ADAPTER_EVIDENCE["demo-files-lint"].capabilities.lint.tests[0].test));
});

test("linter engine: one implicit template per descriptor group, detected by a file of the group anywhere, or always for whole-project tools", () => {
  const templates = Object.fromEntries(builtin.listBuiltinTemplates().map((t) => [t.id, t]));
  const demo = templates["lint-demo"];
  assert.ok(demo, "lint-demo");
  assert.equal(demo.value.implicit, true);
  assert.deepEqual(Object.keys(demo.value.config.tools).sort(), ["demo-each-check", "demo-files-lint"]);
  assert.equal(demo.value.config.tools["demo-files-lint"].tier, "main");
  assert.equal(demo.value.config.tools["demo-each-check"].tier, "extended");
  assert.deepEqual(demo.value.match.files, ["**/*.cfg", "**/*.demo"]);
  const scan = templates["scan-demo-scan"];
  assert.ok(scan && scan.value.implicit === true && scan.value.match === undefined);
  assert.ok(builtin.listImplicitTemplates().some((t) => t.id === "lint-demo"));

  // A .demo file nine folders deep activates the group and is picked (no depth or count cap).
  const deep = harness.tmp("jgates-linter-deep-");
  const nested = path.join(deep, ..."abcdefghi".split(""));
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "x.demo"), "a: 1\n");
  fs.mkdirSync(path.join(deep, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(deep, "node_modules", "dep", "y.demo"), "a: 1\n");
  harness.init(deep);
  const env = harness.envFor("demo-files-lint");
  const plan = harness.plan(deep, "demo-files-lint", env);
  const inv = plan.invocations.find((i) => i.id === "demo-files-lint");
  assert.deepEqual(inv.contract.files, ["a/b/c/d/e/f/g/h/i/x.demo"]);
  assert.deepEqual(inv.command.args.slice(-3), ["--format", "lines", "a/b/c/d/e/f/g/h/i/x.demo"]);

  // Without a file of the group the template is not detected: the tool is not in the project at all.
  const none = harness.init(harness.tmp("jgates-linter-none-"));
  const built = buildPlan(none, { only: ["tool:demo-files-lint"], env, home: harness.home, compare: false, version: "test" });
  assert.equal(built.ok, false);
  assert.ok(JSON.stringify(built.errors).includes("SELECTOR_UNMATCHED"));
});

test("linter engine: the census walks every folder but dependencies, build output and tool state, with no cap, and picks files by extension, name and content", () => {
  const dir = harness.tmp("jgates-census-");
  const put = (rel, text = "x\n") => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  for (let i = 0; i < 650; i += 1) put(`many/f${String(i).padStart(3, "0")}.yml`);
  put(".github/workflows/ci.yml");
  put(".git/config.yml");
  put("node_modules/x/y.yml");
  put("dist/z.yml");
  put("scripts/run", "#!/bin/bash\necho\n");
  put("scripts/other", "plain text\n");
  put("docker/web.Dockerfile", "FROM x\n");
  put("Dockerfile", "FROM x\n");
  const census = engine.fileCensus(dir);
  const yml = engine.activatedFiles(census, { extensions: [".YML"] });
  assert.equal(yml.length, 651);
  assert.ok(yml.includes(".github/workflows/ci.yml"));
  assert.ok(!yml.some((f) => f.startsWith(".git/") || f.startsWith("node_modules/") || f.startsWith("dist/")));
  assert.deepEqual(engine.activatedFiles(census, { names: ["Dockerfile", "*.Dockerfile"] }), ["Dockerfile", "docker/web.Dockerfile"]);
  assert.deepEqual(engine.activatedFiles(census, { names: [".github/workflows/*.yml"] }), [".github/workflows/ci.yml"]);
  assert.deepEqual(engine.activatedFiles(census, { content: { pattern: "^#!.*\\b(?:ba)?sh\\b" } }), ["scripts/run"]);
  assert.equal(engine.requiredFilePresent(census, [".yamllint", "Dockerfile"]), "Dockerfile");
  assert.equal(engine.requiredFilePresent(census, ["web.Dockerfile"]), null, "requires looks at the workspace root only");
  assert.match(census.listingHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(engine.censusHasEvidence(dir, "**/*.Dockerfile", null), true);
  assert.equal(engine.censusHasEvidence(dir, "docker/**/*.Dockerfile", "FROM"), true);
  assert.equal(engine.censusHasEvidence(dir, "**/*.toml", null), false);
});

test("linter engine: a tool that runs only where its configuration exists does not apply without it, and the reason names the file", async () => {
  const base = linter("demo-files-lint");
  const only = engine.makeLinterAdapter({ ...base, descriptor: { ...base.descriptor, activation: { ...base.descriptor.activation, requires: [".demolint.yml"] } } });
  const dir = harness.tmp("jgates-requires-");
  fs.writeFileSync(path.join(dir, "a.demo"), "a: 1\n");
  const input = { dir, env: harness.envFor("demo-files-lint"), tool: "demo-files-lint", capability: "lint", componentRoot: null, timeoutSeconds: 60 };
  const without = only.plan(input);
  assert.equal(without.availability.status, "unavailable");
  assert.match(without.availability.reason, /\.demolint\.yml/);
  fs.writeFileSync(path.join(dir, ".demolint.yml"), "rules: all\n");
  // The census serves one synchronous plan build; the next task sees the new file.
  await new Promise((resolve) => setImmediate(resolve));
  const withIt = only.plan(input);
  assert.equal(withIt.availability.status, "available", withIt.availability.reason ?? "");
  assert.deepEqual(withIt.configFiles.map((c) => c.file), [".demolint.yml"]);
  // Under jgates ci the descriptor's ci arguments are added.
  const scan = externalAdapter("demo-project-scan").plan({ ...input, tool: "demo-project-scan", capability: "secrets", policyDir: dir });
  assert.ok(scan.command.args.includes("--no-inline-ignores"));
});

test("linter engine: the readers read their formats and anything they cannot read is a problem, never an empty list", () => {
  const out = (o) => ({ from: "stdout", ...o });
  const read = (name, text, o = {}, exitCode = 1) => readers.builtinReader(name)({ text, other: "", exitCode }, out({ reader: name, ...o }));
  // json: nested lists with the parent's file, and JSON lines.
  const eslintLike = JSON.stringify([{ filePath: "/workspace/a.js", messages: [{ ruleId: "no-x", severity: 2, line: 3, column: 4, message: "no x" }] }, { filePath: "b.js", messages: [] }]);
  const j = read("json", eslintLike, { items: "[].messages[]", fields: { file: "^.filePath", line: "line", column: "column", rule: "ruleId", level: "severity", message: "message" } });
  assert.deepEqual(j, { ok: true, findings: [{ file: "/workspace/a.js", line: 3, column: 4, rule: "no-x", level: "2", message: "no x" }] });
  const jl = read("json", '{"f":"a.py","m":"bad","r":"E1"}\n\n{"f":"b.py","m":"worse","r":"E2"}\n', { jsonLines: true, fields: { file: "f", message: "m", rule: "r" } });
  assert.equal(jl.ok, true);
  assert.equal(jl.findings.length, 2);
  assert.equal(read("json", "", { jsonLines: true, fields: { file: "f", message: "m", rule: "r" } }).ok, true);
  assert.equal(read("json", "{not json", { fields: { file: "f", message: "m" } }).ok, false);
  assert.equal(read("json", '{"results":[]}', { items: "files[]", fields: { file: "f", message: "m" } }).ok, false);
  assert.equal(read("json", '[{"m":"x","r":"R"}]', { fields: { file: "f", message: "m", rule: "r" } }).ok, false, "a finding without a file");
  assert.equal(read("json", '[{"f":"a","m":"x"}]', { fields: { file: "f", message: "m", rule: "r" } }).ok, false, "a finding without a rule");
  // checkstyle and junit.
  const cs = read("checkstyle", '<?xml version="1.0"?><checkstyle><file name="src/A.java"><error line="2" column="5" severity="warning" message="m" source="Rule.X"/></file></checkstyle>');
  assert.deepEqual(cs.findings, [{ file: "src/A.java", line: 2, column: 5, rule: "Rule.X", level: "warning", message: "m" }]);
  assert.equal(read("checkstyle", "<report/>").ok, false);
  const ju = read("junit", '<testsuite><testcase classname="a.rb" name="Style/X"><failure message="bad style">detail</failure></testcase><testcase classname="b.rb" name="ok"/></testsuite>');
  assert.deepEqual(ju.findings, [{ file: "a.rb", rule: "Style/X", level: "error", message: "bad style" }]);
  assert.equal(read("junit", "<nothing/>").ok, false);
  // sarif: a result without a location fails unless the descriptor allows it.
  const noLoc = JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "t" } }, results: [{ ruleId: "R", message: { text: "m" } }] }] });
  assert.equal(read("sarif", noLoc).ok, false);
  assert.equal(read("sarif", noLoc, { locationOptional: true }).findings[0].file, null);
  assert.equal(read("sarif", '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"t"}},"results":[]}]}').findings.length, 0);
  assert.equal(read("sarif", '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"t"}},"res').ok, false, "a truncated SARIF");
  // lines, files.
  const ln = read("lines", "a.sh:3:1: warning [SC1] quote it\nsummary\n", { pattern: "^(?<file>[^:]+):(?<line>\\d+):(?<column>\\d+): (?<level>\\w+) \\[(?<rule>[^\\]]+)\\] (?<message>.+)$" });
  assert.deepEqual(ln.findings, [{ file: "a.sh", line: 3, column: 1, rule: "SC1", level: "warning", message: "quote it" }]);
  const fl = read("files", "Would reformat: a.py\nWould reformat: b/c.py\n2 files would be reformatted\n", { pattern: "^Would reformat: (?<file>.+)$", rule: "format" });
  assert.deepEqual(fl.findings.map((f) => f.file), ["a.py", "b/c.py"]);
  assert.deepEqual(read("files", "x.md\n\ny.md\n", { rule: "format" }).findings.map((f) => f.file), ["x.md", "y.md"]);
  // status: the reader reads nothing; the engine makes the finding when the exit says so.
  assert.deepEqual(read("status", "anything", { rule: "R" }), { ok: true, findings: [] });
  // Levels: the descriptor's map first, then the common names, unknown is a warning.
  const d = { severity: { "2": "error", "1": "warning" } };
  assert.equal(readers.mapLevel("2", d), "error");
  assert.equal(readers.mapLevel("note", d), "info");
  assert.equal(readers.mapLevel("whatever", d), "warning");
});

test("linter engine: the exit code and the findings must agree, long file lists run in batches, and the each-file loop names every file", () => {
  const exit = { clean: [0], findings: [1] };
  assert.equal(engine.concludeExit(0, 0, exit), null);
  assert.match(engine.concludeExit(2, 0, exit), /exit 0 but 2/);
  assert.match(engine.concludeExit(0, 1, exit), /no finding/);
  assert.equal(engine.concludeExit(1, 1, exit), null);
  assert.match(engine.concludeExit(0, 2, exit), /unexpected exit 2/);
  assert.match(engine.concludeExit(0, null, exit), /did not exit/);
  assert.equal(engine.concludeExit(3, 0, { clean: [0], findings: [0] }), null, "a code in both lists lets the report decide");
  // Batches: by count and by length, every file once, in order.
  const files = Array.from({ length: 450 }, (_, i) => `f${i}.yml`);
  const parts = engine.batches(files);
  assert.deepEqual(parts.map((p) => p.length), [200, 200, 50]);
  assert.deepEqual(parts.flat(), files);
  const long = Array.from({ length: 10 }, (_, i) => `${"d/".repeat(5000)}${i}.yml`);
  assert.ok(engine.batches(long).every((b) => b.join(" ").length <= engine.BATCH_CHARS || b.length === 1));
  // The each-file loop: the script quotes the command and marks every file; the split checks the markers.
  const script = engine.eachFileScript(["tool", "--check", "{file}", "it's"], true);
  assert.match(script, /^for f do /);
  assert.ok(script.includes('"$f"') && script.includes("2>&1 >/dev/null"));
  const output = "\n\u001ejgates-file a.cfg\nbroken\n\n\u001ejgates-exit 1\n\n\u001ejgates-file b.cfg\n\n\u001ejgates-exit 0\n";
  assert.deepEqual(engine.splitEachFile(output, ["a.cfg", "b.cfg"]), [
    { file: "a.cfg", exitCode: 1, text: "broken\n" },
    { file: "b.cfg", exitCode: 0, text: "" },
  ]);
  assert.equal(engine.splitEachFile(output, ["a.cfg"]), null, "a file the loop did not name");
  assert.equal(engine.splitEachFile("\n\u001ejgates-file a.cfg\nbroken\n", ["a.cfg"]), null, "a file without its exit code");
});

test("linter engine: a descriptor that is incomplete or inconsistent is refused by the scan with the file and the reason", () => {
  const good = JSON.parse(fs.readFileSync(path.join(DESCRIPTORS, "demo-files-lint", "linter.json"), "utf8"));
  const refused = (mutate, reason, folder = "demo-broken") => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-descriptors-"));
    try {
      const doc = structuredClone(good);
      doc.id = folder;
      mutate(doc);
      fs.mkdirSync(path.join(root, folder));
      fs.writeFileSync(path.join(root, folder, "linter.json"), JSON.stringify(doc));
      assert.throws(() => engine.loadLinters({ ...process.env, JGATES_LINTERS_EXTRA_DIR: root }), (error) => error.name === "LinterDescriptorError" && error.message.includes(`${folder}`) && reason.test(error.message), String(reason));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  refused((d) => delete d.text["pt-BR"], /pt-BR/);
  refused((d) => (d.text.en.limitation = "  "), /text\.en\.limitation/);
  refused((d) => delete d.governed, /governed/);
  refused((d) => (d.id = "another-id"), /folder name/);
  refused((d) => (d.output.pattern = "^(?<line>\\d+) (?<message>.+)$"), /group file/);
  refused((d) => (d.output.reader = "custom"), /readers\/demo-broken/);
  refused((d) => (d.place.capability = "no-such-capability"), /not a capability/);
  refused((d) => (d.configuration.default = "missing.yml"), /not in the descriptor folder/);
  refused((d) => (d.run.args = ["{report}"]), /only for output\.from file/);
  refused((d) => (d.governed.suppressions = { honoured: true, description: "x" }), /pattern/);
  // A folder without its linter.json is refused too (a tool cannot be half-added).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-descriptors-"));
  try {
    fs.mkdirSync(path.join(root, "demo-empty"));
    assert.throws(() => engine.loadLinters({ ...process.env, JGATES_LINTERS_EXTRA_DIR: root }), /demo-empty.*no linter\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
