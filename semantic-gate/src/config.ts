import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SemanticGateError } from "./errors.js";
import { parseScalar } from "./args.js";
import type { CliOptions, PromptOverride, PromptSettings, SemanticGateConfig } from "./types.js";

export const PROJECT_CONFIG = ".semantic-gate.json";

export const defaultConfig: SemanticGateConfig = {
  scope: "changed",
  threshold: 90,
  output: "json",
  paths: [],
  excludes: [],
  includes: [],
  ignoreFiles: [],
  includeUntracked: true,
  maxContextChars: 160_000,
  maxFileChars: 50_000,
  maxDiffChars: 60_000,
  contextStrategy: "auto",
  outputDir: ".quality/semantic-gate",
  writeReports: true,
  timeoutMs: 300_000,
  codexSandbox: "read-only",
  codexBypassSandbox: false,
  codexSkipGitRepoCheck: true,
  commandPromptMode: "stdin",
  commandOutput: "text",
};

export function globalConfigDir(): string {
  if (process.env.SEMANTIC_GATE_HOME) {
    return process.env.SEMANTIC_GATE_HOME;
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "semantic-gate");
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "semantic-gate");
}

export function globalConfigPath(): string {
  return path.join(globalConfigDir(), "config.json");
}

export function globalSecretsPath(): string {
  return path.join(globalConfigDir(), "secrets.json");
}

export function findProjectConfig(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, PROJECT_CONFIG);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function loadEffectiveConfig(cwd: string, cliOptions: CliOptions): SemanticGateConfig {
  const rawGlobal = readJsonIfExists(globalConfigPath());
  // The user's provider preferences live in the same file (see readUserPreferences); they are not config keys.
  const { [PREFERENCE_PROVIDERS_KEY]: _providers, [PREFERENCE_CONNECTIONS_KEY]: _connections, ...globalFlat } = rawGlobal;
  const globalConfig = withPromptPaths(globalFlat, globalConfigDir());
  const projectPath = findProjectConfig(cwd);
  const projectConfig = projectPath ? withPromptPaths(readJsonIfExists(projectPath), path.dirname(projectPath)) : {};
  const envConfig = configFromEnv(process.env);
  const flagConfig = normalizeFlagConfig(cliOptions);

  const merged: Record<string, unknown> = {
    ...defaultConfig,
    ...globalConfig,
    ...projectConfig,
    ...envConfig,
    ...flagConfig,
  };
  applyUserPreferences(merged, { ...projectConfig, ...envConfig, ...flagConfig }, readUserPreferences(rawGlobal).preferences);
  return normalizeConfig(merged, cliOptions);
}

// ---- the user's provider preferences ------------------------------------------------------------------------------------
//
// Kept in the global config.json (next to the key store, outside every project), apart from the config keys:
//
//   "providers":   { "<provider id>": { "baseUrl"?, "model"?, "apiKeyEnv"?, "allowInsecureHttp"? } }
//   "connections": { "<name>": { "type": "openai-compatible", "baseUrl", "apiKeyEnv"?, "model"?, "headers"?, "allowInsecureHttp"? } }
//
// JGates reads and writes the same keys (jgates/src/core/providers); a cross-read test keeps both in step. The value of
// a field comes from the project (project file, environment, flags), then from the preference, then from the provider's
// default. A connection is used with `provider: <name>`; its key is the variable named by apiKeyEnv (default
// <NAME>_API_KEY), read from the environment or the key store.

export const PREFERENCE_PROVIDERS_KEY = "providers";
export const PREFERENCE_CONNECTIONS_KEY = "connections";
export const CONNECTION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const CONNECTION_TYPES = ["openai-compatible"] as const;
export type PreferenceField = "baseUrl" | "model" | "apiKeyEnv";

/** A provider of the package: its id, the other names it answers to, its defaults and the fields a preference may set. */
export interface ProviderDefaults {
  id: string;
  aliases: readonly string[];
  kind: "http" | "cli";
  baseUrl: string | null;
  apiKeyEnv: string | null;
  fields: readonly PreferenceField[];
}

export const PROVIDER_DEFAULTS: readonly ProviderDefaults[] = [
  { id: "anthropic", aliases: ["claude", "claude-api"], kind: "http", baseUrl: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY", fields: ["baseUrl", "model", "apiKeyEnv"] },
  { id: "gemini", aliases: ["gemini-api"], kind: "http", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKeyEnv: "GEMINI_API_KEY", fields: ["baseUrl", "model", "apiKeyEnv"] },
  { id: "ollama", aliases: [], kind: "http", baseUrl: "http://127.0.0.1:11434", apiKeyEnv: null, fields: ["baseUrl", "model"] },
  { id: "openai", aliases: [], kind: "http", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", fields: ["baseUrl", "model", "apiKeyEnv"] },
  { id: "openai-compatible", aliases: [], kind: "http", baseUrl: null, apiKeyEnv: "SEMANTIC_GATE_API_KEY", fields: ["baseUrl", "model", "apiKeyEnv"] },
  { id: "opencode-api", aliases: [], kind: "http", baseUrl: "https://opencode.ai/inference/openai/v1", apiKeyEnv: "OPENCODE_API_KEY", fields: ["baseUrl", "model", "apiKeyEnv"] },
  { id: "openrouter", aliases: [], kind: "http", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", fields: ["baseUrl", "model", "apiKeyEnv"] },
  { id: "claude-code", aliases: [], kind: "cli", baseUrl: null, apiKeyEnv: null, fields: ["model"] },
  { id: "codex-cli", aliases: [], kind: "cli", baseUrl: null, apiKeyEnv: null, fields: ["model"] },
  { id: "gemini-cli", aliases: [], kind: "cli", baseUrl: null, apiKeyEnv: null, fields: ["model"] },
  { id: "opencode", aliases: [], kind: "cli", baseUrl: null, apiKeyEnv: null, fields: ["model"] },
];

/** Every name the package already gives a meaning to: a connection never takes one of them. */
export const RESERVED_PROVIDER_NAMES: readonly string[] = [
  ...PROVIDER_DEFAULTS.flatMap((p) => [p.id, ...p.aliases]),
  "command",
  "mock",
].sort();

export interface ProviderPreference {
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  allowInsecureHttp?: boolean;
}

export interface ConnectionPreference extends ProviderPreference {
  type: "openai-compatible";
  baseUrl: string;
  headers: Record<string, string>;
}

export interface UserPreferences {
  providers: Record<string, ProviderPreference>;
  connections: Record<string, ConnectionPreference>;
}

/** The provider of a name (an id or an alias), or undefined for a name the package does not know. */
export function providerDefaults(name: string | undefined): ProviderDefaults | undefined {
  if (!name) {
    return undefined;
  }
  const normalized = name.trim().toLowerCase();
  return PROVIDER_DEFAULTS.find((p) => p.id === normalized || p.aliases.includes(normalized));
}

/** true for localhost, *.localhost, 127.0.0.0/8 and ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "::1";
}

/**
 * Why a base URL is refused, or undefined when it is accepted: http or https only, no user or password in it, no query
 * or fragment, and plain http only for loopback unless the user confirmed it (the key would travel in clear text).
 */
export function baseUrlProblem(value: unknown, allowInsecureHttp: boolean): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return "INVALID_URL";
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "INVALID_URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "URL_SCHEME";
  }
  if (url.username || url.password) {
    return "URL_CREDENTIALS";
  }
  if (url.search || url.hash) {
    return "URL_QUERY";
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname) && !allowInsecureHttp) {
    return "INSECURE_HTTP";
  }
  return undefined;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const RESERVED_HEADERS = new Set(["connection", "content-length", "content-type", "host", "transfer-encoding"]);

/** A header name that carries a credential: authorization, cookies, and the *-key, *-token, *-secret families. */
export function isCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "authorization" ||
    lower === "proxy-authorization" ||
    lower === "cookie" ||
    /(^|[-_.])(key|token|secret|password|passwd|credential|credentials|auth|session)$/.test(lower) ||
    /api[-_]?key|secret|password|token|credential/.test(lower)
  );
}

/** Why an extra header is refused, or undefined when it is accepted. */
export function headerProblem(name: string, value: unknown): string | undefined {
  if (!HEADER_NAME.test(name)) {
    return "INVALID_HEADER_NAME";
  }
  if (isCredentialHeader(name)) {
    return "CREDENTIAL_HEADER";
  }
  if (RESERVED_HEADERS.has(name.toLowerCase())) {
    return "RESERVED_HEADER";
  }
  if (typeof value !== "string" || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
    return "INVALID_HEADER_VALUE";
  }
  if (/^(bearer|basic|token)\s/i.test(value.trim())) {
    return "CREDENTIAL_HEADER";
  }
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const KEY_NAME = /^[A-Z_][A-Z0-9_]*$/;
const validModel = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);

/**
 * The preferences of the global config.json. Reading never fails on a bad entry: the entry is left out and named in
 * `problems` (a field that a hand edit broke never reaches a provider).
 */
export function readUserPreferences(raw: Record<string, unknown>): { preferences: UserPreferences; problems: string[] } {
  const preferences: UserPreferences = { providers: {}, connections: {} };
  const problems: string[] = [];
  const fieldsOf = (entry: Record<string, unknown>, where: string, allowed: readonly PreferenceField[]): ProviderPreference | undefined => {
    const out: ProviderPreference = {};
    const allowHttp = entry.allowInsecureHttp === true;
    if (allowHttp) {
      out.allowInsecureHttp = true;
    }
    if (entry.baseUrl !== undefined) {
      const problem = allowed.includes("baseUrl") ? baseUrlProblem(entry.baseUrl, allowHttp) : "FIELD_NOT_SUPPORTED";
      if (problem) {
        problems.push(`${where}.baseUrl: ${problem}`);
        return undefined;
      }
      out.baseUrl = String(entry.baseUrl).trim();
    }
    if (entry.model !== undefined) {
      if (!validModel(entry.model)) {
        problems.push(`${where}.model: INVALID_MODEL`);
        return undefined;
      }
      out.model = entry.model.trim();
    }
    if (entry.apiKeyEnv !== undefined) {
      if (!allowed.includes("apiKeyEnv") || typeof entry.apiKeyEnv !== "string" || !KEY_NAME.test(entry.apiKeyEnv)) {
        problems.push(`${where}.apiKeyEnv: ${allowed.includes("apiKeyEnv") ? "INVALID_KEY_NAME" : "FIELD_NOT_SUPPORTED"}`);
        return undefined;
      }
      out.apiKeyEnv = entry.apiKeyEnv;
    }
    return out;
  };
  const providers = raw[PREFERENCE_PROVIDERS_KEY];
  if (isRecord(providers)) {
    for (const [name, entry] of Object.entries(providers)) {
      const known = providerDefaults(name);
      if (!known || known.id !== name || !isRecord(entry)) {
        problems.push(`${PREFERENCE_PROVIDERS_KEY}.${name}: UNKNOWN_PROVIDER`);
        continue;
      }
      const prefs = fieldsOf(entry, `${PREFERENCE_PROVIDERS_KEY}.${name}`, known.fields);
      if (prefs) {
        preferences.providers[name] = prefs;
      }
    }
  }
  const connections = raw[PREFERENCE_CONNECTIONS_KEY];
  if (isRecord(connections)) {
    for (const [name, entry] of Object.entries(connections)) {
      const where = `${PREFERENCE_CONNECTIONS_KEY}.${name}`;
      if (!CONNECTION_NAME_PATTERN.test(name) || RESERVED_PROVIDER_NAMES.includes(name) || !isRecord(entry)) {
        problems.push(`${where}: INVALID_NAME`);
        continue;
      }
      if ((entry.type ?? "openai-compatible") !== "openai-compatible") {
        problems.push(`${where}.type: INVALID_TYPE`);
        continue;
      }
      if (entry.baseUrl === undefined) {
        problems.push(`${where}.baseUrl: MISSING_BASE_URL`);
        continue;
      }
      const prefs = fieldsOf(entry, where, ["baseUrl", "model", "apiKeyEnv"]);
      if (!prefs) {
        continue;
      }
      const headers: Record<string, string> = {};
      let bad = false;
      if (entry.headers !== undefined) {
        if (!isRecord(entry.headers)) {
          problems.push(`${where}.headers: INVALID_HEADER_NAME`);
          continue;
        }
        for (const [header, value] of Object.entries(entry.headers)) {
          const problem = headerProblem(header, value);
          if (problem) {
            problems.push(`${where}.headers.${header}: ${problem}`);
            bad = true;
            break;
          }
          headers[header] = String(value);
        }
      }
      if (!bad) {
        preferences.connections[name] = { ...prefs, type: "openai-compatible", baseUrl: prefs.baseUrl as string, headers };
      }
    }
  }
  return { preferences, problems };
}

/** The preferences of the user's global config.json (the file of globalConfigPath()). */
export function loadUserPreferences(): { preferences: UserPreferences; problems: string[] } {
  return readUserPreferences(readJsonIfExists(globalConfigPath()));
}

/**
 * Fills, in `merged`, the fields of the provider in effect that the project tier (`overriding`: project file,
 * environment, flags) did not set, from the user's preference for that provider (or the connection of that name).
 * The provider's own default stays for providers.ts to apply.
 */
function applyUserPreferences(merged: Record<string, unknown>, overriding: Record<string, unknown>, preferences: UserPreferences): void {
  const provider = typeof merged.provider === "string" ? merged.provider.trim() : "";
  if (!provider) {
    return;
  }
  const known = providerDefaults(provider);
  const connection = known ? undefined : preferences.connections[provider];
  const prefs: ProviderPreference | undefined = known ? preferences.providers[known.id] : connection;
  if (!prefs) {
    return;
  }
  const set = (value: unknown): boolean => value !== undefined && value !== null && value !== "";
  for (const field of ["baseUrl", "model", "apiKeyEnv"] as const) {
    if (!set(overriding[field]) && prefs[field] !== undefined) {
      merged[field] = prefs[field];
    }
  }
  if (prefs.allowInsecureHttp && !set(overriding.baseUrl)) {
    merged.allowInsecureHttp = true;
  }
  if (connection) {
    merged.connection = provider;
    merged.headers = { ...connection.headers };
  }
}

export function readJsonIfExists(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const text = fs.readFileSync(filePath, "utf8");
  if (!text.trim()) {
    return {};
  }
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SemanticGateError(`Config file is not a JSON object: ${filePath}`, "usage");
  }
  return parsed as Record<string, unknown>;
}

export function configFromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  setIfPresent(config, "provider", env.SEMANTIC_GATE_PROVIDER);
  setIfPresent(config, "model", env.SEMANTIC_GATE_MODEL);
  setIfPresent(config, "scope", env.SEMANTIC_GATE_SCOPE);
  setIfPresent(config, "paths", env.SEMANTIC_GATE_PATHS);
  setIfPresent(config, "excludes", env.SEMANTIC_GATE_EXCLUDES);
  setIfPresent(config, "includes", env.SEMANTIC_GATE_INCLUDES);
  setIfPresent(config, "ignoreFiles", env.SEMANTIC_GATE_IGNORE_FILES);
  setIfPresent(config, "threshold", env.SEMANTIC_GATE_THRESHOLD);
  setIfPresent(config, "output", env.SEMANTIC_GATE_OUTPUT);
  setIfPresent(config, "base", env.SEMANTIC_GATE_BASE);
  setIfPresent(config, "head", env.SEMANTIC_GATE_HEAD);
  setIfPresent(config, "maxContextChars", env.SEMANTIC_GATE_MAX_CONTEXT_CHARS);
  setIfPresent(config, "maxFileChars", env.SEMANTIC_GATE_MAX_FILE_CHARS);
  setIfPresent(config, "maxDiffChars", env.SEMANTIC_GATE_MAX_DIFF_CHARS);
  setIfPresent(config, "contextStrategy", env.SEMANTIC_GATE_CONTEXT_STRATEGY);
  setIfPresent(config, "outputDir", env.SEMANTIC_GATE_OUTPUT_DIR);
  setIfPresent(config, "writeReports", env.SEMANTIC_GATE_WRITE_REPORTS);
  setIfPresent(config, "timeoutMs", env.SEMANTIC_GATE_TIMEOUT_MS);
  setIfPresent(config, "temperature", env.SEMANTIC_GATE_TEMPERATURE);
  setIfPresent(config, "baseUrl", env.SEMANTIC_GATE_BASE_URL);
  setIfPresent(config, "apiKeyEnv", env.SEMANTIC_GATE_API_KEY_ENV);
  setIfPresent(config, "apiKeyProvider", env.SEMANTIC_GATE_API_KEY_PROVIDER);
  setIfPresent(config, "reasoningEffort", env.SEMANTIC_GATE_REASONING_EFFORT);
  setIfPresent(config, "codexSandbox", env.SEMANTIC_GATE_CODEX_SANDBOX);
  setIfPresent(config, "codexBypassSandbox", env.SEMANTIC_GATE_CODEX_BYPASS_SANDBOX);
  setIfPresent(config, "codexSkipGitRepoCheck", env.SEMANTIC_GATE_CODEX_SKIP_GIT_REPO_CHECK);
  setIfPresent(config, "command", env.SEMANTIC_GATE_COMMAND);
  setIfPresent(config, "commandArgs", env.SEMANTIC_GATE_COMMAND_ARGS);
  setIfPresent(config, "modelListCommand", env.SEMANTIC_GATE_MODEL_LIST_COMMAND);
  setIfPresent(config, "modelListArgs", env.SEMANTIC_GATE_MODEL_LIST_ARGS);
  setIfPresent(config, "commandPromptMode", env.SEMANTIC_GATE_COMMAND_PROMPT_MODE);
  return config;
}

export function writeConfigValue(
  cwd: string,
  scope: "global" | "project",
  key: string,
  value: unknown,
): string {
  const filePath = scope === "global" ? globalConfigPath() : path.join(cwd, PROJECT_CONFIG);
  const config = readJsonIfExists(filePath);
  config[key] = value;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

export function unsetConfigValue(cwd: string, scope: "global" | "project", key: string): string {
  const filePath = scope === "global" ? globalConfigPath() : path.join(cwd, PROJECT_CONFIG);
  const config = readJsonIfExists(filePath);
  delete config[key];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

export function initProjectConfig(cwd: string): string {
  const filePath = path.join(cwd, PROJECT_CONFIG);
  if (fs.existsSync(filePath)) {
    return filePath;
  }
  const config = {
    threshold: 90,
    includeUntracked: true,
    maxContextChars: 160_000,
    contextStrategy: "auto",
    outputDir: ".quality/semantic-gate",
  };
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

export function configTargetScope(options: CliOptions): "global" | "project" {
  if (options.project) {
    return "project";
  }
  return "global";
}

/**
 * Resolves the `prompts.*.file` paths of one config file against the folder of that file, so a project file stays
 * the project's whatever the current directory is. Malformed blocks are left for normalizeConfig to reject.
 */
function withPromptPaths(config: Record<string, unknown>, baseDir: string): Record<string, unknown> {
  const prompts = config.prompts;
  if (!prompts || typeof prompts !== "object" || Array.isArray(prompts)) {
    return config;
  }
  const resolved: Record<string, unknown> = { ...(prompts as Record<string, unknown>) };
  for (const kind of ["system", "review"]) {
    const entry = resolved[kind];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const file = (entry as Record<string, unknown>).file;
      if (typeof file === "string" && file.trim() !== "") {
        resolved[kind] = { ...(entry as Record<string, unknown>), file: path.resolve(baseDir, file) };
      }
    }
  }
  return { ...config, prompts: resolved };
}

/** Validates the `prompts` block: only system and review, each with mode replace|append and a file. */
function promptSettingsValue(value: unknown): PromptSettings | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new SemanticGateError("prompts must be an object with system and/or review.", "usage");
  }
  const settings: PromptSettings = {};
  for (const [kind, entry] of Object.entries(value as Record<string, unknown>)) {
    if (kind !== "system" && kind !== "review") {
      throw new SemanticGateError(`prompts.${kind} is not a known prompt; use system or review.`, "usage");
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SemanticGateError(`prompts.${kind} must be an object with mode and file.`, "usage");
    }
    const { mode, file } = entry as Record<string, unknown>;
    if (mode !== "replace" && mode !== "append") {
      throw new SemanticGateError(`prompts.${kind}.mode must be replace or append.`, "usage");
    }
    if (typeof file !== "string" || file.trim() === "") {
      throw new SemanticGateError(`prompts.${kind}.file must be a path.`, "usage");
    }
    const override: PromptOverride = { mode, file: path.resolve(file) };
    settings[kind] = override;
  }
  return settings;
}

function normalizeFlagConfig(options: CliOptions): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (
      key === "objectiveFile" ||
      key === "objectiveStdin" ||
      key === "json" ||
      key === "ci" ||
      key === "project" ||
      key === "global" ||
      value === undefined
    ) {
      continue;
    }
    config[key] = value;
  }
  if (options.json || options.ci) {
    config.output = "json";
  }
  return config;
}

function normalizeConfig(input: Record<string, unknown>, cliOptions: CliOptions = {}): SemanticGateConfig {
  const output = { ...defaultConfig, ...input } as SemanticGateConfig;
  output.threshold = numberValue(input.threshold, defaultConfig.threshold, "threshold");
  output.maxContextChars = numberValue(input.maxContextChars, defaultConfig.maxContextChars, "maxContextChars");
  output.maxFileChars = numberValue(input.maxFileChars, defaultConfig.maxFileChars, "maxFileChars");
  output.maxDiffChars = numberValue(input.maxDiffChars, defaultConfig.maxDiffChars, "maxDiffChars");
  output.timeoutMs = numberValue(input.timeoutMs, defaultConfig.timeoutMs, "timeoutMs");
  // Sampling temperature is sent only when the user sets it: current reasoning models (OpenAI GPT-5 and later,
  // Claude 4.7 and later) reject any value but their default, and the Anthropic API version in use removed it.
  if (input.temperature === undefined || input.temperature === null || input.temperature === "") {
    delete output.temperature;
  } else {
    output.temperature = numberValue(input.temperature, 0, "temperature");
  }
  output.includeUntracked = booleanValue(input.includeUntracked, defaultConfig.includeUntracked);
  output.writeReports = booleanValue(input.writeReports, defaultConfig.writeReports);
  output.codexBypassSandbox = booleanValue(input.codexBypassSandbox, defaultConfig.codexBypassSandbox);
  output.codexSkipGitRepoCheck = booleanValue(input.codexSkipGitRepoCheck, defaultConfig.codexSkipGitRepoCheck);
  output.paths = stringArrayValue(input.paths, defaultConfig.paths);
  output.excludes = stringArrayValue(input.excludes, defaultConfig.excludes);
  output.includes = stringArrayValue(input.includes, defaultConfig.includes);
  output.ignoreFiles = stringArrayValue(input.ignoreFiles, defaultConfig.ignoreFiles);
  if (input.allowInsecureHttp === undefined) {
    delete output.allowInsecureHttp;
  } else {
    output.allowInsecureHttp = booleanValue(input.allowInsecureHttp, false);
  }
  if (input.headers === undefined || input.headers === null) {
    delete output.headers;
  } else if (!isRecord(input.headers) || Object.values(input.headers).some((v) => typeof v !== "string")) {
    throw new SemanticGateError("headers must be an object of header names to text values.", "usage");
  }
  if (input.connection === undefined || input.connection === null || input.connection === "") {
    delete output.connection;
  } else {
    output.connection = String(input.connection);
  }
  const prompts = promptSettingsValue(input.prompts);
  if (prompts) {
    output.prompts = prompts;
  } else {
    delete output.prompts;
  }

  if (!["changed", "full", "paths"].includes(output.scope)) {
    throw new SemanticGateError("scope must be changed, full, or paths.", "usage");
  }
  const cliPaths = Array.isArray(cliOptions.paths) ? cliOptions.paths : [];
  if (output.scope !== "paths" && cliPaths.length > 0) {
    throw new SemanticGateError("--path can only be used with scope=paths.", "usage");
  }
  if (output.scope !== "paths") {
    output.paths = [];
  }
  if (output.scope === "paths" && output.paths.length === 0) {
    throw new SemanticGateError("scope=paths requires at least one --path.", "usage");
  }
  if (input.commandArgs !== undefined) {
    if (Array.isArray(input.commandArgs)) {
      output.commandArgs = input.commandArgs.map(String);
    } else if (typeof input.commandArgs === "string" && input.commandArgs.trim()) {
      const parsed = parseScalar(input.commandArgs);
      output.commandArgs = Array.isArray(parsed) ? parsed.map(String) : input.commandArgs.split(/\s+/);
    }
  }
  if (input.modelListArgs !== undefined) {
    if (Array.isArray(input.modelListArgs)) {
      output.modelListArgs = input.modelListArgs.map(String);
    } else if (typeof input.modelListArgs === "string" && input.modelListArgs.trim()) {
      const parsed = parseScalar(input.modelListArgs);
      output.modelListArgs = Array.isArray(parsed) ? parsed.map(String) : input.modelListArgs.split(/\s+/);
    }
  }

  if (output.output !== "json" && output.output !== "markdown") {
    throw new SemanticGateError("output must be json or markdown.", "usage");
  }
  if (!["single", "chunked", "auto"].includes(output.contextStrategy)) {
    throw new SemanticGateError("contextStrategy must be single, chunked, or auto.", "usage");
  }
  if (!["stdin", "argument"].includes(output.commandPromptMode)) {
    throw new SemanticGateError("commandPromptMode must be stdin or argument.", "usage");
  }
  if (!["text", "json"].includes(output.commandOutput)) {
    throw new SemanticGateError("commandOutput must be text or json.", "usage");
  }
  if (input.codexSandbox === null || input.codexSandbox === false || input.codexSandbox === "") {
    output.codexSandbox = undefined;
  } else if (input.codexSandbox !== undefined) {
    output.codexSandbox = String(input.codexSandbox) as SemanticGateConfig["codexSandbox"];
  }
  if (
    output.codexSandbox &&
    !["read-only", "workspace-write", "danger-full-access"].includes(output.codexSandbox)
  ) {
    throw new SemanticGateError("codexSandbox must be read-only, workspace-write, or danger-full-access.", "usage");
  }
  return output;
}

function setIfPresent(config: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value !== undefined && value !== "") {
    config[key] = parseScalar(value);
  }
}

function numberValue(value: unknown, fallback: number, key: string): number {
  if (value === undefined) {
    return fallback;
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new SemanticGateError(`${key} must be a number.`, "usage");
  }
  return number;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return String(value).toLowerCase() === "true";
}

function stringArrayValue(value: unknown, fallback: string[]): string[] {
  if (value === undefined) {
    return fallback;
  }
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  if (typeof value === "string") {
    const parsed = parseScalar(value);
    if (Array.isArray(parsed)) {
      return parsed.map(String).filter(Boolean);
    }
    return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [String(value)].filter(Boolean);
}
