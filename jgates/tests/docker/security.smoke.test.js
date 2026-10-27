import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LABEL, TOOL_LABEL, buildImage, builderCacheEmpty, cleanupWork, docker, dockerAvailable, labeledContainers, labeledImages } from "./dev-docker.mjs";

// Smoke with the real Docker (npm run test:docker; never part of npm test): the four security scanners that left the
// bridge (Gitleaks dir and git history, Trivy, OSV-Scanner, Checkov) run as adapters of their own through the CLI, in
// the image of jgates/docker/security (built by the jgates-dev builder), on a Git workspace with a synthetic secret
// generated here, a lockfile with a vulnerable lodash and a Terraform file with a public bucket. The Gitleaks finding
// comes out with the value masked, and the raw value is nowhere in the result, the logs or the outputs. Afterwards
// only the last image stays: no container, volume or build cache.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const repo = path.resolve(root, "..");
const MAIN = path.join(root, "dist", "cli", "main.js");
const CONTEXT = path.join(root, "docker", "security");
const TAG = "jgates-dev/security-scanners:dev";
const TOOL = "security-scanners";
const PYTHON = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
// The image is rebuilt only when its Dockerfile changes: the hash goes into a label of the image.
const DOCKERFILE_LABEL = "org.jgates.dockerfile.sha256";
const dockerfileHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(CONTEXT, "Dockerfile"))).digest("hex");

// A GitHub token shape (ghp_ + 36 alphanumerics), random on every run and never written anywhere but the workspace.
const ALPHANUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SECRET = ["gh", "p_"].join("") + Array.from(crypto.randomBytes(36), (b) => ALPHANUM[b % ALPHANUM.length]).join("");

const TOOLS_YML = `schemaVersion: 1
tools:
  gitleaks:
    adapter: gitleaks
    capabilities: [secrets]
  gitleaks-history:
    adapter: gitleaks
    capabilities: [secrets-history]
  trivy:
    adapter: trivy
    capabilities: [dependencies, iac]
  osv-scanner:
    adapter: osv-scanner
    capabilities: [dependencies]
  checkov:
    adapter: checkov
    capabilities: [iac]
`;

const LOCKFILE = {
  name: "demo",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "demo", version: "1.0.0", dependencies: { lodash: "4.17.15" } },
    "node_modules/lodash": {
      version: "4.17.15",
      resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz",
      integrity: "sha512-8xOcRHvCjnocdS5cpwXQXVzmmh5e5+saE2QGoeQmbKmRS6J3VQppPOIt0MnmE+4xlZoumy0GPG0D0MVIQbNA1A==",
    },
  },
};

let imageId = "";
let dir = "";
let home = "";

function git(args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "jgates", GIT_AUTHOR_EMAIL: "jgates@example.invalid", GIT_COMMITTER_NAME: "jgates", GIT_COMMITTER_EMAIL: "jgates@example.invalid" } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

/** The labeled image of the current Dockerfile: the existing one when its label matches, otherwise a new build. */
function securityImage() {
  const current = docker(["image", "inspect", "--format", `{{index .Config.Labels "${DOCKERFILE_LABEL}"}} {{.Id}}`, TAG]);
  const [hash, id] = current.out.trim().split(" ");
  if (current.code === 0 && hash === dockerfileHash && id) return id;
  return buildImage({ context: CONTEXT, tag: TAG, buildArgs: ["--label", `${DOCKERFILE_LABEL}=${dockerfileHash}`] });
}

/** Every file under a folder, for the search of the raw secret. */
function filesUnder(top) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  if (fs.existsSync(top)) walk(top);
  return out;
}

const scannerContainers = () => docker(["ps", "-a", "--filter", "label=org.jgates.adapter", "--format", "{{.ID}} {{.Label \"org.jgates.adapter\"}}"]).out.trim();

before(() => {
  assert.ok(dockerAvailable(), "Docker is required for npm run test:docker (the daemon did not answer)");
  // Containers, volumes and stale images of an earlier smoke of this tool; the current image stays when it matches.
  const existing = docker(["image", "inspect", "--format", "{{.Id}}", TAG]);
  cleanupWork({ keep: existing.code === 0 ? existing.out.trim() : null, tool: TOOL });
  imageId = securityImage();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-security-smoke-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-security-home-"));
});

after(() => {
  try {
    for (const d of [dir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
  } finally {
    // Runs on failure too: leaves the last image only, with no container, volume or build cache.
    cleanupWork({ keep: imageId || null, tool: TOOL });
  }
});

test("the four scanners run as adapters in the real container; the Gitleaks finding has the masked value", { timeout: 1_800_000 }, () => {
  // The image of each instance is pinned in .jgates/lock.json by `tools prepare` (no JGATES_*_IMAGE).
  const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_CONTAINER_RUNTIME: "docker", JGATES_NO_CACHE: "1" };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, timeout: 1_700_000, maxBuffer: 64 * 1024 * 1024 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };

  git(["init", "-q", "-b", "main"]);
  const init = cli(["init", "--cwd", dir, "--profile", "standard", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), TOOLS_YML);
  fs.writeFileSync(path.join(dir, "settings.py"), `GITHUB_TOKEN = "${SECRET}"\n`);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { lodash: "4.17.15" } }, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(LOCKFILE, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "main.tf"), 'resource "aws_s3_bucket" "data" {\n  bucket = "demo-data"\n  acl    = "public-read"\n}\n');
  for (const instance of ["gitleaks", "gitleaks-history", "trivy", "osv-scanner", "checkov"]) {
    const prepared = cli(["tools", "prepare", "--cwd", dir, "--instance", instance, "--image", imageId, "--no-interactive", "--json"]);
    assert.equal(prepared.code, 0, prepared.out + prepared.err);
  }
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);

  const only = ["gitleaks", "gitleaks-history", "trivy", "osv-scanner", "checkov"].flatMap((t) => ["--only", `tool:${t}`]);
  const ran = cli(["run", "--cwd", dir, ...only, "--no-interactive", "--json"]);
  const result = ran.doc;
  assert.ok(result, ran.out + ran.err);
  const stage = (id) => result.stages.find((s) => s.id === id);

  // Every stage ran in the container and its report was interpreted.
  for (const id of ["gitleaks#secrets", "gitleaks-history#secrets-history", "trivy#dependencies", "trivy#iac", "osv-scanner#dependencies", "checkov#iac"]) {
    const s = stage(id);
    assert.ok(s, `${id} in ${JSON.stringify(result.stages.map((x) => x.id))}`);
    assert.equal(s.state, "completed", `${id}: ${JSON.stringify(s)}`);
    assert.notEqual(s.interpreted, false, id);
  }
  assert.equal(result.decision, "failed", "the findings block");

  const of = (stageId) => result.findings.filter((f) => f.stageId === stageId);
  // Gitleaks: the synthetic token in the directory and in the history, the value masked.
  for (const id of ["gitleaks#secrets", "gitleaks-history#secrets-history"]) {
    const leak = of(id).find((f) => f.ruleId === "github-pat" && f.location?.path === "settings.py");
    assert.ok(leak, `${id}: ${JSON.stringify(of(id))}`);
    assert.equal(leak.location.line, 1);
    assert.equal(leak.normalizedSeverity, "critical");
    assert.equal(leak.blocking, true);
    assert.ok(leak.evidence === undefined || leak.evidence.includes("REDACTED"), leak.evidence);
  }
  assert.match(of("gitleaks-history#secrets-history").find((f) => f.ruleId === "github-pat").message, /commit [0-9a-f]{12}/);
  // Trivy and OSV-Scanner: the lodash advisories of the lockfile; the database recorded.
  assert.ok(of("trivy#dependencies").some((f) => f.location?.path === "package-lock.json" && /^CVE-/.test(f.ruleId)), JSON.stringify(of("trivy#dependencies")));
  assert.ok(of("trivy#iac").some((f) => f.location?.path === "main.tf"), JSON.stringify(of("trivy#iac")));
  assert.ok(of("osv-scanner#dependencies").some((f) => f.location?.path === "package-lock.json" && /^GHSA-/.test(f.ruleId)), JSON.stringify(of("osv-scanner#dependencies")));
  assert.ok(of("checkov#iac").some((f) => f.location?.path === "main.tf" && /^CKV/.test(f.ruleId)), JSON.stringify(of("checkov#iac")));
  const trivyDb = stage("trivy#dependencies").analysisInput?.database;
  assert.ok(trivyDb && trivyDb.source && trivyDb.reported === true && trivyDb.updatedAt, JSON.stringify(stage("trivy#dependencies")));
  assert.deepEqual(stage("osv-scanner#dependencies").analysisInput?.database, { source: "https://api.osv.dev", updatedAt: null, reported: false, networkRequired: true });
  assert.ok(!filesUnder(path.join(result.runDir, "outputs", "trivy")).some((f) => path.basename(f) === "trivy.db"), "the database file does not stay in the run folder");

  // The raw value is nowhere the run wrote (result, plan, logs, outputs, events), and the workspace is untouched.
  for (const file of filesUnder(result.runDir)) assert.ok(!fs.readFileSync(file).includes(SECRET), `raw secret in ${path.relative(result.runDir, file)}`);
  assert.ok(!ran.out.includes(SECRET) && !ran.err.includes(SECRET), "raw secret on the CLI output");
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout, "", "the scanners left the workspace as it was");

  // The containers of the run are gone (the runner starts them with --rm).
  assert.equal(scannerContainers(), "", "no scanner container left");
});

test("afterwards only the last image stays: no container, volume or build cache of the work", () => {
  cleanupWork({ keep: imageId, tool: TOOL });
  assert.deepEqual(labeledContainers(TOOL), []);
  assert.deepEqual(docker(["volume", "ls", "-q", "--filter", `label=${LABEL}`, "--filter", `label=${TOOL_LABEL}=${TOOL}`]).out.trim(), "");
  const images = labeledImages(TOOL);
  assert.equal(images.length, 1, images.join("\n"));
  assert.ok(imageId.includes(images[0].split(" ")[0]), images[0]);
  assert.ok(builderCacheEmpty(), docker(["buildx", "du", "--builder", "jgates-dev"]).out);
});
