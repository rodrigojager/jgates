import type { Translator } from "../i18n/index.js";

export interface OptionSpec {
  /** Long name without the dashes, for example "json". */
  name: string;
  type: "boolean" | "string";
  /** Message key in the "cli" catalog, or plain text. */
  description: string;
}

export interface CommandInfo {
  name: string;
  /** Message key in the "cli" catalog, or plain text. */
  description: string;
  options: OptionSpec[];
}

export interface CommandContext {
  /** Positional arguments after the command name. */
  args: string[];
  options: Record<string, string | boolean>;
  /** Every value of each string option, in order (repeatable flags such as --skip); `options` holds the last one. */
  lists: Record<string, string[]>;
  json: boolean;
  version: string;
  /** Every loaded command (used by help). */
  commands: CommandInfo[];
  /** Translator of the "cli" area; commands may build their own with translator(area). */
  t: Translator;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/**
 * Shape of a command module. Each file in src/cli/commands/ exports one `command`.
 * `run` returns the process exit code.
 */
export interface CommandModule extends CommandInfo {
  run(context: CommandContext): number | Promise<number>;
}
