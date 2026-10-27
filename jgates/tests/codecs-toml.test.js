import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist", "core");
const { createTomlCodec, tomlStructuredAvailable, TOML_UNAVAILABLE } = await import(path.join(dist, "codecs", "toml", "index.js"));
const { validateText } = await import(path.join(dist, "documents", "validate.js"));

const CORPUS = path.join(here, "fixtures", "codecs-toml");
const read = (name) => fs.readFileSync(path.join(CORPUS, name)).toString("utf8");

const codec = createTomlCodec();
const hasPython = tomlStructuredAvailable();
// The tests that need the helper fail with the install instruction instead of skipping (project convention).
const INSTALL_HINT = "Python with tomlkit not found: create the .venv (python3 -m venv .venv && .venv/bin/pip install -e quality-gate) or set JGATES_PYTHON";
const requireHelper = () => assert.ok(hasPython, INSTALL_HINT);
// No interpreter reachable: an empty PATH and no JGATES_PYTHON.
const noPython = createTomlCodec({ env: { PATH: "" } });

test("without Python the codec answers 'edição estruturada indisponível' and textual reading still works", () => {
  const text = read("pyproject.toml");
  const doc = noPython.read(text);
  assert.equal(doc.ok, false);
  assert.equal(doc.errors[0].code, TOML_UNAVAILABLE);
  assert.match(doc.errors[0].message, /Edição estruturada indisponível/);
  assert.throws(() => noPython.apply(text, [{ op: "set", path: ["tool", "ruff", "line-length"], value: 1 }]), (e) => e.code === "UNSUPPORTED");
  // Empty edits never need the helper.
  assert.equal(noPython.apply(text, []).text, text);
  // The text itself is untouched and readable.
  assert.equal(read("pyproject.toml"), text);
});

test("the syntax validator keeps saying unavailable without Python", () => {
  const saved = { PATH: process.env.PATH, JGATES_PYTHON: process.env.JGATES_PYTHON };
  process.env.PATH = "";
  delete process.env.JGATES_PYTHON;
  try {
    const result = validateText("toml", "a = 1\n");
    assert.equal(result.status, "unavailable");
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.JGATES_PYTHON !== undefined) process.env.JGATES_PYTHON = saved.JGATES_PYTHON;
  }
});

test("validator checks TOML syntax through the helper", () => {
  requireHelper();
  assert.equal(validateText("toml", read("pyproject.toml")).status, "valid");
  const bad = validateText("toml", read("broken.toml"));
  assert.equal(bad.status, "invalid");
  assert.ok(bad.errors[0].line >= 1);
});

test("read returns the parsed value", () => {
  requireHelper();
  const doc = codec.read(read("pyproject.toml"));
  assert.equal(doc.ok, true);
  assert.equal(doc.dialect, "toml");
  assert.equal(doc.value.tool.ruff["line-length"], 88);
  assert.equal(doc.value.tool.mypy.overrides.length, 2);
  const bad = codec.read(read("broken.toml"));
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].code, "TOML_SYNTAX");
});

test("no-op apply changes no byte for every corpus file", () => {
  requireHelper();
  for (const name of fs.readdirSync(CORPUS).filter((n) => n.endsWith(".toml") && n !== "broken.toml")) {
    const text = read(name);
    const result = codec.apply(text, []);
    assert.equal(result.text, text, name);
    assert.equal(result.changed, false, name);
  }
});

test("editing [tool.ruff] leaves the rest of the shared pyproject.toml byte for byte", () => {
  requireHelper();
  const text = read("pyproject.toml");
  const result = codec.apply(text, [
    { op: "set", path: ["tool", "ruff", "line-length"], value: 100 },
    { op: "set", path: ["tool", "ruff", "lint", "select"], value: ["E", "F", "I"] },
    { op: "delete", path: ["tool", "ruff", "lint", "ignore"] },
  ]);
  assert.equal(result.changed, true);
  assert.match(result.text, /line-length = 100/);
  const head = text.slice(0, text.indexOf("[tool.ruff]"));
  assert.ok(result.text.startsWith(head));
  const pytestBlock = text.slice(text.indexOf("[tool.pytest.ini_options]"), text.indexOf("# Ruff settings below."));
  assert.ok(result.text.includes(pytestBlock));
  const tail = text.slice(text.indexOf("[tool.ruff.lint.per-file-ignores]"));
  assert.ok(result.text.endsWith(tail));
  assert.ok(result.text.includes("# build deps") && result.text.includes("# keep it short"));
});

test("insert into an array and dotted keys", () => {
  requireHelper();
  const text = read("pyproject.toml");
  const result = codec.apply(text, [{ op: "insert", path: ["tool", "pytest", "ini_options", "testpaths"], value: "more", index: 0 }]);
  assert.equal(codec.read(result.text).value.tool.pytest.ini_options.testpaths[0], "more");
  const dotted = read("dotted-quoted.toml");
  const out = codec.apply(dotted, [{ op: "set", path: ["a", "b", "c"], value: 5 }]);
  assert.equal(out.text, dotted.replace("a.b.c = 1", "a.b.c = 5"));
});

test("a bad edit is refused", () => {
  requireHelper();
  assert.throws(() => codec.apply("a = 1\n", [{ op: "set", path: [], value: 1 }]), (e) => e.code === "BAD_EDIT");
  assert.throws(() => codec.apply("a = [\n", [{ op: "set", path: ["a"], value: 1 }]), (e) => e.code === "PARSE");
});
