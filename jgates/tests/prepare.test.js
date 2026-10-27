import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Explicit preparation: doctor only reads; `tools prepare` is the one step that downloads the Semgrep rules,
// stores them by hash under JGATES_HOME/tools and pins the hash in .jgates/lock.json; the next run uses that copy
// with the network gone; a tool version outside the adapter range is incompatible and blocks the stage.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const REAL_SEMGREP = path.join(VENV_BIN, process.platform === "win32" ? "semgrep.exe" : "semgrep");
const HAS_SEMGREP = fs.existsSync(REAL_SEMGREP);
const lockModule = await import(pathToFileURL(path.join(dist, "core", "lock", "index.js")).href);
const semver = await import(pathToFileURL(path.join(dist, "core", "prepare", "semver.js")).href);

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const posixOnly = process.platform === "win32" ? "fake tool scripts need a POSIX shell" : false;

const RULES = `rules:
  - id: no-eval
    message: Do not call eval
    severity: ERROR
    languages: [python]
    pattern: eval(...)
`;
const SOURCE = 'value = eval("1")\n';
const TOOLS_NO_BINDING = "schemaVersion: 1\ntools:\n  semgrep:\n    adapter: semgrep\n    capabilities: [sast]\n";
const TOOLS_LOCAL = `${TOOLS_NO_BINDING}    config:\n      path: .jgates/rules\n      kind: directory\n      role: rules\n`;

/** Lists every file and directory under dir (relative, sorted) with size and mtime, to prove nothing changed. */
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const st = fs.lstatSync(abs);
      out.push(`${path.relative(dir, abs)}|${st.isDirectory() ? "d" : st.size}|${st.mtimeMs}`);
      if (st.isDirectory()) walk(abs);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** A tool stand-in that only answers --version. */
function fakeTool(dir, name, version) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "${name} ${version}"\n`, { mode: 0o755 });
  return file;
}

function project({ tools = TOOLS_NO_BINDING, env = {}, withRules = false } = {}) {
  const dir = tmp("jgates-prep-ws-");
  const home = path.join(tmp("jgates-prep-home-"), "data");
  const bin = tmp("jgates-prep-bin-");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "app.py"), SOURCE);
  const full = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, PATH: bin, ...env };
  const cli = (args, input) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: full, input: input ?? "", timeout: 240_000 });
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
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), tools);
  if (withRules) {
    fs.mkdirSync(path.join(dir, ".jgates", "rules"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".jgates", "rules", "no-eval.yml"), RULES);
  }
  return {
    dir,
    home,
    bin,
    cli,
    doctor: () => cli(["doctor", "--cwd", dir, "--json"]),
    prepare: (...more) => cli(["tools", "prepare", "--instance", "semgrep", "--cwd", dir, "--no-interactive", "--json", ...more]),
    plan: () => cli(["plan", "--cwd", dir, "--only", "tool:semgrep", "--json"]),
    run: () => cli(["run", "--cwd", dir, "--only", "tool:semgrep", "--no-interactive", "--json"]),
    cleanup() {
      for (const d of [dir, path.dirname(home), bin]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

/**
 * A local HTTP server that plays the rules registry, in its own process (the tests call the CLI with spawnSync,
 * which would block an in-process server). Every request prints one line, so the hits can be counted.
 */
async function registry(body = RULES) {
  const script = `const http=require("http");const body=${JSON.stringify(body)};
const s=http.createServer((q,r)=>{console.log("hit");r.setHeader("Content-Type","application/yaml");r.end(body);});
s.listen(0,"127.0.0.1",()=>console.log("port "+s.address().port));`;
  const proc = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  const state = { hits: 0 };
  let buffer = "";
  const port = await new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "hit") state.hits += 1;
        else if (line.startsWith("port ")) resolve(Number(line.slice(5)));
      }
    });
  });
  const url = `http://127.0.0.1:${port}/c/p/default`;
  let closed = false;
  return {
    state,
    url,
    /** Lets the output of the registry process reach this process (spawnSync blocked the event loop). */
    settle: () => new Promise((resolve) => setTimeout(resolve, 150)),
    close: async () => {
      if (closed) return;
      closed = true;
      const exited = once(proc, "exit");
      proc.kill();
      await exited;
    },
  };
}

const toolOf = (doc, id) => doc.tools.find((x) => x.instance === id);

test("version ranges: comparators, wildcard and unreadable versions", () => {
  assert.equal(semver.satisfiesRange("1.100.0", ">=1.100.0"), true);
  assert.equal(semver.satisfiesRange("1.99.9", ">=1.100.0"), false);
  assert.equal(semver.satisfiesRange("0.17.2", ">=0.5.0 <1.0.0"), true);
  assert.equal(semver.satisfiesRange("1.0.0", ">=0.5.0 <1.0.0"), false);
  assert.equal(semver.satisfiesRange("9.9.9", "*"), true);
  assert.equal(semver.satisfiesRange("not-a-version", ">=1.0.0"), null, "an unreadable version never passes silently");
});

test("lock.schema.json accepts the file the prepare step writes and refuses unknown keys", () => {
  const good = { schemaVersion: 1, tools: { semgrep: { adapter: "semgrep", adapterVersion: "0.1.0", toolVersion: "1.100.0", preparedAt: "2026-10-25T00:00:00Z", rules: [{ ref: "p/default", hash: "a".repeat(64), file: "p-default.yml", source: "https://semgrep.dev/c/p/default", bytes: 10 }] } } };
  assert.deepEqual(lockModule.validateLock(good), []);
  assert.notDeepEqual(lockModule.validateLock({ ...good, extra: true }), []);
  assert.notDeepEqual(lockModule.validateLock({ schemaVersion: 1, tools: { semgrep: { adapter: "semgrep" } } }), []);
  assert.ok(lockModule.validateLock({ schemaVersion: 1, tools: { semgrep: { ...good.tools.semgrep, rules: [{ ...good.tools.semgrep.rules[0], hash: "nothex" }] } } }).length > 0);
});

test("doctor --json: each runtime and tool is ready, absent or incompatible, with the fix; nothing is created or downloaded", { skip: posixOnly }, () => {
  const bin = tmp("jgates-prep-fake-");
  const p = project({ tools: `schemaVersion: 1\ntools:\n  semgrep:\n    adapter: semgrep\n    capabilities: [sast]\n  ruff:\n    adapter: ruff\n    capabilities: [lint]\n`, env: { JGATES_SEMGREP: fakeTool(bin, "semgrep", "1.50.0"), JGATES_RUFF: path.join(bin, "no-such-ruff") } });
  try {
    assert.equal(fs.existsSync(p.home), false, "the data folder does not exist before the doctor");
    const workspaceBefore = snapshot(p.dir);
    const r = p.doctor();
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(fs.existsSync(p.home), false, "the doctor does not create the data folder");
    assert.deepEqual(snapshot(p.dir), workspaceBefore, "the doctor does not touch the workspace");

    const d = r.doc;
    assert.equal(d.status, "OK");
    assert.deepEqual(d.runtimes.map((x) => x.id), ["node", "python", "git", "docker"]);
    assert.equal(d.runtimes.find((x) => x.id === "node").state, "ready");
    assert.equal(d.runtimes.find((x) => x.id === "python").state, "ready");
    const semgrep = toolOf(d, "semgrep");
    assert.equal(semgrep.state, "incompatible");
    assert.equal(semgrep.version, "1.50.0");
    assert.equal(semgrep.range, ">=1.100.0");
    assert.match(semgrep.message, /Versão incompatível/);
    assert.ok(semgrep.fix);
    assert.equal(semgrep.preparation.supported, true);
    assert.match(semgrep.preparation.command, /tools prepare --instance semgrep/);
    const ruff = toolOf(d, "ruff");
    assert.equal(ruff.state, "absent");
    assert.ok(ruff.fix, "an absent tool carries the command that fixes it");
    assert.equal(d.environmentReady, false);
    assert.equal(d.summary.incompatible, 1);
    assert.ok(d.summary.absent >= 1);

    const text = spawnSync(process.execPath, [MAIN, "doctor", "--cwd", p.dir], { encoding: "utf8", env: { ...process.env, JGATES_HOME: p.home, JGATES_PYTHON: PYTHON, PATH: p.bin, JGATES_SEMGREP: path.join(bin, "semgrep"), JGATES_RUFF: path.join(bin, "none") } });
    assert.equal(text.status, 0);
    assert.match(text.stdout, /versão incompatível/);
    assert.equal(fs.existsSync(p.home), false);
  } finally {
    p.cleanup();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("doctor reports a ready tool and the real ruff of the repository environment", { skip: !fs.existsSync(path.join(VENV_BIN, "ruff")) }, () => {
  const p = project({ tools: "schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    capabilities: [lint]\n", env: { JGATES_RUFF: path.join(VENV_BIN, "ruff") } });
  try {
    const ruff = toolOf(p.doctor().doc, "ruff");
    assert.equal(ruff.state, "ready");
    assert.match(ruff.version, /^\d+\.\d+\.\d+/);
    assert.equal(ruff.fix, null);
    assert.equal(ruff.preparation.supported, false);
  } finally {
    p.cleanup();
  }
});

test("tools prepare --dry-run shows versions and network and downloads nothing", { skip: posixOnly }, async () => {
  const reg = await registry();
  const bin = tmp("jgates-prep-fake-");
  const p = project({ env: { JGATES_SEMGREP_RULES_URL: reg.url, JGATES_SEMGREP: fakeTool(bin, "semgrep", "1.120.0") } });
  try {
    const before = snapshot(p.dir);
    const r = p.prepare("--dry-run");
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.doc.dryRun, true);
    assert.equal(r.doc.preview.versions.installed, "1.120.0");
    assert.equal(r.doc.preview.versions.range, ">=1.100.0");
    assert.deepEqual(r.doc.preview.network.hosts, [new URL(reg.url).host]);
    await reg.settle();
    assert.equal(reg.state.hits, 0, "the dry run does not touch the network");
    assert.equal(fs.existsSync(p.home), false);
    assert.deepEqual(snapshot(p.dir), before);
  } finally {
    await reg.close();
    p.cleanup();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("tools prepare stores the rules by hash, pins the hash in the lock and the next run uses the copy with no network", { skip: !HAS_SEMGREP }, async () => {
  const reg = await registry();
  const p = project({ env: { JGATES_SEMGREP_RULES_URL: reg.url, JGATES_SEMGREP: REAL_SEMGREP } });
  try {
    const notYet = p.plan();
    assert.equal(notYet.doc.plan.approvable, false, "without local rules and without a prepared copy the instance has nothing to run");

    const r = p.prepare();
    assert.equal(r.code, 0, r.out + r.err);
    await reg.settle();
    assert.equal(reg.state.hits, 1);
    const { hash } = r.doc.result.rules;
    assert.match(hash, /^[0-9a-f]{64}$/);
    const stored = path.join(p.home, "tools", hash, "p-default.yml");
    assert.equal(fs.readFileSync(stored, "utf8"), RULES);

    const lockRead = lockModule.readLock(p.dir);
    assert.equal(lockRead.problem, null);
    assert.equal(lockRead.lock.tools.semgrep.rules[0].hash, hash);
    assert.equal(lockRead.lock.tools.semgrep.rules[0].ref, "p/default");
    assert.ok(lockRead.lock.tools.semgrep.toolVersion);

    const again = p.prepare();
    assert.equal(again.doc.result.changed, false, "the same bytes keep the same hash");

    // The registry is gone: the plan and the run need no network.
    await reg.close();
    const planned = p.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = planned.doc.plan.groups.willRun.find((i) => i.id === "semgrep#sast");
    assert.equal(item.network, false);
    assert.equal(item.availability.status, "available");
    assert.ok(item.command.args.includes(stored), "the plan points at the stored copy");
    assert.ok(item.conditions.some((c) => c.includes(hash.slice(0, 12)) && /preparadas/.test(c)), "the plan shows where the rules came from");
    assert.ok(item.configFiles.some((f) => f.file === ".jgates/lock.json"), "the lock is an input of the plan");

    const ran = p.run();
    assert.equal(ran.code, 1, ran.out + ran.err);
    const stage = ran.doc.stages.find((s) => s.id === "semgrep#sast");
    assert.equal(stage.state, "completed");
    assert.deepEqual(ran.doc.findings.filter((f) => f.tool === "semgrep").map((f) => f.ruleId), ["no-eval"]);

    // Doctor sees the preparation.
    const d = toolOf(p.doctor().doc, "semgrep");
    assert.equal(d.preparation.state, "ready");
    assert.equal(d.preparation.hash, hash);

    // A copy that no longer matches the pinned hash is never used silently.
    fs.writeFileSync(stored, `${RULES}# tampered\n`);
    const tampered = p.plan().doc.plan.groups.willRun.find((i) => i.id === "semgrep#sast");
    assert.equal(tampered.availability.status, "unavailable");
    assert.match(tampered.availability.reason, /tools prepare/);
  } finally {
    await reg.close().catch(() => {});
    p.cleanup();
  }
});

test("a failed download changes nothing; an invalid payload is refused", { skip: !HAS_SEMGREP }, async () => {
  const reg = await registry("not: rules\n");
  const p = project({ env: { JGATES_SEMGREP_RULES_URL: reg.url, JGATES_SEMGREP: REAL_SEMGREP } });
  try {
    const bad = p.prepare();
    assert.equal(bad.code, 3);
    assert.equal(bad.doc.error.code, "RULES_INVALID");
    assert.equal(fs.existsSync(path.join(p.dir, ".jgates", "lock.json")), false);
    await reg.close();
    const offline = p.prepare();
    assert.equal(offline.code, 3);
    assert.equal(offline.doc.error.code, "NETWORK_UNAVAILABLE");
    assert.equal(fs.existsSync(path.join(p.dir, ".jgates", "lock.json")), false);
    const insecure = spawnSync(process.execPath, [MAIN, "tools", "prepare", "--instance", "semgrep", "--cwd", p.dir, "--no-interactive", "--json"], {
      encoding: "utf8",
      env: { ...process.env, JGATES_HOME: p.home, JGATES_PYTHON: PYTHON, PATH: p.bin, JGATES_SEMGREP: REAL_SEMGREP, JGATES_SEMGREP_RULES_URL: "http://example.invalid/rules" },
    });
    assert.equal(insecure.status, 3);
    assert.equal(JSON.parse(insecure.stdout).error.code, "INSECURE_URL");
  } finally {
    await reg.close().catch(() => {});
    p.cleanup();
  }
});

test("tools prepare refuses an instance without a preparation step and an unknown one", { skip: !fs.existsSync(path.join(VENV_BIN, "ruff")) }, () => {
  const p = project({ tools: "schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    capabilities: [lint]\n" });
  try {
    const ruff = p.cli(["tools", "prepare", "--instance", "ruff", "--cwd", p.dir, "--no-interactive", "--json"]);
    assert.equal(ruff.code, 3);
    assert.equal(ruff.doc.error.code, "PREPARE_NOT_SUPPORTED");
    const ghost = p.cli(["tools", "prepare", "--instance", "ghost", "--cwd", p.dir, "--no-interactive", "--json"]);
    assert.equal(ghost.code, 3);
    assert.equal(ghost.doc.error.code, "INSTANCE_NOT_FOUND");
    const none = p.cli(["tools", "prepare", "--cwd", p.dir, "--no-interactive", "--json"]);
    assert.equal(none.code, 3);
    assert.equal(none.doc.error.code, "MISSING_INSTANCE");
  } finally {
    p.cleanup();
  }
});

test("a version older than the one pinned in the lock is refused unless the change is accepted on purpose", { skip: posixOnly }, async () => {
  const reg = await registry();
  const bin = tmp("jgates-prep-fake-");
  const p = project({ env: { JGATES_SEMGREP_RULES_URL: reg.url, JGATES_SEMGREP: fakeTool(bin, "semgrep", "1.150.0") } });
  try {
    assert.equal(p.prepare().code, 0);
    const lock = lockModule.readLock(p.dir).lock;
    assert.equal(lock.tools.semgrep.toolVersion, "1.150.0");
    fakeTool(bin, "semgrep", "1.120.0");
    // The probe caches by mtime; touch to make sure the new answer is read.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(bin, "semgrep"), later, later);
    const refused = p.prepare();
    assert.equal(refused.code, 3);
    assert.equal(refused.doc.error.code, "VERSION_DOWNGRADE");
    assert.equal(lockModule.readLock(p.dir).lock.tools.semgrep.toolVersion, "1.150.0", "the lock keeps the pinned version");
    const accepted = p.prepare("--allow-version-change");
    assert.equal(accepted.code, 0, accepted.out + accepted.err);
    assert.equal(lockModule.readLock(p.dir).lock.tools.semgrep.toolVersion, "1.120.0");
  } finally {
    await reg.close();
    p.cleanup();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("a tool outside the adapter version range is incompatible in the plan and blocks the required stage", { skip: posixOnly }, () => {
  const bin = tmp("jgates-prep-fake-");
  const p = project({ tools: TOOLS_LOCAL, withRules: true, env: { JGATES_SEMGREP: fakeTool(bin, "semgrep", "1.50.0") } });
  try {
    const planned = p.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = planned.doc.plan.groups.willRun.find((i) => i.id === "semgrep#sast");
    assert.equal(item.availability.status, "unavailable");
    assert.match(item.availability.reason, /Versão incompatível/);
    assert.match(item.availability.reason, /1\.50\.0/);
    assert.match(item.availability.reason, />=1\.100\.0/);
    assert.equal(item.versions.toolVersion, "1.50.0");
    assert.ok(planned.doc.plan.warnings.some((w) => w.code === "TOOL_UNAVAILABLE" && /Versão incompatível/.test(w.message)));

    const ran = p.run();
    assert.notEqual(ran.code, 0, "the incompatible tool never approves");
    assert.notEqual(ran.doc.decision, "approved");
    const stage = ran.doc.stages.find((s) => s.id === "semgrep#sast");
    assert.equal(stage.state, "blocked");
    assert.match(stage.reason, /Versão incompatível/);
    assert.equal(ran.doc.findings.filter((f) => f.tool === "semgrep").length, 0);
  } finally {
    p.cleanup();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

// The real registry download: only with network, outside the offline suite (JGATES_NETWORK_TESTS=1).
test("network: tools prepare downloads the real p/default once", { skip: process.env.JGATES_NETWORK_TESTS === "1" && HAS_SEMGREP ? false : "network test: set JGATES_NETWORK_TESTS=1" }, () => {
  const p = project({ env: { JGATES_SEMGREP: REAL_SEMGREP } });
  try {
    const r = p.prepare();
    assert.equal(r.code, 0, r.out + r.err);
    assert.ok(r.doc.result.rules.bytes > 1000);
    assert.ok(fs.existsSync(path.join(p.home, "tools", r.doc.result.rules.hash, "p-default.yml")));
  } finally {
    p.cleanup();
  }
});
