import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

// The CLI side of the history screens (run --no-cache, run --waiver, history preserve, with gc keeping marked
// runs) and the catalogs of the screens (no text about demonstrations or sample data anywhere; the commands shown by the
// Help screen are real commands with real flags).

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const UI = path.resolve(here, "..", "ui");
const FAKE = path.join(here, "fixtures", "executables", "fake-tool.cjs");
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const waivers = await import(pathToFileURL(path.join(dist, "core", "results", "waivers.js")).href);

// ---------------------------------------------------------------------------------------------------------------
// Waiver flag

test("parseWaiverFlag reads key=value pairs and refuses what cannot work", () => {
  assert.deepEqual(waivers.parseWaiverFlag("rule=ruff.E711;path=demo/*;expires=2099-01-31;reason=legacy code"), {
    waiver: { rule: "ruff.E711", path: "demo/*", expires: "2099-01-31", reason: "legacy code" },
  });
  assert.deepEqual(waivers.parseWaiverFlag("fingerprint=jgf1:abc;reason=ok").waiver.fingerprint, "jgf1:abc");
  for (const [spec, part] of [
    ["rule=a", "reason is required"],
    ["reason=x", "give rule, fingerprint or path"],
    ["rule=a;reason=x;expires=31/01/2099", "YYYY-MM-DD"],
    ["rule=a;reason=x;expires=2099-02-31", "YYYY-MM-DD"],
    ["rule=a;colour=red;reason=x", 'unknown key "colour"'],
    ["rule;reason=x", "key=value"],
    ["rule=;reason=x", "is empty"],
  ]) {
    const r = waivers.parseWaiverFlag(spec);
    assert.ok("problem" in r && r.problem.includes(part), `${spec}: ${JSON.stringify(r)}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// CLI over a real run with the fake tool

function project() {
  const dir = tmp("jgates-hist-ws-");
  const home = tmp("jgates-hist-home-");
  const bin = tmp("jgates-hist-bin-");
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.mkdirSync(path.join(dir, "demo"));
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(dir, "demo", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "demo", "mod.py"), "x = 1\n");
  const env = { ...process.env, JGATES_HOME: home, JGATES_RUFF: FAKE, PATH: bin, JGATES_PYTHON: path.join(bin, "no-python") };
  delete env.JGATES_NO_CACHE;
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, timeout: 120_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  assert.equal(cli(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]).code, 0);
  const setMode = (mode) => fs.writeFileSync(path.join(dir, "lint.toml"), `# fake-mode: ${mode}\n`);
  setMode("clean");
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  lint:\n    adapter: ruff\n    capabilities: [lint]\n    config: lint.toml\n");
  const go = (...more) => cli(["run", "--cwd", dir, "--only", "tool:lint", "--no-interactive", "--json", ...more]);
  const lint = (doc) => doc.stages.find((s) => s.id === "lint#lint");
  return { dir, home, cli, go, lint, setMode, cleanup: () => [dir, home, bin].forEach((d) => fs.rmSync(d, { recursive: true, force: true })) };
}

test("run --no-cache runs the step again, while the plain second run reuses it", async () => {
  const p = project();
  try {
    const first = p.go();
    assert.ok(p.lint(first.doc), first.out + first.err);
    assert.equal(p.lint(first.doc).cache.status, "executed");
    const reused = p.go();
    assert.equal(p.lint(reused.doc).cache.status, "reused");
    const fresh = p.go("--no-cache");
    assert.equal(fresh.code, 0, fresh.out + fresh.err);
    // With the cache off the step carries no cache record at all: it ran, and nothing was read from or written to the cache.
    assert.equal(p.lint(fresh.doc).cache, undefined, "--no-cache never serves a step from an earlier run");
    assert.ok(p.lint(fresh.doc).execution.processes > 0);
    // And it is a documented flag of the command.
    const mod = await import(pathToFileURL(path.join(dist, "cli", "commands", "run.js")).href);
    assert.ok(mod.command.options.some((o) => o.name === "no-cache" && o.description.length > 0));
  } finally {
    p.cleanup();
  }
});

test("run --waiver waives a finding for that run only, on top of .jgates/waivers.json, and a bad spec stops before any run", () => {
  const p = project();
  try {
    p.setMode("violations");
    const blocked = p.go("--no-cache");
    const finding = blocked.doc.findings[0];
    assert.ok(finding, blocked.out + blocked.err);
    assert.equal(finding.waived, false);

    const spec = `rule=${finding.ruleId};reason=accepted for now;expires=2099-12-31`;
    const waived = p.go("--no-cache", "--waiver", spec);
    const w = waived.doc.findings.find((f) => f.ruleId === finding.ruleId);
    assert.equal(w.waived, true);
    assert.equal(w.waiverReason, "accepted for now");
    assert.equal(w.blocking, false);
    assert.equal(p.go("--no-cache").doc.findings[0].waived, false, "the flag does not outlive its run");

    // The file and the flag add up.
    fs.writeFileSync(path.join(p.dir, ".jgates", "waivers.json"), JSON.stringify({ waivers: [{ rule: "some.other.rule", reason: "from the file" }] }));
    const both = p.go("--no-cache", "--waiver", spec);
    assert.equal(both.doc.findings.find((f) => f.ruleId === finding.ruleId).waived, true);
    fs.writeFileSync(path.join(p.dir, ".jgates", "waivers.json"), JSON.stringify({ waivers: [{ rule: finding.ruleId, reason: "from the file" }] }));
    assert.equal(p.go("--no-cache", "--waiver", "rule=zzz;reason=other").doc.findings.find((f) => f.ruleId === finding.ruleId).waiverReason, "from the file");

    // An expired waiver does not apply.
    fs.rmSync(path.join(p.dir, ".jgates", "waivers.json"));
    const expired = p.go("--no-cache", "--waiver", `rule=${finding.ruleId};reason=old;expires=2020-01-01`);
    assert.equal(expired.doc.findings.find((f) => f.ruleId === finding.ruleId).waived, false);

    const before = fs.readdirSync(path.join(p.home, "workspaces")).flatMap((id) => fs.readdirSync(path.join(p.home, "workspaces", id, "runs")));
    const bad = p.go("--waiver", "rule=a");
    assert.equal(bad.code, 3);
    assert.equal(bad.doc.code, "BAD_WAIVER");
    const after = fs.readdirSync(path.join(p.home, "workspaces")).flatMap((id) => fs.readdirSync(path.join(p.home, "workspaces", id, "runs")));
    assert.equal(after.length, before.length, "no run was created");
  } finally {
    p.cleanup();
  }
});

test("history preserve marks a run and gc --dry-run leaves marked runs out of the removal list", () => {
  const p = project();
  try {
    const a = p.go("--no-cache").doc.runId;
    const b = p.go("--no-cache").doc.runId;
    const c = p.go("--no-cache").doc.runId;
    const gc = () => p.cli(["gc", "--dry-run", "--max-age-days", "0", "--json"]).doc.runs.map((r) => r.runId);
    assert.deepEqual(gc().sort(), [a, b, c].sort());

    const kept = p.cli(["history", "preserve", a, "--cwd", p.dir, "--json"]);
    assert.equal(kept.code, 0, kept.out + kept.err);
    assert.equal(kept.doc.preserved, true);
    assert.deepEqual(gc().sort(), [b, c].sort());
    const listed = p.cli(["history", "--cwd", p.dir, "--json"]).doc.runs;
    assert.equal(listed.find((r) => r.runId === a).preserved, true);

    assert.equal(p.cli(["baseline", "set", b, "--cwd", p.dir, "--json"]).code, 0);
    assert.deepEqual(gc(), [c]);

    const released = p.cli(["history", "unpreserve", a, "--cwd", p.dir, "--json"]);
    assert.equal(released.doc.preserved, false);
    assert.deepEqual(gc().sort(), [a, c].sort());

    const missing = p.cli(["history", "preserve", "run_nope", "--cwd", p.dir, "--json"]);
    assert.equal(missing.code, 3);
    assert.equal(missing.doc.code, "RUN_NOT_FOUND");
    assert.equal(p.cli(["history", "preserve", "--cwd", p.dir, "--json"]).doc.code, "MISSING_RUN");
    assert.equal(p.cli(["history", "frobnicate", "--cwd", p.dir, "--json"]).doc.code, "UNKNOWN_SUBCOMMAND");
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Catalog of the UI

async function loadCatalog() {
  const vite = await createServer({ root: UI, configFile: false, logLevel: "silent", server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const i18n = await vite.ssrLoadModule("/src/i18n/index.ts");
    return { vite, i18n };
  } catch (error) {
    await vite.close();
    throw error;
  }
}

/** Every message of every UI catalog file, with the file it comes from. */
function catalogFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.pt-BR\.json$/.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(UI, "src"));
  return out;
}

// How a mockup talks about itself (prototype, demonstration, sample data): none of it can reach a screen of the product.
const MOCKUP_TALK = [
  /prot[oó]tipo/i,
  /demonstra[cç][aã]o/i,
  /demo interativa/i,
  /dados de exemplo/i,
  /dados fict[ií]cios/i,
  /valida[cç][õo]es de exemplo/i,
  /execu[cç][aã]o simulada/i,
  /este html/i,
  /offline · /i,
];

test("no screen carries mockup talk about a prototype, demonstrations or sample data", () => {
  const files = catalogFiles();
  assert.ok(files.length >= 8, `catalogs found: ${files.length}`);
  const hits = [];
  for (const file of files) {
    for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) {
      if (typeof value !== "string") continue;
      for (const pattern of MOCKUP_TALK) if (pattern.test(value)) hits.push(`${path.relative(UI, file)}: ${key}: ${value}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("the new screens bring their own catalogs and every key they use is defined", async () => {
  const { vite, i18n } = await loadCatalog();
  try {
    const files = i18n.messageSources().map((s) => s.file);
    for (const screen of ["history", "preferences", "storage", "help", "about"]) assert.ok(files.includes(`screens/${screen}/messages.pt-BR.json`), screen);
    assert.deepEqual(i18n.duplicateKeys(), []);
    for (const screen of ["history", "preferences", "storage", "help", "about"]) {
      const dir = path.join(UI, "src", "screens", screen);
      const source = fs.readdirSync(dir).filter((f) => /\.tsx$/.test(f)).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
      for (const [, key] of source.matchAll(/\bt\(\s*"([a-z0-9_-]+)"/g)) assert.notEqual(i18n.t(key), key, `${screen}: missing message ${key}`);
    }
  } finally {
    await vite.close();
  }
});

test("the commands of the Help screen are real jgates commands with real flags", async () => {
  const messages = JSON.parse(fs.readFileSync(path.join(UI, "src", "screens", "help", "messages.pt-BR.json"), "utf8"));
  const commands = Object.entries(messages).filter(([k]) => k.startsWith("help_cmd_"));
  assert.ok(commands.length >= 10, "the four steps and the extra commands");
  const names = fs.readdirSync(path.join(dist, "cli", "commands")).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, ""));
  const args = await import(pathToFileURL(path.join(dist, "cli", "args.js")).href);
  const globals = new Set((args.GLOBAL_OPTIONS ?? []).map((o) => o.name));
  for (const [key, text] of commands) {
    const tokens = text.match(/"[^"]*"|\S+/g);
    assert.equal(tokens[0], "jgates", key);
    assert.ok(names.includes(tokens[1]), `${key}: ${tokens[1]} is not a command`);
    const mod = await import(pathToFileURL(path.join(dist, "cli", "commands", `${tokens[1]}.js`)).href);
    const known = new Set([...(mod.command.options ?? []).map((o) => o.name), ...globals, "json"]);
    for (const token of tokens.slice(2)) if (token.startsWith("--")) assert.ok(known.has(token.slice(2)), `${key}: ${token} is not a flag of ${tokens[1]}`);
  }
  for (const step of ["init", "ui", "plan", "run"]) assert.ok(messages[`help_cmd_${step}`], step);
});
