import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The UI (React + Vite in jgates/ui) is built into dist/ui, served by the local server after the session check, and
// references nothing outside the server. Browser automation is in tests/ui.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const uiDist = path.join(root, "dist", "ui");
const uiSrc = path.join(root, "ui", "src");
const MAIN = path.join(root, "dist", "cli", "main.js");

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// URLs that appear in the bundle as plain strings: XML namespaces of the SVG/MathML DOM code and the text of React's
// production error messages. None of them is ever requested.
const ALLOWED_URLS = [/^http:\/\/www\.w3\.org\//, /^https:\/\/react\.dev\/errors\/?$/];

function externalUrls(text) {
  const found = text.match(/(?:https?:)?\/\/[A-Za-z0-9][^\s"'`)<>\\]*/g) ?? [];
  return found.filter((u) => /^(https?:)?\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/.test(u) && !ALLOWED_URLS.some((re) => re.test(u)));
}

test("the UI build produces the entry page and hashed assets inside the package", () => {
  const index = path.join(uiDist, "index.html");
  assert.ok(fs.existsSync(index), "dist/ui/index.html is missing: run npm --prefix jgates run build");
  const html = fs.readFileSync(index, "utf8");
  assert.match(html, /<script type="module"[^>]* src="\/assets\/[^"]+\.js"/);
  assert.match(html, /<link rel="stylesheet"[^>]* href="\/assets\/[^"]+\.css"/);
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(html), "the entry page has no inline script");
  assert.ok(!/<style[\s>]/.test(html) && !/\sstyle=/.test(html), "the entry page has no inline style");
  const assets = walk(path.join(uiDist, "assets"));
  assert.ok(assets.some((f) => f.endsWith(".js")) && assets.some((f) => f.endsWith(".css")));
});

test("the built HTML, JS and CSS reference no external domain", () => {
  for (const file of walk(uiDist)) {
    if (!/\.(html|js|css|svg|json)$/.test(file)) continue;
    const found = externalUrls(fs.readFileSync(file, "utf8"));
    assert.deepEqual(found, [], `${path.relative(uiDist, file)} references an external address`);
  }
});

test("the UI sources have no emoji or decorative pictograms and use only catalog keys that exist, in both languages", () => {
  // The catalog is the application file plus the messages.<locale>.json of every screen folder and of the shared components
  // (see ui/src/i18n/index.ts); ui-messages.test.js checks that no key is defined twice and i18n.test.js that both
  // languages have the same keys.
  const catalogs = { "pt-BR": {}, en: {} };
  for (const file of walk(uiSrc)) {
    const match = /(?:^messages|^ui)\.(pt-BR|en)\.json$/.exec(path.basename(file));
    if (!match || !(path.basename(file).startsWith("messages.") || file.endsWith(path.join("i18n", `ui.${match[1]}.json`)))) continue;
    if (path.relative(uiSrc, file).startsWith("forms")) continue;
    Object.assign(catalogs[match[1]], JSON.parse(fs.readFileSync(file, "utf8")));
  }
  const pictograph = /[\p{Extended_Pictographic}\u{FE0F}\u{20E3}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
  const used = new Set();
  for (const file of walk(uiSrc)) {
    const text = fs.readFileSync(file, "utf8");
    const match = pictograph.exec(text);
    assert.equal(match, null, `${path.relative(uiSrc, file)} has a pictogram (${match?.[0]})`);
    if (!/\.tsx?$/.test(file)) continue;
    for (const m of text.matchAll(/\bt\(\s*"([a-z0-9_-]+)"/g)) used.add(m[1]);
  }
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const missing = [...used].filter((key) => !(key in catalog));
    assert.deepEqual(missing, [], `message keys used by the UI but missing from the ${locale} catalog`);
    for (const [key, value] of Object.entries(catalog)) assert.ok(!pictograph.test(value), `${locale} catalog text ${key} has a pictogram`);
  }
  assert.ok(used.size > 40);
});

test("every screen folder has an index.tsx that exports its registration", () => {
  const screensDir = path.join(uiSrc, "screens");
  const folders = fs.readdirSync(screensDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(folders.length >= 4);
  for (const folder of folders) {
    // A folder without an index.tsx only groups the components of a screen (for example tool-area/rules): it is not a screen.
    if (!fs.existsSync(path.join(screensDir, folder.name, "index.tsx"))) {
      const nested = fs.readdirSync(path.join(screensDir, folder.name), { withFileTypes: true });
      assert.ok(nested.length > 0 && nested.every((e) => e.isDirectory()), `${folder.name} has no index.tsx and is not a group of component folders`);
      continue;
    }
    const source = fs.readFileSync(path.join(screensDir, folder.name, "index.tsx"), "utf8");
    assert.match(source, /export const screen\b/, `${folder.name} does not export screen`);
    assert.match(source, /export default function/, `${folder.name} has no default component`);
  }
});

function request(port, method, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

function startUi(dir, home) {
  const proc = spawn(process.execPath, [MAIN, "ui", "--cwd", dir, "--no-open", "--port", "0", "--json"], {
    env: { ...process.env, JGATES_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  proc.stderr.on("data", (d) => (err += d));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`jgates ui did not start:\n${out}\n${err}`)), 30_000);
    proc.stdout.on("data", (d) => {
      out += d;
      try {
        const info = JSON.parse(out);
        clearTimeout(timer);
        resolve({ proc, info });
      } catch {
        // Not complete yet.
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`jgates ui exited with ${code}:\n${out}\n${err}`));
    });
  });
}

test("the server delivers the UI assets only with a session, with the CSP, and refuses path escapes", async () => {
  const dir = tmp("jg-ui-");
  const home = tmp("jg-ui-home-");
  fs.mkdirSync(path.join(dir, ".jgates"), { recursive: true });
  fs.writeFileSync(path.join(dir, "jgates.yml"), "schemaVersion: 1\nextends:\n  - .jgates/tools.yml\n");
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  ruff-api:\n    adapter: ruff\n    config: pyproject.toml\n");
  fs.writeFileSync(path.join(dir, "pyproject.toml"), "[tool.ruff]\nline-length = 88\n");
  let ui = null;
  try {
    ui = await startUi(dir, home);
    const port = ui.info.port;

    const anonymous = await request(port, "GET", "/");
    assert.equal(anonymous.status, 401, "no session, no UI");
    assert.ok(!anonymous.body.toString("utf8").includes("/assets/"));

    const launcher = fs.readFileSync(ui.info.launcher, "utf8");
    const href = /href="([^"]+)"/.exec(launcher)?.[1]?.replace(/&amp;/g, "&");
    const url = new URL(href);
    const boot = await request(port, "GET", url.pathname + url.search);
    assert.equal(boot.status, 200);
    const cookie = String(boot.headers["set-cookie"]?.[0] ?? "").split(";")[0];

    const page = await request(port, "GET", "/", { Cookie: cookie });
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-type"]), /^text\/html/);
    assert.match(String(page.headers["content-security-policy"]), /script-src 'self'/);
    const html = page.body.toString("utf8");
    assert.deepEqual(externalUrls(html), [], "the served HTML references an external address");
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    const style = /href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1];
    assert.ok(script && style, "the served page links the bundle");

    const js = await request(port, "GET", script, { Cookie: cookie });
    assert.equal(js.status, 200);
    assert.match(String(js.headers["content-type"]), /javascript/);
    assert.deepEqual(externalUrls(js.body.toString("utf8")), [], "the served JS references an external address");
    const css = await request(port, "GET", style, { Cookie: cookie });
    assert.equal(css.status, 200);
    assert.match(String(css.headers["content-type"]), /text\/css/);

    const noSessionAsset = await request(port, "GET", script);
    assert.equal(noSessionAsset.status, 401);

    for (const escape of ["/..%2f..%2fpackage.json", "/assets/..%2f..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/package.json", "/assets/missing.js"]) {
      const r = await request(port, "GET", escape, { Cookie: cookie });
      assert.notEqual(r.status, 200, `${escape} must not be served`);
      assert.ok(!r.body.toString("utf8").includes('"name": "jgates"'));
    }
  } finally {
    if (ui && ui.proc.exitCode === null) {
      const exited = once(ui.proc, "exit");
      ui.proc.kill("SIGTERM");
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
