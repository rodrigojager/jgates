import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The message catalog has the same keys in Portuguese and in English, for the CLI (src/i18n) and for the UI
// (ui/src, one messages file per screen folder). The CLI picks the language with --locale or JGATES_LOCALE; the JSON
// documents keep ids, codes and enums in both languages and only the human text changes.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const MAIN = path.join(root, "dist", "cli", "main.js");
const CLI_DIR = path.join(root, "src", "i18n");
const UI_SRC = path.join(root, "ui", "src");
const LOCALES = ["pt-BR", "en"];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/**
 * Compares the catalog files of a folder tree: every <name>.pt-BR.json needs its <name>.en.json (and the reverse) with the
 * same keys and the same {placeholders}. Returns the list of problems (empty when the languages agree).
 */
function catalogProblems(dir) {
  const problems = [];
  const files = walk(dir).filter((f) => /\.(pt-BR|en)\.json$/.test(f));
  const pairs = new Map();
  for (const file of files) {
    const match = /^(.*)\.(pt-BR|en)\.json$/.exec(file);
    const entry = pairs.get(match[1]) ?? {};
    entry[match[2]] = file;
    pairs.set(match[1], entry);
  }
  for (const [base, entry] of pairs) {
    const label = path.relative(dir, base);
    if (!entry["pt-BR"] || !entry.en) {
      problems.push(`${label}: exists only in ${entry["pt-BR"] ? "pt-BR" : "en"}`);
      continue;
    }
    const pt = JSON.parse(fs.readFileSync(entry["pt-BR"], "utf8"));
    const en = JSON.parse(fs.readFileSync(entry.en, "utf8"));
    for (const key of Object.keys(pt)) {
      if (!(key in en)) problems.push(`${label}: key ${key} is missing in en`);
      else if (typeof pt[key] !== "string" || typeof en[key] !== "string") problems.push(`${label}: ${key} is not text`);
      else if (placeholders(pt[key]).join() !== placeholders(en[key]).join()) problems.push(`${label}: ${key} has different placeholders`);
    }
    for (const key of Object.keys(en)) if (!(key in pt)) problems.push(`${label}: key ${key} is missing in pt-BR`);
  }
  return problems;
}

function cli(args, env = {}) {
  const run = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...process.env, JGATES_LOCALE: "", ...env }, timeout: 60_000 });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test("the CLI catalog has the same keys and placeholders in pt-BR and in en", () => {
  assert.deepEqual(catalogProblems(CLI_DIR), []);
  const areas = fs.readdirSync(CLI_DIR).filter((f) => f.endsWith(".pt-BR.json"));
  assert.ok(areas.length >= 40, `expected the whole catalog, found ${areas.length} areas`);
});

test("the UI catalog (every screen folder, the components and the application) has the same keys in pt-BR and in en", () => {
  assert.deepEqual(catalogProblems(UI_SRC), []);
  const files = walk(UI_SRC).filter((f) => f.endsWith(".pt-BR.json"));
  assert.ok(files.length >= 30, `expected the whole UI catalog, found ${files.length} files`);
});

test("the catalog test fails when a key exists in one language and not in the other", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-i18n-"));
  try {
    fs.writeFileSync(path.join(dir, "demo.pt-BR.json"), JSON.stringify({ a: "um {name}", b: "dois" }));
    fs.writeFileSync(path.join(dir, "demo.en.json"), JSON.stringify({ a: "one {name}" }));
    fs.writeFileSync(path.join(dir, "lonely.pt-BR.json"), JSON.stringify({ a: "so" }));
    const problems = catalogProblems(dir);
    assert.ok(problems.some((p) => p.includes("key b is missing in en")), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes("lonely") && p.includes("only in pt-BR")), problems.join("\n"));
    fs.writeFileSync(path.join(dir, "demo.en.json"), JSON.stringify({ a: "one {other}", b: "two", c: "extra" }));
    const later = catalogProblems(dir);
    assert.ok(later.some((p) => p.includes("key c is missing in pt-BR")), later.join("\n"));
    assert.ok(later.some((p) => p.includes("different placeholders")), later.join("\n"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no catalog text has an emoji or decorative pictogram in either language", () => {
  const pictograph = /[\p{Extended_Pictographic}\u{FE0F}\u{20E3}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
  for (const dir of [CLI_DIR, UI_SRC]) {
    for (const file of walk(dir).filter((f) => /\.(pt-BR|en)\.json$/.test(f))) {
      for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) {
        assert.ok(!pictograph.test(value), `${path.relative(root, file)} ${key} has a pictogram`);
      }
    }
  }
});

test("jgates help --locale en shows the help in English and the default stays Portuguese", () => {
  const en = cli(["help", "--locale", "en"]);
  assert.equal(en.status, 0);
  assert.match(en.stdout, /Usage: jgates <command> \[options\]/);
  assert.match(en.stdout, /Commands:/);
  const pt = cli(["help"]);
  assert.match(pt.stdout, /Uso: jgates <comando> \[opções\]/);
  const viaEnv = cli(["help"], { JGATES_LOCALE: "en" });
  assert.match(viaEnv.stdout, /Usage: jgates/);
  // --locale wins over the environment variable.
  const flagWins = cli(["help", "--locale", "pt-BR"], { JGATES_LOCALE: "en" });
  assert.match(flagWins.stdout, /Uso: jgates/);
  const equals = cli(["help", "--locale=en"]);
  assert.match(equals.stdout, /Usage: jgates/);
});

test("jgates help --json is the same in both languages except the human text fields", () => {
  const strip = (doc) => ({
    ...doc,
    commands: doc.commands.map((c) => ({ ...c, description: "<text>", options: c.options.map((o) => ({ ...o, description: "<text>" })) })),
  });
  const pt = JSON.parse(cli(["help", "--json", "--locale", "pt-BR"]).stdout);
  const en = JSON.parse(cli(["help", "--json", "--locale", "en"]).stdout);
  assert.deepEqual(strip(en), strip(pt));
  assert.deepEqual(en.commands.map((c) => c.name), pt.commands.map((c) => c.name));
  assert.ok(en.globalOptions.includes("--locale"));
  // The human text really changed.
  const withText = (doc) => doc.commands.map((c) => c.description).join("|");
  assert.notEqual(withText(en), withText(pt));
  assert.ok(en.commands.every((c) => c.description.length > 0 && !/^[a-z_]+_description$/.test(c.description)), "a command description is a raw key in en");
});

test("error.code of a usage error is the same in both languages and only the text changes", () => {
  const cases = [["nope"], ["help", "--nope-flag"], ["help", "--locale"], ["config", "nope"]];
  for (const args of cases) {
    const pt = cli([...args, "--json", "--locale", "pt-BR"]);
    const en = cli([...args, "--json", "--locale", "en"]);
    assert.equal(en.status, pt.status, args.join(" "));
    const ptDoc = JSON.parse(pt.stdout);
    const enDoc = JSON.parse(en.stdout);
    assert.equal(enDoc.status, "ERROR");
    assert.equal(enDoc.error.code, ptDoc.error.code, args.join(" "));
    assert.equal(enDoc.code, ptDoc.code);
    assert.equal(enDoc.exitCode, ptDoc.exitCode);
    if (args[0] === "nope") {
      assert.equal(enDoc.error.code, "UNKNOWN_COMMAND");
      assert.match(enDoc.error.message, /Unknown command/);
      assert.match(ptDoc.error.message, /Comando desconhecido/);
    }
  }
});

test("an unsupported --locale is a usage error with a stable code", () => {
  const run = cli(["help", "--json", "--locale", "fr"]);
  assert.equal(run.status, 3);
  const doc = JSON.parse(run.stdout);
  assert.equal(doc.error.code, "BAD_LOCALE");
  // A bad value in the environment variable is ignored: the default language stays.
  const env = cli(["help"], { JGATES_LOCALE: "fr" });
  assert.equal(env.status, 0);
  assert.match(env.stdout, /Uso: jgates/);
});

test("a command module translates through the chosen language (its own catalog area)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-i18n-cmd-"));
  try {
    const en = cli(["config", "validate", "--cwd", dir, "--json", "--locale", "en"]);
    const pt = cli(["config", "validate", "--cwd", dir, "--json", "--locale", "pt-BR"]);
    assert.equal(en.status, pt.status);
    const enDoc = JSON.parse(en.stdout);
    const ptDoc = JSON.parse(pt.stdout);
    assert.deepEqual(
      (enDoc.diagnostics ?? []).map((d) => d.code),
      (ptDoc.diagnostics ?? []).map((d) => d.code),
    );
    const enText = JSON.stringify(enDoc);
    const ptText = JSON.stringify(ptDoc);
    assert.notEqual(enText, ptText, "the human text should change with the language");
    assert.match(enText, /does not exist|not exist/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("both locales are listed for every CLI area through listAreas", async () => {
  const mod = await import(path.join(root, "dist", "i18n", "index.js"));
  for (const locale of LOCALES) assert.ok(mod.listAreas(locale).length >= 40);
  assert.deepEqual(mod.listAreas("en"), mod.listAreas("pt-BR"));
  assert.equal(mod.normalizeLocale("en-US"), "en");
  assert.equal(mod.normalizeLocale("pt_BR"), "pt-BR");
  assert.equal(mod.normalizeLocale("fr"), null);
  assert.equal(mod.translator("cli", "en")("help_usage"), "Usage: jgates <command> [options]");
  assert.equal(mod.translator("cli", "pt-BR")("help_usage"), "Uso: jgates <comando> [opções]");
});

