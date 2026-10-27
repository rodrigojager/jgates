import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { jsonCodec, dialectForFile } from "../dist/core/codecs/json/index.js";
import { yamlCodec } from "../dist/core/codecs/yaml/codec.js";
import { patchYamlText } from "../dist/core/codecs/yaml/index.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codecs");
const load = (name) => fs.readFileSync(path.join(dir, name), "utf8");

/** Lines removed and added, after trimming the common head and tail. */
function lineDiff(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { removed: a.slice(head, a.length - tail), added: b.slice(head, b.length - tail) };
}

const corpus = [
  ["strict.json", jsonCodec, { dialect: "json" }],
  ["tsconfig.jsonc", jsonCodec, { dialect: "jsonc" }],
  ["config.yaml", yamlCodec, {}],
  ["plain.yaml", yamlCodec, {}],
];

test("read and write without edits changes no byte", () => {
  for (const [name, codec, options] of corpus) {
    const text = load(name);
    const doc = codec.read(text, options);
    assert.equal(doc.ok, true, name);
    const out = codec.apply(text, [], options);
    assert.equal(out.text, text, name);
    assert.equal(out.changed, false);
  }
  // BOM and CRLF survive an edit-free round trip and an edit
  const crlf = "﻿" + load("strict.json").replace(/\n/g, "\r\n");
  assert.equal(jsonCodec.apply(crlf, []).text, crlf);
  const edited = jsonCodec.apply(crlf, [{ op: "set", path: ["rules", "quotes"], value: "double" }]).text;
  assert.ok(edited.startsWith("﻿"));
  assert.ok(!/[^\r]\n/.test(edited.slice(1)), "line endings stay CRLF");
});

test("read gives positions for the fields", () => {
  const doc = jsonCodec.read(load("strict.json"), { dialect: "json" });
  const semi = doc.fields.find((f) => f.path.join(".") === "rules.semi");
  assert.equal(semi.kind, "boolean");
  assert.equal(semi.line, 6);
  const y = yamlCodec.read(load("config.yaml"));
  const build = y.fields.find((f) => f.path.join(".") === "build");
  assert.equal(build.anchor, "build");
  assert.equal(build.aliases, 2);
  assert.equal(y.fields.find((f) => f.path.join(".") === "deploy.settings").aliasOf, "build");
  assert.equal(yamlCodec.read(load("multi.yaml")).documents, 2);
  const broken = jsonCodec.read('{"a": }', { dialect: "json" });
  assert.equal(broken.ok, false);
  assert.ok(broken.errors[0].line >= 1);
});

test("one option changes only its own lines", () => {
  let out = jsonCodec.apply(load("strict.json"), [{ op: "set", path: ["rules", "quotes"], value: "double" }], { dialect: "json" });
  assert.deepEqual(lineDiff(load("strict.json"), out.text), { removed: ['    "quotes": "single"'], added: ['    "quotes": "double"'] });

  out = jsonCodec.apply(load("tsconfig.jsonc"), [{ op: "set", path: ["compilerOptions", "strict"], value: false }], { dialect: "jsonc" });
  assert.deepEqual(lineDiff(load("tsconfig.jsonc"), out.text), {
    removed: ['\t\t"strict": true, // keep strict'],
    added: ['\t\t"strict": false, // keep strict'],
  });

  out = yamlCodec.apply(load("plain.yaml"), [{ op: "set", path: ["options", "level"], value: 3 }]);
  assert.deepEqual(lineDiff(load("plain.yaml"), out.text), { removed: ["  level: 2"], added: ["  level: 3"] });

  out = yamlCodec.apply(load("plain.yaml"), [{ op: "set", path: ["name"], value: "other" }]);
  assert.deepEqual(lineDiff(load("plain.yaml"), out.text), { removed: ["name: demo   # the name"], added: ["name: other   # the name"] });
});

test("comments, key order and unknown fields survive edits", () => {
  const json = load("tsconfig.jsonc");
  const out = jsonCodec.apply(
    json,
    [
      { op: "set", path: ["compilerOptions", "target"], value: "ES2023" },
      { op: "set", path: ["compilerOptions", "newOption"], value: 1 },
    ],
    { dialect: "jsonc" },
  ).text;
  for (const keep of ["// Project config", "/* compiler block */", "// keep strict", "// runtime", "// before include", '"extra": 1,']) assert.ok(out.includes(keep), keep);
  const keys = (t) => [...t.matchAll(/"(\w+)":/g)].map((m) => m[1]);
  assert.deepEqual(keys(out).filter((k) => k !== "newOption"), keys(json));

  const yaml = load("config.yaml");
  const edited = yamlCodec.apply(yaml, [
    { op: "set", path: ["deploy", "steps", 1, "run"], value: "npm run test:all" },
    { op: "set", path: ["unknown", "added"], value: true },
  ]).text;
  for (const keep of ["# Top comment", "&build   # anchored block", "<<: *build", "# comment before test", "- b   # tag b", "keep: [1, 2,   3]", "'quoted': 'single'", 'note: "keep   this"']) {
    assert.ok(edited.includes(keep), keep);
  }
  assert.ok(edited.includes("npm run test:all"));
});

test("a value reached by an alias returns the shared warning and keeps the aliases", () => {
  const yaml = load("config.yaml");
  const out = yamlCodec.apply(yaml, [{ op: "set", path: ["build", "retries"], value: 5 }]);
  const warning = out.warnings.find((w) => w.code === "SHARED_BY_ALIAS");
  assert.ok(warning, "shared warning");
  assert.match(warning.message, /&build/);
  assert.deepEqual(lineDiff(yaml, out.text), { removed: ["  retries: 3"], added: ["  retries: 5"] });
  assert.ok(out.text.includes("<<: *build") && out.text.includes("settings: *build"), "aliases are not expanded");
  const reread = yamlCodec.read(out.text);
  assert.equal(reread.value.deploy.settings.retries, 5);

  // an unshared value does not warn; a local override of a merged key warns softly
  assert.equal(yamlCodec.apply(yaml, [{ op: "set", path: ["schemaVersion"], value: 2 }]).warnings.length, 0);
  const merged = yamlCodec.apply(yaml, [{ op: "set", path: ["test", "retries"], value: 9 }]);
  assert.ok(merged.warnings.some((w) => w.code === "MERGE_OVERRIDE"));
  // setting an alias node replaces the reference locally
  const local = yamlCodec.apply(yaml, [{ op: "set", path: ["deploy", "settings"], value: { retries: 1 } }]);
  assert.ok(local.warnings.some((w) => w.code === "ALIAS_OVERRIDDEN"));
  assert.ok(local.text.includes("&build"));
  // going through an alias is refused
  assert.throws(() => yamlCodec.apply(yaml, [{ op: "set", path: ["deploy", "settings", "retries"], value: 1 }]), { code: "UNSUPPORTED" });
});

test("multi-document YAML is readable but not editable", () => {
  assert.throws(() => yamlCodec.apply(load("multi.yaml"), [{ op: "set", path: ["a"], value: 2 }]), { code: "MULTI_DOCUMENT" });
  assert.equal(yamlCodec.apply(load("multi.yaml"), []).text, load("multi.yaml"));
});

test("insert and remove in JSON arrays keep the document valid and the comments", () => {
  const strict = load("strict.json");
  let out = jsonCodec.apply(strict, [{ op: "insert", path: ["files"], value: "d.js" }], { dialect: "json" }).text;
  assert.deepEqual(JSON.parse(out).files, ["a.js", "b.js", "c.js", "d.js"]);
  assert.deepEqual(lineDiff(strict, out).removed, ['    "c.js"']);
  out = jsonCodec.apply(strict, [{ op: "insert", path: ["files"], value: "x.js", index: 0 }], { dialect: "json" }).text;
  assert.deepEqual(JSON.parse(out).files, ["x.js", "a.js", "b.js", "c.js"]);
  out = jsonCodec.apply(strict, [{ op: "delete", path: ["files", 1] }], { dialect: "json" }).text;
  assert.deepEqual(JSON.parse(out).files, ["a.js", "c.js"]);
  out = jsonCodec.apply(strict, [{ op: "delete", path: ["files", 2] }, { op: "delete", path: ["files", 1] }, { op: "delete", path: ["files", 0] }], { dialect: "json" }).text;
  assert.deepEqual(JSON.parse(out).files, []);
  out = jsonCodec.apply(strict, [{ op: "insert", path: ["newList"], value: 1 }], { dialect: "json" }).text;
  assert.deepEqual(JSON.parse(out).newList, [1]);

  const jsonc = load("tsconfig.jsonc");
  out = jsonCodec.apply(jsonc, [{ op: "insert", path: ["compilerOptions", "lib"], value: "WebWorker" }, { op: "insert", path: ["include"], value: "tests" }], { dialect: "jsonc" }).text;
  for (const keep of ["// Project config", "/* compiler block */", "// keep strict", "// runtime", "// before include"]) assert.ok(out.includes(keep), keep);
  const parsed = jsonCodec.read(out, { dialect: "jsonc" });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.compilerOptions.lib, ["ES2022", "DOM", "WebWorker"]);
  assert.deepEqual(parsed.value.include, ["src", "tests"]);
  out = jsonCodec.apply(jsonc, [{ op: "delete", path: ["compilerOptions", "lib", 0] }], { dialect: "jsonc" }).text;
  assert.deepEqual(jsonCodec.read(out, { dialect: "jsonc" }).value.compilerOptions.lib, ["DOM"]);
  assert.ok(out.includes("// before include") && out.includes("// keep strict"));
});

test("strict JSON never becomes JSONC", () => {
  assert.equal(dialectForFile("a.json"), "json");
  assert.equal(dialectForFile("a.jsonc"), "jsonc");
  assert.equal(jsonCodec.read(load("tsconfig.jsonc"), { dialect: "json" }).ok, false);
  assert.throws(() => jsonCodec.apply(load("tsconfig.jsonc"), [{ op: "set", path: ["extra"], value: 2 }], { dialect: "json" }), { code: "PARSE" });
  const out = jsonCodec.apply(load("strict.json"), [{ op: "set", path: ["version"], value: "2.0.0" }, { op: "insert", path: ["files"], value: "z" }, { op: "delete", path: ["last"] }], { dialect: "json" }).text;
  assert.doesNotThrow(() => JSON.parse(out));
  assert.ok(!/\/\/|\/\*|,\s*[\]}]/.test(out));
  assert.throws(() => jsonCodec.read("{}", { dialect: "json5" }), { code: "DIALECT" });
});

test("YAML sequences: insert, delete and replace stay local", () => {
  const plain = load("plain.yaml");
  let out = yamlCodec.apply(plain, [{ op: "insert", path: ["options", "paths"], value: "docs" }]).text;
  assert.deepEqual(lineDiff(plain, out), { removed: [], added: ["    - docs"] });
  out = yamlCodec.apply(plain, [{ op: "insert", path: ["options", "paths"], value: "docs", index: 0 }]).text;
  assert.deepEqual(lineDiff(plain, out), { removed: [], added: ["    - docs"] });
  assert.deepEqual(yamlCodec.read(out).value.options.paths, ["docs", "src", "tests"]);
  out = yamlCodec.apply(plain, [{ op: "delete", path: ["options", "paths", 0] }]).text;
  assert.deepEqual(lineDiff(plain, out), { removed: ["    - src"], added: [] });
  out = yamlCodec.apply(plain, [{ op: "insert", path: ["empty"], value: "x" }]).text;
  assert.deepEqual(yamlCodec.read(out).value.empty, ["x"]);
  assert.ok(out.includes("# plain document") && out.includes("# list below"));

  const cfg = load("config.yaml");
  out = yamlCodec.apply(cfg, [{ op: "insert", path: ["deploy", "steps"], value: { name: "audit", run: "npm audit" } }]).text;
  assert.deepEqual(yamlCodec.read(out).value.deploy.steps.at(-1), { name: "audit", run: "npm audit" });
  assert.ok(out.includes("# comment before test"));
  out = yamlCodec.apply(cfg, [{ op: "delete", path: ["deploy", "tags", 1] }]).text;
  assert.deepEqual(yamlCodec.read(out).value.deploy.tags, ["a", "c"]);
  out = yamlCodec.apply(cfg, [{ op: "set", path: ["deploy", "tags", 0], value: "z" }]).text;
  assert.deepEqual(lineDiff(cfg, out), { removed: ["    - a"], added: ["    - z"] });
});

test("the YAML text patcher keeps its contract", () => {
  const out = patchYamlText("a: 1\nb: 2\n", [{ op: "set", path: ["a"], value: 3 }]);
  assert.equal(out.text, "a: 3\nb: 2\n");
  assert.throws(() => patchYamlText("a: [\n", [{ op: "set", path: ["a"], value: 3 }]), { code: "YAML_PARSE" });
});
