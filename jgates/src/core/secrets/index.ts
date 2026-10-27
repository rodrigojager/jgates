// The user's key store (D9): the keys of the semantic-gate providers and of the PII tools, kept by the name of the
// environment variable (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, a name of the user's own). It is the file of the
// semantic-gate package (semantic-gate/src/credentials.ts), outside every project and outside the JGates data folder:
// SEMANTIC_GATE_HOME, %APPDATA%\semantic-gate or $XDG_CONFIG_HOME/semantic-gate (~/.config/semantic-gate), file
// secrets.json, folder 0700 and file 0600. Both packages read and write the same format:
//
//   { "schemaVersion": 2, "secrets": { "<NAME>": { "value": "...", "updatedAt": "<ISO date>" } } }
//
// The first format (a flat map by provider) is still read, under the provider's key name, and the next write rewrites
// the file in the new one. A 0600 file is not an operating system keychain: anyone with the user's session reads it.
//
// The rules every caller (CLI, server routes, providers, PII tools) follows through this module:
//   - the environment variable wins over the store (resolveSecret);
//   - a value goes only to the process that declares its name (passEnv of a PII tool, apiKeyEnv of a provider);
//   - nothing returns a value: SecretInfo has the name, the state, the source and the date, never a character of it;
//   - a process that called blockVault() (jgates ci) never reads nor writes the store: only the environment counts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** What a text output shows for a value that is set: fixed length, nothing of the value. */
export const SECRET_MASK = "********";
export const SECRETS_SCHEMA_VERSION = 2;
export const SECRETS_FILE = "secrets.json";
const MAX_VALUE_LENGTH = 16 * 1024;

export type SecretsErrorCode = "INVALID_NAME" | "INVALID_VALUE" | "VAULT_UNREADABLE" | "VAULT_BLOCKED" | "VAULT_WRITE_FAILED";

export class SecretsError extends Error {
  constructor(
    readonly code: SecretsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SecretsError";
  }
}

/** A key variable of a known provider: the default name, the provider id and the other names the provider also reads. */
export interface KnownSecret {
  name: string;
  provider: string;
  alternates: readonly string[];
}

/** The key names of the semantic-gate providers that use an API key (the CLI providers use their own login). */
export const KNOWN_SECRETS: readonly KnownSecret[] = [
  { name: "ANTHROPIC_API_KEY", provider: "anthropic", alternates: ["CLAUDE_API_KEY"] },
  { name: "GEMINI_API_KEY", provider: "gemini", alternates: ["GOOGLE_API_KEY"] },
  { name: "OPENAI_API_KEY", provider: "openai", alternates: [] },
  { name: "OPENCODE_API_KEY", provider: "opencode-api", alternates: [] },
  { name: "OPENROUTER_API_KEY", provider: "openrouter", alternates: [] },
  { name: "SEMANTIC_GATE_API_KEY", provider: "openai-compatible", alternates: [] },
];

export interface SecretInfo {
  name: string;
  /** The provider whose key this name is, or null for a name of the user's own. */
  provider: string | null;
  state: "set" | "unset";
  /** env: the environment has it and wins; vault: only the store has it; none: neither. */
  source: "env" | "vault" | "none";
  /** The variable of the environment that gives the value (the name, or an alternate such as CLAUDE_API_KEY). */
  envName: string | null;
  /** true when the store has a value for the name, also when the environment wins over it. */
  inVault: boolean;
  /** Date of the last write of the name in the store; null when unknown or not stored. */
  updatedAt: string | null;
}

export interface SecretsOptions {
  /** The environment the store's place and the precedence are read from (default: process.env). */
  env?: NodeJS.ProcessEnv;
}

// ---- the process guard ---------------------------------------------------------------------------------------------------

let blocked = false;

/** From now on this process never reads nor writes the store (jgates ci: the pipeline's secrets come from the environment). */
export function blockVault(): void {
  blocked = true;
}

export function vaultBlocked(): boolean {
  return blocked;
}

// ---- names and place -----------------------------------------------------------------------------------------------------

export function isValidSecretName(name: unknown): name is string {
  return typeof name === "string" && SECRET_NAME.test(name);
}

/** The folder of the store: the configuration folder of the semantic-gate package (never a project, never JGATES_HOME). */
export function vaultDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SEMANTIC_GATE_HOME) return env.SEMANTIC_GATE_HOME;
  if (process.platform === "win32" && env.APPDATA) return path.join(env.APPDATA, "semantic-gate");
  const configHome = env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), ".config");
  return path.join(configHome, "semantic-gate");
}

export function vaultPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(vaultDir(env), SECRETS_FILE);
}

export function knownSecret(name: string): KnownSecret | undefined {
  return KNOWN_SECRETS.find((k) => k.name === name || k.alternates.includes(name));
}

/** The name a provider's key has in the store (the provider of the first format, by its id). */
function nameForLegacyProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  const alias = normalized === "claude" || normalized === "claude-api" ? "anthropic" : normalized === "gemini-api" ? "gemini" : normalized;
  const known = KNOWN_SECRETS.find((k) => k.provider === alias);
  if (known) return known.name;
  const derived = `${alias.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
  return /^[0-9]/.test(derived) ? `_${derived}` : derived;
}

function checkName(name: unknown): string {
  if (!isValidSecretName(name)) throw new SecretsError("INVALID_NAME", `invalid key name (the text is not repeated): use capital letters, digits and "_" (${SECRET_NAME.source})`);
  return name;
}

function checkValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new SecretsError("INVALID_VALUE", "the key is empty");
  if (trimmed.length > MAX_VALUE_LENGTH) throw new SecretsError("INVALID_VALUE", `the key is longer than ${MAX_VALUE_LENGTH} characters`);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new SecretsError("INVALID_VALUE", "the key has a line break or another control character");
  return trimmed;
}

function guard(): void {
  if (blocked) throw new SecretsError("VAULT_BLOCKED", "the user key store is not used here: only the environment counts");
}

// ---- the file ------------------------------------------------------------------------------------------------------------

interface Entry {
  value: string;
  updatedAt: string | null;
}

interface Store {
  entries: Map<string, Entry>;
  legacy: boolean;
}

function readStore(file: string): Store {
  const entries = new Map<string, Entry>();
  let text: string;
  let mtime: string | null = null;
  try {
    text = fs.readFileSync(file, "utf8");
    mtime = fs.statSync(file).mtime.toISOString();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries, legacy: false };
    throw new SecretsError("VAULT_UNREADABLE", `the key store ${file} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
  let parsed: unknown;
  try {
    parsed = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new SecretsError("VAULT_UNREADABLE", `the key store ${file} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new SecretsError("VAULT_UNREADABLE", `the key store ${file} must hold a JSON object`);
  const record = parsed as Record<string, unknown>;
  let legacy = false;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string" || value === "") continue;
    legacy = true;
    entries.set(isValidSecretName(key) ? key : nameForLegacyProvider(key), { value, updatedAt: mtime });
  }
  const secrets = record.secrets;
  if (secrets !== null && typeof secrets === "object" && !Array.isArray(secrets)) {
    for (const [name, raw] of Object.entries(secrets as Record<string, unknown>)) {
      if (!isValidSecretName(name) || raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.value !== "string" || entry.value === "") continue;
      entries.set(name, { value: entry.value, updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null });
    }
  }
  return { entries, legacy };
}

function writeStore(file: string, entries: Map<string, Entry>): void {
  const dir = path.dirname(file);
  const secrets: Record<string, Entry> = {};
  for (const name of [...entries.keys()].sort()) secrets[name] = entries.get(name) as Entry;
  const text = `${JSON.stringify({ schemaVersion: SECRETS_SCHEMA_VERSION, secrets }, null, 2)}\n`;
  const temp = path.join(dir, `.secrets-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Windows ignores POSIX modes; the folder is still in the user's profile.
    }
    // Written next to the file with its final mode and renamed over it: a reader never sees half a file.
    fs.writeFileSync(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      fs.chmodSync(temp, 0o600);
    } catch {
      // Windows: see above.
    }
    fs.renameSync(temp, file);
  } catch (error) {
    throw new SecretsError("VAULT_WRITE_FAILED", `the key store ${file} cannot be written (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

// ---- the API -------------------------------------------------------------------------------------------------------------

function describe(name: string, store: Store, env: NodeJS.ProcessEnv): SecretInfo {
  const known = knownSecret(name);
  // The default name of a provider also reports the alternates the provider reads (CLAUDE_API_KEY for ANTHROPIC_API_KEY).
  const envNames = known?.name === name ? [name, ...known.alternates] : [name];
  const envName = envNames.find((n) => typeof env[n] === "string" && env[n] !== "") ?? null;
  const entry = store.entries.get(name);
  const source: SecretInfo["source"] = envName ? "env" : entry ? "vault" : "none";
  return { name, provider: known?.provider ?? null, state: source === "none" ? "unset" : "set", source, envName, inVault: Boolean(entry), updatedAt: entry?.updatedAt ?? null };
}

const emptyStore = (): Store => ({ entries: new Map(), legacy: false });

/**
 * The known provider names, the names in the store and `extraNames`, sorted, with state and source. Never a value.
 * When the store is blocked (jgates ci) only the environment is reported.
 */
export function listSecrets(options: SecretsOptions & { extraNames?: readonly string[] } = {}): SecretInfo[] {
  const env = options.env ?? process.env;
  const store = blocked ? emptyStore() : readStore(vaultPath(env));
  const names = new Set<string>([...KNOWN_SECRETS.map((k) => k.name), ...store.entries.keys()]);
  for (const name of options.extraNames ?? []) if (isValidSecretName(name)) names.add(name);
  return [...names].sort().map((name) => describe(name, store, env));
}

/** The state of one name (no value). */
export function secretInfo(name: string, options: SecretsOptions = {}): SecretInfo {
  checkName(name);
  const env = options.env ?? process.env;
  return describe(name, blocked ? emptyStore() : readStore(vaultPath(env)), env);
}

/** Writes the value of a name, with the date of the write; returns the state (no value). */
export function setSecret(name: string, value: string, options: SecretsOptions & { now?: Date } = {}): SecretInfo {
  checkName(name);
  const checked = checkValue(value);
  guard();
  const env = options.env ?? process.env;
  const file = vaultPath(env);
  const store = readStore(file);
  store.entries.set(name, { value: checked, updatedAt: (options.now ?? new Date()).toISOString() });
  writeStore(file, store.entries);
  return describe(name, store, env);
}

/** Removes a name from the store; `removed` is false when it was not there. */
export function unsetSecret(name: string, options: SecretsOptions = {}): { removed: boolean; info: SecretInfo } {
  checkName(name);
  guard();
  const env = options.env ?? process.env;
  const file = vaultPath(env);
  const store = readStore(file);
  const removed = store.entries.delete(name);
  if (removed || store.legacy) writeStore(file, store.entries);
  return { removed, info: describe(name, store, env) };
}

/**
 * The value of a name for the process that declares it: the environment first, then the store (unless `vault` is false
 * or the store is blocked). undefined when neither has it. The caller hands the value to that process only.
 */
export function resolveSecret(name: string, options: SecretsOptions & { vault?: boolean } = {}): { value: string; source: "env" | "vault" } | undefined {
  if (!isValidSecretName(name)) return undefined;
  const env = options.env ?? process.env;
  const fromEnv = env[name];
  if (typeof fromEnv === "string" && fromEnv !== "") return { value: fromEnv, source: "env" };
  if (options.vault === false || blocked) return undefined;
  const entry = readStore(vaultPath(env)).entries.get(name);
  return entry ? { value: entry.value, source: "vault" } : undefined;
}
