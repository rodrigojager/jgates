import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { docker, dockerAvailable } from "./dev-docker.mjs";

// Adapter migration B, with the real engine (npm run test:docker; never part of npm test): Semgrep, Gitleaks, Trivy,
// OSV-Scanner, Checkov, zizmor, govulncheck, cargo-audit, cargo-test, oasdiff, ZAP, CodeQL, supply-chain and the
// generic command run through `jgates run` in step containers of the local development image jgates-tools:dev. Each
// has a known-bad fixture (its finding or failure is detected) and a clean fixture (it passes), the project folder is
// byte for byte the same afterwards, and every step is a `docker run` of the image with the step container contract.
//
// The image carries no Semgrep rules, no CodeQL and no vulnerability database (the advisory data is the jgates-data
// volume, filled by `jgates tools update-data`). So: Semgrep runs the rules the fixture supplies; CodeQL is checked as
// absent (blocked, never passed); and the scanners that need advisories (OSV-Scanner, govulncheck, cargo-audit) run
// offline (`--network none`) against the data volume, which the suite fills first when a database is missing or older
// than the limit (the same call a user makes), so their known-bad fixtures are detected with no network.

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const dist = path.join(packageRoot, "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FIXTURES = path.join(packageRoot, "tests", "fixtures");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const engine = await load("core", "engine", "index.js");
const { workspaceId } = await load("core", "ids", "index.js");
const IMAGE = engine.DEV_TOOLS_IMAGE;

const made = [];
const workspaces = new Set();
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

/** Everything this suite created in the engine carries its workspace id (and the JGates labels); the cleanup selects by them only. */
function cleanup() {
  for (const ws of workspaces) {
    const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${ws}`];
    for (const id of docker(["ps", "-aq", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["rm", "-f", id]);
    for (const name of docker(["volume", "ls", "-q", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["volume", "rm", "-f", name]);
  }
}

before(() => {
  assert.ok(dockerAvailable(), "Docker is required for npm run test:docker (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
});

after(() => {
  try {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } finally {
    cleanup();
  }
});

function treeHash(root) {
  const h = crypto.createHash("sha256");
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".git") continue;
      if (e.isDirectory()) {
        h.update(`d:${next}\0`);
        walk(p, next);
      } else h.update(`f:${next}\0`).update(fs.readFileSync(p));
    }
  };
  walk(root, "");
  return h.digest("hex");
}

const GIT_IDENTITY = ["-c", "user.name=jgates-test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"];

/**
 * A project in its own folder (files written, git initialized, JGates initialized), with the tools.yml of the case.
 * `history` is a list of commits made after the files are written, each `{ message, write?: {name: content}, remove?: [name] }`.
 */
function makeProject({ files = {}, copy = null, tools = null, history = [], templates = [], extraEnv = {} }) {
  const project = tmp("jgates-adapters-b-project-");
  const home = tmp("jgates-adapters-b-home-");
  if (copy) fs.cpSync(copy, project, { recursive: true });
  const write = (entries) => {
    for (const [name, content] of entries) {
      fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
      fs.writeFileSync(path.join(project, name), content);
    }
  };
  // `jgates init` refuses a project that already has a .jgates folder: those files come after it.
  write(Object.entries(files).filter(([name]) => !name.startsWith(".jgates/")));
  const env = { ...process.env, JGATES_HOME: home, JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", ...extraEnv };
  delete env.JGATES_IMAGE_JSON;
  const cli = (args, timeout = 1_200_000) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout });
  const git = (...args) => {
    const r = spawnSync("git", [...GIT_IDENTITY, ...args], { cwd: project, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q");
  const init = cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  write(Object.entries(files).filter(([name]) => name.startsWith(".jgates/")));
  if (tools !== null) fs.writeFileSync(path.join(project, ".jgates", "tools.yml"), tools);
  // Project templates (id, file) join the configuration through jgates.yml.
  if (templates.length > 0) fs.appendFileSync(path.join(project, "jgates.yml"), templates.map(([id, source]) => `  - id: ${id}\n    source: ${source}\n    activation: always\n`).join(""));
  git("add", "-A");
  if (history.length > 0) {
    git("commit", "-q", "-m", "initial");
    for (const step of history) {
      write(Object.entries(step.write ?? {}));
      for (const name of step.remove ?? []) fs.rmSync(path.join(project, name), { force: true });
      git("add", "-A");
      git("commit", "-q", "--allow-empty", "-m", step.message);
    }
  }
  const ws = workspaceId(project);
  workspaces.add(ws);
  return {
    project,
    home,
    ws,
    cli,
    run: (tool) => {
      const ran = cli(["run", "--cwd", project, "--no-interactive", "--json", "--only", `tool:${tool}`]);
      let doc = null;
      try {
        doc = JSON.parse(ran.stdout);
      } catch {
        doc = null;
      }
      assert.ok(doc?.stages, `${tool}: no result document\n${ran.stdout.slice(0, 3000)}\n${ran.stderr.slice(0, 3000)}`);
      return { code: ran.status, doc };
    },
  };
}

const found = (doc, tool) => doc.findings.filter((f) => f.tool === tool || f.origin === tool);
const summary = (doc) => JSON.stringify({ decision: doc.decision, stages: doc.stages.map((s) => [s.id, s.state, s.reason]), findings: doc.findings.map((f) => [f.tool, f.ruleId, f.location?.path]) }).slice(0, 4000);

/** All the step logs of a run (stdout and stderr) as one text. */
function logsOf(doc) {
  const dir = path.join(doc.runDir, "logs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), "utf8")).join("\n=====\n") : "";
}

/** The run really went through the engine: a step container of the image, with the contract's flags, and nothing else. */
function assertRanInContainers(doc, ws) {
  const logs = logsOf(doc);
  for (const part of ["run --rm --init --pull never --name", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges"]) {
    assert.ok(logs.includes(part), `a step log holds the docker run flag ${part}`);
  }
  assert.ok(!/HOST_EXECUTION_REFUSED/.test(JSON.stringify(doc.stages)), "no step was refused");
  assert.equal(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${ws}`]).out.trim(), "", "no container of the run is left");
}

/**
 * The bad project fails its check (a finding of the tool, or a failed decision) and the clean one passes, both through
 * the real engine and both leaving the project folder untouched.
 */
function scenario(name, { bad, clean, tool, rule, badStage = "completed", blocking = true, containers = true, check = () => {} }) {
  test(name, () => {
    for (const kind of ["bad", "clean"]) {
      const p = makeProject(kind === "bad" ? bad : clean);
      const before = treeHash(p.project);
      const { doc } = p.run(tool);
      assert.equal(treeHash(p.project), before, `${kind}: the project folder is identical after the run`);
      assert.deepEqual(doc.workspaceChanges?.added ?? [], [], `${kind}: nothing was added to the project`);
      if (containers) assertRanInContainers(doc, p.ws);
      const stage = doc.stages.find((s) => s.id.startsWith(`${tool}#`));
      assert.ok(stage, `${kind}: the stage of ${tool} exists: ${summary(doc)}`);
      if (kind === "bad") {
        const mine = found(doc, rule.tool ?? tool);
        assert.equal(stage.state, badStage, `bad: ${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        if (rule.id !== undefined || rule.path !== undefined || badStage === "completed") assert.ok(mine.length > 0, `bad: the tool reported findings: ${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        if (rule.id) assert.ok(mine.some((f) => (rule.id instanceof RegExp ? rule.id.test(f.ruleId) : f.ruleId === rule.id)), `bad: rule ${rule.id} among ${JSON.stringify(mine.map((f) => f.ruleId))}`);
        if (rule.path) assert.ok(mine.some((f) => f.location?.path === rule.path), `bad: a finding at ${rule.path}: ${JSON.stringify(mine.map((f) => f.location))}`);
        if (blocking) assert.notEqual(doc.decision, "passed", `bad: the run must not pass: ${summary(doc)}`);
        check(doc, p, "bad");
      } else {
        assert.equal(stage.state, "completed", `clean: ${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        assert.equal(found(doc, rule.tool ?? tool).length, 0, `clean: no finding: ${summary(doc)}`);
        assert.equal(doc.decision, "passed", `clean: ${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        check(doc, p, "clean");
      }
    }
  });
}

const toolsYml = (id, adapter, capabilities, extra = "") => `schemaVersion: 1\ntools:\n  ${id}:\n    adapter: ${adapter}\n    capabilities: [${capabilities}]\n${extra}`;

const dataModule = await load("core", "data", "index.js");

/** Fills the jgates-data volume with the databases that are missing or older than the limit (real downloads, once per suite). */
const ensured = new Set();
function ensureAdvisoryData(ids) {
  const env = { ...process.env, JGATES_TOOLS_IMAGE: IMAGE, JGATES_LOCALE: "en" };
  const ages = dataModule.agesOf(dataModule.readDataStatusSync(env, "0.0.0").status, new Date(), dataModule.DEFAULT_DATA_MAX_AGE_DAYS);
  const stale = ids.filter((id) => !ensured.has(id) && ages.find((a) => a.id === id).state !== "fresh");
  if (stale.length > 0) {
    const r = spawnSync(process.execPath, [MAIN, "tools", "update-data", "--database", stale.join(","), "--json"], { encoding: "utf8", env, timeout: 1_800_000 });
    assert.equal(r.status, 0, `update-data ${stale.join(",")}: ${r.stdout.slice(-1500)}${r.stderr.slice(-1500)}`);
  }
  for (const id of ids) ensured.add(id);
}

// ---------------------------------------------------------------------------------------------------------------------
// SAST, secrets and infrastructure
// ---------------------------------------------------------------------------------------------------------------------

const SEMGREP_RULE = "rules:\n  - id: no-eval\n    message: Do not call eval\n    severity: ERROR\n    languages: [python]\n    pattern: eval(...)\n";
const SEMGREP_TOOLS = toolsYml("semgrep", "semgrep", "sast", "    config:\n      path: .jgates/rules\n      kind: directory\n      role: rules\n");
const semgrepProject = (source) => ({ files: { "src/app.py": source, ".jgates/rules/no-eval.yml": SEMGREP_RULE }, tools: SEMGREP_TOOLS });

scenario("semgrep: the project's own rule finds eval() and the clean source passes (no registry rules are needed)", {
  tool: "semgrep",
  rule: { id: /no-eval$/, path: "src/app.py" },
  bad: semgrepProject('value = eval("1")\n'),
  clean: semgrepProject("value = int('1')\n"),
});

/** A synthetic token shaped like a GitHub personal access token, assembled here so no scanner flags this file. */
const FAKE_TOKEN = ["ghp", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
const secretSource = `GITHUB_TOKEN = "${FAKE_TOKEN}"\n`;

scenario("gitleaks (files): a committed-looking token is a redacted finding and the clean module passes", {
  tool: "gitleaks",
  rule: { id: "github-pat", path: "settings.py" },
  bad: { files: { "settings.py": secretSource }, tools: toolsYml("gitleaks", "gitleaks", "secrets") },
  clean: { files: { "settings.py": 'GITHUB_TOKEN = os.environ["GITHUB_TOKEN"]\n' }, tools: toolsYml("gitleaks", "gitleaks", "secrets") },
  check: (doc, _p, kind) => {
    const all = JSON.stringify(doc) + logsOf(doc);
    assert.ok(!all.includes(FAKE_TOKEN), `${kind}: the raw secret never reaches the result or the logs`);
  },
});

scenario("gitleaks (history): a token removed in a later commit is still found in the history, and a history without it passes", {
  tool: "gitleaks",
  rule: { id: "github-pat" },
  bad: {
    files: { "settings.py": 'DEBUG = True\n' },
    tools: toolsYml("gitleaks", "gitleaks", "secrets-history"),
    history: [{ message: "add token", write: { "settings.py": secretSource } }, { message: "remove token", write: { "settings.py": "DEBUG = True\n" } }],
  },
  clean: {
    files: { "settings.py": "DEBUG = True\n" },
    tools: toolsYml("gitleaks", "gitleaks", "secrets-history"),
    history: [{ message: "change", write: { "settings.py": "DEBUG = False\n" } }],
  },
});

const DOCKERFILE_BAD = "FROM alpine:3.20\nRUN echo hello\n";
const DOCKERFILE_CLEAN = "FROM alpine:3.20\nRUN adduser -D app\nUSER app\nHEALTHCHECK CMD true\nCMD [\"true\"]\n";

scenario("trivy (misconfiguration): a Dockerfile that runs as root is a finding and the hardened one passes", {
  tool: "trivy",
  rule: { id: /DS-?0?002|DS002/, path: "Dockerfile" },
  bad: { files: { Dockerfile: DOCKERFILE_BAD }, tools: toolsYml("trivy", "trivy", "iac") },
  clean: { files: { Dockerfile: DOCKERFILE_CLEAN }, tools: toolsYml("trivy", "trivy", "iac") },
});

scenario("checkov: a Dockerfile without a user is a failed check and the hardened one passes", {
  tool: "checkov",
  rule: { id: "CKV_DOCKER_3", path: "Dockerfile" },
  bad: { files: { Dockerfile: DOCKERFILE_BAD }, tools: toolsYml("checkov", "checkov", "iac") },
  clean: { files: { Dockerfile: DOCKERFILE_CLEAN }, tools: toolsYml("checkov", "checkov", "iac") },
});

scenario("zizmor: a template injection in a workflow is a finding and the clean workflow passes", {
  tool: "zizmor",
  rule: { id: "template-injection" },
  bad: { copy: path.join(FIXTURES, "zizmor", "injection"), tools: toolsYml("zizmor", "zizmor", "ci-cd") },
  clean: { copy: path.join(FIXTURES, "zizmor", "clean"), tools: toolsYml("zizmor", "zizmor", "ci-cd") },
});

// ---------------------------------------------------------------------------------------------------------------------
// Dependencies (advisory data: the jgates-data volume, offline scanners)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Known-bad / clean pair of a scanner that reads advisory data: the data volume is filled first, then the pair behaves
 * like `scenario`, with the step started with no network and the volume mounted read-only.
 */
function advisoryScenario(name, { database, tool, rule, bad, clean }) {
  test(`${name} [advisory data: ${database}, offline]`, () => {
    ensureAdvisoryData([database]);
    for (const kind of ["bad", "clean"]) {
      const p = makeProject(kind === "bad" ? bad : clean);
      const before = treeHash(p.project);
      const { doc } = p.run(tool);
      assert.equal(treeHash(p.project), before, `${kind}: the project folder is identical after the run`);
      assertRanInContainers(doc, p.ws);
      const logs = logsOf(doc);
      assert.ok(/--network\s+none/.test(logs), `${kind}: the scanner step has no network\n${logs.slice(-1500)}`);
      assert.ok(logs.includes("type=volume,src=jgates-data,dst=/data,readonly"), `${kind}: the data volume is mounted read-only`);
      const stage = doc.stages.find((s) => s.id.startsWith(`${tool}#`));
      assert.ok(stage, `${kind}: the stage of ${tool} exists: ${summary(doc)}`);
      assert.equal(stage.state, "completed", `${kind}: ${summary(doc)}\n${logs.slice(-2500)}`);
      assert.ok(stage.analysisInput?.database?.updatedAt, `${kind}: the stage records the fetch time of the database: ${JSON.stringify(stage)}`);
      if (kind === "bad") {
        const mine = found(doc, rule.tool ?? tool);
        assert.ok(mine.length > 0 && mine.some((f) => (rule.id instanceof RegExp ? rule.id.test(f.ruleId) : f.ruleId === rule.id)), `bad: ${rule.id} among ${JSON.stringify(mine.map((f) => f.ruleId))}\n${logs.slice(-2500)}`);
        assert.notEqual(doc.decision, "passed", `bad: ${summary(doc)}`);
      } else {
        assert.equal(found(doc, rule.tool ?? tool).length, 0, `clean: ${summary(doc)}`);
        assert.equal(doc.decision, "passed", `clean: ${summary(doc)}\n${logs.slice(-2500)}`);
      }
    }
  });
}

const npmLock = (version) =>
  JSON.stringify({ name: "demo", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "demo", version: "1.0.0", dependencies: { lodash: version } }, "node_modules/lodash": { version, resolved: `https://registry.npmjs.org/lodash/-/lodash-${version}.tgz` } } }, null, 2) + "\n";

advisoryScenario("osv-scanner: a lockfile with a vulnerable lodash is a finding and the current lodash passes", {
  database: "osv",
  tool: "osv-scanner",
  rule: { id: /^(GHSA|CVE|OSV)/ },
  bad: { files: { "package-lock.json": npmLock("4.17.15"), "package.json": '{"name":"demo","version":"1.0.0","dependencies":{"lodash":"4.17.15"}}\n' }, tools: toolsYml("osv-scanner", "osv-scanner", "dependencies") },
  // No third-party package at all: the clean answer does not depend on how the advisories about any package change over time.
  clean: { files: { "package-lock.json": JSON.stringify({ name: "demo", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "demo", version: "1.0.0" } } }, null, 2) + "\n", "package.json": '{"name":"demo","version":"1.0.0"}\n' }, tools: toolsYml("osv-scanner", "osv-scanner", "dependencies") },
});

const GO_MOD = "module example.com/demo\n\ngo 1.21\n\nrequire golang.org/x/text v0.3.0\n";
const GO_SUM = "golang.org/x/text v0.3.0 h1:g61tztE5qeGQ89tm6NTjjM9VPIm088od1l6aSorWRWg=\ngolang.org/x/text v0.3.0/go.mod h1:NqM8EUOU14njkJ3fqMW+pc6Ldnwhi/IjpwHt7yyuwOQ=\n";
const GO_BAD = 'package main\n\nimport (\n\t"fmt"\n\n\t"golang.org/x/text/language"\n)\n\nfunc main() {\n\ttags, _, err := language.ParseAcceptLanguage("en-US,fr;q=0.8")\n\tfmt.Println(tags, err)\n}\n';
const GO_CLEAN = 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello")\n}\n';

advisoryScenario("govulncheck: a reachable vulnerable call is a finding and a module without dependencies passes", {
  database: "govulndb",
  tool: "govulncheck",
  rule: { id: /^GO-/ },
  bad: { files: { "go.mod": GO_MOD, "go.sum": GO_SUM, "main.go": GO_BAD }, tools: toolsYml("govulncheck", "govulncheck", "dependencies") },
  clean: { files: { "go.mod": "module example.com/demo\n\ngo 1.21\n", "main.go": GO_CLEAN }, tools: toolsYml("govulncheck", "govulncheck", "dependencies") },
});

const cargoLock = (crates) =>
  `# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 3\n\n[[package]]\nname = "demo"\nversion = "0.1.0"\n${crates.length ? `dependencies = [\n${crates.map((c) => ` "${c.name}",\n`).join("")}]\n` : ""}${crates.map((c) => `\n[[package]]\nname = "${c.name}"\nversion = "${c.version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`).join("")}`;
const CARGO_TOML = '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n';

advisoryScenario("cargo-audit: a lockfile with a vulnerable crate is a finding and one without dependencies passes", {
  database: "rustsec",
  tool: "cargo-audit",
  rule: { id: /^RUSTSEC-/ },
  bad: { files: { "Cargo.toml": CARGO_TOML, "Cargo.lock": cargoLock([{ name: "time", version: "0.1.43" }]), "src/lib.rs": "pub fn id() {}\n" }, tools: toolsYml("cargo-audit", "cargo-audit", "dependencies") },
  clean: { files: { "Cargo.toml": CARGO_TOML, "Cargo.lock": cargoLock([]), "src/lib.rs": "pub fn id() {}\n" }, tools: toolsYml("cargo-audit", "cargo-audit", "dependencies") },
});

// ---------------------------------------------------------------------------------------------------------------------
// Rust tests, API compatibility, supply chain, the generic command, CodeQL
// ---------------------------------------------------------------------------------------------------------------------

const HALVE_BAD = "/// Half of `x`, rounded down. Bug: halve(10) is 6.\npub fn halve(x: u32) -> u32 {\n    if x == 10 {\n        6\n    } else {\n        x / 2\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn halve_of_ten_is_five() {\n        assert_eq!(halve(10), 5);\n    }\n}\n";
const HALVE_CLEAN = HALVE_BAD.replace("    if x == 10 {\n        6\n    } else {\n        x / 2\n    }\n", "    x / 2\n").replace(" Bug: halve(10) is 6.", "");
const halverToml = '[package]\nname = "halver"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n';

scenario("cargo-test: a failing test fails the step with its name and a passing suite passes", {
  tool: "cargo-test",
  rule: { id: /./ },
  bad: { files: { "Cargo.toml": halverToml, "src/lib.rs": HALVE_BAD }, tools: toolsYml("cargo-test", "cargo-test", "tests") },
  clean: { files: { "Cargo.toml": halverToml, "src/lib.rs": HALVE_CLEAN }, tools: toolsYml("cargo-test", "cargo-test", "tests") },
  check: (doc, _p, kind) => {
    if (kind === "bad") assert.ok(found(doc, "cargo-test").some((f) => /halve_of_ten_is_five/.test(`${f.message} ${f.ruleId} ${JSON.stringify(f.location)}`)), summary(doc));
  },
});

const oasdiffProject = (variant) => ({
  files: { "openapi.yaml": fs.readFileSync(path.join(FIXTURES, "oasdiff", "base", "openapi.yaml"), "utf8") },
  tools: toolsYml("oasdiff", "oasdiff", "api-compatibility", "    spec: openapi.yaml\n    baseRef: HEAD~1\n"),
  history: [{ message: "change the API", write: { "openapi.yaml": fs.readFileSync(path.join(FIXTURES, "oasdiff", variant, "openapi.yaml"), "utf8") } }],
});

scenario("oasdiff: a removed operation breaks the contract against the committed base and an additive change passes", {
  tool: "oasdiff",
  rule: { id: /./ },
  bad: oasdiffProject("removed"),
  clean: oasdiffProject("additive"),
});

scenario("supply-chain: a lockfile with an unpinned remote source is a finding and the pinned lockfile passes (in-process analysis, no container)", {
  tool: "supply-chain",
  rule: { id: /./ },
  containers: false,
  bad: { copy: path.join(FIXTURES, "supply-chain", "npm-risky"), tools: toolsYml("supply-chain", "supply-chain", "supply-chain", "    blockOn: low\n") },
  clean: { copy: path.join(FIXTURES, "supply-chain", "npm-clean"), tools: toolsYml("supply-chain", "supply-chain", "supply-chain") },
});

/** A project template (.jgates/templates/gen.yml) with one generic-command check: the declaration lives in the template. */
const genericTemplate = (command) =>
  [
    "schemaVersion: 1",
    "id: gen",
    "extends: [builtin:base]",
    "config:",
    "  tools:",
    "    gen-check:",
    "      adapter: generic-command",
    "      enabled: true",
    "      capabilities: [lint]",
    `      command: ${JSON.stringify(command)}`,
    '      args: ["{workspace}/check.js"]',
    "      config:",
    "        effects: { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false }",
    "        evidence: { kind: exit-code }",
    "",
  ].join("\n");
const genericProject = (command, extra = {}) => ({ files: { "check.js": CHECK_JS, ".jgates/templates/gen.yml": genericTemplate(command), ...extra }, templates: [["gen", ".jgates/templates/gen.yml"]] });
const CHECK_JS = "const fs = require('node:fs');\nprocess.exit(fs.existsSync(process.cwd() + '/FAIL') ? 1 : 0);\n";

test("generic-command: the command runs in the step container and its exit code decides; a command the image lacks is an error, never a pass", () => {
  const bad = makeProject(genericProject("node", { FAIL: "1\n" }));
  const clean = makeProject(genericProject("node"));
  const missing = makeProject(genericProject("definitely-not-in-the-image"));
  const failed = bad.run("gen-check").doc;
  const passed = clean.run("gen-check").doc;
  const lost = missing.run("gen-check").doc;
  for (const [p, doc] of [[bad, failed], [clean, passed], [missing, lost]]) assertRanInContainers(doc, p.ws);
  assert.equal(failed.stages.find((s) => s.id === "gen-check#lint").state, "completed", summary(failed));
  assert.notEqual(failed.decision, "passed", summary(failed));
  assert.equal(passed.stages.find((s) => s.id === "gen-check#lint").state, "completed", `${summary(passed)}\n${logsOf(passed).slice(-2000)}`);
  assert.equal(passed.decision, "passed", summary(passed));
  assert.equal(lost.stages.find((s) => s.id === "gen-check#lint").state, "error", summary(lost));
  assert.notEqual(lost.decision, "passed", summary(lost));
});

test("codeql: the image carries no CodeQL, so the stage is blocked with the reason and the run never passes", () => {
  for (const dir of ["bad", "clean"]) {
    const p = makeProject({ copy: path.join(FIXTURES, "codeql", dir), tools: toolsYml("codeql", "codeql", "dataflow", "    enabled: true\n    language: python\n") });
    const { doc } = p.run("codeql");
    const stage = doc.stages.find((s) => s.id.startsWith("codeql#"));
    assert.ok(stage, summary(doc));
    assert.notEqual(stage.state, "completed", summary(doc));
    assert.notEqual(doc.decision, "passed", summary(doc));
    assert.ok(stage.reason, "the stage says why");
    assert.equal(found(doc, "codeql").length, 0);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// ZAP against a target the step container reaches on the host
// ---------------------------------------------------------------------------------------------------------------------

const SECURE_HEADERS = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; form-action 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store, max-age=0",
  "permissions-policy": "geolocation=()",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "referrer-policy": "no-referrer",
};

/** A page in its own process, on every interface and both IP families (the container reaches the host through the engine's gateway). `needsToken` answers 401 without the header. */
function startPage({ hardened, token = null }) {
  const script = `
    import http from "node:http";
    const headers = ${JSON.stringify(hardened ? SECURE_HEADERS : {})};
    const token = ${JSON.stringify(token)};
    const server = http.createServer((req, res) => {
      if (token && req.headers.authorization !== "Bearer " + token) { res.writeHead(401, { "content-type": "text/html; charset=utf-8" }); return res.end("<html><body>no</body></html>"); }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end("<!doctype html><html><head><title>fixture</title></head><body><p>hello</p></body></html>");
    });
    server.listen(0, "::", () => console.log("listening " + server.address().port));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const m = /listening (\d+)/.exec(buffer);
      if (m) resolve({ port: Number(m[1]), close: () => new Promise((done) => (child.once("exit", done), child.kill())) });
    });
    child.once("exit", (code) => reject(new Error(`the fixture page exited with ${code}`)));
  });
}

test("zap: a page without security headers has blocking alerts, the hardened page has none, through a network step container", async () => {
  const servers = [];
  try {
    for (const hardened of [false, true]) {
      const server = await startPage({ hardened });
      servers.push(server);
      const p = makeProject({
        files: { "package.json": JSON.stringify({ name: "web-fixture", private: true }) + "\n" },
        // The user writes the address the host knows; the step container reaches the host through its alias.
        tools: toolsYml("zap", "zap", "dast", `    target: http://localhost:${server.port}\n`),
      });
      const before = treeHash(p.project);
      const { doc } = p.run("zap");
      const stage = doc.stages.find((s) => s.id.startsWith("zap#"));
      assert.ok(stage, summary(doc));
      assert.equal(treeHash(p.project), before);
      assertRanInContainers(doc, p.ws);
      assert.ok(logsOf(doc).includes("--network bridge"), "the step container has the network the item declared");
      if (!hardened) {
        assert.equal(stage.state, "completed", `${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        const mine = found(doc, "zap");
        assert.ok(mine.some((f) => f.blocking), `bad: a blocking alert: ${summary(doc)}`);
        assert.ok(mine.some((f) => /Content Security Policy|Anti-clickjacking/i.test(f.message + f.ruleId)), summary(doc));
        // The alerts name the target the user wrote, not the alias the container used.
        assert.ok(!JSON.stringify(mine).includes("host.docker.internal"), "the container alias is rewritten back");
        assert.notEqual(doc.decision, "passed");
      } else {
        assert.equal(stage.state, "completed", `${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        assert.deepEqual(found(doc, "zap").filter((f) => f.blocking), [], summary(doc));
        assert.equal(doc.decision, "passed", summary(doc));
      }
    }
  } finally {
    for (const server of servers) await server.close();
  }
});

test("zap: the authentication header travels through the environment and never reaches the plan, the logs or the result", async () => {
  const secret = "zap-secret-" + crypto.randomBytes(6).toString("hex");
  const server = await startPage({ hardened: true, token: secret });
  try {
    const p = makeProject({
      files: { "package.json": JSON.stringify({ name: "web-fixture", private: true }) + "\n" },
      tools: toolsYml("zap", "zap", "dast", `    target: http://localhost:${server.port}\n    auth:\n      header: Authorization\n      valueEnv: ZAP_TOKEN_VALUE\n`),
      extraEnv: { ZAP_TOKEN_VALUE: `Bearer ${secret}` },
    });
    const { doc } = p.run("zap");
    const stage = doc.stages.find((s) => s.id.startsWith("zap#"));
    assert.equal(stage?.state, "completed", `${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
    assert.equal(doc.decision, "passed", summary(doc));
    const everything = JSON.stringify(doc) + logsOf(doc) + fs.readdirSync(path.join(doc.runDir, "outputs", "zap", "zap")).map((n) => (fs.statSync(path.join(doc.runDir, "outputs", "zap", "zap", n)).isFile() ? fs.readFileSync(path.join(doc.runDir, "outputs", "zap", "zap", n), "utf8") : "")).join("\n");
    assert.ok(!everything.includes(secret), "the secret is nowhere in the run folder files that were read");
  } finally {
    await server.close();
  }
});
