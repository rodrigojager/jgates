import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Built-in templates for the checks builtin:strict turns on "when available" and that need no project-specific input
// (Gitleaks history, Trivy licenses, CodeQL dataflow, mutmut / Stryker mutation, mypy with its defaults): activation,
// the instance they bring (never switched on by the template itself), init, and the actions of the not-applicable
// entries (add-template, configure-tool with the settings JGates cannot guess, prepare-image).

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const load = (rel) => import(pathToFileURL(path.join(dist, ...rel.split("/"))).href);
const { buildPlan, validatePlanDocument } = await load("core/plan/index.js");
const { getBuiltinTemplate } = await load("builtin/index.js");
const { planInit } = await load("core/init/index.js");
const { explainMissing, REQUIRED_SETTINGS } = await load("core/plan/availability.js");
const { translator } = await load("i18n/index.js");
const { mutationSettings } = await load("adapters/mutation/index.js");
const { codeqlSettings } = await load("adapters/codeql/index.js");
const { buildCheckSettings } = await load("adapters/build-check/index.js");
const { planUnits, MYPY_DEFAULT_ARGS } = await load("adapters/build-check/units.js");

const NEW = {
  "gitleaks-history": { adapter: "gitleaks", capability: "secrets-history" },
  "trivy-licenses": { adapter: "trivy", capability: "licenses" },
  "python-mypy-defaults": { adapter: "build-check", capability: "typecheck" },
  "python-mutmut": { adapter: "mutation", capability: "mutation" },
  "typescript-stryker": { adapter: "mutation", capability: "mutation" },
  "python-codeql": { adapter: "codeql", capability: "dataflow" },
  "typescript-codeql": { adapter: "codeql", capability: "dataflow" },
  "go-codeql": { adapter: "codeql", capability: "dataflow" },
  "dotnet-codeql": { adapter: "codeql", capability: "dataflow" },
};
/** The capabilities the Python test project gets from the new templates. */
const PYTHON_CAPS = ["secrets-history", "licenses", "typecheck", "mutation", "dataflow"];
const PYTHON_TEMPLATES = ["gitleaks-history", "trivy-licenses", "python-mypy-defaults", "python-mutmut", "python-codeql"];

/** A Python project shaped like the real test project: Git history, requirements.txt, pytest configured in pyproject. */
function pythonProject(templates) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-strict-tpl-"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
  fs.writeFileSync(path.join(dir, "requirements.txt"), "requests==2.32.3\n");
  fs.writeFileSync(path.join(dir, "app.py"), "def add(a, b):\n    return a + b\n");
  if (templates) {
    const list = templates.map((id) => `  - id: ${id}\n    source: builtin:${id}\n    activation: ${id === "base" ? "always" : "detected"}\n`).join("");
    fs.writeFileSync(path.join(dir, "jgates.yml"), `schemaVersion: 1\ntemplates:\n${list}`);
  } else fs.writeFileSync(path.join(dir, "jgates.yml"), "schemaVersion: 1\n");
  return dir;
}

function plan(dir, profile, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-strict-tpl-home-"));
  try {
    // No codeql / mutmut / mypy / container image here: every new check is either planned or TOOL_MISSING.
    const result = buildPlan(dir, { compare: false, home, profile, env: { ...process.env, JGATES_HOME: home, ...env } });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? null));
    return result.plan;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const withDir = (dir, fn) => {
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const notHere = (p) => Object.fromEntries((p.groups.notApplicableRequirements ?? []).map((n) => [n.selector.replace("capability:", ""), n]));

test("the new templates bring one instance of the right adapter and capability, never switched on by the template", () => {
  for (const [id, want] of Object.entries(NEW)) {
    const item = getBuiltinTemplate(`builtin:${id}`);
    assert.ok(item, id);
    const tools = Object.values(item.value.config.tools);
    // The Python type check brings mypy and pyright side by side; every other template brings one instance.
    assert.equal(tools.length, id === "python-mypy-defaults" ? 2 : 1, id);
    for (const tool of tools) {
      assert.equal(tool.adapter, want.adapter, id);
      assert.deepEqual(tool.capabilities, [want.capability], id);
      // Only the profile (strict: when available) turns the check on; standard and minimal stay as they were.
      assert.equal(tool.enabled, undefined, id);
    }
    assert.ok(item.value.match && (item.value.match.languages || item.value.match.files), `${id} is activated by evidence or language`);
  }
  // Sensible defaults: CodeQL for a language it supports, mutation bounded, mypy with its defaults.
  assert.equal(getBuiltinTemplate("builtin:python-codeql").value.config.tools["codeql-python"].config.language, "python");
  assert.equal(getBuiltinTemplate("builtin:typescript-codeql").value.config.tools["codeql-javascript"].config.language, "javascript-typescript");
  assert.equal(getBuiltinTemplate("builtin:python-mutmut").value.config.tools.mutmut.timeoutSeconds, 900);
  assert.equal(getBuiltinTemplate("builtin:python-mypy-defaults").value.config.tools.mypy.config.withoutConfig, "defaults");
});

test("templates added: strict plans every new check or reports it TOOL_MISSING with the shared prepare-image action; never SETUP_REQUIRED", () => {
  withDir(pythonProject(["base", "python", "python-pytest", ...PYTHON_TEMPLATES]), (dir) => {
    const p = plan(dir, "builtin:strict");
    const active = p.templates.active.map((a) => a.id);
    for (const id of PYTHON_TEMPLATES) assert.ok(active.includes(id), `${id} active: ${active.join(", ")}`);
    const na = notHere(p);
    for (const cap of PYTHON_CAPS) {
      const runs = p.groups.willRun.some((i) => i.capabilities.includes(cap));
      if (runs) continue;
      const n = na[cap];
      assert.ok(n, `${cap} is planned or reported`);
      if (cap === "dataflow") {
        // CodeQL is customer supplied, not part of the image: CUSTOMER_SUPPLIED, fixed by preparing it into its volume.
        assert.equal(n.reasonCode, "CUSTOMER_SUPPLIED", `${cap}: ${n.message}`);
        assert.equal(n.action.kind, "prepare-codeql", JSON.stringify(n));
        assert.equal(n.action.command, "jgates tools prepare-codeql");
        continue;
      }
      assert.equal(n.reasonCode, "TOOL_MISSING", `${cap}: ${n.message}`);
      // The tool is not in the tools image: the image of this release is the one shared action, never a host install.
      assert.equal(n.action.kind, "prepare-image", JSON.stringify(n));
      assert.ok(n.action.tools.length === 1 && n.action.adapter, cap);
      assert.deepEqual(n.action.docs, [], `${cap} offers no per-tool download`);
      assert.match(n.message, /JGates tools image|imagem de ferramentas do JGates/, cap);
      assert.ok(n.message.length > 0, cap);
    }
    assert.equal(p.groups.uncoveredRequirements.length, 0);
    assert.ok(!p.blockers.some((b) => b.code === "REQUIREMENT_UNCOVERED"));
    assert.deepEqual(validatePlanDocument(p), []);
  });
});

test("templates added: the standard profile does not run them and nothing blocks (they never switch a check on)", () => {
  withDir(pythonProject(["base", "python", "python-pytest", ...PYTHON_TEMPLATES]), (dir) => {
    const p = plan(dir, "builtin:standard");
    for (const cap of PYTHON_CAPS) assert.ok(!p.groups.willRun.some((i) => i.capabilities.includes(cap)), cap);
    assert.equal(p.groups.uncoveredRequirements.length, 0);
    assert.deepEqual(validatePlanDocument(p), []);
  });
});

test("explicit templates without the new ones: each capability says exactly which template to add (add-template)", () => {
  withDir(pythonProject(["base", "python", "python-pytest"]), (dir) => {
    const p = plan(dir, "builtin:strict");
    const na = notHere(p);
    const want = { "secrets-history": "builtin:gitleaks-history", licenses: "builtin:trivy-licenses", typecheck: "builtin:python-mypy-defaults", mutation: "builtin:python-mutmut", dataflow: "builtin:python-codeql" };
    for (const [cap, template] of Object.entries(want)) {
      const n = na[cap];
      assert.ok(n, cap);
      assert.equal(n.reasonCode, "SETUP_REQUIRED", cap);
      assert.equal(n.action.kind, "add-template", cap);
      assert.equal(n.action.template, template, cap);
      assert.equal(n.action.templateState, "absent", cap);
      assert.deepEqual(n.action.settings, [], cap);
      assert.ok(n.message.includes(template), `${cap}: ${n.message}`);
    }
    // The evidence already found is named: the Git history, the dependency manifest, the pytest configuration.
    assert.deepEqual(na["secrets-history"].action.files, [".git/HEAD"]);
    assert.ok(na.licenses.action.files.includes("requirements.txt"));
    assert.deepEqual(na.mutation.action.files, ["pyproject.toml"]);
    assert.deepEqual(na.typecheck.action.files, []);
    assert.deepEqual(validatePlanDocument(p), []);
  });
});

test("adapters that need user input name the missing settings (configure-tool): schemathesis and zap a target, oasdiff a baseRef", () => {
  withDir(pythonProject(["base", "python"]), (dir) => {
    const na = notHere(plan(dir, "builtin:strict"));
    assert.equal(na["api-contract"].action.kind, "configure-tool");
    assert.equal(na["api-contract"].action.adapter, "schemathesis");
    assert.deepEqual(na["api-contract"].action.settings, ["target"]);
    assert.equal(na.dast.action.kind, "configure-tool");
    assert.equal(na.dast.action.adapter, "zap");
    assert.deepEqual(na.dast.action.settings, ["target"]);
    const oas = na["api-compatibility"].action;
    assert.equal(oas.kind, "configure-tool");
    assert.equal(oas.adapter, "oasdiff");
    assert.deepEqual(oas.settings, ["baseRef"]);
    assert.equal(oas.template, "builtin:openapi-oasdiff");
    assert.deepEqual(oas.files, ["openapi.yaml", "openapi.yml", "openapi.json"]);
    for (const cap of ["api-contract", "dast", "api-compatibility"]) assert.equal(na[cap].reasonCode, "SETUP_REQUIRED", cap);
  });
  assert.deepEqual(Object.keys(REQUIRED_SETTINGS).sort(), ["migration-drift", "oasdiff", "performance", "schemathesis", "zap"]);
});

test("explainMissing without the project folder keeps the old shapes: an evidence template is add-files, a language one add-template", () => {
  const t = translator("plan", "en");
  const base = { label: "X", languages: ["python"], templates: { active: [], inactive: [] } };
  const history = explainMissing({ ...base, capability: "secrets-history" }, t);
  assert.equal(history.action.kind, "add-files");
  assert.equal(history.action.template, "builtin:gitleaks-history");
  assert.equal(history.action.templateState, "absent");
  const typecheck = explainMissing({ ...base, capability: "typecheck" }, t);
  assert.equal(typecheck.action.kind, "add-template");
  assert.equal(typecheck.action.template, "builtin:python-mypy-defaults");
  // A template declared but inactive (evidence missing) still asks for the files.
  const declared = explainMissing({ ...base, capability: "secrets-history", templates: { active: [], inactive: [{ source: "builtin:gitleaks-history" }] } }, t);
  assert.equal(declared.action.kind, "add-files");
  assert.equal(declared.action.templateState, "declared");
});

test("init on a Python project with Git history and dependencies includes the new templates", () => {
  withDir(pythonProject(null), (dir) => {
    fs.rmSync(path.join(dir, "jgates.yml"));
    const out = planInit(dir, "strict");
    for (const id of PYTHON_TEMPLATES) assert.ok(out.templates.includes(id), `${id}: ${out.templates.join(", ")}`);
    const root = out.files.find((f) => f.file === "jgates.yml").text;
    assert.match(root, /source: builtin:gitleaks-history\n\s+activation: detected/);
  });
  // Without Git and without a dependency manifest, the two evidence templates are left out.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-strict-tpl-bare-"));
  withDir(bare, (dir) => {
    fs.writeFileSync(path.join(dir, "app.py"), "x = 1\n");
    const out = planInit(dir, "strict");
    assert.ok(!out.templates.includes("gitleaks-history"));
    assert.ok(!out.templates.includes("trivy-licenses"));
  });
});

test("python-mypy and python-mypy-defaults together do not conflict: the configured template wins and is required", () => {
  withDir(pythonProject(["base", "python", "python-mypy", "python-mypy-defaults"]), (dir) => {
    fs.writeFileSync(path.join(dir, "mypy.ini"), "[mypy]\nstrict = True\n");
    const p = plan(dir, "builtin:standard");
    const item = [...p.groups.willRun, ...p.groups.notApplicableOrDisabled].find((i) => i.tool === "mypy");
    assert.ok(item, "one mypy instance");
    // python-mypy turns it on (required, as before) even in standard, where the defaults template alone would not.
    assert.equal(item.state.enabled, true);
    assert.equal(item.state.when, undefined);
    assert.ok(!p.errors?.some?.((e) => e.code === "TEMPLATE_CONFLICT"));
  });
});

test("mypy without a configuration: withoutConfig defaults checks mypy and pyright with their defaults, also where the other is configured", () => {
  withDir(pythonProject(null), (dir) => {
    const settings = buildCheckSettings({ tool: "mypy", config: { tools: { mypy: { adapter: "build-check", config: { checker: "mypy", withoutConfig: "defaults" } } } } });
    assert.deepEqual(settings.problems, []);
    assert.equal(settings.withoutConfig, "defaults");
    const units = planUnits({ dir, env: process.env, checker: "mypy", componentRoot: null, settings: { checker: "mypy", tsconfig: null, withoutConfig: "defaults" } });
    assert.equal(units.skipped.length, 0, JSON.stringify(units.skipped));
    assert.equal(units.units.length, 1);
    assert.equal(units.units[0].config, "");
    if (units.units[0].available) assert.ok(MYPY_DEFAULT_ARGS.every((a) => units.units[0].steps[0].args.includes(a)));
    // The default ("skip") keeps today's behaviour: no configuration, no check.
    const skip = planUnits({ dir, env: process.env, checker: "mypy", componentRoot: null, settings: { checker: "mypy", tsconfig: null } });
    assert.equal(skip.units.length, 0);
    fs.writeFileSync(path.join(dir, "pyrightconfig.json"), "{}\n");
    const both = planUnits({ dir, env: process.env, checker: "mypy", componentRoot: null, settings: { checker: "mypy", tsconfig: null, withoutConfig: "defaults" } });
    assert.equal(both.skipped.length, 0, JSON.stringify(both.skipped));
    assert.equal(both.units.length, 1, "mypy still runs with its defaults though pyright is configured");
    // pyright without a configuration: defaults under withoutConfig defaults, none under skip.
    fs.rmSync(path.join(dir, "pyrightconfig.json"));
    const py = planUnits({ dir, env: process.env, checker: "pyright", componentRoot: null, settings: { checker: "pyright", tsconfig: null, withoutConfig: "defaults" } });
    assert.equal(py.skipped.length, 0, JSON.stringify(py.skipped));
    assert.equal(py.units.length, 1);
    assert.equal(py.units[0].config, "");
    assert.equal(planUnits({ dir, env: process.env, checker: "pyright", componentRoot: null, settings: { checker: "pyright", tsconfig: null } }).units.length, 0);
    assert.equal(getBuiltinTemplate("builtin:python-mypy-defaults").value.config.tools.pyright.config.withoutConfig, "defaults");
    assert.equal(getBuiltinTemplate("builtin:python-pyright").value.config.tools.pyright.config.withoutConfig, "skip");
  });
  const bad = buildCheckSettings({ tool: "mypy", config: { tools: { mypy: { config: { checker: "mypy", withoutConfig: "always" } } } } });
  assert.equal(bad.problems.length, 1);
});

test("the template settings under config reach the adapters: CodeQL language, mutation engine and time bound", () => {
  const cq = codeqlSettings({ tool: "codeql-python", config: { tools: { "codeql-python": { adapter: "codeql", config: { language: "python", suite: "security-extended" } } } } });
  assert.deepEqual(cq.problems, []);
  assert.equal(cq.language, "python");
  // tools.yml writes them next to the adapter, and that wins over config.
  assert.equal(codeqlSettings({ tool: "c", config: { tools: { c: { language: "go", config: { language: "python" } } } } }).language, "go");
  const m = mutationSettings({ tool: "mutmut", config: { tools: { mutmut: { adapter: "mutation", timeoutSeconds: 900, config: { engine: "mutmut" } } } } });
  assert.deepEqual(m.problems, []);
  assert.equal(m.engine, "mutmut");
  assert.equal(m.timeoutSeconds, 900);
});

test("the labels of the new templates exist in en and pt-BR", () => {
  for (const lang of ["en", "pt-BR"]) {
    const t = translator("catalog", lang);
    for (const id of Object.keys(NEW)) {
      assert.notEqual(t(`template_${id}_label`), `template_${id}_label`, `${lang} ${id}`);
      assert.notEqual(t(`template_${id}_description`), `template_${id}_description`, `${lang} ${id}`);
    }
  }
});
