#!/usr/bin/env node
import { normalizeLocale, setLocale, translator } from "../i18n/index.js";
import { localeFromArgv, parseArgs, wantsJson } from "./args.js";
import type { CommandContext } from "./command.js";
import { loadCommands, defaultCommandsDir } from "./loader.js";
import { EXIT_INTERNAL, EXIT_USAGE, reportError, writeJson, type Sink } from "./output.js";
import { readVersion } from "./version.js";

const sink: Sink = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

export async function main(argv: string[]): Promise<number> {
  const json = wantsJson(argv);
  const t = translator("cli");
  // The language of the human text: --locale wins over JGATES_LOCALE (read at start-up) over the default. The JSON
  // documents keep ids, codes and enums in every language; only the message and fix texts change.
  const requested = localeFromArgv(argv);
  const locale = normalizeLocale(requested);
  if (locale) setLocale(locale);
  try {
    if (requested !== undefined && !locale) {
      return reportError(sink, json, "BAD_LOCALE", t("bad_locale", { value: requested }), t("bad_locale_fix"), EXIT_USAGE);
    }
    // JGATES_EXTRA_COMMANDS_DIR adds one more folder of command modules (used by tests).
    const extra = process.env.JGATES_EXTRA_COMMANDS_DIR;
    const modules = await loadCommands(extra ? [defaultCommandsDir(), extra] : [defaultCommandsDir()]);
    const parsed = parseArgs(argv, (name) => modules.find((m) => m.name === name)?.options ?? []);
    const version = readVersion();

    if (parsed.problem) {
      const { kind, name } = parsed.problem;
      return reportError(sink, json, kind.toUpperCase(), t(kind, { name }), t(`${kind}_fix`, { name }), EXIT_USAGE);
    }
    if (parsed.options.version) {
      if (json) writeJson(sink, { schemaVersion: 1, status: "OK", version });
      else sink.stdout(`jgates ${version}\n`);
      return 0;
    }
    const name = parsed.options.help || parsed.command === null ? "help" : parsed.command;
    const target = modules.find((m) => m.name === name);
    if (!target) {
      return reportError(sink, json, "UNKNOWN_COMMAND", t("unknown_command", { name }), t("unknown_command_fix"), EXIT_USAGE);
    }
    const context: CommandContext = {
      args: parsed.args,
      options: parsed.options,
      lists: parsed.lists,
      json,
      version,
      commands: modules.map(({ name, description, options }) => ({ name, description, options })),
      t,
      ...sink,
    };
    return await target.run(context);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return reportError(sink, json, "INTERNAL_ERROR", t("internal_error", { detail }), t("internal_error_fix"), EXIT_INTERNAL);
  }
}

process.exitCode = await main(process.argv.slice(2));
