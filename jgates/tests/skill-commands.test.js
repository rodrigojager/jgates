import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

function helpJson() {
  const r = spawnSync(process.execPath, [MAIN, "help", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** Lines of fenced code blocks that start with `jgates `. */
function jgatesLines(text) {
  const lines = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("```")) {
      inside = !inside;
      continue;
    }
    if (inside && /^jgates\s/.test(line.trim())) lines.push(line.trim());
  }
  return lines;
}

// The global options come from help --json itself (--json, --help, --version, --locale), so a flag the CLI does not
// accept never passes as "global".
const GLOBAL_FLAGS = new Set(helpJson().globalOptions);

/** Every agent skill shipped by the repository. */
const SKILL_FILES = [
  ["jgates", "skill", "SKILL.md"],
  ["use-jgates-quality", "SKILL.md"],
  ["use-jgates-quality", "agents", "openai.yaml"],
  ["use-jgates-semantic", "SKILL.md"],
  ["use-jgates-semantic", "agents", "openai.yaml"],
  ["quality-gate", "skill", "quality-gate.md"],
  ["semantic-gate", "templates", "semantic-review-skill.md"],
];

/** Every `jgates ...` command line of a skill: fenced code lines and inline code spans. */
function allJgatesLines(text) {
  const lines = jgatesLines(text);
  for (const match of text.matchAll(/`(jgates\s[^`]+)`/g)) lines.push(match[1].trim());
  return lines;
}

/** Commands safe to run with a folder that does not exist: each one refuses it (BAD_CWD) before touching anything. */
const PROBED = new Set(["baseline", "config", "discover", "doctor", "history", "init", "plan", "profiles", "report", "run", "tools"]);
/** Error codes that mean the command line itself is wrong (command, subcommand, flag, value or argument). */
const USAGE_CODES = new Set([
  "UNKNOWN_COMMAND",
  "UNKNOWN_SUBCOMMAND",
  "UNKNOWN_ACTION",
  "UNKNOWN_FLAG",
  "MISSING_VALUE",
  "UNEXPECTED_VALUE",
  "UNEXPECTED_ARGUMENT",
  "OPTION_NOT_SUPPORTED",
  "BAD_LOCALE",
]);

test("the jgates skill cites only commands and flags present in help --json", () => {
  const doc = helpJson();
  const byName = new Map(doc.commands.map((c) => [c.name, new Set(c.options.map((o) => o.name))]));
  const lines = jgatesLines(read("jgates", "skill", "SKILL.md"));
  assert.ok(lines.length >= 8, "the skill should show the cycle commands");
  const cited = new Set();
  for (const line of lines) {
    const tokens = line.split(/\s+/);
    const command = tokens[1];
    assert.ok(byName.has(command), `unknown command in skill: ${line}`);
    cited.add(command);
    for (const token of tokens.slice(2)) {
      if (!token.startsWith("--")) continue;
      assert.ok(
        byName.get(command).has(token) || GLOBAL_FLAGS.has(token),
        `flag ${token} is not in help --json for "${command}": ${line}`,
      );
    }
  }
  for (const command of ["discover", "doctor", "plan", "run", "report", "history"]) {
    assert.ok(cited.has(command), `the skill should cite jgates ${command}`);
  }
});

test("the jgates skill states that reduced and incomplete are not approval", () => {
  const text = read("jgates", "skill", "SKILL.md");
  assert.match(text, /`reduced: true`[\s\S]{0,300}NOT approval/);
  assert.match(text, /`incomplete`[\s\S]{0,200}NOT approved/);
  assert.match(text, /never ends the cycle as approved/);
});

test("the component skill folders are named use-jgates-quality and use-jgates-semantic, and each name matches its folder", () => {
  for (const folder of ["use-jgates-quality", "use-jgates-semantic"]) {
    const text = read(folder, "SKILL.md");
    const name = /^---\r?\n[\s\S]*?^name:\s*(\S+)\s*$/m.exec(text)?.[1];
    assert.equal(name, folder, `${folder}/SKILL.md: the front matter name must match the folder`);
    assert.ok(fs.existsSync(path.join(root, folder, "agents", "openai.yaml")), `${folder} keeps agents/openai.yaml`);
  }
  for (const old of ["use-quality-gate", "use-semantic-gate"]) {
    assert.equal(fs.existsSync(path.join(root, old)), false, `${old} was renamed and must not come back`);
  }
  const pkg = JSON.parse(read("package.json"));
  for (const folder of ["use-jgates-quality/", "use-jgates-semantic/"]) assert.ok(pkg.files.includes(folder), `package.json ships ${folder}`);
});

test("the three component skills mention jgates and the fix loop and keep the component commands", () => {
  const skills = [
    { file: ["use-jgates-quality", "SKILL.md"], current: ["quality-gate . --scope changed", "jgates doctor"] },
    { file: ["use-jgates-semantic", "SKILL.md"], current: ["semantic-gate run --scope changed", "semantic-gate status"] },
    { file: ["quality-gate", "skill", "quality-gate.md"], current: ["quality-gate . --scope changed", "jgates doctor"] },
  ];
  for (const { file, current } of skills) {
    const text = read(...file);
    assert.match(text, /jgates/, `${file.join("/")} should mention jgates`);
    assert.match(text, /reduced/, `${file.join("/")} should mention reduced`);
    assert.match(text, /## Fix Loop/, `${file.join("/")} should keep the fix loop`);
    for (const snippet of current) assert.ok(text.includes(snippet), `${file.join("/")} lost "${snippet}"`);
  }
});

test("the jgates commands cited in the current skills exist in help --json", () => {
  const doc = helpJson();
  const byName = new Map(doc.commands.map((c) => [c.name, new Set(c.options.map((o) => o.name))]));
  for (const file of [["use-jgates-quality", "SKILL.md"], ["use-jgates-semantic", "SKILL.md"], ["quality-gate", "skill", "quality-gate.md"]]) {
    for (const line of jgatesLines(read(...file))) {
      const tokens = line.split(/\s+/);
      assert.ok(byName.has(tokens[1]), `unknown command in ${file.join("/")}: ${line}`);
      for (const token of tokens.slice(2)) {
        if (token.startsWith("--")) assert.ok(byName.get(tokens[1]).has(token) || GLOBAL_FLAGS.has(token), `${token} in ${line}`);
      }
    }
  }
});

test("every jgates command and flag cited in any skill exists in help --json", () => {
  const doc = helpJson();
  const byName = new Map(doc.commands.map((c) => [c.name, new Set(c.options.map((o) => o.name))]));
  let total = 0;
  for (const file of SKILL_FILES) {
    for (const line of allJgatesLines(read(...file))) {
      total++;
      const tokens = line.split(/\s+/);
      assert.ok(byName.has(tokens[1]), `unknown command in ${file.join("/")}: ${line}`);
      for (const token of tokens.slice(2)) {
        if (!token.startsWith("--")) continue;
        const flag = token.split("=")[0];
        assert.ok(byName.get(tokens[1]).has(flag) || GLOBAL_FLAGS.has(flag), `flag ${flag} is not in help --json for "${tokens[1]}" (${file.join("/")}): ${line}`);
      }
    }
  }
  assert.ok(total >= 20, `expected the skills to cite the jgates commands, found ${total}`);
});

test("every jgates command line cited in any skill is accepted by the CLI parser", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-skill-"));
  const missing = path.join(scratch, "no-such-workspace");
  const env = { ...process.env, JGATES_HOME: path.join(scratch, "home") };
  delete env.JGATES_EXTRA_COMMANDS_DIR;
  try {
    for (const file of SKILL_FILES) {
      for (const line of allJgatesLines(read(...file))) {
        assert.doesNotMatch(line, /(^|\s)(\||;|&&?|>>?|2>|<)(\s|$)|\$\(|\$\{|`/, `keep jgates lines in skills free of shell constructs: ${line}`);
        const tokens = line.split(/\s+/).slice(1);
        if (!PROBED.has(tokens[0])) continue;
        // The workspace becomes a folder that does not exist: the line is parsed in full, then refused with BAD_CWD
        // before anything is read, written, run or downloaded.
        const args = [];
        let hasCwd = false;
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i] === "--cwd") {
            hasCwd = true;
            args.push("--cwd", missing);
            i++;
          } else args.push(tokens[i]);
        }
        if (!hasCwd) args.push("--cwd", missing);
        if (!args.includes("--json")) args.push("--json");
        const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, timeout: 30000 });
        let out;
        try {
          out = JSON.parse(r.stdout);
        } catch {
          assert.fail(`no JSON from "${line}" (${file.join("/")}): ${r.stdout}${r.stderr}`);
        }
        assert.ok(!USAGE_CODES.has(out.code), `${file.join("/")}: "${line}" is rejected by the CLI: ${out.code} ${out.message}`);
        assert.equal(out.code, "BAD_CWD", `${file.join("/")}: "${line}" should stop only at the missing workspace, got ${out.code}`);
      }
    }
    assert.equal(fs.existsSync(missing), false, "probing the skills must not create the workspace");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("the jgates skill covers the commands and options an agent needs in the fix loop", () => {
  const doc = helpJson();
  const text = read("jgates", "skill", "SKILL.md");
  const lines = allJgatesLines(text);
  const cited = new Set(lines.map((l) => l.split(/\s+/)[1]));
  for (const command of ["discover", "doctor", "init", "plan", "run", "history", "report", "baseline", "profiles", "tools"]) {
    assert.ok(cited.has(command), `the skill should cite jgates ${command}`);
  }
  const has = (re, what) => assert.ok(lines.some((l) => re.test(l)), `the skill should show ${what}`);
  has(/^jgates report \S+ .*--agent-context/, "report --agent-context");
  has(/^jgates tools prepare .*--instance/, "tools prepare --instance");
  has(/^jgates tools prepare .*--dry-run/, "tools prepare --dry-run");
  has(/^jgates baseline set /, "baseline set");
  has(/^jgates baseline compare /, "baseline compare");
  has(/^jgates profiles list/, "profiles list");
  has(/^jgates run .*--plan /, "run --plan");
  assert.ok(doc.globalOptions.includes("--locale"), "help --json should list --locale");
  assert.match(text, /`--locale en`/);
  assert.match(text, /JGATES_LOCALE/);
});

// Portuguese words and letters that never appear in the English skills.
const PORTUGUESE = /[\u00e3\u00f5\u00e7\u00c3\u00d5\u00c7]|\b(n[a\u00e3]o|voc[e\u00ea]|tamb[e\u00e9]m|est[a\u00e1]|ent[a\u00e3]o|porque|quando|isso|pelo|pela|arquivo|projeto|agente|regras?|execu[c\u00e7][a\u00e3]o|revis[a\u00e3]o|deve|seguran[c\u00e7]a|qualidade|mudan[c\u00e7]as?|plano|fase|tarefa|aceite)\b/i;
// References to the internal development plan: its files and folders, decision, criteria, phase and task ids, and
// local paths or e-mail addresses.
const PLAN_REFERENCES =
  /docs\/plans|\bPLAN\.md\b|\b\d{2}-[a-z0-9-]+\.md\b|\bADR-?\d|\bAC-?\d|\bR-[A-Z]+-\d|\bDEVIATIONS\b|\bPENDENCIAS\b|\bprototipo\b|\b(phase|fase)[ -]?\d|\bT\d{2}\b|\/home\/|\/Users\/|[A-Za-z]:\\\\Users|[\w.+-]+@[\w-]+\.[\w.]+/i;

test("no skill contains Portuguese text or references to the internal plan", () => {
  for (const file of SKILL_FILES) {
    const text = read(...file);
    text.split(/\r?\n/).forEach((line, i) => {
      assert.doesNotMatch(line, PORTUGUESE, `${file.join("/")}:${i + 1} looks Portuguese: ${line}`);
      assert.doesNotMatch(line, PLAN_REFERENCES, `${file.join("/")}:${i + 1} refers to the internal plan or a local identity: ${line}`);
    });
  }
});
