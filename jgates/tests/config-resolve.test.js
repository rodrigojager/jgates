import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const resolver = await import(pathToFileURL(path.join(dist, "core", "config", "resolve", "index.js")).href);
const builtin = await import(pathToFileURL(path.join(dist, "builtin", "index.js")).href);
const { qualityBridgeManifest } = await import(pathToFileURL(path.join(dist, "adapters", "quality-bridge", "manifest.js")).href);
const { builtinPiiManifest } = await import(pathToFileURL(path.join(dist, "adapters", "builtin-pii", "manifest.js")).href);

/** Creates a project with the given files (in the given order), runs `fn(dir)` and always cleans up. */
function withProject(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jg-res-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cli(dir, ...args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jg-res-home-"));
  try {
    const r = spawnSync(process.execPath, [MAIN, "config", ...args, "--cwd", dir, "--json"], {
      encoding: "utf8",
      env: { ...process.env, JGATES_HOME: home },
      timeout: 30000,
    });
    let doc;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      assert.fail(`stdout is not JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
    }
    return { status: r.status, doc, stderr: r.stderr };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const NO_STACK = { languages: [], classifications: [] };
const yaml = (lines) => `${lines.join("\n")}\n`;
const root = (...lines) => yaml(["schemaVersion: 1", ...lines]);
const PROFILES = ".jgates/profiles.yml";

test("resolve --explain --json shows, for a field the profile overrides, the value, layer, file and previous value", () => {
  const files = {
    "jgates.yml": root("selection:", "  profile: rapido"),
    [PROFILES]: yaml([
      "schemaVersion: 1",
      "profiles:",
      "  rapido:",
      "    extends: builtin:standard",
      "    checks:",
      "      capability:sast: { enabled: false }",
      "      tool:quality-bridge.gitleaks: { enabled: false }",
    ]),
  };
  withProject(files, (dir) => {
    const r = cli(dir, "resolve", "--explain");
    assert.equal(r.status, 0, JSON.stringify(r.doc));
    assert.equal(r.doc.status, "OK");
    assert.equal(r.doc.profile.id, "rapido");
    assert.deepEqual(r.doc.profile.chain.map((l) => l.id), ["rapido", "builtin:standard", "builtin:minimal"]);
    assert.equal(r.doc.profile.label, "Equilibrado");

    // Overridden inside the profile chain: rapido over the starter profile.
    const sast = r.doc.fields["/checks/capability:sast/enabled"];
    assert.equal(sast.value, false);
    assert.equal(sast.layer, "profile");
    assert.equal(sast.source, "profile:rapido");
    assert.equal(sast.file, PROFILES);
    assert.equal(sast.path, "profiles.rapido.checks.capability:sast.enabled");
    assert.deepEqual(
      { value: sast.previous.value, layer: sast.previous.layer, source: sast.previous.source, file: sast.previous.file },
      { value: true, layer: "profile", source: "builtin:standard", file: "builtin:profiles/standard.json" },
    );
    assert.deepEqual(sast.history.map((h) => [h.source, h.value]), [["builtin:minimal", false], ["builtin:standard", true], ["profile:rapido", false]]);
    assert.equal(r.doc.config.checks["capability:sast"].enabled, false);

    // Overridden across layers: the profile over the base template.
    const gitleaks = r.doc.fields["/checks/tool:quality-bridge.gitleaks/enabled"];
    assert.equal(gitleaks.value, false);
    assert.equal(gitleaks.layer, "profile");
    assert.equal(gitleaks.file, PROFILES);
    assert.equal(gitleaks.previous.value, true);
    assert.equal(gitleaks.previous.layer, "template");
    assert.equal(gitleaks.previous.source, "builtin:base");
    assert.equal(gitleaks.previous.file, "builtin:templates/base.json");
    assert.deepEqual(gitleaks.history.map((h) => h.layer), ["defaults", "template", "profile"]);

    // Without --explain the origins are not listed, the configuration is.
    const plain = cli(dir, "resolve");
    assert.equal(plain.status, 0);
    assert.equal(plain.doc.fields, undefined);
    assert.deepEqual(plain.doc.config, r.doc.config);
  });
});

test("a cycle in profile extends exits 3 with the exact chain in error.message", () => {
  const files = {
    "jgates.yml": root("selection:", "  profile: rapido"),
    [PROFILES]: yaml(["schemaVersion: 1", "profiles:", "  rapido:", "    extends: lento", "  lento:", "    extends: medio", "  medio:", "    extends: rapido"]),
  };
  withProject(files, (dir) => {
    const r = cli(dir, "resolve", "--explain");
    assert.equal(r.status, 3);
    assert.equal(r.doc.status, "ERROR");
    assert.equal(r.doc.error.code, "EXTENDS_CYCLE");
    assert.ok(r.doc.error.message.includes("rapido -> lento -> medio -> rapido"), r.doc.error.message);
    assert.deepEqual(r.doc.errors[0].chain, ["rapido", "lento", "medio", "rapido"]);
    // The same cycle is reported once, not once per member.
    assert.equal(r.doc.errors.filter((e) => e.code === "EXTENDS_CYCLE").length, 1);
  });
});

test("a cycle in a profile that is not selected is still an error", () => {
  const files = {
    "jgates.yml": root("selection:", "  profile: ok"),
    [PROFILES]: yaml(["schemaVersion: 1", "profiles:", "  ok:", "    extends: builtin:minimal", "  a:", "    extends: b", "  b:", "    extends: a"]),
  };
  withProject(files, (dir) => {
    const r = cli(dir, "resolve");
    assert.equal(r.status, 3);
    assert.equal(r.doc.error.code, "EXTENDS_CYCLE");
    assert.ok(r.doc.error.message.includes("a -> b -> a"), r.doc.error.message);
  });
});

const tpl = (id, extendsList, configLines = [], extra = []) =>
  yaml([
    "schemaVersion: 1",
    `id: ${id}`,
    ...(extendsList.length ? ["extends:", ...extendsList.map((e) => `  - ${e}`)] : []),
    ...extra,
    ...(configLines.length ? ["config:", ...configLines.map((l) => `  ${l}`)] : []),
  ]);
const templatesOf = (...entries) => ["templates:", ...entries.flatMap(([id, source, more = []]) => [`  - id: ${id}`, `    source: ${source}`, "    activation: always", ...more.map((m) => `    ${m}`)])];
const T = (name) => `.jgates/templates/${name}.yml`;

test("a cycle in template extends exits 3 with the exact chain", () => {
  const files = {
    "jgates.yml": root(...templatesOf(["a", T("a")])),
    [T("a")]: tpl("a", [T("b")]),
    [T("b")]: tpl("b", [T("c")]),
    [T("c")]: tpl("c", [T("a")]),
  };
  withProject(files, (dir) => {
    const r = cli(dir, "resolve");
    assert.equal(r.status, 3);
    assert.equal(r.doc.error.code, "EXTENDS_CYCLE");
    const chain = [T("a"), T("b"), T("c"), T("a")];
    assert.ok(r.doc.error.message.includes(chain.join(" -> ")), r.doc.error.message);
    assert.deepEqual(r.doc.errors[0].chain, chain);
  });
});

test("a diamond resolves with the common ancestor applied once, parents in the declared order before the child", () => {
  const files = {
    "jgates.yml": root(...templatesOf(["top", T("top")])),
    [T("common")]: tpl("common", [], ["execution:", "  timeoutSeconds: 900", "workspace:", "  exclude: [build/**]"]),
    [T("left")]: tpl("left", [T("common")], ["workspace:", "  exclude: { add: [left/**] }"]),
    [T("right")]: tpl("right", [T("common")], ["execution:", "  concurrency: 2"]),
    [T("top")]: tpl("top", [T("left"), T("right")], ["workspace:", "  exclude: { add: [top/**] }"]),
  };
  withProject(files, (dir) => {
    const r = cli(dir, "resolve", "--explain");
    assert.equal(r.status, 0, JSON.stringify(r.doc));
    assert.deepEqual(r.doc.templates.active.map((a) => a.id), ["top"]);
    assert.deepEqual(r.doc.templates.active[0].chain, [T("common"), T("left"), T("right"), T("top")]);
    const templateLayers = r.doc.layers.filter((l) => l.layer === "template").map((l) => l.source);
    assert.deepEqual(templateLayers, [T("common"), T("left"), T("right"), T("top")]);
    const timeout = r.doc.fields["/execution/timeoutSeconds"];
    assert.equal(timeout.value, 900);
    assert.equal(timeout.history.length, 1, "the common ancestor is applied once");
    assert.equal(timeout.source, T("common"));
    // The add of left (applied once over common) and then the add of top.
    assert.deepEqual(r.doc.config.workspace.exclude, ["build/**", "left/**", "top/**"]);
    assert.deepEqual(r.doc.fields["/workspace/exclude"].history.map((h) => h.source), [T("common"), T("left"), T("top")]);
  });
});

test("lists: add and remove change the inherited list, replace swaps it, and removing a missing item warns", () => {
  const files = {
    "jgates.yml": root(...templatesOf(["child", T("child")], ["other", T("other")])),
    [T("parent")]: tpl("parent", [], ["workspace:", "  exclude: [a/**, b/**, c/**]", "  include: [src/**, lib/**]"]),
    [T("child")]: tpl("child", [T("parent")], ["workspace:", "  exclude: { add: [d/**], remove: [b/**, zz/**] }"]),
    [T("other")]: tpl("other", [T("parent")], ["workspace:", "  include: { replace: [app/**] }"]),
  };
  withProject(files, (dir) => {
    const r = cli(dir, "resolve", "--explain");
    assert.equal(r.status, 0, JSON.stringify(r.doc));
    assert.deepEqual(r.doc.config.workspace.exclude, ["a/**", "c/**", "d/**"]);
    const exclude = r.doc.fields["/workspace/exclude"];
    assert.equal(exclude.op, "list");
    assert.deepEqual(exclude.operation, { add: ["d/**"], remove: ["b/**", "zz/**"] });
    assert.deepEqual(exclude.previous.value, ["a/**", "b/**", "c/**"]);
    assert.equal(exclude.previous.source, T("parent"));
    assert.deepEqual(r.doc.config.workspace.include, ["app/**"]);
    assert.deepEqual(r.doc.fields["/workspace/include"].previous.value, ["src/**", "lib/**"]);
    const warning = r.doc.warnings.find((w) => w.code === "REMOVE_MISSING_ITEM");
    assert.ok(warning, JSON.stringify(r.doc.warnings));
    assert.equal(warning.pointer, "/workspace/exclude");
    assert.ok(warning.message.includes("zz/**"));
  });
  // The same removal can be configured as an error.
  withProject(files, (dir) => {
    const r = resolver.resolveConfig(dir, { inventory: NO_STACK, missingRemove: "error" });
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, "REMOVE_MISSING_ITEM");
  });
});

test("a later plain list replaces the inherited one: the project file over the templates", () => {
  const files = {
    "jgates.yml": root("extends:", "  - .jgates/workspace.yml", ...templatesOf(["child", T("child")])),
    ".jgates/workspace.yml": yaml(["schemaVersion: 1", "exclude: [only/**]"]),
    [T("child")]: tpl("child", [], ["workspace:", "  exclude: [a/**, b/**]"]),
  };
  withProject(files, (dir) => {
    const r = resolver.resolveConfig(dir, { inventory: NO_STACK });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.config.workspace.exclude, ["only/**"]);
    const f = r.fields["/workspace/exclude"];
    assert.equal(f.layer, "project");
    assert.equal(f.file, ".jgates/workspace.yml");
    assert.deepEqual(f.previous.value, ["a/**", "b/**"]);
  });
});

test("null clears an inherited value while an absent key inherits it", () => {
  const files = {
    "jgates.yml": root(...templatesOf(["cleared", T("cleared")])),
    [T("parent")]: tpl("parent", [], ["execution:", "  timeoutSeconds: 900", "  concurrency: 4"]),
    [T("cleared")]: tpl("cleared", [T("parent")], ["execution:", "  timeoutSeconds: null"]),
  };
  withProject(files, (dir) => {
    const r = cli(dir, "resolve", "--explain");
    assert.equal(r.status, 0, JSON.stringify(r.doc));
    // null: present, null, with the inherited value as the previous one.
    assert.ok(Object.hasOwn(r.doc.config.execution, "timeoutSeconds"));
    assert.equal(r.doc.config.execution.timeoutSeconds, null);
    const timeout = r.doc.fields["/execution/timeoutSeconds"];
    assert.equal(timeout.source, T("cleared"));
    assert.equal(timeout.previous.value, 900);
    // Absent: inherited from the parent template, which overrode the JGates default.
    const concurrency = r.doc.fields["/execution/concurrency"];
    assert.equal(concurrency.value, 4);
    assert.equal(concurrency.source, T("parent"));
    assert.equal(concurrency.previous.value, 1);
    assert.equal(concurrency.previous.layer, "defaults");
  });
});

test("enabled: false is a value that overrides, absent inherits, and enabled: null is refused in every layer", () => {
  const files = {
    "jgates.yml": root("selection:", "  profile: sem-testes"),
    [PROFILES]: yaml(["schemaVersion: 1", "profiles:", "  sem-testes:", "    extends: builtin:strict", "    checks:", "      capability:unit: { enabled: false }"]),
  };
  withProject(files, (dir) => {
    const r = resolver.resolveConfig(dir, { inventory: NO_STACK });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.config.checks["capability:unit"].enabled, false);
    assert.equal(r.fields["/checks/capability:unit/enabled"].previous.value, true);
    assert.equal(r.fields["/checks/capability:unit/enabled"].previous.source, "builtin:strict");
    // Absent in sem-testes: inherited from builtin:strict.
    assert.equal(r.config.checks["capability:coverage"].enabled, true);
    assert.equal(r.fields["/checks/capability:coverage/enabled"].source, "builtin:strict");

    const forced = resolver.resolveConfig(dir, { inventory: NO_STACK, overrides: [{ pointer: "/checks/capability:unit/enabled", value: null, source: "--skip" }] });
    assert.equal(forced.ok, false);
    assert.equal(forced.errors[0].code, "ENABLED_NULL");

    const skip = resolver.resolveConfig(dir, { inventory: NO_STACK, overrides: [{ pointer: "/checks/capability:coverage/enabled", value: false, source: "--skip" }] });
    assert.equal(skip.ok, true);
    assert.equal(skip.fields["/checks/capability:coverage/enabled"].layer, "call");
    assert.equal(skip.fields["/checks/capability:coverage/enabled"].source, "--skip");
  });

  withProject(
    { ...files, [PROFILES]: yaml(["schemaVersion: 1", "profiles:", "  sem-testes:", "    checks:", "      capability:unit: { enabled: null }"]) },
    (dir) => {
      const r = cli(dir, "resolve");
      assert.equal(r.status, 3);
      assert.equal(r.doc.error.code, "CONFIG_INVALID");
      assert.ok(r.doc.diagnostics.some((d) => d.code === "TYPE" && d.path === "profiles.sem-testes.checks.capability:unit.enabled"), JSON.stringify(r.doc.diagnostics));
    },
  );

  withProject(
    { "jgates.yml": root(...templatesOf(["x", T("x")])), [T("x")]: tpl("x", [], ["checks:", "  capability:unit: { enabled: null }"]) },
    (dir) => {
      const r = cli(dir, "resolve");
      assert.equal(r.status, 3);
      assert.equal(r.doc.error.code, "TEMPLATE_INVALID");
      assert.ok(r.doc.errors[0].details.diagnostics.some((d) => d.code === "TYPE" && d.path === "config.checks.capability:unit.enabled"));
    },
  );
});

test("two active templates that override the same field with no defined priority conflict, whatever the order on disk", () => {
  const one = tpl("one", [], ["checks:", "  capability:mutation: { enabled: true }", "  capability:sast: { enabled: true }"]);
  const two = tpl("two", [], ["checks:", "  capability:mutation: { enabled: false }", "  capability:sast: { enabled: true }"]);
  const forward = {
    "jgates.yml": root(...templatesOf(["one", T("one")], ["two", T("two")])),
    [T("one")]: one,
    [T("two")]: two,
  };
  const backward = {
    [T("two")]: two,
    [T("one")]: one,
    "jgates.yml": root(...templatesOf(["two", T("two")], ["one", T("one")])),
  };
  const run = (files) =>
    withProject(files, (dir) => {
      const r = cli(dir, "resolve");
      assert.equal(r.status, 3, JSON.stringify(r.doc));
      const { projectDir, ...rest } = r.doc;
      return rest;
    });
  const a = run(forward);
  const b = run(backward);
  assert.equal(a.error.code, "TEMPLATE_CONFLICT");
  assert.ok(a.error.message.includes("/checks/capability:mutation/enabled"), a.error.message);
  assert.ok(a.error.message.includes(T("one")) && a.error.message.includes(T("two")));
  // The same value in both is not a conflict: only capability:mutation is reported.
  assert.deepEqual(a.errors.map((e) => e.pointer), ["/checks/capability:mutation/enabled"]);
  assert.deepEqual(a.errors[0].details.templates, [T("one"), T("two")]);
  assert.deepEqual(a, b);

  // A declared priority defines the order: the higher one wins and the other is the previous value.
  withProject(
    { ...forward, "jgates.yml": root(...templatesOf(["one", T("one"), ["priority: 10"]], ["two", T("two")])) },
    (dir) => {
      const r = cli(dir, "resolve", "--explain");
      assert.equal(r.status, 0, JSON.stringify(r.doc));
      const lint = r.doc.fields["/checks/capability:mutation/enabled"];
      assert.equal(lint.value, true);
      assert.equal(lint.source, T("one"));
      assert.equal(lint.previous.value, false);
      assert.equal(lint.previous.source, T("two"));
    },
  );
});

test("a specialized template overrides its base without a conflict", () => {
  const files = {
    "jgates.yml": root(...templatesOf(["base", "builtin:base"], ["mine", T("mine")])),
    [T("mine")]: tpl("mine", ["builtin:base"], ["checks:", "  tool:quality-bridge.jscpd: { enabled: false }"]),
  };
  withProject(files, (dir) => {
    const r = resolver.resolveConfig(dir, { inventory: NO_STACK });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const f = r.fields["/checks/tool:quality-bridge.jscpd/enabled"];
    assert.equal(f.value, false);
    assert.equal(f.source, T("mine"));
    assert.equal(f.previous.source, "builtin:base");
    assert.deepEqual(r.layers.filter((l) => l.layer === "template").map((l) => l.source), ["builtin:base", T("mine")]);
  });
});

test("config get /selection/profile --json gives the effective profile and its origin", () => {
  withProject({ "jgates.yml": root("selection:", "  profile: builtin:minimal") }, (dir) => {
    const r = cli(dir, "get", "/selection/profile");
    assert.equal(r.status, 0, JSON.stringify(r.doc));
    assert.equal(r.doc.value, "builtin:minimal");
    assert.equal(r.doc.layer, "project");
    assert.equal(r.doc.source, "jgates.yml");
    assert.equal(r.doc.file, "jgates.yml");
    assert.equal(r.doc.path, "selection.profile");
    assert.equal(r.doc.previous.value, "builtin:standard");
    assert.equal(r.doc.previous.layer, "defaults");

    const called = cli(dir, "get", "/selection/profile", "--profile", "builtin:strict");
    assert.equal(called.status, 0);
    assert.equal(called.doc.value, "builtin:strict");
    assert.equal(called.doc.layer, "call");
    assert.equal(called.doc.source, "--profile");
    assert.equal(called.doc.file, null);
    assert.equal(called.doc.previous.value, "builtin:minimal");
    assert.equal(called.doc.previous.file, "jgates.yml");

    const container = cli(dir, "get", "/selection");
    assert.equal(container.status, 0);
    assert.deepEqual(container.doc.value, { profile: "builtin:minimal" });
    assert.equal(container.doc.fields["/selection/profile"].layer, "project");
  });
  withProject({ "jgates.yml": root() }, (dir) => {
    const r = cli(dir, "get", "/selection/profile");
    assert.equal(r.status, 0);
    assert.equal(r.doc.value, "builtin:standard");
    assert.equal(r.doc.layer, "defaults");
    assert.equal(r.doc.source, "jgates");
  });
});

test("config get and resolve refuse a bad pointer, an unknown pointer and an unknown profile with exit 3", () => {
  withProject({ "jgates.yml": root() }, (dir) => {
    const missing = cli(dir, "get");
    assert.equal(missing.status, 3);
    assert.equal(missing.doc.error.code, "POINTER_REQUIRED");
    const bad = cli(dir, "get", "selection/profile");
    assert.equal(bad.status, 3);
    assert.equal(bad.doc.error.code, "BAD_POINTER");
    const unknown = cli(dir, "get", "/selection/profle");
    assert.equal(unknown.status, 3);
    assert.equal(unknown.doc.error.code, "POINTER_NOT_FOUND");
    assert.equal(unknown.doc.suggestion, "/selection/profile");
    const profile = cli(dir, "resolve", "--profile", "builtin:strcit");
    assert.equal(profile.status, 3);
    assert.equal(profile.doc.error.code, "PROFILE_UNKNOWN");
    assert.equal(profile.doc.errors[0].details.suggestion, "builtin:strict");
    const option = cli(dir, "validate", "--explain");
    assert.equal(option.status, 3);
    assert.equal(option.doc.error.code, "OPTION_NOT_SUPPORTED");
  });
});

test("the starter profiles and the built-in templates are valid and select bridge subchecks and catalog capabilities", () => {
  const templates = builtin.listBuiltinTemplates().map((i) => i.ref);
  assert.deepEqual(templates, ["builtin:base", "builtin:dotnet", "builtin:go", "builtin:python-import-linter", "builtin:python-pytest", "builtin:python-typescript", "builtin:python", "builtin:rust", "builtin:typescript-dependency-cruiser", "builtin:typescript-eslint", "builtin:typescript-vitest", "builtin:typescript"]);
  const profiles = builtin.listBuiltinProfiles().map((i) => i.ref);
  assert.deepEqual(profiles, ["builtin:minimal", "builtin:standard", "builtin:strict"]);

  const subchecks = new Set(qualityBridgeManifest.subchecks.map((s) => `tool:quality-bridge.${s.id}`));
  const baseChecks = Object.keys(builtin.getBuiltinTemplate("builtin:base").value.config.checks);
  assert.deepEqual(new Set(baseChecks), subchecks);

  withProject({ "jgates.yml": root() }, (dir) => {
    const checksOf = (profile) => {
      const r = resolver.resolveConfig(dir, { profile, inventory: NO_STACK });
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      return Object.fromEntries(Object.entries(r.config.checks).filter(([k]) => k.startsWith("capability:")).map(([k, v]) => [k, v.enabled]));
    };
    const minimal = checksOf("builtin:minimal");
    const standard = checksOf("builtin:standard");
    const strict = checksOf("builtin:strict");
    assert.notDeepEqual(minimal, standard);
    assert.notDeepEqual(standard, strict);
    const on = (checks) => Object.keys(checks).filter((k) => checks[k]).sort();
    assert.deepEqual(on(minimal), ["capability:file-size", "capability:lint", "capability:secrets"]);
    // PII enters the plan only when the profile selects capability:pii: standard and strict do, minimal does not.
    assert.ok(on(standard).includes("capability:pii") && on(strict).includes("capability:pii"));
    for (const c of on(minimal)) assert.ok(on(standard).includes(c));
    for (const c of on(standard)) assert.ok(on(strict).includes(c));
    assert.ok(strict["capability:unit"] && !standard["capability:unit"]);
    const capabilities = new Set([...qualityBridgeManifest.capabilities, ...builtinPiiManifest.capabilities]);
    for (const key of Object.keys(strict)) assert.ok(capabilities.has(key.slice("capability:".length)), key);
  });
});

test("the implicit templates activate from the discovery: base always, Python when the project has Python", () => {
  const files = {
    "jgates.yml": root(),
    "api/pyproject.toml": '[project]\nname = "api"\nversion = "0.1.0"\n',
    "api/src/api/__init__.py": "",
  };
  withProject(files, (dir) => {
    const r = cli(dir, "resolve", "--explain");
    assert.equal(r.status, 0, JSON.stringify(r.doc));
    const active = Object.fromEntries(r.doc.templates.active.map((a) => [a.id, a.reason]));
    assert.deepEqual(active, { base: "ALWAYS", python: "DETECTED" });
    assert.deepEqual(r.doc.templates.inactive.map((i) => [i.id, i.reason]), [["dotnet", "NOT_DETECTED"], ["typescript", "NOT_DETECTED"]]);
    assert.equal(r.doc.fields["/templates/base/source"].layer, "defaults");
    assert.ok(r.doc.config.workspace.exclude.includes(".git/**"));
    assert.ok(r.doc.config.workspace.exclude.includes("**/.venv/**"));
    assert.equal(r.doc.fields["/workspace/exclude"].source, "builtin:python");
    assert.equal(r.doc.fields["/workspace/exclude"].previous.source, "builtin:base");
    // Both stack templates extend the base: with both active the base is applied once and they do not conflict.
    const both = resolver.resolveConfig(dir, { inventory: { languages: ["python", "typescript"] } });
    assert.equal(both.ok, true, JSON.stringify(both.errors));
    assert.deepEqual(both.layers.filter((l) => l.layer === "template").map((l) => l.source), ["builtin:base", "builtin:python", "builtin:typescript"]);
    assert.ok(both.config.workspace.exclude.includes("**/node_modules/**") && both.config.workspace.exclude.includes("**/.venv/**"));
  });
});

test("the precedence runs defaults < template < profile < project < call", () => {
  const files = {
    "jgates.yml": root("selection:", "  profile: p", "  intensity: projeto", ...templatesOf(["t", T("t")])),
    [PROFILES]: yaml(["schemaVersion: 1", "profiles:", "  p:", "    intensity: perfil", "    checks:", "      capability:lint: { enabled: false, intensity: perfil }"]),
    [T("t")]: tpl("t", [], ["checks:", "  capability:lint: { enabled: true, intensity: template }"]),
  };
  withProject(files, (dir) => {
    const r = resolver.resolveConfig(dir, {
      inventory: NO_STACK,
      overrides: [{ pointer: "/checks/capability:lint/intensity", value: "chamada" }],
    });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.layers.map((l) => l.layer).filter((l, i, all) => all.indexOf(l) === i), ["defaults", "template", "profile", "project", "call"]);
    assert.equal(r.fields["/selection/intensity"].value, "projeto");
    assert.equal(r.fields["/selection/intensity"].previous.value, "perfil");
    assert.deepEqual(r.fields["/checks/capability:lint/intensity"].history.map((h) => [h.layer, h.value]), [["template", "template"], ["profile", "perfil"], ["call", "chamada"]]);
    assert.equal(resolver.getField(r, "/checks/capability:lint/enabled").field.layer, "profile");
  });
});
