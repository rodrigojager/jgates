import readline from "node:readline";
import { Writable } from "node:stream";
import { setStoredApiKey } from "./credentials.js";
import { listProviderModels } from "./providers.js";
import { writeConfigValue } from "./config.js";
import type { CliOptions, SemanticGateConfig } from "./types.js";

interface Choice {
  label: string;
  value: string;
  description?: string;
}

interface SetupProvider extends Choice {
  kind: "api" | "local" | "cli" | "custom";
  needsKey: boolean;
  needsModel: boolean;
  needsBaseUrl?: boolean;
  needsCommand?: boolean;
}

const providers: SetupProvider[] = [
  {
    label: "OpenRouter",
    value: "openrouter",
    kind: "api",
    needsKey: true,
    needsModel: true,
    description: "Remote OpenAI-compatible router with many hosted models.",
  },
  {
    label: "OpenAI API",
    value: "openai",
    kind: "api",
    needsKey: true,
    needsModel: true,
    description: "Official OpenAI API.",
  },
  {
    label: "Anthropic Claude API",
    value: "anthropic",
    kind: "api",
    needsKey: true,
    needsModel: true,
    description: "Official Anthropic Messages API.",
  },
  {
    label: "Gemini API",
    value: "gemini",
    kind: "api",
    needsKey: true,
    needsModel: true,
    description: "Google Gemini API.",
  },
  {
    label: "Ollama Local",
    value: "ollama",
    kind: "local",
    needsKey: false,
    needsModel: true,
    needsBaseUrl: true,
    description: "Local Ollama server, default http://127.0.0.1:11434.",
  },
  {
    label: "OpenCode API",
    value: "opencode-api",
    kind: "custom",
    needsKey: true,
    needsModel: true,
    needsBaseUrl: true,
    description: "OpenCode Zen chat completions endpoint (base URL https://opencode.ai/inference/openai/v1) with OPENCODE_API_KEY.",
  },
  {
    label: "OpenAI-compatible API",
    value: "openai-compatible",
    kind: "custom",
    needsKey: true,
    needsModel: true,
    needsBaseUrl: true,
    description: "Any /chat/completions endpoint, such as a LiteLLM proxy or another gateway, with a custom API key environment variable.",
  },
  {
    label: "Codex CLI",
    value: "codex-cli",
    kind: "cli",
    needsKey: false,
    needsModel: true,
    description: "Uses local `codex exec` preset (Codex CLI 0.122.0 or newer).",
  },
  {
    label: "Claude Code",
    value: "claude-code",
    kind: "cli",
    needsKey: false,
    needsModel: false,
    description: "Uses local `claude --print` preset with every tool off (Claude Code 2.1.0 or newer).",
  },
  {
    label: "Gemini CLI",
    value: "gemini-cli",
    kind: "cli",
    needsKey: false,
    needsModel: false,
    description: "Uses local headless `gemini` preset, prompt on stdin (Gemini CLI 0.30.0 or newer).",
  },
  {
    label: "OpenCode CLI",
    value: "opencode",
    kind: "cli",
    needsKey: false,
    needsModel: true,
    description: "Uses local `opencode run` preset with a read-only agent (OpenCode 1.2.0 or newer).",
  },
  {
    label: "Custom Command",
    value: "command",
    kind: "cli",
    needsKey: false,
    needsModel: false,
    needsCommand: true,
    description: "Any local AI CLI that accepts prompt by stdin or argument.",
  },
];

export async function runSetupWizard(
  cwd: string,
  options: CliOptions,
  existingConfig: SemanticGateConfig,
): Promise<void> {
  const scope =
    options.project || options.global
      ? options.project
        ? "project"
        : "global"
      : ((await selectChoice("Where should semantic-gate save this configuration?", [
          { label: "Global user config", value: "global", description: "Recommended for personal provider/model defaults." },
          { label: "Project config", value: "project", description: "Use for repository-specific non-secret settings." },
        ], undefined, selectionFooter(existingConfig.provider, existingConfig.model))) as "global" | "project");

  const provider = (await selectChoice(
    "Choose AI provider or local CLI",
    providers.map(({ label, value, description }) => {
      const choice: Choice = { label, value };
      if (description !== undefined) {
        choice.description = description;
      }
      return choice;
    }),
    existingConfig.provider,
    selectionFooter(existingConfig.provider, existingConfig.model),
  )) as string;
  const providerSpec = providers.find((item) => item.value === provider)!;

  const values: Record<string, unknown> = { provider };

  if (providerSpec.needsBaseUrl) {
    const defaultBase =
      provider === "ollama"
        ? existingConfig.baseUrl ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434"
        : existingConfig.baseUrl ?? "";
    values.baseUrl = await promptText("Base URL", defaultBase);
  }

  if (providerSpec.needsKey) {
    const keyAction = await selectChoice("API key", [
      { label: "Keep using env var or existing stored key", value: "keep" },
      { label: "Paste and save key to user-local secret store", value: "save" },
      { label: "Use a custom environment variable name", value: "env" },
    ], undefined, selectionFooter(provider, existingConfig.model));
    if (keyAction === "save") {
      const secret = await promptSecret(`Paste API key for ${provider}`);
      if (secret.trim()) {
        setStoredApiKey(provider, secret);
      }
    } else if (keyAction === "env") {
      values.apiKeyEnv = await promptText("Environment variable name", existingConfig.apiKeyEnv ?? "");
    }
  }

  if (providerSpec.needsCommand) {
    values.command = await promptText("Command", existingConfig.command ?? provider);
    const currentArgs = existingConfig.commandArgs ? JSON.stringify(existingConfig.commandArgs) : "";
    const commandArgs = await promptText("Command args as JSON array or space-separated string", currentArgs);
    if (commandArgs.trim()) {
      values.commandArgs = parseArgsValue(commandArgs);
    }
    values.commandPromptMode = await selectChoice("Prompt delivery mode", [
      { label: "stdin", value: "stdin" },
      { label: "argument placeholder {prompt}", value: "argument" },
    ], existingConfig.commandPromptMode, selectionFooter(provider, existingConfig.model));
  }

  const model = await chooseModel(provider, providerSpec, { ...existingConfig, ...values } as SemanticGateConfig);
  if (model) {
    values.model = model;
  }

  values.threshold = await promptNumber("Approval threshold", existingConfig.threshold);
  values.contextStrategy = await selectChoice("Context strategy", [
    { label: "auto", value: "auto", description: "Use one request when possible, chunk only when needed." },
    { label: "single", value: "single", description: "Fail if context exceeds limit." },
    { label: "chunked", value: "chunked", description: "Always split large reviews into chunks." },
  ], existingConfig.contextStrategy, selectionFooter(provider, typeof values.model === "string" ? values.model : existingConfig.model));
  values.maxContextChars = await promptNumber("Max context characters", existingConfig.maxContextChars);
  values.includeUntracked = await confirm("Include untracked files?", existingConfig.includeUntracked);
  values.writeReports = await confirm("Write reports to .quality/semantic-gate?", existingConfig.writeReports);

  for (const [key, value] of Object.entries(values)) {
    writeConfigValue(cwd, scope, key, value);
  }

  process.stdout.write(`\nSaved semantic-gate ${scope} configuration.\n`);
  process.stdout.write(`Provider: ${provider}\n`);
  if (values.model) {
    process.stdout.write(`Model: ${values.model}\n`);
  }
}

async function chooseModel(
  provider: string,
  providerSpec: SetupProvider,
  config: SemanticGateConfig,
): Promise<string | undefined> {
  if (!providerSpec.needsModel && providerSpec.kind === "cli") {
    const shouldSet = await confirm("Set a model argument for this CLI preset?", Boolean(config.model));
    if (!shouldSet) {
      return undefined;
    }
  }

  if (providerSpec.kind !== "cli" || provider === "codex-cli" || provider === "opencode") {
    const useRemote = await confirm("Fetch available models from provider?", true);
    if (useRemote) {
      try {
        const models = await listProviderModels({ ...config, provider });
        if (models.length > 0) {
          return selectChoice(
            "Choose default model",
            models.map((model) => ({ label: model.name ? `${model.id} - ${model.name}` : model.id, value: model.id })),
            config.model,
            selectionFooter(provider, config.model),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`Could not fetch models: ${message}\n`);
      }
    }
  }

  return promptText("Default model", config.model ?? "");
}

async function selectChoice(title: string, choices: Choice[], current?: string, footer?: string): Promise<string> {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return selectChoiceTty(title, choices, current, footer);
  }
  return selectChoiceFallback(title, choices, current, footer);
}

async function selectChoiceTty(title: string, choices: Choice[], current?: string, footer?: string): Promise<string> {
  let index = Math.max(0, choices.findIndex((choice) => choice.value === current));
  if (index < 0) {
    index = 0;
  }
  readline.emitKeypressEvents(process.stdin);
  const wasPaused = process.stdin.isPaused();
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdout.write("\x1b[?25l");

  const render = () => {
    const terminalRows = process.stdout.rows ?? 24;
    const reservedRows = 7 + (footer ? 1 : 0);
    const visibleRows = Math.max(3, Math.min(choices.length, terminalRows - reservedRows));
    const halfWindow = Math.floor(visibleRows / 2);
    const maxStart = Math.max(0, choices.length - visibleRows);
    const start = Math.min(Math.max(0, index - halfWindow), maxStart);
    const end = Math.min(choices.length, start + visibleRows);

    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`${title}\n\n`);
    if (start > 0) {
      process.stdout.write(`  ... ${start} more above\n`);
    }
    choices.slice(start, end).forEach((choice, offset) => {
      const choiceIndex = start + offset;
      const selected = choiceIndex === index ? ">" : " ";
      const suffix = choice.description ? `  ${choice.description}` : "";
      process.stdout.write(`${selected} ${choice.label}${suffix}\n`);
    });
    if (end < choices.length) {
      process.stdout.write(`  ... ${choices.length - end} more below\n`);
    }
    if (footer) {
      process.stdout.write(`\n${footer}\n`);
    }
    process.stdout.write(
      `\nUse Up/Down and Enter. ${index + 1}/${choices.length}. Ctrl+C cancels.\n`,
    );
  };

  return new Promise((resolve, reject) => {
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      process.stdin.off("keypress", onKeypress);
      process.off("exit", cleanup);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      if (wasPaused) {
        process.stdin.pause();
      }
      process.stdout.write("\x1b[?25h");
    };
    const onKeypress = (_text: string, key: readline.Key) => {
      if (key.name === "up") {
        index = (index - 1 + choices.length) % choices.length;
        render();
      } else if (key.name === "down") {
        index = (index + 1) % choices.length;
        render();
      } else if (key.name === "return") {
        cleanup();
        process.stdout.write(`\n${choices[index]!.label}\n`);
        resolve(choices[index]!.value);
      } else if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Setup cancelled."));
      }
    };
    process.stdin.on("keypress", onKeypress);
    process.once("exit", cleanup);
    render();
  });
}

async function selectChoiceFallback(title: string, choices: Choice[], current?: string, footer?: string): Promise<string> {
  process.stdout.write(`${title}\n`);
  choices.forEach((choice, index) => {
    process.stdout.write(`${index + 1}. ${choice.label}${choice.description ? ` - ${choice.description}` : ""}\n`);
  });
  if (footer) {
    process.stdout.write(`${footer}\n`);
  }
  const currentIndex = Math.max(0, choices.findIndex((choice) => choice.value === current));
  const answer = await promptText("Choose number", String(currentIndex + 1));
  const index = Number(answer) - 1;
  return choices[index]?.value ?? choices[currentIndex]?.value ?? choices[0]!.value;
}

function selectionFooter(provider: unknown, model: unknown): string {
  const providerText = typeof provider === "string" && provider ? provider : "(not set)";
  const modelText = typeof model === "string" && model ? model : "(not set)";
  return `Current semantic-gate selection: provider=${providerText} | model=${modelText}`;
}

async function promptText(label: string, defaultValue = ""): Promise<string> {
  const answer = await question(`${label}${defaultValue ? ` [${defaultValue}]` : ""}: `);
  return answer.trim() || defaultValue;
}

async function promptNumber(label: string, defaultValue: number): Promise<number> {
  const answer = await promptText(label, String(defaultValue));
  const value = Number(answer);
  return Number.isFinite(value) ? value : defaultValue;
}

async function confirm(label: string, defaultValue: boolean): Promise<boolean> {
  const answer = await promptText(`${label} (${defaultValue ? "Y/n" : "y/N"})`, defaultValue ? "y" : "n");
  return ["y", "yes", "s", "sim", "true", "1"].includes(answer.trim().toLowerCase());
}

async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return question(`${label}: `);
  }
  const mutableStdout = new MutedOutput();
  const rl = readline.createInterface({ input: process.stdin, output: mutableStdout });
  mutableStdout.writeTo(process.stdout, `${label}: `);
  return new Promise((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

function question(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function parseArgsValue(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

class MutedOutput extends Writable {
  writeTo(output: NodeJS.WriteStream, text: string): void {
    output.write(text);
  }

  override _write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    process.stdout.write("*");
    callback();
  }
}
