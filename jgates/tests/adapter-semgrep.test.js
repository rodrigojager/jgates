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
const { imageJsonWithout } = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "setup", "image-json.mjs")).href);
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

test("with Semgrep absent from the tools image the stage is blocked and the decision is incomplete, never passed", () => {
  const p = project({ JGATES_PYTHON: path.join(os.tmpdir(), "jgates-no-such-venv", "bin", "python"), JGATES_IMAGE_JSON: imageJsonWithout("semgrep") }, { withSemgrep: false });
  try {
    const planned = p.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = p.item(planned);
    assert.equal(item.availability.status, "unavailable");
    assert.match(item.availability.reason, /jgates setup/);
    assert.ok(planned.doc.plan.warnings.some((w) => w.code === "TOOL_MISSING"));
    const ran = p.run();
    assert.equal(ran.code, 2, ran.out + ran.err);
    assert.equal(ran.doc.decision, "incomplete");
    const stage = ran.doc.stages.find((s) => s.id === "semgrep#sast");
    assert.equal(stage.state, "blocked");
    assert.match(stage.reason, /jgates setup/);
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

// ---- Bundled JGates rule pack -------------------------------------------------------------------------------------
// The pack's rule tests and its vulnerable/clean fixtures run on a real Semgrep: a local one (JGATES_SEMGREP, the
// repository .venv, PATH) or the quality sidecar image through Docker. With neither, the tests fail and say so.

const PACK_ROOT = path.resolve(here, "..", "packs", "semgrep");
const PACK_RULES = path.join(PACK_ROOT, "jgates-semgrep", "rules");
const PACK_FIXTURES = path.join(here, "fixtures", "semgrep-pack");
const SIDECAR_IMAGE = process.env.JGATES_SEMGREP_IMAGE || "jgates/quality-sidecar:latest";

function localSemgrep() {
  const candidates = [process.env.JGATES_SEMGREP, path.join(VENV_BIN, process.platform === "win32" ? "semgrep.exe" : "semgrep")].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["semgrep"], { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.split(/\r?\n/)[0].trim() : null;
}

/** A real engine or a thrown explanation; never a silent pass. `mounts` map host folders to container paths. */
function engine() {
  const local = localSemgrep();
  if (local) {
    // Semgrep keeps settings.yml in the user profile and several runs of the suite share it: each run gets a throwaway profile.
    const run = (args) => {
      const home = tmp("jgates-semgrep-home-");
      try {
        return spawnSync(local, args, { encoding: "utf8", timeout: 240_000, env: { ...process.env, HOME: home, USERPROFILE: home, SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0" } });
      } finally {
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      }
    };
    return { kind: "local", run };
  }
  const docker = spawnSync("docker", ["image", "inspect", SIDECAR_IMAGE], { encoding: "utf8" });
  if (docker.status === 0) {
    return {
      kind: "docker",
      run: (args, mounts = {}) => {
        const volumes = Object.entries(mounts).flatMap(([host, inside]) => ["-v", `${host}:${inside.path}${inside.writable ? "" : ":ro"}`]);
        return spawnSync("docker", ["run", "--rm", "--label", "jproject.project=jgates", ...volumes, "--entrypoint", "semgrep", SIDECAR_IMAGE, ...args], { encoding: "utf8", timeout: 240_000 });
      },
    };
  }
  throw new assert.AssertionError({ message: `no Semgrep engine available: install semgrep (JGATES_SEMGREP, .venv or PATH) or build the Docker image ${SIDECAR_IMAGE}; the pack tests cannot pass without one` });
}

const packWorkspace = (variant) => {
  const dir = tmp("jgates-pack-ws-");
  fs.cpSync(path.join(PACK_FIXTURES, variant), dir, { recursive: true });
  return dir;
};
const PACK_TOOLS = "schemaVersion: 1\ntools:\n  semgrep:\n    adapter: semgrep\n    capabilities: [sast]\n    rulePack: jgates\n";

function packCli(dir, home) {
  const env = { ...process.env, JGATES_HOME: home };
  return (...args) => spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, timeout: 240_000 });
}

/** Plans through the CLI, runs the planned semgrep arguments on the engine and normalizes the output with the adapter. */
function scanWithPack(variant) {
  const eng = engine();
  const dir = packWorkspace(variant);
  const out = tmp("jgates-pack-out-");
  const home = tmp("jgates-pack-home-");
  try {
    const cli = packCli(dir, home);
    const init = cli("init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json");
    assert.equal(init.status, 0, init.stdout + init.stderr);
    fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), PACK_TOOLS);
    const planned = cli("plan", "--cwd", dir, "--only", "tool:semgrep", "--json");
    const doc = JSON.parse(planned.stdout);
    const item = doc.plan.groups.willRun.find((i) => i.id === "semgrep#sast");
    assert.ok(item, planned.stdout.slice(0, 600));
    const args = item.command.args;
    const configs = args.flatMap((a, i) => (a === "--config" ? [args[i + 1]] : []));
    assert.ok(configs.some((c) => path.resolve(c) === PACK_RULES), `the plan uses the bundled pack: ${configs.join(", ")}`);
    const outFile = path.join(out, "semgrep.json");
    const docker = eng.kind === "docker";
    const real = args
      .filter((a) => a !== "--quiet")
      .map((a) => {
        if (path.resolve(a) === PACK_RULES) return docker ? "/pack" : a;
        if (/^\{runDir\}.*semgrep\.json$/.test(a)) return docker ? "/out/semgrep.json" : outFile;
        if (a === ".") return docker ? "/ws" : dir;
        return a.replace("{workspace}", docker ? "/ws" : dir);
      });
    const run = eng.run(real, { [dir]: { path: "/ws" }, [PACK_RULES]: { path: "/pack" }, [out]: { path: "/out", writable: true } });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const root = docker ? "/ws" : dir;
    const parsed = semgrepAdapter.parseSemgrepOutput(fs.readFileSync(outFile, "utf8"), { stageId: "semgrep#sast", version: eng.kind, workspace: root, cwd: root });
    assert.equal(parsed.ok, true, parsed.problem);
    return { findings: parsed.findings, configs, item };
  } finally {
    for (const d of [dir, out, home]) fs.rmSync(d, { recursive: true, force: true });
  }
}

test("the rule tests of the bundled pack pass on a real Semgrep (ruleid/ok annotations of every rule file) [proves: semgrep#sast]", () => {
  const eng = engine();
  const docker = eng.kind === "docker";
  // A few jobs only: Semgrep starts one engine process per job, and the suite runs other scans at the same time.
  const run = eng.run(["--test", "--jobs=2", "--metrics=off", "--disable-version-check", docker ? "/rules" : PACK_RULES], { [PACK_RULES]: { path: "/rules" } });
  const text = `${run.stdout}\n${run.stderr}`;
  assert.equal(run.status, 0, text);
  assert.match(text, /All tests passed/, text);
  const files = fs.readdirSync(PACK_RULES);
  const yamls = files.filter((f) => f.endsWith(".yaml"));
  assert.ok(yamls.length >= 8, "the pack covers injection, SSRF, path traversal, crypto, deserialization and authorization for Python and JavaScript");
  for (const y of yamls) {
    const stem = y.replace(/\.yaml$/, "");
    assert.ok(files.some((f) => f.startsWith(`${stem}.`) && !f.endsWith(".yaml")), `${y} has a test file`);
  }
});

test("the bundled pack flags the vulnerable fixture and its clean twin none, with normalized findings [proves: semgrep#sast]", () => {
  const bad = scanWithPack("vulnerable");
  const ids = new Set(bad.findings.map((f) => f.ruleId));
  for (const id of [
    "jgates.python.sql-string-building",
    "jgates.python.os-command-injection",
    "jgates.python.weak-hash",
    "jgates.python.unsafe-deserialization",
    "jgates.js.path-traversal",
    "jgates.js.ssrf",
    "jgates.js.weak-hash",
    "jgates.js.os-command-injection",
    "jgates.js.jwt-signature-not-verified",
  ]) assert.ok(ids.has(id), `${id} missing in ${[...ids].join(", ")}`);
  for (const f of bad.findings) {
    assert.equal(f.tool, "semgrep");
    assert.ok(f.location.path && f.location.line > 0, JSON.stringify(f));
  }
  assert.deepEqual([...new Set(bad.findings.map((f) => f.location.path))].sort(), ["app.py", "server.js", "server.ts"]);
  const clean = scanWithPack("clean");
  assert.deepEqual(clean.findings.map((f) => f.ruleId), []);
});

test("the pack runs next to the customer's own rules, and an unknown pack id is refused", () => {
  const dir = packWorkspace("clean");
  const home = tmp("jgates-pack-home-");
  try {
    const cli = packCli(dir, home);
    assert.equal(cli("init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json").status, 0);
    fs.mkdirSync(path.join(dir, ".jgates", "rules"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".jgates", "rules", "no-eval.yml"), RULE("eval(...)"));
    fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), `${PACK_TOOLS}    config:\n      path: .jgates/rules\n      kind: directory\n      role: rules\n`);
    const both = JSON.parse(cli("plan", "--cwd", dir, "--only", "tool:semgrep", "--json").stdout).plan.groups.willRun.find((i) => i.id === "semgrep#sast");
    const configs = both.command.args.flatMap((a, i) => (a === "--config" ? [both.command.args[i + 1]] : []));
    assert.equal(configs.length, 2);
    assert.ok(configs.includes("{workspace}/.jgates/rules/no-eval.yml"));
    assert.ok(configs.some((c) => path.resolve(c) === PACK_RULES));
    assert.ok(both.configFiles.some((f) => f.file.endsWith("python-injection.yaml") && /^sha256:/.test(f.sha256)));
    assert.equal(both.network, false);
    fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), PACK_TOOLS.replace("rulePack: jgates", "rulePack: vendor-x"));
    const bad = cli("plan", "--cwd", dir, "--only", "tool:semgrep", "--json");
    const verdict = JSON.parse(bad.stdout || "{}");
    assert.ok(bad.status !== 0 || verdict.plan?.approvable === false, "an unknown pack id is refused: " + bad.stdout.slice(0, 300));
  } finally {
    for (const d of [dir, home]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("the pack passes the distribution check", () => {
  const result = spawnSync(process.execPath, [MAIN, "tools", "distribution", "--packs", PACK_ROOT, "--json"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const doc = JSON.parse(result.stdout);
  const pack = (doc.report?.packs ?? []).find((p) => p.id === "jgates-semgrep-rules");
  assert.ok(pack, result.stdout.slice(0, 500));
  assert.equal(pack.ok, true, JSON.stringify(pack.problems));
});
