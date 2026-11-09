// The agent CLIs the semantic gate can drive (claude-code, codex-cli, opencode, gemini-cli): whether each one is
// installed (path, version), whether it is logged in, the models it offers, and how to open its own login.
//
// Rules:
//  - JGates never logs in and never reads a credential. The login state comes from the CLI's own status command
//    (`claude auth status`, `codex login status`, `opencode auth list`), run with a short timeout; gemini has no
//    status command, so only the presence of its credential file (or of a key variable) is checked, never the content.
//  - Only configuration files are read, for the model the user set in the CLI itself (~/.codex/config.toml `model`,
//    ~/.claude/settings.json `model`, opencode.json `model`, ~/.gemini/settings.json `model.name`).
//  - Every argument is a constant of this file: no user text ever reaches a command line or a shell. On Windows the
//    npm shims (.cmd) run through node with the shim's script, any other .cmd/.bat through `cmd.exe /d /s /c` with
//    quoted constant arguments.
//  - Every command is bounded in time; a CLI that hangs is killed (with its process tree on Windows) and reported as
//    "unknown" with the reason TIMEOUT.
// The login opens a new visible terminal running the CLI's own login command (Windows `start`, macOS Terminal,
// Linux x-terminal-emulator / gnome-terminal / konsole / xterm); when none is available the command is returned for
// the person to copy.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

export const CLI_PROVIDER_IDS = ["claude-code", "codex-cli", "opencode", "gemini-cli"] as const;
export type CliProviderId = (typeof CLI_PROVIDER_IDS)[number];
export type LoginState = "logged-in" | "not-logged-in" | "unknown";
/** Why a login state is what it is: the source of the answer, or why there is none. */
export type LoginReason =
  | "STATUS_COMMAND"
  | "CREDENTIAL_FILE"
  | "KEY_VARIABLE"
  | "NO_CREDENTIAL_FOUND"
  | "NOT_INSTALLED"
  | "TIMEOUT"
  | "COMMAND_FAILED"
  | "UNRECOGNIZED_OUTPUT";

export const STATUS_TIMEOUT_MS = 8_000;
export const MODELS_TIMEOUT_MS = 20_000;
const MODELS_CACHE_MS = 60_000;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_MODELS = 1000;
const SAFE_ARG = /^[A-Za-z0-9._:=-]+$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}$/;

interface CliSpec {
  id: CliProviderId;
  name: string;
  command: string;
  /** The CLI's own status command, or null when it has none (gemini). */
  statusArgs: readonly string[] | null;
  loginArgs: readonly string[];
  install: string;
  /** Model names the CLI accepts, offered when the CLI cannot list its own (aliases, not dated ids). */
  suggested: readonly string[];
  /** The CLI's own model listing, or null. */
  modelsArgs: readonly string[] | null;
}

const SPECS: Record<CliProviderId, CliSpec> = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    statusArgs: ["auth", "status"],
    loginArgs: ["auth", "login"],
    install: "npm install -g @anthropic-ai/claude-code",
    suggested: ["sonnet", "opus", "haiku"],
    modelsArgs: null,
  },
  "codex-cli": {
    id: "codex-cli",
    name: "Codex CLI",
    command: "codex",
    statusArgs: ["login", "status"],
    loginArgs: ["login"],
    install: "npm install -g @openai/codex",
    suggested: [],
    modelsArgs: ["debug", "models"],
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    statusArgs: ["auth", "list"],
    loginArgs: ["auth", "login"],
    install: "npm install -g opencode-ai",
    suggested: [],
    modelsArgs: ["models"],
  },
  "gemini-cli": {
    id: "gemini-cli",
    name: "Gemini CLI",
    command: "gemini",
    statusArgs: null,
    loginArgs: [],
    install: "npm install -g @google/gemini-cli",
    suggested: ["pro", "flash", "flash-lite", "auto"],
    modelsArgs: null,
  },
};

export function isCliProviderId(value: string): value is CliProviderId {
  return (CLI_PROVIDER_IDS as readonly string[]).includes(value);
}

export function cliSpec(id: CliProviderId): Readonly<CliSpec> {
  return SPECS[id];
}

// ---- the shape of the answer ----------------------------------------------------------------------------------------------

export interface CliLogin {
  state: LoginState;
  reason: LoginReason;
  /** How the CLI says it is logged in (e.g. "ChatGPT", "claude.ai"); never an account name nor a token. */
  method: string | null;
  /** The command or check the state came from, for the person to run it themselves. */
  checkedWith: string | null;
}

export interface CliModels {
  /** cli: listed by the CLI itself; suggested: aliases the CLI accepts; none: no list. */
  source: "cli" | "suggested" | "none";
  list: string[];
  truncated: boolean;
  /** The model set in the CLI's own configuration, when readable. */
  configured: string | null;
  /** The file `configured` came from. */
  configuredIn: string | null;
  /** The model to preselect: the configured one, else the first of the list (not for opencode), else null (the CLI's own default). */
  suggestedDefault: string | null;
  /** Why the CLI's listing failed, when it did (the suggestions and the configured model are still given). */
  problem: "TIMEOUT" | "COMMAND_FAILED" | "UNRECOGNIZED_OUTPUT" | null;
}

export interface CliCommandLine {
  command: string;
  args: string[];
  /** The line to type in a terminal. */
  display: string;
}

export interface CliProviderStatus {
  id: CliProviderId;
  name: string;
  command: string;
  installed: boolean;
  /** Absolute path of the executable found on PATH, or null. */
  path: string | null;
  version: string | null;
  login: CliLogin;
  /** null when the models were not asked for. */
  models: CliModels | null;
  loginCommand: CliCommandLine;
  install: string;
}

export interface CliStatusReport {
  checkedAt: string;
  timeoutMs: number;
  providers: CliProviderStatus[];
}

// ---- running a CLI --------------------------------------------------------------------------------------------------------

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** A spawn error (the executable could not start). */
  error: string | null;
}

export type CliRunner = (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number; platform: NodeJS.Platform }) => Promise<RunResult>;

const WINDOWS_RUNNABLE = [".exe", ".cmd", ".bat", ".com"];

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The absolute path of a command on PATH. On Windows only PATHEXT extensions a process can start are tried
 * (.exe/.cmd/.bat/.com, in PATHEXT order): the extensionless sh script and the .ps1 of an npm shim are skipped.
 */
export function resolveCliExecutable(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const pathValue = (platform === "win32" ? env.Path ?? env.PATH : env.PATH ?? env.Path) ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  const exts =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((e) => e.trim().toLowerCase())
          .filter((e) => WINDOWS_RUNNABLE.includes(e))
      : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir.trim()) continue;
    for (const ext of exts) {
      const candidate = path.join(dir.trim(), command + ext);
      if (!isFile(candidate)) continue;
      if (platform !== "win32") {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
        } catch {
          continue;
        }
      }
      return candidate;
    }
  }
  return null;
}

/** The script an npm .cmd shim runs with node (`"%dp0%\node_modules\...\cli.js"`), when it is one and the file exists. */
export function npmShimTarget(file: string): string | null {
  if (!/\.cmd$/i.test(file)) return null;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const match = /%~?dp0%?\\([^"\r\n]+?\.(?:c|m)?js)"/i.exec(text);
  if (!match?.[1]) return null;
  const target = path.join(path.dirname(file), match[1].replace(/\\/g, path.sep));
  return isFile(target) ? target : null;
}

/** How a resolved executable is started without a shell: the program, its arguments and whether they are verbatim. */
export function spawnPlan(file: string, args: readonly string[], platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { program: string; args: string[]; verbatim: boolean } {
  for (const arg of args) if (!SAFE_ARG.test(arg)) throw new Error(`refused argument: ${arg}`);
  if (platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    const target = npmShimTarget(file);
    if (target) return { program: process.execPath, args: [target, ...args], verbatim: false };
    // Not an npm shim: cmd.exe runs it. The path comes from PATH and the arguments are constants; a path with a
    // character cmd.exe would expand inside quotes is refused.
    if (/["%^!\r\n]/.test(file)) throw new Error("refused path");
    return { program: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `""${file}" ${args.join(" ")}"`], verbatim: true };
  }
  return { program: file, args: [...args], verbatim: false };
}

function killTree(pid: number | undefined, platform: NodeJS.Platform, child: { kill(signal?: NodeJS.Signals): boolean }): void {
  if (platform === "win32" && pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000, stdio: "ignore" });
      return;
    } catch {
      // fall through to a plain kill
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

/** The default runner: no shell, no stdin, hidden window, output capped, killed at the timeout. */
export const defaultRunner: CliRunner = (file, args, { env, timeoutMs, platform }) =>
  new Promise((resolve) => {
    let plan: ReturnType<typeof spawnPlan>;
    try {
      plan = spawnPlan(file, args, platform, env);
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: (error as Error).message });
      return;
    }
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(plan.program, plan.args, {
      env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      killTree(child.pid, platform, child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ code: null, stdout, stderr, timedOut: true, error: null });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    child.on("error", (error) => finish({ code: null, stdout, stderr, timedOut: false, error: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut: false, error: null }));
  });

// ---- parsing ----------------------------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const BOX = /[─-╿●○•◆◇❯]/g;

export function plainText(text: string): string {
  return text.replace(ANSI, "").replace(BOX, " ").replace(/\r/g, "");
}

/** The first version number of a `--version` output. */
export function parseVersion(text: string): string | null {
  const match = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)/.exec(plainText(text));
  return match?.[1] ?? null;
}

/** A short, harmless label of the login method (letters, digits, spaces, dots and dashes); anything else is dropped. */
function methodLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/[.!]+$/, "");
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(trimmed) && !trimmed.includes("@") ? trimmed : null;
}

type Parsed = { state: LoginState; reason: LoginReason; method: string | null };

function failed(r: RunResult): Parsed | null {
  if (r.timedOut) return { state: "unknown", reason: "TIMEOUT", method: null };
  if (r.error !== null) return { state: "unknown", reason: "COMMAND_FAILED", method: null };
  return null;
}

/** `claude auth status`: a JSON object with `loggedIn` (and `authMethod`); older versions print text. */
export function parseClaudeStatus(r: RunResult): Parsed {
  const early = failed(r);
  if (early) return early;
  const text = plainText(r.stdout);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const doc = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      if (typeof doc.loggedIn === "boolean") {
        return { state: doc.loggedIn ? "logged-in" : "not-logged-in", reason: "STATUS_COMMAND", method: doc.loggedIn ? methodLabel(doc.authMethod) : null };
      }
    } catch {
      // not JSON: read it as text below
    }
  }
  return textStatus(`${text}\n${plainText(r.stderr)}`, r.code);
}

/** `codex login status`: "Logged in using ChatGPT" / "Not logged in" (stdout or stderr). */
export function parseCodexStatus(r: RunResult): Parsed {
  const early = failed(r);
  if (early) return early;
  return textStatus(`${plainText(r.stdout)}\n${plainText(r.stderr)}`, r.code);
}

function textStatus(text: string, code: number | null): Parsed {
  if (/\bnot\s+(logged|signed)\s+in\b|\bnot\s+authenticated\b|\bno\s+credentials?\b/i.test(text)) return { state: "not-logged-in", reason: "STATUS_COMMAND", method: null };
  const using = /\blogged\s+in\s+(?:using|with|via)\s+([^\r\n]+)/i.exec(text);
  if (using) return { state: "logged-in", reason: "STATUS_COMMAND", method: methodLabel(using[1]) };
  if (/\b(logged|signed)\s+in\b|\bauthenticated\b/i.test(text)) return { state: "logged-in", reason: "STATUS_COMMAND", method: null };
  return { state: "unknown", reason: code === 0 ? "UNRECOGNIZED_OUTPUT" : "COMMAND_FAILED", method: null };
}

/** `opencode auth list`: one line per stored credential, then "N credentials"; "0 credentials" when none. */
export function parseOpencodeStatus(r: RunResult): Parsed {
  const early = failed(r);
  if (early) return early;
  const text = `${plainText(r.stdout)}\n${plainText(r.stderr)}`;
  const count = /\b(\d+)\s+credentials?\b/i.exec(text);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const entries = lines.filter((l) => /\b(oauth|api|stored|env|environment|wellknown|key)\s*$/i.test(l));
  if (entries.length > 0 || (count && Number(count[1]) > 0)) return { state: "logged-in", reason: "STATUS_COMMAND", method: null };
  if ((count && Number(count[1]) === 0) || /\bno\s+credentials?\b/i.test(text)) return { state: "not-logged-in", reason: "STATUS_COMMAND", method: null };
  return { state: "unknown", reason: r.code === 0 ? "UNRECOGNIZED_OUTPUT" : "COMMAND_FAILED", method: null };
}

/** `opencode models`: one provider/model id per line. */
export function parseOpencodeModels(stdout: string): string[] {
  return plainText(stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("/") && MODEL_ID.test(l));
}

/** `codex debug models`: JSON `{ models: [{ slug, visibility }] }`; hidden models are left out. */
export function parseCodexModels(stdout: string): string[] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return null;
  }
  const models = doc !== null && typeof doc === "object" ? (doc as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) return null;
  const out: string[] = [];
  for (const item of models) {
    if (item === null || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.visibility === "hide") continue;
    if (typeof rec.slug === "string" && MODEL_ID.test(rec.slug)) out.push(rec.slug);
  }
  return out;
}

/** The top-level `model = "..."` of a Codex config.toml (before the first [table]). */
export function codexConfigModel(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*model\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (match) {
      const value = (match[1] ?? match[2] ?? "").trim();
      return MODEL_ID.test(value) ? value : null;
    }
  }
  return null;
}

// ---- the configured model and the credential presence -----------------------------------------------------------------------

function homeOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const fromEnv = platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE;
  return fromEnv && fromEnv.trim() !== "" ? fromEnv : os.homedir();
}

function readSmall(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function jsonModel(file: string, pick: (doc: Record<string, unknown>) => unknown): { model: string; file: string } | null {
  const text = readSmall(file);
  if (text === null) return null;
  const doc = parseJsonc(text, [], { allowTrailingComma: true }) as unknown;
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const value = pick(doc as Record<string, unknown>);
  return typeof value === "string" && MODEL_ID.test(value.trim()) ? { model: value.trim(), file } : null;
}

/** The model set in the CLI's own configuration file (a configuration file only: never a credential file). */
export function configuredModel(id: CliProviderId, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { model: string; file: string } | null {
  const home = homeOf(env, platform);
  switch (id) {
    case "codex-cli": {
      const file = path.join(env.CODEX_HOME && env.CODEX_HOME.trim() !== "" ? env.CODEX_HOME : path.join(home, ".codex"), "config.toml");
      const text = readSmall(file);
      const model = text === null ? null : codexConfigModel(text);
      return model ? { model, file } : null;
    }
    case "claude-code": {
      const dir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() !== "" ? env.CLAUDE_CONFIG_DIR : path.join(home, ".claude");
      return jsonModel(path.join(dir, "settings.json"), (d) => d.model);
    }
    case "opencode": {
      const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== "" ? env.XDG_CONFIG_HOME : path.join(home, ".config");
      for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) {
        const found = jsonModel(path.join(base, "opencode", name), (d) => d.model);
        if (found) return found;
      }
      return null;
    }
    case "gemini-cli":
      return jsonModel(path.join(home, ".gemini", "settings.json"), (d) => {
        const model = d.model;
        if (typeof model === "string") return model;
        return model !== null && typeof model === "object" ? (model as Record<string, unknown>).name : undefined;
      });
  }
}

/** Gemini CLI has no status command: a key variable or its OAuth credential file present means logged in (the content is never read). */
export function geminiLogin(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Parsed & { checkedWith: string } {
  for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
    if ((env[name] ?? "").trim() !== "") return { state: "logged-in", reason: "KEY_VARIABLE", method: name, checkedWith: name };
  }
  const file = path.join(homeOf(env, platform), ".gemini", "oauth_creds.json");
  if (isFile(file)) return { state: "logged-in", reason: "CREDENTIAL_FILE", method: "Google", checkedWith: file };
  return { state: "unknown", reason: "NO_CREDENTIAL_FOUND", method: null, checkedWith: file };
}

// ---- the status ------------------------------------------------------------------------------------------------------------

export interface CliStatusOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runner?: CliRunner;
  /** Limit of each status and version command (default 8 s). */
  timeoutMs?: number;
  /** Limit of a model listing (default 20 s). */
  modelsTimeoutMs?: number;
  /** false: no model listing (faster; `models` is null). */
  models?: boolean;
  only?: readonly CliProviderId[];
  /** false: ignore the cache of model listings. */
  cache?: boolean;
}

const modelsCache = new Map<string, { at: number; list: string[] | null; problem: CliModels["problem"] }>();

export function clearCliStatusCache(): void {
  modelsCache.clear();
}

export function commandLineOf(spec: CliSpec): CliCommandLine {
  return { command: spec.command, args: [...spec.loginArgs], display: [spec.command, ...spec.loginArgs].join(" ") };
}

async function listedModels(spec: CliSpec, file: string, run: CliRunner, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, timeoutMs: number, useCache: boolean): Promise<{ list: string[] | null; problem: CliModels["problem"] }> {
  if (!spec.modelsArgs) return { list: null, problem: null };
  const key = `${spec.id}|${file}`;
  const cached = modelsCache.get(key);
  if (useCache && cached && Date.now() - cached.at < MODELS_CACHE_MS) return { list: cached.list, problem: cached.problem };
  const r = await run(file, spec.modelsArgs, { env, timeoutMs, platform });
  let list: string[] | null = null;
  let problem: CliModels["problem"] = null;
  if (r.timedOut) problem = "TIMEOUT";
  else if (r.error !== null || r.code !== 0) problem = "COMMAND_FAILED";
  else {
    list = spec.id === "codex-cli" ? parseCodexModels(r.stdout) : parseOpencodeModels(r.stdout);
    if (list === null || list.length === 0) {
      problem = "UNRECOGNIZED_OUTPUT";
      list = null;
    }
  }
  // A failure is not cached: the next check tries again.
  if (problem === null) modelsCache.set(key, { at: Date.now(), list, problem });
  return { list, problem };
}

async function statusOf(spec: CliSpec, options: Required<Pick<CliStatusOptions, "timeoutMs" | "modelsTimeoutMs" | "models" | "cache">> & { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; runner: CliRunner }): Promise<CliProviderStatus> {
  const { env, platform, runner } = options;
  const file = resolveCliExecutable(spec.command, env, platform);
  const base = { id: spec.id, name: spec.name, command: spec.command, loginCommand: commandLineOf(spec), install: spec.install };
  if (!file) {
    return { ...base, installed: false, path: null, version: null, login: { state: "unknown", reason: "NOT_INSTALLED", method: null, checkedWith: null }, models: null };
  }
  const versionRun = runner(file, ["--version"], { env, timeoutMs: options.timeoutMs, platform });
  const statusRun = spec.statusArgs ? runner(file, spec.statusArgs, { env, timeoutMs: options.timeoutMs, platform }) : null;
  const modelsRun = options.models ? listedModels(spec, file, runner, env, platform, options.modelsTimeoutMs, options.cache) : null;
  const [versionResult, statusResult, modelsResult] = await Promise.all([versionRun, statusRun, modelsRun]);

  let login: CliLogin;
  if (spec.id === "gemini-cli") {
    const g = geminiLogin(env, platform);
    login = { state: g.state, reason: g.reason, method: g.method, checkedWith: g.checkedWith };
  } else {
    const parsed = spec.id === "claude-code" ? parseClaudeStatus(statusResult as RunResult) : spec.id === "codex-cli" ? parseCodexStatus(statusResult as RunResult) : parseOpencodeStatus(statusResult as RunResult);
    login = { ...parsed, checkedWith: [spec.command, ...(spec.statusArgs ?? [])].join(" ") };
  }

  let models: CliModels | null = null;
  if (options.models) {
    const configured = configuredModel(spec.id, env, platform);
    const fromCli = modelsResult?.list ?? null;
    const offered = fromCli ?? [...spec.suggested];
    const merged = [...new Set([...(configured ? [configured.model] : []), ...offered])];
    models = {
      source: fromCli ? "cli" : spec.suggested.length > 0 ? "suggested" : "none",
      list: merged.slice(0, MAX_MODELS),
      truncated: merged.length > MAX_MODELS,
      configured: configured?.model ?? null,
      configuredIn: configured?.file ?? null,
      // opencode lists every model of every provider it knows: no first one is a sensible default, its own default applies.
      suggestedDefault: configured?.model ?? (spec.id === "opencode" ? null : merged[0] ?? null),
      problem: modelsResult?.problem ?? null,
    };
  }
  const version = versionResult.timedOut || versionResult.error !== null ? null : parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  return { ...base, installed: true, path: file, version, login, models };
}

/** The state of every agent CLI (or of `only`), checked in parallel, each command bounded in time. */
export async function cliProvidersStatus(options: CliStatusOptions = {}): Promise<CliStatusReport> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? STATUS_TIMEOUT_MS;
  const ids = options.only && options.only.length > 0 ? CLI_PROVIDER_IDS.filter((id) => options.only?.includes(id)) : [...CLI_PROVIDER_IDS];
  const providers = await Promise.all(
    ids.map((id) =>
      statusOf(SPECS[id], {
        env,
        platform,
        runner: options.runner ?? defaultRunner,
        timeoutMs,
        modelsTimeoutMs: options.modelsTimeoutMs ?? MODELS_TIMEOUT_MS,
        models: options.models !== false,
        cache: options.cache !== false,
      }),
    ),
  );
  return { checkedAt: new Date().toISOString(), timeoutMs, providers };
}

// ---- the login terminal ------------------------------------------------------------------------------------------------------

export type TerminalSpawner = (program: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; verbatim: boolean }) => Promise<void>;

/** Starts a detached, visible process and resolves once it started (rejects when it could not). */
export const defaultTerminalSpawner: TerminalSpawner = (program, args, { env, verbatim }) =>
  new Promise((resolve, reject) => {
    const child = spawn(program, [...args], { env, detached: true, stdio: "ignore", shell: false, windowsHide: false, windowsVerbatimArguments: verbatim });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

let terminalSpawnerOverride: TerminalSpawner | null = null;

/** Replaces the spawner of login terminals (tests); null restores the real one. */
export function setTerminalSpawner(spawner: TerminalSpawner | null): void {
  terminalSpawnerOverride = spawner;
}

export interface LoginTerminalResult {
  provider: CliProviderId;
  /** true when a terminal was started with the login command. */
  opened: boolean;
  /** windows-start, macos-terminal, or the Linux terminal used; null when none could be opened. */
  method: string | null;
  /** The login command, to show and to copy when no terminal could be opened. */
  command: CliCommandLine;
  /** Why no terminal was opened: NO_TERMINAL (Linux without a known terminal), SPAWN_FAILED. */
  reason: "NO_TERMINAL" | "SPAWN_FAILED" | null;
}

const LINUX_TERMINALS: ReadonlyArray<{ program: string; before: readonly string[] }> = [
  { program: "x-terminal-emulator", before: ["-e"] },
  { program: "gnome-terminal", before: ["--"] },
  { program: "konsole", before: ["-e"] },
  { program: "xfce4-terminal", before: ["-x"] },
  { program: "xterm", before: ["-e"] },
];

/** How a terminal running `command` is opened on the platform, or null when no terminal is known. */
export function terminalPlan(spec: CliSpec, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): { program: string; args: string[]; verbatim: boolean; method: string } | null {
  const line = commandLineOf(spec);
  for (const arg of [line.command, ...line.args]) if (!SAFE_ARG.test(arg)) throw new Error(`refused argument: ${arg}`);
  const title = `JGates - ${spec.name} login`;
  if (platform === "win32") {
    // cmd /c start "<title>" cmd /k <cli> <args>: a new console window that stays open after the login. Every word is
    // a constant of this file.
    return { program: env.ComSpec ?? "cmd.exe", args: ["/d", "/c", "start", `"${title}"`, "cmd.exe", "/k", line.display], verbatim: true, method: "windows-start" };
  }
  if (platform === "darwin") {
    return {
      program: "osascript",
      args: ["-e", `tell application "Terminal" to do script "${line.display}"`, "-e", 'tell application "Terminal" to activate'],
      verbatim: false,
      method: "macos-terminal",
    };
  }
  for (const terminal of LINUX_TERMINALS) {
    if (resolveCliExecutable(terminal.program, env, platform)) return { program: terminal.program, args: [...terminal.before, line.command, ...line.args], verbatim: false, method: terminal.program };
  }
  return null;
}

/** Opens a new visible terminal running the CLI's own login command; JGates itself never logs in. */
export async function openLoginTerminal(id: CliProviderId, options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; spawner?: TerminalSpawner } = {}): Promise<LoginTerminalResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const spec = SPECS[id];
  const command = commandLineOf(spec);
  const plan = terminalPlan(spec, platform, env);
  if (!plan) return { provider: id, opened: false, method: null, command, reason: "NO_TERMINAL" };
  const spawner = options.spawner ?? terminalSpawnerOverride ?? defaultTerminalSpawner;
  try {
    await spawner(plan.program, plan.args, { env, verbatim: plan.verbatim });
    return { provider: id, opened: true, method: plan.method, command, reason: null };
  } catch {
    return { provider: id, opened: false, method: plan.method, command, reason: "SPAWN_FAILED" };
  }
}
