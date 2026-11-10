import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

// V2-58: no message file of the core or of the UI carries a parenthesized plural ("teste(s)", "violação(ões)",
// "incompatível(is)"), in either language, and a summary renders the natural singular and plural text. The scan is a function
// of a folder list, so the test also proves it fails by running it over a temp copy with a planted "teste(s)" string.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE_DIR = path.join(root, "jgates", "src", "i18n");
const UI_DIR = path.join(root, "jgates", "ui", "src");
const DIST_I18N = path.join(root, "jgates", "dist", "i18n", "index.js");

// A letter glued to a short parenthesized word: "teste(s)", "violação(ões)", "o(a)". A parenthesis after a space
// ("(required)", "Ollama (local)") is ordinary text and never matches.
const PARENTHESIZED_PLURAL = /\p{L}\(\p{L}{1,5}\)/u;

function messageFiles(dir) {
  const found = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.(pt-BR|en)\.json$/.test(entry.name)) found.push(full);
    }
  }
  return found.sort();
}

/** Every "<file> <key>: <text>" line of the folders whose message has a parenthesized plural. */
function offenders(dirs) {
  const bad = [];
  for (const dir of dirs) {
    for (const file of messageFiles(dir)) {
      const messages = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const [key, value] of Object.entries(messages)) {
        if (typeof value === "string" && PARENTHESIZED_PLURAL.test(value)) bad.push(`${path.relative(root, file)} ${key}: ${value}`);
      }
    }
  }
  return bad;
}

test("V2-58 every core and UI message file, in both languages, is free of parenthesized plurals", () => {
  const files = [...messageFiles(CORE_DIR), ...messageFiles(UI_DIR)];
  assert.ok(files.some((f) => f.endsWith(".pt-BR.json")) && files.some((f) => f.endsWith(".en.json")), "both languages are scanned");
  assert.ok(files.length >= 100, `expected the whole catalog, found ${files.length} files`);
  assert.deepEqual(offenders([CORE_DIR, UI_DIR]), []);
});

test("V2-58 the scan fails when a planted teste(s) string is added to a copy of the messages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-v2-58-"));
  try {
    for (const file of messageFiles(CORE_DIR)) fs.copyFileSync(file, path.join(dir, path.basename(file)));
    assert.deepEqual(offenders([dir]), [], "the unmodified copy is clean");
    const target = path.join(dir, "vitest.pt-BR.json");
    const messages = JSON.parse(fs.readFileSync(target, "utf8"));
    messages.planted = "{count} teste(s) executado(s)";
    fs.writeFileSync(target, JSON.stringify(messages));
    const found = offenders([dir]);
    assert.equal(found.length, 1, found.join("\n"));
    assert.match(found[0], /planted/);
    for (const planted of ["{n} violação(ões)", "{n} incompatível(is)", "{n} item(ns)", "{n} file(s)", "{n} dependency(ies)"]) {
      assert.ok(PARENTHESIZED_PLURAL.test(planted), planted);
    }
    assert.ok(!PARENTHESIZED_PLURAL.test("Name (optional)") && !PARENTHESIZED_PLURAL.test("Ollama (local)"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("V2-58 a core summary renders the singular for 1 and the plural for 15, in pt-BR and in en", async () => {
  const { translator } = await import(pathToFileURL(DIST_I18N).href);
  const pt = translator("vitest", "pt-BR");
  const en = translator("vitest", "en");
  const params = (n) => ({ version: "3.0.0", executed: n, failed: 0, skipped: 0 });
  assert.match(pt("vitest_reason_tests", params(1)), /1 teste executado,/);
  assert.match(pt("vitest_reason_tests", params(15)), /15 testes executados,/);
  assert.match(en("vitest_reason_tests", params(1)), /1 test run,/);
  assert.match(en("vitest_reason_tests", params(15)), /15 tests run,/);
  // Several counts in one message each take their own form, and a verb agrees with its count.
  const gc = translator("gc", "pt-BR");
  assert.match(gc("gc_text_summary_dry", { count: 1, bytes: 10 }), /^1 run seria apagado /);
  assert.match(gc("gc_text_summary_dry", { count: 3, bytes: 10 }), /^3 runs seriam apagados /);
  assert.match(gc("gc_text_summary_done", { count: 1, workspaces: 2, bytes: 10 }), /1 run e 2 workspaces/);
  // 0 is plural, like 15; a missing count leaves the block as written instead of guessing.
  assert.match(pt("vitest_reason_tests", params(0)), /0 testes executados,/);
  assert.match(pt("vitest_reason_tests", { version: "3.0.0", failed: 0, skipped: 0 }), /\{executed, plural,/);
});
