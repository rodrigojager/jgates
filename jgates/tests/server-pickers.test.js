import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The value pickers of the derived forms (GET /api/pickers/<source>, PLAN-config-editing.md section 3), through the
// route handler run in this process: project files filtered by a pattern (path or file name), folders, local branches
// and tags read from the .git files plus the recent commits from an asynchronous read-only git, the compose services
// and ports as service targets, and the workspace and catalogue vocabularies. An unknown source is refused by the
// route's schema; a project without git says why the git list is empty.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (p) => pathToFileURL(path.resolve(here, "..", "dist", p)).href;

const dirs = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
const made = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

const home = made("jg-pickers-home-");
Object.assign(process.env, { JGATES_HOME: home, JGATES_LOCALE: "en", NO_COLOR: "1" });

const { routes, pickerList } = await import(dist("server/routes/pickers.js"));
const route = routes.find((r) => r.method === "GET" && r.path === "/api/pickers/:source");

function project({ git = true } = {}) {
  const dir = made("jg-pickers-proj-");
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write("jgates.yml", "schemaVersion: 1\n");
  write(".jgates/tools.yml", "schemaVersion: 1\ntools:\n  zz:\n    adapter: zizmor\n");
  write(".jgates/profiles.yml", "schemaVersion: 1\nprofiles:\n  mine:\n    label: Mine\n    extends: builtin:standard\n");
  write(".jgates/architecture.yml", "schemaVersion: 1\narchitecture:\n  layers:\n    - id: domain\n      paths: [src/domain/**]\n  rules: []\n");
  write("compose.yaml", 'services:\n  web:\n    image: nginx\n    ports: ["8080:80"]\n  db:\n    image: postgres\n    expose: ["5432"]\n');
  write("api/openapi.yaml", "openapi: 3.0.0\n");
  write("docs/README.md", "# demo\n");
  write("src/domain/a.py", "x = 1\n");
  write("node_modules/dep/index.js", "\n");
  if (git) {
    const run = (...args) => {
      const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    run("init", "-q", "-b", "main");
    run("add", "-A");
    run("commit", "-q", "-m", "first commit");
    run("branch", "feature/x");
    run("tag", "v1.0");
    run("pack-refs", "--all");
    run("branch", "loose-branch");
  }
  return dir;
}

const values = (list) => list.items.map((i) => i.value);

test("the route takes one value source per path and refuses an unknown one", () => {
  assert.ok(route, "GET /api/pickers/:source");
  assert.deepEqual(route.params.properties.source.enum.includes("git-ref"), true);
  assert.equal(route.params.properties.source.enum.includes("passwords"), false);
});

test("files are filtered by a pattern over the path or the file name; folders leave the technical ones out", async () => {
  const dir = project({ git: false });
  const all = await pickerList(dir, "project-file");
  assert.ok(values(all).includes("api/openapi.yaml"));
  assert.ok(!values(all).some((v) => v.startsWith("node_modules/")), "node_modules is never offered");
  const byPath = await pickerList(dir, "project-file", "(^|/)(openapi|swagger)[^/]*\\.(ya?ml|json)$");
  assert.deepEqual(values(byPath), ["api/openapi.yaml"]);
  const byName = await pickerList(dir, "project-file", "^(openapi|swagger)[^/\\\\]*\\.(ya?ml|json)$");
  assert.deepEqual(values(byName), ["api/openapi.yaml"]);
  const bad = await pickerList(dir, "project-file", "([");
  assert.deepEqual(bad.items, []);
  assert.deepEqual(bad.notes, ["pattern-invalid"]);
  const folders = await pickerList(dir, "project-folder");
  for (const f of ["api", "docs", "src", "src/domain"]) assert.ok(values(folders).includes(f), f);
  assert.ok(!values(folders).includes("node_modules"));
});

test("git refs: loose and packed branches and tags from the .git files, recent commits from git", async () => {
  const dir = project();
  const list = await pickerList(dir, "git-ref");
  assert.deepEqual(list.notes, []);
  const of = (group) => list.items.filter((i) => i.group === group);
  assert.deepEqual(of("branch").map((i) => i.value), ["feature/x", "loose-branch", "main"]);
  assert.deepEqual(of("tag").map((i) => i.value), ["v1.0"]);
  assert.equal(of("commit").length, 1);
  assert.match(of("commit")[0].value, /^[0-9a-f]{40}$/);
  assert.match(of("commit")[0].label, /first commit$/);

  const none = await pickerList(project({ git: false }), "git-ref");
  assert.deepEqual(none.items, []);
  assert.deepEqual(none.notes, ["not-a-repository"]);
});

test("without git the list keeps branches and tags and says the commits are missing", async () => {
  const dir = project();
  const saved = { PATH: process.env.PATH, Path: process.env.Path, JGATES_GIT: process.env.JGATES_GIT };
  try {
    process.env.PATH = "";
    process.env.Path = "";
    process.env.JGATES_GIT = path.join(dir, "no-such-git");
    const list = await pickerList(dir, "git-ref");
    assert.deepEqual(list.notes, ["git-missing"]);
    assert.ok(list.items.some((i) => i.value === "main"));
    assert.ok(!list.items.some((i) => i.group === "commit"));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("service targets are the compose services and their ports; services are their names", async () => {
  const dir = project({ git: false });
  const targets = await pickerList(dir, "service-target");
  assert.deepEqual(values(targets).sort(), ["service:db:5432", "service:web:80"]);
  assert.equal(targets.items.find((i) => i.value === "service:web:80").label, "web : 80");
  assert.deepEqual(values(await pickerList(dir, "service")).sort(), ["db", "web"]);
});

test("vocabularies: profiles, templates, tool instances, adapters, capabilities, selectors, layers, languages", async () => {
  const dir = project({ git: false });
  const profiles = await pickerList(dir, "profile");
  assert.ok(profiles.items.some((i) => i.value === "mine" && i.label === "Mine" && i.group === "project"));
  assert.ok(profiles.items.some((i) => i.value.startsWith("builtin:") && i.group === "builtin"));
  assert.ok(values(await pickerList(dir, "template")).some((v) => v.startsWith("builtin:")));
  assert.ok(values(await pickerList(dir, "tool-instance")).includes("zz"));
  const adapters = await pickerList(dir, "adapter");
  assert.ok(values(adapters).includes("zizmor"));
  assert.ok(values(await pickerList(dir, "capability")).length > 5);
  const selectors = values(await pickerList(dir, "check-selector"));
  assert.ok(selectors.some((v) => v.startsWith("category:")));
  assert.ok(selectors.some((v) => v.startsWith("capability:")));
  assert.ok(selectors.includes("tool:zz"));
  assert.deepEqual(values(await pickerList(dir, "architecture-layer")), ["domain"]);
  const languages = await pickerList(dir, "language");
  assert.ok(values(languages).includes("python"));
  assert.ok(values(await pickerList(dir, "framework")).length > 0);
  assert.ok(Array.isArray((await pickerList(dir, "component")).items));
});

test("the handler answers the list as JSON", async () => {
  const dir = project({ git: false });
  const server = { projectDir: dir };
  const result = await route.handler({ params: { source: "project-folder" }, query: {}, body: undefined, session: null, server, raw: null });
  assert.equal(result.status, 200);
  assert.equal(result.json.status, "OK");
  assert.equal(result.json.source, "project-folder");
  assert.ok(result.json.items.some((i) => i.value === "src/domain"));
});
