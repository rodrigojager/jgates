import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { docker, dockerAvailable } from "./dev-docker.mjs";

// Advisory data with the real engine (npm run test:docker): `jgates tools update-data` fills the jgates-data volume with
// the databases (real downloads: the RustSec clone always, Trivy and OSV only when missing or older than the limit),
// and OSV-Scanner and Trivy then detect a known-vulnerable lockfile offline (`--network none`, the volume read-only),
// record the fetch time of the database they read, and refuse to run (DATA_STALE) when the data is older than the
// limit. The volume is the product's own (jgates-data, labelled); a stamp the test changes is restored at the end.
// The same scanners on the other stacks (govulncheck, cargo-audit) are in adapters-b.test.js.

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const dist = path.join(packageRoot, "dist");
const MAIN = path.join(dist, "cli", "main.js");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const engine = await load("core", "engine", "index.js");
const data = await load("core", "data", "index.js");
const { workspaceId } = await load("core", "ids", "index.js");
const IMAGE = engine.DEV_TOOLS_IMAGE;

const made = [];
const workspaces = new Set();
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const baseEnv = { ...process.env, JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
delete baseEnv.JGATES_IMAGE_JSON;

before(() => {
  assert.ok(dockerAvailable(), "Docker is required for npm run test:docker (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
});

after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  for (const ws of workspaces) {
    const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${ws}`];
    for (const id of docker(["ps", "-aq", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["rm", "-f", id]);
    for (const name of docker(["volume", "ls", "-q", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["volume", "rm", "-f", name]);
  }
});

const cliIn = (cwd, home) => (args, timeout = 1_800_000) => spawnSync(process.execPath, [MAIN, ...args], { cwd, encoding: "utf8", env: { ...baseEnv, JGATES_HOME: home }, input: "", timeout });

const npmLock = (withLodash) =>
  JSON.stringify(
    {
      name: "demo",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: withLodash
        ? { "": { name: "demo", version: "1.0.0", dependencies: { lodash: "4.17.15" } }, "node_modules/lodash": { version: "4.17.15", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz" } }
        : { "": { name: "demo", version: "1.0.0" } },
    },
    null,
    2,
  ) + "\n";
const TOOLS = "schemaVersion: 1\ntools:\n  osv-scanner:\n    adapter: osv-scanner\n    capabilities: [dependencies]\n  trivy:\n    adapter: trivy\n    capabilities: [dependencies]\n";

function makeProject(withLodash) {
  const project = tmp("jgates-advisory-project-");
  const home = tmp("jgates-advisory-home-");
  fs.writeFileSync(path.join(project, "package-lock.json"), npmLock(withLodash));
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", ...(withLodash ? { dependencies: { lodash: "4.17.15" } } : {}) }) + "\n");
  const cli = cliIn(project, home);
  const git = (...args) => assert.equal(spawnSync("git", ["-c", "user.name=jgates-test", "-c", "user.email=test@example.invalid", ...args], { cwd: project }).status, 0);
  git("init", "-q");
  const init = cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  fs.writeFileSync(path.join(project, ".jgates", "tools.yml"), TOOLS);
  git("add", "-A");
  workspaces.add(workspaceId(project));
  return {
    project,
    cli,
    run: () => {
      const r = cli(["run", "--cwd", project, "--no-interactive", "--json", "--only", "tool:osv-scanner", "--only", "tool:trivy"]);
      let doc = null;
      try {
        doc = JSON.parse(r.stdout);
      } catch {
        doc = null;
      }
      assert.ok(doc?.stages, `no result document\n${r.stdout.slice(0, 2000)}\n${r.stderr.slice(0, 2000)}`);
      return { code: r.status, doc };
    },
  };
}

const logsOf = (doc) => {
  const dir = path.join(doc.runDir, "logs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => `# ${n}\n${fs.readFileSync(path.join(dir, n), "utf8")}`).join("\n=====\n") : "";
};
const statusNow = () => data.readDataStatusSync({ ...baseEnv }, "0.0.0");

/** Rewrites the fetch time of a database in the volume (a labelled helper container); returns the previous one. */
function stamp(database, fetchedAt) {
  const script = "import json,sys\np='/data/jgates-data.json'\nd=json.load(open(p))\nd['databases'][sys.argv[1]]['fetchedAt']=sys.argv[2]\njson.dump(d,open(p,'w'),indent=2)";
  const r = docker(["run", "--rm", "--pull", "never", "--user", "10001:10001", "--label", "org.jgates.managed=true", "--label", "org.jgates.kind=helper", "--mount", "type=volume,src=jgates-data,dst=/data", IMAGE, "python3", "-c", script, database, fetchedAt]);
  assert.equal(r.code, 0, r.err);
}

test("jgates tools update-data fills jgates-data, and OSV-Scanner and Trivy detect a vulnerable lockfile offline with the fetch time recorded", () => {
  const p = makeProject(true);
  // 1. The refresh: the RustSec clone every time (a real fill), Trivy and OSV when the volume does not hold fresh ones.
  const before = statusNow();
  const stale = ["trivy", "osv"].filter((id) => data.agesOf(before.status, new Date(), data.DEFAULT_DATA_MAX_AGE_DAYS).find((a) => a.id === id).state !== "fresh");
  const update = p.cli(["tools", "update-data", "--database", ["rustsec", ...stale].join(","), "--json"]);
  assert.equal(update.status, 0, update.stdout.slice(-2000) + update.stderr.slice(-2000));
  const updateDoc = JSON.parse(update.stdout);
  assert.equal(updateDoc.status, "OK");
  assert.ok(updateDoc.databases.length >= 1 && updateDoc.databases.every((d) => d.ok && /^\d{4}-\d\d-\d\dT/.test(d.fetchedAt)), update.stdout);
  const volumes = docker(["volume", "ls", "-q", "--filter", "label=org.jgates.managed=true", "--filter", "label=org.jgates.kind=data"]).out.split(/\s+/);
  assert.ok(volumes.includes("jgates-data"), "the data volume is labelled");
  const after = statusNow();
  assert.equal(after.state, "ok");
  for (const id of ["trivy", "osv", "rustsec"]) assert.ok(after.status.databases[id]?.fetchedAt, `${id} has a fetch time in the volume`);
  assert.notEqual(after.status.databases.rustsec.fetchedAt, before.status.databases.rustsec?.fetchedAt ?? null, "the refresh stamped a new fetch time");
  // Nothing in the image: the volume is the only place with databases (the image's forbidden-content gate checks the rest).
  const inImage = docker(["run", "--rm", "--pull", "never", "--entrypoint", "sh", IMAGE, "-c", "test ! -e /data/trivy && test ! -e /data/osv && echo clean"]);
  assert.equal(inImage.out.trim(), "clean");

  // 2. The scan: the plan records the fetch times, the steps run with no network and the volume read-only.
  const planned = JSON.parse(p.cli(["plan", "--cwd", p.project, "--json", "--only", "tool:osv-scanner", "--only", "tool:trivy"]).stdout);
  assert.deepEqual(planned.plan.inputs.container.dataTimestamps, { osv: after.status.databases.osv.fetchedAt, trivy: after.status.databases.trivy.fetchedAt });
  const { doc } = p.run();
  const logs = logsOf(doc);
  assert.equal((logs.match(/--network none/g) ?? []).length >= 2, true, "both scanner steps have no network");
  assert.ok(!/--network bridge/.test(logs), "no step has a network");
  assert.ok(logs.includes("type=volume,src=jgates-data,dst=/data,readonly"), "the data volume is mounted read-only");
  for (const tool of ["osv-scanner", "trivy"]) {
    const stage = doc.stages.find((s) => s.id.startsWith(`${tool}#`));
    assert.equal(stage.state, "completed", `${tool}: ${JSON.stringify(stage)}\n${logs.slice(-3000)}`);
    assert.ok(doc.findings.some((f) => f.tool === tool && /^(GHSA|CVE|OSV)/.test(f.ruleId)), `${tool}: a vulnerability of lodash 4.17.15 among ${JSON.stringify(doc.findings.filter((f) => f.tool === tool).map((f) => f.ruleId))}`);
    assert.ok(stage.analysisInput?.database?.updatedAt, `${tool}: the stage records the database fetch time`);
    assert.equal(stage.analysisInput.database.networkRequired, false);
  }
  assert.equal(doc.stages.find((s) => s.id.startsWith("osv-scanner#")).analysisInput.database.updatedAt, after.status.databases.osv.fetchedAt);
  assert.notEqual(doc.decision, "passed", "a known-vulnerable lockfile never passes");
  // Provenance: each database's fetch time travels with the result.
  assert.deepEqual(doc.provenance.container.dataTimestamps, { osv: after.status.databases.osv.fetchedAt, trivy: after.status.databases.trivy.fetchedAt });
});

test("the same scanners pass a lockfile without third-party packages offline, and data older than the limit makes them incomplete (DATA_STALE), never clean", () => {
  const clean = makeProject(false);
  const ok = clean.run();
  for (const tool of ["osv-scanner", "trivy"]) assert.equal(ok.doc.stages.find((s) => s.id.startsWith(`${tool}#`)).state, "completed", JSON.stringify(ok.doc.stages));
  assert.equal(ok.doc.decision, "passed", JSON.stringify(ok.doc.stages.map((s) => [s.id, s.state, s.reason])) + logsOf(ok.doc).slice(-2000));

  // Age the OSV stamp by nine days (restored afterwards): that scanner is blocked, Trivy still runs.
  const before = statusNow().status.databases.osv.fetchedAt;
  try {
    stamp("osv", new Date(Date.now() - 9 * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z"));
    const stale = clean.run();
    assert.equal(stale.code, 2, JSON.stringify(stale.doc.stages));
    assert.equal(stale.doc.decision, "incomplete");
    const osv = stale.doc.stages.find((s) => s.id.startsWith("osv-scanner#"));
    assert.equal(osv.state, "blocked");
    assert.equal(osv.execution.notRun.problems[0].code, "DATA_STALE");
    assert.equal(stale.doc.stages.find((s) => s.id.startsWith("trivy#")).state, "completed");
  } finally {
    stamp("osv", before);
  }
  assert.equal(statusNow().status.databases.osv.fetchedAt, before, "the stamp was restored");
});
