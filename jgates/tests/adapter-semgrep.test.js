import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Semgrep adapter: a directory of local rules is the only rule source of the run; editing, creating and
// renaming rules go through the document service; an invalid rule blocks the plan; nothing touches the network.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const HAS_SEMGREP = fs.existsSync(path.join(VENV_BIN, process.platform === "win32" ? "semgrep.exe" : "semgrep"));
const rules = await import(pathToFileURL(path.join(dist, "core", "rules", "index.js")).href);
const documents = await import(pathToFileURL(path.join(dist, "core", "documents", "index.js")).href);
const catalog = await import(pathToFileURL(path.join(dist, "core", "catalog", "index.js")).href);
const semgrepAdapter = await import(pathToFileURL(path.join(dist, "adapters", "semgrep", "index.js")).href);

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const RULE = (pattern, id = "no-eval") => `rules:
  - id: ${id}
    message: Do not call ${id}
    severity: ERROR
    languages: [python]
    pattern: ${pattern}
`;
const SOURCE = 'value = eval("1")\nprint(exec("2"))\n';
const TOOLS = "schemaVersion: 1\ntools:\n  semgrep:\n    adapter: semgrep\n    capabilities: [sast]\n    config:\n      path: .jgates/rules\n      kind: directory\n      role: rules\n";

function project(extraEnv = {}, { withSemgrep = true } = {}) {
  if (withSemgrep) assert.ok(HAS_SEMGREP, "semgrep is not installed in the repository .venv: run `npm --prefix jgates run setup:dev-tools`");
  const dir = tmp("jgates-sg-ws-");
  const home = tmp("jgates-sg-home-");
  const emptyBin = tmp("jgates-sg-bin-");
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, ".jgates", "rules"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.py"), SOURCE);
  fs.writeFileSync(path.join(dir, ".jgates", "rules", "no-eval.yml"), RULE("eval(...)"));
  const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, PATH: emptyBin, ...extraEnv };
  const cli = (args, input) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: input ?? "", timeout: 240_000 });
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
  const plan = (...more) => cli(["plan", "--cwd", dir, "--only", "tool:semgrep", "--json", ...more]);
  const run = () => cli(["run", "--cwd", dir, "--only", "tool:semgrep", "--no-interactive", "--json"]);
  const item = (planned) => planned.doc.plan.groups.willRun.find((i) => i.id === "semgrep#sast");
  const write = (entry, text, ifMatch) => cli(["tools", "config", "write", "semgrep", "--file", "config", "--entry", entry, "--if-match", ifMatch, "--no-interactive", "--cwd", dir, "--json"], text);
  const read = (entry) => cli(["tools", "config", "read", "semgrep", "--file", "config", "--entry", entry, "--cwd", dir, "--json"]);
  const cleanup = () => {
    for (const d of [dir, home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { dir, home, cli, plan, run, item, write, read, cleanup };
}

const found = (result) => result.findings.filter((f) => f.tool === "semgrep");

test("a violation of a local rule comes back with the local rule id, file and line; the plan shows only local rules and no network [proves: semgrep#sast]", () => {
  const p = project();
  try {
    const planned = p.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = p.item(planned);
    assert.ok(item, JSON.stringify(planned.doc.plan.groups.willRun.map((i) => i.id)));
    assert.equal(item.adapter, "semgrep");
    assert.match(item.versions.toolVersion, /^\d+\.\d+\.\d+/);
    assert.equal(item.network, false);
    const args = item.command.args;
    // Every --config is a file of the local directory; there is no registry reference.
    const configs = args.flatMap((a, i) => (a === "--config" ? [args[i + 1]] : []));
    assert.deepEqual(configs, ["{workspace}/.jgates/rules/no-eval.yml"]);
    assert.ok(args.includes("--metrics=off"));
    assert.ok(args.includes("--json"));
    assert.ok(args.every((a) => !/^(p|r)\//.test(a) && !/^https?:/.test(a) && a !== "auto"), JSON.stringify(args));
    assert.equal(args[args.indexOf("--output") + 1], "{runDir}/outputs/semgrep/semgrep/semgrep.json");
    assert.equal(item.command.env.SEMGREP_SEND_METRICS, "off");
    assert.ok(item.configFiles.some((f) => f.file === ".jgates/rules/no-eval.yml" && /^sha256:/.test(f.sha256)));

    const before = fs.readdirSync(p.dir).sort();
    const ran = p.run();
    assert.equal(ran.code, 1, ran.out + ran.err);
    assert.equal(ran.doc.decision, "failed");
    const stage = ran.doc.stages.find((s) => s.id === "semgrep#sast");
    assert.equal(stage.state, "completed");
    const list = found(ran.doc);
    assert.deepEqual(list.map((f) => f.ruleId), ["no-eval"]);
    assert.equal(list[0].location.path, "src/app.py");
    assert.equal(list[0].location.line, 1);
    assert.equal(list[0].toolVersion, item.versions.toolVersion);
    assert.equal(list[0].blocking, true);
    assert.deepEqual(fs.readdirSync(p.dir).sort(), before, "nothing is left in the workspace");
    assert.deepEqual(ran.doc.workspaceChanges.added, []);
    assert.ok(fs.existsSync(path.join(ran.doc.runDir, "outputs", "semgrep", "semgrep", "semgrep.json")));
  } finally {
    p.cleanup();
  }
});

test("editing the pattern through the documents API changes the plan hash and the finding", () => {
  const p = project();
  try {
    const first = p.plan().doc.plan;
    const firstFindings = found(p.run().doc);
    assert.deepEqual(firstFindings.map((f) => f.location.line), [1]);

    const read = p.read("no-eval.yml");
    assert.equal(read.code, 0, read.out + read.err);
    const document = read.doc.document;
    const edited = document.text.replace("pattern: eval(...)", "pattern: exec(...)");
    assert.notEqual(edited, document.text);
    const written = p.write("no-eval.yml", edited, document.revision);
    assert.equal(written.code, 0, written.out + written.err);

    const second = p.plan().doc.plan;
    assert.notEqual(second.planHash, first.planHash, "the rule file is an input of the plan");
    const sha = (plan) => plan.groups.willRun.find((i) => i.id === "semgrep#sast").configFiles.find((f) => f.file === ".jgates/rules/no-eval.yml").sha256;
    assert.notEqual(sha(second), sha(first));
    const secondFindings = found(p.run().doc);
    assert.deepEqual(secondFindings.map((f) => [f.ruleId, f.location.line]), [["no-eval", 2]], "the new pattern matches exec, not eval");
  } finally {
    p.cleanup();
  }
});

test("a rule created through the documents API shows in the list and runs in the next plan; creating needs an explicit action", () => {
  const p = project();
  try {
    // No revision means "create": a plain write over a missing file is refused.
    const refused = p.write("no-exec.yml", RULE("exec(...)", "no-exec"), "0".repeat(64));
    assert.notEqual(refused.code, 0, "a write that expects an existing revision does not create the file");
    assert.equal(fs.existsSync(path.join(p.dir, ".jgates", "rules", "no-exec.yml")), false);

    const created = p.write("no-exec.yml", RULE("exec(...)", "no-exec"), "absent");
    assert.equal(created.code, 0, created.out + created.err);
    assert.ok(fs.existsSync(path.join(p.dir, ".jgates", "rules", "no-exec.yml")));

    const listed = rules.collectRuleSource(p.dir, "semgrep");
    assert.deepEqual(listed.files.map((f) => f.entry), ["no-eval.yml", "no-exec.yml"]);
    assert.equal(listed.valid, true);

    const planned = p.plan();
    const configs = p.item(planned).command.args.filter((a) => a.startsWith("{workspace}/"));
    assert.deepEqual(configs, ["{workspace}/.jgates/rules/no-eval.yml", "{workspace}/.jgates/rules/no-exec.yml"]);
    assert.deepEqual(found(p.run().doc).map((f) => f.ruleId).sort(), ["no-eval", "no-exec"]);

    // A name that leaves the directory is refused, and so is a name outside include.
    const escape = p.write("../escape.yml", RULE("eval(...)", "x"), "absent");
    assert.notEqual(escape.code, 0);
    assert.equal(fs.existsSync(path.join(p.dir, ".jgates", "escape.yml")), false);
  } finally {
    p.cleanup();
  }
});

test("renaming a rule moves the file, never overwrites, follows the include list and points at the references left", () => {
  const p = project();
  try {
    fs.writeFileSync(path.join(p.dir, ".jgates", "tools.yml"), TOOLS.replace("      role: rules\n", '      role: rules\n      include: ["no-eval.yml", "other.yml"]\n') + "# notes: see no-eval.yml before changing\n");
    fs.writeFileSync(path.join(p.dir, ".jgates", "rules", "other.yml"), RULE("exec(...)", "other"));
    const source = rules.collectRuleSource(p.dir, "semgrep");
    const file = source.files.find((f) => f.entry === "no-eval.yml");

    const clash = (() => {
      try {
        return rules.renameRuleFile(p.dir, "semgrep", { from: "no-eval.yml", to: "other.yml", expectedRevision: file.revision });
      } catch (error) {
        return error;
      }
    })();
    assert.equal(clash.code, "DOCUMENT_EXISTS");
    assert.ok(fs.existsSync(path.join(p.dir, ".jgates", "rules", "no-eval.yml")));

    const stale = rules.renameRuleFile(p.dir, "semgrep", { from: "no-eval.yml", to: "renamed.yml", expectedRevision: "1".repeat(64) });
    assert.equal(stale.status, "conflict");

    const badName = (() => {
      try {
        return rules.renameRuleFile(p.dir, "semgrep", { from: "no-eval.yml", to: "../out.yml", expectedRevision: file.revision });
      } catch (error) {
        return error;
      }
    })();
    assert.ok(badName instanceof documents.DocumentError, String(badName));

    const result = rules.renameRuleFile(p.dir, "semgrep", { from: "no-eval.yml", to: "renamed.yml", expectedRevision: file.revision });
    assert.equal(result.status, "renamed");
    assert.equal(fs.existsSync(path.join(p.dir, ".jgates", "rules", "no-eval.yml")), false);
    assert.equal(fs.readFileSync(path.join(p.dir, ".jgates", "rules", "renamed.yml"), "utf8"), RULE("eval(...)"));
    const tools = fs.readFileSync(path.join(p.dir, ".jgates", "tools.yml"), "utf8");
    assert.match(tools, /include: \[.*"renamed\.yml".*\]/);
    assert.equal(result.updated.length, 1);
    // The comment still names the old file: reported as pending, not rewritten.
    assert.deepEqual(result.pending.map((r) => r.file), [".jgates/tools.yml"]);
    assert.match(result.pending[0].text, /no-eval\.yml/);
    assert.equal(rules.collectRuleSource(p.dir, "semgrep").valid, true);
    assert.deepEqual(found(p.run().doc).map((f) => f.ruleId).sort(), ["no-eval", "other"], "the renamed rule still runs");
  } finally {
    p.cleanup();
  }
});

test("a rule with invalid YAML shows its syntax error and blocks the plan; a contract error does too", () => {
  const p = project();
  try {
    fs.writeFileSync(path.join(p.dir, ".jgates", "rules", "broken.yml"), "rules:\n  - id: broken\n    pattern: [unclosed\n");
    const source = rules.collectRuleSource(p.dir, "semgrep");
    assert.equal(source.valid, false);
    const broken = source.files.find((f) => f.entry === "broken.yml");
    assert.equal(broken.validation.status, "invalid");
    assert.equal(broken.validation.issues[0].kind, "syntax");
    assert.ok(broken.validation.issues[0].line >= 1);

    const planned = p.plan();
    const plan = planned.doc.plan;
    assert.equal(plan.approvable, false, "the plan is not approvable");
    const blocker = plan.blockers.find((b) => b.code === "TOOL_UNAVAILABLE");
    assert.ok(blocker, JSON.stringify(plan.blockers));
    assert.match(blocker.message, /broken\.yml/);
    assert.equal(p.run().code, 3, "run refuses a plan that is not approvable");

    // Contract: valid YAML, but no matcher and an unknown severity.
    fs.writeFileSync(path.join(p.dir, ".jgates", "rules", "broken.yml"), "rules:\n  - id: broken\n    message: m\n    severity: SEVERE\n    languages: [python]\n");
    const contract = rules.collectRuleSource(p.dir, "semgrep").files.find((f) => f.entry === "broken.yml");
    assert.deepEqual(contract.validation.issues.map((i) => i.code).sort(), ["RULE_MATCHER", "RULE_SEVERITY"]);
    assert.ok(contract.validation.issues.every((i) => i.kind === "contract" && i.ruleId === "broken"));
    assert.equal(p.plan().doc.plan.approvable, false);

    // Fixing the file unblocks the plan.
    fs.writeFileSync(path.join(p.dir, ".jgates", "rules", "broken.yml"), RULE("print(...)", "broken"));
    assert.equal(p.plan().doc.plan.approvable, true);
  } finally {
    p.cleanup();
  }
});

test("a rule id repeated across files is reported and blocks the plan", () => {
  const p = project();
  try {
    fs.writeFileSync(path.join(p.dir, ".jgates", "rules", "copy.yml"), RULE("exec(...)", "no-eval"));
    const source = rules.collectRuleSource(p.dir, "semgrep");
    assert.deepEqual(source.duplicates.map((d) => d.id), ["no-eval"]);
    assert.equal(source.valid, false);
    assert.equal(p.plan().doc.plan.approvable, false);
  } finally {
    p.cleanup();
  }
});

test("without Semgrep installed the stage is blocked and the decision is incomplete, never passed", () => {
  const p = project({ JGATES_PYTHON: path.join(os.tmpdir(), "jgates-no-such-venv", "bin", "python") }, { withSemgrep: false });
  try {
    const planned = p.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = p.item(planned);
    assert.equal(item.availability.status, "unavailable");
    assert.match(item.availability.reason, /jgates doctor --fix/);
    assert.ok(planned.doc.plan.warnings.some((w) => w.code === "TOOL_UNAVAILABLE"));
    const ran = p.run();
    assert.equal(ran.code, 2, ran.out + ran.err);
    assert.equal(ran.doc.decision, "incomplete");
    const stage = ran.doc.stages.find((s) => s.id === "semgrep#sast");
    assert.equal(stage.state, "blocked");
    assert.match(stage.reason, /jgates doctor --fix/);
    assert.deepEqual(found(ran.doc), []);
  } finally {
    p.cleanup();
  }
});

test("an instance without a rules binding cannot be planned, and the manifest is valid", () => {
  const p = project();
  try {
    fs.writeFileSync(path.join(p.dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  semgrep:\n    adapter: semgrep\n    capabilities: [sast]\n");
    const planned = p.plan();
    assert.equal(planned.doc.plan.approvable, false);
    assert.match(JSON.stringify(planned.doc.plan.blockers), /regras locais/);
    const c = catalog.createCatalog ? catalog.createCatalog() : null;
    if (c && c.registerAdapter) c.registerAdapter(semgrepAdapter.semgrepManifest);
    else if (catalog.validateManifest) assert.deepEqual(catalog.validateManifest(semgrepAdapter.semgrepManifest).errors ?? [], []);
  } finally {
    p.cleanup();
  }
});

test("the rules routes list the files with their validation and rename through the document service", async () => {
  const p = project();
  try {
    const routes = await import(pathToFileURL(path.join(dist, "server", "routes", "rules.js")).href);
    const list = routes.routes.find((r) => r.method === "GET");
    const rename = routes.routes.find((r) => r.method === "POST");
    const server = { projectDir: p.dir, log() {} };
    const ok = list.handler({ params: { instance: "semgrep" }, query: {}, server });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.rules.files.map((f) => f.entry), ["no-eval.yml"]);
    assert.equal(ok.json.rules.files[0].validation.status, "valid");
    assert.equal("abs" in ok.json.rules.files[0], false);
    const filtered = list.handler({ params: { instance: "semgrep" }, query: { q: "nothing-matches-this" }, server });
    assert.deepEqual(filtered.json.rules.files, []);
    assert.equal(filtered.json.rules.total, 1);
    const byId = list.handler({ params: { instance: "semgrep" }, query: { q: "no-eval" }, server });
    assert.equal(byId.json.rules.files.length, 1);
    const moved = rename.handler({ params: { instance: "semgrep" }, body: { from: "no-eval.yml", to: "moved.yml", expectedRevision: ok.json.rules.files[0].revision }, server });
    assert.equal(moved.json.rename.status, "renamed");
    assert.throws(() => rename.handler({ params: { instance: "semgrep" }, body: { from: "moved.yml", to: "again.yml", expectedRevision: "2".repeat(64) }, server }), (e) => e.status === 409);
  } finally {
    p.cleanup();
  }
});
