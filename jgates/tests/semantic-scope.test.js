import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The Semantic scope engine (core/semantic-scope): import extraction, resolution of full/selected/incremental scopes
// (subjects, context with reasons, limits, exclusions, blockers, dirty inputs, dependency changes, subsystems), the
// host file-access guard and the ledger states. The V2 cases (tests/v2/v2-24..27) cover the CLI, API and run flows.

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const load = (rel) => import(pathToFileURL(path.join(DIST, rel)).href);
const scope = await load("core/semantic-scope/index.js");
const semantic = await load("core/semantic/index.js");

const temps = [];
test.after(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-scope-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-scope-home-"));
  temps.push(dir, home);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  const env = { ...process.env, ...GIT_ENV, JGATES_HOME: home };
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const resolve = (request, extra = {}) => scope.resolveSemanticScope({ workspacePath: dir, request, home, env, ...extra });
  return { dir, home, env, git, write, resolve, head: () => git("rev-parse", "HEAD") };
}

const APP = {
  "src/auth/guard.js": "export function requireUser(req) { return req.user; }\n",
  "src/routes/a.js": "import { requireUser } from '../auth/guard.js';\nexport const a = (r) => requireUser(r);\n",
  "src/routes/b.js": "const { requireUser } = require('../auth/guard');\nmodule.exports = (r) => requireUser(r);\n",
  "src/routes/c.js": "import { a } from './a.js';\nexport const c = a;\n",
  "src/lib/http.js": "import express from 'express';\nexport const app = express();\n",
  "src/other.js": "export const other = 1;\n",
  "package.json": JSON.stringify({ name: "x", dependencies: { express: "4.0.0" } }, null, 2),
};

test("extractImports reads static, re-exported, required and dynamic imports; computed ones are unknowns", () => {
  const js = scope.extractImports("src/x.ts", "import a from './a';\nexport * from './b.js';\nimport c = require('./c');\nconst d = require('./d');\nawait import('./e');\nawait import(name);\nrequire(path);\n");
  assert.equal(js.method, "ast");
  assert.deepEqual(js.imports.map((i) => i.spec).sort(), ["./a", "./b.js", "./c", "./d", "./e"]);
  assert.deepEqual(js.unknowns.map((u) => u.code).sort(), ["COMPUTED_REQUIRE", "DYNAMIC_IMPORT"]);
  const py = scope.extractImports("pkg/mod.py", "import os, json as j\nfrom .sibling import thing\nfrom . import other\nimportlib.import_module(name)\n");
  assert.equal(py.method, "regex");
  assert.ok(py.imports.some((i) => i.spec === "os") && py.imports.some((i) => i.spec === ".sibling") && py.imports.some((i) => i.spec === ".other"));
  assert.deepEqual(py.unknowns.map((u) => u.code), ["DYNAMIC_IMPORT"]);
  assert.equal(scope.extractImports("README.md", "import x"), null);
});

test("a full scope takes every applicable file as subject; a full scope with subjects or a comparison is refused", () => {
  const r = repo({ ...APP, "img/logo.png": "png" });
  const full = r.resolve(null);
  assert.equal(full.mode, "full");
  assert.deepEqual(full.blockers, []);
  assert.ok(full.subjects.some((s) => s.path === "src/other.js"));
  assert.equal(full.subjects.some((s) => s.path === "img/logo.png"), false, "a binary is not an applicable unit");
  assert.ok(full.spec.units.omitted.some((u) => u.id === "img/logo.png"));
  assert.deepEqual(full.context, []);
  assert.equal(full.completion.claim, "repository-applicable");
  assert.equal(full.inheritedCoverage.state, "none");
  assert.deepEqual(r.resolve({ mode: "full", subjects: [{ kind: "path", value: "src" }] }).blockers.map((b) => b.code), ["SCOPE_SUBJECTS_NOT_APPLICABLE"]);
  assert.deepEqual(r.resolve({ mode: "full", base: "HEAD" }).blockers.map((b) => b.code), ["SCOPE_COMPARISON_NOT_APPLICABLE"]);
  assert.deepEqual(r.resolve({ mode: "incremental" }).blockers.map((b) => b.code), ["SCOPE_BASE_REQUIRED"]);
  assert.deepEqual(r.resolve({ mode: "selected" }).blockers.map((b) => b.code), ["SCOPE_SUBJECTS_REQUIRED"]);
  assert.deepEqual(r.resolve({ mode: "selected", subjects: [{ kind: "path", value: "../outside" }] }).blockers.map((b) => b.code), ["SCOPE_PATH_OUTSIDE", "SCOPE_SUBJECTS_REQUIRED"]);
  assert.deepEqual(r.resolve({ mode: "selected", subjects: [{ kind: "path", value: "nothing/here" }] }).blockers.map((b) => b.code), ["SCOPE_SUBJECT_EMPTY"]);
  assert.deepEqual(r.resolve({ mode: "incremental", base: "no-such-ref" }).blockers.map((b) => b.code), ["SCOPE_REF_UNRESOLVED"]);
});

test("a selected scope keeps subjects apart from the context it imports and from its importers; exclusions are never context", () => {
  const r = repo(APP);
  const sel = r.resolve({ mode: "selected", subjects: [{ kind: "path", value: "src/routes/a.js" }], exclusions: ["src/routes/c.js"] });
  assert.deepEqual(sel.blockers, []);
  assert.deepEqual(sel.subjects.map((s) => s.path), ["src/routes/a.js"]);
  const ctx = new Map(sel.context.map((c) => [c.path, c]));
  assert.ok(ctx.get("src/auth/guard.js").reasons.some((x) => x.code === "IMPORTED_BY_SUBJECT"));
  assert.equal(ctx.has("src/routes/c.js"), false, "an excluded importer is not context");
  assert.ok(sel.exclusions.excluded.some((e) => e.path === "src/routes/c.js" && e.reason.code === "EXCLUDED"));
  assert.equal(sel.completion.claim, "scope-only");
});

test("subsystems are the layers of .jgates/architecture.yml; an unknown one blocks", () => {
  const r = repo({
    ...APP,
    "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/architecture.yml\n",
    ".jgates/architecture.yml": "schemaVersion: 1\narchitecture:\n  layers:\n    - id: routes\n      paths: [\"src/routes/**\"]\n    - id: auth\n      paths: [\"src/auth/**\"]\n  rules:\n    - id: no-cycles\n      kind: no-cycles\n",
  });
  const sel = r.resolve({ mode: "selected", subjects: [{ kind: "subsystem", value: "routes" }] });
  assert.deepEqual(sel.blockers, []);
  assert.deepEqual(sel.subjects.map((s) => s.path), ["src/routes/a.js", "src/routes/b.js", "src/routes/c.js"]);
  assert.ok(sel.subjects.every((s) => s.reasons[0].code === "SELECTED_SUBSYSTEM"));
  assert.deepEqual(r.resolve({ mode: "selected", subjects: [{ kind: "subsystem", value: "nope" }] }).blockers.map((b) => b.code), ["SCOPE_SUBSYSTEM_UNKNOWN"]);
});

test("an incremental scope follows importers within the depth and file limits and recommends the rest", () => {
  const r = repo(APP);
  const base = r.head();
  r.write("src/auth/guard.js", "export function requireUser(req) { return req.user ?? null; }\n");
  r.git("commit", "-q", "-am", "guard");
  const all = r.resolve({ mode: "incremental", base });
  assert.deepEqual(all.subjects.map((s) => s.path), ["src/auth/guard.js"]);
  assert.deepEqual(all.context.map((c) => c.path), ["src/routes/a.js", "src/routes/b.js"], "depth 1 by default: c.js imports a.js, not the guard");
  assert.ok(all.context.every((c) => c.reasons[0].code === "IMPORTS_CHANGED_GUARD"));
  const deeper = r.resolve({ mode: "incremental", base, context: { maxDepth: 2 } });
  const c = deeper.context.find((x) => x.path === "src/routes/c.js");
  assert.ok(c && c.reasons[0].code === "IMPORTS_AFFECTED" && c.reasons[0].via === "src/routes/a.js");
  const limited = r.resolve({ mode: "incremental", base, context: { maxFiles: 1 } });
  assert.equal(limited.context.length, 1);
  assert.equal(limited.impact.recommendedExpansion.length, 1);
  assert.ok(limited.impact.recommendedExpansion[0].reasons.some((x) => x.code === "LIMIT_FILES"));
  assert.ok(limited.spec.units.omitted.some((u) => u.id === limited.impact.recommendedExpansion[0].path));
  assert.deepEqual(r.resolve({ mode: "incremental", base, context: { maxDepth: 0 } }).context, []);
  const explicit = r.resolve({ mode: "incremental", base, context: { maxDepth: 0, allow: ["src/other.js"] } });
  assert.deepEqual(explicit.context.map((x) => [x.path, x.relation]), [["src/other.js", "explicit"]]);
  assert.deepEqual(r.resolve({ mode: "incremental", base: "HEAD" }).blockers.map((b) => b.code), ["SCOPE_NO_CHANGES"]);
});

test("a changed dependency in package.json brings the files using that package as context", () => {
  const r = repo(APP);
  const base = r.head();
  r.write("package.json", JSON.stringify({ name: "x", dependencies: { express: "5.0.0" } }, null, 2));
  r.git("commit", "-q", "-am", "bump express");
  const res = r.resolve({ mode: "incremental", base });
  const http = res.context.find((c) => c.path === "src/lib/http.js");
  assert.ok(http, JSON.stringify(res.context));
  assert.equal(http.relation, "dependency-user");
  assert.equal(http.reasons[0].code, "USES_CHANGED_DEPENDENCY");
});

test("dirty inputs are laid over HEAD only when selected; a review reading the working tree is refused otherwise", () => {
  const r = repo(APP);
  const base = r.head();
  r.write("src/routes/a.js", "import { requireUser } from '../auth/guard.js';\nexport const a = (r) => requireUser(r) && true;\n");
  r.git("commit", "-q", "-am", "a");
  r.write("src/routes/b.js", "module.exports = () => 1;\n");
  r.write("src/new.js", "export const n = 1;\n");
  const committedOnly = r.resolve({ mode: "incremental", base });
  assert.deepEqual(committedOnly.subjects.map((s) => s.path), ["src/routes/a.js"]);
  assert.equal(committedOnly.workingTreeMatchesTarget, true, "the dirty files are not read by this scope");
  const withNew = r.resolve({ mode: "incremental", base, dirty: ["src/new.js"] });
  assert.deepEqual(withNew.subjects.map((s) => [s.path, s.change]), [["src/new.js", "untracked"], ["src/routes/a.js", "modified"]]);
  assert.deepEqual(withNew.spec.resolved.dirtyInputs.map((d) => d.path), ["src/new.js"]);
  const all = r.resolve({ mode: "incremental", base, dirty: "all" });
  assert.deepEqual(all.subjects.map((s) => s.path), ["src/new.js", "src/routes/a.js", "src/routes/b.js"]);
  // The guard is context of a.js; b.js is dirty but not selected and is context of nothing here: still readable.
  const ctxDirty = r.resolve({ mode: "incremental", base, context: { allow: ["src/routes/b.js"] } });
  assert.equal(ctxDirty.workingTreeMatchesTarget, false, "b.js on disk is not the target's b.js");
  const p = semantic.buildSemanticPlan({ workspacePath: r.dir, home: r.home, env: r.env, scope: { mode: "incremental", base, context: { allow: ["src/routes/b.js"] } } });
  assert.ok(p.blockers.some((b) => b.code === "SCOPE_TARGET_NOT_CHECKED_OUT"));
  const other = r.resolve({ mode: "incremental", base, target: base, dirty: "all" });
  assert.deepEqual(other.blockers.map((b) => b.code), ["SCOPE_DIRTY_REQUIRES_HEAD_TARGET"]);
});

test("the access guard reads subjects and context only, refuses exclusions, escapes and the rest, and expands only under the bounded policy within limits", () => {
  const r = repo({ ...APP, "secret.env": "TOKEN=x\n" });
  const strict = r.resolve({ mode: "selected", subjects: [{ kind: "path", value: "src/routes/a.js" }], exclusions: ["src/routes/c.js"] });
  const guard = scope.createScopeGuard({ workspacePath: r.dir, resolution: strict, env: r.env });
  assert.match(guard.read("src/routes/a.js"), /requireUser/);
  assert.equal(guard.check("src/auth/guard.js").role, "context");
  assert.throws(() => guard.read("../secret.env"), (e) => e.decision.code === "PATH_ESCAPE");
  assert.throws(() => guard.read("src/routes/c.js"), (e) => e.decision.code === "EXCLUDED");
  assert.throws(() => guard.read("secret.env"), (e) => e.decision.code === "OUTSIDE_SCOPE");
  assert.equal(guard.requestExpansion("src/other.js", "needed").allowed, false, "strict: no expansion");
  assert.deepEqual(guard.violations().map((v) => v.code), ["PATH_ESCAPE", "EXCLUDED", "OUTSIDE_SCOPE", "OUTSIDE_SCOPE"]);

  const bounded = r.resolve({ mode: "selected", subjects: [{ kind: "path", value: "src/routes/a.js" }], context: { policy: "bounded", maxFiles: 3, maxDepth: 1 } });
  const used = bounded.context.filter((c) => c.relation !== "explicit").length;
  const g2 = scope.createScopeGuard({ workspacePath: r.dir, resolution: bounded, env: r.env });
  const admitted = [];
  for (const f of ["src/other.js", "src/lib/http.js", "package.json"]) admitted.push(g2.requestExpansion(f, "the hunter asked").allowed);
  assert.equal(admitted.filter(Boolean).length, 3 - used);
  assert.equal(g2.expansions().length, 3 - used);
  assert.ok(g2.violations().some((v) => v.code === "EXPANSION_LIMIT"));
  assert.equal(g2.check("src/other.js").role, "expanded");
});

test("the ledger leaves a unit clean only when the completed review received it without a live finding", () => {
  const sent = new Set(["a.js", "b.js", "c.js"]);
  const st = (unit, findings, completed = true, s = sent) => scope.examinedState(unit, { completed, findings, sent: s }).state;
  assert.equal(st("a.js", []), "clean");
  assert.equal(st("a.js", [], false), "unresolved");
  assert.equal(st("d.js", []), "unresolved", "not sent");
  assert.equal(st("a.js", [], true, null), "unresolved");
  assert.equal(st("a.js", [{ path: "a.js", confirmation: "rejected" }]), "clean");
  assert.equal(st("a.js", [{ path: "a.js", confirmation: "needs-validation" }]), "unresolved");
  assert.equal(st("a.js", [{ path: "a.js", confirmation: "confirmed" }]), "findings");
  assert.equal(st("b.js", [{ path: "a.js", confirmation: "confirmed" }]), "clean");
  assert.equal(st("b.js", [{ confirmation: "confirmed" }]), "unresolved", "a finding without a file leaves every unit unresolved");
});

test("the API run choices become CLI flags that resolve the same scope (the server starts runs through the CLI)", () => {
  const r = repo(APP);
  const base = r.head();
  r.write("src/auth/guard.js", "export function requireUser(req) { return req.user || null; }\n");
  r.git("commit", "-q", "-am", "guard");
  const choices = { purpose: "security", rigor: "deep", budget: { maxCalls: 3 }, scope: { mode: "incremental", base, exclusions: ["src/routes/b.js"], context: { maxFiles: 4, allow: ["src/other.js"] } } };
  const args = scope.semanticChoiceArgs(choices);
  assert.ok(args.every((a) => a.startsWith("--") && a.includes("=")));
  const cli = spawnSync(process.execPath, [path.join(DIST, "cli", "main.js"), "semantic", "plan", "--cwd", r.dir, "--json", ...args], { encoding: "utf8", env: r.env });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  const viaCli = JSON.parse(cli.stdout).plan;
  const inProcess = semantic.buildSemanticPlan({ workspacePath: r.dir, home: r.home, env: r.env, ...choices });
  assert.equal(viaCli.scope.resolution.scopeHash, inProcess.scope.resolution.scopeHash);
  assert.deepEqual([viaCli.purpose, viaCli.rigor, viaCli.budget], ["security", "deep", { maxCalls: 3, maxTokens: null }]);
});

test("scope controls are identical for every purpose and scope resolution ignores rigor and budget", () => {
  assert.deepEqual(scope.scopeControls("security"), scope.scopeControls("general-review"));
  const r = repo(APP);
  const a = semantic.buildSemanticPlan({ workspacePath: r.dir, home: r.home, env: r.env, rigor: "quick", budget: { maxCalls: 1 } });
  const b = semantic.buildSemanticPlan({ workspacePath: r.dir, home: r.home, env: r.env, rigor: "deep", budget: { maxTokens: 9 } });
  assert.equal(a.scope.resolution.scopeHash, b.scope.resolution.scopeHash);
  assert.notEqual(a.planHash, b.planHash);
  const sec = semantic.buildSemanticPlan({ workspacePath: r.dir, home: r.home, env: r.env, purpose: "security" });
  // The security-audit module is registered: the security purpose is no longer blocked as unavailable.
  assert.deepEqual(sec.methods.map((m) => m.id), ["security-audit"]);
  assert.equal(sec.blockers.some((x) => x.code === "SEMANTIC_METHOD_UNAVAILABLE"), false);
  assert.equal(sec.scope.resolution.scopeHash, a.scope.resolution.scopeHash);
});

test("purpose is only a shortcut for a method list: same plan hash as the methods, methods win, no purpose label", () => {
  const r = repo(APP);
  const plan = (extra) => semantic.buildSemanticPlan({ workspacePath: r.dir, home: r.home, env: r.env, ...extra });
  const viaPurpose = plan({ purpose: "security" });
  const viaMethod = plan({ methods: ["security-audit"] });
  assert.equal(viaPurpose.planHash, viaMethod.planHash, "--purpose security plans the same run as --method security-audit");
  const both = plan({ purpose: "general-review", methods: ["security-audit"] });
  assert.deepEqual(both.methods.map((m) => m.id), ["security-audit"], "with both, the methods win");
  assert.equal(both.purpose, null, "no purpose label when methods are named");
  assert.equal(both.planHash, viaMethod.planHash);
  assert.equal(viaMethod.purpose, null);
  assert.equal(plan({}).purpose, null, "no purpose given, none shown");
  assert.deepEqual(plan({ methods: ["general-review", "security-audit"] }).methods.map((m) => m.id), ["general-review", "security-audit"], "two methods keep their order");
});
