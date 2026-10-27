import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// The UI messages are loaded by folder (ui/src/i18n/index.ts): the catalog of a screen sits next to its index.tsx and is
// found without editing a shared file, and ui.pt-BR.json holds only what belongs to the application. The module is
// loaded through Vite (the same import.meta.glob the browser build uses).

const here = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(here, "..", "ui");
const SCREENS = path.join(UI, "src", "screens");

async function loadI18n() {
  const vite = await createServer({ root: UI, configFile: false, logLevel: "silent", server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    return { vite, i18n: await vite.ssrLoadModule("/src/i18n/index.ts") };
  } catch (error) {
    await vite.close();
    throw error;
  }
}

test("the catalogs of the screens are found by folder and no key is defined twice", async () => {
  const { vite, i18n } = await loadI18n();
  try {
    const files = i18n.messageSources().map((s) => s.file);
    assert.ok(files.includes("i18n/ui.pt-BR.json"));
    assert.ok(files.includes("components/messages.pt-BR.json"));
    // Every messages.pt-BR.json under screens/ was loaded, whatever the folder.
    const onDisk = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "messages.pt-BR.json") onDisk.push(path.relative(path.join(UI, "src"), full).split(path.sep).join("/"));
      }
    };
    walk(SCREENS);
    assert.ok(onDisk.length >= 6, `expected the migrated screens, found ${onDisk.join(", ")}`);
    for (const file of onDisk) assert.ok(files.includes(file), `${file} was not loaded`);
    assert.deepEqual(i18n.duplicateKeys(), [], "a key is defined by two catalog files");

    // Keys of screens resolve through the one t().
    assert.equal(i18n.t("plan_title").includes("plan_title"), false);
    assert.equal(i18n.t("env_title").includes("env_title"), false);
    assert.equal(i18n.t("app_skip"), "Pular para o conteúdo");
    assert.equal(i18n.t("missing_key_xyz"), "missing_key_xyz");
  } finally {
    await vite.close();
  }
});

test("ui.pt-BR.json holds only application keys: no screen prefix", async () => {
  const app = JSON.parse(fs.readFileSync(path.join(UI, "src", "i18n", "ui.pt-BR.json"), "utf8"));
  const screenPrefix = /^(tools|tool|plan|run|env|rules|doc|diff|conflict|validation|scope|requirement|decision|support|role)_/;
  const strays = Object.keys(app).filter((k) => screenPrefix.test(k));
  assert.deepEqual(strays, []);
});

test("a new screen folder brings its own messages with no edit to a shared file", async () => {
  const folder = path.join(SCREENS, `zz-i18n-probe-${process.pid}`);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "messages.pt-BR.json"), JSON.stringify({ zzprobe_title: "Tela de teste {name}" }));
  let loaded;
  try {
    loaded = await loadI18n();
    assert.equal(loaded.i18n.t("zzprobe_title", { name: "ok" }), "Tela de teste ok");
    assert.ok(loaded.i18n.messageSources().some((s) => s.file.endsWith(`${path.basename(folder)}/messages.pt-BR.json`)));
  } finally {
    await loaded?.vite.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("a key repeated across catalog files is reported", async () => {
  const folder = path.join(SCREENS, `zz-i18n-dup-${process.pid}`);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "messages.pt-BR.json"), JSON.stringify({ app_skip: "outro texto" }));
  let loaded;
  try {
    loaded = await loadI18n();
    const dup = loaded.i18n.duplicateKeys();
    assert.equal(dup.length, 1);
    assert.equal(dup[0].key, "app_skip");
    // The application catalog wins, so a stray file cannot change the shell.
    assert.equal(loaded.i18n.t("app_skip"), "Pular para o conteúdo");
  } finally {
    await loaded?.vite.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("the Playwright config matches every tests/ui spec with no list", () => {
  const config = fs.readFileSync(path.join(here, "ui", "playwright.config.ts"), "utf8");
  const match = config.match(/testMatch:\s*(\/.+\/)\s*,/);
  assert.ok(match, "testMatch not found");
  assert.equal(match[1], "/\\.spec\\.ts$/");
  const specs = fs.readdirSync(path.join(here, "ui")).filter((f) => f.endsWith(".spec.ts"));
  const re = new RegExp(match[1].slice(1, -1));
  for (const spec of specs) assert.ok(re.test(spec), spec);
  assert.ok(specs.includes("shell.spec.ts"));
});
