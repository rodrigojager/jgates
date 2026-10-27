import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The commands in the product documentation (docs/jgates/*.md) are real.
//
// The test scans every page in docs/jgates, takes the `jgates ...` lines of the fenced ```bash blocks and checks them
// against the product:
//   1. static: the command and every --flag exist in `jgates help --json`, and a subcommand is not rejected as unknown;
//   2. executed: a command without placeholders runs against the main fixture (JGATES_HOME in a temp folder) and exits 0.
// A page is extended by dropping a new docs/jgates/<name>.<locale>.md; nothing here lists the pages except PAGE_SETUP,
// which says how a page starts (see below), and REQUIRED_PAGES, the pages every locale must have.

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");
const DOCS = path.join(ROOT, "docs", "jgates");
const require = createRequire(import.meta.url);
const fixture = require("../../tests/fixtures/jgates/main-fixture.js");

const LOCALES = ["pt-BR", "en"];
const REQUIRED_PAGES = ["primeiros-passos", "ci", "templates-e-perfis", "editor", "adaptadores", "seguranca", "semantic-gate", "agentes", "pasta-de-dados", "limitacoes", "problemas"];

/**
 * How a page starts, by page name. `init` (the default): the fixture already has the configuration `jgates init` writes.
 * `none`: a clean fixture (the page runs `jgates init` itself). `tools`: init plus an instance `ruff-api` in tools.yml.
 */
const PAGE_SETUP = { "primeiros-passos": "none", editor: "tools", adaptadores: "tools" };

/** Commands never executed by the test (they serve, download, delete or run the whole gate); they are still checked statically. */
const NOT_EXECUTED = [
  (t) => t[0] === "ui",
  (t) => t[0] === "run",
  (t) => t[0] === "tools" && t[1] === "prepare" && !t.includes("--dry-run"),
  (t) => t[0] === "gc" && t.includes("--yes"),
];

/** Commands that have subcommands: the first word after the command is probed, the rest is free. */
/** Flags every command accepts (they are not in the per-command options of help --json). */
const GLOBAL_FLAGS = new Set(["json", "help", "version", "locale"]);

const WITH_SUBCOMMANDS = new Set(["config", "tools", "profiles", "workspaces", "baseline", "history"]);

const homes = [];
const dirs = [];
test.after(() => {
  for (const d of [...homes, ...dirs]) fs.rmSync(d, { recursive: true, force: true });
});

function jgates(args, { cwd, home } = {}) {
  const r = spawnSync(process.execPath, [MAIN, ...args], {
    encoding: "utf8",
    cwd,
    timeout: 90000,
    env: { ...process.env, JGATES_HOME: home, NO_COLOR: "1" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Splits a command line like a shell would for the simple cases the pages use (quotes, no expansion). */
export function splitWords(line) {
  const words = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) words.push(current);
      current = "";
      started = false;
    } else current += ch;
  }
  if (started || current) words.push(current);
  return words;
}

/** The `jgates ...` command lines of the ```bash / ```sh blocks of a page (continuations with a trailing backslash joined). */
export function extractCommands(markdown) {
  const commands = [];
  const fence = /^```(bash|sh|shell)\s*\n([\s\S]*?)^```/gm;
  let match;
  while ((match = fence.exec(markdown))) {
    const lines = match[2].replace(/\\\n/g, " ").split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("jgates ")) continue;
      const words = splitWords(line.replace(/\s+#.*$/, ""));
      commands.push({ line, words: words.slice(1) });
    }
  }
  return commands;
}

const pages = fs
  .readdirSync(DOCS)
  .filter((f) => /\.(pt-BR|en)\.md$/.test(f))
  .sort();

const help = JSON.parse(jgates(["help", "--json"], { home: os.tmpdir() }).out);
const OPTIONS = new Map(help.commands.map((c) => [c.name, new Set(c.options.map((o) => o.name.replace(/^--/, "")))]));

const isTemplate = (words) => words.some((w) => /<[^>]+>/.test(w));

function makeProject(kind) {
  const { dir } = fixture.createMainFixture();
  dirs.push(dir);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-docs-home-"));
  homes.push(home);
  if (kind !== "none") {
    const init = jgates(["init", "--cwd", dir, "--no-interactive"], { home });
    assert.equal(init.code, 0, init.err + init.out);
  }
  if (kind === "tools") {
    fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  ruff-api:\n    adapter: ruff\n    component: api\n    runner: container\n    config: api/pyproject.toml\n");
    fs.writeFileSync(path.join(dir, "jgates.yml"), fs.readFileSync(path.join(dir, "jgates.yml"), "utf8").replace("  - .jgates/profiles.yml\n", "  - .jgates/profiles.yml\n  - .jgates/tools.yml\n"));
  }
  return { dir, home };
}

const pageName = (file) => file.replace(/\.(pt-BR|en)\.md$/, "");
const localeOf = (file) => (file.endsWith(".en.md") ? "en" : "pt-BR");

test("every required page exists in both languages", () => {
  for (const name of REQUIRED_PAGES) for (const locale of LOCALES) assert.ok(pages.includes(`${name}.${locale}.md`), `docs/jgates/${name}.${locale}.md is missing`);
});

test("the two languages of a page carry the same commands and the same structure", () => {
  const names = new Set(pages.map(pageName));
  for (const name of names) {
    const pt = fs.readFileSync(path.join(DOCS, `${name}.pt-BR.md`), "utf8");
    const en = fs.readFileSync(path.join(DOCS, `${name}.en.md`), "utf8");
    assert.deepEqual(
      extractCommands(en).map((c) => c.line),
      extractCommands(pt).map((c) => c.line),
      `${name}: the commands differ between pt-BR and en`,
    );
    const headings = (text) => (text.match(/^#{1,3} /gm) ?? []).length;
    assert.equal(headings(en), headings(pt), `${name}: the number of headings differs between pt-BR and en`);
    const blocks = (text) => (text.match(/^```/gm) ?? []).length;
    assert.equal(blocks(en), blocks(pt), `${name}: the number of code blocks differs between pt-BR and en`);
  }
});

for (const file of pages) {
  const text = fs.readFileSync(path.join(DOCS, file), "utf8");
  const commands = extractCommands(text);

  test(`${file}: every documented command and flag exists in help --json`, () => {
    for (const { line, words } of commands) {
      const [name, ...rest] = words;
      assert.ok(OPTIONS.has(name), `${file}: unknown command in "${line}"`);
      for (const word of rest) {
        if (!word.startsWith("--")) continue;
        const flag = word.slice(2).split("=")[0];
        assert.ok(GLOBAL_FLAGS.has(flag) || OPTIONS.get(name).has(flag), `${file}: "${line}" uses --${flag}, which jgates ${name} does not have`);
      }
    }
  });

  test(`${file}: documented subcommands exist`, () => {
    const { dir, home } = makeProject("init");
    const probed = new Set();
    for (const { line, words } of commands) {
      const [name, sub] = words;
      if (!WITH_SUBCOMMANDS.has(name) || !sub || sub.startsWith("--") || probed.has(`${name} ${sub}`)) continue;
      probed.add(`${name} ${sub}`);
      const path3 = name === "tools" && sub === "config" ? [name, sub, words[2] ?? ""] : [name, sub];
      const r = jgates([...path3.filter(Boolean), "--cwd", dir, "--json"], { home });
      assert.ok(!/UNKNOWN_ACTION/.test(r.out + r.err), `${file}: "${line}" uses a subcommand jgates ${name} does not have`);
    }
  });

  test(`${file}: the commands without placeholders run against the main fixture`, () => {
    const executable = commands.filter((c) => !isTemplate(c.words) && !NOT_EXECUTED.some((skip) => skip(c.words)));
    if (executable.length === 0) return;
    const { dir, home } = makeProject(PAGE_SETUP[pageName(file)] ?? "init");
    for (const { line, words } of executable) {
      // Commands that work on the data folder (gc) have no --cwd; the others run against the fixture.
      const args = words.includes("--cwd") || !OPTIONS.get(words[0])?.has("cwd") ? words : [...words, "--cwd", dir];
      const r = jgates(args, { cwd: dir, home });
      assert.equal(r.code, 0, `${file}: "${line}" exited ${r.code}\n${r.err}\n${r.out.slice(0, 600)}`);
    }
  });

  test(`${file}: no removed or invented feature is documented`, () => {
    assert.ok(!/JGATES_[A-Z]*_?IMAGE/.test(text), `${file}: JGATES_*_IMAGE variables no longer exist (the image comes from .jgates/lock.json)`);
    const fenced = (text.match(/^```[a-z]*\n[\s\S]*?^```/gm) ?? []).join("\n");
    assert.ok(!/npm (publish|i(nstall)? -g jgates)\b/.test(fenced), `${file}: the package is not published`);
    for (const name of new Set(text.match(/\bJGATES_[A-Z_]+\b/g) ?? [])) {
      const used = spawnSync("grep", ["-rlF", name, path.join(ROOT, "jgates", "src"), path.join(ROOT, "jgates", "ui", "src")], { encoding: "utf8" });
      assert.ok(used.stdout.trim() !== "", `${file}: ${name} is not read anywhere in jgates/src`);
    }
    for (const route of new Set(text.match(/#\/[a-z][a-z/-]*/g) ?? [])) {
      const screens = path.join(ROOT, "jgates", "ui", "src", "screens");
      const known = fs.readdirSync(screens).some((d) => {
        const index = path.join(screens, d, "index.tsx");
        return fs.existsSync(index) && fs.readFileSync(index, "utf8").includes(`path: "${route.slice(1)}"`);
      });
      assert.ok(known, `${file}: the interface has no screen at ${route}`);
    }
  });
}

// ---- README.md: two halves (English first, then Português) with the same content, and real commands ----

const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const [readmeIntro, readmeRest] = [README.slice(0, README.indexOf("\n## English")), README.slice(README.indexOf("\n## English"))];
const readmeEn = readmeRest.slice(0, readmeRest.indexOf("\n## Português"));
const readmePt = readmeRest.slice(readmeRest.indexOf("\n## Português"));

test("README.md starts with the title and the English paragraph, then the English part, then the Portuguese part", () => {
  const english = README.indexOf("\n## English");
  const portuguese = README.indexOf("\n## Português");
  assert.ok(english > 0 && portuguese > english, "the English part comes before the Portuguese part");
  const intro = readmeIntro.split("\n").filter((line) => line.trim() !== "" && line.trim() !== "---");
  assert.equal(intro[0], "# JGates", "README.md starts with the title");
  assert.equal(intro.length, 2, "the intro holds only the title and one paragraph");
  assert.match(intro[1], /^JGates validates a repository/, "the intro paragraph is the English one");
  assert.match(readmePt, /^\n## Português\n\nO JGates valida um repositório/, "the Portuguese part opens with the translated paragraph");
});

test("README.md has a Portuguese and an English part with the same structure and the same commands", () => {
  assert.ok(readmeIntro.length > 0 && readmePt.length > 0 && readmeEn.length > 0, "README.md needs an intro, an English part and a Português part");
  const headings = (text) => (text.match(/^#{3,4} /gm) ?? []).length;
  assert.equal(headings(readmeEn), headings(readmePt), "the number of sections differs between the Portuguese and the English part");
  const blocks = (text) => (text.match(/^```/gm) ?? []).length;
  assert.equal(blocks(readmeEn), blocks(readmePt), "the number of code blocks differs between the two parts");
  const bullets = (text) => (text.match(/^[-*] /gm) ?? []).length;
  assert.equal(bullets(readmeEn), bullets(readmePt), "the number of list items differs between the two parts");
  const lines = (text) => extractCommands(text).map((c) => c.line);
  assert.deepEqual(lines(readmeEn), lines(readmePt), "the commands differ between the two parts");
  const links = (text) => [...text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1].replace(/\.(pt-BR|en)\.md$/, ".md"));
  assert.deepEqual(links(readmeEn), links(readmePt), "the links differ between the two parts");
});

test("README.md: every jgates command and flag exists in help --json, and every link and cited file exists", () => {
  const commands = extractCommands(README);
  assert.ok(commands.length >= 6, "the README should show the jgates commands");
  for (const { line, words } of commands) {
    const [name, ...rest] = words;
    assert.ok(OPTIONS.has(name), `README.md: unknown command in "${line}"`);
    for (const word of rest) {
      if (!word.startsWith("--")) continue;
      const flag = word.slice(2).split("=")[0];
      assert.ok(GLOBAL_FLAGS.has(flag) || OPTIONS.get(name).has(flag), `README.md: "${line}" uses --${flag}, which jgates ${name} does not have`);
    }
  }
  // Inline `jgates <command> ...` mentions too.
  for (const m of README.matchAll(/`jgates ([a-z]+)((?: --?[a-zA-Z-]+)*)[^`]*`/g)) {
    assert.ok(OPTIONS.has(m[1]), `README.md: unknown command in \`${m[0]}\``);
    for (const flag of m[2].trim().split(/\s+/).filter(Boolean)) assert.ok(GLOBAL_FLAGS.has(flag.slice(2)) || OPTIONS.get(m[1]).has(flag.slice(2)), `README.md: ${flag} is not an option of jgates ${m[1]}`);
  }
  for (const m of README.matchAll(/\]\(([^)#:]+)(?:#[^)]*)?\)/g)) assert.ok(fs.existsSync(path.join(ROOT, m[1])), `README.md links to ${m[1]}, which does not exist`);
  for (const m of README.matchAll(/`((?:docs|examples|jgates|quality-gate|semantic-gate|use-[a-z-]+)\/[A-Za-z0-9_./-]+)`/g)) assert.ok(fs.existsSync(path.join(ROOT, m[1])), `README.md cites ${m[1]}, which does not exist`);
});

test("the documentation carries no company, pilot, hosting or old-name material", () => {
  const files = [
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "quality-gate/README.md",
    "semantic-gate/README.md",
    "jgates/skill/SKILL.md",
    "use-jgates-quality/SKILL.md",
    "use-jgates-semantic/SKILL.md",
    "quality-gate/skill/quality-gate.md",
    ...fs.readdirSync(DOCS).map((f) => `docs/jgates/${f}`),
  ];
  // The retired quality command name and the old project name are spelled in pieces so a repository-wide search for them stays empty.
  const retiredQuality = "quality[-_ ]?" + "check";
  const oldProject = "cyber" + "vinci";
  const banned = new RegExp(
    `${oldProject}|corporat|empresa|company|piloto|pilot\\b|\\bvps\\b|máquina do dono|revisão do dono|code-approval|quality-ci|${retiredQuality}|use-quality-gate|use-semantic-gate|ghcr\\.io\\/rodrigojager`,
    "i"
  );
  for (const file of files) {
    fs.readFileSync(path.join(ROOT, file), "utf8")
      .split("\n")
      .forEach((line, i) => assert.doesNotMatch(line, banned, `${file}:${i + 1} carries material that does not belong in the public documentation: ${line}`));
  }
  assert.ok(!fs.existsSync(path.join(ROOT, "docs", "tutorial-gitlab-quality-gate.en.md")), "the GitLab tutorials were replaced by docs/jgates/ci.*");
  assert.match(fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8"), /Copyright \(c\) 2026 JGates contributors/);
});
