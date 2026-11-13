import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

// V2-66 (fake engine): a hand-written configuration survives every guided screen (PLAN-config-editing.md section 6).
// The fixture jgates/tests/fixtures/handwritten is a project whose YAML was written by hand: a ZAP instance with a key
// its hand-written form does not know (auth), a zizmor instance (no hand-written form), an own tool with a command and
// arguments, a profile with `extends` and selectors the check tree has no row for (pii:, architecture:), a template file
// of the project with its own command, comments in every file, services.profiles, and one invalid key (hook.modo in
// .jgates/pii.yml). Through the routes the screens call, run in this process:
//   - the forms API returns every key present in every file (a field or a group at its key path), the invalid key as a
//     custom field with its diagnostic and line, and the screens' read routes answer with what the files hold even while
//     that key makes the configuration invalid;
//   - one change through each guided write route changes exactly that key: the file is compared byte for byte with the
//     original plus the expected edit, and every other file of the project is byte for byte the same.
// The screens themselves are in jgates/tests/ui/handwritten.spec.ts.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = path.join(root, "jgates", "tests", "fixtures", "handwritten");
const dist = (p) => pathToFileURL(path.join(root, "jgates", "dist", p)).href;
const VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const CONFIG_FILES = [
  "jgates.yml",
  ".jgates/tools.yml",
  ".jgates/profiles.yml",
  ".jgates/workspace.yml",
  ".jgates/pii.yml",
  ".jgates/policy.yml",
  ".jgates/architecture.yml",
  ".jgates/dependencies.yml",
  ".jgates/templates/team-extras.yml",
];

const made = [];
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A fresh copy of the fixture, with its own data folder, and the server context the routes read. */
function project() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jg-v2-66-home-")));
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jg-v2-66-proj-")));
  made.push(home, projectDir);
  fs.cpSync(FIXTURE, projectDir, { recursive: true });
  const server = { projectDir, policyMode: false, workspace: { id: "ws_v266handwritten000", path: projectDir, name: "v2-66" }, home, version: VERSION, plans: new Map(), log: () => undefined };
  return { projectDir, server };
}

/** Every file of the project (relative path, forward slashes) with its bytes. */
function snapshot(dir) {
  const out = new Map();
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else out.set(child, fs.readFileSync(path.join(dir, child)));
    }
  };
  walk("");
  return out;
}

const modules = new Map();
async function call(server, mod, method, p, { params = {}, query = {}, body } = {}) {
  if (!modules.has(mod)) modules.set(mod, (await import(dist(`server/routes/${mod}.js`))).routes);
  const route = modules.get(mod).find((r) => r.method === method && r.path === p);
  assert.ok(route, `${method} ${p}`);
  try {
    return await route.handler({ params, query, body, session: null, server, raw: null });
  } catch (error) {
    if (typeof error?.status !== "number") throw error;
    return { status: error.status, json: { code: error.code, message: error.message, details: error.details } };
  }
}

/** The answer of a route that must succeed. */
async function ok(server, mod, method, p, options) {
  const res = await call(server, mod, method, p, options);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${p}: ${res.status} ${JSON.stringify(res.json).slice(0, 600)}`);
  return res.json;
}

/** A line-oriented diff for the failure message. */
function diffLines(a, b) {
  const x = a.split("\n");
  const y = b.split("\n");
  const out = [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) out.push(`${i + 1}: - ${JSON.stringify(x[i])}\n${i + 1}: + ${JSON.stringify(y[i])}`);
  return out.slice(0, 12).join("\n");
}

/**
 * After one change: `file` is the original with each [from, to] replaced (each `from` occurs exactly once), and every
 * other file of the project has the same bytes.
 */
function assertOnly(dir, before, file, replacements, what) {
  const after = snapshot(dir);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `${what}: no file created or removed`);
  let expected = before.get(file).toString("utf8");
  for (const [from, to] of replacements) {
    assert.equal(expected.split(from).length, 2, `${what}: the fixture holds ${JSON.stringify(from)} once`);
    expected = expected.replace(from, to);
  }
  const actual = after.get(file).toString("utf8");
  assert.ok(actual === expected, `${what}: ${file} changed beyond the edited key\n${diffLines(expected, actual)}`);
  for (const [other, bytes] of before) if (other !== file) assert.ok(bytes.equals(after.get(other)), `${what}: ${other} changed`);
}

/** Every key path of a parsed YAML document: [path, value] for each mapping key and list item, depth first. */
function keyPaths(value, prefix = []) {
  const out = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      if (item !== null && typeof item === "object") {
        out.push([[...prefix, i], item]);
        out.push(...keyPaths(item, [...prefix, i]));
      }
    });
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push([[...prefix, k], v]);
      // A list of scalars is one field (a list or checklist control), not a key per item.
      if (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")) continue;
      out.push(...keyPaths(v, [...prefix, k]));
    }
  }
  return out;
}

const pathKey = (p) => JSON.stringify(p);

/** The key paths of `doc` (under `under`) that the form has neither a field nor a group for. */
function uncovered(form, doc, under = []) {
  const at = new Set([...form.fields.map((f) => pathKey(f.path)), ...form.groups.map((g) => pathKey(g.path))]);
  // A value edited as one YAML text (an open object) holds its own keys.
  const whole = form.fields.filter((f) => f.widget === "yaml" || f.state === "custom").map((f) => f.path);
  const inside = (p) => whole.some((w) => w.length < p.length && w.every((s, i) => s === p[i]));
  let node = doc;
  for (const s of under) node = node?.[s];
  return keyPaths(node, under)
    .map(([p]) => p)
    .filter((p) => !at.has(pathKey(p)) && !inside(p))
    .map((p) => p.join("."));
}

test("V2-66 every key of the hand-written files is returned by the forms API, the invalid one as a custom field with its line", async () => {
  const { projectDir, server } = project();
  for (const file of CONFIG_FILES) {
    const { form } = await ok(server, "forms", "GET", "/api/forms/derived/file", { query: { file } });
    assert.equal(form.available, true, `${file}: the form is available`);
    assert.equal(form.file.editable, true, `${file}: the form is editable`);
    const doc = parseYaml(fs.readFileSync(path.join(projectDir, file), "utf8"));
    assert.deepEqual(uncovered(form, doc), [], `${file}: keys without a field or group`);
  }
  // The instances of tools.yml, each in its own form (the tool pages).
  const tools = parseYaml(fs.readFileSync(path.join(projectDir, ".jgates/tools.yml"), "utf8"));
  for (const instance of Object.keys(tools.tools)) {
    const { form } = await ok(server, "forms", "GET", "/api/forms/derived/instance/:instance", { params: { instance } });
    assert.deepEqual(uncovered(form, tools, ["tools", instance]), [], `tool ${instance}: keys without a field or group`);
  }
  const dast = (await ok(server, "forms", "GET", "/api/forms/derived/instance/:instance", { params: { instance: "dast" } })).form;
  for (const key of ["header", "valueEnv"]) assert.ok(dast.fields.some((f) => f.id === `tools.dast.auth.${key}` && f.state === "set"), `ZAP auth.${key} has a field`);

  // The invalid key: a custom field, with its diagnostic and line, and a link to that line.
  const pii = (await ok(server, "forms", "GET", "/api/forms/derived/file", { query: { file: ".jgates/pii.yml" } })).form;
  const typo = pii.fields.find((f) => f.id === "hook.modo");
  assert.ok(typo, "hook.modo is a field");
  assert.equal(typo.state, "custom");
  assert.equal(typo.link.line, 15);
  assert.ok(typo.diagnostics.some((d) => d.code === "UNKNOWN_KEY" && d.line === 15), JSON.stringify(typo.diagnostics));
  assert.ok(pii.diagnostics.some((d) => d.path === "hook.modo" && d.line === 15));
});

test("V2-66 the read routes of the guided screens answer with what the files hold while one key makes the configuration invalid", async () => {
  const { server } = project();
  // Perfil: the profile of the project and its hand-written selectors, with the diagnostic of the invalid key.
  const list = await ok(server, "profiles", "GET", "/api/profiles");
  assert.ok(list.profiles.some((p) => p.id === "team" && p.origin === "project"), "the team profile is listed");
  const view = await ok(server, "config", "GET", "/api/config/profile");
  assert.equal(view.profile.id, "team");
  assert.ok(view.diagnostics.some((d) => d.file === ".jgates/pii.yml" && d.path === "hook.modo" && d.line === 15), `the view names the invalid key: ${JSON.stringify(view.diagnostics)}`);
  // Execução: the values of jgates.yml, not the defaults.
  const execution = await ok(server, "execution", "GET", "/api/config/execution");
  const field = (key) => execution.fields.find((f) => f.key === key);
  assert.equal(field("concurrency").value, 2);
  assert.equal(field("concurrency").explicit, true);
  assert.equal(field("dataMaxAgeDays").value, 14);
  assert.ok(execution.diagnostics.some((d) => d.path === "hook.modo"), "Execução names the invalid key");
  // Ferramentas: the tools the templates bring and the instances of tools.yml.
  const effective = await ok(server, "tools", "GET", "/api/tool-effective");
  assert.ok(effective.tools.length > 0, `the effective tools are listed: ${JSON.stringify(effective).slice(0, 300)}`);
  for (const id of ["dast", "workflows", "my-lint"]) assert.ok(effective.tools.some((t) => t.tool === id), `tool ${id} is listed`);
  assert.ok(effective.diagnostics.some((d) => d.path === "hook.modo"), "Ferramentas names the invalid key");
  // The tool pages: the target of the ZAP and the command of the own tool are read from the files, not lost.
  const { availability } = await ok(server, "tools", "GET", "/api/tool-availability");
  assert.ok(!/alvo|target/i.test(availability.dast?.reason ?? ""), `dast: ${JSON.stringify(availability.dast)}`);
  assert.ok(!/command|executável/i.test(availability["my-lint"]?.reason ?? ""), `my-lint: ${JSON.stringify(availability["my-lint"])}`);
  // Templates, Serviços, Workspace, Dados pessoais, Arquitetura.
  const templates = await ok(server, "templates", "GET", "/api/config/templates");
  assert.ok(templates.templates.some((t) => t.id === "team-extras" && t.origin === "project"));
  const services = await ok(server, "services", "GET", "/api/services");
  assert.deepEqual(services.config.profiles, ["backend", "debug"]);
  const architecture = await ok(server, "architecture", "GET", "/api/config/architecture");
  assert.ok(architecture.rules.some((r) => r.id === "domain-isolation"));
  const pii = await ok(server, "pii", "GET", "/api/pii");
  assert.equal(pii.entities.find((e) => e.id === "cpf").inFile.severity, "critical");
});

test("V2-66 one key per file through the derived forms changes only that key", async () => {
  const { projectDir, server } = project();
  const cases = [
    { file: "jgates.yml", path: ["execution", "network"], value: "deny", from: "  network: explicit\n", to: "  network: deny\n" },
    { file: ".jgates/tools.yml", path: ["tools", "workflows", "persona"], value: "auditor", from: "    persona: pedantic\n", to: "    persona: auditor\n" },
    { file: ".jgates/tools.yml", path: ["tools", "dast", "auth", "valueEnv"], value: "ZAP_TOKEN", from: "valueEnv: DAST_TOKEN\n", to: "valueEnv: ZAP_TOKEN\n" },
    { file: ".jgates/tools.yml", path: ["tools", "my-lint", "timeoutSeconds"], value: 180, from: "    timeoutSeconds: 120\n", to: "    timeoutSeconds: 180\n" },
    { file: ".jgates/profiles.yml", path: ["profiles", "team", "label"], value: "Equipe", from: "    label: Time\n", to: "    label: Equipe\n" },
    { file: ".jgates/profiles.yml", path: ["profiles", "team", "checks", "pii:cpf", "enabled"], value: true, from: "      pii:cpf:\n        enabled: false\n", to: "      pii:cpf:\n        enabled: true\n" },
    { file: ".jgates/workspace.yml", path: ["discovery", "mode"], value: "explicit", from: "  mode: auto\n", to: "  mode: explicit\n" },
    { file: ".jgates/pii.yml", path: ["severity"], value: "medium", from: "severity: high\n", to: "severity: medium\n" },
    { file: ".jgates/policy.yml", path: ["rules", "coverage.minimum", "threshold"], value: 80, from: "    threshold: 70\n", to: "    threshold: 80\n" },
    { file: ".jgates/architecture.yml", path: ["architecture", "rules", 0, "severity"], value: "critical", from: "      severity: high\n", to: "      severity: critical\n" },
    { file: ".jgates/dependencies.yml", path: ["install", "command"], value: "pip install -r requirements-dev.txt", from: "  command: pip install -r requirements.txt\n", to: "  command: pip install -r requirements-dev.txt\n" },
    { file: ".jgates/templates/team-extras.yml", path: ["priority"], value: 60, from: "priority: 50\n", to: "priority: 60\n" },
  ];
  for (const c of cases) {
    const what = `${c.file} ${c.path.join(".")}`;
    const before = snapshot(projectDir);
    const { form } = await ok(server, "forms", "GET", "/api/forms/derived/file", { query: { file: c.file } });
    await ok(server, "forms", "PUT", "/api/forms/derived/key", { body: { file: c.file, path: c.path, op: "set", value: c.value, expectedRevision: form.file.revision } });
    assertOnly(projectDir, before, c.file, [[c.from, c.to]], what);
  }
  // The custom key, edited as text, and then removed: only its line changes.
  const before = snapshot(projectDir);
  const pii = (await ok(server, "forms", "GET", "/api/forms/derived/file", { query: { file: ".jgates/pii.yml" } })).form;
  await ok(server, "forms", "PUT", "/api/forms/derived/key", { body: { file: ".jgates/pii.yml", path: ["hook", "modo"], op: "remove", expectedRevision: pii.file.revision } });
  assertOnly(projectDir, before, ".jgates/pii.yml", [["  modo: fix              # a typo: this key does not exist\n", ""]], "remove hook.modo");
});

test("V2-66 Execução, Perfil and Política write one key each", async () => {
  const { projectDir, server } = project();
  let before = snapshot(projectDir);
  const execution = await ok(server, "execution", "GET", "/api/config/execution");
  await ok(server, "execution", "PUT", "/api/config/execution", { body: { expectedRevision: execution.revision, changes: { concurrency: 4 } } });
  assertOnly(projectDir, before, "jgates.yml", [["  concurrency: 2           # two checks", "  concurrency: 4           # two checks"]], "Execução concurrency");

  before = snapshot(projectDir);
  await ok(server, "config", "PUT", "/api/config/selection", { body: { profile: "team", changes: [{ selector: "capability:secrets", enabled: false }] } });
  assertOnly(projectDir, before, ".jgates/profiles.yml", [["      capability:secrets:\n        enabled: true\n", "      capability:secrets:\n        enabled: false\n"]], "Perfil check switch");

  before = snapshot(projectDir);
  await ok(server, "profiles", "PUT", "/api/profiles/:id/rename", { params: { id: "quick" }, body: { to: "fast" } });
  assertOnly(projectDir, before, ".jgates/profiles.yml", [["  quick:\n", "  fast:\n"]], "Perfil rename");

  before = snapshot(projectDir);
  await ok(server, "profiles", "PUT", "/api/profiles/:id/default", { params: { id: "fast" }, body: {} });
  assertOnly(projectDir, before, "jgates.yml", [["  profile: team            # our own", "  profile: fast            # our own"]], "Perfil default");

  before = snapshot(projectDir);
  await ok(server, "config", "PUT", "/api/config/policy", { body: { changes: [{ control: "coverage", value: 85 }] } });
  assertOnly(projectDir, before, ".jgates/policy.yml", [["    threshold: 70\n", "    threshold: 85\n"]], "Política coverage");
});

test("V2-66 Ferramentas: the settings form, the own tool's six steps and a rename change only their keys", async () => {
  const { projectDir, server } = project();
  let before = snapshot(projectDir);
  const form = (await ok(server, "forms", "GET", "/api/forms/:instance", { params: { instance: "dast" } })).form;
  await ok(server, "forms", "PUT", "/api/forms/:instance", { params: { instance: "dast" }, body: { expectedRevision: form.revision, intents: [{ field: "blockingRisk", op: "set", value: "medium" }] } });
  assertOnly(projectDir, before, ".jgates/tools.yml", [["    blockingRisk: high\n", "    blockingRisk: medium\n"]], "ZAP settings form");

  // The own tool, edited through the six steps with only the timeout changed.
  before = snapshot(projectDir);
  const { own } = await ok(server, "tools", "GET", "/api/tools/:instance/own", { params: { instance: "my-lint" } });
  const { id, image, ...rest } = own;
  const body = { id, ...(image ? { image } : {}), command: rest.command, args: rest.args, report: rest.report, capabilities: rest.capabilities, network: rest.network, timeoutSeconds: 300, replace: true };
  await ok(server, "tools", "POST", "/api/tools/custom/save", { body });
  assertOnly(projectDir, before, ".jgates/tools.yml", [["    timeoutSeconds: 120\n", "    timeoutSeconds: 300\n"]], "own tool edit");

  before = snapshot(projectDir);
  await ok(server, "tools", "PUT", "/api/tools/:instance", { params: { instance: "workflows" }, body: { name: "gh-workflows" } });
  assertOnly(projectDir, before, ".jgates/tools.yml", [["  workflows:\n", "  gh-workflows:\n"]], "tool rename");
});

test("V2-66 Templates: the stepper edit and the switch change only their keys", async () => {
  const { projectDir, server } = project();
  let before = snapshot(projectDir);
  const detail = await ok(server, "templates", "GET", "/api/config/templates/:id", { params: { id: "team-extras" } });
  const model = detail.model;
  assert.ok(model, "the hand-written template has the stepper's model");
  const list = await ok(server, "templates", "GET", "/api/config/templates");
  await ok(server, "templates", "PUT", "/api/config/templates/:id", {
    params: { id: "team-extras" },
    body: { label: model.label, languages: model.languages, frameworks: model.frameworks, command: ["python3", ...model.command.slice(1)], capability: model.capability, effects: model.effects, evidence: model.evidence, expectedRevision: list.revision },
  });
  assertOnly(projectDir, before, ".jgates/templates/team-extras.yml", [["      command: python\n", "      command: python3\n"]], "template stepper edit");

  before = snapshot(projectDir);
  const again = await ok(server, "templates", "GET", "/api/config/templates");
  await ok(server, "templates", "PUT", "/api/config/templates/:id/enabled", { params: { id: "team-extras" }, body: { enabled: false, expectedRevision: again.revision } });
  assertOnly(projectDir, before, "jgates.yml", [["    priority: 50\n", "    priority: 50\n    enabled: false\n"]], "template switch");
});

test("V2-66 Arquitetura, Serviços, Workspace and Dados pessoais write one key each", async () => {
  const { projectDir, server } = project();
  let before = snapshot(projectDir);
  let architecture = await ok(server, "architecture", "GET", "/api/config/architecture");
  await ok(server, "architecture", "PUT", "/api/config/architecture/rules/:id", { params: { id: "domain-isolation" }, body: { enabled: false, expectedRevision: architecture.revision } });
  assertOnly(projectDir, before, ".jgates/architecture.yml", [['      message: "O domínio não importa a infraestrutura."\n', '      message: "O domínio não importa a infraestrutura."\n      enabled: false\n']], "architecture rule switch");

  // The guided editor sends every layer and rule it shows; only the added path is new.
  before = snapshot(projectDir);
  architecture = await ok(server, "architecture", "GET", "/api/config/architecture");
  const layers = architecture.layers.map((l) => ({ id: l.id, paths: l.id === "infrastructure" ? [...l.paths, "app/adapters/**"] : l.paths }));
  const rules = architecture.rules.map((r) => ({ id: r.id, from: r.from, to: r.to }));
  await ok(server, "architecture", "PUT", "/api/config/architecture", { body: { layers, rules, removeLayers: [], removeRules: [], expectedRevision: architecture.revision } });
  assertOnly(projectDir, before, ".jgates/architecture.yml", [['      paths: ["app/infrastructure/**"]', '      paths: ["app/infrastructure/**", "app/adapters/**"]']], "architecture editor");

  // Serviços: what the screen sends with only the wait time changed.
  before = snapshot(projectDir);
  const services = await ok(server, "services", "GET", "/api/services");
  assert.deepEqual(services.instanceTargets, [{ tool: "dast", target: "http://localhost:8000" }]);
  const target = services.config.target;
  await ok(server, "services", "PUT", "/api/services", {
    body: {
      compose: services.selected,
      roles: services.roles,
      target: { port: target.port, ...(target.path !== "/" ? { path: target.path } : {}), ...(target.health ? { health: target.health } : {}) },
      build: services.config.build,
      writableBinds: services.config.writableBinds,
      allowHostEffects: services.config.allowHostEffects,
      timeoutSeconds: 300,
      // The screen's default: "usar como alvo" is unchecked while it would replace the URL written by hand.
      setTargets: services.instanceTargets.every((i) => i.target === null || i.target.startsWith("service:")),
      profiles: services.config.profiles,
      revision: services.revision,
      acknowledged: true,
    },
  });
  assertOnly(projectDir, before, "jgates.yml", [["  timeoutSeconds: 90\n", "  timeoutSeconds: 300\n"]], "Serviços wait time");

  // The compose profiles, now a control of the screen: one unchecked, only that list changes (quoting and comment stay).
  before = snapshot(projectDir);
  const again = await ok(server, "services", "GET", "/api/services");
  await ok(server, "services", "PUT", "/api/services", {
    body: {
      compose: again.selected,
      roles: again.roles,
      target: { port: target.port, health: target.health },
      build: again.config.build,
      writableBinds: again.config.writableBinds,
      allowHostEffects: again.config.allowHostEffects,
      timeoutSeconds: again.config.timeoutSeconds,
      setTargets: false,
      profiles: ["backend"],
      revision: again.revision,
      acknowledged: true,
    },
  });
  assertOnly(projectDir, before, "jgates.yml", [['  profiles: [backend, "debug"]   # only', "  profiles: [backend]   # only"]], "Serviços compose profiles");

  // Workspace: the component dialog sends the declared list with one component changed.
  before = snapshot(projectDir);
  const settings = await ok(server, "workspace", "GET", "/api/workspace/settings");
  const components = settings.components.map((c) => (c.id === "app" ? { ...c, framework: "fastapi" } : c));
  await ok(server, "workspace", "PUT", "/api/workspace/settings", { body: { expectedRevision: settings.revision, components } });
  assertOnly(projectDir, before, ".jgates/workspace.yml", [["      groups: [dev]\n", "      groups: [dev]\n    framework: fastapi\n"]], "Workspace component");

  // Dados pessoais, in the file that holds the invalid key.
  before = snapshot(projectDir);
  const pii = await ok(server, "pii", "GET", "/api/pii");
  await ok(server, "pii", "PUT", "/api/pii", { body: { expectedRevision: pii.revision, edits: [{ op: "set", path: ["entities", "cpf", "severity"], value: "high" }] } });
  assertOnly(projectDir, before, ".jgates/pii.yml", [["    severity: critical   # CPFs", "    severity: high   # CPFs"]], "Dados pessoais severity");
});
