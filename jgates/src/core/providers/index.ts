// The user's provider preferences (D10): per known provider, the base URL (a proxy instead of the provider's address),
// the default model and the name of the key; and named connections of type openai-compatible (a gateway: LiteLLM,
// vLLM, a team proxy, Ollama under /v1) with a base URL, a key name, a default model and extra headers that carry no
// secret. A project uses a connection with `provider: <name>` in jgates.yml > extensions.semantic-gate.
//
// They live in the global config.json of the semantic-gate package, next to the key store (core/secrets), outside every
// project and outside the JGates data folder. The semantic-gate package reads the same keys (semantic-gate/src/config.ts,
// readUserPreferences); a cross-read test keeps the two implementations in step:
//
//   "providers":   { "<provider id>": { "baseUrl"?, "model"?, "apiKeyEnv"?, "allowInsecureHttp"? } }
//   "connections": { "<name>": { "type": "openai-compatible", "baseUrl", "apiKeyEnv"?, "model"?, "headers"?, "allowInsecureHttp"? } }
//
// The other keys of config.json (the flat settings of the semantic-gate CLI) are kept as they are on every write.
// Precedence, field by field: the project, then the user's preference, then the provider's default; the resolution says
// where each value came from. A process that called blockUserPreferences() (jgates ci) never reads nor writes them.
// No credential is ever kept here: a header with a credential name is refused, the key goes in the key store.
import fs from "node:fs";
import path from "node:path";
import { isValidSecretName, secretInfo, vaultDir, type SecretInfo } from "../secrets/index.js";

export const PREFERENCES_FILE = "config.json";
export const PROVIDERS_KEY = "providers";
export const CONNECTIONS_KEY = "connections";
export const CONNECTION_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const CONNECTION_TYPES = ["openai-compatible"] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

export type ProviderField = "baseUrl" | "model" | "apiKeyEnv";
export const PROVIDER_FIELDS: readonly ProviderField[] = ["baseUrl", "model", "apiKeyEnv"];
/** project: jgates.yml; user: the preferences; default: the provider's own value; unset: none of them has one. */
export type Origin = "project" | "user" | "default" | "unset";

/** A provider of the semantic-gate package: id, aliases, defaults and the fields a preference may set. */
export interface ProviderInfo {
  id: string;
  aliases: readonly string[];
  kind: "http" | "cli";
  baseUrl: string | null;
  apiKeyEnv: string | null;
  fields: readonly ProviderField[];
}

/** Same table as PROVIDER_DEFAULTS of semantic-gate/src/config.ts (the cross-read test compares them). */
export const PROVIDERS: readonly ProviderInfo[] = [
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

/** Names that are not configurable but taken: the generic command provider and the mock. */
const OTHER_PROVIDERS = ["command", "mock"] as const;

/** Every name the semantic-gate package gives a meaning to: a connection never takes one. */
export const RESERVED_NAMES: readonly string[] = [...PROVIDERS.flatMap((p) => [p.id, ...p.aliases]), ...OTHER_PROVIDERS].sort();

// ---- errors ---------------------------------------------------------------------------------------------------------------

export type ProvidersErrorCode =
  | "INVALID_NAME"
  | "NAME_COLLIDES"
  | "UNKNOWN_PROVIDER"
  | "NOT_CONFIGURABLE"
  | "FIELD_NOT_SUPPORTED"
  | "CONNECTION_EXISTS"
  | "NOT_FOUND"
  | "INVALID_TYPE"
  | "MISSING_BASE_URL"
  | "INVALID_URL"
  | "URL_SCHEME"
  | "URL_CREDENTIALS"
  | "URL_QUERY"
  | "INSECURE_HTTP"
  | "INVALID_KEY_NAME"
  | "INVALID_MODEL"
  | "INVALID_HEADER_NAME"
  | "INVALID_HEADER_VALUE"
  | "CREDENTIAL_HEADER"
  | "RESERVED_HEADER"
  | "PREFERENCES_UNREADABLE"
  | "PREFERENCES_BLOCKED"
  | "PREFERENCES_WRITE_FAILED";

/** One refused field: `field` is the path of the field (baseUrl, headers.X-Api-Key, name). No value is ever repeated. */
export interface FieldError {
  field: string;
  code: ProvidersErrorCode;
  message: string;
}

const MESSAGES: Record<ProvidersErrorCode, string> = {
  INVALID_NAME: "a connection name has lowercase letters, digits and \"-\", starts with a letter or a digit and has at most 63 characters",
  NAME_COLLIDES: "the name is a provider of the semantic gate; choose another name for the connection",
  UNKNOWN_PROVIDER: "neither a provider of the semantic gate nor a connection of the preferences",
  NOT_CONFIGURABLE: "this provider has no preferences (it is configured in jgates.yml)",
  FIELD_NOT_SUPPORTED: "this provider does not use this field",
  CONNECTION_EXISTS: "a connection with this name already exists (jgates providers set changes it)",
  NOT_FOUND: "there is no connection with this name",
  INVALID_TYPE: "the only connection type is openai-compatible",
  MISSING_BASE_URL: "a connection needs a base URL",
  INVALID_URL: "not a valid URL",
  URL_SCHEME: "only http and https are accepted",
  URL_CREDENTIALS: "a user or a password in the URL is refused: the key goes in the key store",
  URL_QUERY: "a query string or a fragment in the URL is refused",
  INSECURE_HTTP: "plain http to a host that is not loopback would send the key in clear text; use https or confirm it explicitly",
  INVALID_KEY_NAME: "a key name has capital letters, digits and \"_\" and does not start with a digit",
  INVALID_MODEL: "a model is a non-empty text of at most 200 characters, with no line break",
  INVALID_HEADER_NAME: "not a valid header name",
  INVALID_HEADER_VALUE: "a header value is a text of at most 1024 characters, with no line break",
  CREDENTIAL_HEADER: "a header that carries a credential is refused: the key goes in the key store",
  RESERVED_HEADER: "this header is set by the semantic gate itself",
  PREFERENCES_UNREADABLE: "the preferences file cannot be read",
  PREFERENCES_BLOCKED: "the user's preferences are not used here: only the project and the environment count",
  PREFERENCES_WRITE_FAILED: "the preferences file cannot be written",
};

const fieldError = (field: string, code: ProvidersErrorCode): FieldError => ({ field, code, message: `${field}: ${MESSAGES[code]}` });

export class ProvidersError extends Error {
  constructor(
    readonly code: ProvidersErrorCode,
    readonly errors: readonly FieldError[],
    message: string = errors.map((e) => e.message).join("; "),
  ) {
    super(message);
    this.name = "ProvidersError";
  }
}

function refuse(errors: FieldError[]): never {
  throw new ProvidersError((errors[0] as FieldError).code, errors);
}

// ---- the process guard ------------------------------------------------------------------------------------------------------

let blocked = false;

/** From now on this process never reads nor writes the user's preferences (jgates ci: only the policy and the environment). */
export function blockUserPreferences(): void {
  blocked = true;
}

export function userPreferencesBlocked(): boolean {
  return blocked;
}

// ---- validation (same rules as semantic-gate/src/config.ts) ---------------------------------------------------------------

/** The provider of a name (an id or an alias), or undefined. */
export function knownProvider(name: string): ProviderInfo | undefined {
  const normalized = name.trim().toLowerCase();
  return PROVIDERS.find((p) => p.id === normalized || p.aliases.includes(normalized));
}

export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.includes(name.trim().toLowerCase());
}

/** true for localhost, *.localhost, 127.0.0.0/8 and ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "::1";
}

/** Why a base URL is refused (a code), or undefined when it is accepted. */
export function baseUrlProblem(value: unknown, allowInsecureHttp: boolean): ProvidersErrorCode | undefined {
  if (typeof value !== "string" || value.trim() === "") return "INVALID_URL";
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "INVALID_URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "URL_SCHEME";
  if (url.username || url.password) return "URL_CREDENTIALS";
  if (url.search || url.hash) return "URL_QUERY";
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname) && !allowInsecureHttp) return "INSECURE_HTTP";
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

/** Why an extra header is refused (a code), or undefined when it is accepted. */
export function headerProblem(name: string, value: unknown): ProvidersErrorCode | undefined {
  if (!HEADER_NAME.test(name)) return "INVALID_HEADER_NAME";
  if (isCredentialHeader(name)) return "CREDENTIAL_HEADER";
  if (RESERVED_HEADERS.has(name.toLowerCase())) return "RESERVED_HEADER";
  if (typeof value !== "string" || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return "INVALID_HEADER_VALUE";
  if (/^(bearer|basic|token)\s/i.test(value.trim())) return "CREDENTIAL_HEADER";
  return undefined;
}

const validModel = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The key name a connection uses when it declares none: <NAME>_API_KEY (the rule of the semantic-gate package). */
export function defaultConnectionKeyName(name: string): string {
  const derived = `${name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
  return /^[0-9]/.test(derived) ? `_${derived}` : derived;
}

// ---- the file ---------------------------------------------------------------------------------------------------------------

export interface ProviderPreference {
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  allowInsecureHttp?: boolean;
}

export interface Connection extends ProviderPreference {
  type: ConnectionType;
  baseUrl: string;
  headers: Record<string, string>;
}

export interface Preferences {
  providers: Record<string, ProviderPreference>;
  connections: Record<string, Connection>;
  /** Entries of the file that break a rule (a hand edit): left out, named here with the field. */
  problems: FieldError[];
}

export interface PreferencesOptions {
  /** The environment the place of the file is read from (default: process.env). */
  env?: NodeJS.ProcessEnv;
}

export function preferencesPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(vaultDir(env), PREFERENCES_FILE);
}

function readRaw(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ProvidersError("PREFERENCES_UNREADABLE", [fieldError(file, "PREFERENCES_UNREADABLE")]);
  }
  let parsed: unknown;
  try {
    parsed = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new ProvidersError("PREFERENCES_UNREADABLE", [fieldError(file, "PREFERENCES_UNREADABLE")], `the preferences file ${file} is not valid JSON`);
  }
  if (!isRec(parsed)) throw new ProvidersError("PREFERENCES_UNREADABLE", [fieldError(file, "PREFERENCES_UNREADABLE")], `the preferences file ${file} must hold a JSON object`);
  return parsed;
}

function writeRaw(file: string, record: Record<string, unknown>): void {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.config-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Written next to the file and renamed over it: a reader never sees half a file.
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } catch {
    throw new ProvidersError("PREFERENCES_WRITE_FAILED", [fieldError(file, "PREFERENCES_WRITE_FAILED")]);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** The checks of the fields a preference sets (also used to read the file). */
function checkFields(entry: Record<string, unknown>, where: string, allowed: readonly ProviderField[]): FieldError[] {
  const errors: FieldError[] = [];
  const prefix = where ? `${where}.` : "";
  const allowHttp = entry.allowInsecureHttp === true;
  if (entry.baseUrl !== undefined) {
    if (!allowed.includes("baseUrl")) errors.push(fieldError(`${prefix}baseUrl`, "FIELD_NOT_SUPPORTED"));
    else {
      const problem = baseUrlProblem(entry.baseUrl, allowHttp);
      if (problem) errors.push(fieldError(`${prefix}baseUrl`, problem));
    }
  }
  if (entry.model !== undefined && !validModel(entry.model)) errors.push(fieldError(`${prefix}model`, "INVALID_MODEL"));
  if (entry.apiKeyEnv !== undefined) {
    if (!allowed.includes("apiKeyEnv")) errors.push(fieldError(`${prefix}apiKeyEnv`, "FIELD_NOT_SUPPORTED"));
    else if (!isValidSecretName(entry.apiKeyEnv)) errors.push(fieldError(`${prefix}apiKeyEnv`, "INVALID_KEY_NAME"));
  }
  if (entry.headers !== undefined) {
    if (!isRec(entry.headers)) errors.push(fieldError(`${prefix}headers`, "INVALID_HEADER_NAME"));
    else for (const [name, value] of Object.entries(entry.headers)) {
      const problem = headerProblem(name, value);
      if (problem) errors.push(fieldError(`${prefix}headers.${name}`, problem));
    }
  }
  return errors;
}

function preferenceOf(entry: Record<string, unknown>): ProviderPreference {
  const out: ProviderPreference = {};
  if (typeof entry.baseUrl === "string") out.baseUrl = entry.baseUrl.trim();
  if (typeof entry.model === "string") out.model = entry.model.trim();
  if (typeof entry.apiKeyEnv === "string") out.apiKeyEnv = entry.apiKeyEnv;
  if (entry.allowInsecureHttp === true) out.allowInsecureHttp = true;
  return out;
}

function parsePreferences(raw: Record<string, unknown>): Preferences {
  const out: Preferences = { providers: {}, connections: {}, problems: [] };
  const providers = raw[PROVIDERS_KEY];
  if (isRec(providers)) {
    for (const [name, entry] of Object.entries(providers)) {
      const where = `${PROVIDERS_KEY}.${name}`;
      const known = knownProvider(name);
      if (!known || known.id !== name || !isRec(entry)) {
        out.problems.push(fieldError(where, "UNKNOWN_PROVIDER"));
        continue;
      }
      const errors = checkFields(entry, where, known.fields);
      if (errors.length > 0) out.problems.push(...errors);
      else out.providers[name] = preferenceOf(entry);
    }
  }
  const connections = raw[CONNECTIONS_KEY];
  if (isRec(connections)) {
    for (const [name, entry] of Object.entries(connections)) {
      const where = `${CONNECTIONS_KEY}.${name}`;
      if (!CONNECTION_NAME.test(name) || isReservedName(name) || !isRec(entry)) {
        out.problems.push(fieldError(where, isReservedName(name) ? "NAME_COLLIDES" : "INVALID_NAME"));
        continue;
      }
      const errors = checkFields(entry, where, PROVIDER_FIELDS);
      if ((entry.type ?? "openai-compatible") !== "openai-compatible") errors.push(fieldError(`${where}.type`, "INVALID_TYPE"));
      if (entry.baseUrl === undefined) errors.push(fieldError(`${where}.baseUrl`, "MISSING_BASE_URL"));
      if (errors.length > 0) {
        out.problems.push(...errors);
        continue;
      }
      const headers: Record<string, string> = {};
      if (isRec(entry.headers)) for (const [h, v] of Object.entries(entry.headers)) headers[h] = String(v);
      out.connections[name] = { ...preferenceOf(entry), type: "openai-compatible", baseUrl: String(entry.baseUrl).trim(), headers };
    }
  }
  return out;
}

const emptyPreferences = (): Preferences => ({ providers: {}, connections: {}, problems: [] });

/** The preferences of the user (empty when blocked: jgates ci). A broken entry is left out and named in `problems`. */
export function readPreferences(options: PreferencesOptions = {}): Preferences {
  if (blocked) return emptyPreferences();
  return parsePreferences(readRaw(preferencesPath(options.env ?? process.env)));
}

// ---- the listing --------------------------------------------------------------------------------------------------------------

export interface FieldValue {
  value: string | null;
  origin: Origin;
}

/** The state of the key a provider or connection uses: name, state and source, never a value. */
export interface KeyState {
  name: string;
  state: SecretInfo["state"] | "unknown";
  source: SecretInfo["source"] | "unknown";
  updatedAt: string | null;
}

/** One provider or connection as the preferences make it (user over default), for the CLI and the interface. */
export interface ProviderEntry {
  name: string;
  kind: "provider" | "connection";
  /** The type of a connection; for a provider, http (an API) or cli (a CLI with its own login). */
  type: ConnectionType | "http" | "cli";
  /** The fields a preference may set for it. */
  fields: readonly ProviderField[];
  baseUrl: FieldValue;
  model: FieldValue;
  apiKeyEnv: FieldValue;
  headers: Record<string, string>;
  allowInsecureHttp: boolean;
  /** null when it uses no key (a CLI provider, ollama). */
  key: KeyState | null;
}

const fv = (value: string | null | undefined, origin: Origin): FieldValue => (value === undefined || value === null ? { value: null, origin: "unset" } : { value, origin });

function keyState(name: string | null, env: NodeJS.ProcessEnv): KeyState | null {
  if (!name) return null;
  try {
    const info = secretInfo(name, { env });
    return { name, state: info.state, source: info.source, updatedAt: info.updatedAt };
  } catch {
    return { name, state: "unknown", source: "unknown", updatedAt: null };
  }
}

function providerEntryOf(info: ProviderInfo, prefs: ProviderPreference | undefined, env: NodeJS.ProcessEnv): ProviderEntry {
  const pick = (field: "baseUrl" | "apiKeyEnv"): FieldValue => (!info.fields.includes(field) ? fv(null, "unset") : prefs?.[field] !== undefined ? fv(prefs[field], "user") : fv(info[field], "default"));
  const apiKeyEnv = pick("apiKeyEnv");
  return {
    name: info.id,
    kind: "provider",
    type: info.kind,
    fields: info.fields,
    baseUrl: pick("baseUrl"),
    model: fv(prefs?.model, "user"),
    apiKeyEnv,
    headers: {},
    allowInsecureHttp: prefs?.allowInsecureHttp === true,
    key: keyState(apiKeyEnv.value, env),
  };
}

function connectionEntryOf(name: string, c: Connection, env: NodeJS.ProcessEnv): ProviderEntry {
  const apiKeyEnv = c.apiKeyEnv !== undefined ? fv(c.apiKeyEnv, "user") : fv(defaultConnectionKeyName(name), "default");
  return {
    name,
    kind: "connection",
    type: c.type,
    fields: PROVIDER_FIELDS,
    baseUrl: fv(c.baseUrl, "user"),
    model: fv(c.model, "user"),
    apiKeyEnv,
    headers: { ...c.headers },
    allowInsecureHttp: c.allowInsecureHttp === true,
    key: keyState(apiKeyEnv.value, env),
  };
}

/** Every configurable provider (by id) and every connection (by name), with the value and origin of each field. */
export function listProviders(options: PreferencesOptions = {}): { providers: ProviderEntry[]; problems: FieldError[]; file: string; blocked: boolean } {
  const env = options.env ?? process.env;
  const prefs = readPreferences({ env });
  const providers = PROVIDERS.map((p) => providerEntryOf(p, prefs.providers[p.id], env));
  const connections = Object.keys(prefs.connections)
    .sort()
    .map((name) => connectionEntryOf(name, prefs.connections[name] as Connection, env));
  return { providers: [...providers, ...connections], problems: prefs.problems, file: preferencesPath(env), blocked };
}

/** One provider (by id or alias) or connection; undefined when the name is neither. */
export function providerEntry(name: string, options: PreferencesOptions = {}): ProviderEntry | undefined {
  const env = options.env ?? process.env;
  const prefs = readPreferences({ env });
  const known = knownProvider(name);
  if (known) return providerEntryOf(known, prefs.providers[known.id], env);
  const c = prefs.connections[name];
  return c ? connectionEntryOf(name, c, env) : undefined;
}

// ---- the changes -------------------------------------------------------------------------------------------------------------

/** A change of a preference: a value sets the field, null removes it (back to the default), undefined leaves it. */
export interface ProviderPatch {
  baseUrl?: string | null;
  model?: string | null;
  apiKeyEnv?: string | null;
  /** The explicit confirmation that plain http to a host that is not loopback is accepted. */
  allowInsecureHttp?: boolean | null;
  /** Connections only: the whole set of extra headers (replaces it); null removes them all. */
  headers?: Record<string, string> | null;
}

function guard(): void {
  if (blocked) refuse([fieldError("preferences", "PREFERENCES_BLOCKED")]);
}

function applyPatch(current: Record<string, unknown>, patch: ProviderPatch): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const key of ["baseUrl", "model", "apiKeyEnv", "allowInsecureHttp", "headers"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null || value === false || (typeof value === "string" && value.trim() === "")) delete next[key];
    else next[key] = typeof value === "string" ? value.trim() : value;
  }
  return next;
}

function sectionOf(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const section = raw[key];
  return isRec(section) ? { ...section } : {};
}

/**
 * Changes the preference of a known provider (by id or alias) or of an existing connection. Every refused field is
 * reported at once (ProvidersError.errors, with the field); nothing is written when one is refused.
 */
export function setProvider(name: string, givenPatch: ProviderPatch, options: PreferencesOptions = {}): ProviderEntry {
  guard();
  // A new base URL drops the confirmation of plain http given for the old one, unless the change confirms it again.
  const patch: ProviderPatch = givenPatch.baseUrl !== undefined && givenPatch.allowInsecureHttp === undefined ? { ...givenPatch, allowInsecureHttp: null } : givenPatch;
  const env = options.env ?? process.env;
  const file = preferencesPath(env);
  const raw = readRaw(file);
  const known = knownProvider(name);
  if (!known) {
    if ((OTHER_PROVIDERS as readonly string[]).includes(name.trim().toLowerCase())) refuse([fieldError("name", "NOT_CONFIGURABLE")]);
    const connections = sectionOf(raw, CONNECTIONS_KEY);
    const current = connections[name];
    if (!isRec(current)) refuse([fieldError("name", "UNKNOWN_PROVIDER")]);
    const next = applyPatch(current as Record<string, unknown>, patch);
    const errors = checkFields(next, "", PROVIDER_FIELDS);
    if (next.baseUrl === undefined) errors.push(fieldError("baseUrl", "MISSING_BASE_URL"));
    if (errors.length > 0) refuse(errors);
    connections[name] = { type: "openai-compatible", ...next };
    writeRaw(file, { ...raw, [CONNECTIONS_KEY]: connections });
    return providerEntry(name, { env }) as ProviderEntry;
  }
  if (patch.headers !== undefined && patch.headers !== null) refuse([fieldError("headers", "FIELD_NOT_SUPPORTED")]);
  const providers = sectionOf(raw, PROVIDERS_KEY);
  const current = isRec(providers[known.id]) ? (providers[known.id] as Record<string, unknown>) : {};
  const { headers: _headers, ...fields } = patch;
  const next = applyPatch(current, fields);
  const errors = checkFields(next, "", known.fields);
  if (errors.length > 0) refuse(errors);
  if (Object.keys(next).length === 0) delete providers[known.id];
  else providers[known.id] = next;
  writeRaw(file, { ...raw, [PROVIDERS_KEY]: providers });
  return providerEntry(known.id, { env }) as ProviderEntry;
}

export interface ConnectionInput {
  type?: string;
  baseUrl: string;
  model?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  allowInsecureHttp?: boolean;
}

/** Adds a named connection; the name, the base URL and every header are checked, and nothing is written when one fails. */
export function addConnection(name: string, input: ConnectionInput, options: PreferencesOptions = {}): ProviderEntry {
  guard();
  const env = options.env ?? process.env;
  const errors: FieldError[] = [];
  if (isReservedName(name)) errors.push(fieldError("name", "NAME_COLLIDES"));
  else if (!CONNECTION_NAME.test(name)) errors.push(fieldError("name", "INVALID_NAME"));
  if (input.type !== undefined && input.type !== "openai-compatible") errors.push(fieldError("type", "INVALID_TYPE"));
  const entry = applyPatch({}, { baseUrl: input.baseUrl ?? null, model: input.model ?? null, apiKeyEnv: input.apiKeyEnv ?? null, allowInsecureHttp: input.allowInsecureHttp ?? null, headers: input.headers && Object.keys(input.headers).length > 0 ? input.headers : null });
  if (entry.baseUrl === undefined) errors.push(fieldError("baseUrl", "MISSING_BASE_URL"));
  errors.push(...checkFields(entry, "", PROVIDER_FIELDS));
  if (errors.length > 0) refuse(errors);
  const file = preferencesPath(env);
  const raw = readRaw(file);
  const connections = sectionOf(raw, CONNECTIONS_KEY);
  if (connections[name] !== undefined) refuse([fieldError("name", "CONNECTION_EXISTS")]);
  connections[name] = { type: "openai-compatible", ...entry };
  writeRaw(file, { ...raw, [CONNECTIONS_KEY]: connections });
  return providerEntry(name, { env }) as ProviderEntry;
}

/** Removes a connection, or the preferences of a known provider (back to its defaults). */
export function removeProvider(name: string, options: PreferencesOptions = {}): { removed: boolean; kind: "connection" | "provider" } {
  guard();
  const env = options.env ?? process.env;
  const file = preferencesPath(env);
  const raw = readRaw(file);
  const known = knownProvider(name);
  const key = known ? PROVIDERS_KEY : CONNECTIONS_KEY;
  const id = known ? known.id : name;
  const section = sectionOf(raw, key);
  if (section[id] === undefined) {
    if (!known) refuse([fieldError("name", (OTHER_PROVIDERS as readonly string[]).includes(name) ? "NOT_CONFIGURABLE" : "NOT_FOUND")]);
    return { removed: false, kind: "provider" };
  }
  delete section[id];
  writeRaw(file, { ...raw, [key]: section });
  return { removed: true, kind: known ? "provider" : "connection" };
}

// ---- the resolution of a run ---------------------------------------------------------------------------------------------------

/** What the project (jgates.yml > extensions.semantic-gate) declares for the provider fields. */
export interface ProjectProviderFields {
  baseUrl?: string | null;
  model?: string | null;
  apiKeyEnv?: string | null;
}

/** The provider settings in effect, field by field, with where each value came from. */
export interface ProviderResolution {
  provider: string;
  /** provider: a known provider; connection: a connection of the preferences; other: command or mock; unknown: neither. */
  kind: "provider" | "connection" | "other" | "unknown";
  /** used: the user's preferences were read; ignored: they were not (jgates ci, or the caller asked so). */
  preferences: "used" | "ignored";
  baseUrl: FieldValue;
  model: FieldValue;
  apiKeyEnv: FieldValue;
  /** Names of the extra headers of a connection (the values are in `headerValues`). */
  headers: string[];
  headerValues: Record<string, string>;
  allowInsecureHttp: boolean;
}

/**
 * Field by field: the project, then the user's preference for that provider (or the connection of that name), then
 * the provider's default. With `preferences: false` (or when blocked) only the project and the defaults count.
 */
export function resolveProviderSettings(provider: string, project: ProjectProviderFields, options: PreferencesOptions & { preferences?: boolean } = {}): ProviderResolution {
  const use = options.preferences !== false && !blocked;
  let prefs: Preferences = emptyPreferences();
  if (use) {
    try {
      prefs = readPreferences(options);
    } catch {
      prefs = emptyPreferences();
    }
  }
  const known = knownProvider(provider);
  const connection = known ? undefined : prefs.connections[provider];
  const kind: ProviderResolution["kind"] = known ? "provider" : connection ? "connection" : (OTHER_PROVIDERS as readonly string[]).includes(provider) ? "other" : "unknown";
  const user: ProviderPreference | undefined = known ? prefs.providers[known.id] : connection;
  const defaults: Record<ProviderField, string | null> = known
    ? { baseUrl: known.baseUrl, model: null, apiKeyEnv: known.apiKeyEnv }
    : connection
      ? { baseUrl: null, model: null, apiKeyEnv: defaultConnectionKeyName(provider) }
      : { baseUrl: null, model: null, apiKeyEnv: null };
  const field = (name: ProviderField): FieldValue => {
    const fromProject = project[name];
    if (typeof fromProject === "string" && fromProject !== "") return { value: fromProject, origin: "project" };
    const fromUser = user?.[name];
    if (fromUser !== undefined) return { value: fromUser, origin: "user" };
    return fv(defaults[name], "default");
  };
  const baseUrl = field("baseUrl");
  return {
    provider,
    kind,
    preferences: use ? "used" : "ignored",
    baseUrl,
    model: field("model"),
    apiKeyEnv: field("apiKeyEnv"),
    headers: Object.keys(connection?.headers ?? {}).sort(),
    headerValues: { ...(connection?.headers ?? {}) },
    allowInsecureHttp: baseUrl.origin === "user" && user?.allowInsecureHttp === true,
  };
}

/** The public form of a resolution (no header values): what the result and the server show. */
export function publicResolution(r: ProviderResolution): Omit<ProviderResolution, "headerValues"> {
  const { headerValues: _values, ...rest } = r;
  return rest;
}
