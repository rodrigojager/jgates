// Preferências > Providers e chaves: the user's key store (D9) through the local server. The store is the file of the
// semantic-gate package (core/secrets), outside every project and outside the JGates data folder.
//
//  - GET lists the known names, the names in the store and the key names the provider preferences use, with state,
//    source (environment, store, none) and date of the last write: never a value, not even a part of it;
//  - PUT writes a value, DELETE removes it, POST .../test lists the provider's models with the key (no token spent);
//  - the answer of a write has the state of the name only: the value is never repeated, and the request body is never
//    logged (the server log has the method, the path and the status);
//  - writing is refused in the governed mode and while a CI policy is edited (providers.ts > assertUserSettingsWritable).
import { listProviders, providerEntry } from "../../core/providers/index.js";
import { knownSecret, listSecrets, secretInfo, SecretsError, setSecret, unsetSecret, vaultPath, resolveSecret, type SecretInfo } from "../../core/secrets/index.js";
import { translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { assertUserSettingsWritable, listModelsOf, MODELS_TIMEOUT_MS, userSettingsLock } from "./providers.js";
import { modeOf } from "../policy-mode.js";

const t = translator("server");

/** The key name pattern of the store (core/secrets SECRET_NAME), with a length limit for the route. */
const NAME_PATTERN = "^[A-Z_][A-Z0-9_]{0,127}$";
/** The longest value the store keeps (core/secrets). */
const MAX_VALUE = 16 * 1024;

const nameParams = {
  type: "object",
  properties: { name: { type: "string", pattern: NAME_PATTERN } },
  required: ["name"],
  additionalProperties: false,
};

const SECRETS_STATUS: Record<SecretsError["code"], number> = {
  INVALID_NAME: 400,
  INVALID_VALUE: 422,
  VAULT_UNREADABLE: 422,
  VAULT_BLOCKED: 403,
  VAULT_WRITE_FAILED: 500,
};

/** Runs an operation of the store; a SecretsError becomes an HttpError with the message of the server catalog. */
function guarded<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof SecretsError) {
      const key = `server_secrets_${error.code.toLowerCase()}`;
      const fix = t(`${key}_fix`);
      throw new HttpError(SECRETS_STATUS[error.code] ?? 422, error.code, t(key, { path: vaultPath() }), fix === `${key}_fix` ? null : fix);
    }
    throw error;
  }
}

/** The providers and connections that use each key name (by the key name of their preferences or default). */
function usersOfKeys(): Map<string, string[]> {
  const users = new Map<string, string[]>();
  let entries: ReturnType<typeof listProviders>["providers"] = [];
  try {
    entries = listProviders().providers;
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const name = entry.apiKeyEnv.value;
    if (!name) continue;
    users.set(name, [...(users.get(name) ?? []), entry.name]);
  }
  return users;
}

/** A name as the screen shows it: the state without any value, who uses it and whether Testar applies. */
function secretView(info: SecretInfo, users: Map<string, string[]>): Record<string, unknown> {
  return { ...info, usedBy: users.get(info.name) ?? [], testable: knownSecret(info.name) !== undefined };
}

function secretsView(server: ServerContext): Record<string, unknown> {
  const lock = userSettingsLock(server);
  const users = usersOfKeys();
  const secrets = guarded(() => listSecrets({ extraNames: [...users.keys()] }));
  return {
    schemaVersion: 1,
    status: "OK",
    writable: lock === null,
    locked: lock,
    governed: lock === "governed" ? { policy: modeOf().governed?.policy ?? "" } : null,
    vault: vaultPath(),
    secrets: secrets.map((info) => secretView(info, users)),
  };
}

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/secrets",
    handler({ server }) {
      return { status: 200, json: secretsView(server) };
    },
  },
  {
    // Writes the value of a name in the store. The answer says whether the environment still wins over it.
    method: "PUT",
    path: "/api/secrets/:name",
    params: nameParams,
    body: {
      type: "object",
      properties: { value: { type: "string", minLength: 1, maxLength: MAX_VALUE } },
      required: ["value"],
      additionalProperties: false,
    },
    maxBody: MAX_VALUE * 6 + 1024,
    handler({ params, body, server }) {
      assertUserSettingsWritable(server);
      const name = params.name as string;
      const info = guarded(() => setSecret(name, (body as { value: string }).value));
      server.log(`secret saved: ${name}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", secret: secretView(info, usersOfKeys()), environmentWins: info.source === "env" } };
    },
  },
  {
    method: "DELETE",
    path: "/api/secrets/:name",
    params: nameParams,
    handler({ params, server }) {
      assertUserSettingsWritable(server);
      const name = params.name as string;
      const outcome = guarded(() => unsetSecret(name));
      server.log(`secret removed: ${name}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", removed: outcome.removed, secret: secretView(outcome.info, usersOfKeys()), environmentWins: outcome.info.source === "env" } };
    },
  },
  {
    // Testar a key of a known provider: the model listing of that provider (with its preferences) and this key.
    method: "POST",
    path: "/api/secrets/:name/test",
    params: nameParams,
    timeoutMs: MODELS_TIMEOUT_MS,
    async handler({ params }) {
      const name = params.name as string;
      const known = knownSecret(name);
      if (!known) throw new HttpError(422, "NOT_TESTABLE", t("server_secrets_not_testable", { name }), t("server_secrets_not_testable_fix"));
      const info = guarded(() => secretInfo(name));
      let resolved: ReturnType<typeof resolveSecret>;
      try {
        resolved = resolveSecret(name);
      } catch {
        resolved = undefined;
      }
      if (!resolved) throw new HttpError(422, "SECRET_NOT_SET", t("server_secrets_not_set", { name }), t("server_secrets_not_set_fix", { name }));
      const entry = providerEntry(known.provider);
      if (!entry) throw new HttpError(422, "NOT_TESTABLE", t("server_secrets_not_testable", { name }), t("server_secrets_not_testable_fix"));
      const answer = await listModelsOf(entry, name);
      return { status: 200, json: { schemaVersion: 1, status: "OK", provider: known.provider, source: info.source, ...answer } };
    },
  },
];
