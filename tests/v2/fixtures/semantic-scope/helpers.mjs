// Shared setup of the scope cases (V2-24..V2-27): a temporary Git repository holding a copy of ./app, a temporary
// JGATES_HOME, the jgates CLI, and an optional fake provider command that records every prompt it receives and
// answers with the JSON in answer.json (no test spends model tokens).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..", "..", "..");
export const MAIN = path.join(ROOT, "jgates", "dist", "cli", "main.js");
export const APP = path.join(here, "app");
export const load = (rel) => import(pathToFileURL(path.join(ROOT, "jgates", "dist", rel)).href);

export const APPROVED = { status: "APPROVED", score: 95, findings: [], hardBlockers: [] };

const GIT_ENV = { GIT_AUTHOR_NAME: "Scope Test", GIT_AUTHOR_EMAIL: "scope@example.invalid", GIT_COMMITTER_NAME: "Scope Test", GIT_COMMITTER_EMAIL: "scope@example.invalid" };

export function setupRepo(prefix, { provider = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-ws-`));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-home-`));
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-aux-`));
  fs.cpSync(APP, dir, { recursive: true });
  const prompts = path.join(aux, "prompts");
  fs.mkdirSync(prompts);
  const answerFile = path.join(aux, "answer.json");
  fs.writeFileSync(answerFile, JSON.stringify(APPROVED));
  if (provider) {
    const script = path.join(aux, "fake-provider.mjs");
    fs.writeFileSync(
      script,
      [
        `import fs from "node:fs";`,
        `import path from "node:path";`,
        `const chunks = [];`,
        `for await (const c of process.stdin) chunks.push(c);`,
        `const n = fs.readdirSync(${JSON.stringify(prompts)}).length + 1;`,
        `fs.writeFileSync(path.join(${JSON.stringify(prompts)}, String(n).padStart(3, "0") + ".txt"), Buffer.concat(chunks));`,
        `process.stdout.write(fs.readFileSync(${JSON.stringify(answerFile)}, "utf8"));`,
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "jgates.yml"),
      ["extensions:", "  semantic-gate:", "    provider: command", `    command: ${JSON.stringify(process.execPath)}`, `    commandArgs: [${JSON.stringify(script)}]`, "    model: fake-model", "    maxCalls: 20", ""].join("\n"),
    );
  }
  const env = { ...process.env, ...GIT_ENV, JGATES_HOME: home, NO_COLOR: "1", JGATES_LOCALE: "en" };
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const head = () => git("rev-parse", "HEAD");
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args, "--cwd", dir], { encoding: "utf8", env, input: "", timeout: 180_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const answer = (doc) => fs.writeFileSync(answerFile, JSON.stringify(doc));
  const sentPrompts = () => fs.readdirSync(prompts).sort().map((f) => fs.readFileSync(path.join(prompts, f), "utf8"));
  const clearPrompts = () => {
    for (const f of fs.readdirSync(prompts)) fs.rmSync(path.join(prompts, f));
  };
  const cleanup = () => {
    for (const d of [dir, home, aux]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { dir, home, env, git, head, cli, write, answer, sentPrompts, clearPrompts, cleanup };
}

/** The plan document of `jgates semantic plan ... --json`, asserting it answered. */
export function plan(p, ...args) {
  const r = p.cli("semantic", "plan", ...args, "--json");
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(r.doc?.plan, r.out + r.err);
  return r.doc.plan;
}

export const ids = (xs) => xs.map((x) => x.id ?? x.path).sort();
export const codes = (entry) => (entry?.reasons ?? []).map((r) => r.code);
