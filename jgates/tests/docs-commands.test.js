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
const REQUIRED_PAGES = [
  "getting-started",
  "ci",
  "templates-and-profiles",
  "editor",
  "adapters",
  "compatibility",
  "quality-integrations",
  "security",
  "semantic-gate",
  "agents",
  "data-folder",
  "limitations",
  "troubleshooting",
  "services",
  "extension",
  "storage",
];

/**
 * How a page starts, by page name. `init` (the default): the fixture already has the configuration `jgates init` writes.
 * `none`: a clean fixture (the page runs `jgates init` itself). `tools`: init plus an instance `ruff-api` in tools.yml.
 */
const PAGE_SETUP = { "getting-started": "none", editor: "tools", adapters: "tools" };

/**
 * Commands never executed by the test (they serve, download, delete or run the whole gate, or they talk to the container
 * engine); they are still checked statically. The lifecycle commands (setup, status, deps, clean, uninstall) and the tools
 * subcommands that build, download, export or import touch the engine and the machine, so a test never runs them for real.
 */
const ENGINE_TOOLS_SUBCOMMANDS = new Set(["update-data", "prepare-codeql", "export", "import", "build-extension", "test", "add-custom"]);
const NOT_EXECUTED = [
  (t) => t[0] === "ui",
  (t) => t[0] === "run",
  // A Semantic run needs a configured provider and spends model calls: its pages are checked for the command, its flags
  // and its subcommands (the other tests of this file), never executed.
  (t) => t[0] === "semantic" && t[1] === "run",
  (t) => ["setup", "status", "deps", "clean", "uninstall"].includes(t[0]),
  (t) => t[0] === "tools" && t[1] === "prepare" && !t.includes("--dry-run"),
  (t) => t[0] === "tools" && ENGINE_TOOLS_SUBCOMMANDS.has(t[1]) && !(t[1] === "add-custom" && t.includes("--dry-run")),
  (t) => t[0] === "gc" && t.includes("--yes"),
];

/** Commands that have subcommands: the first word after the command is probed, the rest is free. */
/** Flags every command accepts (they are not in the per-command options of help --json). */
const GLOBAL_FLAGS = new Set(["json", "help", "version", "locale"]);

const WITH_SUBCOMMANDS = new Set(["config", "tools", "profiles", "workspaces", "baseline", "history", "deps"]);

const homes = [];
const dirs = [];
test.after(() => {
  for (const d of [...homes, ...dirs]) fs.rmSync(d, { recursive: true, force: true });
});

// In-image mode (tests/setup/in-image.mjs): the repository .venv stands for the sidecar environment of the tools image.
const VENV_PYTHON = [path.join("Scripts", "python.exe"), path.join("bin", "python")].map((p) => path.join(ROOT, ".venv", p)).find((p) => fs.existsSync(p));

function jgates(args, { cwd, home } = {}) {
  const r = spawnSync(process.execPath, [MAIN, ...args], {
    encoding: "utf8",
    cwd,
    timeout: 90000,
    env: { ...process.env, ...(VENV_PYTHON && !process.env.JGATES_PYTHON ? { JGATES_PYTHON: VENV_PYTHON } : {}), JGATES_HOME: home, NO_COLOR: "1" },
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

/** True when `text` appears in a file under jgates/src or jgates/ui/src (portable replacement for `grep -rlF`). */
function isReadInSources(text) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(full)) return true;
      } else if (fs.readFileSync(full, "utf8").includes(text)) return true;
    }
    return false;
  };
  return [path.join(ROOT, "jgates", "src"), path.join(ROOT, "jgates", "ui", "src")].some((dir) => fs.existsSync(dir) && walk(dir));
}

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
      // A subcommand that touches the engine is probed with a folder that does not exist: the command refuses (BAD_CWD)
      // after it has found the subcommand and before it does anything, and an unknown one is refused first.
      const touchesEngine = name === "deps" || (name === "tools" && ENGINE_TOOLS_SUBCOMMANDS.has(sub));
      const r = jgates([...path3.filter(Boolean), "--cwd", touchesEngine ? path.join(dir, "no-such-folder") : dir, "--json"], { home });
      assert.ok(!/UNKNOWN_ACTION|UNKNOWN_SUBCOMMAND/.test(r.out + r.err), `${file}: "${line}" uses a subcommand jgates ${name} does not have`);
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
    // The per-tool image variables of the host-runner era are gone (the tools image comes from release/tools-image.json, or
    // JGATES_TOOLS_IMAGE in development); JGATES_TOOLS_IMAGE_DIGEST is real and is also checked against the sources below.
    assert.ok(!/JGATES_(SEMGREP|GITLEAKS|TRIVY|OSV|CHECKOV|SIDECAR|ZAP|MEGALINTER|QUALITY|SCANNER)[A-Z_]*_IMAGE/.test(text), `${file}: the per-tool JGATES_*_IMAGE variables no longer exist`);
    const fenced = (text.match(/^```[a-z]*\n[\s\S]*?^```/gm) ?? []).join("\n");
    assert.ok(!/npm (publish|i(nstall)? -g jgates)\b/.test(fenced), `${file}: the package is not published`);
    for (const name of new Set(text.match(/\bJGATES_[A-Z_]+\b/g) ?? [])) {
      assert.ok(isReadInSources(name), `${file}: ${name} is not read anywhere in jgates/src`);
    }
    for (const route of new Set(text.match(/#\/[a-z][a-z/-]*/g) ?? [])) {
      const screens = path.join(ROOT, "jgates", "ui", "src", "screens");
      const known = fs.readdirSync(screens).some((d) => {
        const index = path.join(screens, d, "index.tsx");
        // A route written with a parameter (`#/semantic/results/<run>`) ends in "/" here and names a screen whose path
        // goes on with that parameter (`/semantic/results/:id`).
        const wanted = route.endsWith("/") ? `path: "${route.slice(1)}:` : `path: "${route.slice(1)}"`;
        return fs.existsSync(index) && fs.readFileSync(index, "utf8").includes(wanted);
      });
      assert.ok(known, `${file}: the interface has no screen at ${route}`);
    }
  });
}

// ---- Nothing is installed on the host ----
//
// JGates runs every check in the tools image, so no page tells you to install a scanner, a linter, a test runner or a
// language toolchain on your machine. Installing JGates itself (npm), the container engine and the Dockerfile lines of the
// user's own image are the only installs a page may show.

const HOST_INSTALL = [
  /\b(pip3?|pipx|uv tool|uv pip|poetry|conda) (install|add)\b/,
  /\bnpm (install|i|add) (-g|--global)\s+(?!\.\/jgates-)\S*(eslint|prettier|vitest|jest|ruff|semgrep|stryker|typescript|tsc|playwright)/,
  /\b(cargo|go|dotnet tool) install\b/,
  /\b(apt|apt-get|dnf|yum|brew|winget|choco|scoop)\s+install\b(?!.*(docker|moby|podman|rancher))/i,
  /\brustup (toolchain )?(install|add)\b/,
  /\bnvm install\b|\bpyenv install\b/,
];

function fencedShell(markdown) {
  const fence = /^```(bash|sh|shell|powershell|cmd)\s*\n([\s\S]*?)^```/gm;
  const lines = [];
  let match;
  while ((match = fence.exec(markdown))) lines.push(...match[2].split("\n"));
  return lines;
}

test("no page tells you to install a scanner, a linter or a test runner on the host", () => {
  const sources = [
    ...pages.map((f) => ({ name: `docs/jgates/${f}`, text: fs.readFileSync(path.join(DOCS, f), "utf8") })),
    // The README is checked without its Development section: that one builds this repository (its Python test environment).
    { name: "README.md", text: fs.readFileSync(path.join(ROOT, "README.md"), "utf8").replace(/^### (Development|Desenvolvimento)[\s\S]*?(?=^### |^---|(?![\s\S]))/gm, "") },
  ];
  for (const { name, text } of sources) {
    for (const line of fencedShell(text)) for (const pattern of HOST_INSTALL) assert.doesNotMatch(line, pattern, `${name}: a command block tells you to install a tool on the host: ${line}`);
    // Prose: the retired recipes (jgates doctor installing tools) must not come back.
    assert.doesNotMatch(text, /doctor --fix|--include-optional|<JGATES_HOME>\/tools\/python/, `${name}: the host install recipes of jgates doctor no longer exist`);
    assert.doesNotMatch(text, /\(s\)/, `${name}: write natural plurals, never "(s)"`);
  }
});

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
    `${oldProject}|(?<!in)corporat|empresa|company|piloto|pilot\\b|\\bvps\\b|máquina do dono|revisão do dono|code-approval|quality-ci|${retiredQuality}|use-quality-gate|use-semantic-gate|ghcr\\.io\\/rodrigojager`,
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
