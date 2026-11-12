import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

// Forms derived from the configuration schemas (ADR-0009, PLAN-config-editing.md sections 2-3), through the route
// handlers of /api/forms/derived/* run in this process against a project written by hand:
//   - a file form returns every key the file has, unknown keys as custom text fields with their diagnostic, each key with
//     its value, origin (this file, default, template, profile), display label (catalogue name, id as secondary) and a
//     YAML link (file, key path, line);
//   - a tool instance of an adapter without a hand-written form gets a form from the schema; the hand-written forms
//     (ruff, pytest, zap, schemathesis, oasdiff, migration-drift, performance, playwright) still apply as overlays;
//   - one key at a time is set or removed with a revision check, keeping comments, order and unknown keys byte for
//     byte, and a preview gives the diff without writing.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (p) => pathToFileURL(path.resolve(here, "..", "dist", p)).href;
const VERSION = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "package.json"), "utf8")).version;

const dirs = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
const made = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

const home = made("jg-derived-home-");
Object.assign(process.env, { JGATES_HOME: home, JGATES_LOCALE: "en", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "", NO_COLOR: "1" });

const { routes } = await import(dist("server/routes/forms.js"));
const { invalidateProjectCache } = await import(dist("core/cache/project.js"));
const route = (method, p) => {
  const r = routes.find((x) => x.method === method && x.path === p);
  assert.ok(r, `${method} ${p}`);
  return r;
};
const context = (dir) => ({ projectDir: dir, policyMode: false, workspace: { id: "ws_formsderived00000", path: dir, name: "demo" }, home, version: VERSION, plans: new Map(), log: () => undefined });
/** Calls a handler as the router does (an HttpError comes back as { status, code }) and clears the cache after a write. */
async function call(server, method, p, { params = {}, query = {}, body } = {}) {
  try {
    const result = await route(method, p).handler({ params, query, body, session: null, server, raw: null });
    return { status: result.status, json: result.json };
  } catch (error) {
    if (error && typeof error.status === "number") return { status: error.status, code: error.code, message: error.message, details: error.details };
    throw error;
  } finally {
    if (method !== "GET") invalidateProjectCache();
  }
}

const ROOT = `schemaVersion: 2
# The project's own choices.
selection:
  profile: mine   # a project profile
execution:
  network: deny   # no network for the checks
  # a key JGates does not know
  mystery: 3
services:
  profiles: [dev]
`;

const PROFILES = `schemaVersion: 1
profiles:
  mine:
    label: Mine
    extends: builtin:standard
    gates: [quality]
    color: blue
    checks:
      capability:sast:
        when: available
`;

// tools is the last key, so an entry the form adds goes at the end of the file.
const TOOLS = `schemaVersion: 1
# Tools written by hand.
tools:
  zz:
    adapter: zizmor   # no hand-written form
    persona: pedantic
    handWritten: yes
  sem:
    adapter: semgrep
    rulePack: jgates
  ruff-main:
    adapter: ruff
  pytest-main:
    adapter: pytest
  web-zap:
    adapter: zap
    mode: passive
  st:
    adapter: schemathesis
  oas:
    adapter: oasdiff
  drift:
    adapter: migration-drift
  perf:
    adapter: performance
  e2e:
    adapter: playwright
`;

function project() {
  const dir = made("jg-derived-proj-");
  fs.mkdirSync(path.join(dir, ".jgates"));
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(dir, "jgates.yml"), ROOT);
  fs.writeFileSync(path.join(dir, ".jgates", "profiles.yml"), PROFILES);
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), TOOLS);
  return dir;
}

/** Every key path of a parsed YAML value that is not an object of keys (scalars and lists), as JSON. */
function leafPaths(value, prefix = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return prefix.length ? [prefix] : [];
  return Object.entries(value).flatMap(([k, v]) => leafPaths(v, [...prefix, k]));
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fieldAt = (form, p) => form.fields.find((f) => same(f.path, p));

test("a file form returns every key of the file: value, origin, label and YAML link; unknown keys as custom text fields with their diagnostic", async () => {
  const dir = project();
  const server = context(dir);
  const res = await call(server, "GET", "/api/forms/derived/file", { query: { file: "jgates.yml" } });
  assert.equal(res.status, 200, JSON.stringify(res));
  const form = res.json.form;
  assert.equal(form.available, true);
  assert.equal(form.file.file, "jgates.yml");
  assert.match(form.file.revision, /^[0-9a-f]{64}$/);

  // Every key present in the file has a field.
  const keys = leafPaths(parse(ROOT));
  for (const key of keys) {
    const field = fieldAt(form, key);
    assert.ok(field, `no field for ${key.join(".")}`);
    assert.deepEqual(field.value, key.reduce((o, k) => o[k], parse(ROOT)), `value of ${key.join(".")}`);
    assert.equal(field.origin.kind, "file", `origin of ${key.join(".")}`);
    assert.equal(field.link.file, "jgates.yml");
    assert.ok(Number.isInteger(field.link.line) && field.link.line > 0, `line of ${key.join(".")}`);
    assert.equal(typeof field.label.text, "string");
    assert.equal(field.label.secondary, String(key[key.length - 1]));
  }
  // Known keys get their control; the unknown one is a custom text field with the schema's diagnostic.
  const network = fieldAt(form, ["execution", "network"]);
  assert.equal(network.state, "set");
  assert.equal(network.widget, "radio");
  assert.deepEqual(network.options.map((o) => o.value), ["explicit", "allow", "deny"]);
  assert.equal(network.link.path, "execution.network");
  assert.equal(network.link.line, 6);
  const mystery = fieldAt(form, ["execution", "mystery"]);
  assert.equal(mystery.state, "custom");
  assert.equal(mystery.widget, "text");
  assert.equal(mystery.text, "3");
  assert.equal(mystery.diagnostics[0].code, "UNKNOWN_KEY");
  assert.equal(mystery.link.line, 8);

  // Keys the file leaves out: their effective value and where it comes from.
  const concurrency = fieldAt(form, ["execution", "concurrency"]);
  assert.equal(concurrency.state, "inherited");
  assert.equal(concurrency.value, 1);
  assert.equal(concurrency.origin.kind, "default");
  assert.equal(concurrency.widget, "number");
  assert.equal(concurrency.limits.minimum, 1);
  const maxAge = fieldAt(form, ["execution", "dataMaxAgeDays"]);
  assert.equal(maxAge.value, 7);
  assert.equal(maxAge.origin.kind, "default");
  assert.ok(maxAge.presets.includes(7));
  const gates = fieldAt(form, ["selection", "gates"]);
  assert.equal(gates.widget, "checklist");
  assert.deepEqual(gates.value, ["quality"]);
  assert.equal(gates.origin.kind, "profile", JSON.stringify(gates.origin));
  assert.equal(gates.origin.source, "profile:mine");
  assert.equal(fieldAt(form, ["services", "build"]).widget, "radio");
  assert.ok(form.diagnostics.some((d) => d.code === "UNKNOWN_KEY" && d.path === "execution.mystery"));
});

test("the profiles file: unknown keys of a profile are custom, a check selector is named by the catalogue, a key the profile leaves out comes from its parent", async () => {
  const dir = project();
  const server = context(dir);
  const form = (await call(server, "GET", "/api/forms/derived/file", { query: { file: ".jgates/profiles.yml" } })).json.form;
  for (const key of leafPaths(parse(PROFILES))) assert.ok(fieldAt(form, key), `no field for ${key.join(".")}`);
  assert.equal(fieldAt(form, ["profiles", "mine", "color"]).state, "custom");
  assert.equal(fieldAt(form, ["profiles", "mine", "color"]).diagnostics[0].code, "UNKNOWN_KEY");
  const entry = form.groups.find((g) => same(g.path, ["profiles", "mine"]));
  assert.deepEqual(entry.label, { text: "Mine", secondary: "mine" });
  const check = form.groups.find((g) => same(g.path, ["profiles", "mine", "checks", "capability:sast"]));
  assert.deepEqual(check.label, { text: "SAST", secondary: "capability:sast" });
  const when = fieldAt(form, ["profiles", "mine", "checks", "capability:sast", "when"]);
  assert.equal(when.state, "set");
  assert.equal(when.widget, "radio");
  const enabled = fieldAt(form, ["profiles", "mine", "checks", "capability:sast", "enabled"]);
  assert.equal(enabled.state, "inherited");
  assert.equal(enabled.widget, "switch");
  assert.equal(enabled.value, true);
  assert.deepEqual([enabled.origin.kind, enabled.origin.source], ["profile", "builtin:standard"]);
  assert.equal(fieldAt(form, ["profiles", "mine", "extends"]).source.name, "profile");
});

test("a tool instance of an adapter without a hand-written form gets a form from the schema, with every key of its entry", async () => {
  const dir = project();
  const server = context(dir);
  const res = await call(server, "GET", "/api/forms/derived/instance/:instance", { params: { instance: "zz" } });
  assert.equal(res.status, 200, JSON.stringify(res));
  const form = res.json.form;
  assert.equal(form.hasForm, true);
  assert.equal(form.overlay, null);
  assert.equal(form.nativeForm, null);
  assert.deepEqual(form.instance.label, { text: "zizmor (GitHub Actions security)", secondary: "zz" });
  assert.equal(form.file.file, ".jgates/tools.yml");
  for (const key of leafPaths(parse(TOOLS).tools.zz, ["tools", "zz"])) assert.ok(fieldAt(form, key), `no field for ${key.join(".")}`);
  const persona = fieldAt(form, ["tools", "zz", "persona"]);
  assert.deepEqual([persona.widget, persona.state, persona.value, persona.origin.kind], ["radio", "set", "pedantic", "file"]);
  assert.deepEqual(persona.link, { file: ".jgates/tools.yml", path: "tools.zz.persona", line: 6, column: 5 });
  const minSeverity = fieldAt(form, ["tools", "zz", "minSeverity"]);
  assert.equal(minSeverity.state, "inherited");
  assert.equal(minSeverity.widget, "radio");
  assert.equal(fieldAt(form, ["tools", "zz", "offline"]).widget, "switch");
  const custom = fieldAt(form, ["tools", "zz", "handWritten"]);
  assert.deepEqual([custom.state, custom.widget, custom.text], ["custom", "text", "yes"]);
  assert.equal(custom.diagnostics[0].code, "UNKNOWN_KEY");
  // Only zizmor's settings are listed, not every adapter's.
  assert.equal(fieldAt(form, ["tools", "zz", "spiderMinutes"]), undefined);
  // Capabilities are offered by catalogue name.
  const caps = fieldAt(form, ["tools", "zz", "capabilities"]);
  assert.equal(caps.widget, "checklist");
  assert.deepEqual(caps.options.find((o) => o.value === "ci-cd"), { value: "ci-cd", label: "CI/CD security", secondary: "ci-cd" });

  // semgrep has no hand-written form either; its rulePack is an enum.
  const sem = (await call(server, "GET", "/api/forms/derived/instance/:instance", { params: { instance: "sem" } })).json.form;
  assert.deepEqual([fieldAt(sem, ["tools", "sem", "rulePack"]).widget, fieldAt(sem, ["tools", "sem", "rulePack"]).value], ["radio", "jgates"]);
});

test("an instance a template declares shows the template's values with origin template", async () => {
  const dir = project();
  const server = context(dir);
  const index = (await call(server, "GET", "/api/forms/derived/index")).json;
  const ruff = index.instances.find((i) => i.id === "ruff");
  assert.ok(ruff, JSON.stringify(index.instances.map((i) => i.id)));
  assert.deepEqual([ruff.declaredIn, ruff.hasForm, ruff.nativeForm], ["template", true, "ruff"]);
  assert.ok(index.instances.every((i) => i.hasForm === true));
  const form = (await call(server, "GET", "/api/forms/derived/instance/:instance", { params: { instance: "ruff" } })).json.form;
  assert.equal(form.instance.declaredIn, "template");
  const enabled = fieldAt(form, ["tools", "ruff", "enabled"]);
  assert.deepEqual([enabled.state, enabled.value, enabled.origin.kind, enabled.origin.source], ["inherited", true, "template", "builtin:python"]);
});

test("the hand-written forms still apply as overlays: labels, order and options over the derived fields, the native-file forms named", async () => {
  const dir = project();
  const server = context(dir);
  const expected = { "ruff-main": "ruff", "pytest-main": "pytest", "web-zap": "zap", st: "schemathesis", oas: "oasdiff", drift: "migration-drift", perf: "performance", e2e: "playwright" };
  for (const [instance, adapter] of Object.entries(expected)) {
    const res = await call(server, "GET", "/api/forms/derived/instance/:instance", { params: { instance } });
    assert.equal(res.status, 200, `${instance}: ${JSON.stringify(res)}`);
    const form = res.json.form;
    if (adapter === "ruff" || adapter === "pytest") {
      assert.equal(form.nativeForm?.id, adapter, instance);
      assert.ok(form.nativeForm.documents.length > 0);
    } else {
      assert.equal(form.overlay?.id, adapter, instance);
      const ordered = form.fields.filter((f) => typeof f.order === "number");
      assert.ok(ordered.length > 0, `${instance}: no field took the overlay`);
      assert.ok(ordered.every((f) => f.label.text !== f.label.secondary), `${instance}: overlay labels`);
      assert.deepEqual(form.fields.slice(0, ordered.length), ordered, `${instance}: the overlay's fields come first, in its order`);
    }
  }
  const zap = (await call(server, "GET", "/api/forms/derived/instance/:instance", { params: { instance: "web-zap" } })).json.form;
  const mode = fieldAt(zap, ["tools", "web-zap", "mode"]);
  assert.deepEqual([mode.label.text, mode.widget, mode.value, mode.options.map((o) => o.label)], ["Scan mode", "radio", "passive", ["Passive (recommended)", "Active (attacks the target)"]]);
  assert.ok(zap.rules.length > 0);
  // Keys of the schema the overlay leaves out still have their control (auth is in the schema, not in the overlay).
  assert.ok(fieldAt(zap, ["tools", "web-zap", "auth", "header"]));
});

test("one key at a time: set and remove keep comments, order and unknown keys byte for byte; preview writes nothing; a moved revision is a conflict", async () => {
  const dir = project();
  const server = context(dir);
  const file = path.join(dir, "jgates.yml");
  const revision = async () => (await call(server, "GET", "/api/forms/derived/file", { query: { file: "jgates.yml" } })).json.form.file.revision;

  // Preview: the diff, nothing written.
  let rev = await revision();
  const preview = await call(server, "POST", "/api/forms/derived/key/preview", { body: { file: "jgates.yml", path: ["execution", "failFast"], op: "set", value: true, expectedRevision: rev } });
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.match(preview.json.preview.diff, /\+ {2}failFast: true/);
  assert.equal(preview.json.preview.writable, true);
  assert.equal(fs.readFileSync(file, "utf8"), ROOT, "a preview writes nothing");

  // Set: one line added after the last key of execution, every other byte the same.
  const set = await call(server, "PUT", "/api/forms/derived/key", { body: { file: "jgates.yml", path: ["execution", "failFast"], op: "set", value: true, expectedRevision: rev } });
  assert.equal(set.status, 200, JSON.stringify(set));
  assert.equal(set.json.save.status, "saved");
  const afterSet = ROOT.replace("  mystery: 3\n", "  mystery: 3\n  failFast: true\n");
  assert.equal(fs.readFileSync(file, "utf8"), afterSet);

  // A stale revision is refused and nothing changes.
  const stale = await call(server, "PUT", "/api/forms/derived/key", { body: { file: "jgates.yml", path: ["execution", "network"], op: "set", value: "allow", expectedRevision: rev } });
  assert.equal(stale.status, 409);
  assert.equal(stale.code, "REVISION_CONFLICT");
  assert.equal(fs.readFileSync(file, "utf8"), afterSet);

  // Change a value: only the value changes, its comment stays.
  rev = set.json.save.revision;
  const change = await call(server, "PUT", "/api/forms/derived/key", { body: { file: "jgates.yml", path: ["execution", "network"], op: "set", value: "allow", expectedRevision: rev } });
  assert.equal(change.status, 200, JSON.stringify(change));
  const afterChange = afterSet.replace("  network: deny   # no network", "  network: allow   # no network");
  assert.equal(fs.readFileSync(file, "utf8"), afterChange);

  // Remove: the line goes, the rest stays.
  rev = change.json.save.revision;
  const removed = await call(server, "PUT", "/api/forms/derived/key", { body: { file: "jgates.yml", path: ["execution", "failFast"], op: "remove", expectedRevision: rev } });
  assert.equal(removed.status, 200, JSON.stringify(removed));
  const afterRemove = afterChange.replace("  failFast: true\n", "");
  assert.equal(fs.readFileSync(file, "utf8"), afterRemove);

  // A custom key is edited as text and stays custom; a new unknown key is refused.
  rev = removed.json.save.revision;
  const custom = await call(server, "PUT", "/api/forms/derived/key", { body: { file: "jgates.yml", path: ["execution", "mystery"], op: "set", yaml: "4", expectedRevision: rev } });
  assert.equal(custom.status, 200, JSON.stringify(custom));
  const afterCustom = afterRemove.replace("  mystery: 3\n", "  mystery: 4\n");
  assert.equal(fs.readFileSync(file, "utf8"), afterCustom);
  rev = custom.json.save.revision;
  const unknown = await call(server, "PUT", "/api/forms/derived/key", { body: { file: "jgates.yml", path: ["execution", "brandNew"], op: "set", value: 1, expectedRevision: rev } });
  assert.equal(unknown.status, 422);
  assert.equal(unknown.code, "EDIT_INVALID");
  const invalid = await call(server, "PUT", "/api/forms/derived/key", { body: { file: "jgates.yml", path: ["execution", "concurrency"], op: "set", value: 0, expectedRevision: rev } });
  assert.equal(invalid.status, 422);
  assert.equal(fs.readFileSync(file, "utf8"), afterCustom);

  // A block left empty by a removal goes with it (no `budgets: {}` behind).
  const budget = await call(server, "PUT", "/api/forms/derived/key", { body: { file: "jgates.yml", path: ["execution", "budgets", "totalSeconds"], op: "set", value: 600, expectedRevision: rev } });
  assert.equal(budget.status, 200, JSON.stringify(budget));
  const unbudget = await call(server, "PUT", "/api/forms/derived/key", { body: { file: "jgates.yml", path: ["execution", "budgets", "totalSeconds"], op: "remove", expectedRevision: budget.json.save.revision } });
  assert.equal(unbudget.status, 200, JSON.stringify(unbudget));
  assert.deepEqual(unbudget.json.save.pruned, ["execution.budgets"]);
  assert.equal(fs.readFileSync(file, "utf8"), afterCustom);
});

test("the first key of an instance a template declares creates its entry with the template's adapter; the rest of tools.yml stays", async () => {
  const dir = project();
  const server = context(dir);
  const file = path.join(dir, ".jgates", "tools.yml");
  const form = (await call(server, "GET", "/api/forms/derived/instance/:instance", { params: { instance: "ruff" } })).json.form;
  const res = await call(server, "PUT", "/api/forms/derived/key", { body: { file: ".jgates/tools.yml", path: ["tools", "ruff", "timeoutSeconds"], op: "set", value: 120, expectedRevision: form.file.revision } });
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(fs.readFileSync(file, "utf8"), `${TOOLS}  ruff:\n    adapter: ruff\n    timeoutSeconds: 120\n`);
  const after = (await call(server, "GET", "/api/forms/derived/instance/:instance", { params: { instance: "ruff" } })).json.form;
  assert.equal(after.instance.declaredIn, "tools-file");
  assert.deepEqual([fieldAt(after, ["tools", "ruff", "timeoutSeconds"]).value, fieldAt(after, ["tools", "ruff", "timeoutSeconds"]).origin.kind], [120, "file"]);

  // Set a setting of a hand-written instance: the comment and the unknown key next to it stay.
  const zz = (await call(server, "GET", "/api/forms/derived/instance/:instance", { params: { instance: "zz" } })).json.form;
  const edit = await call(server, "PUT", "/api/forms/derived/key", { body: { file: ".jgates/tools.yml", path: ["tools", "zz", "persona"], op: "set", value: "auditor", expectedRevision: zz.file.revision } });
  assert.equal(edit.status, 200, JSON.stringify(edit));
  assert.equal(fs.readFileSync(file, "utf8"), `${TOOLS.replace("persona: pedantic", "persona: auditor")}  ruff:\n    adapter: ruff\n    timeoutSeconds: 120\n`);
});

test("files outside the configuration and the lock are refused", async () => {
  const dir = project();
  const server = context(dir);
  const lock = await call(server, "PUT", "/api/forms/derived/key", { body: { file: ".jgates/lock.json", path: ["x"], op: "remove", expectedRevision: null } });
  assert.deepEqual([lock.status, lock.code], [403, "FILE_GENERATED"]);
  const outside = await call(server, "GET", "/api/forms/derived/file", { query: { file: ".jgates/other.yml" } });
  assert.equal(outside.status, 400);
  assert.equal(outside.code, "FILE_NOT_CONFIG");
  const missing = await call(server, "GET", "/api/forms/derived/instance/:instance", { params: { instance: "nope" } });
  assert.equal(missing.status, 404);
});
