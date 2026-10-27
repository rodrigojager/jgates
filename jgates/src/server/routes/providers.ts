// Preferências > Providers e chaves: the user's provider preferences (D10) through the local server. Per known provider
// the base URL, the default model and the key name; named connections of type openai-compatible (a gateway) with base
// URL, key name, default model and extra headers that carry no secret. They live in the global config.json of the
// semantic-gate package (core/providers), outside every project: nothing here touches the workspace.
//
// Rules of these routes (and of secrets.ts, which uses the helpers below):
//  - writing is refused in the governed mode (JGATES_POLICY_DIR) and while the server edits a CI policy (--policy);
//  - the body is never logged (the server log has the method, the path and the status only) and no answer carries a
//    key value: an entry has the key's name, state and source, never a character of it;
//  - config.json has a revision (sha256 of the file, null when absent): a write that names an older one is a conflict;
//  - Testar lists the models of the provider with the key, without sending a prompt or spending a token.
import crypto from "node:crypto";
import fs from "node:fs";
import { loadModelLister } from "../../adapters/semantic-gate/index.js";
import { emptyCounts, maskText, strictMaskRules } from "../../adapters/semantic-gate/mask.js";
import {
  addConnection,
  CONNECTION_TYPES,
  listProviders,
  preferencesPath,
  providerEntry,
  ProvidersError,
  removeProvider,
  RESERVED_NAMES,
  setProvider,
  type FieldError,
  type FieldValue,
  type ProviderEntry,
  type ProviderPatch,
} from "../../core/providers/index.js";
import { resolveSecret, SECRET_MASK } from "../../core/secrets/index.js";
import { translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import { modeOf, policyEditingDir } from "../policy-mode.js";
import type { RouteDefinition, ServerContext } from "../types.js";

const t = translator("server");

export const HASH_PATTERN = "^[0-9a-f]{64}$";
/** A provider id, an alias or a connection name (the core checks which one). */
export const PROVIDER_NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,62}$";
const TEST_TIMEOUT_MS = 30_000;
/** Handler limit of a route that lists models: the provider call plus the loading of the package. */
export const MODELS_TIMEOUT_MS = TEST_TIMEOUT_MS + 15_000;
/** Models an answer of Testar carries at most (the list feeds the choice of the default model). */
const MAX_MODELS = 500;

// ---- the lock of the user's settings ------------------------------------------------------------------------------------

export type UserSettingsLock = "governed" | "policy" | null;

/** Why the user's keys and provider preferences cannot be written by this server, or null when they can. */
export function userSettingsLock(server: ServerContext): UserSettingsLock {
  if (server.policyMode || policyEditingDir() !== null) return "policy";
  if (modeOf().mode === "governed") return "governed";
  return null;
}

/** Refuses a write of the user's settings in the governed mode and while a CI policy is edited. */
export function assertUserSettingsWritable(server: ServerContext): void {
  const lock = userSettingsLock(server);
  if (lock === "governed") {
    throw new HttpError(403, "GOVERNED_LOCKED", t("server_user_locked_governed", { policy: modeOf().governed?.policy ?? "" }), t("server_user_locked_governed_fix"));
  }
  if (lock === "policy") throw new HttpError(409, "POLICY_MODE_UNAVAILABLE", t("server_user_locked_policy"), t("server_user_locked_policy_fix"));
}

// ---- the revision of config.json ----------------------------------------------------------------------------------------

/** sha256 of config.json, or null when the file does not exist. */
export function preferencesRevision(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(preferencesPath(env))).digest("hex");
  } catch {
    return null;
  }
}

function checkRevision(expected: string | null | undefined): void {
  if (expected === undefined) return;
  const current = preferencesRevision();
  if (expected !== current) throw new HttpError(409, "REVISION_CONFLICT", t("server_providers_conflict"), t("server_providers_conflict_fix"), { currentRevision: current });
}

// ---- errors ----------------------------------------------------------------------------------------------------------------

const PROVIDERS_STATUS: Record<string, number> = {
  UNKNOWN_PROVIDER: 404,
  NOT_FOUND: 404,
  CONNECTION_EXISTS: 409,
  PREFERENCES_BLOCKED: 403,
  PREFERENCES_UNREADABLE: 422,
  PREFERENCES_WRITE_FAILED: 500,
};

/** A refused field with the message of the server catalog (the field path is kept; no value is ever repeated). */
export function fieldErrorView(e: FieldError): { field: string; code: string; message: string } {
  const key = `server_prov_${e.code.toLowerCase()}`;
  const text = t(key);
  return { field: e.field, code: e.code, message: text === key ? e.message : text };
}

/** Runs a change of the preferences and turns a ProvidersError into an HttpError with every refused field. */
export function providersGuard<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ProvidersError) {
      const errors = error.errors.map(fieldErrorView);
      const first = errors[0];
      const message = first ? `${first.field}: ${first.message}` : t("server_internal");
      throw new HttpError(PROVIDERS_STATUS[error.code] ?? 422, error.code, message, t("server_prov_fix"), { errors });
    }
    throw error;
  }
}

// ---- the test of a provider ---------------------------------------------------------------------------------------------

export interface ModelsAnswer {
  name: string;
  kind: ProviderEntry["kind"];
  keyName: string | null;
  count: number;
  models: string[];
  truncated: boolean;
  /** Whether the default model is in the list (null when no default model is set). */
  defaultModelListed: boolean | null;
}

/**
 * Lists the models of a provider or connection with its preferences and the key (no prompt is sent, no token is
 * spent). `keyName` tests another key name with the same provider (POST /api/secrets/<NAME>/test). The text that comes
 * back has neither the key nor anything shaped like a credential, whatever the provider answers.
 */
export async function listModelsOf(entry: ProviderEntry, keyName?: string): Promise<ModelsAnswer> {
  if (entry.fields.includes("baseUrl") && !entry.baseUrl.value) {
    throw new HttpError(422, "NEEDS_BASE_URL", t("server_provider_needs_base_url", { name: entry.name }), t("server_provider_needs_base_url_fix"));
  }
  const key = keyName ?? entry.apiKeyEnv.value;
  let keyValue: string | undefined;
  try {
    keyValue = key ? resolveSecret(key)?.value : undefined;
  } catch {
    keyValue = undefined;
  }
  const rules = strictMaskRules();
  const clean = (text: string): string => maskText(keyValue ? text.split(keyValue).join(SECRET_MASK) : text, emptyCounts(rules), rules).replace(/\s+/g, " ").slice(0, 300);
  const userValue = (v: FieldValue): string | undefined => (v.value && v.origin === "user" ? v.value : undefined);
  const baseUrl = userValue(entry.baseUrl);
  const apiKeyEnv = keyName ?? userValue(entry.apiKeyEnv);
  try {
    const lister = await loadModelLister();
    const config: Record<string, unknown> = {
      ...lister.defaultConfig,
      provider: entry.name,
      timeoutMs: TEST_TIMEOUT_MS,
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(entry.model.value ? { model: entry.model.value } : {}),
      ...(entry.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
      ...(entry.kind === "connection" ? { connection: entry.name, headers: entry.headers } : {}),
    };
    const listed = await lister.listProviderModels(config);
    const ids = listed.map((m) => m.id).filter((id): id is string => typeof id === "string").map(clean);
    return {
      name: entry.name,
      kind: entry.kind,
      keyName: key ?? null,
      count: ids.length,
      models: ids.slice(0, MAX_MODELS),
      truncated: ids.length > MAX_MODELS,
      defaultModelListed: entry.model.value ? ids.includes(entry.model.value) : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(502, "PROVIDER_TEST_FAILED", t("server_provider_test_failed", { name: entry.name, detail: clean(message) }), t("server_provider_test_failed_fix"));
  }
}

// ---- schemas -----------------------------------------------------------------------------------------------------------------

const nameParams = {
  type: "object",
  properties: { name: { type: "string", pattern: PROVIDER_NAME_PATTERN } },
  required: ["name"],
  additionalProperties: false,
};
const revision = { anyOf: [{ type: "string", pattern: HASH_PATTERN }, { type: "null" }] };
const nullableText = (max: number) => ({ anyOf: [{ type: "string", maxLength: max }, { type: "null" }] });
const headers = {
  type: "object",
  maxProperties: 20,
  propertyNames: { maxLength: 128 },
  additionalProperties: { type: "string", maxLength: 1024 },
};

const patchBody = {
  type: "object",
  properties: {
    expectedRevision: revision,
    baseUrl: nullableText(2048),
    model: nullableText(200),
    apiKeyEnv: nullableText(128),
    allowInsecureHttp: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    headers: { anyOf: [headers, { type: "null" }] },
  },
  required: ["expectedRevision"],
  additionalProperties: false,
  minProperties: 2,
};

const addBody = {
  type: "object",
  properties: {
    expectedRevision: revision,
    name: { type: "string", minLength: 1, maxLength: 64 },
    type: { enum: [...CONNECTION_TYPES] },
    baseUrl: { type: "string", maxLength: 2048 },
    model: { type: "string", maxLength: 200 },
    apiKeyEnv: { type: "string", maxLength: 128 },
    allowInsecureHttp: { type: "boolean" },
    headers,
  },
  required: ["expectedRevision", "name", "baseUrl"],
  additionalProperties: false,
};

/** What the screen needs to show every provider and connection: values with their origin, the key's state, never a value. */
export function providersView(server: ServerContext): Record<string, unknown> {
  const lock = userSettingsLock(server);
  const listing = providersGuard(() => listProviders());
  return {
    schemaVersion: 1,
    status: "OK",
    writable: lock === null,
    locked: lock,
    governed: lock === "governed" ? { policy: modeOf().governed?.policy ?? "" } : null,
    file: listing.file,
    revision: preferencesRevision(),
    providers: listing.providers,
    problems: listing.problems.map(fieldErrorView),
    reservedNames: RESERVED_NAMES,
    connectionNamePattern: PROVIDER_NAME_PATTERN,
  };
}

function entryOrMissing(name: string): ProviderEntry {
  const entry = providersGuard(() => providerEntry(name));
  if (!entry) throw new HttpError(404, "UNKNOWN_PROVIDER", `name: ${t("server_prov_unknown_provider")}`, t("server_prov_fix"), { errors: [{ field: "name", code: "UNKNOWN_PROVIDER", message: t("server_prov_unknown_provider") }] });
  return entry;
}

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/providers",
    handler({ server }) {
      return { status: 200, json: providersView(server) };
    },
  },
  {
    // Changes the preference of a known provider or of a connection: a value sets the field, null removes it.
    method: "PUT",
    path: "/api/providers/:name",
    params: nameParams,
    body: patchBody,
    maxBody: 32 * 1024,
    handler({ params, body, server }) {
      assertUserSettingsWritable(server);
      const { expectedRevision, ...patch } = body as ProviderPatch & { expectedRevision: string | null };
      checkRevision(expectedRevision);
      const entry = providersGuard(() => setProvider(params.name as string, patch));
      server.log(`provider preference saved: ${entry.name}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", provider: entry, revision: preferencesRevision() } };
    },
  },
  {
    // Adds a named connection of type openai-compatible.
    method: "POST",
    path: "/api/providers",
    body: addBody,
    maxBody: 32 * 1024,
    handler({ body, server }) {
      assertUserSettingsWritable(server);
      const { expectedRevision, name, ...input } = body as { expectedRevision: string | null; name: string; baseUrl: string; type?: string; model?: string; apiKeyEnv?: string; allowInsecureHttp?: boolean; headers?: Record<string, string> };
      checkRevision(expectedRevision);
      const entry = providersGuard(() => addConnection(name, input));
      server.log(`connection added: ${entry.name}`);
      return { status: 201, json: { schemaVersion: 1, status: "OK", provider: entry, revision: preferencesRevision() } };
    },
  },
  {
    // Removes a connection, or the preferences of a known provider (back to its defaults).
    method: "DELETE",
    path: "/api/providers/:name",
    params: nameParams,
    query: { type: "object", properties: { expectedRevision: { type: "string", pattern: "^([0-9a-f]{64}|none)$" } }, additionalProperties: false },
    handler({ params, query, server }) {
      assertUserSettingsWritable(server);
      if (query.expectedRevision !== undefined) checkRevision(query.expectedRevision === "none" ? null : query.expectedRevision);
      const outcome = providersGuard(() => removeProvider(params.name as string));
      server.log(`provider preference removed: ${params.name as string}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", name: params.name, ...outcome, revision: preferencesRevision() } };
    },
  },
  {
    // Testar: the model listing of the provider with its preferences and the key; reads only, so it is allowed in
    // every mode (the model list also feeds the choice of the default model).
    method: "POST",
    path: "/api/providers/:name/test",
    params: nameParams,
    timeoutMs: MODELS_TIMEOUT_MS,
    async handler({ params }) {
      const answer = await listModelsOf(entryOrMissing(params.name as string));
      return { status: 200, json: { schemaVersion: 1, status: "OK", ...answer } };
    },
  },
];
