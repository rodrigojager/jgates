import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The tools image pin file and the engine/image preflight, seen from outside: `jgates plan --json` against the fake
// engine (jgates/tests/docker/fake-docker.cjs, which records every call), the reasons catalogue and the package.

const here = path.dirname(fileURLToPath(import.meta.url));
// This file tests the container mode (the default outside the tools image): not the in-image mode of the other tests
// (tests/setup/in-image.mjs); every engine call goes to the fake engine.
const IN_IMAGE_JSON = process.env.JGATES_IMAGE_JSON;
delete process.env.JGATES_IMAGE_JSON;
const packageRoot = path.resolve(here, "..");
const repoRoot = path.resolve(packageRoot, "..");
const MAIN = path.join(packageRoot, "dist", "cli", "main.js");
const FAKE = path.join(here, "docker", "fake-docker.cjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const load = (...parts) => import(pathToFileURL(path.join(packageRoot, "dist", ...parts)).href);

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** A workspace with two Python files (several planned items), a data folder and a fake engine. */
function setup({ fake = {}, runtime } = {}) {
  const dir = tmp("jgates-ti-ws-");
  const home = tmp("jgates-ti-home-");
  const bin = tmp("jgates-ti-bin-");
  const log = path.join(bin, "calls.jsonl");
  const wrapper = path.join(bin, "docker.cjs");
  const settings = { FAKE_DOCKER_LOG: log, FAKE_DOCKER_STATE: bin, ...fake };
  fs.writeFileSync(wrapper, `Object.assign(process.env, ${JSON.stringify(settings)});\nrequire(${JSON.stringify(FAKE)});\n`);
  fs.writeFileSync(path.join(dir, "mod.py"), "import os\n");
  const base = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime ?? wrapper, JGATES_NO_CACHE: "1", NO_COLOR: "1" };
  delete base.JGATES_TOOLS_IMAGE;
  const cli = (args, env = {}) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: dir, encoding: "utf8", env: { ...base, ...env }, timeout: 120_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, doc };
  };
  const init = cli(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const plan = (env = {}) => {
    const r = cli(["plan", "--cwd", dir, "--json"], env);
    assert.ok(r.doc, r.stdout + r.stderr);
    return r.doc.plan ?? r.doc;
  };
  return { dir, plan, calls };
}

const codes = (plan) => plan.blockers.map((b) => b.code);

test("inside the tools image (in-image mode) the plan does not look at the engine: the checks run natively there", () => {
  const w = setup({ fake: { FAKE_DOCKER_LABELS: "none" } });
  const plan = w.plan({ JGATES_IMAGE_JSON: IN_IMAGE_JSON });
  assert.ok(!codes(plan).some((c) => c.startsWith("IMAGE_") || c.startsWith("ENGINE_")), JSON.stringify(plan.blockers));
  assert.ok(!w.calls().some((c) => c[0] === "image"), "no engine call was made");
});

test("with the image absent the plan has the single blocker IMAGE_MISSING, with text and action in both languages", () => {
  const w = setup({ fake: { FAKE_DOCKER_LABELS: "none" } });
  const expected = {
    // The size is the pin's: MB for the first minimal image, GB for the full one.
    en: { label: "Download now", text: /^The JGates tools have not been downloaded yet \(\d+(\.\d)? (MB|GB)\)\.$/ },
    "pt-BR": { label: "Baixar agora", text: /^As ferramentas do JGates ainda não foram baixadas \(\d+(,\d)? (MB|GB)\)\.$/ },
  };
  for (const locale of ["en", "pt-BR"]) {
    const plan = w.plan({ JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_LOCALE: locale });
    const missing = plan.blockers.filter((b) => b.code === "IMAGE_MISSING");
    assert.equal(missing.length, 1, `${locale}: ${JSON.stringify(plan.blockers)}`);
    assert.match(missing[0].message, expected[locale].text);
    assert.equal(missing[0].action.label, expected[locale].label);
    assert.equal(missing[0].action.kind, "command");
    assert.equal(plan.approvable, false);
    assert.ok(plan.groups.willRun.length >= 1, "planned items exist, yet the blocker is shown once");
  }
});

test("no engine at all is ENGINE_NOT_INSTALLED; an engine that is stopped is ENGINE_STOPPED", () => {
  const none = setup({ runtime: path.join(os.tmpdir(), "jgates-no-such-engine-binary") });
  const notInstalled = none.plan({ JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_LOCALE: "en" });
  assert.deepEqual(codes(notInstalled).filter((c) => c.startsWith("ENGINE_") || c.startsWith("IMAGE_")), ["ENGINE_NOT_INSTALLED"]);
  const b1 = notInstalled.blockers.find((b) => b.code === "ENGINE_NOT_INSTALLED");
  assert.equal(b1.action.label, "Download Docker Desktop");
  assert.equal(b1.action.kind, "link");
  assert.match(b1.action.url, /^https:\/\/www\.docker\.com\//);

  const stopped = setup({ fake: { FAKE_DOCKER_DAEMON: "stopped" } });
  const en = stopped.plan({ JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_LOCALE: "en" });
  assert.deepEqual(codes(en).filter((c) => c.startsWith("ENGINE_") || c.startsWith("IMAGE_")), ["ENGINE_STOPPED"]);
  const b2 = en.blockers.find((b) => b.code === "ENGINE_STOPPED");
  assert.equal(b2.message, "Docker is installed, but it is stopped.");
  assert.equal(b2.action.label, "Open Docker Desktop");
  assert.match(b2.details, /Cannot connect to the Docker daemon/, "the raw engine text is only in the details");
  const pt = stopped.plan({ JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_LOCALE: "pt-BR" });
  const b3 = pt.blockers.find((b) => b.code === "ENGINE_STOPPED");
  assert.equal(b3.message, "O Docker está instalado, mas parado.");
  assert.equal(b3.action.label, "Abrir o Docker Desktop");
});

test("an engine with too little memory blocks with ENGINE_LOW_MEMORY", () => {
  const w = setup({ fake: { FAKE_DOCKER_MEMORY_MB: "2048", FAKE_DOCKER_LABELS: JSON.stringify({ "org.jgates.version": VERSION }) } });
  const plan = w.plan({ JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_LOCALE: "en" });
  const low = plan.blockers.find((b) => b.code === "ENGINE_LOW_MEMORY");
  assert.ok(low, JSON.stringify(plan.blockers));
  assert.match(low.message, /^Docker has 2 GB of memory; some checks of this plan need 4 GB\.$/);
});

test("an image of this JGates version leaves the plan without engine or image blockers", () => {
  const w = setup({ fake: { FAKE_DOCKER_LABELS: JSON.stringify({ "org.jgates.version": VERSION }) } });
  const plan = w.plan({ JGATES_TOOLS_IMAGE: "jgates-tools:dev" });
  assert.deepEqual(codes(plan).filter((c) => c.startsWith("ENGINE_") || c.startsWith("IMAGE_") || c === "DISK_LOW"), []);
});

test("JGATES_TOOLS_IMAGE picks the image the preflight inspects; without it the pin file's image is checked (container-first by default)", async () => {
  const { readToolsImagePin } = await load("core", "tools-image", "index.js");
  const pin = readToolsImagePin();
  const w = setup({ fake: { FAKE_DOCKER_LABELS: JSON.stringify({ "org.jgates.version": VERSION }) } });
  w.plan({ JGATES_TOOLS_IMAGE: "jgates-tools:dev" });
  w.plan({ JGATES_TOOLS_IMAGE: "registry.example/custom-tools:7" });
  const inspected = w.calls().filter((c) => c[0] === "image" && c[1] === "inspect").map((c) => c[c.length - 1]);
  assert.ok(inspected.includes("jgates-tools:dev"), JSON.stringify(inspected));
  assert.ok(inspected.includes("registry.example/custom-tools:7"), JSON.stringify(inspected));
  w.plan();
  const last = w.calls().filter((c) => c[0] === "image" && c[1] === "inspect").pop();
  assert.equal(last[last.length - 1], pin.reference);
});

test("the pin file holds the image reference, id, version and size, and the package ships it", async () => {
  const { readToolsImagePin, toolsImageTarget } = await load("core", "tools-image", "index.js");
  const pin = readToolsImagePin();
  assert.match(pin.digest, /^sha256:[0-9a-f]{64}$/);
  if (pin.published) {
    assert.match(pin.reference, /^ghcr\.io\/.+\/jgates-tools@sha256:[0-9a-f]{64}$/);
    assert.equal(pin.reference.split("@")[1], pin.digest);
  } else {
    assert.equal(pin.reference, "jgates-tools:dev");
  }
  assert.ok(pin.imageVersion && pin.jgatesVersion && pin.sizeBytes > 0);
  assert.equal(pin.platform, "linux/amd64");
  assert.deepEqual(toolsImageTarget({ JGATES_TOOLS_IMAGE: "jgates-tools:dev" }, pin), { reference: "jgates-tools:dev", source: "env" });
  assert.equal(toolsImageTarget({}, pin).source, "pin");

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: repoRoot, encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024, timeout: 240_000 });
  assert.equal(r.status, 0, r.stderr);
  const packed = JSON.parse(r.stdout.slice(r.stdout.indexOf("["))).at(0).files.map((f) => f.path.replace(/\\/g, "/"));
  assert.ok(packed.includes("jgates/release/tools-image.json"), "the pin file is in the package");
});

test("the reasons catalogue has the text and the action of every engine and image code in both languages", async () => {
  const { REASONS, resolveReason, formatBytes } = await load("core", "reasons", "index.js");
  const params = { have: "2 GB", need: "4 GB", missing: "3 GB", size: "2,4 GB", done: "1 GB", total: "2 GB", reason: "x", actual: "1", expected: "2", platform: "linux/arm64" };
  for (const code of ["ENGINE_NOT_INSTALLED", "ENGINE_STOPPED", "ENGINE_LOW_MEMORY", "DISK_LOW", "IMAGE_MISSING", "IMAGE_PULLING", "IMAGE_PULL_FAILED", "IMAGE_VERSION_MISMATCH"]) {
    assert.ok(REASONS[code], code);
    const en = resolveReason(code, params, "en");
    const pt = resolveReason(code, params, "pt-BR");
    for (const r of [en, pt]) {
      assert.ok(r.message && !/reason_|\{/.test(r.message), `${code}: ${r.message}`);
      assert.ok(r.action.label && !r.action.label.startsWith("reason_"), code);
      assert.ok(["command", "link", "route", "none"].includes(r.action.kind));
    }
    assert.notEqual(en.message, pt.message, code);
  }
  assert.equal(formatBytes(2_400_000_000, "pt-BR"), "2,4 GB");
  assert.equal(formatBytes(2_400_000_000, "en"), "2.4 GB");
  assert.equal(formatBytes(113_744_376, "pt-BR"), "113,7 MB");
  assert.throws(() => resolveReason("NOT_A_CODE"), /no entry/);
});
