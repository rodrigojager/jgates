"use strict";

// Every help link of the product resolves, in both languages.
//
// Three places point at the documentation:
//   1. the interface and the server name documentation pages by their path (`docs/jgates/<page>.<locale>.md`, with an
//      optional #anchor): the About screen, the key store, the Semantic card, the services and storage screens...;
//   2. the reasons catalogue (jgates/src/core/reasons) gives every reason code one action: a command, an official page, or a
//      screen of the interface. A route must be a real screen, and the code must be explained in the troubleshooting page
//      of both languages;
//   3. the pages link to one another and to the README: each relative link must reach an existing file, and each #anchor an
//      existing heading, in the language of the page.
// Nothing here lists the pages: a new page in docs/jgates is checked as soon as it exists.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DOCS = path.join(ROOT, "docs", "jgates");
const LOCALES = ["pt-BR", "en"];

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

function walk(dir, accept, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, accept, out);
    else if (accept(entry.name)) out.push(full);
  }
  return out;
}

/** The GitHub anchor of a heading: markup removed, lowercase, punctuation dropped (letters and digits of any alphabet kept), spaces to hyphens. */
function slug(heading) {
  const plain = heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim()
    .toLowerCase();
  return plain.replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
}

/** The anchors of a markdown file (headings outside fenced blocks; a repeated heading gets -1, -2...). */
function anchorsOf(markdown) {
  const seen = new Map();
  const anchors = new Set();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = slug(match[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

const anchorCache = new Map();
function anchorsOfFile(file) {
  if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(fs.readFileSync(file, "utf8")));
  return anchorCache.get(file);
}

/** The relative links of a markdown text, outside code: `[text](target)`; external links are left out. */
function relativeLinks(markdown) {
  const withoutCode = markdown.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
  const links = [];
  for (const m of withoutCode.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    links.push(target);
  }
  return links;
}

const pages = fs
  .readdirSync(DOCS)
  .filter((f) => /\.(pt-BR|en)\.md$/.test(f))
  .sort();
const pageNames = [...new Set(pages.map((f) => f.replace(/\.(pt-BR|en)\.md$/, "")))];

test("every documentation page exists in both languages", () => {
  for (const name of pageNames) for (const locale of LOCALES) assert.ok(pages.includes(`${name}.${locale}.md`), `docs/jgates/${name}.${locale}.md is missing`);
});

test("the pages the product needs exist (the container-first release)", () => {
  for (const name of ["getting-started", "troubleshooting", "data-folder", "adapters", "compatibility", "quality-integrations", "limitations", "security", "ci", "services", "extension", "storage"]) {
    assert.ok(pageNames.includes(name), `docs/jgates/${name}.*.md is missing`);
  }
});

test("every documentation path the interface and the server name resolves, with its anchor, in both languages", () => {
  const sources = [
    ...walk(path.join(ROOT, "jgates", "ui", "src"), (n) => /\.(tsx?|json)$/.test(n)),
    ...walk(path.join(ROOT, "jgates", "src"), (n) => /\.(ts|json)$/.test(n)),
  ];
  const found = new Map();
  for (const file of sources) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/docs\/jgates\/([A-Za-z0-9-]+)\.(pt-BR|en)\.md(#[\p{L}\p{N}-]+)?/gu)) {
      found.set(m[0], { file: path.relative(ROOT, file), page: m[1], locale: m[2], anchor: m[3] ? m[3].slice(1) : null });
    }
  }
  assert.ok(found.size >= 4, "the interface should point at least at the About, key store and Semantic pages");
  for (const [reference, { file, page, locale, anchor }] of found) {
    const target = path.join(DOCS, `${page}.${locale}.md`);
    assert.ok(fs.existsSync(target), `${file} points at ${reference}, which does not exist`);
    if (anchor) assert.ok(anchorsOfFile(target).has(anchor), `${file} points at ${reference}, which has no such heading`);
    const other = LOCALES.find((l) => l !== locale);
    assert.ok(fs.existsSync(path.join(DOCS, `${page}.${other}.md`)), `${reference} is documented in ${locale} only`);
  }
});

test("the About screen names the pages a new person needs", () => {
  const about = read("jgates", "ui", "src", "screens", "about", "index.tsx");
  for (const m of about.matchAll(/file: "(docs\/jgates\/[^"]+)"/g)) assert.ok(fs.existsSync(path.join(ROOT, m[1])), `the About screen points at ${m[1]}, which does not exist`);
});

// ---- The reasons catalogue ----

const reasonsSource = read("jgates", "src", "core", "reasons", "index.ts");
const reasons = [...reasonsSource.matchAll(/^\s*([A-Z][A-Z_]+): entry\("([A-Z][A-Z_]+)",\s*(\{[^}]*\})\)/gm)].map((m) => ({ key: m[1], code: m[2], action: m[3] }));

test("the reasons catalogue is read as it is written", () => {
  assert.ok(reasons.length >= 20, `expected the whole catalogue, read ${reasons.length} reasons`);
  for (const { key, code } of reasons) assert.equal(key, code, `the reason ${key} is registered under another code`);
});

test("every reason has its text and its action label in both languages", () => {
  for (const locale of LOCALES) {
    const messages = JSON.parse(read("jgates", "src", "i18n", `reasons.${locale}.json`));
    for (const { code } of reasons) {
      assert.ok(typeof messages[`reason_${code}`] === "string" && messages[`reason_${code}`].length > 0, `reasons.${locale}.json has no text for ${code}`);
      assert.ok(typeof messages[`reason_${code}_action`] === "string" && messages[`reason_${code}_action`].length > 0, `reasons.${locale}.json has no action label for ${code}`);
    }
  }
});

test("the screen a reason points at exists", () => {
  const routes = new Set();
  for (const file of walk(path.join(ROOT, "jgates", "ui", "src", "screens"), (n) => n === "index.tsx")) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/path: "([^"]+)"/g)) routes.add(m[1].replace(/^\//, ""));
  }
  let checked = 0;
  for (const { code, action } of reasons) {
    const route = /route: "([^"]+)"/.exec(action)?.[1];
    if (!route) continue;
    checked += 1;
    assert.ok(routes.has(route), `${code} points at the screen #/${route}, which the interface does not have`);
  }
  assert.ok(checked >= 3, "the catalogue should point at screens of the interface");
});

test("the commands a reason points at are real commands of jgates", () => {
  const help = JSON.parse(require("node:child_process").spawnSync(process.execPath, [path.join(ROOT, "jgates", "dist", "cli", "main.js"), "help", "--json"], { encoding: "utf8" }).stdout);
  const commands = new Set(help.commands.map((c) => c.name));
  let checked = 0;
  for (const { code, action } of reasons) {
    const command = /command: "([^"]+)"/.exec(action)?.[1];
    if (!command) continue;
    checked += 1;
    const words = command.split(/\s+/);
    assert.equal(words[0], "jgates", `${code}: the action ${command} is not a jgates command`);
    assert.ok(commands.has(words[1]), `${code}: the action "${command}" names a command jgates does not have`);
  }
  assert.ok(checked >= 5, "the catalogue should point at commands");
});

test("the official pages a reason links to are https addresses", () => {
  for (const { code, action } of reasons) {
    const url = /url: ([A-Z_]+)/.exec(action)?.[1];
    if (!url) continue;
    const value = new RegExp(`const ${url} = "([^"]+)"`).exec(reasonsSource)?.[1];
    assert.ok(value && /^https:\/\/[^\s]+$/.test(value), `${code}: ${url} is not an https address`);
  }
});

test("every reason code is explained in the troubleshooting page, in both languages", () => {
  for (const locale of LOCALES) {
    const text = read("docs", "jgates", `troubleshooting.${locale}.md`);
    for (const { code } of reasons) assert.ok(text.includes(`\`${code}\``), `docs/jgates/troubleshooting.${locale}.md does not explain ${code}`);
  }
});

// ---- The links between pages ----

function checkLinks(label, file, markdown, locale) {
  for (const target of relativeLinks(markdown)) {
    const [rawPath, anchor] = target.split("#");
    const resolved = rawPath === "" ? file : path.resolve(path.dirname(file), rawPath);
    assert.ok(fs.existsSync(resolved), `${label} links to ${target}, which does not exist`);
    if (/\.(pt-BR|en)\.md$/.test(resolved) && locale) {
      assert.ok(resolved.endsWith(`.${locale}.md`), `${label} links to ${target}, a page in the other language`);
    }
    if (anchor && resolved.endsWith(".md")) {
      assert.ok(anchorsOfFile(resolved).has(anchor), `${label} links to ${target}, which has no such heading`);
    }
  }
}

for (const name of pages) {
  const locale = name.endsWith(".en.md") ? "en" : "pt-BR";
  test(`docs/jgates/${name}: every link and every anchor resolves`, () => {
    const file = path.join(DOCS, name);
    checkLinks(`docs/jgates/${name}`, file, fs.readFileSync(file, "utf8"), locale);
  });
}

test("README.md: every link and every anchor resolves, in both halves", () => {
  const file = path.join(ROOT, "README.md");
  const readme = fs.readFileSync(file, "utf8");
  const english = readme.indexOf("\n## English");
  const portuguese = readme.indexOf("\n## Português");
  checkLinks("README.md (English)", file, readme.slice(english, portuguese), "en");
  checkLinks("README.md (Português)", file, readme.slice(portuguese), "pt-BR");
});
