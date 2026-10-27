"use strict";

// Install test: packs the checkout with `npm pack` (never `npm publish`), inspects the tarball, installs it in a
// temporary folder whose path has a space and Unicode characters, and runs the installed commands from there. The routine
// itself lives in scripts/smoke-install.mjs, which the user also runs in a local Windows session.
//
// It needs the compiled jgates (npm --prefix jgates run build) and the npm cache for the runtime dependencies; no
// network is used when they are cached. No model token and no Docker are involved.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const SMOKE = path.join(ROOT, "scripts", "smoke-install.mjs");
const BUILT = fs.existsSync(path.join(ROOT, "jgates", "dist", "ui", "index.html"));
const SKIP_UNBUILT = BUILT ? false : "jgates/dist is missing: run npm --prefix jgates run build";

let smoke = null;
const loadSmoke = async () => (smoke ??= await import(pathToFileURL(SMOKE).href));

const base = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-install-"));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

let packed = null;
async function pack() {
  if (!packed) packed = (await loadSmoke()).packCheckout(base);
  return packed;
}

test("the tarball carries the compiled jgates, the UI assets and the skill, and nothing from development", { skip: SKIP_UNBUILT }, async () => {
  const { files, size } = await pack();
  const has = (p) => files.includes(p);
  assert.ok(has("jgates/dist/cli/main.js"), "compiled CLI");
  assert.ok(has("jgates/dist/ui/index.html"), "UI entry page");
  assert.ok(files.some((f) => /^jgates\/dist\/ui\/assets\/.+\.js$/.test(f)), "UI scripts");
  assert.ok(files.some((f) => /^jgates\/dist\/ui\/assets\/.+\.css$/.test(f)), "UI styles");
  assert.ok(has("jgates/skill/SKILL.md"), "jgates agent skill");
  assert.ok(has("semantic-gate/dist/cli.js") && has("quality-gate/bin/quality-gate.js"), "component commands");
  assert.ok(!files.some((f) => f.startsWith("bin/")), "no removed command in the tarball");

  const forbidden = [/(^|\/)\.venv\//, /(^|\/)node_modules\//, /(^|\/)\.quality\//, /(^|\/)\.git\//, /\.tgz$/, /\.map$/, /(^|\/)__pycache__\//, /\.pyc$/, /^jgates\/(src|ui|dev-tools|tests|scripts)\//, /^docs\//, /^\.scratch\//];
  const leaked = files.filter((f) => forbidden.some((re) => re.test(f)));
  assert.deepEqual(leaked, [], "development files in the tarball");
  assert.ok(size < 5 * 1024 * 1024, `the tarball is ${size} bytes: a heavy fixture got in`);
  const heavy = files.filter((f) => /(^|\/)fixtures\//.test(f) && fs.statSync(path.join(ROOT, f)).size > 64 * 1024);
  assert.deepEqual(heavy, [], "heavy fixtures in the tarball");
});

test("the root package declares the runtime dependencies of jgates, for an install outside the workspace", () => {
  const root = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const jgates = JSON.parse(fs.readFileSync(path.join(ROOT, "jgates", "package.json"), "utf8"));
  assert.equal(root.version, jgates.version);
  assert.deepEqual(root.engines, jgates.engines);
  const source = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (p !== path.join(ROOT, "jgates", "dist", "ui")) walk(p);
      } else if (p.endsWith(".js") && BUILT) source.push(fs.readFileSync(p, "utf8"));
    }
  };
  if (BUILT) walk(path.join(ROOT, "jgates", "dist"));
  const used = new Set();
  for (const text of source) for (const m of text.matchAll(/from "((?:@[^/"]+\/)?[^./"][^/"]*)(?:\/[^"]*)?"/g)) if (!m[1].startsWith("node:")) used.add(m[1]);
  for (const name of used) assert.ok(root.dependencies?.[name], `${name} is imported by jgates/dist but missing in the root dependencies`);
  for (const [name, range] of Object.entries(root.dependencies ?? {})) assert.equal(jgates.dependencies[name], range, `${name} range differs from jgates/package.json`);
});

test("the tarball installs in a folder with a space and Unicode and the installed commands and UI work", { skip: SKIP_UNBUILT, timeout: 240_000 }, async () => {
  const { tarball } = await pack();
  const { smokeInstall, UNICODE_DIR_NAME } = await loadSmoke();
  assert.match(UNICODE_DIR_NAME, / /);
  assert.match(UNICODE_DIR_NAME, /[^\x00-\x7f]/);
  const { dir, steps } = await smokeInstall({ tarball, base, online: process.env.JGATES_INSTALL_ONLINE === "1" });
  assert.ok(dir.includes(UNICODE_DIR_NAME));
  const failed = steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`);
  assert.deepEqual(failed, []);
  for (const required of ["jgates --version", "jgates doctor --json prints a JSON document", "quality-gate --help", "semantic-gate --version", "jgates ui --no-open serves the page", "the HTML and the assets reference no external domain"]) {
    assert.ok(steps.some((s) => s.name === required && s.ok), `step missing: ${required}`);
  }
});

test("the install smoke script exists and documents the manual Windows roteiro", () => {
  const text = fs.readFileSync(SMOKE, "utf8");
  assert.match(text, /Manual script for the user's Windows session/);
  assert.match(text, /--keep/);
  assert.ok(!/npm\s+publish|git\s+tag|gh\s+release/.test(text.replace(/never npm publish/g, "")), "the script must not publish");
});

test("install smoke on Windows", { skip: process.platform === "win32" ? false : "needs Windows: the smoke runs in the user's local Windows session (node scripts/smoke-install.mjs)", timeout: 300_000 }, () => {
  const result = spawnSync(process.execPath, [SMOKE], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
