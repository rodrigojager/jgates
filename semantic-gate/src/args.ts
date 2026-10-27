import { SemanticGateError } from "./errors.js";
import type { CliOptions, ParsedCli } from "./types.js";

const booleanFlags = new Set([
  "json",
  "ci",
  "objective-stdin",
  "include-untracked",
  "no-include-untracked",
  "write-reports",
  "no-write-reports",
  "project",
  "global",
  "help",
  "key-stdin",
  "verify",
  "no-verify",
  "codex-bypass-sandbox",
  "no-codex-bypass-sandbox",
  "codex-skip-git-repo-check",
  "no-codex-skip-git-repo-check",
  "force",
]);

const keyMap: Record<string, string> = {
  "objective-file": "objectiveFile",
  "objective-stdin": "objectiveStdin",
  "include-untracked": "includeUntracked",
  "no-include-untracked": "includeUntracked",
  "max-context-chars": "maxContextChars",
  "max-file-chars": "maxFileChars",
  "max-diff-chars": "maxDiffChars",
  "context-strategy": "contextStrategy",
  "output-dir": "outputDir",
  "write-reports": "writeReports",
  "no-write-reports": "writeReports",
  "timeout-ms": "timeoutMs",
  "base-url": "baseUrl",
  "api-key-env": "apiKeyEnv",
  "api-key-provider": "apiKeyProvider",
  "reasoning-effort": "reasoningEffort",
  "codex-sandbox": "codexSandbox",
  "codex-bypass-sandbox": "codexBypassSandbox",
  "no-codex-bypass-sandbox": "codexBypassSandbox",
  "codex-skip-git-repo-check": "codexSkipGitRepoCheck",
  "no-codex-skip-git-repo-check": "codexSkipGitRepoCheck",
  "key-stdin": "keyStdin",
  "command-args": "commandArgs",
  "model-list-command": "modelListCommand",
  "model-list-args": "modelListArgs",
  "command-prompt-mode": "commandPromptMode",
  "command-output": "commandOutput",
  "ignore-file": "ignoreFiles",
};

const arrayFlags: Record<string, string> = {
  path: "paths",
  exclude: "excludes",
  include: "includes",
  "ignore-file": "ignoreFiles",
};

export function parseCli(argv: string[]): ParsedCli {
  const [rawCommand, ...rest] = argv;
  const command = normalizeCommand(rawCommand);
  const options: CliOptions = {};
  const positional: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) {
      continue;
    }
    if (token === "--") {
      positional.push(...rest.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    const flag = eqIndex >= 0 ? withoutPrefix.slice(0, eqIndex) : withoutPrefix;
    const explicitValue = eqIndex >= 0 ? withoutPrefix.slice(eqIndex + 1) : undefined;
    const key = keyMap[flag] ?? flag;

    if (arrayFlags[flag]) {
      const value = explicitValue ?? rest[index + 1];
      if (value === undefined) {
        throw new SemanticGateError(`Missing value for --${flag}.`, "usage");
      }
      if (explicitValue === undefined) {
        index += 1;
      }
      const arrayKey = arrayFlags[flag]!;
      const existing = options[arrayKey];
      options[arrayKey] = [...(Array.isArray(existing) ? existing : []), String(value)];
      continue;
    }

    if (flag.startsWith("no-")) {
      options[key] = false;
      continue;
    }

    if (booleanFlags.has(flag)) {
      options[key] = explicitValue === undefined ? true : parseScalar(explicitValue);
      continue;
    }

    const value = explicitValue ?? rest[index + 1];
    if (value === undefined) {
      throw new SemanticGateError(`Missing value for --${flag}.`, "usage");
    }
    if (explicitValue === undefined) {
      index += 1;
    }
    options[key] = parseScalar(value);
  }

  if (command === "config" || command === "auth" || command === "models") {
    const [subcommand, ...remaining] = positional;
    if (!subcommand) {
      throw new SemanticGateError(`Missing ${command} subcommand.`, "usage");
    }
    return { command, subcommand, positional: remaining, options };
  }

  return { command, positional, options };
}

function normalizeCommand(rawCommand: string | undefined): ParsedCli["command"] {
  if (!rawCommand || rawCommand === "help" || rawCommand === "--help" || rawCommand === "-h") {
    return "help";
  }
  if (rawCommand === "--version" || rawCommand === "-v" || rawCommand === "version") {
    return "version";
  }
  if (
    rawCommand === "run" ||
    rawCommand === "init" ||
    rawCommand === "config" ||
    rawCommand === "setup" ||
    rawCommand === "status" ||
    rawCommand === "prompts"
  ) {
    return rawCommand;
  }
  if (rawCommand === "auth" || rawCommand === "models") {
    return rawCommand;
  }
  throw new SemanticGateError(`Unknown command: ${rawCommand}`, "usage");
}

export function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    return JSON.parse(trimmed);
  }
  return value;
}
