#!/usr/bin/env node
// Install smoke: packs the checkout (npm pack, never npm publish), installs the tarball in a temporary folder whose path
// has a space and Unicode characters, and runs the installed commands from there:
//
//   jgates --version, jgates doctor --json, quality-gate --help, semantic-gate --version
//   jgates ui --no-open --json: serves the UI, and the HTML and the assets reference no external domain
//
// It is the same routine tests/install.test.js runs on Linux. On Windows, run it in the user's local session:
//
//   node scripts/smoke-install.mjs [--tarball <file.tgz>] [--keep] [--online]
//
// --tarball  use an already packed tarball instead of packing the checkout
// --keep     keep the temporary folder (printed at the end)
// --online   let npm reach the registry for the runtime dependencies (the default tries the npm cache only first)
//
// Manual script for the user's Windows session (no Docker needed, no CI minutes):
//   1. Open PowerShell in a clone of the repository, with Node 22 or newer (node --version).
//   2. Run `npm install` once if node_modules is missing, then `npm --prefix jgates run build` so jgates/dist exists.
//   3. Run `node scripts/smoke-install.mjs`. Every step prints "ok" or "FAIL"; the exit code is 0 only if all pass.
//   4. Run it again with the clone under a path that has spaces and accents (for example C:\Users\Ana Júlia\proj).
//   5. In the printed temporary folder (use --keep), run `node_modules\.bin\jgates.cmd ui --no-open` and open the
//      launcher address it prints; confirm the browser shows the interface and the network tab has no external request.
//   6. Report the printed lines and any FAIL back to the session that orchestrates the work.
// macOS is not tested on a real Mac; the documentation says so.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..");

/** Folder name with a space and non-ASCII characters (accents, CJK, an emoji-free symbol), as a user path may have. */
export const UNICODE_DIR_NAME = "jgates instalação ünï 配置";

const ALLOWED_URLS = [/^http:\/\/www\.w3\.org\//, /^https:\/\/react\.dev\/errors\/?$/];

/** Addresses in `text` that point outside the local server (a registry, a CDN, a font host...). */
export function externalUrls(text) {
  const found = text.match(/(?:https?:)?\/\/[A-Za-z0-9][^\s"'`)<>\\]*/g) ?? [];
  return found.filter((u) => /^(https?:)?\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/.test(u) && !ALLOWED_URLS.some((re) => re.test(u)));
}

function npmCommand() {
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(cli)) return { cmd: process.execPath, prefix: [cli], shell: false };
  return { cmd: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [], shell: process.platform === "win32" };
}

/** Runs npm with the given arguments (no shell quoting needed when npm-cli.js is found beside node). */
export function npm(args, options = {}) {
  const { cmd, prefix, shell } = npmCommand();
  return spawnSync(cmd, [...prefix, ...args], { encoding: "utf8", shell, ...options });
}

/** Packs the checkout into `dest`. Lifecycle scripts are off: the build is already done and `prepare` needs the network. */
export function packCheckout(dest, root = REPO_ROOT) {
  const result = npm(["pack", "--ignore-scripts", "--json", "--pack-destination", dest], { cwd: root });
  if (result.status !== 0) throw new Error(`npm pack failed (${result.status}):\n${result.stderr}`);
  const info = JSON.parse(result.stdout)[0];
  return { tarball: path.join(dest, info.filename), files: info.files.map((f) => f.path), size: info.size };
}

function run(file, args, options = {}) {
  return spawnSync(process.execPath, [file, ...args], { encoding: "utf8", ...options });
}

function request(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: p, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

function startUi(main, cwd, home) {
  const proc = spawn(process.execPath, [main, "ui", "--cwd", cwd, "--no-open", "--port", "0", "--json"], {
    env: { ...process.env, JGATES_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  proc.stderr.on("data", (d) => (err += d));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`jgates ui did not start:\n${out}\n${err}`));
    }, 30_000);
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

function stop(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once("exit", () => resolve());
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
  });
}

/**
 * Installs `tarball` in `<base>/<UNICODE_DIR_NAME>/app` and checks the installed commands.
 * Returns { dir, steps }, where each step is { name, ok, detail }. Never throws for a failed check.
 */
export async function smokeInstall({ tarball, base, online = false, log = () => {} }) {
  const steps = [];
  const check = (name, ok, detail = "") => {
    steps.push({ name, ok, detail });
    log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${String(detail).split("\n").join("\n     ")}`}`);
    return ok;
  };
  const dir = path.join(base, UNICODE_DIR_NAME, "app");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "install-smoke", version: "0.0.0", private: true }));

  // Runtime dependencies come from the npm cache first, so the smoke needs no network when they are cached.
  const common = ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];
  let install = npm([...common, "--offline"], { cwd: dir });
  if (install.status !== 0 && online) install = npm(common, { cwd: dir });
  if (!check("npm install of the tarball", install.status === 0, `${install.stdout}\n${install.stderr}`)) return { dir, steps };

  const pkgDir = path.join(dir, "node_modules", "jgates");
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const bin = (name) => path.join(pkgDir, pkg.bin[name]);

  const shim = process.platform === "win32" ? "jgates.cmd" : "jgates";
  check("the jgates shim is in node_modules/.bin", fs.existsSync(path.join(dir, "node_modules", ".bin", shim)));

  const version = run(bin("jgates"), ["--version"], { cwd: dir });
  check("jgates --version", version.status === 0 && version.stdout.includes(pkg.version), `${version.stdout}${version.stderr}`);

  const quality = run(bin("quality-gate"), ["--help"], { cwd: dir });
  check("quality-gate --help", quality.status === 0 && quality.stdout.includes("quality-gate"), `${quality.stdout}${quality.stderr}`);

  const semantic = run(bin("semantic-gate"), ["--version"], { cwd: dir });
  check("semantic-gate --version", semantic.status === 0 && /^\d+\.\d+\.\d+/.test(semantic.stdout.trim()), `${semantic.stdout}${semantic.stderr}`);

  // doctor may report missing tools (exit 1 is a finding, not a crash): the JSON document must still be valid.
  const project = path.join(dir, "projeto com espaço");
  fs.mkdirSync(project, { recursive: true });
  const doctor = run(bin("jgates"), ["doctor", "--json", "--cwd", project], { cwd: project });
  let doctorJson = null;
  try {
    doctorJson = JSON.parse(doctor.stdout);
  } catch {
    doctorJson = null;
  }
  check("jgates doctor --json prints a JSON document", doctorJson !== null && typeof doctorJson === "object" && doctor.status !== null && doctor.status <= 1, `exit ${doctor.status}\n${doctor.stdout.slice(0, 400)}${doctor.stderr}`);

  const skill = path.join(pkgDir, "jgates", "skill", "SKILL.md");
  check("the agent skill is in the package", fs.existsSync(skill));

  // The UI: served from the installed package, with no external reference.
  const home = path.join(dir, "jgates-home");
  let ui = null;
  try {
    ui = await startUi(bin("jgates"), project, home);
    const port = ui.info.port;
    const launcher = fs.readFileSync(ui.info.launcher, "utf8");
    const href = /href="([^"]+)"/.exec(launcher)?.[1]?.replace(/&amp;/g, "&");
    const url = new URL(href);
    const boot = await request(port, url.pathname + url.search);
    const cookie = String(boot.headers["set-cookie"]?.[0] ?? "").split(";")[0];
    const page = await request(port, "/", { Cookie: cookie });
    const html = page.body.toString("utf8");
    check("jgates ui --no-open serves the page", boot.status === 200 && page.status === 200 && /^text\/html/.test(String(page.headers["content-type"])), `bootstrap ${boot.status}, page ${page.status}`);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    const texts = [html];
    let assetsOk = assets.length > 0;
    for (const asset of assets) {
      const res = await request(port, asset, { Cookie: cookie });
      if (res.status !== 200) assetsOk = false;
      texts.push(res.body.toString("utf8"));
    }
    check("the page assets are served", assetsOk, assets.join("\n"));
    // Also scan every compiled asset of the package, including the lazily loaded screens.
    const assetDir = path.join(pkgDir, "jgates", "dist", "ui", "assets");
    for (const name of fs.readdirSync(assetDir)) if (/\.(js|css|html)$/.test(name)) texts.push(fs.readFileSync(path.join(assetDir, name), "utf8"));
    const external = [...new Set(texts.flatMap(externalUrls))];
    check("the HTML and the assets reference no external domain", external.length === 0, external.join("\n"));
  } catch (error) {
    check("jgates ui --no-open", false, error instanceof Error ? error.message : String(error));
  } finally {
    if (ui) await stop(ui.proc);
  }
  return { dir, steps };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const valueOf = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-smoke-"));
  let tarball = valueOf("--tarball");
  if (!tarball) {
    if (!fs.existsSync(path.join(REPO_ROOT, "jgates", "dist", "ui", "index.html"))) {
      console.error("jgates/dist is missing: run `npm --prefix jgates run build` first.");
      process.exit(2);
    }
    tarball = packCheckout(base).tarball;
    console.log(`packed ${tarball}`);
  }
  const { dir, steps } = await smokeInstall({ tarball: path.resolve(tarball), base, online: flag("--online"), log: (line) => console.log(line) });
  const failed = steps.filter((s) => !s.ok).length;
  console.log(`${steps.length - failed}/${steps.length} steps passed`);
  if (flag("--keep")) console.log(`kept: ${dir}`);
  else fs.rmSync(base, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
