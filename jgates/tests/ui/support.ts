import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Shared helpers of the browser specs: a Python fixture with one known Ruff violation, the `jgates ui` server started
// against it and the bootstrap link read from the launcher file (the server never prints the secret).

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, "..", "..", "..");
export const MAIN = path.join(REPO, "jgates", "dist", "cli", "main.js");
const VENV_BIN = path.join(REPO, ".venv", process.platform === "win32" ? "Scripts" : "bin");
export const PYTHON = process.env.JGATES_PYTHON ?? path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
export const RUFF = process.env.JGATES_RUFF ?? path.join(VENV_BIN, process.platform === "win32" ? "ruff.exe" : "ruff");

export const PYTEST_SECTION = `[tool.pytest.ini_options]\naddopts = "-q"\n`;
export const PYPROJECT = `[project]
name = "demo"
version = "0.1.0"

${PYTEST_SECTION}
[tool.ruff.lint]
select = ["E", "F"]
`;
// One violation per rule: F401 (unused import) and E711 (comparison to None).
export const MODULE = "import os\n\n\ndef check(value):\n    return value == None\n";

export interface Fixture {
  dir: string;
  home: string;
  /** SEMANTIC_GATE_HOME: the key store (secrets.json) and the provider preferences (config.json). */
  store: string;
  pyproject: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

export function createFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ui-ws-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ui-home-"));
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ui-bin-"));
  // The user's key store and provider preferences (SEMANTIC_GATE_HOME) are a temporary folder too: a screen never reads
  // nor writes the real ones, and no key of the machine's environment shows up.
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ui-store-"));
  fs.mkdirSync(path.join(dir, "demo"));
  fs.writeFileSync(path.join(dir, "pyproject.toml"), PYPROJECT);
  fs.writeFileSync(path.join(dir, "demo", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "demo", "mod.py"), MODULE);
  // An empty PATH keeps the run from finding tools of the machine: Python and Ruff come by absolute path.
  const env: NodeJS.ProcessEnv = { ...process.env, JGATES_HOME: home, SEMANTIC_GATE_HOME: store, JGATES_PYTHON: PYTHON, JGATES_RUFF: RUFF, PATH: emptyBin };
  for (const name of Object.keys(env)) if (/_API_KEY$|^SEMANTIC_GATE_(?!HOME$)/.test(name)) delete env[name];
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"], { env, encoding: "utf8", timeout: 120_000 });
  if (init.status !== 0) throw new Error(`jgates init failed: ${init.stdout}${init.stderr}`);
  // The binding: the Ruff instance reads its configuration from the pyproject.toml the editor writes.
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    config: pyproject.toml\n");
  return {
    dir,
    home,
    store,
    pyproject: path.join(dir, "pyproject.toml"),
    env,
    cleanup() {
      for (const d of [dir, home, emptyBin, store]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

export interface UiServer {
  info: any;
  bootstrapUrl: string;
  stop(): Promise<void>;
}

/** Starts `jgates ui --no-open --port 0 --json` and reads the bootstrap link from the launcher file. */
export async function startServer(fixture: Fixture, options: { policy?: boolean } = {}): Promise<UiServer> {
  // With `policy` the folder of the fixture is served as a CI policy (jgates ui --policy) instead of a project.
  const child: ChildProcess = spawn(process.execPath, [MAIN, "ui", "--no-open", "--port", "0", "--json", options.policy ? "--policy" : "--cwd", fixture.dir], { env: fixture.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stderr?.on("data", (c) => (err += c));
  const info = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`jgates ui did not report in time: ${out}${err}`)), 60_000);
    child.stdout?.on("data", (chunk) => {
      out += chunk;
      try {
        const doc = JSON.parse(out);
        clearTimeout(timer);
        resolve(doc);
      } catch {
        // The JSON document is not complete yet.
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`jgates ui exited with ${code}: ${out}${err}`));
    });
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const hard = setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(hard);
  };
  try {
    const launcher = fs.readFileSync(info.launcher, "utf8");
    const match = launcher.match(/https?:\/\/[^"'<>\s]*\/session\/bootstrap\?token=[A-Za-z0-9_\-%.~]+/);
    if (!match) throw new Error("bootstrap link not found in the launcher file");
    return { info, bootstrapUrl: match[0].replace(/&amp;/g, "&"), stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** The section of a TOML text that starts at `header`, up to the next table header. */
export function tomlSection(text: string, header: string): string {
  const start = text.indexOf(header);
  if (start < 0) return "";
  const rest = text.slice(start + header.length);
  const next = rest.search(/^\[/m);
  return text.slice(start, next < 0 ? undefined : start + header.length + next);
}
