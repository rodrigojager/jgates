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
/**
 * JGates runs here as inside the tools image (in-image mode, like the node tests' tests/setup/in-image.mjs): the steps
 * run natively with the test doubles above, the image's tools are the package's mirror of image.json, and no server
 * reaches a real container engine.
 */
export const IN_IMAGE: NodeJS.ProcessEnv = { JGATES_IMAGE_JSON: path.join(REPO, "jgates", "release", "image-tools.json"), JGATES_CONTAINER_RUNTIME: "jgates-test-no-engine" };

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

/**
 * Removes a fixture folder. On Windows a folder cannot go while a process still has it as its working folder (a git
 * child of the stopped server can outlive it for a moment), so EPERM/EBUSY/ENOTEMPTY are retried for up to 30 s; the
 * maxRetries option of fs.rmSync does not cover this case.
 */
export function removeDir(dir: string): void {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (Date.now() > deadline || !["EPERM", "EBUSY", "ENOTEMPTY"].includes(code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

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
  const env: NodeJS.ProcessEnv = { ...process.env, ...IN_IMAGE, JGATES_HOME: home, SEMANTIC_GATE_HOME: store, JGATES_PYTHON: PYTHON, JGATES_RUFF: RUFF, PATH: emptyBin };
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
      for (const d of [dir, home, emptyBin, store]) removeDir(d);
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

// ---- Gate-flow fixture (Quality + Semantic) -----------------------------------------------------------------------------
// A Git workspace whose Quality gate is one controllable generic-command check (the check.mjs of the V2 sequence cases:
// its mode file decides pass / fail / hang) and whose Semantic provider is the scripted mock of semantic-gate. Nothing
// here spends model tokens: the mock answers from a JSON tool script, and the "hanging" reviewer is a local command.

const CHECK = path.join(REPO, "tests", "v2", "fixtures", "sequence", "check.mjs");
/** Every file of the fixture: the subjects of a whole-repository Semantic review. */
export const GATE_FILES = [".jgates/profiles.yml", ".jgates/templates/seq.yml", "evidence.schema.json", "jgates.yml", "src/core/a.js", "src/other/b.js"];
const DIMENSIONS = ["functional-correctness", "tests", "maintainability", "architecture", "performance-reliability", "security"];

function reviewerScript(subjects: string[]) {
  const read = { toolCalls: subjects.map((p) => ({ name: "read_file", arguments: { path: p } })) };
  const plan = { summary: "Fixture modules and their configuration.", dimensions: DIMENSIONS.map((id) => ({ id, files: subjects, hypotheses: [`${id}: nothing suspicious in the fixture`] })) };
  const hunt = { summary: "Every dimension examined; nothing to report.", dimensions: DIMENSIONS.map((id) => ({ id, state: "examined", reviewed_paths: subjects, checks: [`checked ${id}`] })), candidates: [], gaps: [] };
  const answer = (value: unknown) => ({ text: JSON.stringify(value), usage: { inputTokens: 100, outputTokens: 50 } });
  return { contexts: { "evidence-planning": [read, answer(plan)], hunting: [read, answer(hunt)] } };
}

export interface GateFixture {
  dir: string;
  home: string;
  store: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
  /** The mode of the Quality check. */
  setMode(mode: "pass" | "fail" | "hang"): void;
  /** True once the hanging Quality check or the hanging reviewer started. */
  qualityStarted(): boolean;
  reviewerStarted(): boolean;
  /** The files the scripted reviewer reads and examines (default: every file). */
  setReviewSubjects(paths: string[]): void;
  /** Replaces the scripted reviewer by a local command that starts and then never answers (for cancellation). */
  useHangingReviewer(): void;
  /** Names of the run folders under <home>/workspaces/<id>/<kind>. */
  runFolders(kind: "runs" | "semantic-runs" | "sequences"): string[];
  /** Provider calls recorded by the Semantic runs (0 means the model was never invoked). */
  providerCalls(): number;
  git(...args: string[]): string;
  write(rel: string, text: string): void;
}

export function createGateFixture(): GateFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-gates-ws-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-gates-home-"));
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-gates-aux-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-gates-store-"));
  const modeFile = path.join(aux, "mode.txt");
  const script = path.join(aux, "reviewer-script.json");
  const hangFlag = path.join(aux, "reviewer-started.txt");
  const hangScript = path.join(aux, "hang-reviewer.mjs");
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const yamlList = (values: string[]) => `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
  const rootConfig = (provider: string[]) =>
    ["schemaVersion: 1", "selection:", "  profile: seq", "templates:", "  - id: seq", "    source: .jgates/templates/seq.yml", "    activation: always", "extensions:", "  semantic-gate:", ...provider.map((l) => `    ${l}`), "    timeoutSeconds: 120", ""].join("\n");
  write("jgates.yml", rootConfig(["provider: mock", "model: scripted-model"]));
  write(
    ".jgates/templates/seq.yml",
    [
      "schemaVersion: 1",
      "id: seq",
      "config:",
      "  execution:",
      "    timeoutSeconds: 120",
      "  tools:",
      "    seq-check:",
      "      adapter: generic-command",
      "      enabled: true",
      "      capabilities: [lint]",
      `      command: ${JSON.stringify(process.execPath)}`,
      `      args: ${yamlList([CHECK, "{outputDir}", modeFile, "{workspace}"])}`,
      "      config:",
      "        effects: { readsCode: true, writesOutputs: true, mayChangeCode: false, executesProjectCode: true, usesNetwork: false }",
      "        evidence: { kind: json-file, file: evidence.json, schema: evidence.schema.json }",
      "",
    ].join("\n"),
  );
  write("evidence.schema.json", JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { const: true } } }));
  write(".jgates/profiles.yml", ["schemaVersion: 1", "profiles:", "  seq:", "    label: Sequence", "    checks:", '      "capability:lint": { enabled: true }', ""].join("\n"));
  write("src/core/a.js", "exports.a = () => 1;\n");
  write("src/other/b.js", "exports.b = () => 2;\n");
  fs.writeFileSync(modeFile, "pass");
  fs.writeFileSync(script, JSON.stringify(reviewerScript(GATE_FILES)));
  fs.writeFileSync(hangScript, `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(hangFlag)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);

  const git = (...args: string[]): string => {
    const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");

  // The real PATH stays (the Quality check and git need it); keys of the machine never reach the server.
  const env: NodeJS.ProcessEnv = { ...process.env, ...IN_IMAGE, JGATES_HOME: home, SEMANTIC_GATE_HOME: store, JGATES_NO_CACHE: "1", NO_COLOR: "1", SEMANTIC_GATE_MOCK_TOOL_SCRIPT: script };
  for (const name of Object.keys(env)) if (/_API_KEY$|^SEMANTIC_GATE_(?!HOME$|MOCK_TOOL_SCRIPT$)/.test(name)) delete env[name];

  const workspaces = path.join(home, "workspaces");
  const folders = (kind: string): string[] => {
    if (!fs.existsSync(workspaces)) return [];
    return fs.readdirSync(workspaces).flatMap((ws) => {
      const d = path.join(workspaces, ws, kind);
      return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => fs.statSync(path.join(d, n)).isDirectory()) : [];
    });
  };
  return {
    dir,
    home,
    store,
    env,
    write,
    git,
    setMode: (mode) => fs.writeFileSync(modeFile, mode),
    qualityStarted: () => fs.existsSync(`${modeFile}.started`),
    reviewerStarted: () => fs.existsSync(hangFlag),
    setReviewSubjects: (paths) => fs.writeFileSync(script, JSON.stringify(reviewerScript(paths))),
    useHangingReviewer() {
      write("jgates.yml", rootConfig(["provider: command", `command: ${JSON.stringify(process.execPath)}`, `commandArgs: ${yamlList([hangScript])}`, "commandPromptMode: stdin"]));
    },
    runFolders: folders,
    providerCalls() {
      let total = 0;
      if (!fs.existsSync(workspaces)) return 0;
      for (const ws of fs.readdirSync(workspaces)) {
        const d = path.join(workspaces, ws, "semantic-runs");
        if (!fs.existsSync(d)) continue;
        for (const run of fs.readdirSync(d)) {
          try {
            total += Number(JSON.parse(fs.readFileSync(path.join(d, run, "result.json"), "utf8")).semanticRun?.outcome?.calls ?? 0);
          } catch {
            total += 1; // A run without a readable result cannot prove it made no call.
          }
        }
      }
      return total;
    },
    cleanup() {
      for (const d of [dir, home, aux, store]) removeDir(d);
    },
  };
}

/** A started server for a gate fixture (the fixture is not a `Fixture`: it keeps the real PATH). */
export function startGateServer(fixture: GateFixture): Promise<UiServer> {
  return startServer({ ...fixture, pyproject: "" } as unknown as Fixture);
}

/** Opens the application through the bootstrap link and returns the base URL without the hash. */
export async function openApp(page: import("@playwright/test").Page, server: UiServer): Promise<string> {
  await page.goto(server.bootstrapUrl);
  await page.waitForURL((u) => !u.pathname.startsWith("/session"));
  return page.url().split("#")[0] as string;
}

/**
 * Reloads the page. On a first visit in a language other than the cached one the app reloads itself once (see
 * syncLocaleWithPreferences); a reload of the test that meets that one is aborted, so it is asked again.
 */
export async function reloadPage(page: import("@playwright/test").Page): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.reload();
      return;
    } catch (error) {
      if (attempt >= 3 || !String(error).includes("ERR_ABORTED")) throw error;
    }
  }
}

/** GET of a server route from the page (same origin, with the session cookie). */
export async function pageGet<T = any>(page: import("@playwright/test").Page, route: string): Promise<T> {
  return page.evaluate(async (r) => (await fetch(r, { headers: { accept: "application/json" } })).json(), route) as Promise<T>;
}

// ---- Wizard fixture ----------------------------------------------------------------------------------------------------
const FAKE = path.join(REPO, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version as string;
const PINNED = `registry.example.test/jgates/jgates-tools@sha256:${"ab".repeat(32)}`;

/** A project without jgates.yml, served with the fake engine (not in-image): the image exists once it was pulled. */
export function wizardFixture(language: "pt-BR" | "en"): Fixture {
  const fixture = createFixture();
  fs.rmSync(path.join(fixture.dir, "jgates.yml"));
  fs.rmSync(path.join(fixture.dir, ".jgates"), { recursive: true, force: true });
  const engine = fs.mkdtempSync(path.join(fixture.home, "engine-"));
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    [
      `const fs = require("node:fs");`,
      `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(path.join(engine, "calls.jsonl"))};`,
      `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};`,
      `const present = fs.existsSync(${JSON.stringify(path.join(engine, "pull-attempts"))});`,
      `process.env.FAKE_DOCKER_LABELS = present ? ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))} : "none";`,
      `require(${JSON.stringify(FAKE)});`,
      ``,
    ].join("\n"),
  );
  fixture.env.JGATES_IMAGE_JSON = "";
  fixture.env.JGATES_CONTAINER_RUNTIME = runtime;
  fixture.env.JGATES_TOOLS_IMAGE = PINNED;
  fixture.env.JGATES_NO_CACHE = "1";
  fs.writeFileSync(path.join(fixture.home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "system", language }, null, 2)}\n`, { mode: 0o600 });
  return fixture;
}

/** Opens every collapsed group of a long list (the tools catalogue, the templates, the review): their cards are inside. */
export async function openGroups(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll("main details:not(.capst-more)").forEach((d) => ((d as HTMLDetailsElement).open = true)));
}
