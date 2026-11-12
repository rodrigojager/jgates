// Renders the pre-rendered image of each Semantic mascot, shown where WebGL is unavailable:
// ui/src/mascots/semantic/fallback/<id>.webp, from the same models and renderer the UI draws with WebGL (static
// three-quarter pose, transparent background, so one image serves the light and dark themes). Run it after changing a
// model, from the repository root: `node jgates/scripts/render-semantic-mascots.mjs`. It bundles the renderer with Vite
// into a temporary folder and draws in a headless Chrome (JGATES_CHROME, else the system Chrome, else Playwright's).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mascotsDir = path.join(root, "ui", "src", "mascots", "semantic");
const outDir = path.join(mascotsDir, "fallback");
const SIZE = 320;
const ORIGIN = "http://mascots.invalid";

const { SEMANTIC_MASCOT_IDS } = await import(pathToFileURL(path.join(mascotsDir, "catalog.js")).href);
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-semantic-mascots-"));
try {
  await build({
    configFile: false,
    logLevel: "warn",
    root: mascotsDir,
    build: {
      outDir: bundleDir,
      emptyOutDir: true,
      minify: false,
      lib: { entry: path.join(mascotsDir, "renderer.js"), formats: ["es"], fileName: () => "renderer.js" },
    },
  });
  const chrome = process.env.JGATES_CHROME ?? ["/usr/bin/google-chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find((p) => fs.existsSync(p));
  const browser = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route(`${ORIGIN}/**`, async (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (name === "index.html") return route.fulfill({ contentType: "text/html", body: '<!doctype html><script type="module">import * as r from "./renderer.js"; window.mascots = r;</script>' });
      const file = path.join(bundleDir, name);
      if (!file.startsWith(bundleDir) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(file) });
    });
    await page.goto(`${ORIGIN}/index.html`);
    await page.waitForFunction(() => "mascots" in window);
    fs.mkdirSync(outDir, { recursive: true });
    for (const id of SEMANTIC_MASCOT_IDS) {
      const url = await page.evaluate(([mascot, size]) => window.mascots.renderSemanticMascotImage(mascot, size, size, "image/webp", 0.9), [id, SIZE]);
      if (!url.startsWith("data:image/webp;base64,")) throw new Error(`${id}: the browser did not encode WebP`);
      const file = path.join(outDir, `${id}.webp`);
      fs.writeFileSync(file, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
      console.log(`${path.relative(root, file)}: ${fs.statSync(file).size} bytes`);
    }
    if (errors.length) throw new Error(errors.join("\n"));
  } finally {
    await browser.close();
  }
} finally {
  fs.rmSync(bundleDir, { recursive: true, force: true });
}
