import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitFromResolved, compare, describeInstallation, installCommand, remoteCommit, repositoryUrl } from "../dist/core/update/index.js";

// `jgates update` and About > Updates, against a local git repository and a fake installation: no network, and the
// real installation of the machine is never touched.

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, "..", "dist", "cli", "main.js");
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** A repository with a minimal package named jgates; returns its file URL and its commits. */
function repository() {
  const dir = tmp("jg-up-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "test");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "jgates", version: "9.9.0" }));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  const first = git(dir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "jgates", version: "9.9.1" }));
  git(dir, "commit", "-q", "-am", "second");
  git(dir, "tag", "-a", "v9.9.1", "-m", "release");
  const second = git(dir, "rev-parse", "HEAD");
  return { dir, url: pathToFileURL(dir).href, first, second };
}

/** An installation as `npm install --prefix <prefix> git+...` leaves it, built from `commit`. */
function installation(commit, { owner = true } = {}) {
  const prefix = tmp("jg-up-prefix-");
  const pkg = path.join(prefix, "node_modules", "jgates");
  fs.mkdirSync(path.join(pkg, "jgates", "dist"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "jgates", version: "9.9.0", repository: { type: "git", url: "git+https://example.invalid/jgates.git" } }));
  if (commit) fs.writeFileSync(path.join(pkg, "jgates", "dist", "build-info.json"), JSON.stringify({ commit, dirty: false }));
  if (owner) fs.writeFileSync(path.join(prefix, "package.json"), JSON.stringify({ dependencies: { jgates: "git+https://example.invalid/jgates.git" } }));
  return { prefix, pkg };
}

test("the repository URL and the commit npm recorded are read from their usual shapes", () => {
  assert.equal(repositoryUrl({ url: "git+https://github.com/rodrigojager/jgates.git" }), "https://github.com/rodrigojager/jgates.git");
  assert.equal(repositoryUrl(undefined), null);
  const sha = "a".repeat(40);
  assert.equal(commitFromResolved(`git+ssh://git@github.com/rodrigojager/jgates.git#${sha}`), sha);
  assert.equal(commitFromResolved("file:../jgates-0.3.0.tgz"), null);
});

test("an installation says how it was installed and which commit it came from", () => {
  const sha = "b".repeat(40);
  const dep = installation(sha);
  const global = installation(null, { owner: false });
  try {
    const a = describeInstallation(dep.pkg);
    assert.equal(a.kind, "dependency");
    assert.equal(a.prefix, dep.prefix);
    assert.equal(a.commit, sha);
    assert.equal(a.repository, "https://example.invalid/jgates.git");
    assert.deepEqual(installCommand(a, a.repository, sha), ["npm", "install", "--prefix", dep.prefix, `git+https://example.invalid/jgates.git#${sha}`, "--no-audit", "--no-fund"]);
    const b = describeInstallation(global.pkg);
    assert.equal(b.kind, "global");
    assert.equal(b.commit, null);
    assert.equal(installCommand(b, "https://example.invalid/jgates.git", sha), null, "a global install is updated by hand");
    // Without build-info, the lockfile's resolved URL tells the commit.
    fs.writeFileSync(path.join(global.prefix, "package-lock.json"), JSON.stringify({ packages: { "node_modules/jgates": { resolved: `git+https://example.invalid/jgates.git#${sha}` } } }));
    assert.equal(describeInstallation(global.pkg).commit, sha);
  } finally {
    for (const d of [dep.prefix, global.prefix]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("the newest commit comes from git ls-remote, for a branch or an annotated tag", () => {
  const repo = repository();
  try {
    assert.equal(remoteCommit(repo.url, "main"), repo.second);
    assert.equal(remoteCommit(repo.url, "v9.9.1"), repo.second, "the peeled tag names the commit");
    assert.throws(() => remoteCommit(repo.url, "missing"), (e) => e.code === "REF_NOT_FOUND");
    const inst = describeInstallation(installation(repo.first).pkg);
    assert.equal(compare(inst, repo.second), "available");
    assert.equal(compare({ ...inst, commit: repo.second }, repo.second), "up-to-date");
    assert.equal(compare({ ...inst, commit: null }, repo.second), "unknown");
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

function cli(args, env) {
  const home = tmp("jg-up-home-");
  try {
    return spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...process.env, JGATES_HOME: home, ...env } });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("jgates update --check only reports, in JSON and in both languages", () => {
  const repo = repository();
  const inst = installation(repo.first);
  const env = { JGATES_UPDATE_PACKAGE_DIR: inst.pkg, JGATES_UPDATE_REPOSITORY: repo.url };
  try {
    const r = cli(["update", "--check", "--json"], env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.state, "available");
    assert.equal(out.latest, repo.second);
    assert.equal(out.applied, null);
    assert.equal(fs.existsSync(path.join(inst.prefix, "node_modules", ".package-lock.json")), false, "nothing was installed");
    const en = cli(["update", "--check", "--locale", "en"], env);
    assert.match(en.stdout, /An update is available\./);
    const pt = cli(["update", "--check", "--locale", "pt-BR"], env);
    assert.match(pt.stdout, /Há uma atualização disponível\./);
    const missing = cli(["update", "--check", "--ref", "missing", "--json"], env);
    assert.equal(missing.status, 3);
    assert.equal(JSON.parse(missing.stdout).code, "REF_NOT_FOUND");
    // Without a terminal and without --yes it never installs.
    const plain = cli(["update", "--locale", "en"], env);
    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /run again with --yes/);
  } finally {
    for (const d of [repo.dir, inst.prefix]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("jgates help lists the update command", () => {
  const r = cli(["help", "--json"], {});
  assert.equal(r.status, 0);
  assert.ok(JSON.parse(r.stdout).commands.some((c) => c.name === "update"));
});

// ---- About > Updates, through the API of a running `jgates ui` ------------------------------------------------------

function request(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: "127.0.0.1", port, method, path: p, agent: false, headers: { Host: `127.0.0.1:${port}`, ...(data ? { "Content-Type": "application/json", "Content-Length": String(data.length) } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

test("About > Updates checks only when asked and installs only the commit that check found", { timeout: 240_000 }, async () => {
  const repo = repository();
  const inst = installation(repo.first);
  const home = tmp("jg-up-home-");
  const dir = tmp("jg-up-ws-");
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  const env = { ...process.env, JGATES_HOME: home, JGATES_UPDATE_PACKAGE_DIR: inst.pkg, JGATES_UPDATE_REPOSITORY: repo.url };
  const proc = spawn(process.execPath, [MAIN, "ui", "--cwd", dir, "--no-open", "--port", "0", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    proc.stdout.setEncoding("utf8");
    let out = "";
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`jgates ui did not start: ${out}`)), 30_000);
      proc.stdout.on("data", (d) => {
        out += d;
        try {
          const parsed = JSON.parse(out);
          clearTimeout(timer);
          resolve(parsed);
        } catch {
          // Not complete yet.
        }
      });
    });
    const html = fs.readFileSync(info.launcher, "utf8");
    const url = new URL(/href="([^"]+)"/.exec(html)[1].replace(/&amp;/g, "&"));
    const boot = await request(info.port, "GET", url.pathname + url.search);
    const cookie = String(boot.headers["set-cookie"]?.[0] ?? "").split(";")[0];
    const s = await request(info.port, "GET", "/api/session", { headers: { Cookie: cookie } });
    const headers = { Cookie: cookie, Origin: `http://127.0.0.1:${info.port}`, "X-JGates-CSRF": s.json.csrfToken };
    const send = (method, p, body) => request(info.port, method, p, { headers, body });

    const idle = await send("GET", "/api/update/status");
    assert.equal(idle.json.update.state, "idle", "nothing runs before the person asks");
    const early = await send("POST", "/api/update/install", { commit: repo.second });
    assert.equal(early.status, 409, "no install without a check first");
    assert.equal(early.json.code, "UPDATE_NOT_CHECKED");

    const check = await send("POST", "/api/update/check", {});
    assert.equal(check.status, 200, check.text);
    assert.equal(check.json.state, "available");
    assert.equal(check.json.latest, repo.second);
    assert.equal(check.json.canInstall, true);

    const other = await send("POST", "/api/update/install", { commit: repo.first });
    assert.equal(other.status, 409, "only the commit the check found");

    const started = await send("POST", "/api/update/install", { commit: repo.second });
    assert.equal(started.status, 202, started.text);
    let state = started.json.update;
    for (let i = 0; i < 100 && state.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      state = (await send("GET", "/api/update/status")).json.update;
    }
    assert.equal(state.state, "done", state.log.join("\n"));
    const installed = JSON.parse(fs.readFileSync(path.join(inst.prefix, "node_modules", "jgates", "package.json"), "utf8"));
    assert.equal(installed.version, "9.9.1", "the fake prefix got the newer package");
  } finally {
    if (proc.exitCode === null) {
      const exited = once(proc, "exit");
      proc.kill("SIGTERM");
      await exited;
    }
    for (const d of [repo.dir, inst.prefix, home, dir]) fs.rmSync(d, { recursive: true, force: true });
  }
});
