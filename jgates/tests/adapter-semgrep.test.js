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
    // Every --config is a local path: the project's own rule file, then the rules of the pack the base template turns on
    // (they ship with JGates); there is no registry reference.
    const configs = args.flatMap((a, i) => (a === "--config" ? [args[i + 1]] : []));
    assert.equal(configs[0], "{workspace}/.jgates/rules/no-eval.yml");
    assert.ok(configs.slice(1).every((c) => /jgates-semgrep[\\/]rules$/.test(c)), JSON.stringify(configs));
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

test("an instance without a rules binding of its own runs the bundled pack the base template turns on, and the manifest is valid", () => {
  const p = project();
  try {
    fs.writeFileSync(path.join(p.dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  semgrep:\n    adapter: semgrep\n    capabilities: [sast]\n");
    const planned = p.plan();
    // The base template selects the pack that ships with JGates, so the instance always has rules: nothing asks for a binding.
    assert.doesNotMatch(JSON.stringify(planned.doc.plan.blockers), /regras locais/);
    const item = p.item(planned);
    assert.ok(item, JSON.stringify(planned.doc.plan.groups.willRun.map((i) => i.id)));
    assert.ok(item.command.args.some((a) => /jgates-semgrep[\\/]rules$/.test(a)));
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
// repository .venv, PATH) or the JGates tools image through Docker. With neither, the tests fail and say so.
// The twins live in fixtures/semgrep-pack/{vulnerable,clean}/<language>/ and the rule ids the vulnerable twin must flag
// in fixtures/semgrep-pack/expected/<language>.json: a new language is a new folder and a new file, no test code.

const PACK_ROOT = path.resolve(here, "..", "packs", "semgrep");
const PACK_RULES = path.join(PACK_ROOT, "jgates-semgrep", "rules");
const PACK_FIXTURES = path.join(here, "fixtures", "semgrep-pack");
const TOOLS_IMAGE = process.env.JGATES_SEMGREP_IMAGE || "jgates-tools:dev";
// The closed lists of the pack (prefixes, categories, subdimensions, severities, signal tags, forbidden keys) are the
// plain file the pack:check command reads too: one place, no copy in the tests.
const PACK_LISTS = JSON.parse(fs.readFileSync(path.join(here, "..", "src", "adapters", "semgrep", "pack-lists.json"), "utf8"));
const SECURITY_SUBDIMENSIONS = PACK_LISTS.subdimensions;
const PACK_CATEGORIES = PACK_LISTS.categories;
// Metadata keys (and links) typical of registry rules: a rule of this pack never carries one.
const FORBIDDEN_METADATA = PACK_LISTS.forbiddenMetadata;
// `semgrep --test` pairs an annotated fixture for `html` and `generic` rules too (checked on 1.182.1), so every rule kind
// of the pack, signals included, is proven by its fixture as well as by its twins.
const asvsData = await import(pathToFileURL(path.join(dist, "core", "coverage", "asvs", "index.js")).href);
const ASVS_IDS = new Set(asvsData.loadAsvs("5.0.0").requirements.map((r) => r.id));
const PACK_SEVERITIES = PACK_LISTS.severities;
const twinLanguages = () => fs.readdirSync(path.join(PACK_FIXTURES, "expected")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();

function localSemgrep() {
  // JGATES_SEMGREP_ENGINE=image proves the pack on the Semgrep of the tools image, whatever local Semgrep exists.
  if (process.env.JGATES_SEMGREP_ENGINE === "image") return null;
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
  const docker = spawnSync("docker", ["image", "inspect", TOOLS_IMAGE], { encoding: "utf8" });
  if (docker.status === 0) {
    return {
      kind: "docker",
      run: (args, mounts = {}) => {
        const volumes = Object.entries(mounts).flatMap(([host, inside]) => ["-v", `${host}:${inside.path}${inside.writable ? "" : ":ro"}`]);
        return spawnSync("docker", ["run", "--rm", "--label", "jproject.project=jgates", ...volumes, "--entrypoint", "semgrep", TOOLS_IMAGE, ...args], { encoding: "utf8", timeout: 240_000 });
      },
    };
  }
  throw new assert.AssertionError({ message: `no Semgrep engine available: install semgrep (JGATES_SEMGREP, .venv or PATH) or use the tools image ${TOOLS_IMAGE}; the pack tests cannot pass without one` });
}

// Group twins: `expected/<language>/<group>.json` ({ files, ruleIds } or { files, signals }) names the files (relative to the
// language folder) of one group's twins. Those files stay out of the per-language workspace and make a workspace of their
// own, so a new group twin is data only.
const GROUP_SUPPORT_FILES = { rust: ["Cargo.toml"] };
const groupsOf = (language) => {
  const dir = path.join(PACK_FIXTURES, "expected", language);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => ({ group: f.replace(/\.json$/, ""), expected: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }));
};
const twinGroupLanguages = () => {
  const dir = path.join(PACK_FIXTURES, "expected");
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
};
const slash = (p) => p.split(path.sep).join("/");

const packWorkspace = (variant, language, group = null) => {
  const dir = tmp("jgates-pack-ws-");
  const src = path.join(PACK_FIXTURES, variant, language);
  const groups = groupsOf(language);
  if (group === null) {
    const taken = new Set(groups.flatMap((g) => g.expected.files ?? []));
    fs.cpSync(src, dir, { recursive: true, filter: (from) => fs.statSync(from).isDirectory() || !taken.has(slash(path.relative(src, from))) });
  } else {
    const found = groups.find((g) => g.group === group);
    assert.ok(found, `${language}: no expected/${language}/${group}.json`);
    for (const file of [...(GROUP_SUPPORT_FILES[language] ?? []), ...found.expected.files]) {
      if (!fs.existsSync(path.join(src, file))) continue;
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(path.join(src, file), path.join(dir, file));
    }
  }
  return dir;
};
const PACK_TOOLS = "schemaVersion: 1\ntools:\n  semgrep:\n    adapter: semgrep\n    capabilities: [sast]\n    rulePack: jgates\n";

function packCli(dir, home) {
  const env = { ...process.env, JGATES_HOME: home };
  return (...args) => spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, timeout: 240_000 });
}

/** Plans through the CLI, runs the planned semgrep arguments on the engine and normalizes the output with the adapter. */
function scanWithPack(variant, language, group = null) {
  const eng = engine();
  const dir = packWorkspace(variant, language, group);
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
    return { findings: parsed.findings, signals: parsed.signals, configs, item };
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
});

test("every rule of the bundled pack has its language prefix, its metadata and an annotated fixture, and no registry key", () => {
  const index = semgrepAdapter.buildPackIndex(PACK_RULES);
  assert.deepEqual(index.problems, []);
  assert.ok(index.rules.length >= 24, "the pack keeps its 24 JavaScript and Python rules");
  const prefixes = semgrepAdapter.PACK_LANGUAGE_PREFIX;
  assert.deepEqual(Object.values(prefixes).sort(), ["config", "csharp", "go", "html", "java", "js", "php", "python", "rust"], "the nine prefixes");
  assert.deepEqual(prefixes, PACK_LISTS.languages, "the index reads the same lists as the tests");
  assert.ok(PACK_LISTS.subdimensions.includes("hardening"));
  const seen = new Set();
  const families = new Map();
  for (const rule of index.rules) {
    assert.ok(!seen.has(rule.id), `${rule.id} is defined once`);
    seen.add(rule.id);
    assert.ok(prefixes[rule.language], `${rule.file}: ${rule.language} is a language of the pack`);
    assert.ok(rule.id.startsWith(`jgates.${prefixes[rule.language]}.`), `${rule.id} carries the prefix of ${rule.language}`);
    assert.ok(PACK_SEVERITIES.includes(rule.severity), `${rule.id}: severity ${rule.severity}`);
    assert.equal(rule.author, "JGates", `${rule.id}: author`);
    if (rule.metadataKeys.includes("class")) {
      assert.equal(rule.class, "review", `${rule.id}: class must be review`);
      assert.equal(rule.severity, "INFO", `${rule.id}: Review is INFO`);
      assert.equal(rule.signal, null, `${rule.id}: Review is not a signal`);
    }
    if (rule.id.endsWith("-by-default")) assert.equal(rule.class, "review", `${rule.id}: -by-default requires class: review`);
    for (const key of FORBIDDEN_METADATA) assert.ok(!rule.metadataKeys.includes(key), `${rule.id}: metadata key ${key} is typical of registry rules`);
    if (rule.signal !== null) {
      // A signal rule is a record of the scan, never a finding: INFO, `signal` from the closed list, `author`, nothing else.
      assert.ok(PACK_LISTS.signalTags.includes(rule.signal), `${rule.id}: signal ${rule.signal}`);
      assert.equal(rule.severity, "INFO", `${rule.id}: a signal rule is INFO`);
      assert.deepEqual(rule.metadataKeys, [...PACK_LISTS.signalMetadata].sort(), `${rule.id}: a signal rule carries only signal and author`);
      assert.equal(rule.family, `uses-${rule.signal}`, `${rule.id}: named uses-<tag>`);
    } else {
      assert.ok(PACK_CATEGORIES.includes(rule.category), `${rule.id}: category ${rule.category}`);
      assert.match(rule.cwe, /^CWE-\d+$/, `${rule.id}: CWE`);
      assert.ok(SECURITY_SUBDIMENSIONS.includes(rule.subdimension), `${rule.id}: subdimension ${rule.subdimension}`);
      assert.deepEqual(rule.metadataKeys.filter((key) => !PACK_LISTS.optionalRuleMetadata.includes(key)), [...PACK_LISTS.ruleMetadata].sort(), `${rule.id}: only the metadata keys of a rule`);
      assert.ok(rule.asvsRequirements.length > 0, `${rule.id}: asvs_requirements`);
      for (const req of rule.asvsRequirements) assert.ok(ASVS_IDS.has(req), `${rule.id}: ${req} is a requirement of the vendored data`);
      assert.equal(new Set(rule.asvsRequirements).size, rule.asvsRequirements.length, `${rule.id}: a requirement once`);
      // One family name means one category and one CWE in every language.
      const kind = `${rule.category} ${rule.cwe}`;
      if (!families.has(rule.family)) families.set(rule.family, { kind, id: rule.id });
      assert.equal(families.get(rule.family).kind, kind, `${rule.id}: the family ${rule.family} has another category or CWE than ${families.get(rule.family).id}`);
    }
    assert.ok(rule.fixture, `${rule.file} has a fixture beside it`);
    // A rule file may have a fixture per extension (.js, .jsx, .ts): the cases of a rule may sit in any of them.
    const fixture = rule.fixtures.map((f) => fs.readFileSync(path.join(PACK_RULES, f), "utf8")).join("\n");
    const id = rule.id.replace(/[.]/g, "\\.");
    assert.match(fixture, new RegExp(`ruleid:\\s*${id}(?![\\w.-])`), `${rule.id} has a ruleid: case`);
    assert.match(fixture, new RegExp(`\\bok:\\s*${id}(?![\\w.-])`), `${rule.id} has an ok: case`);
  }
  for (const file of semgrepAdapter.listPackRuleFiles(PACK_RULES)) {
    const text = fs.readFileSync(path.join(PACK_RULES, file), "utf8");
    assert.doesNotMatch(text, /semgrep\.dev/i, `${file} links to the registry`);
  }
});

/** One language's twins: every expected rule id comes back from the vulnerable twin, the clean twin has no finding. */
function checkTwin(language) {
  const known = new Set(semgrepAdapter.buildPackIndex(PACK_RULES).rules.map((r) => r.id));
  const expected = JSON.parse(fs.readFileSync(path.join(PACK_FIXTURES, "expected", `${language}.json`), "utf8"));
  assert.ok(Array.isArray(expected.ruleIds) && expected.ruleIds.length > 0, `expected/${language}.json lists rule ids`);
  for (const id of expected.ruleIds) assert.ok(known.has(id), `${language}: ${id} is a rule of the pack`);
  const bad = scanWithPack("vulnerable", language);
  const ids = new Set(bad.findings.map((f) => f.ruleId));
  for (const id of expected.ruleIds) assert.ok(ids.has(id), `${language}: ${id} missing in ${[...ids].join(", ")}`);
  for (const f of bad.findings) {
    assert.equal(f.tool, "semgrep");
    assert.ok(f.location.path && f.location.line > 0, JSON.stringify(f));
  }
  assert.deepEqual([...new Set(bad.findings.map((f) => f.location.path))].sort(), [...expected.files].sort(), language);
  const clean = scanWithPack("clean", language);
  // A signal rule records the technology a file uses (the scan here is parsed without the pack's signal map, so its results
  // show up as findings): the clean twin has no finding of a check, as in checkGroupTwin.
  assert.deepEqual(clean.findings.filter((f) => !isSignal(f)).map((f) => f.ruleId), [], `${language} clean twin`);
}

const SIGNAL_ID = /^jgates\.[a-z]+\.uses-([a-z0-9-]+)$/;
/** The signal tags of a scan: the `signals` record of the parse result when present, else the ids `jgates.<prefix>.uses-<tag>`. */
function signalTags(scan) {
  const record = scan.signals;
  if (record !== undefined && record !== null) {
    const entries = Array.isArray(record) ? record : Object.entries(record).filter(([, v]) => v).map(([k]) => k);
    return [...new Set(entries.map((e) => (typeof e === "string" ? e : e.tag ?? e.signal)))].sort();
  }
  return [...new Set(scan.findings.map((f) => SIGNAL_ID.exec(f.ruleId)?.[1]).filter(Boolean))].sort();
}
const isSignal = (f) => SIGNAL_ID.test(f.ruleId);

/** Compares a scan of a group's vulnerable twin with its expected file: exact rule ids, or exact signal tags. */
function compareGroup(label, expected, scan) {
  const real = scan.findings.filter((f) => !isSignal(f));
  if (expected.signals !== undefined) {
    assert.deepEqual(signalTags(scan), [...expected.signals].sort(), `${label}: signal tags`);
    assert.deepEqual([...new Set(real.map((f) => f.ruleId))], [], `${label}: a signals group has no finding`);
    return;
  }
  assert.deepEqual([...new Set(real.map((f) => f.ruleId))].sort(), [...expected.ruleIds].sort(), `${label}: rule ids`);
  assert.deepEqual([...new Set(real.map((f) => f.location.path))].sort(), [...expected.files].filter((f) => !/(^|\/)Cargo\.toml$/.test(f)).sort(), `${label}: files with findings`);
}

/** One group's twins: the vulnerable twin gives exactly the expected ids (or tags), the clean twin nothing; the whole pack is the configuration. */
function checkGroupTwin(language, group, expected) {
  const label = `${language}/${group}`;
  assert.ok(Array.isArray(expected.files) && expected.files.length > 0, `expected/${label}.json lists files`);
  assert.ok(Array.isArray(expected.ruleIds) !== Array.isArray(expected.signals), `expected/${label}.json lists ruleIds or signals`);
  if (expected.ruleIds) {
    const known = new Set(semgrepAdapter.buildPackIndex(PACK_RULES).rules.map((r) => r.id));
    for (const id of expected.ruleIds) assert.ok(known.has(id), `${label}: ${id} is a rule of the pack`);
  }
  const bad = scanWithPack("vulnerable", language, group);
  for (const f of bad.findings) assert.ok(f.tool === "semgrep" && f.location.path && f.location.line > 0, JSON.stringify(f));
  compareGroup(label, expected, bad);
  const clean = scanWithPack("clean", language, group);
  assert.deepEqual(clean.findings.filter((f) => !isSignal(f)).map((f) => f.ruleId), [], `${label} clean twin`);
  if (expected.signals !== undefined) assert.deepEqual(signalTags(clean), [], `${label} clean twin signals`);
}

test("every group twin (expected/<language>/<group>.json) gives exactly its rule ids or signal tags on the vulnerable twin and nothing on the clean one [proves: semgrep#sast]", async (t) => {
  // Each completed real group is a reported subtest, not an opaque multi-hour loop. Awaiting each one keeps the
  // scans sequential and preserves both twins and every exact comparison without a timer or a synthetic heartbeat.
  for (const language of twinGroupLanguages()) {
    for (const { group, expected } of groupsOf(language)) {
      await t.test(`${language}/${group}: vulnerable and clean twins`, () => checkGroupTwin(language, group, expected));
    }
  }
});

test("the group comparison fails when the expected ids or tags differ, and a group file stays out of the per-language workspace", () => {
  const finding = (ruleId, p) => ({ ruleId, tool: "semgrep", location: { path: p, line: 1 } });
  const scan = { findings: [finding("jgates.go.a", "x.go"), finding("jgates.go.uses-graphql", "x.go")] };
  compareGroup("ok", { files: ["x.go"], ruleIds: ["jgates.go.a"] }, scan);
  assert.throws(() => compareGroup("more", { files: ["x.go"], ruleIds: ["jgates.go.a", "jgates.go.b"] }, scan), assert.AssertionError);
  assert.throws(() => compareGroup("fewer", { files: ["x.go"], ruleIds: [] }, scan), assert.AssertionError);
  compareGroup("tags", { files: ["x.go"], signals: ["graphql"] }, { findings: [finding("jgates.go.uses-graphql", "x.go")] });
  assert.throws(() => compareGroup("tags", { files: ["x.go"], signals: ["graphql", "grpc"] }, { findings: [finding("jgates.go.uses-graphql", "x.go")] }), assert.AssertionError);
  assert.deepEqual(signalTags({ findings: [], signals: { graphql: 2, grpc: 0 } }), ["graphql"], "the signals record wins when present");
  // The workspace of a language folder leaves the files of its groups out; the workspace of a group holds only its files.
  const language = twinGroupLanguages()[0];
  if (language) {
    const taken = new Set(groupsOf(language).flatMap((g) => g.expected.files));
    const whole = packWorkspace("vulnerable", language);
    try {
      for (const file of taken) assert.ok(!fs.existsSync(path.join(whole, file)), `${file} is a group twin file`);
    } finally {
      fs.rmSync(whole, { recursive: true, force: true });
    }
  }
});

// The five languages added to the pack each have a literal-titled test below: the stack matrix cites them as the proof
// of the `validated` row of that stack. Any other twin language is covered by the data-driven test.
const TITLED_TWINS = ["go", "csharp", "rust", "java", "php"];

test("the bundled pack flags the vulnerable fixture of every other language as expected and its clean twin none, with normalized findings [proves: semgrep#sast]", () => {
  const languages = twinLanguages();
  assert.ok(languages.length >= 8, "the eight languages of the pack are twinned");
  for (const language of TITLED_TWINS) assert.ok(languages.includes(language), `${language} is twinned`);
  for (const language of languages.filter((l) => !TITLED_TWINS.includes(l))) checkTwin(language);
});

test("the bundled pack flags the vulnerable Go twin as expected and its clean twin none [proves: semgrep#sast, semgrep#sast@go]", () => checkTwin("go"));
test("the bundled pack flags the vulnerable C# twin as expected and its clean twin none [proves: semgrep#sast, semgrep#sast@csharp]", () => checkTwin("csharp"));
test("the bundled pack flags the vulnerable Rust twin as expected and its clean twin none [proves: semgrep#sast, semgrep#sast@rust]", () => checkTwin("rust"));
test("the bundled pack flags the vulnerable Java twin as expected and its clean twin none [proves: semgrep#sast, semgrep#sast@java]", () => checkTwin("java"));
test("the bundled pack flags the vulnerable PHP twin as expected and its clean twin none [proves: semgrep#sast, semgrep#sast@php]", () => checkTwin("php"));

test("HTML files and configuration files are counted as html and config, and a pack folder of each is a pack language", () => {
  const scanned = [
    "/ws/index.html", "/ws/old/page.HTM", "/ws/app.js", "/ws/conf/site.conf", "/ws/app.properties", "/ws/php.ini", "/ws/.htaccess", "/ws/web.config",
    "/ws/src/main/resources/application.yml", "/ws/application-dev.yaml", "/ws/appsettings.json", "/ws/appsettings.Production.json",
    "/ws/config/packages/security.yaml", "/ws/config/services.yaml", "/ws/config/app.php", "/ws/data.json", "/ws/ci.yml", "/ws/settings.xml",
  ];
  const counts = semgrepAdapter.scannedLanguageCounts(scanned, ["html", "config", "go"]);
  assert.equal(counts.html, 2);
  assert.equal(counts.config, 12, "the configuration files by extension, by file name and by the framework folders");
  assert.equal(counts.go, 0);
  assert.equal(counts.javascript, 1);
  assert.equal(counts.php, 1, "a Laravel config file is also a PHP file");
  assert.deepEqual(semgrepAdapter.scannedLanguageCounts(["/ws/data.json", "/ws/ci.yml"], ["html", "config"]), { html: 0, config: 0 });
  // The plan item names the two kinds of file in words a person reads, in both languages.
  assert.deepEqual(["html", "config"].map((l) => semgrepAdapter.packLanguageLabel(l, "en")), ["HTML files", "configuration files"]);
  assert.deepEqual(["html", "config"].map((l) => semgrepAdapter.packLanguageLabel(l, "pt-BR")), ["arquivos HTML", "arquivos de configuração"]);
  assert.deepEqual(semgrepAdapter.packLanguagesOf(["go/go-xss.yaml", "html/html-markup.yaml", "config/config-server.yaml", "config/config-framework.yaml"]), ["go", "html", "config"]);
});

test("the scanned languages of a Semgrep output are counted per language, a pack language with no file is 0, and the plan names what the pack lacks", () => {
  const counts = semgrepAdapter.scannedLanguageCounts(["/ws/A.java", "/ws/b.php", "/ws/c.PHP", "/ws/d.kt", "/ws/readme.md"], ["java", "php", "go"]);
  assert.deepEqual(counts, { java: 1, php: 2, go: 0, kotlin: 1 });
  const parsed = semgrepAdapter.parseSemgrepOutput(JSON.stringify({ results: [], errors: [], paths: { scanned: ["/ws/A.java"] } }), { stageId: "s", version: null, workspace: "/ws", cwd: "/ws" });
  assert.deepEqual(parsed.scanned, ["/ws/A.java"]);
  assert.deepEqual(semgrepAdapter.packLanguagesOf(["javascript-xss.yaml", "go/go-xss.yaml", "java/java-injection.yaml", "php/php-taint.yaml"]), ["javascript", "go", "java", "php"]);
});

test("the pack runs next to the customer's own rules, and an unknown pack id is refused", () => {
  const dir = packWorkspace("clean", "python");
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
