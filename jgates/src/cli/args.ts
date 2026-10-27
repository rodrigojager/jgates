import type { OptionSpec } from "./command.js";

export interface Parsed {
  command: string | null;
  args: string[];
  options: Record<string, string | boolean>;
  /**
   * Every value of each string option, in command line order. `options` keeps the last one (the behaviour of the
   * commands that take a single value); a repeatable option such as --skip reads all of them here.
   */
  lists: Record<string, string[]>;
  /** Set when the command line is invalid. */
  problem: { kind: "unknown_flag" | "missing_value" | "unexpected_value"; name: string } | null;
}

export const GLOBAL_OPTIONS: OptionSpec[] = [
  { name: "json", type: "boolean", description: "global_option_json" },
  { name: "version", type: "boolean", description: "global_option_version" },
  { name: "help", type: "boolean", description: "global_option_help" },
  { name: "locale", type: "string", description: "global_option_locale" },
];

/** Cheap pre-scan of --locale <value> / --locale=<value>, so even a usage error is written in the chosen language. */
export function localeFromArgv(argv: string[]): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--locale") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) found = next;
    } else if (token.startsWith("--locale=")) found = token.slice("--locale=".length);
  }
  return found;
}

/** Cheap pre-scan: --json must shape errors even when the rest of the line is invalid. */
export function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

export function parseArgs(argv: string[], specsFor: (command: string | null) => OptionSpec[]): Parsed {
  const out: Parsed = { command: null, args: [], options: {}, lists: {}, problem: null };
  const keep = (name: string, value: string): void => {
    out.options[name] = value;
    (out.lists[name] ??= []).push(value);
  };
  const first = argv.find((a) => !a.startsWith("-"));
  out.command = first ?? null;
  const specs = [...GLOBAL_OPTIONS, ...specsFor(out.command)];
  let commandSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "-v") {
      out.options.version = true;
      continue;
    }
    if (token === "-h") {
      out.options.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      if (!commandSeen && token === first) commandSeen = true;
      else out.args.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const spec = specs.find((s) => s.name === name);
    if (!spec) {
      out.problem ??= { kind: "unknown_flag", name: `--${name}` };
      continue;
    }
    if (spec.type === "boolean") {
      if (eq !== -1) out.problem ??= { kind: "unexpected_value", name: `--${name}` };
      else out.options[name] = true;
      continue;
    }
    if (eq !== -1) keep(name, token.slice(eq + 1));
    else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out.problem ??= { kind: "missing_value", name: `--${name}` };
      else {
        keep(name, next);
        i++;
      }
    }
  }
  return out;
}
