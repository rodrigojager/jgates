import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The CI examples (examples/ci) are valid YAML, cite only real jgates commands and flags, lay the policy out beside the
// project (never inside it), and are exactly what the policy screen generates. They name no company, no real digest and
// no registry of whoever publishes the product.

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const EXAMPLES = path.join(ROOT, "examples", "ci");
const require = createRequire(import.meta.url);
const YAML = require("yaml");
const { githubSnippet, gitlabSnippet } = await import(pathToFileURL(path.join(dist, "server", "routes", "policy.js")).href);
const { checkPolicyLocation } = await import(pathToFileURL(path.join(dist, "core", "policy", "index.js")).href);

const PLACEHOLDER_HASH = "<policy-sha256>";
const PLACEHOLDER_DIGEST = "sha256:<digest>";
const PLACEHOLDER_IMAGE = `<registry>/jgates-tools@${PLACEHOLDER_DIGEST}`;
const read = (name) => fs.readFileSync(path.join(EXAMPLES, name), "utf8");
const GLOBAL_FLAGS = new Set(["json", "help", "version", "locale"]);

const help = JSON.parse(spawnSync(process.execPath, [MAIN, "help", "--json"], { encoding: "utf8", env: { ...process.env, JGATES_HOME: os.tmpdir() } }).stdout);
const OPTIONS = new Map(help.commands.map((c) => [c.name, new Set(c.options.map((o) => o.name.replace(/^--/, "")))]));

/** The shell lines of each example, as written in the YAML (github: run steps; gitlab: script). */
function shellLines(name) {
  const doc = YAML.parse(read(name));
  const lines = [];
  if (name.startsWith("github")) {
    for (const job of Object.values(doc.jobs)) for (const step of job.steps) if (step.run) lines.push(...String(step.run).split("\n"));
  } else {
    for (const job of Object.values(doc)) if (job && typeof job === "object" && job.script) lines.push(...job.script.flatMap((s) => String(s).split("\n")));
  }
  return lines.map((l) => l.trim()).filter(Boolean);
}

const files = fs.readdirSync(EXAMPLES).filter((f) => f.endsWith(".yml"));

test("examples/ci holds the GitHub Actions and GitLab CI examples", () => {
  assert.deepEqual(files.sort(), ["github-actions.yml", "gitlab-ci.yml"]);
});

for (const file of files) {
  test(`${file}: valid YAML`, () => {
    const doc = YAML.parseDocument(read(file));
    assert.deepEqual(doc.errors, []);
    assert.equal(typeof doc.toJS(), "object");
  });

  test(`${file}: every jgates command and flag exists in help --json`, () => {
    const commands = shellLines(file).filter((l) => /^jgates\s/.test(l));
    assert.ok(commands.length > 0, "the example runs no jgates command");
    for (const line of commands) {
      const words = line.split(/\s+/).slice(1);
      assert.ok(OPTIONS.has(words[0]), `unknown command in "${line}"`);
      for (const word of words.filter((w) => w.startsWith("--"))) {
        const flag = word.slice(2).split("=")[0];
        assert.ok(GLOBAL_FLAGS.has(flag) || OPTIONS.get(words[0]).has(flag), `"${line}" uses --${flag}, which jgates ${words[0]} does not have`);
      }
    }
  });

  test(`${file}: neutral (no company, real digest, registry of the publisher or retired command)`, () => {
    const text = read(file);
    assert.ok(!/quality-ci|quality-gate|semantic-gate/i.test(text), "cites a retired or other command");
    assert.ok(!/ghcr\.io/i.test(text), "cites a container registry");
    // The only digest is the placeholder; the image is named by a placeholder registry.
    const withoutPlaceholder = text.split(PLACEHOLDER_IMAGE).join("").split(PLACEHOLDER_DIGEST).join("");
    assert.ok(!/sha256:[0-9a-f]{16,}|@sha256|\b[0-9a-f]{64}\b/i.test(withoutPlaceholder), "contains a real digest");
    assert.ok(text.includes(PLACEHOLDER_IMAGE), "does not name the tools image with the placeholder registry and digest");
    assert.ok(!/company|corporat|empresa/i.test(text), "mentions a company");
    assert.ok(!/@|\.com\b(?!\/rodrigojager\/jgates)/.test(withoutPlaceholder.replace(/\$\{\{[^}]*\}\}/g, "").replace(/github\.com\/rodrigojager\/jgates/g, "").replace(/\w+@v\d+/g, "").replace(/gitlab-ci-token:[^@]*@/g, "")), "contains an address");
  });
}

test("the examples are what the policy screen generates", () => {
  assert.equal(read("github-actions.yml"), githubSnippet(PLACEHOLDER_HASH));
  assert.equal(read("gitlab-ci.yml"), gitlabSnippet(PLACEHOLDER_HASH));
});

test("GitHub Actions: the policy is a separate checkout beside the project, outside it", () => {
  const doc = YAML.parse(githubSnippet(PLACEHOLDER_HASH));
  const job = Object.values(doc.jobs)[0];
  const checkouts = job.steps.filter((s) => String(s.uses).startsWith("actions/checkout"));
  assert.equal(checkouts.length, 2);
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ci-gh-")));
  try {
    const run = job.steps.find((s) => /jgates ci/.test(s.run ?? ""));
    // Lay the workspace out exactly as the checkouts do.
    for (const c of checkouts) fs.mkdirSync(path.join(workspace, c.with.path ?? "."), { recursive: true });
    const project = path.join(workspace, run["working-directory"]);
    const policy = path.normalize(job.env.JGATES_POLICY_DIR.replace("${{ github.workspace }}", workspace));
    assert.ok(checkouts.some((c) => path.join(workspace, c.with.path) === project), "the job does not run in a project checkout");
    assert.ok(checkouts.some((c) => path.join(workspace, c.with.path) === policy), "JGATES_POLICY_DIR is not the policy checkout");
    assert.notEqual(project, workspace, "the project is the workspace root, which would contain the policy");
    assert.equal(checkPolicyLocation(policy, project), null);
    // The layout the snippet used to suggest (policy under the project root) is what the check refuses.
    fs.mkdirSync(path.join(workspace, "project", "policy"));
    assert.equal(checkPolicyLocation(path.join(workspace, "project", "policy"), project)?.code, "POLICY_INSIDE_PROJECT");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("GitLab CI: the policy is cloned outside $CI_PROJECT_DIR", () => {
  const doc = YAML.parse(gitlabSnippet(PLACEHOLDER_HASH));
  const declared = doc.jgates.variables.JGATES_POLICY_DIR;
  const builds = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ci-gl-")));
  try {
    const projectDir = path.join(builds, "group", "project");
    fs.mkdirSync(projectDir, { recursive: true });
    const policy = path.normalize(declared.replace("$CI_BUILDS_DIR", builds).replace("$CI_JOB_ID", "42"));
    assert.ok(policy.startsWith(builds + path.sep), "the policy is not under the builds directory");
    fs.mkdirSync(policy);
    assert.equal(checkPolicyLocation(policy, projectDir), null);
    assert.ok(!declared.includes("$CI_PROJECT_DIR"));
    assert.ok(doc.jgates.script.some((l) => /git clone/.test(l) && l.includes('"$JGATES_POLICY_DIR"')), "the policy is not cloned into JGATES_POLICY_DIR");
  } finally {
    fs.rmSync(builds, { recursive: true, force: true });
  }
});

test("the job runs in the pinned tools image and installs nothing", () => {
  const github = YAML.parse(read("github-actions.yml"));
  const job = Object.values(github.jobs)[0];
  assert.equal(job.container, PLACEHOLDER_IMAGE, "the GitHub job does not use the tools image as its container");
  assert.equal(job.env.JGATES_TOOLS_IMAGE_DIGEST, PLACEHOLDER_DIGEST);
  const gitlab = YAML.parse(read("gitlab-ci.yml")).jgates;
  assert.equal(gitlab.image, PLACEHOLDER_IMAGE, "the GitLab job does not use the tools image");
  assert.equal(gitlab.variables.JGATES_TOOLS_IMAGE_DIGEST, PLACEHOLDER_DIGEST);
  for (const name of files) {
    const lines = shellLines(name);
    assert.ok(lines.some((l) => /^jgates ci\s/.test(l)), `${name} does not call jgates ci`);
    for (const line of lines) {
      assert.ok(!/^(npm|npx|pnpm|yarn|pip|pip3|uv)\s/.test(line), `${name} installs something: "${line}"`);
      assert.ok(!/(^|\s)(sudo|apt|apt-get|apk)\s/.test(line), `${name} installs a package: "${line}"`);
    }
  }
  assert.ok(!job.steps.some((s) => String(s.uses).startsWith("actions/setup-")), "the GitHub job sets up a toolchain the image already has");
  const text = githubSnippet(PLACEHOLDER_HASH) + gitlabSnippet(PLACEHOLDER_HASH);
  assert.ok(!/git\+https|node:22|npm install/.test(text), "an example still installs JGates");
});
