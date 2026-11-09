import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Options forms of the runtime checks (ZAP, Schemathesis, oasdiff): their settings live in tools.<id> of
// .jgates/tools.yml, so the form edits that file with minimal patches, with the setting names the adapters read.

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const forms = await import(pathToFileURL(path.join(DIST, "core", "forms", "index.js")).href);
const { zapSettings } = await import(pathToFileURL(path.join(DIST, "adapters", "zap", "index.js")).href);
const { oasdiffSettings } = await import(pathToFileURL(path.join(DIST, "adapters", "oasdiff", "index.js")).href);
const { schemathesisSettings } = await import(pathToFileURL(path.join(DIST, "adapters", "schemathesis", "index.js")).href);
const { parse } = await import("yaml");

const TOOLS = `schemaVersion: 1
tools:
  # The runtime security scan.
  zap:
    adapter: zap
    auth:
      header: Authorization
      valueEnv: ZAP_TOKEN
  oas:
    adapter: oasdiff
  st:
    adapter: schemathesis
`;

function withProject(fn, { tools = TOOLS, extra = {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jg-forms-rt-")));
  const files = { "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/tools.yml\n", ".jgates/tools.yml": tools, ...extra };
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const toolsText = (dir) => fs.readFileSync(path.join(dir, ".jgates", "tools.yml"), "utf8");
const settingsOf = (dir) => parse(toolsText(dir));

test("the ZAP form edits tools.zap of tools.yml: fields named as the adapter reads them, options labelled, auth kept", async () => {
  await withProject(async (dir) => {
    const view = await forms.openForm(dir, "zap");
    assert.equal(view.scope, "instance");
    assert.equal(view.document.relPath, ".jgates/tools.yml");
    assert.deepEqual(view.section, ["tools", "zap"]);
    assert.equal(view.available, true);
    const ids = view.fields.map((f) => f.id);
    assert.deepEqual(ids, ["capabilities", "target", "mode", "allowActive", "spec", "blockingRisk", "spiderMinutes", "image"]);
    const target = view.fields.find((f) => f.id === "target");
    assert.equal(target.required, true);
    assert.equal(target.format, "http-url");
    assert.equal(target.state, "inherited");
    const mode = view.fields.find((f) => f.id === "mode");
    assert.deepEqual(mode.options.map((o) => o.value), ["passive", "active"]);
    assert.equal(mode.defaultValue, "passive");
    assert.ok(mode.options.every((o) => o.label && !o.label.includes("zap_form")));
    assert.deepEqual(view.fields.find((f) => f.id === "allowActive").showWhen, { field: "mode", equals: "active" });
    assert.equal(view.rules.length, 1);
    // The instance's own key (adapter) is not "not in the form"; auth is, and stays untouched.
    assert.deepEqual(view.unsupported.map((u) => u.documentPath), ["tools.zap.auth"]);

    const saved = await forms.saveForm(dir, "zap", { expectedRevision: view.revision, intents: [{ field: "target", op: "set", value: "http://localhost:8000" }] });
    assert.equal(saved.status, "saved");
    const text = toolsText(dir);
    assert.match(text, /# The runtime security scan\./);
    assert.match(text, /valueEnv: ZAP_TOKEN/);
    const config = settingsOf(dir);
    assert.equal(config.tools.zap.target, "http://localhost:8000");
    const read = zapSettings({ config, tool: "zap" });
    assert.equal(read.target, "http://localhost:8000");
    assert.deepEqual(read.problems, []);
  });
});

test("an invalid target URL is refused by the form and nothing is written", async () => {
  await withProject(async (dir) => {
    const view = await forms.openForm(dir, "zap");
    const before = toolsText(dir);
    for (const value of ["localhost:8000", "ftp://host", "http://user:pw@host", "http://host/?q=1", "not a url"]) {
      await assert.rejects(
        forms.saveForm(dir, "zap", { expectedRevision: view.revision, intents: [{ field: "target", op: "set", value }] }),
        (e) => e.code === "FORM_VALUE_INVALID",
        value,
      );
    }
    assert.equal(toolsText(dir), before);
  });
});

test("the oasdiff base is one choice: saving a reference file removes the git ref, and failOn uses the adapter levels", async () => {
  await withProject(async (dir) => {
    let view = await forms.openForm(dir, "oas");
    assert.deepEqual(view.choices.map((c) => [c.id, c.required, c.options.map((o) => o.field)]), [["base", true, ["baseRef", "baseSpec"]]]);
    assert.deepEqual(view.fields.find((f) => f.id === "failOn").options.map((o) => o.value), ["ERR", "WARN"]);
    // The OpenAPI files of the project are offered for the spec.
    assert.deepEqual(view.fields.find((f) => f.id === "spec").suggestions, ["openapi.yaml", "api/v1/openapi-public.yml"]);
    await forms.saveForm(dir, "oas", { expectedRevision: view.revision, intents: [{ field: "baseRef", op: "set", value: "origin/main" }, { field: "spec", op: "set", value: "openapi.yaml" }] });
    assert.deepEqual(oasdiffSettings({ config: settingsOf(dir), tool: "oas" }).problems, []);
    assert.equal(settingsOf(dir).tools.oas.baseRef, "origin/main");
    view = await forms.openForm(dir, "oas");
    await forms.saveForm(dir, "oas", { expectedRevision: view.revision, intents: [{ field: "baseSpec", op: "set", value: "api/base.yaml" }, { field: "baseRef", op: "inherit" }] });
    const read = oasdiffSettings({ config: settingsOf(dir), tool: "oas" });
    assert.equal(read.baseRef, null);
    assert.equal(read.baseSpec, "api/base.yaml");
    assert.deepEqual(read.problems, []);
    view = await forms.openForm(dir, "oas");
    await assert.rejects(forms.saveForm(dir, "oas", { expectedRevision: view.revision, intents: [{ field: "baseRef", op: "set", value: "--upload-pack=x" }] }), (e) => e.code === "FORM_VALUE_INVALID");
    await assert.rejects(forms.saveForm(dir, "oas", { expectedRevision: view.revision, intents: [{ field: "spec", op: "set", value: "../outside.yaml" }] }), (e) => e.code === "FORM_VALUE_INVALID");
  }, { extra: { "openapi.yaml": "openapi: 3.0.0\n", "api/v1/openapi-public.yml": "openapi: 3.0.0\n", "node_modules/x/openapi.yaml": "x" } });
});

test("the Schemathesis form saves target and checks the adapter accepts; a moved revision is a conflict", async () => {
  await withProject(async (dir) => {
    const view = await forms.openForm(dir, "st");
    const checks = view.fields.find((f) => f.id === "checks");
    assert.equal(checks.options.length, 13);
    await forms.saveForm(dir, "st", { expectedRevision: view.revision, intents: [{ field: "target", op: "set", value: "https://api.local:8443/v1" }, { field: "checks", op: "set", value: ["not_a_server_error", "ignored_auth"] }] });
    const read = schemathesisSettings({ config: settingsOf(dir), tool: "st" });
    assert.equal(read.target, "https://api.local:8443/v1");
    assert.deepEqual(read.checks, ["not_a_server_error", "ignored_auth"]);
    assert.deepEqual(read.problems, []);
    const stale = await forms.saveForm(dir, "st", { expectedRevision: view.revision, intents: [{ field: "maxExamples", op: "set", value: 10 }] });
    assert.equal(stale.status, "conflict");
    assert.equal(stale.rebased.ok, true);
  });
});

test("an instance a template declares gets its entry in tools.yml on the first save, merged with the template's declaration", async () => {
  const template = "schemaVersion: 1\nid: rt\nconfig:\n  tools:\n    zap-tpl:\n      adapter: zap\n      capabilities: [dast]\n";
  await withProject(
    async (dir) => {
      const view = await forms.openForm(dir, "zap-tpl");
      assert.equal(view.available, true);
      assert.equal(view.fields.find((f) => f.id === "target").state, "inherited");
      // Nothing is written by opening the form; an unknown instance is still refused.
      assert.doesNotMatch(toolsText(dir), /zap-tpl/);
      await assert.rejects(forms.openForm(dir, "no-such-tool"), (e) => e.code === "INSTANCE_NOT_FOUND");
      const saved = await forms.saveForm(dir, "zap-tpl", { expectedRevision: view.revision, intents: [{ field: "target", op: "set", value: "http://localhost:1" }] });
      assert.equal(saved.status, "saved");
      assert.deepEqual(settingsOf(dir).tools["zap-tpl"], { adapter: "zap", target: "http://localhost:1" });
      const { resolveConfig } = await import(pathToFileURL(path.join(DIST, "core", "config", "resolve", "index.js")).href);
      const merged = resolveConfig(dir).config.tools["zap-tpl"];
      assert.equal(merged.target, "http://localhost:1");
      assert.deepEqual(merged.capabilities, ["dast"]);
    },
    {
      extra: {
        "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/tools.yml\ntemplates:\n  - id: rt\n    source: .jgates/templates/rt.yml\n    activation: always\n",
        ".jgates/templates/rt.yml": template,
      },
    },
  );
});
