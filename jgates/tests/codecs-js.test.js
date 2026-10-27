import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const { jsCodec, readJs, patchJsText, checkEdit, dialectForFile, UNRESOLVED_KEY } = await import(path.join(dist, "core", "codecs", "js", "index.js"));
const docs = await import(path.join(dist, "core", "documents", "index.js"));
const { findEslintConfig } = await import(path.join(dist, "adapters", "eslint", "index.js"));
const { findVitestConfig } = await import(path.join(dist, "adapters", "vitest", "index.js"));
const { builtinManifests } = await import(path.join(dist, "adapters", "manifests.js"));
const { validateManifest } = await import(path.join(dist, "core", "catalog", "index.js"));

const CORPUS = path.join(here, "fixtures", "codecs-js");
const corpus = (name) => fs.readFileSync(path.join(CORPUS, name), "utf8");
const TS = { dialect: "typescript" };

function withProject(files, tools, fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jg-js-")));
  try {
    const all = { "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/tools.yml\n", ".jgates/tools.yml": `schemaVersion: 1\n${tools}`, ...files };
    for (const [name, content] of Object.entries(all)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TOOLS = `tools:
  eslint-web:
    adapter: eslint
    config: eslint.config.js
  vitest-web:
    adapter: vitest
    config: vitest.config.ts
`;

function cli(dir, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jg-js-home-"));
  try {
    const r = spawnSync(process.execPath, [MAIN, ...args, "--cwd", dir, "--json"], { encoding: "utf8", env: { ...process.env, JGATES_HOME: home }, timeout: 30000 });
    return { status: r.status, doc: JSON.parse(r.stdout) };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Opening never executes

test("configs that would write a marker open as text through the documents API and the tool area, and the marker never appears", () => {
  const files = { "eslint.config.js": corpus("eslint.config.js"), "vitest.config.ts": corpus("vitest.config.ts") };
  withProject(files, TOOLS, (dir) => {
    const eslintDoc = docs.openDocument(dir, "eslint-web", "config");
    const vitestDoc = docs.openDocument(dir, "vitest-web", "config");
    assert.equal(eslintDoc.text, files["eslint.config.js"]);
    assert.equal(vitestDoc.text, files["vitest.config.ts"]);
    assert.equal(eslintDoc.state, "editable");
    assert.equal(docs.validateDocument(dir, "eslint-web", "config", {}).status, "unavailable");
    const preview = docs.previewEdit(dir, "eslint-web", "config", { text: files["eslint.config.js"] + "// x\n" });
    assert.equal(preview.changed, true);
    // The tool area reads the same documents through the CLI.
    const read = cli(dir, ["tools", "config", "read", "vitest-web", "--file", "config"]);
    assert.equal(read.status, 0);
    // Parsing them (the projection) executes nothing either.
    assert.equal(readJs(files["eslint.config.js"]).ok, true);
    assert.equal(readJs(files["vitest.config.ts"], TS).ok, true);
    assert.equal(fs.existsSync(path.join(dir, "executed.marker")), false);
    assert.equal(fs.existsSync(path.join(CORPUS, "executed.marker")), false);
    assert.deepEqual(fs.readdirSync(dir).sort(), [".jgates", "eslint.config.js", "jgates.yml", "vitest.config.ts"]);
  });
});

test("the codec never loads the file: no marker even when the text is edited and re-read", () => {
  const text = corpus("eslint.config.js");
  patchJsText(text, [{ op: "set", path: [1, "rules", "semi"], value: ["warn", "never"] }]);
  assert.equal(fs.existsSync(path.join(CORPUS, "executed.marker")), false);
  assert.equal(process.env.JGATES_JS_CODEC_EXECUTED, undefined);
});

// ---------------------------------------------------------------------------------------------------------------------
// Reading

test("eslint flat config: the literal parts are projected, the rest is reported as partial", () => {
  const doc = readJs(corpus("eslint.config.js"));
  assert.equal(doc.ok, true);
  assert.equal(doc.partial, true);
  assert.equal(doc.dialect, "javascript");
  const codes = doc.warnings.map((w) => w.code);
  assert.ok(codes.includes("MEMBER"), "js.configs.recommended");
  assert.ok(codes.includes("SPREAD"), "...globals.node");
  assert.ok(codes.includes("REFERENCE"), "strict is a variable");
  assert.deepEqual(doc.value[1].rules.semi, ["error", "always"]);
  assert.equal(doc.value[1].rules.quotes[1], "single");
  assert.equal(doc.value[1].rules["no-console"][UNRESOLVED_KEY], "REFERENCE");
  assert.deepEqual(doc.value[2], { ignores: ["dist/**", "coverage/**"] });
  assert.equal(doc.value[0][UNRESOLVED_KEY], "MEMBER");
  const semi = doc.fields.find((f) => f.path.join(".") === "1.rules.semi");
  assert.equal(semi.kind, "array");
  assert.ok(semi.line > 1 && semi.column > 1);
});

test("vitest config: defineConfig is a known wrapper and satisfies is looked through", () => {
  const doc = readJs(corpus("vitest.config.ts"), TS);
  assert.equal(doc.ok, true);
  assert.equal(doc.partial, false);
  assert.equal(doc.value.test.coverage.thresholds.lines, 80);
  assert.deepEqual(doc.value.test.include, ["src/**/*.test.ts"]);
});

test("module.exports (CJS) and a const object that is exported are read", () => {
  assert.deepEqual(readJs(corpus("eslint.config.cjs")).value[0].rules.eqeqeq, ["error", "always"]);
  const doc = readJs("const cfg = { a: 1 };\nexport default cfg;\n");
  assert.deepEqual(doc.value, { a: 1 });
});

test("a config that is a function with imports and mergeConfig has no projection at all", () => {
  const doc = readJs(corpus("vitest.config.mjs"));
  assert.equal(doc.ok, true);
  assert.equal(doc.partial, true);
  assert.equal(doc.fields.length, 0);
  assert.equal(doc.value[UNRESOLVED_KEY], "FUNCTION");
  const check = checkEdit(corpus("vitest.config.mjs"), { op: "set", path: ["test", "include"], value: [] });
  assert.equal(check.ok, false);
  assert.equal(check.reason, "FUNCTION");
});

test("syntax errors come back as errors, never thrown, and the text is untouched", () => {
  const doc = readJs("export default { a: , };\n");
  assert.equal(doc.ok, false);
  assert.ok(doc.errors.length > 0 && doc.errors[0].line === 1);
  assert.throws(() => patchJsText("export default { a: , };\n", [{ op: "set", path: ["a"], value: 1 }]), (e) => e.code === "PARSE");
});

test("dialect helpers and the Codec interface", () => {
  assert.equal(dialectForFile("vitest.config.ts"), "typescript");
  assert.equal(dialectForFile("eslint.config.mjs"), "javascript");
  assert.equal(jsCodec.id, "js");
  assert.deepEqual([...jsCodec.dialects], ["javascript", "typescript"]);
  assert.throws(() => readJs("x", { dialect: "coffee" }), (e) => e.code === "DIALECT");
  const text = "export default { a: 1 };\n";
  assert.equal(patchJsText(text, []).changed, false);
});

// ---------------------------------------------------------------------------------------------------------------------
// Writing

test("changing one static property alters only it; imports, functions, comments and quotes stay", () => {
  const text = corpus("eslint.config.js");
  const out = patchJsText(text, [{ op: "set", path: [1, "rules", "semi"], value: ["warn", "never"] }]);
  assert.equal(out.changed, true);
  assert.equal(out.text, text.replace('semi: ["error", "always"]', 'semi: ["warn", "never"]'));
  const q = patchJsText(text, [{ op: "set", path: [1, "rules", "quotes", 1], value: "double" }]);
  assert.equal(q.text, text.replace("quotes: ['error', 'single']", "quotes: ['error', 'double']"), "single quotes of the old value are kept");
  const vt = corpus("vitest.config.ts");
  const out2 = patchJsText(vt, [{ op: "set", path: ["test", "coverage", "thresholds", "lines"], value: 90 }], TS);
  assert.equal(out2.text, vt.replace("lines: 80", "lines: 90"));
});

test("adding keys and array items keeps neighbours, comments and trailing commas", () => {
  const text = corpus("eslint.config.js");
  const add = patchJsText(text, [{ op: "set", path: [1, "rules", "eqeqeq"], value: "error" }]);
  assert.match(add.text, /"no-unused-vars": \["warn", \{ argsIgnorePattern: "\^_" \}\],\n      eqeqeq: "error",\n    \},/);
  assert.equal(add.text.replace(/\n      eqeqeq: "error",/, ""), text);
  const ins = patchJsText(text, [{ op: "insert", path: [2, "ignores"], value: "build/**" }]);
  assert.equal(ins.text, text.replace('"coverage/**"]', '"coverage/**", \'build/**\']'.replace("'build/**'", '"build/**"')));
  const first = patchJsText(text, [{ op: "insert", path: [2, "ignores"], value: "x", index: 0 }]);
  assert.match(first.text, /ignores: \["x", "dist\/\*\*"/);
  // A comment on the line of the previous item stays with it.
  const withComment = "export default {\n  a: 1, // first\n  b: 2,\n};\n";
  assert.equal(patchJsText(withComment, [{ op: "set", path: ["c"], value: true }]).text, "export default {\n  a: 1, // first\n  b: 2,\n  c: true,\n};\n");
  const noComma = "export default {\n  a: 1, // first\n  b: 2 // last\n};\n";
  assert.equal(patchJsText(noComma, [{ op: "set", path: ["c"], value: 3 }]).text, "export default {\n  a: 1, // first\n  b: 2, // last\n  c: 3\n};\n");
});

test("new nested parents are created and empty containers filled", () => {
  const out = patchJsText("export default {};\n", [{ op: "set", path: ["test", "coverage", "provider"], value: "v8" }]);
  assert.equal(out.text, "export default { test: { coverage: { provider: \"v8\" } } };\n");
  const arr = patchJsText("export default {\n  files: [],\n};\n", [{ op: "insert", path: ["files"], value: "src/**" }]);
  assert.equal(arr.text, "export default {\n  files: [\"src/**\"],\n};\n");
  const created = patchJsText("export default {\n  a: 1,\n};\n", [{ op: "insert", path: ["files"], value: "x" }]);
  assert.equal(created.text, "export default {\n  a: 1,\n  files: [\"x\"],\n};\n");
});

test("delete removes the member with its comma and line, and is a no-op when the target is missing", () => {
  const text = "export default {\n  a: 1,\n  // keep me\n  b: 2,\n  c: [1, 2, 3],\n};\n";
  assert.equal(patchJsText(text, [{ op: "delete", path: ["b"] }]).text, "export default {\n  a: 1,\n  // keep me\n  c: [1, 2, 3],\n};\n");
  assert.equal(patchJsText(text, [{ op: "delete", path: ["c"] }]).text, "export default {\n  a: 1,\n  // keep me\n  b: 2,\n};\n");
  assert.equal(patchJsText(text, [{ op: "delete", path: ["c", 1] }]).text, text.replace("[1, 2, 3]", "[1, 3]"));
  assert.equal(patchJsText("export default { a: 1, b: 2 };\n", [{ op: "delete", path: ["b"] }]).text, "export default { a: 1 };\n");
  assert.equal(patchJsText("export default { a: 1, b: 2 };\n", [{ op: "delete", path: ["a"] }]).text, "export default { b: 2 };\n");
  const noTrailing = "export default {\n  a: 1,\n  b: 2\n};\n";
  assert.equal(patchJsText(noTrailing, [{ op: "delete", path: ["b"] }]).text, "export default {\n  a: 1\n};\n");
  const missing = patchJsText(text, [{ op: "delete", path: ["zzz"] }]);
  assert.equal(missing.changed, false);
  assert.equal(missing.text, text);
});

test("CRLF, BOM and TypeScript wrappers are preserved", () => {
  const crlf = "\ufeffimport x from \"x\";\r\nexport default defineConfig({\r\n  a: 1,\r\n  b: { c: 2 },\r\n} as const);\r\n";
  const out = patchJsText(crlf, [{ op: "set", path: ["b", "d"], value: 3 }, { op: "set", path: ["a"], value: 5 }], TS);
  assert.equal(out.text, "\ufeffimport x from \"x\";\r\nexport default defineConfig({\r\n  a: 5,\r\n  b: { c: 2, d: 3 },\r\n} as const);\r\n");
  assert.ok(!/(?<!\r)\n/.test(out.text));
});

test("every patch is verified: the re-read value equals the expected one (key order and quoting aside)", () => {
  const text = corpus("eslint.config.cjs");
  const out = patchJsText(text, [
    { op: "set", path: [0, "rules", "no-undef"], value: "off" },
    { op: "set", path: [0, "files"], value: ["a", "b"] },
    { op: "delete", path: [0, "rules", "eqeqeq"] },
  ]);
  const doc = readJs(out.text);
  assert.deepEqual(doc.value, [{ files: ["a", "b"], rules: { "no-undef": "off" } }]);
  assert.ok(out.text.startsWith("/* CommonJS flat config: a plain literal, fully projectable. */\nmodule.exports"));
});

// ---------------------------------------------------------------------------------------------------------------------
// Ambiguity is refused with the reason; the text editor keeps working

test("a spread in the path refuses the visual edit with the reason and leaves the text alone", () => {
  const text = "export default {\n  ...base,\n  rules: { semi: \"error\" },\n};\n";
  const check = checkEdit(text, { op: "set", path: ["rules", "semi"], value: "off" });
  assert.equal(check.ok, false);
  assert.equal(check.reason, "SPREAD");
  assert.match(check.message, /spread/);
  assert.equal(check.line, 2);
  assert.throws(
    () => patchJsText(text, [{ op: "set", path: ["rules", "semi"], value: "off" }]),
    (e) => e.code === "UNSUPPORTED" && e.details.reason === "SPREAD" && /Use a edição de texto/.test(e.message),
  );
  // Appending to a config array that holds a spread stays unambiguous; changing an item behind the spread does not.
  const arr = "export default [\n  ...configs,\n  { rules: { semi: 1 } },\n];\n";
  assert.equal(checkEdit(arr, { op: "set", path: [1, "rules", "semi"], value: 2 }).reason, "SPREAD");
  assert.equal(checkEdit(arr, { op: "insert", path: [], value: { x: 1 } }).ok, false, "root array is not an addressable key");
  // The textual editor is untouched by all of this: the document API saves any text.
  withProject({ "eslint.config.js": arr }, "tools:\n  e:\n    adapter: eslint\n    config: eslint.config.js\n", (dir) => {
    const doc = docs.openDocument(dir, "e", "config");
    const saved = docs.saveDocument(dir, "e", "config", { expectedRevision: doc.revision, text: arr.replace("semi: 1", "semi: 2") });
    assert.equal(saved.status, "saved");
    assert.match(fs.readFileSync(path.join(dir, "eslint.config.js"), "utf8"), /semi: 2/);
  });
});

test("functions, calls, references, env and conditionals in the path are refused with their own reason", () => {
  const cases = [
    ["export default { a: () => ({ b: 1 }) };\n", ["a", "b"], "FUNCTION"],
    ["export default { a: make({ b: 1 }) };\n", ["a", "b"], "CALL"],
    ["export default { a: shared };\n", ["a", "b"], "REFERENCE"],
    ["import shared from \"./s.js\";\nexport default { a: shared };\n", ["a", "b"], "IMPORT"],
    ["export default { a: process.env.CI };\n", ["a", "b"], "ENV"],
    ["export default { a: CI ? { b: 1 } : {} };\n", ["a", "b"], "CONDITIONAL"],
    ["export default { a() { return 1; } };\n", ["a", "b"], "FUNCTION"],
    ["const k = \"a\";\nexport default { [k]: 1, b: 2 };\n", ["b"], "COMPUTED_KEY"],
    ["export default { a: shared };\n", ["a"], "NOT_STATIC"],
  ];
  for (const [text, p, reason] of cases) {
    const check = checkEdit(text, { op: "set", path: p, value: 1 });
    assert.equal(check.ok, false, text);
    assert.equal(check.reason, reason, text);
    assert.throws(() => patchJsText(text, [{ op: "set", path: p, value: 1 }]), (e) => e.code === "UNSUPPORTED" && e.details.reason === reason);
  }
  // Deleting a value that holds code is refused as well: it would lose the function.
  assert.equal(checkEdit("export default { a: () => 1, b: 2 };\n", { op: "delete", path: ["a"] }).reason, "NOT_STATIC");
  // But editing a sibling of a function in an object without spread is fine, and the function stays byte for byte.
  const sibling = "export default {\n  a: () => 1,\n  b: 2,\n};\n";
  assert.equal(patchJsText(sibling, [{ op: "set", path: ["b"], value: 3 }]).text, sibling.replace("b: 2", "b: 3"));
});

test("bad edits are BAD_EDIT, not guesses", () => {
  assert.throws(() => patchJsText("export default { a: 1 };\n", [{ op: "set", path: ["a"], value: () => 1 }]), (e) => e.code === "BAD_EDIT");
  assert.throws(() => patchJsText("export default { a: 1 };\n", [{ op: "set", path: ["a"], value: Number.NaN }]), (e) => e.code === "BAD_EDIT");
  assert.throws(() => patchJsText("export default { a: [1] };\n", [{ op: "set", path: ["a", 5], value: 1 }]), (e) => e.code === "BAD_EDIT");
  assert.throws(() => patchJsText("export default { a: [1] };\n", [{ op: "set", path: ["a", "x"], value: 1 }]), (e) => e.code === "BAD_EDIT");
  assert.equal(checkEdit("const x = 1;\n", { op: "set", path: ["a"], value: 1 }).reason, "NO_CONFIG_ROOT");
});

// ---------------------------------------------------------------------------------------------------------------------
// Adapters: manifest and binding, "editable file", no execution

test("the ESLint and Vitest manifests are valid, editable-file level; ESLint announces lint and Vitest the unit and coverage ones", () => {
  const manifests = builtinManifests();
  for (const id of ["eslint", "vitest"]) {
    const m = manifests.find((x) => x.id === id);
    assert.ok(m, id);
    assert.equal(validateManifest(m).ok, true, validateManifest(m).errors.join("; "));
    assert.deepEqual(m.editing.implemented, ["text", "partial"]);
    assert.deepEqual(m.editing.tested, []);
    // Both run: Vitest tests and coverage, ESLint lint.
    assert.deepEqual(m.capabilities, id === "vitest" ? ["unit", "coverage"] : ["lint"]);
  }
});

test("the config file is found by name only and nothing is read", () => {
  withProject({ "eslint.config.mjs": "throw new Error('never');\n", "vite.config.js": "x", "vitest.config.mts": "y" }, "tools: {}\n", (dir) => {
    assert.equal(findEslintConfig(dir), "eslint.config.mjs");
    assert.equal(findVitestConfig(dir), "vitest.config.mts");
    assert.equal(findEslintConfig(path.join(dir, ".jgates")), null);
  });
});

test("tools list shows ESLint and Vitest at the editable-file level and does not announce execution", () => {
  const files = { "eslint.config.js": corpus("eslint.config.js"), "vitest.config.ts": corpus("vitest.config.ts") };
  withProject(files, TOOLS, (dir) => {
    const { status, doc } = cli(dir, ["tools", "list"]);
    assert.equal(status, 0);
    const adapters = Object.fromEntries(doc.adapters.map((a) => [a.id, a]));
    assert.ok(adapters.eslint && adapters.vitest);
    assert.deepEqual(adapters.eslint.capabilities, ["lint"]);
    assert.deepEqual(adapters.vitest.capabilities, ["unit", "coverage"]);
    const byId = Object.fromEntries(doc.instances.map((i) => [i.id, i]));
    assert.equal(byId["eslint-web"].supportLevel, "editable-file");
    assert.equal(byId["vitest-web"].supportLevel, "editable-file");
    assert.equal(fs.existsSync(path.join(dir, "executed.marker")), false);
    // The human table says "arquivo editável" for both.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jg-js-home-"));
    try {
      const r = spawnSync(process.execPath, [MAIN, "tools", "list", "--cwd", dir], { encoding: "utf8", env: { ...process.env, JGATES_HOME: home } });
      const rows = r.stdout.split("\n").filter((l) => /^\s+(eslint-web|vitest-web)\s/.test(l));
      assert.equal(rows.length, 2);
      for (const row of rows) assert.match(row, /arquivo edit/i);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
    const inspected = cli(dir, ["tools", "inspect", "vitest-web"]);
    assert.equal(inspected.doc.instance.supportLevel, "editable-file");
    assert.equal(inspected.doc.instance.bindings[0].relPath, "vitest.config.ts");
  });
});
