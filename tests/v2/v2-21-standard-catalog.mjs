import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-21: a fresh standard installation exposes every new Quality integration with its distribution state, without any
// custom adapter. The repository is packed with npm (the artifact a user installs), the tarball is installed into an
// empty temp folder, and the installed `jgates` is asked for its catalog (`tools list --json`), its shipped packs
// (`tools distribution`) and the plan of a project that has the evidence (a workflow, a lockfile, an OpenAPI file).
// Nothing is built or read from the source tree: only what the tarball carries counts. `npm install` may need the
// registry (or the npm cache) for the four runtime dependencies.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

/** Runs npm without a shell when npm-cli.js is next to node (always on a normal install); otherwise through the shell. */
function npm(args, options = {}) {
  const nodeDir = path.dirname(process.execPath);
  const cli = [path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find((p) => fs.existsSync(p));
  const run = cli ? spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 600_000, ...options }) : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { encoding: "utf8", timeout: 600_000, shell: process.platform === "win32", ...options });
  assert.equal(run.status, 0, `npm ${args.join(" ")}\n${run.stdout}\n${run.stderr}`);
  return run;
}

const EXPECTED = {
  zizmor: "prepared-from-authorized-source",
  oasdiff: "customer-supplied",
  "build-check": "customer-supplied",
  codeql: "customer-supplied",
  schemathesis: "prepared-from-authorized-source",
  zap: "customer-supplied",
  mutation: "customer-supplied",
  "supply-chain": "shipped",
  semgrep: "customer-supplied",
};

test("V2-21: a fresh npm-packed installation lists zizmor, oasdiff, build-check, CodeQL, Schemathesis, ZAP, mutation, supply-chain and the shipped Semgrep pack with their distribution states", () => {
  try {
    // 1. Pack the repository exactly as it would be published (scripts off: the built output is what is packed).
    const packDir = tmp("v2-21-pack-");
    const packed = JSON.parse(npm(["pack", "--ignore-scripts", "--pack-destination", packDir, "--json"], { cwd: root }).stdout);
    const tarball = path.join(packDir, packed[0].filename);
    assert.ok(fs.existsSync(tarball), "npm pack produced a tarball");

    // 2. Install that tarball into an empty folder.
    const prefix = tmp("v2-21-install-");
    fs.writeFileSync(path.join(prefix, "package.json"), JSON.stringify({ name: "v2-21-consumer", private: true, version: "0.0.0" }));
    npm(["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", "--loglevel", "error"], { cwd: prefix });
    const installed = path.join(prefix, "node_modules", "jgates", "jgates");
    const main = path.join(installed, "dist", "cli", "main.js");
    assert.ok(fs.existsSync(main), "the installed package carries the jgates CLI");
    assert.equal(fs.existsSync(path.join(root, "jgates", "dist")), true);

    // 3. Ask the installed CLI. The home is empty and the working folder has no jgates files: a fresh installation.
    const home = tmp("v2-21-home-");
    const cwd = tmp("v2-21-empty-");
    const env = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", NO_COLOR: "1" };
    const cli = (args, dir = cwd) => {
      const r = spawnSync(process.execPath, [main, ...args], { cwd: dir, encoding: "utf8", env, input: "", timeout: 240_000 });
      let doc = null;
      try {
        doc = JSON.parse(r.stdout);
      } catch {
        doc = null;
      }
      assert.ok(doc, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      return { code: r.status, doc };
    };

    const list = cli(["tools", "list", "--json", "--cwd", cwd]);
    assert.equal(list.code, 0);
    assert.deepEqual(list.doc.instances, [], "a fresh installation has no custom instance");
    const adapters = new Map(list.doc.adapters.map((a) => [a.id, a]));
    for (const [id, mode] of Object.entries(EXPECTED)) {
      const adapter = adapters.get(id);
      assert.ok(adapter, `${id} is in the standard catalog`);
      assert.equal(adapter.distribution?.mode, mode, `${id} distribution state`);
      assert.ok(Array.isArray(adapter.stackSupport) && adapter.stackSupport.length > 0, `${id} declares capability-by-stack support`);
      assert.equal(adapter.origin, "builtin", `${id} is built in, not a custom adapter`);
      // A tool JGates does not ship carries the official way to get and set it up; the shipped one carries SPDX and notices.
      if (mode === "shipped") assert.ok(adapter.distribution.spdx && adapter.distribution.notices?.length > 0, `${id} records SPDX and notices`);
      else {
        assert.ok(adapter.distribution.acquisition?.length > 0, `${id} has official acquisition links`);
        assert.ok(adapter.distribution.setup?.length > 0, `${id} has official setup guidance`);
      }
    }
    const capabilities = new Map(list.doc.capabilities.map((c) => [c.id, c]));
    assert.equal(capabilities.get("supply-chain")?.category, "dependencies");

    // 4. The Semgrep rule pack JGates authors ships inside the tarball with its record (shipped, MIT, notices).
    const packsDir = path.join(installed, "packs", "semgrep");
    assert.ok(fs.existsSync(path.join(packsDir, "jgates-semgrep", "jgates-pack.json")), "the shipped Semgrep pack is in the installed package");
    const distribution = cli(["tools", "distribution", "--packs", packsDir, "--json", "--cwd", cwd]);
    assert.equal(distribution.code, 0, JSON.stringify(distribution.doc.report.problems));
    const pack = distribution.doc.report.packs.find((p) => p.id === "jgates-semgrep-rules");
    assert.ok(pack, "the Semgrep pack is reported");
    assert.equal(pack.ok, true);
    assert.equal(pack.record.distribution, "shipped");
    assert.equal(pack.record.spdx, "MIT");
    assert.ok(pack.record.notices.length > 0);
    for (const id of Object.keys(EXPECTED)) assert.equal(distribution.doc.report.adapters.find((a) => a.id === id)?.mode, EXPECTED[id], `${id} in the distribution report`);

    // 5. With evidence in the project, the standard plan includes the new checks without any custom adapter.
    const project = tmp("v2-21-project-");
    fs.mkdirSync(path.join(project, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(project, ".github", "workflows", "ci.yml"), "name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n");
    fs.copyFileSync(path.join(root, "jgates", "tests", "fixtures", "supply-chain", "npm-risky", "package-lock.json"), path.join(project, "package-lock.json"));
    fs.writeFileSync(path.join(project, "openapi.yaml"), "openapi: 3.0.3\ninfo: { title: t, version: '1' }\npaths: {}\n");
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
    const init = cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"], project);
    assert.equal(init.code, 0, JSON.stringify(init.doc));
    const plan = cli(["plan", "--cwd", project, "--json"], project);
    assert.equal(plan.code, 0, JSON.stringify(plan.doc).slice(0, 400));
    const planned = [...plan.doc.plan.groups.willRun, ...plan.doc.plan.groups.notApplicableOrDisabled];
    for (const adapter of ["zizmor", "oasdiff", "supply-chain"]) assert.ok(planned.some((i) => i.adapter === adapter), `${adapter} is in the plan of a project with its evidence`);
    assert.equal(planned.find((i) => i.adapter === "supply-chain").category, "dependencies");
  } finally {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  }
});
