// jgates secrets list | set <NAME> | unset <NAME> | test <NAME> (D9): the user's key store (core/secrets), outside every
// project. set reads the value from the terminal without echo, or from stdin when it is not a terminal; never from an
// argument (it would stay in the shell history and in the process list). No output carries a value, not even a part of
// it: names, state, source (environment, store, none) and the date of the last write.
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_INTERNAL, EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator, type Params } from "../../i18n/index.js";
import {
  isValidSecretName,
  knownSecret,
  listSecrets,
  resolveSecret,
  SECRET_MASK,
  SecretsError,
  setSecret,
  unsetSecret,
  vaultPath,
  type SecretInfo,
} from "../../core/secrets/index.js";
import { loadModelLister } from "../../adapters/semantic-gate/index.js";
import { maskText, strictMaskRules, emptyCounts } from "../../adapters/semantic-gate/mask.js";

const t = translator("secrets");
const ACTIONS = ["list", "set", "unset", "test"] as const;
type Action = (typeof ACTIONS)[number];
const EXIT_TEST_FAILED = 1;
const EXIT_CANCELLED = 130;
const TEST_TIMEOUT_MS = 30_000;

class Cancelled extends Error {}

/** Reads one line from the terminal without echo (raw mode); Ctrl+C or Ctrl+D on an empty line cancel. */
function readHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  return new Promise((resolve, reject) => {
    let value = "";
    process.stderr.write(prompt);
    const finish = (error: Error | null): void => {
      input.removeListener("data", onData);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish(null);
        if (ch === "\u0003" || (ch === "\u0004" && value === "")) return finish(new Cancelled());
        if (ch === "\u007f" || ch === "\b") {
          value = [...value].slice(0, -1).join("");
          continue;
        }
        if (ch >= " ") value += ch;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

/** Reads the whole of stdin (a pipe or a file), for scripts: `printf %s "$KEY" | jgates secrets set NAME`. */
function readPiped(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const sourceText = (s: SecretInfo): string => (s.source === "env" ? t("secrets_source_env", { name: s.envName ?? s.name }) : s.source === "vault" ? t("secrets_source_vault") : t("secrets_source_none"));
const dateText = (s: SecretInfo): string => (s.updatedAt ? s.updatedAt.replace("T", " ").replace(/\.\d+Z$/, "Z") : "-");

/** The JSON form of a name: never a value. */
const publicInfo = (s: SecretInfo): Record<string, unknown> => ({
  name: s.name,
  provider: s.provider,
  state: s.state,
  source: s.source,
  envName: s.envName,
  inVault: s.inVault,
  updatedAt: s.updatedAt,
  environmentWins: s.source === "env" && s.inVault,
});

function renderList(list: readonly SecretInfo[], file: string): string {
  const width = Math.max(t("secrets_col_name").length, ...list.map((s) => s.name.length));
  const lines = [t("secrets_list_header", { path: file }), ""];
  lines.push(`${t("secrets_col_name").padEnd(width)}  ${t("secrets_col_state").padEnd(8)}  ${t("secrets_col_value").padEnd(8)}  ${t("secrets_col_updated").padEnd(20)}  ${t("secrets_col_source")}`);
  for (const s of list) {
    lines.push(`${s.name.padEnd(width)}  ${(s.state === "set" ? t("secrets_state_set") : t("secrets_state_unset")).padEnd(8)}  ${(s.state === "set" ? SECRET_MASK : "-").padEnd(8)}  ${dateText(s).padEnd(20)}  ${sourceText(s)}`);
    if (s.source === "env" && s.inVault) lines.push(`${" ".repeat(width + 2)}${t("secrets_env_wins", { name: s.envName ?? s.name })}`);
  }
  return `${lines.join("\n")}\n`;
}

export const command: CommandModule = {
  name: "secrets",
  description: t("secrets_cmd_description"),
  options: [],
  async run(ctx: CommandContext) {
    const header = (action: Action): Record<string, unknown> => ({ schemaVersion: 1, tool: "jgates", version: ctx.version, command: `secrets ${action}` });
    const fail = (code: string, key: string, params: Params = {}, exitCode = EXIT_USAGE, fixKey = `${key}_fix`): number => reportError(ctx, ctx.json, code, t(key, params), t(fixKey, params), exitCode);
    const fromError = (error: unknown): number => {
      if (!(error instanceof SecretsError)) throw error;
      const exit = error.code === "VAULT_WRITE_FAILED" ? EXIT_INTERNAL : EXIT_USAGE;
      return reportError(ctx, ctx.json, error.code, t("secrets_store_error", { detail: error.message }), t(`secrets_fix_${error.code.toLowerCase()}`), exit);
    };

    const [action, name, ...extra] = ctx.args;
    if (!ACTIONS.includes(action as Action)) return fail("UNKNOWN_ACTION", "secrets_unknown_action", { name: action ?? "" });
    const env = process.env;
    const file = vaultPath(env);

    if (action === "list") {
      if (name !== undefined) return fail("UNEXPECTED_ARGUMENT", "secrets_unexpected_argument", { name });
      let list: SecretInfo[];
      try {
        list = listSecrets({ env });
      } catch (error) {
        return fromError(error);
      }
      if (ctx.json) writeJson(ctx, { ...header("list"), status: "OK", exitCode: 0, vault: file, secrets: list.map(publicInfo) });
      else ctx.stdout(renderList(list, file));
      return 0;
    }

    if (name === undefined) return fail("MISSING_NAME", "secrets_missing_name", { action: action as string });
    if (!isValidSecretName(name)) return fail("INVALID_NAME", "secrets_invalid_name", {});
    // A value given as an argument is refused before anything else, and is never repeated in the message.
    if (extra.length > 0) return fail(action === "set" ? "VALUE_AS_ARGUMENT" : "UNEXPECTED_ARGUMENT", action === "set" ? "secrets_value_as_argument" : "secrets_unexpected_argument", { name: action === "set" ? name : extra[0] ?? "" });

    if (action === "set") {
      let value: string;
      try {
        value = process.stdin.isTTY ? await readHidden(t("secrets_prompt", { name })) : await readPiped();
      } catch (error) {
        if (error instanceof Cancelled) return fail("CANCELLED", "secrets_cancelled", {}, EXIT_CANCELLED);
        throw error;
      }
      let info: SecretInfo;
      try {
        info = setSecret(name, value, { env });
      } catch (error) {
        return fromError(error);
      }
      const environmentWins = info.source === "env";
      if (ctx.json) writeJson(ctx, { ...header("set"), status: "OK", exitCode: 0, vault: file, secret: publicInfo(info) });
      else {
        ctx.stdout(`${t("secrets_set_done", { name, path: file })}\n`);
        if (environmentWins) ctx.stderr(`${t("secrets_env_wins", { name: info.envName ?? name })}\n`);
      }
      return 0;
    }

    if (action === "unset") {
      let outcome: { removed: boolean; info: SecretInfo };
      try {
        outcome = unsetSecret(name, { env });
      } catch (error) {
        return fromError(error);
      }
      if (ctx.json) writeJson(ctx, { ...header("unset"), status: "OK", exitCode: 0, vault: file, removed: outcome.removed, secret: publicInfo(outcome.info) });
      else {
        ctx.stdout(`${t(outcome.removed ? "secrets_unset_done" : "secrets_unset_absent", { name, path: file })}\n`);
        if (outcome.info.source === "env") ctx.stderr(`${t("secrets_unset_env_still", { name: outcome.info.envName ?? name })}\n`);
      }
      return 0;
    }

    // test: lists the provider's models with the key (no prompt is sent, no token is spent).
    const known = knownSecret(name);
    if (!known) return fail("NOT_TESTABLE", "secrets_not_testable", { name });
    let resolved: ReturnType<typeof resolveSecret>;
    try {
      resolved = resolveSecret(name, { env });
    } catch (error) {
      return fromError(error);
    }
    if (!resolved) return fail("SECRET_NOT_SET", "secrets_not_set", { name });
    const baseUrl = env.SEMANTIC_GATE_BASE_URL;
    if (known.provider === "openai-compatible" && !baseUrl) return fail("NEEDS_BASE_URL", "secrets_needs_base_url", { name });
    const secretValue = resolved.value;
    // Whatever the provider answers, the message shown has neither the value nor anything shaped like a credential.
    const clean = (text: string): string => maskText(text.split(secretValue).join(SECRET_MASK), emptyCounts(strictMaskRules()), strictMaskRules()).replace(/\s+/g, " ").slice(0, 300);
    try {
      const lister = await loadModelLister(env);
      const config = { ...lister.defaultConfig, provider: known.provider, apiKeyEnv: name, timeoutMs: TEST_TIMEOUT_MS, ...(baseUrl ? { baseUrl } : {}) };
      const models = await lister.listProviderModels(config);
      const ids = models.map((m) => m.id).filter((id) => typeof id === "string");
      if (ctx.json) writeJson(ctx, { ...header("test"), status: "OK", exitCode: 0, name, provider: known.provider, source: resolved.source, models: ids.length, sample: ids.slice(0, 10).map(clean) });
      else ctx.stdout(`${t("secrets_test_ok", { name, provider: known.provider, count: ids.length, source: resolved.source === "env" ? t("secrets_source_env", { name }) : t("secrets_source_vault") })}\n${ids.slice(0, 10).map((id) => `  ${clean(id)}`).join("\n")}${ids.length > 0 ? "\n" : ""}`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail("TEST_FAILED", "secrets_test_failed", { name, provider: known.provider, detail: clean(message) }, EXIT_TEST_FAILED);
    }
  },
};
