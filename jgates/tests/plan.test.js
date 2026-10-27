import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const require = createRequire(import.meta.url);
const mainFixture = require("../../tests/fixtures/jgates/main-fixture.js");
const planApi = await import(pathToFileURL(path.join(dist, "core", "plan", "index.js")).href);

// The plan starts nothing; the interpreter is still named by absolute path so the command in the plan is stable.
const VENV_PYTHON = path.resolve(here, "..", "..", ".venv", "bin", process.platform === "win32" ? "python.exe" : "python");
const PYTHON = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python";

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function cli(home, args) {
  const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function json(r) {
  try {
    return JSON.parse(r.out);
  } catch (error) {
    throw new Error(`stdout is not one JSON document (${error.message}):\n${r.out}\n${r.err}`);
  }
}

const git = (dir, args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout;

/** The main fixture after `jgates init`, with its own data folder. */
function withProject(fn, { profile = "standard" } = {}) {
  const { dir } = mainFixture.createMainFixture();
  const home = tmp("jgates-plan-home-");
  try {
    const init = cli(home, ["init", "--cwd", dir, "--profile", profile, "--no-interactive", "--json"]);
    assert.equal(init.code, 0, init.out + init.err);
    return fn({ dir, home, plan: (...args) => cli(home, ["plan", "--cwd", dir, ...args]) });
  } finally {
    mainFixture.removeFixture(dir);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const ids = (items) => items.map((i) => i.id).sort();
const find = (plan, id) => [...plan.groups.willRun, ...plan.groups.notApplicableOrDisabled].find((i) => i.id === id);

test("plan --json on the main fixture: items of the three components with origin and reason, and the three groups", () => {
  withProject(({ dir, home, plan }) => {
    const before = mainFixture.listTree(dir);
    const r = plan("--json");
    assert.equal(r.code, 0, r.out + r.err);
    const out = json(r);
    assert.equal(out.status, "OK");
    const p = out.plan;
    assert.deepEqual(Object.keys(p.groups).sort(), ["notApplicableOrDisabled", "uncoveredRequirements", "willRun"]);
    assert.ok(Array.isArray(p.groups.uncoveredRequirements));
    assert.ok(p.groups.willRun.length > 0);
    assert.deepEqual(validateDoc(p), []);
    assert.match(p.planHash, /^sha256:[0-9a-f]{64}$/);

    // The three components, each with the templates that apply to it.
    const comps = Object.fromEntries(p.components.map((c) => [c.id, c]));
    assert.deepEqual(Object.keys(comps).sort(), ["api", "libs-shared", "web"]);
    assert.ok(comps.api.templates.includes("python"));
    assert.ok(comps.web.templates.includes("typescript"));
    assert.ok(comps["libs-shared"].templates.includes("typescript"));

    // The bridge items span every component; the Ruff item (Python components only) is checked below.
    const bridgeItems = (list) => list.filter((i) => i.adapter === "quality-bridge");
    for (const item of bridgeItems([...p.groups.willRun, ...p.groups.notApplicableOrDisabled])) {
      assert.deepEqual(item.components.map((c) => c.id).sort(), ["api", "libs-shared", "web"], item.id);
      assert.ok(item.reason.code && item.reason.message, item.id);
      assert.ok(item.state.decision, `${item.id} has the decision that set it`);
      assert.ok(item.origin.kind !== "none", item.id);
      // Included by a template: the base template, reached by the python and typescript entries the discovery activated.
      const entries = item.includedBy.filter((i) => i.kind === "template").map((i) => `${i.entry}:${i.reason}`).sort();
      assert.deepEqual(entries, ["base:ALWAYS", "python:DETECTED", "typescript:DETECTED"], item.id);
      assert.ok(item.category && item.capabilities.length === 1, item.id);
    }
    const ruffItem = p.groups.willRun.find((i) => i.id === "ruff#lint");
    assert.ok(ruffItem, "the python template adds the Ruff instance");
    assert.deepEqual(ruffItem.components.map((c) => c.id), ["api"]);
    for (const item of bridgeItems(p.groups.willRun)) {
      assert.ok(item.command.executable.length > 0);
      assert.ok(Array.isArray(item.command.args) && item.command.args.length > 0);
      assert.equal(item.command.stdin.target, p.workspace.path);
      assert.ok(item.versions.adapter);
      assert.ok(item.configFiles.length > 0 && item.configFiles.every((f) => f.sha256 === null || /^sha256:/.test(f.sha256)));
      assert.equal(typeof item.network, "boolean");
      assert.ok(["required", "conditional"].includes(item.requirement));
    }
    // Planning wrote nothing in the project; the plan went to the data folder.
    assert.deepEqual(mainFixture.listTree(dir), before);
    assert.ok(out.savedTo.startsWith(path.join(home, "workspaces", p.workspace.id)));
    assert.ok(fs.existsSync(out.savedTo));
  });
});

const validateDoc = (doc) => planApi.validatePlanDocument(doc);

test("minimal, standard, strict and a user profile give different plans, and every difference points to its layer", () => {
  withProject(({ home, dir, plan }) => {
    const created = cli(home, ["profiles", "create", "rapido", "--cwd", dir, "--from", "standard", "--skip", "capability:sast", "--no-interactive", "--json"]);
    assert.equal(created.code, 0, created.out + created.err);
    const plans = {};
    for (const profile of ["minimal", "standard", "strict", "rapido"]) {
      const r = plan("--profile", profile, "--json");
      assert.equal(r.code, 0, `${profile}: ${r.out}${r.err}`);
      plans[profile] = json(r).plan;
      assert.equal(plans[profile].profile.id, profile);
    }
    const sets = Object.fromEntries(Object.entries(plans).map(([k, p]) => [k, JSON.stringify(ids(p.groups.willRun))]));
    assert.equal(new Set(Object.values(sets)).size, 4, JSON.stringify(sets, null, 1));

    const differences = (a, b) => ids([...plans[b].groups.willRun, ...plans[b].groups.notApplicableOrDisabled]).filter((id) => find(plans[a], id).state.enabled !== find(plans[b], id).state.enabled);
    for (const [a, b] of [["minimal", "standard"], ["standard", "strict"], ["standard", "rapido"]]) {
      const diff = differences(a, b);
      assert.ok(diff.length > 0, `${a} -> ${b}`);
      for (const id of diff) {
        const d = find(plans[b], id).state.decision;
        assert.equal(d.layer, "profile", `${b} ${id}`);
        assert.ok(d.file, `${b} ${id} names the file`);
        assert.ok(d.source.endsWith(b) || d.source === `builtin:${b}`, `${b} ${id}: ${d.source}`);
      }
    }
    const semgrep = find(plans.rapido, "quality-bridge.semgrep#sast");
    assert.equal(semgrep.state.enabled, false);
    assert.equal(semgrep.state.decision.source, "profile:rapido");
    assert.equal(semgrep.state.decision.file, ".jgates/profiles.yml");
    // Each plan shows what changed since the previous one of the workspace.
    assert.deepEqual(plans.rapido.changes.profile, { from: "strict", to: "rapido" });
    assert.ok(plans.strict.changes.items.changed.some((c) => c.id === "quality-bridge.project-tests#unit" && c.fields.some((f) => f.field === "group")));
  });
});

test("a forced template without a compatible component is an explained incompatibility", () => {
  withProject(({ dir, plan }) => {
    fs.mkdirSync(path.join(dir, ".jgates", "templates"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".jgates", "templates", "go.yml"), "schemaVersion: 1\nid: go\nlabel: Go\nmatch:\n  languages: [go]\n");
    fs.appendFileSync(
      path.join(dir, "jgates.yml"),
      "  - id: go\n    source: .jgates/templates/go.yml\n    activation: always\n  - id: go-manual\n    source: .jgates/templates/go.yml\n    activation: manual\n",
    );
    const r = plan("--json");
    assert.equal(r.code, 0, r.out + r.err);
    const p = json(r).plan;
    assert.equal(p.incompatibilities.length, 1, JSON.stringify(p.incompatibilities));
    const inc = p.incompatibilities[0];
    assert.equal(inc.code, "TEMPLATE_INCOMPATIBLE");
    assert.equal(inc.template, "go");
    assert.equal(inc.activation, "ALWAYS");
    assert.deepEqual(inc.match.languages, ["go"]);
    assert.deepEqual(inc.components.map((c) => c.id).sort(), ["api", "libs-shared", "web"]);
    assert.match(inc.message, /go/);
    assert.match(inc.message, /api \(python\)/);
    assert.deepEqual(validateDoc(p), []);

    // Forced only for this plan: --template turns the manual entry on, and it is explained the same way.
    const forced = json(plan("--template", "go-manual", "--json")).plan;
    assert.deepEqual(forced.incompatibilities.map((i) => `${i.template}:${i.activation}`).sort(), ["go-manual:REQUESTED", "go:ALWAYS"]);
    const text = plan();
    assert.equal(text.code, 0);
    assert.match(text.out, /Incompatível: O template go/);
  });
});

test("plan --skip capability:unit moves the unit tests out of 'will run', with the origin 'only this run', and changes no file", () => {
  withProject(({ dir, plan }) => {
    const id = "quality-bridge.project-tests#unit";
    const full = json(plan("--profile", "strict", "--json")).plan;
    assert.ok(ids(full.groups.willRun).includes(id));

    const tree = mainFixture.listTree(dir);
    const status = git(dir, ["status", "--porcelain"]);
    const r = plan("--profile", "strict", "--skip", "capability:unit", "--skip", "capability:coverage", "--json");
    assert.equal(r.code, 0, r.out + r.err);
    const out = json(r);
    const p = out.plan;
    assert.ok(!ids(p.groups.willRun).includes(id));
    const item = p.groups.notApplicableOrDisabled.find((i) => i.id === id);
    assert.ok(item);
    assert.equal(item.state.enabled, false);
    assert.equal(item.state.origin, "run");
    assert.equal(item.state.originLabel, "só esta execução");
    assert.equal(item.state.runOnly, true);
    assert.equal(item.state.decision.source, "--skip");
    // The repeated flag counts: coverage is off too.
    assert.ok(!ids(p.groups.willRun).includes("quality-bridge.coverage#coverage"));
    // The requirement the profile selects stays visible, with the reason.
    const unit = p.groups.uncoveredRequirements.find((u) => u.selector === "capability:unit");
    assert.equal(unit.reason, "DISABLED_FOR_RUN");
    assert.equal(unit.runOnly, true);
    assert.deepEqual(p.selection.request.skip, ["capability:unit", "capability:coverage"]);
    assert.deepEqual(p.selection.overrides.find((o) => o.selector === "capability:unit").items, [id]);
    assert.equal(p.selection.reduced, true);
    assert.equal(out.reduced, true);
    assert.equal(p.groups.willRun[0].command.stdin.projectTests, false);
    // Nothing of the project changed.
    assert.deepEqual(mainFixture.listTree(dir), tree);
    assert.equal(git(dir, ["status", "--porcelain"]), status);
  });
});

test("a plan whose selected requirements all lack an executable check is blocked: the JSON says so and the exit code is 3", () => {
  withProject(({ dir, plan }) => {
    fs.appendFileSync(
      path.join(dir, ".jgates", "profiles.yml"),
      [
        "  sem-ferramenta:",
        "    label: Sem ferramenta",
        "    checks:",
        ...["file-size", "lint", "secrets", "sast", "dependencies", "duplication", "iac", "unit", "coverage", "pii", "architecture"].map((c) => `      capability:${c}: { enabled: false }`),
        "      capability:mutation: { enabled: true }",
        "",
      ].join("\n"),
    );
    const r = plan("--profile", "sem-ferramenta", "--json");
    assert.equal(r.code, 3, r.out + r.err);
    const out = json(r);
    assert.equal(out.status, "BLOCKED");
    assert.equal(out.code, "PLAN_EMPTY");
    assert.equal(out.exitCode, 3);
    assert.equal(out.approvable, false);
    const p = out.plan;
    assert.equal(p.groups.willRun.length, 0);
    assert.equal(p.blocked.code, "PLAN_EMPTY");
    assert.equal(p.approvable, false);
    assert.deepEqual(p.groups.uncoveredRequirements.map((u) => `${u.selector}:${u.reason}`).sort(), ["capability:mutation:NO_EXECUTABLE_CHECK"]);

    // Turning every check off for one run is blocked the same way.
    const skipped = plan("--skip", "tool:quality-bridge,tool:ruff,tool:builtin-pii", "--json");
    assert.equal(skipped.code, 3, skipped.out);
    assert.equal(json(skipped).plan.blocked.code, "PLAN_EMPTY");
    assert.ok(json(skipped).plan.groups.uncoveredRequirements.every((u) => u.reason === "DISABLED_FOR_RUN"));
    // A requirement without an executable check, next to checks that run: the plan runs but cannot approve.
    fs.appendFileSync(path.join(dir, ".jgates", "profiles.yml"), "  com-mutacao:\n    extends: builtin:standard\n    checks:\n      capability:mutation: { enabled: true }\n");
    const partial = plan("--profile", "com-mutacao", "--json");
    assert.equal(partial.code, 0, partial.out);
    assert.equal(json(partial).plan.approvable, false);
    assert.deepEqual(json(partial).plan.blockers.map((b) => b.code), ["REQUIREMENT_UNCOVERED"]);
  });
});

test("after a configuration file changes, the new plan has another hash and lists the change", () => {
  withProject(({ dir, plan }) => {
    const first = json(plan("--json")).plan;
    assert.equal(first.changes, null);
    const again = json(plan("--json")).plan;
    assert.equal(again.planHash, first.planHash, "same configuration, same hash");
    assert.equal(again.changes.same, true);

    const file = path.join(dir, ".jgates", "profiles.yml");
    const text = fs.readFileSync(file, "utf8");
    const edited = text.replace(/(  standard:[\s\S]*?capability:iac:\n\s+enabled: )true/, "$1false");
    assert.notEqual(edited, text);
    fs.writeFileSync(file, edited);
    const next = json(plan("--json")).plan;
    assert.notEqual(next.planHash, first.planHash);
    assert.equal(next.changes.previousHash, first.planHash);
    assert.deepEqual(next.changes.configFiles.changed, [".jgates/profiles.yml"]);
    const checkov = next.changes.items.changed.find((c) => c.id === "quality-bridge.checkov#iac");
    assert.ok(checkov, JSON.stringify(next.changes.items));
    assert.deepEqual(checkov.fields.find((f) => f.field === "group"), { field: "group", from: "willRun", to: "notApplicableOrDisabled" });
    // The text review says the same: back to the original file, one configuration file and the IaC items changed.
    fs.writeFileSync(file, text);
    const shown = plan();
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /Mudou desde o plano anterior: 0 item\(ns\) novo\(s\), 0 removido\(s\), [1-9]\d* alterado\(s\), 1 arquivo\(s\) de configuração\./);
    assert.match(shown.out, /Requisitos sem cobertura \(0\):/);
  });
});

test("--out writes the plan; the API refuses an edited command, a stale workspace and another folder", () => {
  withProject(({ dir, home, plan }) => {
    const outDir = tmp("jgates-plan-out-");
    try {
      const file = path.join(outDir, "plano.json");
      const r = plan("--out", file, "--json");
      assert.equal(r.code, 0, r.out + r.err);
      assert.equal(json(r).outFile, file);
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepEqual(validateDoc(saved), []);
      assert.equal(saved.planHash, planApi.computePlanHash(saved));
      const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON };
      const opts = { env, version: saved.versions.jgates };

      assert.equal(planApi.validatePlanAgainstWorkspace(saved, dir, opts).ok, true);

      const edited = structuredClone(saved);
      edited.groups.willRun[0].command.executable = "/bin/sh";
      assert.equal(planApi.validatePlanAgainstWorkspace(edited, dir, opts).code, "PLAN_TAMPERED");
      edited.planHash = planApi.computePlanHash(edited);
      const rehashed = planApi.validatePlanAgainstWorkspace(edited, dir, opts);
      assert.equal(rehashed.code, "PLAN_TAMPERED", "a re-hashed edit is still not the internal plan");
      assert.ok(rehashed.changes.items.changed.some((c) => c.fields.some((f) => f.field === "command")));

      assert.equal(planApi.validatePlanAgainstWorkspace({ hello: 1 }, dir, opts).code, "PLAN_INVALID");
      const other = tmp("jgates-plan-other-");
      try {
        assert.equal(planApi.validatePlanAgainstWorkspace(saved, other, opts).code, "PLAN_WORKSPACE_MISMATCH");
      } finally {
        fs.rmSync(other, { recursive: true, force: true });
      }

      fs.appendFileSync(path.join(dir, "jgates.yml"), "# edited after the plan\n");
      const stale = planApi.validatePlanAgainstWorkspace(saved, dir, opts);
      assert.equal(stale.code, "PLAN_STALE");
      assert.deepEqual(stale.changes.configFiles.changed, ["jgates.yml"]);
      assert.match(stale.message, /jgates\.yml/);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

test("equal items are deduplicated by semantic identity, not by tool name", () => {
  const item = (id, identity, entry, component) => ({
    id,
    identity,
    includedBy: [{ kind: "template", entry, source: "builtin:base", file: "builtin:templates/base.json", reason: "DETECTED", matched: [] }],
    components: [{ id: component, root: component, language: null }],
    configFiles: [{ file: "jgates.yml", sha256: null }],
  });
  const out = planApi.dedupeItems([item("a#lint", "sha256:1", "python", "api"), item("a#lint", "sha256:1", "typescript", "web"), item("b#lint", "sha256:2", "python", "web")]);
  assert.deepEqual(out.map((i) => i.id), ["a#lint", "b#lint"]);
  assert.deepEqual(out[0].includedBy.map((i) => i.entry), ["python", "typescript"]);
  assert.deepEqual(out[0].components.map((c) => c.id), ["api", "web"]);
});

test("bad flags and selectors that name nothing are usage errors (exit 3) with a suggestion", () => {
  withProject(({ plan }) => {
    const scope = plan("--scope", "everything", "--json");
    assert.equal(scope.code, 3);
    assert.equal(json(scope).code, "BAD_SCOPE");
    assert.equal(json(plan("--scope", "paths", "--json")).code, "PATHS_REQUIRED");
    const unmatched = plan("--skip", "capability:unti", "--json");
    assert.equal(unmatched.code, 3);
    const err = json(unmatched);
    assert.equal(err.code, "SELECTOR_UNMATCHED");
    assert.equal(err.errors[0].suggestion, "capability:unit");
    const paths = plan("--scope", "paths", "--path", "web", "--path", "api", "--json");
    assert.equal(paths.code, 0, paths.out);
    const p = json(paths).plan;
    assert.deepEqual(p.scope.paths, ["web", "api"]);
    assert.equal(p.scope.effective, "full");
    assert.ok(p.warnings.some((w) => w.code === "SCOPE_WIDENED"));
  });
});
