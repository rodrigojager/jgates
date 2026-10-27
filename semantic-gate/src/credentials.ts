// The user's key store: one file per user, outside every project (globalSecretsPath(): SEMANTIC_GATE_HOME,
// %APPDATA%\semantic-gate or $XDG_CONFIG_HOME/semantic-gate; folder 0700, file 0600), indexed by the name of the
// environment variable that holds the key (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, a name of the user's own).
// JGates reads and writes the same file (jgates/src/core/secrets); both keep this format:
//
//   { "schemaVersion": 2, "secrets": { "<NAME>": { "value": "...", "updatedAt": "<ISO date>" } } }
//
// The first format was a flat map by provider ({ "openrouter": "..." }); those entries are still read, under the name
// of the provider's key variable, and the next write rewrites the file in the new format.
// Precedence: the environment variable always wins over the store. No output ever returns a value, not even a part
// of it: listings carry the name, the state, the source and the date of the last write.
import fs from "node:fs";
import path from "node:path";
import { globalSecretsPath } from "./config.js";
import { SemanticGateError } from "./errors.js";

export const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
/** What a text output shows for a value that is set (fixed length, nothing of the value). */
export const SECRET_MASK = "********";
export const SECRETS_SCHEMA_VERSION = 2;
const MAX_SECRET_LENGTH = 16 * 1024;

/** The providers whose key the store knows by default, in listing order. */
export const KEY_PROVIDERS = ["anthropic", "gemini", "openai", "openai-compatible", "opencode-api", "openrouter"] as const;

export interface StoredSecretInfo {
  /** The name of the variable (the key of the store). */
  name: string;
  /** The provider whose default key this name is (absent for a name of the user's own). */
  provider?: string;
  configured: boolean;
  state: "set" | "unset";
  /** env: the variable is set in the environment (it wins); stored: only the store has it; none: neither. */
  source: "env" | "stored" | "none";
  /** The variable that gives the value in effect (the name itself, or an alternate such as CLAUDE_API_KEY). */
  envName: string;
  /** true when the store has a value for the name (also when the environment wins over it). */
  stored: boolean;
  /** Date of the last write of the name in the store (null when unknown or not stored). */
  updatedAt: string | null;
  /** SECRET_MASK when a value is in effect; never any character of the value. */
  masked?: string;
}

interface StoreEntry {
  value: string;
  updatedAt: string | null;
}

interface StoreContent {
  entries: Map<string, StoreEntry>;
  /** true when the file still has entries of the first format (by provider). */
  legacy: boolean;
}

// ---- names ---------------------------------------------------------------------------------------------------------------

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/** The name a provider's key has in the store: its default variable, or <PROVIDER>_API_KEY for any other provider. */
export function secretNameForProvider(provider: string): string {
  const known = defaultApiKeyEnv(provider);
  if (known) {
    return known;
  }
  const derived = `${normalizeProviderKey(provider).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
  return /^[0-9]/.test(derived) ? `_${derived}` : derived;
}

/** The provider whose default key variable is `name` (anthropic for ANTHROPIC_API_KEY and CLAUDE_API_KEY...). */
export function providerForSecretName(name: string): string | undefined {
  for (const provider of KEY_PROVIDERS) {
    if (defaultApiKeyEnv(provider) === name || alternateApiKeyEnvs(provider).includes(name)) {
      return provider;
    }
  }
  return undefined;
}

/** A name as given to `auth set|unset`: a variable name as it is, or a provider (openrouter, claude...). */
export function secretNameFromArgument(argument: string): string {
  const trimmed = argument.trim();
  if (isValidSecretName(trimmed)) {
    return trimmed;
  }
  if (/^[a-z][a-z0-9-]{0,31}$/i.test(trimmed) && !/^(sk|pk|gsk|xai|key)-/i.test(trimmed) && trimmed.toUpperCase() !== trimmed) {
    return secretNameForProvider(trimmed);
  }
  throw new SemanticGateError(
    `Invalid key name (the text is not repeated). Use a variable name (${SECRET_NAME_PATTERN.source}) or a provider.`,
    "usage",
  );
}

// ---- the file ------------------------------------------------------------------------------------------------------------

function readStore(filePath = globalSecretsPath()): StoreContent {
  const entries = new Map<string, StoreEntry>();
  if (!fs.existsSync(filePath)) {
    return { entries, legacy: false };
  }
  let parsed: unknown;
  let mtime: string | null = null;
  try {
    const text = fs.readFileSync(filePath, "utf8");
    mtime = fs.statSync(filePath).mtime.toISOString();
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch (error) {
    throw new SemanticGateError(
      `The key store ${filePath} cannot be read (${error instanceof Error ? error.message.split("\n")[0] : String(error)}).`,
      "usage",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SemanticGateError(`The key store ${filePath} must hold a JSON object.`, "usage");
  }
  const record = parsed as Record<string, unknown>;
  let legacy = false;
  // First format: { "<provider>": "<value>" }. Read under the provider's key name; the new entries win on a clash.
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string" || !value) {
      continue;
    }
    legacy = true;
    const name = isValidSecretName(key) ? key : secretNameForProvider(key);
    entries.set(name, { value, updatedAt: mtime });
  }
  const secrets = record.secrets;
  if (secrets && typeof secrets === "object" && !Array.isArray(secrets)) {
    for (const [name, raw] of Object.entries(secrets as Record<string, unknown>)) {
      if (!isValidSecretName(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const entry = raw as Record<string, unknown>;
      if (typeof entry.value !== "string" || !entry.value) {
        continue;
      }
      entries.set(name, { value: entry.value, updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null });
    }
  }
  return { entries, legacy };
}

function writeStore(entries: Map<string, StoreEntry>, filePath = globalSecretsPath()): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows ignores POSIX modes; the folder is still in the user's profile.
  }
  const secrets: Record<string, StoreEntry> = {};
  for (const name of [...entries.keys()].sort()) {
    secrets[name] = entries.get(name) as StoreEntry;
  }
  const text = `${JSON.stringify({ schemaVersion: SECRETS_SCHEMA_VERSION, secrets }, null, 2)}\n`;
  // Written next to the file and renamed over it: a reader never sees half a file, and the mode is set before the rename.
  const temp = path.join(dir, `.secrets-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      fs.chmodSync(temp, 0o600);
    } catch {
      // Windows: see above.
    }
    fs.renameSync(temp, filePath);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function checkValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new SemanticGateError("The key is empty.", "usage");
  }
  if (trimmed.length > MAX_SECRET_LENGTH) {
    throw new SemanticGateError(`The key is longer than ${MAX_SECRET_LENGTH} characters.`, "usage");
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new SemanticGateError("The key has a line break or another control character.", "usage");
  }
  return trimmed;
}

// ---- writing -------------------------------------------------------------------------------------------------------------

/** Stores the value of a name; returns the path of the store. The date of the write is kept with the name. */
export function setStoredSecret(name: string, value: string, now: Date = new Date()): string {
  if (!isValidSecretName(name)) {
    throw new SemanticGateError(`Invalid key name (the text is not repeated): use ${SECRET_NAME_PATTERN.source}.`, "usage");
  }
  const checked = checkValue(value);
  const filePath = globalSecretsPath();
  const store = readStore(filePath);
  store.entries.set(name, { value: checked, updatedAt: now.toISOString() });
  writeStore(store.entries, filePath);
  return filePath;
}

/** Removes a name from the store (nothing happens when it is not there); returns the path and whether it was there. */
export function unsetStoredSecret(name: string): { filePath: string; removed: boolean } {
  if (!isValidSecretName(name)) {
    throw new SemanticGateError(`Invalid key name (the text is not repeated): use ${SECRET_NAME_PATTERN.source}.`, "usage");
  }
  const filePath = globalSecretsPath();
  const store = readStore(filePath);
  const removed = store.entries.delete(name);
  if (removed || store.legacy) {
    writeStore(store.entries, filePath);
  }
  return { filePath, removed };
}

/** Compatibility with the first API (by provider): stores under the provider's key name. */
export function setStoredApiKey(provider: string, apiKey: string): string {
  return setStoredSecret(secretNameFromArgument(provider), apiKey);
}

/** Compatibility with the first API (by provider). */
export function unsetStoredApiKey(provider: string): string {
  return unsetStoredSecret(secretNameFromArgument(provider)).filePath;
}

// ---- reading -------------------------------------------------------------------------------------------------------------

/** The value the store has for a name (the store only, not the environment). For the processes that declare the name. */
export function readStoredSecret(name: string): string | undefined {
  if (!isValidSecretName(name)) {
    return undefined;
  }
  return readStore().entries.get(name)?.value;
}

/** Names, state, source and date of the store and of the known providers; never a value. */
export function listStoredApiKeys(env: NodeJS.ProcessEnv = process.env): StoredSecretInfo[] {
  const store = readStore();
  const out: StoredSecretInfo[] = [];
  const covered = new Set<string>();
  for (const provider of KEY_PROVIDERS) {
    const name = secretNameForProvider(provider);
    const alternates = alternateApiKeyEnvs(provider);
    covered.add(name);
    for (const alternate of alternates) {
      covered.add(alternate);
    }
    out.push(describe(name, provider, [name, ...alternates], store, env));
  }
  for (const name of [...store.entries.keys()].sort()) {
    if (!covered.has(name)) {
      out.push(describe(name, undefined, [name], store, env));
    }
  }
  return out;
}

function describe(
  name: string,
  provider: string | undefined,
  names: string[],
  store: StoreContent,
  env: NodeJS.ProcessEnv,
): StoredSecretInfo {
  const fromEnv = names.find((candidate) => Boolean(env[candidate]));
  const storedName = names.find((candidate) => store.entries.has(candidate));
  const storedEntry = storedName ? store.entries.get(storedName) : undefined;
  const source: StoredSecretInfo["source"] = fromEnv ? "env" : storedEntry ? "stored" : "none";
  const info: StoredSecretInfo = {
    name,
    configured: source !== "none",
    state: source === "none" ? "unset" : "set",
    source,
    envName: fromEnv ?? storedName ?? name,
    stored: Boolean(storedEntry),
    updatedAt: storedEntry?.updatedAt ?? null,
  };
  if (provider) {
    info.provider = provider;
  }
  if (info.configured) {
    info.masked = SECRET_MASK;
  }
  return info;
}

export interface ResolvedApiKey {
  value: string;
  source: "env" | "stored";
  /** The variable (or store name) the value came from. */
  name: string;
}

/**
 * The key of a provider: the environment first (the declared name, the provider's default name, its alternates), then
 * the store under the same names unless `store` is false (a run that must use only the environment).
 */
export function resolveApiKeySource(options: {
  provider: string;
  envName?: string;
  keyProvider?: string;
  env?: NodeJS.ProcessEnv;
  store?: boolean;
}): ResolvedApiKey | undefined {
  const env = options.env ?? process.env;
  const keyProvider = normalizeProviderKey(options.keyProvider ?? options.provider);
  const defaultEnv = defaultApiKeyEnv(keyProvider);
  const envNames = uniqueStrings(
    [options.envName, defaultEnv, ...alternateApiKeyEnvs(keyProvider)].filter((name): name is string => Boolean(name)),
  );
  for (const name of envNames) {
    const value = env[name];
    if (value) {
      return { value, source: "env", name };
    }
  }
  if (options.store === false) {
    return undefined;
  }
  const storeNames = uniqueStrings(
    [options.envName, secretNameForProvider(keyProvider), ...alternateApiKeyEnvs(keyProvider)].filter(
      (name): name is string => Boolean(name) && isValidSecretName(name as string),
    ),
  );
  const store = readStore();
  for (const name of storeNames) {
    const entry = store.entries.get(name);
    if (entry) {
      return { value: entry.value, source: "stored", name };
    }
  }
  return undefined;
}

export function resolveApiKey(options: {
  provider: string;
  envName?: string;
  keyProvider?: string;
  env?: NodeJS.ProcessEnv;
  store?: boolean;
}): string | undefined {
  return resolveApiKeySource(options)?.value;
}

export function defaultApiKeyEnv(provider: string): string | undefined {
  switch (normalizeProviderKey(provider)) {
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
    case "claude":
    case "claude-api":
      return "ANTHROPIC_API_KEY";
    case "gemini":
    case "gemini-api":
      return "GEMINI_API_KEY";
    case "openai-compatible":
      return "SEMANTIC_GATE_API_KEY";
    case "opencode-api":
      return "OPENCODE_API_KEY";
    default:
      return undefined;
  }
}

export function alternateApiKeyEnvs(provider: string): string[] {
  switch (normalizeProviderKey(provider)) {
    case "anthropic":
      return ["CLAUDE_API_KEY"];
    case "gemini":
      // The Gemini client libraries also read GOOGLE_API_KEY; here GEMINI_API_KEY, the documented default, wins.
      return ["GOOGLE_API_KEY"];
    default:
      return [];
  }
}

export function normalizeProviderKey(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "claude") {
    return "anthropic";
  }
  if (normalized === "claude-api") {
    return "anthropic";
  }
  if (normalized === "gemini-api") {
    return "gemini";
  }
  return normalized;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
