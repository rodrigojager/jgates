import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPolicyBundle } from "../../../jgates/dist/core/policy/index.js";
import { workspaceId } from "../../../jgates/dist/core/ids/index.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const main = path.join(root, "jgates", "dist", "cli", "main.js");
export const image = "jgates-tools:dev";
const tools = ["markdownlint", "pylint", "yamllint"];

export function assertGovernedLinters(t, docker) {
  const scratch = fs.mkdtempSync(path.join(process.env.JGATES_E2E_TMP || os.tmpdir(), "v2-106-"));
  const project = path.join(scratch, "project");
  const policy = path.join(scratch, "policy");
  fs.mkdirSync(project);
  const workspace = workspaceId(project);
  t.after(() => {
    try {
      if (!docker) return;
      const filter = ["--filter", `label=org.jgates.workspace=${workspace}`];
      const volumes = docker(["volume", "ls", "-q", ...filter]);
      assert.equal(volumes.code, 0, volumes.err);
      for (const name of volumes.out.trim().split(/\s+/).filter(Boolean)) {
        const removed = docker(["volume", "rm", name]);
        assert.equal(removed.code, 0, removed.err);
      }
      assert.equal(docker(["ps", "-aq", ...filter]).out.trim(), "", "the governed run left no containers");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=JGates", "-c", "user.email=fixture@example.invalid", ...args], { cwd: project, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  const commit = (markdown) => {
    fs.writeFileSync(path.join(project, "README.md"), markdown);
    git("add", "-A");
    git("commit", "-qm", "Fixture");
  };
  git("init", "-q");
  fs.writeFileSync(path.join(project, ".gitattributes"), "*.yaml text eol=lf\n");
  fs.writeFileSync(path.join(project, "example.py"), '"""Example module."""\n# pylint: disable=invalid-name\nVALUE = 1\n');
  fs.writeFileSync(path.join(project, "example.yaml"), "---\nkey: value\n");
  commit("# Example\n\n### Skipped heading\n");

  fs.mkdirSync(path.join(policy, ".jgates"), { recursive: true });
  fs.writeFileSync(path.join(policy, ".jgates", "quality-policy.json"), JSON.stringify({ schemaVersion: 1, budgets: { maxFileLines: 40 } }));
  const checks = Object.fromEntries([
    ["capability:lint", { enabled: false }],
    ["capability:secrets", { enabled: false }],
    ["capability:links", { enabled: true, when: "available" }],
    ...tools.map((id) => [`tool:${id}`, { enabled: true }]),
    ["tool:lychee", { enabled: true, when: "available" }],
  ]);
  fs.writeFileSync(path.join(policy, ".jgates", "profiles.yml"), JSON.stringify({
    schemaVersion: 1,
    profiles: { gate: { label: "Gate", extends: "builtin:minimal", checks } },
  }));

  const run = (network) => {
    fs.writeFileSync(path.join(policy, "jgates.yml"), JSON.stringify({
      schemaVersion: 1,
      extends: [".jgates/profiles.yml"],
      selection: { profile: "gate" },
      execution: { network },
    }));
    const env = {
      ...process.env, JGATES_HOME: path.join(scratch, "home"), JGATES_IMAGE_JSON: "",
      JGATES_TOOLS_IMAGE: image, JGATES_LOCALE: "en", JGATES_POLICY_SHA256: readPolicyBundle(policy).bundle.sha256,
    };
    if (env.JGATES_CONTAINER_RUNTIME === "jgates-test-no-engine") delete env.JGATES_CONTAINER_RUNTIME;
    if (!docker) {
      const runtime = path.join(scratch, "docker.cjs");
      const fakeEnv = {
        FAKE_DOCKER_STATE: scratch,
        FAKE_DOCKER_LABELS: JSON.stringify({ "org.jgates.version": version }),
        FAKE_DOCKER_OUTPUT_FILES: JSON.stringify({
          "-markdownlint": { [markdownlintFinding.reportPath.slice("/output/".length)]: network === "allow" ? markdownlintClean.report : markdownlintFinding.report },
        }),
      };
      fs.writeFileSync(runtime, `Object.assign(process.env, ${JSON.stringify(fakeEnv)});\n${fakeDocker}`);
      env.JGATES_CONTAINER_RUNTIME = runtime;
    }
    const result = spawnSync(process.execPath, [main, "ci", "--cwd", project, "--policy", policy, "--json"], {
      env, encoding: "utf8", timeout: 240_000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.ok(result.stdout, result.error?.message ?? result.stderr);
    const doc = JSON.parse(result.stdout);
    assert.ok(doc.stages, result.stdout);
    assert.equal(result.status, doc.exitCode);
    return doc;
  };
  const completed = (doc, id) => {
    const stage = doc.stages.find((entry) => entry.adapter === id);
    assert.equal(stage?.state, "completed", JSON.stringify(stage ?? doc.stages));
    assert.equal(stage.selfReported, true, id);
    return stage;
  };

  const bad = run("explicit");
  assert.equal(bad.decision, "failed");
  for (const id of tools) completed(bad, id);
  assert.ok(bad.findings.some((f) => f.tool === "markdownlint" && f.ruleId === "MD001" && f.blocking));
  assert.ok(bad.findings.some((f) => f.ruleId === "suppression.linter-pylint" && f.location?.path === "example.py"));
  const legacy = bad.stages.filter((s) => s.id.includes("megalinter"));
  assert.ok(legacy.every((s) => s.state === "disabled"), JSON.stringify(legacy));
  assert.ok(bad.disabled.some((s) => s.id === "lychee#links" && /needs network access/.test(s.reason)));
  assert.ok(!bad.stages.some((s) => s.adapter === "lychee"));

  fs.writeFileSync(path.join(project, "example.py"), '"""Example module."""\nVALUE = 1\n');
  commit("# Example\n\n## Heading\n");
  const clean = run("allow");
  assert.equal(clean.decision, "incomplete", JSON.stringify({
    findings: clean.findings.map(({ tool, ruleId, blocking }) => ({ tool, ruleId, blocking })),
    stages: clean.stages.map(({ id, state, reason }) => ({ id, state, reason })),
  }));
  for (const id of [...tools, "lychee"]) {
    const stage = completed(clean, id);
    assert.equal(stage.blockingViolations, 0, id);
    assert.ok(clean.unsatisfied.some((entry) => entry.requirementId === (stage.requirementId ?? stage.id)), id);
  }
  if (docker) {
    for (const doc of [bad, clean]) {
      const errors = doc.stages.filter((stage) => stage.state === "error");
      assert.deepEqual(errors, []);
      assert.equal(doc.stages.find((stage) => stage.id === "quality-bridge.file-size")?.state, "completed");
    }
  }
}

const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
function recorded(id, kind) {
  const file = path.join(root, "jgates", "tests", "fixtures", "linters", id, "recorded", `${kind}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8")).calls[0];
}
const markdownlintFinding = recorded("markdownlint", "bad");
const markdownlintClean = recorded("markdownlint", "clean");
const lycheeClean = recorded("lychee", "clean");
const fakeDocker = `
if (process.argv[2] === "run") {
  if (process.argv.includes("/etc/jgates/image.json")) {
    process.env.FAKE_DOCKER_STDOUT = require("node:fs").readFileSync(${JSON.stringify(path.join(root, "jgates", "release", "image-tools.json"))}, "utf8");
  } else if (process.argv.includes("lychee")) {
    process.env.FAKE_DOCKER_STDOUT = ${JSON.stringify(lycheeClean.stdout)};
  }
}
require(${JSON.stringify(path.join(root, "jgates", "tests", "docker", "fake-docker.cjs"))});
`;
