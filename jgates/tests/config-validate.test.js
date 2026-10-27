import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");
const loader = await import(pathToFileURL(path.resolve(here, "..", "dist", "core", "config", "load", "index.js")).href);

/** Creates a project with the given files, runs `config validate --json`, and always cleans up. */
function validate(files, { raw = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jg-cfg-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jg-cfg-home-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    const started = Date.now();
    const r = spawnSync(process.execPath, [MAIN, "config", "validate", "--cwd", dir, "--json"], {
      encoding: "utf8",
      env: { ...process.env, JGATES_HOME: home },
      timeout: 20000,
    });
    const doc = JSON.parse(r.stdout);
    return { status: r.status, doc, ms: Date.now() - started, raw };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const profiles = (body) => `schemaVersion: 1\nprofiles:\n${body}`;

test("a minimal valid configuration exits 0 with no diagnostics", () => {
  const r = validate({
    "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/profiles.yml\nselection:\n  profile: standard\n",
    ".jgates/profiles.yml": profiles("  standard:\n    extends: builtin:standard\n"),
  });
  assert.equal(r.status, 0);
  assert.equal(r.doc.valid, true);
  assert.deepEqual(r.doc.diagnostics, []);
});

test("an unknown key exits 3 with file, field path and the probable name", () => {
  const r = validate({
    "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/profiles.yml\n",
    ".jgates/profiles.yml": profiles("  standard:\n    extends: builtin:standard\n    profle: x\n"),
  });
  assert.equal(r.status, 3);
  const d = r.doc.diagnostics.find((x) => x.code === "UNKNOWN_KEY");
  assert.ok(d, JSON.stringify(r.doc.diagnostics));
  assert.equal(d.file, ".jgates/profiles.yml");
  assert.equal(d.path, "profiles.standard.profle");
  assert.equal(d.kind, "schema");
  assert.equal(d.suggestion, undefined);
  assert.ok(typeof d.line === "number");

  const r2 = validate({ "jgates.yml": "schemaVersion: 1\nselection:\n  profle: standard\n" });
  assert.equal(r2.status, 3);
  const d2 = r2.doc.diagnostics.find((x) => x.code === "UNKNOWN_KEY");
  assert.equal(d2.file, "jgates.yml");
  assert.equal(d2.path, "selection.profle");
  assert.equal(d2.suggestion, "profile");
});

test("schemaVersion is required in root and fragments", () => {
  const r = validate({ "jgates.yml": "selection:\n  profile: builtin:standard\n" });
  assert.equal(r.status, 3);
  assert.ok(r.doc.diagnostics.some((d) => d.code === "SCHEMA_VERSION_REQUIRED" && d.path === "schemaVersion"));
});

test("code-executing tags, abusive aliases and oversized files are refused with a diagnostic", () => {
  const tag = validate({ "jgates.yml": "schemaVersion: 1\nextends: !!js/function 'function(){}'\n" });
  assert.equal(tag.status, 3);
  assert.ok(tag.doc.diagnostics.some((d) => d.kind === "syntax" && d.code === "YAML_TAG_FORBIDDEN"), JSON.stringify(tag.doc.diagnostics));

  const custom = validate({ "jgates.yml": "schemaVersion: 1\nselection: !ruby/object:Foo {}\n" });
  assert.equal(custom.status, 3);
  assert.ok(custom.doc.diagnostics.some((d) => d.code === "YAML_TAG_FORBIDDEN"));

  let bomb = "a: &a [x, x, x, x, x, x, x, x, x]\n";
  let prev = "a";
  for (let i = 0; i < 9; i++) {
    const name = String.fromCharCode(98 + i);
    bomb += `${name}: &${name} [${Array(9).fill(`*${prev}`).join(", ")}]\n`;
    prev = name;
  }
  const alias = validate({ "jgates.yml": `schemaVersion: 1\nextensions:\n  x:\n${bomb.split("\n").map((l) => (l ? `    ${l}` : l)).join("\n")}` });
  assert.equal(alias.status, 3);
  assert.ok(alias.doc.diagnostics.some((d) => d.kind === "syntax"), JSON.stringify(alias.doc.diagnostics));
  assert.ok(alias.ms < 15000);

  const deep = validate({ "jgates.yml": `schemaVersion: 1\nextensions: ${"[".repeat(5000)}${"]".repeat(5000)}\n` });
  assert.equal(deep.status, 3);
  assert.ok(deep.doc.diagnostics.some((d) => d.code === "YAML_TOO_DEEP"));

  const big = validate({ "jgates.yml": `schemaVersion: 1\n# ${"x".repeat(1024 * 1024 + 10)}\n` });
  assert.equal(big.status, 3);
  assert.ok(big.doc.diagnostics.some((d) => d.code === "YAML_TOO_LARGE"));

  const broken = validate({ "jgates.yml": "schemaVersion: 1\nselection: [unclosed\n" });
  assert.equal(broken.status, 3);
  assert.ok(broken.doc.diagnostics.some((d) => d.code === "YAML_SYNTAX"));
});

test("enabled: false, null and an absent field give different validation results", () => {
  const withEnabled = (line) =>
    validate({
      "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/profiles.yml\n",
      ".jgates/profiles.yml": profiles(`  rapido:\n    extends: builtin:standard\n    checks:\n      capability:unit: { ${line} }\n`),
    });
  const off = withEnabled("enabled: false");
  const absent = withEnabled("intensity: low");
  const nul = withEnabled("enabled: null");
  assert.equal(off.status, 0, JSON.stringify(off.doc.diagnostics));
  assert.equal(absent.status, 0, JSON.stringify(absent.doc.diagnostics));
  assert.equal(nul.status, 3);
  assert.ok(nul.doc.diagnostics.some((d) => d.code === "TYPE" && d.path === "profiles.rapido.checks.capability:unit.enabled"));

  // The loader keeps the three states apart in the parsed value.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jg-cfg-"));
  try {
    fs.writeFileSync(path.join(dir, "jgates.yml"), "schemaVersion: 1\nextends:\n  - .jgates/profiles.yml\n");
    fs.mkdirSync(path.join(dir, ".jgates"));
    fs.writeFileSync(path.join(dir, ".jgates", "profiles.yml"), profiles("  a:\n    checks:\n      tool:t1: { enabled: false }\n      tool:t2: { intensity: low }\n"));
    const loaded = loader.loadProjectConfig(dir);
    const checks = loaded.byKind.profiles.value.profiles.a.checks;
    assert.equal(checks["tool:t1"].enabled, false);
    assert.equal("enabled" in checks["tool:t2"], false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("references are checked: missing extends file, unknown profile and unknown fragment type", () => {
  const r = validate({
    "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/policy.yml\n  - ../outside.yml\n  - .jgates/other.yml\nselection:\n  profile: standrd\n",
    ".jgates/other.yml": "schemaVersion: 1\n",
    ".jgates/profiles.yml": profiles("  standard:\n    extends: builtin:standard\n"),
  });
  assert.equal(r.status, 3);
  const codes = r.doc.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("REF_MISSING_FILE") || codes.includes("REF_OUTSIDE_PROJECT"));
  assert.ok(codes.includes("REF_OUTSIDE_PROJECT"));
  assert.ok(codes.includes("UNKNOWN_FRAGMENT"));
  const p = r.doc.diagnostics.find((d) => d.code === "REF_PROFILE_UNKNOWN");
  assert.equal(p.path, "selection.profile");
  assert.equal(p.suggestion, "standard");
  assert.ok(r.doc.diagnostics.every((d) => ["syntax", "schema", "reference"].includes(d.kind)));
});

test("a missing jgates.yml is invalid; the architecture fragment is checked by its schema", () => {
  const none = validate({});
  assert.equal(none.status, 3);
  assert.ok(none.doc.diagnostics.some((d) => d.code === "ROOT_MISSING"));

  const checked = validate({
    "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/architecture.yml\n",
    ".jgates/architecture.yml": "schemaVersion: 1\narchitecture:\n  layers:\n    - id: a\n      paths: [\"a/**\"]\n",
  });
  assert.equal(checked.status, 0, JSON.stringify(checked.doc.diagnostics));
  assert.equal(checked.doc.files.find((f) => f.kind === "architecture").schemaPending, false);

  const unknown = validate({
    "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/architecture.yml\n",
    ".jgates/architecture.yml": "schemaVersion: 1\nlayers: [a]\n",
  });
  assert.equal(unknown.status, 3);
  assert.ok(unknown.doc.diagnostics.some((d) => d.code === "UNKNOWN_KEY" && d.file === ".jgates/architecture.yml" && d.path === "layers"));
});

test("the schemas live in jgates/schemas/config, one per document", () => {
  const dir = path.resolve(here, "..", "schemas", "config");
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, ["architecture.schema.json", "jgates.schema.json", "lock.schema.json", "pii.schema.json", "policy.schema.json", "profiles.schema.json", "template.schema.json", "tools.schema.json", "workspace.schema.json"]);
  for (const n of names) assert.equal(JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")).$schema, "https://json-schema.org/draft/2020-12/schema");
});

test("an unknown config subcommand is a usage error", () => {
  const r = spawnSync(process.execPath, [MAIN, "config", "nope", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stdout).code, "UNKNOWN_ACTION");
});
