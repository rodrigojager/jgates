import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

// V2-73 (PLAN-consistency.md sections 1 and 2): one vocabulary in both languages. The test walks the catalogues of the
// UI, of the core and of the server and fails on a message key missing in one language, on a user-facing string
// hardcoded in a route, on a parenthesized plural, and on built-in profile, template, category, capability and adapter
// names or descriptions that do not resolve through the catalogues in both languages. The scans are functions of a
// folder, so the test also proves each one fails by running it over a temp copy with a planted offender.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const JGATES = path.join(root, "jgates");
const CORE_DIR = path.join(JGATES, "src", "i18n");
const UI_DIR = path.join(JGATES, "ui", "src");
const ROUTES_DIR = path.join(JGATES, "src", "server", "routes");
const DIST = path.join(JGATES, "dist");
const load = (rel) => import(pathToFileURL(path.join(DIST, rel)).href);

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

/** Every "<file>: <what>" line of a folder whose two language files do not hold the same keys (or lack a sibling). */
function parityProblems(dir) {
  const bad = [];
  for (const file of messageFiles(dir).filter((f) => f.endsWith(".en.json"))) {
    const sibling = file.replace(/\.en\.json$/, ".pt-BR.json");
    if (!fs.existsSync(sibling)) {
      bad.push(`${path.relative(root, file)}: no pt-BR file`);
      continue;
    }
    const en = JSON.parse(fs.readFileSync(file, "utf8"));
    const pt = JSON.parse(fs.readFileSync(sibling, "utf8"));
    for (const key of Object.keys(en)) if (!(key in pt)) bad.push(`${path.relative(root, sibling)}: missing ${key}`);
    for (const key of Object.keys(pt)) if (!(key in en)) bad.push(`${path.relative(root, file)}: missing ${key}`);
    for (const key of Object.keys(en)) {
      if (key in pt && typeof en[key] === "string" && typeof pt[key] === "string") {
        const params = (text) => [...text.matchAll(/\{(\w+)(?:,|\})/g)].map((m) => m[1]).sort().join(",");
        if (params(en[key]) !== params(pt[key])) bad.push(`${path.relative(root, sibling)}: ${key} does not use the placeholders of the English text`);
      }
    }
  }
  for (const file of messageFiles(dir).filter((f) => f.endsWith(".pt-BR.json"))) {
    if (!fs.existsSync(file.replace(/\.pt-BR\.json$/, ".en.json"))) bad.push(`${path.relative(root, file)}: no en file`);
  }
  return bad;
}

const PARENTHESIZED_PLURAL = /\p{L}\(\p{L}{1,5}\)/u;
function pluralProblems(dirs) {
  const bad = [];
  for (const dir of dirs) {
    for (const file of messageFiles(dir)) {
      for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) {
        if (typeof value === "string" && PARENTHESIZED_PLURAL.test(value)) bad.push(`${path.relative(root, file)} ${key}: ${value}`);
      }
    }
  }
  return bad;
}

// A message of a route handler comes from a catalogue. A literal that carries Portuguese letters, or an Error class whose
// message is a literal, is a string of the user's language written in code.
const PORTUGUESE_LITERAL = /(["'`])(?:(?!\1)[^\\\n]|\\.)*[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ](?:(?!\1)[^\\\n]|\\.)*\1/;
const ERROR_WITH_LITERAL = /new\s+(?:HttpError|ProfileError|DraftError)\s*\(\s*(?:[^,()]+,\s*){2}(["'`])/;
function hardcodedStrings(dir) {
  const bad = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".ts")).sort()) {
    const lines = fs.readFileSync(path.join(dir, name), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "").replace(/^\s*\/\*.*$/, "");
      if (PORTUGUESE_LITERAL.test(code) || ERROR_WITH_LITERAL.test(code)) bad.push(`${name}:${index + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  return bad;
}

test("V2-73 every message file of the UI, the core and the server has the same keys and placeholders in both languages", () => {
  const files = [...messageFiles(CORE_DIR), ...messageFiles(UI_DIR)];
  assert.ok(files.length >= 200, `expected the whole catalogue, found ${files.length} files`);
  assert.ok(files.some((f) => f.endsWith("server.en.json")) && files.some((f) => f.endsWith("ui.pt-BR.json")));
  assert.deepEqual([...parityProblems(CORE_DIR), ...parityProblems(UI_DIR)], []);
});

test("V2-73 the parity scan fails on a key missing in one language", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-v2-73-"));
  try {
    fs.copyFileSync(path.join(CORE_DIR, "server.en.json"), path.join(dir, "server.en.json"));
    fs.copyFileSync(path.join(CORE_DIR, "server.pt-BR.json"), path.join(dir, "server.pt-BR.json"));
    assert.deepEqual(parityProblems(dir), []);
    const target = path.join(dir, "server.pt-BR.json");
    const pt = JSON.parse(fs.readFileSync(target, "utf8"));
    delete pt.route_file_missing;
    fs.writeFileSync(target, JSON.stringify(pt));
    const found = parityProblems(dir);
    assert.equal(found.length, 1, found.join("\n"));
    assert.match(found[0], /missing route_file_missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("V2-73 no route under jgates/src/server/routes writes a user-facing string in code", () => {
  const files = fs.readdirSync(ROUTES_DIR).filter((n) => n.endsWith(".ts"));
  assert.ok(files.length >= 30, `expected the routes, found ${files.length}`);
  assert.deepEqual(hardcodedStrings(ROUTES_DIR), []);
});

test("V2-73 the route scan fails on a planted Portuguese or English message", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-v2-73-"));
  try {
    const target = path.join(dir, "planted.ts");
    fs.writeFileSync(target, 'export const ok = () => { throw refuseMsg(404, "FILE_MISSING", "route_file_missing", { file }); };\n// "não existe" in a comment is not a message\n');
    assert.deepEqual(hardcodedStrings(dir), []);
    fs.writeFileSync(target, 'export const a = () => { throw new HttpError(404, "FILE_MISSING", `O arquivo ${file} não existe.`); };\n');
    assert.equal(hardcodedStrings(dir).length, 1);
    fs.writeFileSync(target, 'export const b = () => { throw new HttpError(404, "FILE_MISSING", "The file is missing."); };\n');
    assert.equal(hardcodedStrings(dir).length, 1);
    fs.writeFileSync(target, 'export const c = () => ({ problem: "Arquivo não encontrado." });\n');
    assert.equal(hardcodedStrings(dir).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("V2-73 no message of the core, the server or the UI has a parenthesized plural, and the scan fails on a planted one", () => {
  assert.deepEqual(pluralProblems([CORE_DIR, UI_DIR]), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-v2-73-"));
  try {
    fs.writeFileSync(path.join(dir, "x.pt-BR.json"), JSON.stringify({ planted: "{count} validação(ões)" }));
    assert.equal(pluralProblems([dir]).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("V2-73 the built-in profiles, templates, categories, capabilities and adapters resolve through the catalogues in both languages", async () => {
  const { listBuiltinTemplates, listBuiltinProfiles, builtinProfileBody } = await load("builtin/index.js");
  const { builtinTemplateText, createCoreCatalog, localizedAdapterName } = await load("core/catalog/index.js");
  const { starterProfileText } = await load("core/profiles/index.js");
  const { builtinManifests } = await load("adapters/manifests.js");
  const { setLocale, getLocale } = await load("i18n/index.js");
  const texts = {};
  const previous = getLocale();
  try {
    for (const locale of ["pt-BR", "en"]) {
      setLocale(locale);
      texts[locale] = {
        templates: Object.fromEntries(listBuiltinTemplates().map((t) => [t.id, builtinTemplateText(t.ref, t.value)])),
        profiles: Object.fromEntries(listBuiltinProfiles().map((p) => [p.id, starterProfileText(p.id, builtinProfileBody(p))])),
        catalog: createCoreCatalog(),
        adapters: Object.fromEntries(builtinManifests().map((m) => [m.id, localizedAdapterName(m.id, m.displayName)])),
      };
    }
  } finally {
    setLocale(previous);
  }
  const catalogKeys = (locale) => Object.keys(JSON.parse(fs.readFileSync(path.join(CORE_DIR, `catalog.${locale}.json`), "utf8")));
  const ptKeys = new Set(catalogKeys("pt-BR"));
  const enKeys = new Set(catalogKeys("en"));
  const missing = [];
  for (const t of listBuiltinTemplates()) {
    for (const part of ["label", "description"]) for (const keys of [ptKeys, enKeys]) if (!keys.has(`template_${t.id}_${part}`)) missing.push(`template_${t.id}_${part}`);
  }
  for (const m of builtinManifests()) for (const keys of [ptKeys, enKeys]) if (!keys.has(`adapter_${m.id}_name`)) missing.push(`adapter_${m.id}_name`);
  for (const category of texts.en.catalog.toDocument().categories) for (const part of ["label", "description"]) for (const keys of [ptKeys, enKeys]) if (!keys.has(`category_${category.id}_${part}`)) missing.push(`category_${category.id}_${part}`);
  for (const capability of texts.en.catalog.toDocument().capabilities) {
    if (capability.id.startsWith("x-custom:")) continue;
    for (const part of ["label", "description"]) for (const keys of [ptKeys, enKeys]) if (!keys.has(`capability_${capability.id}_${part}`)) missing.push(`capability_${capability.id}_${part}`);
  }
  assert.deepEqual([...new Set(missing)], [], "built-in names and descriptions missing from a catalogue");
  for (const id of Object.keys(texts.en.templates)) {
    assert.notEqual(texts["pt-BR"].templates[id].description, texts.en.templates[id].description, `template ${id}: the pt-BR description is the English one`);
  }
  for (const locale of ["pt-BR", "en"]) {
    const json = JSON.parse(fs.readFileSync(path.join(CORE_DIR, `catalog.${locale}.json`), "utf8"));
    for (const category of texts[locale].catalog.toDocument().categories) assert.equal(category.label, json[`category_${category.id}_label`], `${locale} category ${category.id}`);
    for (const [id, name] of Object.entries(texts[locale].adapters)) assert.equal(name, json[`adapter_${id}_name`], `${locale} adapter ${id}`);
  }
  // The two profile names the wizard and the rest of the UI share.
  assert.equal(texts["pt-BR"].profiles.minimal.label, "Essencial");
  assert.equal(texts.en.profiles.minimal.label, "Essential");
  for (const locale of ["pt-BR", "en"]) {
    for (const p of Object.values(texts[locale].profiles)) assert.ok(p.label && p.description);
  }
});

test("V2-73 every description of the configuration schemas has its help text in both languages", async () => {
  const { schemaHelp } = await load("core/forms/derived/schemas.js");
  const { setLocale, getLocale } = await load("i18n/index.js");
  const descriptions = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      if (typeof node.description === "string") descriptions.add(node.description);
      Object.values(node).forEach(walk);
    }
  };
  const dir = path.join(JGATES, "schemas", "config");
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) walk(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
  assert.ok(descriptions.size >= 100, `expected the schema descriptions, found ${descriptions.size}`);
  const previous = getLocale();
  try {
    setLocale("pt-BR");
    const untranslated = [...descriptions].filter((d) => schemaHelp(d) === d);
    assert.deepEqual(untranslated.map((d) => d.slice(0, 70)), [], "descriptions without a pt-BR help text (schema-help catalogue)");
    setLocale("en");
    assert.deepEqual([...descriptions].filter((d) => schemaHelp(d) !== d).map((d) => d.slice(0, 70)), [], "descriptions whose English help differs from the schema");
  } finally {
    setLocale(previous);
  }
});