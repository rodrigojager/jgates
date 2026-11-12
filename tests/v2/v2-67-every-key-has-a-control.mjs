import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-67 (fake engine): every configuration key with a known value set has a control (ADR-0009,
// PLAN-config-editing.md section 2). A walk over jgates/schemas/config/*.schema.json and over the settings of every
// adapter (tools.<id> of tools.schema.json) lists each enum, boolean, bounded number and array-of-enum key; through
// the forms API (GET /api/forms/derived/schema, run in this process) each one must have a field with the matching
// control: select or radio, switch, number with the same limits, checklist with the same values. The walk is the
// test's own, independent of the form engine, and it is checked against a schema copy with planted keys: the planted
// keys, and only those, come out without a field.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMAS = path.join(root, "jgates", "schemas", "config");
const dist = (p) => pathToFileURL(path.join(root, "jgates", "dist", p)).href;
const VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const made = [];
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Resolves a local $ref (#/$defs/...), keeping the sibling keywords. */
function deref(node, schemaRoot, depth = 0) {
  if (!isObject(node) || typeof node.$ref !== "string" || depth > 20) return node;
  let target = schemaRoot;
  for (const seg of node.$ref.slice(2).split("/")) target = target?.[seg];
  const { $ref, ...rest } = node;
  return { ...deref(target, schemaRoot, depth + 1), ...rest };
}

const types = (s) => (Array.isArray(s.type) ? s.type : typeof s.type === "string" ? [s.type] : []);

/** What control a schema node asks for, when it is one of the four kinds with a known value set. */
function kindOf(s, schemaRoot) {
  if (Array.isArray(s.enum)) return { kind: "enum", values: s.enum.filter((v) => v !== null) };
  const t = types(s);
  if (t.length > 0 && t.every((x) => x === "boolean" || x === "null") && t.includes("boolean")) return { kind: "boolean" };
  if (t.some((x) => x === "integer" || x === "number") && t.every((x) => x === "integer" || x === "number" || x === "null")) {
    const limits = {};
    for (const k of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) if (typeof s[k] === "number") limits[k] = s[k];
    if (Object.keys(limits).length > 0) return { kind: "bounded", limits };
  }
  if (t.includes("array") && isObject(s.items)) {
    const items = deref(s.items, schemaRoot);
    if (Array.isArray(items.enum)) return { kind: "enum-array", values: items.enum.filter((v) => v !== null) };
  }
  return null;
}

/**
 * Every key of a schema with a known value set, as patterns: map keys are "*", list items "[]", the shapes of a
 * oneOf/anyOf and the branches of allOf/if/then are walked at the same path.
 */
function expectedKeys(schema, schemaRoot = schema, base = "") {
  const out = new Map();
  const join = (prefix, key) => (key === "[]" ? `${prefix}[]` : prefix === "" ? key : `${prefix}.${key}`);
  const walk = (raw, at, depth) => {
    if (depth > 30) return;
    const s = deref(raw, schemaRoot);
    if (!isObject(s)) return;
    const k = at === "" ? null : kindOf(s, schemaRoot);
    if (k) out.set(`${at}|${k.kind}`, { pattern: at, ...k });
    for (const [name, child] of Object.entries(isObject(s.properties) ? s.properties : {})) walk(child, join(at, name), depth + 1);
    if (isObject(s.additionalProperties)) walk(s.additionalProperties, join(at, "*"), depth + 1);
    // The values of a list of known values are that list's checklist, not keys of their own.
    if (isObject(s.items) && k?.kind !== "enum-array") walk(s.items, join(at, "[]"), depth + 1);
    for (const key of ["oneOf", "anyOf", "allOf"]) if (Array.isArray(s[key])) for (const b of s[key]) walk(b, at, depth + 1);
    for (const key of ["then", "else"]) if (isObject(s[key])) walk(s[key], at, depth + 1);
  };
  walk(schema, base, 0);
  return [...out.values()];
}

const sameValues = (a, b) => a.length === b.length && a.every((v) => b.includes(v));
const sameLimits = (field, limits) => Object.entries(limits).every(([k, v]) => field?.[k] === v);

/** Whether a field (or one of the shapes of a choice field) is the control a key needs. */
function controls(field, key) {
  const candidates = [field, ...(field.shapes ?? [])];
  return candidates.some((c) => {
    const values = (c.options ?? []).map((o) => o.value);
    if (key.kind === "enum") return (c.widget === "select" || c.widget === "radio") && sameValues(values, key.values);
    if (key.kind === "boolean") return c.widget === "switch";
    if (key.kind === "bounded") return c.widget === "number" && sameLimits(c.limits, key.limits);
    if (key.kind === "enum-array") return c.widget === "checklist" && sameValues(values, key.values);
    return false;
  });
}

/** The keys of `expected` that no field of the forms controls. */
function missing(expected, forms) {
  const fields = forms.flatMap((f) => f.fields);
  return expected.filter((key) => !fields.some((f) => f.pattern === key.pattern && controls(f, key))).map((k) => `${k.pattern} (${k.kind})`);
}

// ---- the forms API, in this process -----------------------------------------------------------------------------------

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jg-v2-67-home-")));
const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jg-v2-67-proj-")));
made.push(home, projectDir);
const server = { projectDir, policyMode: false, workspace: { id: "ws_v267formscontrol00", path: projectDir, name: "v2-67" }, home, version: VERSION, plans: new Map(), log: () => undefined };

let schemaRoute;
async function api(query) {
  if (!schemaRoute) {
    const { routes } = await import(dist("server/routes/forms.js"));
    schemaRoute = routes.find((r) => r.method === "GET" && r.path === "/api/forms/derived/schema");
    assert.ok(schemaRoute, "GET /api/forms/derived/schema");
  }
  const res = await schemaRoute.handler({ params: {}, query, body: undefined, session: null, server, raw: null });
  assert.equal(res.status, 200);
  return res.json;
}

const schemaFiles = fs
  .readdirSync(SCHEMAS)
  .filter((f) => f.endsWith(".schema.json"))
  .sort();
const read = (file) => JSON.parse(fs.readFileSync(path.join(SCHEMAS, file), "utf8"));
const instanceOf = (tools) => tools.properties.tools.additionalProperties;

test("V2-67 every enum, boolean, bounded number and array-of-enum key of every configuration schema has its control in the forms API", async () => {
  const listed = await api({});
  assert.deepEqual(listed.schemas.map((s) => s.schema), schemaFiles, "the API lists every schema of the folder");
  let total = 0;
  for (const file of schemaFiles) {
    const expected = expectedKeys(read(file));
    total += expected.length;
    const { form } = await api({ schema: file });
    assert.deepEqual(missing(expected, [form]), [], `${file}: keys without a control`);
  }
  assert.ok(total > 100, `the walk found the keys (${total})`);
});

test("V2-67 every adapter's settings have their controls: every adapter of the catalogue has a form, and together they cover every setting of tools.<id>", async () => {
  const { builtinManifests } = await import(dist("adapters/manifests.js"));
  const ids = builtinManifests().map((m) => m.id);
  const listed = await api({});
  assert.deepEqual(listed.adapters.map((a) => a.id).sort(), [...ids].sort(), "one form per adapter of the catalogue");
  const tools = read("tools.schema.json");
  const settings = expectedKeys(instanceOf(tools), tools, "tools.*");
  assert.ok(settings.length > 30, `adapter settings found (${settings.length})`);
  const forms = [];
  for (const id of ids) {
    const { form } = await api({ adapter: id });
    assert.equal(form.adapter.id, id);
    forms.push(form);
    // The settings of every instance are in every adapter's form.
    for (const key of ["enabled", "required"]) assert.ok(form.fields.some((f) => f.pattern === `tools.*.${key}` && f.widget === "switch"), `${id}: ${key}`);
    assert.ok(form.fields.some((f) => f.pattern === "tools.*.timeoutSeconds" && f.widget === "number" && f.limits.minimum === 1), `${id}: timeoutSeconds`);
  }
  assert.deepEqual(missing(settings, forms), [], "adapter settings without a control");
  // Each adapter's own enums are in its form (zizmor's persona, zap's mode, codeql's suite).
  const of = (id) => forms.find((f) => f.adapter.id === id);
  assert.ok(of("zizmor").fields.some((f) => f.pattern === "tools.*.persona" && f.widget === "radio"));
  assert.ok(of("zap").fields.some((f) => f.pattern === "tools.*.mode" && f.widget === "radio"));
  assert.ok(of("codeql").fields.some((f) => f.pattern === "tools.*.suite"));
  assert.ok(!of("zizmor").fields.some((f) => f.pattern === "tools.*.mode"), "zap's mode is not a zizmor setting");
});

test("V2-67 the check fails when a key is planted in a schema copy without a field", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jg-v2-67-copy-")));
  made.push(dir);
  const rootSchema = structuredClone(read("jgates.schema.json"));
  rootSchema.properties.execution.properties.plantedSwitch = { type: "boolean" };
  rootSchema.properties.selection.properties.plantedMode = { enum: ["one", "two", "three", "four", "five"] };
  rootSchema.properties.services.properties.plantedLimit = { type: "integer", minimum: 2, maximum: 9 };
  const tools = structuredClone(read("tools.schema.json"));
  instanceOf(tools).properties.plantedChecks = { description: "zap: planted.", type: "array", items: { enum: ["a", "b"] } };
  fs.writeFileSync(path.join(dir, "jgates.schema.json"), JSON.stringify(rootSchema));
  fs.writeFileSync(path.join(dir, "tools.schema.json"), JSON.stringify(tools));
  const copy = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));

  const rootForm = (await api({ schema: "jgates.schema.json" })).form;
  assert.deepEqual(missing(expectedKeys(copy("jgates.schema.json")), [rootForm]).sort(), ["execution.plantedSwitch (boolean)", "selection.plantedMode (enum)", "services.plantedLimit (bounded)"]);
  const toolsCopy = copy("tools.schema.json");
  const zap = (await api({ adapter: "zap" })).form;
  const toolsForm = (await api({ schema: "tools.schema.json" })).form;
  assert.deepEqual(missing(expectedKeys(instanceOf(toolsCopy), toolsCopy, "tools.*"), [zap, toolsForm]), ["tools.*.plantedChecks (enum-array)"]);
  // A changed limit is caught as well: the control must carry the schema's limits.
  rootSchema.properties.execution.properties.concurrency.maximum = 64;
  assert.deepEqual(missing(expectedKeys(rootSchema), [rootForm]).filter((k) => k.startsWith("execution.concurrency")), ["execution.concurrency (bounded)"]);
});
