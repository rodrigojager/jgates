// jgates providers list | set <provider|connection> | add <name> | remove <name> | test <provider|connection> (D10):
// the user's provider preferences (core/providers), outside every project, in the global config.json of the
// semantic-gate package next to the key store. Per known provider: base URL, default model and key name; named
// connections of type openai-compatible (a gateway) with base URL, key name, default model and extra headers that
// carry no secret. A project uses a connection with `provider: <name>`. The key itself is never here (jgates secrets).
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_INTERNAL, EXIT_USAGE, errorPayload, reportError, writeJson } from "../output.js";
import { translator, type Params } from "../../i18n/index.js";
import {
  addConnection,
  listProviders,
  providerEntry,
  ProvidersError,
  removeProvider,
  setProvider,
  type FieldError,
  type FieldValue,
  type ProviderEntry,
  type ProviderPatch,
} from "../../core/providers/index.js";
import { resolveSecret, SECRET_MASK } from "../../core/secrets/index.js";
import { loadModelLister } from "../../adapters/semantic-gate/index.js";
import { emptyCounts, maskText, strictMaskRules } from "../../adapters/semantic-gate/mask.js";

const t = translator("providers");
const ACTIONS = ["list", "set", "add", "remove", "test"] as const;
type Action = (typeof ACTIONS)[number];
const EXIT_TEST_FAILED = 1;
const TEST_TIMEOUT_MS = 30_000;

/** --header Name=Value or Name: Value; an empty value clears the headers. */
function parseHeaders(values: readonly string[]): { headers: Record<string, string> | null } | { bad: string } {
  const headers: Record<string, string> = {};
  for (const raw of values) {
    if (raw.trim() === "") return { headers: null };
    const at = raw.search(/[=:]/);
    if (at <= 0) return { bad: raw.split(/[=:]/)[0] ?? "" };
    headers[raw.slice(0, at).trim()] = raw.slice(at + 1).trim();
  }
  return { headers };
}

const originText = (v: FieldValue): string => t(`providers_origin_${v.origin}`);
const valueText = (v: FieldValue): string => v.value ?? "-";

/** The JSON form of an entry: values and origins, the key's name and state; never a key value. */
const publicEntry = (e: ProviderEntry): Record<string, unknown> => ({ ...e });

function renderEntry(e: ProviderEntry): string {
  const lines = [e.kind === "connection" ? t("providers_entry_connection", { name: e.name, type: e.type }) : t("providers_entry_provider", { name: e.name, type: e.type })];
  const row = (label: string, v: FieldValue): void => {
    lines.push(`  ${label.padEnd(10)}  ${valueText(v).padEnd(40)}  ${originText(v)}`);
  };
  if (e.fields.includes("baseUrl")) row(t("providers_field_base_url"), e.baseUrl);
  row(t("providers_field_model"), e.model);
  if (e.fields.includes("apiKeyEnv") && e.apiKeyEnv.value) {
    const key = e.key;
    const state = !key ? "-" : key.state === "set" ? `${SECRET_MASK} ${t(`providers_key_source_${key.source}`)}` : key.state === "unset" ? t("providers_key_unset", { name: key.name }) : t("providers_key_unknown");
    lines.push(`  ${t("providers_field_key").padEnd(10)}  ${valueText(e.apiKeyEnv).padEnd(40)}  ${originText(e.apiKeyEnv)}; ${state}`);
  }
  const names = Object.keys(e.headers);
  if (names.length > 0) lines.push(`  ${t("providers_field_headers").padEnd(10)}  ${names.map((n) => `${n}=${e.headers[n]}`).join(", ")}`);
  if (e.allowInsecureHttp) lines.push(`  ${t("providers_insecure_http_confirmed")}`);
  return lines.join("\n");
}

export const command: CommandModule = {
  name: "providers",
  description: t("providers_cmd_description"),
  options: [
    { name: "base-url", type: "string", description: t("providers_option_base_url") },
    { name: "model", type: "string", description: t("providers_option_model") },
    { name: "key-env", type: "string", description: t("providers_option_key_env") },
    { name: "header", type: "string", description: t("providers_option_header") },
    { name: "allow-http", type: "boolean", description: t("providers_option_allow_http") },
  ],
  async run(ctx: CommandContext) {
    const header = (action: Action): Record<string, unknown> => ({ schemaVersion: 1, tool: "jgates", version: ctx.version, command: `providers ${action}` });
    const fail = (code: string, key: string, params: Params = {}, exitCode = EXIT_USAGE, fixKey = `${key}_fix`): number => reportError(ctx, ctx.json, code, t(key, params), t(fixKey, params), exitCode);
    const fieldText = (e: FieldError): string => t("providers_field_error", { field: e.field, reason: t(`providers_err_${e.code.toLowerCase()}`) });
    const fromError = (error: unknown): number => {
      if (!(error instanceof ProvidersError)) throw error;
      const exit = error.code === "PREFERENCES_WRITE_FAILED" ? EXIT_INTERNAL : EXIT_USAGE;
      const message = error.errors.map(fieldText).join("\n");
      const fix = t(`providers_fix_${error.code.toLowerCase()}`, {});
      if (ctx.json) writeJson(ctx, { ...errorPayload(error.code, message, fix, exit), errors: error.errors.map((e) => ({ field: e.field, code: e.code, message: fieldText(e) })) });
      else ctx.stderr(`ERROR ${error.code}\n${message}\n${fix}\n`);
      return exit;
    };

    const [action, name, ...extra] = ctx.args;
    if (!ACTIONS.includes(action as Action)) return fail("UNKNOWN_ACTION", "providers_unknown_action", { name: action ?? "" });
    const env = process.env;
    const flags = ["base-url", "model", "key-env", "header", "allow-http"].filter((f) => ctx.options[f] !== undefined);

    if (action === "list") {
      if (name !== undefined) return fail("UNEXPECTED_ARGUMENT", "providers_unexpected_argument", { name });
      if (flags.length > 0) return fail("UNEXPECTED_OPTION", "providers_unexpected_option", { name: `--${flags[0]}`, action });
      let listing: ReturnType<typeof listProviders>;
      try {
        listing = listProviders({ env });
      } catch (error) {
        return fromError(error);
      }
      if (ctx.json) writeJson(ctx, { ...header("list"), status: "OK", exitCode: 0, file: listing.file, providers: listing.providers.map(publicEntry), problems: listing.problems.map((e) => ({ field: e.field, code: e.code, message: fieldText(e) })) });
      else {
        const out = [t("providers_list_header", { path: listing.file }), "", listing.providers.map(renderEntry).join("\n\n")];
        if (listing.problems.length > 0) out.push("", t("providers_list_problems"), ...listing.problems.map((e) => `  ${fieldText(e)}`));
        ctx.stdout(`${out.join("\n")}\n`);
      }
      return 0;
    }

    if (name === undefined) return fail("MISSING_NAME", "providers_missing_name", { action: action as string });
    if (extra.length > 0) return fail("UNEXPECTED_ARGUMENT", "providers_unexpected_argument", { name: extra[0] ?? "" });
    const str = (flag: string): string | undefined => (typeof ctx.options[flag] === "string" ? (ctx.options[flag] as string) : undefined);
    let headers: Record<string, string> | null | undefined;
    if (ctx.lists.header && ctx.lists.header.length > 0) {
      const parsed = parseHeaders(ctx.lists.header);
      if ("bad" in parsed) return fail("INVALID_HEADER", "providers_invalid_header", { name: parsed.bad });
      headers = parsed.headers;
    }

    if (action === "set") {
      if (flags.length === 0) return fail("NOTHING_TO_SET", "providers_nothing_to_set", { name });
      const patch: ProviderPatch = {};
      const baseUrl = str("base-url");
      const model = str("model");
      const keyEnv = str("key-env");
      // An empty value removes the field (back to the provider's default).
      if (baseUrl !== undefined) patch.baseUrl = baseUrl === "" ? null : baseUrl;
      if (model !== undefined) patch.model = model === "" ? null : model;
      if (keyEnv !== undefined) patch.apiKeyEnv = keyEnv === "" ? null : keyEnv;
      if (ctx.options["allow-http"] === true) patch.allowInsecureHttp = true;
      if (headers !== undefined) patch.headers = headers;
      let entry: ProviderEntry;
      try {
        entry = setProvider(name, patch, { env });
      } catch (error) {
        return fromError(error);
      }
      if (ctx.json) writeJson(ctx, { ...header("set"), status: "OK", exitCode: 0, provider: publicEntry(entry) });
      else ctx.stdout(`${t("providers_set_done", { name: entry.name })}\n${renderEntry(entry)}\n`);
      return 0;
    }

    if (action === "add") {
      const baseUrl = str("base-url");
      if (baseUrl === undefined || baseUrl === "") return fail("MISSING_BASE_URL", "providers_add_needs_base_url", { name });
      let entry: ProviderEntry;
      try {
        const model = str("model");
        const keyEnv = str("key-env");
        entry = addConnection(
          name,
          {
            baseUrl,
            ...(model ? { model } : {}),
            ...(keyEnv ? { apiKeyEnv: keyEnv } : {}),
            ...(headers ? { headers } : {}),
            ...(ctx.options["allow-http"] === true ? { allowInsecureHttp: true } : {}),
          },
          { env },
        );
      } catch (error) {
        return fromError(error);
      }
      if (ctx.json) writeJson(ctx, { ...header("add"), status: "OK", exitCode: 0, provider: publicEntry(entry) });
      else ctx.stdout(`${t("providers_add_done", { name: entry.name, key: entry.apiKeyEnv.value ?? "-" })}\n${renderEntry(entry)}\n`);
      return 0;
    }

    if (flags.length > 0) return fail("UNEXPECTED_OPTION", "providers_unexpected_option", { name: `--${flags[0]}`, action: action as string });

    if (action === "remove") {
      let outcome: ReturnType<typeof removeProvider>;
      try {
        outcome = removeProvider(name, { env });
      } catch (error) {
        return fromError(error);
      }
      if (ctx.json) writeJson(ctx, { ...header("remove"), status: "OK", exitCode: 0, name, kind: outcome.kind, removed: outcome.removed });
      else ctx.stdout(`${t(outcome.kind === "connection" ? "providers_remove_connection_done" : outcome.removed ? "providers_remove_provider_done" : "providers_remove_provider_absent", { name })}\n`);
      return 0;
    }

    // test: lists the models with the settings of the preferences and the key (no prompt is sent, no token is spent).
    let entry: ProviderEntry | undefined;
    try {
      entry = providerEntry(name, { env });
    } catch (error) {
      return fromError(error);
    }
    if (!entry) return fail("UNKNOWN_PROVIDER", "providers_unknown_provider", { name });
    if (entry.fields.includes("baseUrl") && !entry.baseUrl.value) return fail("NEEDS_BASE_URL", "providers_test_needs_base_url", { name: entry.name });
    let keyValue: string | undefined;
    try {
      keyValue = entry.apiKeyEnv.value ? resolveSecret(entry.apiKeyEnv.value, { env })?.value : undefined;
    } catch {
      keyValue = undefined;
    }
    // Whatever the provider answers, the text shown has neither the key nor anything shaped like a credential.
    const clean = (text: string): string => maskText(keyValue ? text.split(keyValue).join(SECRET_MASK) : text, emptyCounts(strictMaskRules()), strictMaskRules()).replace(/\s+/g, " ").slice(0, 300);
    const userValue = (v: FieldValue): string | undefined => (v.value && v.origin === "user" ? v.value : undefined);
    try {
      const lister = await loadModelLister(env);
      const baseUrl = userValue(entry.baseUrl);
      const apiKeyEnv = userValue(entry.apiKeyEnv);
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
      const models = await lister.listProviderModels(config);
      const ids = models.map((m) => m.id).filter((id) => typeof id === "string");
      const listedModel = entry.model.value ? ids.includes(entry.model.value) : null;
      if (ctx.json) writeJson(ctx, { ...header("test"), status: "OK", exitCode: 0, name: entry.name, kind: entry.kind, models: ids.length, sample: ids.slice(0, 10).map(clean), defaultModelListed: listedModel });
      else {
        const lines = [t("providers_test_ok", { name: entry.name, count: ids.length }), ...ids.slice(0, 10).map((id) => `  ${clean(id)}`)];
        if (listedModel === false) lines.push(t("providers_test_model_missing", { model: entry.model.value ?? "" }));
        ctx.stdout(`${lines.join("\n")}\n`);
      }
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail("TEST_FAILED", "providers_test_failed", { name: entry.name, detail: clean(message) }, EXIT_TEST_FAILED);
    }
  },
};
