import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Schema-driven forms (Options tab): Ruff and pytest editing the same pyproject.toml through field intents, minimal
// patches and the shared revision of the document service.

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const DIST = path.resolve(here, "..", "dist");
const MAIN = path.join(DIST, "cli", "main.js");
const VENV_PYTHON = path.join(REPO, ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
// The TOML helper runs in the sidecar Python: the repository .venv when nothing else is configured.
if (!process.env.JGATES_PYTHON && fs.existsSync(VENV_PYTHON)) process.env.JGATES_PYTHON = VENV_PYTHON;

const forms = await import(path.join(DIST, "core", "forms", "index.js"));
const docs = await import(path.join(DIST, "core", "documents", "index.js"));
const { tomlStructuredAvailable } = await import(path.join(DIST, "core", "codecs", "toml", "index.js"));
const { routes } = await import(path.join(DIST, "server", "routes", "forms.js"));
const { choosePytestConfig } = await import(path.join(DIST, "adapters", "pytest", "index.js"));

const PYTEST_SECTION = `[tool.pytest.ini_options]
# Fast feedback by default.
addopts = "-q"
testpaths = ["tests"]

`;
const RUFF_SECTION = `[tool.ruff]
# Shared by lint and format.
line-length = 88

[tool.ruff.lint]
select = ["E", "F"]
`;
const PYPROJECT = `[project]
name = "demo"
version = "0.1.0"

${PYTEST_SECTION}${RUFF_SECTION}`;

const TOOLS = `schemaVersion: 1
tools:
  ruff:
    adapter: ruff
    config: pyproject.toml
  pytest:
    adapter: pytest
    config: pyproject.toml
`;

function withProject(fn, { pyproject = PYPROJECT, tools = TOOLS } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jg-forms-")));
  const files = { "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/tools.yml\n", ".jgates/tools.yml": tools, "pyproject.toml": pyproject };
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  const done = () => fs.rmSync(dir, { recursive: true, force: true });
  let out;
  try {
    out = fn(dir, path.join(dir, "pyproject.toml"));
  } catch (e) {
    done();
    throw e;
  }
  if (out && typeof out.then === "function") return out.finally(done);
  done();
  return out;
}

/** The section of a TOML text that starts at `header`, up to the next table header. */
function section(text, header) {
  const start = text.indexOf(header);
  if (start < 0) return "";
  const rest = text.slice(start + header.length);
  const next = rest.search(/^\[/m);
  return text.slice(start, next < 0 ? undefined : start + header.length + next);
}

/** Lines that differ between two texts with the same number of lines (null when the counts differ). */
function changedLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length !== b.length) return null;
  return a.map((line, i) => (line === b[i] ? null : { line: i + 1, before: line, after: b[i] })).filter(Boolean);
}

const field = (view, id) => view.fields.find((f) => f.id === id);

test("the TOML helper is available (forms need Python with tomlkit)", () => {
  assert.ok(
    tomlStructuredAvailable(),
    "Python with tomlkit not found: create the .venv (python3 -m venv .venv && .venv/bin/pip install -e quality-gate) or set JGATES_PYTHON",
  );
});

test("changing line-length in the Ruff form changes only that line; the pytest section stays byte for byte", async () => {
  await withProject(async (dir, file) => {
    const view = await forms.openForm(dir, "ruff");
    assert.equal(view.available, true, JSON.stringify(view.unavailable));
    assert.deepEqual(view.section, ["tool", "ruff"]);
    assert.equal(field(view, "line-length").state, "set");
    assert.equal(field(view, "line-length").value, 88);
    assert.deepEqual(view.document.sharedWith.map((s) => s.tool), ["pytest"]);

    const preview = await forms.previewForm(dir, "ruff", { expectedRevision: view.revision, intents: [{ field: "line-length", op: "set", value: 100 }] });
    assert.equal(preview.status, "ok");
    assert.match(preview.diff, /-line-length = 88\n\+line-length = 100/);
    assert.equal(fs.readFileSync(file, "utf8"), PYPROJECT, "a preview writes nothing");

    const saved = await forms.saveForm(dir, "ruff", { expectedRevision: view.revision, intents: [{ field: "line-length", op: "set", value: 100 }] });
    assert.equal(saved.status, "saved");
    const after = fs.readFileSync(file, "utf8");
    assert.deepEqual(changedLines(PYPROJECT, after), [{ line: 12, before: "line-length = 88", after: "line-length = 100" }]);
    assert.equal(section(after, "[tool.pytest.ini_options]"), PYTEST_SECTION);
    assert.equal(saved.revision, docs.openDocument(dir, "pytest", "config").revision);
  });
});

test("the other way: changing addopts in the pytest form leaves the Ruff sections byte for byte", async () => {
  await withProject(async (dir, file) => {
    const view = await forms.openForm(dir, "pytest");
    assert.deepEqual(view.section, ["tool", "pytest", "ini_options"]);
    assert.equal(field(view, "addopts").value, "-q");
    const saved = await forms.saveForm(dir, "pytest", { expectedRevision: view.revision, intents: [{ field: "addopts", op: "set", value: "-ra -q" }] });
    assert.equal(saved.status, "saved");
    const after = fs.readFileSync(file, "utf8");
    assert.deepEqual(changedLines(PYPROJECT, after), [{ line: 7, before: 'addopts = "-q"', after: 'addopts = "-ra -q"' }]);
    assert.equal(after.slice(after.indexOf("[tool.ruff]")), RUFF_SECTION);
  });
});

test("form, text and form again keep the values and never write defaults the user did not choose", async () => {
  await withProject(async (dir, file) => {
    const first = await forms.openForm(dir, "ruff");
    // Inherited fields show the tool default without it being in the file.
    assert.equal(field(first, "format.quote-style").state, "inherited");
    assert.equal(field(first, "format.quote-style").defaultValue, "double");
    const intents = [
      { field: "target-version", op: "set", value: "py312" },
      { field: "lint.ignore", op: "set", value: ["F401"] },
      // Equal to what the file already has: not an edit.
      { field: "line-length", op: "set", value: 88 },
      // Absent already: not an edit.
      { field: "preview", op: "inherit" },
    ];
    const saved = await forms.saveForm(dir, "ruff", { expectedRevision: first.revision, intents });
    assert.equal(saved.status, "saved");
    assert.deepEqual([...saved.changes].sort(), ["lint.ignore", "target-version"]);
    const text = fs.readFileSync(file, "utf8");
    for (const absent of ["quote-style", "preview", "include", "indent-width", "fixable", "respect-gitignore"]) {
      assert.ok(!text.includes(absent), `${absent} must not be written`);
    }

    // The text editor changes the file (a comment and another key), then the form reads it again.
    const viaText = text.replace('target-version = "py312"', 'target-version = "py312"  # kept by hand');
    const textSave = docs.saveDocument(dir, "ruff", "config", { expectedRevision: saved.revision, text: viaText });
    assert.equal(textSave.status, "saved");
    const again = await forms.openForm(dir, "ruff");
    assert.equal(field(again, "target-version").value, "py312");
    assert.deepEqual(field(again, "lint.ignore").value, ["F401"]);
    assert.equal(field(again, "line-length").value, 88);
    assert.equal(field(again, "format.quote-style").state, "inherited");

    // Saving the same values again changes no byte.
    const same = await forms.saveForm(dir, "ruff", { expectedRevision: again.revision, intents });
    assert.equal(same.status, "unchanged");
    assert.equal(fs.readFileSync(file, "utf8"), viaText);
  });
});

test("'use the inherited value' removes the key and is not the same as false, 0 or empty", async () => {
  await withProject(async (dir, file) => {
    let view = await forms.openForm(dir, "ruff");
    let r = await forms.saveForm(dir, "ruff", { expectedRevision: view.revision, intents: [{ field: "preview", op: "set", value: false }, { field: "exclude", op: "set", value: [] }] });
    assert.equal(r.status, "saved");
    view = await forms.openForm(dir, "ruff");
    assert.equal(field(view, "preview").state, "set");
    assert.equal(field(view, "preview").value, false);
    assert.equal(field(view, "exclude").state, "set");
    assert.deepEqual(field(view, "exclude").value, []);
    assert.match(fs.readFileSync(file, "utf8"), /^preview = false$/m);

    r = await forms.saveForm(dir, "ruff", { expectedRevision: view.revision, intents: [{ field: "preview", op: "inherit" }, { field: "exclude", op: "inherit" }, { field: "line-length", op: "inherit" }] });
    assert.equal(r.status, "saved");
    view = await forms.openForm(dir, "ruff");
    for (const id of ["preview", "exclude", "line-length"]) assert.equal(field(view, id).state, "inherited", id);
    const text = fs.readFileSync(file, "utf8");
    assert.ok(!/preview|exclude|line-length/.test(text));
    assert.equal(section(text, "[tool.pytest.ini_options]"), PYTEST_SECTION);
  });
});

test("two editors of the same pyproject.toml share the revision: the second save asks for reconciliation", async () => {
  await withProject(async (dir, file) => {
    const ruff = await forms.openForm(dir, "ruff");
    const pytest = await forms.openForm(dir, "pytest");
    assert.equal(ruff.revision, pytest.revision);

    const first = await forms.saveForm(dir, "ruff", { expectedRevision: ruff.revision, intents: [{ field: "line-length", op: "set", value: 120 }] });
    assert.equal(first.status, "saved");
    const afterRuff = fs.readFileSync(file, "utf8");

    const intents = [{ field: "minversion", op: "set", value: "8.0" }];
    const second = await forms.saveForm(dir, "pytest", { expectedRevision: pytest.revision, intents });
    assert.equal(second.status, "conflict");
    assert.equal(second.expectedRevision, pytest.revision);
    assert.equal(second.current.revision, first.revision);
    assert.equal(fs.readFileSync(file, "utf8"), afterRuff, "a conflict writes nothing");
    // The same intents over the current version, shown for confirmation (not saved).
    assert.equal(second.rebased.ok, true);
    assert.match(second.rebased.text, /line-length = 120/);
    assert.match(second.rebased.text, /minversion = "8.0"/);

    const preview = await forms.previewForm(dir, "pytest", { expectedRevision: pytest.revision, intents });
    assert.equal(preview.status, "conflict");

    // Reconciled: the user confirms over the current revision, and both changes are in the file.
    const third = await forms.saveForm(dir, "pytest", { expectedRevision: second.current.revision, intents });
    assert.equal(third.status, "saved");
    const final = fs.readFileSync(file, "utf8");
    assert.match(final, /line-length = 120/);
    assert.match(final, /minversion = "8.0"/);
    assert.equal(final.slice(final.indexOf("[tool.ruff]")), afterRuff.slice(afterRuff.indexOf("[tool.ruff]")));
  });
});

test("a value the schema does not recognize is never removed or switched off when another field is saved", async () => {
  const pyproject = `[tool.pytest.ini_options]
addopts = ["-q"]

[tool.ruff]
line-length = 88
select = ["E"]

[tool.ruff.lint]
select = ["E", "custom-plugin"]
per-file-ignores = { "tests/*" = ["S101"] }

[tool.ruff.lint.isort]
known-first-party = ["demo"]
`;
  await withProject(async (dir, file) => {
    const view = await forms.openForm(dir, "ruff");
    const select = field(view, "lint.select");
    assert.equal(select.state, "unrecognized");
    assert.deepEqual(select.value, ["E", "custom-plugin"]);
    assert.ok(select.problems.length > 0);
    assert.deepEqual(select.position, { line: 9, column: 1 });
    assert.equal(field(view, "lint.per-file-ignores").state, "set");
    // Keys outside the form, with their place in the file.
    const unsupported = Object.fromEntries(view.unsupported.map((u) => [u.documentPath, u.position?.line]));
    assert.deepEqual(unsupported, { "tool.ruff.select": 6, "tool.ruff.lint.isort": 12 });
    // pytest: a string list where the form expects a TOML array of strings is fine, but a list for addopts is not.
    const pytest = await forms.openForm(dir, "pytest");
    assert.equal(field(pytest, "addopts").state, "unrecognized");

    const saved = await forms.saveForm(dir, "ruff", { expectedRevision: view.revision, intents: [{ field: "line-length", op: "set", value: 99 }] });
    assert.equal(saved.status, "saved");
    assert.deepEqual(changedLines(pyproject, fs.readFileSync(file, "utf8")), [{ line: 5, before: "line-length = 88", after: "line-length = 99" }]);

    const fresh = await forms.openForm(dir, "ruff");
    for (const intent of [{ field: "lint.select", op: "inherit" }, { field: "lint.select", op: "set", value: ["E"] }]) {
      await assert.rejects(forms.saveForm(dir, "ruff", { expectedRevision: fresh.revision, intents: [intent] }), (e) => e.code === "FORM_FIELD_UNRECOGNIZED");
    }
    await assert.rejects(forms.saveForm(dir, "ruff", { expectedRevision: fresh.revision, intents: [{ field: "line-length", op: "set", value: 0 }] }), (e) => e.code === "FORM_VALUE_INVALID");
    await assert.rejects(forms.saveForm(dir, "ruff", { expectedRevision: fresh.revision, intents: [{ field: "lint.isort", op: "inherit" }] }), (e) => e.code === "FORM_FIELD_UNKNOWN");
    assert.match(fs.readFileSync(file, "utf8"), /select = \["E", "custom-plugin"\]/);
  }, { pyproject });
});

test("without Python the form is unavailable and says why; the text stays readable", async () => {
  await withProject(async (dir) => {
    const view = await forms.openForm(dir, "ruff", { env: { PATH: "" } });
    assert.equal(view.available, false);
    assert.equal(view.unavailable.code, "STRUCTURED_EDIT_UNAVAILABLE");
    assert.equal(docs.openDocument(dir, "ruff", "config").text, PYPROJECT);
    await assert.rejects(forms.saveForm(dir, "ruff", { expectedRevision: view.revision, intents: [{ field: "line-length", op: "set", value: 90 }] }, { env: { PATH: "" } }), (e) => e.code === "FORM_UNAVAILABLE");
  });
});

test("a syntax error suspends the form with the position; an adapter without a form is refused", async () => {
  await withProject(async (dir) => {
    const view = await forms.openForm(dir, "ruff");
    assert.equal(view.available, false);
    assert.equal(view.unavailable.code, "DOCUMENT_PARSE");
    await assert.rejects(forms.openForm(dir, "other"), (e) => e.code === "FORM_NOT_FOUND");
    await assert.rejects(forms.openForm(dir, "nope"), (e) => e.code === "INSTANCE_NOT_FOUND");
  }, { pyproject: "[tool.ruff\nline-length = 88\n", tools: TOOLS + "  other:\n    adapter: semgrep\n    config: pyproject.toml\n" });
});

test("tools list shows Ruff and pytest at the assisted-configuration level, from their manifests", () => {
  withProject((dir) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jg-forms-home-"));
    try {
      const r = spawnSync(process.execPath, [MAIN, "tools", "list", "--cwd", dir, "--json"], { encoding: "utf8", env: { ...process.env, JGATES_HOME: home }, timeout: 60_000 });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const doc = JSON.parse(r.stdout);
      const byId = Object.fromEntries(doc.instances.map((i) => [i.id, i.supportLevel]));
      assert.deepEqual(byId, { ruff: "assisted", pytest: "assisted" });
      const text = spawnSync(process.execPath, [MAIN, "tools", "list", "--cwd", dir], { encoding: "utf8", env: { ...process.env, JGATES_HOME: home }, timeout: 60_000 });
      assert.match(text.stdout, /ruff\s.*configuração assistida/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

test("the form routes: read, preview, save, conflict with the rebased preview, refusals with their status", async () => {
  await withProject(async (dir, file) => {
    const logs = [];
    const server = { projectDir: dir, log: (l) => logs.push(l) };
    const route = (method, p) => routes.find((r) => r.method === method && r.path === p);
    const get = await route("GET", "/api/forms/:instance").handler({ params: { instance: "ruff" }, query: {}, body: undefined, server });
    assert.equal(get.status, 200);
    const revision = get.json.form.revision;
    const body = { expectedRevision: revision, intents: [{ field: "line-length", op: "set", value: 101 }] };
    const preview = await route("POST", "/api/forms/:instance/preview").handler({ params: { instance: "ruff" }, query: {}, body, server });
    assert.equal(preview.json.preview.status, "ok");
    const put = await route("PUT", "/api/forms/:instance").handler({ params: { instance: "ruff" }, query: {}, body, server });
    assert.equal(put.json.save.status, "saved");
    assert.match(fs.readFileSync(file, "utf8"), /line-length = 101/);
    await assert.rejects(route("PUT", "/api/forms/:instance").handler({ params: { instance: "pytest" }, query: {}, body: { expectedRevision: revision, intents: [] }, server }), (e) => e.status === 409 && e.code === "REVISION_CONFLICT" && e.details.conflict.current.revision === put.json.save.revision);
    await assert.rejects(route("GET", "/api/forms/:instance").handler({ params: { instance: "missing" }, query: {}, body: undefined, server }), (e) => e.status === 404);
    const fresh = put.json.save.revision;
    await assert.rejects(route("PUT", "/api/forms/:instance").handler({ params: { instance: "ruff" }, query: {}, body: { expectedRevision: fresh, intents: [{ field: "line-length", op: "set", value: "wide" }] }, server }), (e) => e.status === 422 && e.code === "FORM_VALUE_INVALID");
  });
});

test("toml positions follow headers, dotted and quoted keys and skip multi-line values", () => {
  const text = '[tool.ruff]\nexclude = [\n  "a = 1",\n  "[x]",\n]\nlint.select = ["E"]\nnote = """\nfake = 1\n"""\n\n[tool."quoted.key"]\nb = 2\n[[arr]]\nc = 1\n[[arr]]\nc = 2\n';
  const p = forms.tomlPositions(text);
  const at = (...keys) => forms.positionOf(p, keys)?.line ?? null;
  assert.equal(at("tool", "ruff", "exclude"), 2);
  assert.equal(at("tool", "ruff", "lint", "select"), 6);
  assert.equal(at("tool", "ruff", "lint"), 6);
  assert.equal(p.has(JSON.stringify(["tool", "ruff", "fake"])), false);
  assert.equal(at("tool", "quoted.key", "b"), 12);
  assert.equal(at("arr", 1, "c"), 16);
});

test("pytest picks the binding first, then its native configuration file", () => {
  withProject((dir) => {
    assert.deepEqual(choosePytestConfig(dir, "pytest", null), { file: "pyproject.toml", source: "binding" });
    fs.writeFileSync(path.join(dir, "pytest.ini"), "[pytest]\n");
    assert.deepEqual(choosePytestConfig(dir, "none", null), { file: "pytest.ini", source: "native" });
    fs.rmSync(path.join(dir, "pytest.ini"));
    assert.deepEqual(choosePytestConfig(dir, "none", null), { file: "pyproject.toml", source: "native" });
  });
});
