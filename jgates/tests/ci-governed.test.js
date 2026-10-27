import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// jgates ci: the governed CI path. Only the CI policy (pinned by JGATES_POLICY_SHA256) decides what runs; the checkout
// is analyzed in a clean copy of its commit; whatever the job could use to loosen the gate is refused with exit 3.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const mainFixture = require("../../tests/fixtures/jgates/main-fixture.js");
const { readPolicyBundle } = await import(pathToFileURL(path.join(dist, "core", "policy", "index.js")).href);
const { executeRun } = await import(pathToFileURL(path.join(dist, "core", "run", "index.js")).href);
const { findOnPath } = await import(pathToFileURL(path.join(dist, "core", "bridge", "index.js")).href);

const PYTHON = findOnPath("python") ?? findOnPath("python3");
const GIT = findOnPath("git");
const NO_DOCKER = { DOCKER_CONTEXT: "", DOCKER_HOST: "tcp://127.0.0.1:1", GITHUB_BASE_REF: "", GITHUB_HEAD_REF: "", GITHUB_SHA: "", GITLAB_CI: "" };
const validateResult = new Ajv2020({ strict: true, allErrors: true }).compile(
  JSON.parse(fs.readFileSync(path.resolve(here, "..", "schemas", "result", "result.schema.json"), "utf8")),
);
// The parts of SARIF 2.1.0 the export promises (the full schema is not shipped offline).
const validateSarif = new Ajv2020({ strict: false, allErrors: true }).compile({
  type: "object",
  required: ["version", "runs"],
  properties: {
    version: { const: "2.1.0" },
    runs: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["tool", "results"],
        properties: {
          tool: { type: "object", required: ["driver"], properties: { driver: { type: "object", required: ["name"] } } },
          results: {
            type: "array",
            items: {
              type: "object",
              required: ["message"],
              properties: {
                level: { enum: ["none", "note", "warning", "error"] },
                message: { type: "object", required: ["text"] },
                locations: { type: "array", items: { type: "object", properties: { physicalLocation: { type: "object", required: ["artifactLocation"] } } } },
              },
            },
          },
        },
      },
    },
  },
});

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const CAPABILITIES = ["file-size", "lint", "secrets", "sast", "dependencies", "duplication", "iac", "unit", "coverage", "pii"];

function write(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, ...name.split("/"))), { recursive: true });
    fs.writeFileSync(path.join(dir, ...name.split("/")), content);
  }
}

/** A profiles document whose profile `id` turns on only the capabilities in `on`. */
function profilesYaml(id, on) {
  const checks = CAPABILITIES.map((c) => `      capability:${c}:\n        enabled: ${on.includes(c)}\n`).join("");
  return `schemaVersion: 1\nprofiles:\n  ${id}:\n    label: ${id}\n    extends: builtin:minimal\n    checks:\n${checks}`;
}

/** A CI policy: profile "gate" with the capabilities in `on`, and the bridge quality policy given. */
function policyFiles({ on = ["file-size"], quality = { schemaVersion: 1, budgets: { maxFileLines: 5 } } } = {}) {
  return {
    "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/profiles.yml\nselection:\n  profile: gate\n",
    ".jgates/profiles.yml": profilesYaml("gate", on),
    ...(quality ? { ".jgates/quality-policy.json": `${JSON.stringify(quality, null, 2)}\n` } : {}),
    "README.md": "# CI policy (not part of the bundle)\n",
  };
}

const git = (dir, ...args) => {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

function setup(policy = policyFiles()) {
  assert.ok(PYTHON, "python not found on PATH: put the repository .venv/bin first on PATH");
  assert.ok(GIT, "git not found on PATH");
  const { dir } = mainFixture.createMainFixture();
  const home = tmp("jgates-ci-home-");
  const policyDir = tmp("jgates-ci-policy-");
  const emptyBin = tmp("jgates-ci-bin-");
  const out = tmp("jgates-ci-out-");
  write(policyDir, policy);
  // Only what the test passes: no ambient policy variables, no tools on PATH (git and python are named explicitly).
  const base = { ...process.env, ...NO_DOCKER, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_GIT: GIT, PATH: emptyBin };
  delete base.JGATES_POLICY_DIR;
  delete base.JGATES_POLICY_SHA256;
  delete base.JGATES_NO_CACHE;
  const sha = () => readPolicyBundle(policyDir).bundle.sha256;
  const cliWith = (extraEnv, ...args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...base, ...extraEnv }, timeout: 600_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  /** jgates ci with the right hash of the policy folder. */
  const ci = (...args) => cliWith({ JGATES_POLICY_SHA256: sha() }, "ci", "--cwd", dir, "--policy", policyDir, "--json", ...args);
  const runs = () => {
    const ws = path.join(home, "workspaces");
    if (!fs.existsSync(ws)) return [];
    return fs.readdirSync(ws).flatMap((id) => (fs.existsSync(path.join(ws, id, "runs")) ? fs.readdirSync(path.join(ws, id, "runs")) : []));
  };
  const cleanup = () => {
    mainFixture.removeFixture(dir);
    for (const d of [home, policyDir, emptyBin, out]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { dir, home, policyDir, out, sha, cliWith, ci, runs, cleanup };
}

const one = (r) => {
  try {
    return JSON.parse(r.out);
  } catch (error) {
    throw new Error(`stdout is not one JSON document (${error.message}):\n${r.out}\n${r.err}`);
  }
};

const readRun = (result, name) => fs.readFileSync(path.join(result.runDir, name), "utf8");

test("ci: without JGATES_POLICY_SHA256, with a wrong hash, without the folder or with the policy inside the checkout it exits 3 with the code and runs nothing", () => {
  const p = setup();
  try {
    const expectError = (r, code) => {
      assert.equal(r.code, 3, r.out + r.err);
      const doc = one(r);
      assert.equal(doc.code, code, r.out);
      assert.equal(doc.exitCode, 3);
      assert.equal(doc.executed, false);
      assert.ok(doc.message.length > 0 && doc.fix.length > 0, r.out);
      return doc;
    };
    const ciArgs = ["ci", "--cwd", p.dir, "--json"];

    expectError(p.cliWith({}, ...ciArgs, "--policy", p.policyDir), "POLICY_SHA256_REQUIRED");
    expectError(p.cliWith({ JGATES_POLICY_SHA256: "  " }, ...ciArgs, "--policy", p.policyDir), "POLICY_SHA256_REQUIRED");
    expectError(p.cliWith({ JGATES_POLICY_SHA256: "not-a-hash" }, ...ciArgs, "--policy", p.policyDir), "POLICY_SHA256_INVALID");
    const wrong = expectError(p.cliWith({ JGATES_POLICY_SHA256: "0".repeat(64) }, ...ciArgs, "--policy", p.policyDir), "POLICY_HASH_MISMATCH");
    assert.equal(wrong.expected, "0".repeat(64));
    assert.equal(wrong.actual, p.sha());
    // The hash is checked before the bundle is used: one changed byte is a mismatch.
    const before = p.sha();
    fs.appendFileSync(path.join(p.policyDir, ".jgates", "profiles.yml"), "\n");
    expectError(p.cliWith({ JGATES_POLICY_SHA256: before }, ...ciArgs, "--policy", p.policyDir), "POLICY_HASH_MISMATCH");

    expectError(p.cliWith({ JGATES_POLICY_SHA256: p.sha() }, ...ciArgs), "POLICY_DIR_REQUIRED");
    const missing = path.join(p.policyDir, "nope");
    expectError(p.cliWith({ JGATES_POLICY_SHA256: p.sha() }, ...ciArgs, "--policy", missing), "POLICY_DIR_MISSING");
    expectError(p.cliWith({ JGATES_POLICY_SHA256: p.sha(), JGATES_POLICY_DIR: missing }, ...ciArgs), "POLICY_DIR_MISSING");

    // The same policy committed inside the checkout: refused even with its exact hash.
    const inside = path.join(p.dir, "ci-policy");
    write(inside, policyFiles());
    git(p.dir, "add", "-A");
    git(p.dir, "commit", "-qm", "policy inside the project");
    const insideSha = readPolicyBundle(inside).bundle.sha256;
    expectError(p.cliWith({ JGATES_POLICY_SHA256: insideSha }, ...ciArgs, "--policy", inside), "POLICY_INSIDE_PROJECT");
    expectError(p.cliWith({ JGATES_POLICY_SHA256: insideSha, JGATES_POLICY_DIR: inside }, ...ciArgs), "POLICY_INSIDE_PROJECT");

    // A broken quality policy and a profile the policy does not define are configuration failures too.
    fs.writeFileSync(path.join(p.policyDir, ".jgates", "quality-policy.json"), '{"schemaVersion":1,"budgets":{"maxFileLines":-1}}\n');
    expectError(p.cliWith({ JGATES_POLICY_SHA256: p.sha() }, ...ciArgs, "--policy", p.policyDir), "POLICY_QUALITY_INVALID");
    write(p.policyDir, policyFiles());
    expectError(p.cliWith({ JGATES_POLICY_SHA256: p.sha() }, ...ciArgs, "--policy", p.policyDir, "--profile", "strict"), "POLICY_PROFILE_REFUSED");

    // Text mode: the code on stderr, nothing on stdout.
    const text = p.cliWith({ JGATES_POLICY_SHA256: "0".repeat(64) }, "ci", "--cwd", p.dir, "--policy", p.policyDir);
    assert.equal(text.code, 3);
    assert.equal(text.out, "");
    assert.match(text.err, /^ERROR POLICY_HASH_MISMATCH\n/);

    assert.deepEqual(p.runs(), [], "no run folder was created");
  } finally {
    p.cleanup();
  }
});

test("ci: --skip, --only, --waiver, --no-cache, --bridge-mode quick|offline and the reduced selections are refused with 3 before anything runs", () => {
  const p = setup();
  try {
    const cases = [
      [["--skip", "capability:file-size"], "CI_OPTION_REFUSED"],
      [["--only", "capability:file-size"], "CI_OPTION_REFUSED"],
      [["--waiver", "rule=budget.file-lines;reason=self approved"], "CI_OPTION_REFUSED"],
      [["--no-cache"], "CI_OPTION_REFUSED"],
      [["--plan", path.join(p.out, "plan.json")], "CI_OPTION_REFUSED"],
      [["--template", "python"], "CI_OPTION_REFUSED"],
      [["--path", "api"], "CI_OPTION_REFUSED"],
      [["--scope", "paths"], "CI_SCOPE_REFUSED"],
      [["--bridge-mode", "quick"], "CI_BRIDGE_MODE_REFUSED"],
      [["--bridge-mode", "offline"], "CI_BRIDGE_MODE_REFUSED"],
      [["--semantic"], "UNKNOWN_FLAG"],
    ];
    for (const [args, code] of cases) {
      const r = p.ci(...args);
      assert.equal(r.code, 3, `${args.join(" ")}: ${r.out}${r.err}`);
      assert.equal(one(r).code, code, args.join(" "));
    }
    assert.deepEqual(p.runs(), [], "no run folder was created");
  } finally {
    p.cleanup();
  }
});

test("ci: a project whose own jgates.yml, profile, waivers and quality policy switch the checks off is analyzed with the policy's rules, and the decision is the policy's (main fixture)", () => {
  const p = setup(policyFiles({ on: ["file-size", "secrets"] }));
  try {
    // The project turns everything but file-size off, disables the budgets and waives what is left.
    write(p.dir, {
      "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/profiles.yml\nselection:\n  profile: relaxed\n",
      ".jgates/profiles.yml": profilesYaml("relaxed", ["file-size"]),
      ".jgates/waivers.json": `${JSON.stringify({ waivers: [{ rule: "budget.file-lines", reason: "self approved" }] })}\n`,
      ".quality-gate-policy.json": `${JSON.stringify({ schemaVersion: 1, budgets: { enabled: false } })}\n`,
    });
    git(p.dir, "add", "-A");
    git(p.dir, "commit", "-qm", "project configuration that switches the gate off");

    // With its own configuration the project passes.
    const own = p.cliWith({}, "run", "--cwd", p.dir, "--json", "--no-interactive");
    assert.equal(own.code, 0, own.out + own.err);
    assert.equal(one(own).selection.profile, "relaxed");

    const r = p.ci("--sarif", path.join(p.out, "jgates.sarif"), "--out", path.join(p.dir, ".jgates-ci"));
    const result = one(r);
    // Blocking file-size violations (the policy's budget, not waived) and the secrets check the project turned off.
    assert.equal(r.code, 1, r.out + r.err);
    assert.equal(result.decision, "failed");
    assert.equal(result.exitCode, 1);
    assert.equal(result.reduced, false);
    assert.equal(result.selection.profile, "gate");
    assert.equal(result.selection.options.governed, true);
    const budget = result.findings.filter((f) => f.ruleId === "budget.file-lines");
    assert.ok(budget.length > 0, JSON.stringify(result.findings));
    assert.ok(budget.every((f) => f.blocking && !f.waived), JSON.stringify(budget));
    assert.ok(result.stages.some((s) => s.id === "quality-bridge.gitleaks" && s.state !== "disabled"), JSON.stringify(result.stages));
    assert.ok(result.requirements.some((q) => q.id === "quality-bridge.gitleaks" && q.required));

    // The plan names only the policy's files, and the bridge runs in full mode with the policy's quality policy.
    const plan = JSON.parse(readRun(result, "plan.json"));
    const configFiles = plan.inputs.configFiles.map((f) => f.file).filter((f) => !f.startsWith("builtin:")).sort();
    assert.deepEqual(configFiles, [".jgates/profiles.yml", "jgates.yml"]);
    const stdin = plan.invocations.find((i) => i.adapter === "quality-bridge").command.stdin;
    assert.equal(stdin.mode, "full");
    assert.equal(stdin.policyFile, "{runDir}/quality-policy.json");
    assert.equal(stdin.requirePolicy, true);
    assert.equal(stdin.toolConfigs, undefined);
    assert.equal(readRun(result, "quality-policy.json"), fs.readFileSync(path.join(p.policyDir, ".jgates", "quality-policy.json"), "utf8"));
    assert.equal(stdin.policySha256, result.policy.qualityPolicy.sha256);

    // result.json records the policy: bundle hash, files and source, and it follows the result schema.
    const bundle = readPolicyBundle(p.policyDir).bundle;
    assert.equal(result.policy.sha256, bundle.sha256);
    assert.deepEqual(result.policy.files, bundle.files);
    assert.deepEqual(result.policy.files.map((f) => f.path), [".jgates/profiles.yml", ".jgates/quality-policy.json", "jgates.yml"]);
    assert.deepEqual(result.policy.source, { dir: bundle.dir, from: "option" });
    assert.equal(result.policy.qualityPolicy.file, ".jgates/quality-policy.json");
    const onDisk = JSON.parse(readRun(result, "result.json"));
    assert.deepEqual(onDisk.policy, result.policy);
    assert.ok(validateResult(onDisk), JSON.stringify(validateResult.errors));

    // --sarif writes a SARIF 2.1.0 document with the findings; --out gets a copy of the run artifacts.
    const sarif = JSON.parse(fs.readFileSync(path.join(p.out, "jgates.sarif"), "utf8"));
    assert.ok(validateSarif(sarif), JSON.stringify(validateSarif.errors));
    assert.equal(sarif.version, "2.1.0");
    assert.equal(sarif.runs[0].results.length, result.findings.length);
    assert.ok(sarif.runs[0].results.some((x) => x.ruleId.endsWith("/budget.file-lines")));
    const copied = path.join(p.dir, ".jgates-ci");
    for (const name of ["result.json", "plan.json", "events.jsonl", "quality-policy.json"]) assert.ok(fs.existsSync(path.join(copied, name)), name);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(copied, "result.json"), "utf8")), onDisk);
  } finally {
    p.cleanup();
  }
});

test("ci: the analysis reads the commit, never the work tree: a dirty file does not enter", () => {
  const p = setup(policyFiles({ quality: { schemaVersion: 1, budgets: { maxFileLines: 40 } } }));
  try {
    const head = git(p.dir, "rev-parse", "HEAD");
    const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n";
    // An untracked file and a tracked one changed in the work tree, both over the budget.
    write(p.dir, { "dirty.txt": big });
    fs.appendFileSync(path.join(p.dir, "README.md"), big);

    const r = p.ci("--no-interactive");
    const result = one(r);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(result.decision, "passed");
    assert.equal(result.analyzed.target, "commit");
    assert.equal(result.analyzed.snapshot.commit, head);
    assert.equal(result.analyzed.dirty, false);
    assert.equal(result.analyzed.approval.code, "COMMIT_APPROVED");
    assert.deepEqual(result.findings, []);
    // The work tree was left as it was.
    assert.ok(fs.existsSync(path.join(p.dir, "dirty.txt")));

    // Committed, the same file is analyzed and the policy's budget rejects it.
    git(p.dir, "add", "-A");
    git(p.dir, "commit", "-qm", "commit the big files");
    const again = p.ci();
    const second = one(again);
    assert.equal(again.code, 1, again.out + again.err);
    const paths = second.findings.filter((f) => f.ruleId === "budget.file-lines").map((f) => f.location?.path).sort();
    assert.deepEqual(paths, ["README.md", "dirty.txt"]);

    // JGATES_POLICY_DIR names the folder when --policy is absent; the result says so.
    const viaEnv = p.cliWith({ JGATES_POLICY_SHA256: p.sha(), JGATES_POLICY_DIR: p.policyDir }, "ci", "--cwd", p.dir, "--head", head, "--json");
    assert.equal(viaEnv.code, 0, viaEnv.out + viaEnv.err);
    assert.equal(one(viaEnv).policy.source.from, "env");
    assert.equal(one(viaEnv).analyzed.snapshot.commit, head);
  } finally {
    p.cleanup();
  }
});

test("ci: an incomplete run never exits 0 (a required tool of the policy is missing)", () => {
  const p = setup(policyFiles({ on: ["file-size", "secrets"], quality: null }));
  try {
    const r = p.ci();
    const result = one(r);
    assert.equal(r.code, 2, r.out + r.err);
    assert.equal(result.decision, "incomplete");
    assert.equal(result.complete, false);
    assert.ok(result.unsatisfied.some((u) => u.requirementId === "quality-bridge.gitleaks"), JSON.stringify(result.unsatisfied));
    // Without a quality policy in the bundle the bridge gets the built-in default, never the project's file.
    assert.equal(result.policy.qualityPolicy.file, null);
    assert.equal(readRun(result, "quality-policy.json"), '{\n  "schemaVersion": 1\n}\n');
  } finally {
    p.cleanup();
  }
});

test("ci engine: with neverPassReduced a reduced run that would pass ends incomplete with exit 2", async () => {
  const home = tmp("jgates-ci-engine-home-");
  const workspace = tmp("jgates-ci-engine-ws-");
  try {
    const output = {
      stages: [{ id: "kept", state: "completed" }],
      requirements: [{ id: "kept", required: true }, { id: "dropped", required: true }],
      disabled: [{ id: "dropped", origin: "run", reason: "turned off for this run" }],
      findings: [],
      logs: [],
      outputs: [],
    };
    const env = { ...process.env, JGATES_GIT: "/nonexistent-git" };
    const base = { workspacePath: workspace, home, version: "0.0.0-test", adapter: "fake", options: {}, env, execute: async () => structuredClone(output) };
    const loose = await executeRun(base);
    assert.equal(loose.reduced, true);
    assert.equal(loose.decision, "passed");
    assert.equal(loose.exitCode, 0);

    const governed = await executeRun({ ...base, neverPassReduced: true });
    assert.equal(governed.reduced, true);
    assert.equal(governed.decision, "incomplete");
    assert.equal(governed.exitCode, 2);
    assert.equal(governed.complete, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(governed.runDir, "result.json"), "utf8")).exitCode, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
