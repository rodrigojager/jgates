import { SemanticGateError } from "./errors.js";
import { runCommand } from "./shell.js";
import { readStoredSecret, resolveApiKey, secretNameForProvider } from "./credentials.js";
import { baseUrlProblem, headerProblem } from "./config.js";
import type { ProviderModel, ProviderRequest, ProviderResponse, SemanticGateConfig } from "./types.js";

export async function callProvider(request: ProviderRequest): Promise<ProviderResponse> {
  const provider = request.config.provider;
  if (!provider) {
    throw new SemanticGateError(
      "No provider configured. Run `semantic-gate config set provider <provider>` or pass --provider.",
      "provider",
    );
  }

  if (request.config.connection) {
    return openAiCompatibleProvider(request, connectionTarget(request.config));
  }

  switch (provider) {
    case "mock":
      return mockProvider(request);
    case "openrouter":
      return openAiCompatibleProvider(request, {
        provider: "openrouter",
        baseUrl: request.config.baseUrl ?? "https://openrouter.ai/api/v1",
        apiKeyEnv: request.config.apiKeyEnv ?? "OPENROUTER_API_KEY",
      });
    case "openai":
      return openAiCompatibleProvider(request, {
        provider: "openai",
        baseUrl: request.config.baseUrl ?? "https://api.openai.com/v1",
        apiKeyEnv: request.config.apiKeyEnv ?? "OPENAI_API_KEY",
      });
    case "openai-compatible":
      return openAiCompatibleProvider(
        request,
        request.config.baseUrl === undefined
          ? { provider: "openai-compatible", apiKeyEnv: request.config.apiKeyEnv ?? "SEMANTIC_GATE_API_KEY" }
          : {
              provider: "openai-compatible",
              baseUrl: request.config.baseUrl,
              apiKeyEnv: request.config.apiKeyEnv ?? "SEMANTIC_GATE_API_KEY",
            },
      );
    case "opencode-api":
      // OpenCode Zen serves its chat-completions models (Kimi, GLM, DeepSeek, Qwen Max, free models) under this base;
      // its Claude, GPT and Gemini models use other API formats and are reached with the anthropic/openai/gemini providers.
      return openAiCompatibleProvider(request, {
        provider: "opencode-api",
        baseUrl: request.config.baseUrl ?? OPENCODE_ZEN_CHAT_BASE_URL,
        apiKeyEnv: request.config.apiKeyEnv ?? "OPENCODE_API_KEY",
      });
    case "anthropic":
    case "claude":
    case "claude-api":
      return anthropicProvider(request);
    case "ollama":
      return ollamaProvider(request);
    case "gemini":
    case "gemini-api":
      return geminiProvider(request);
    case "command":
    case "codex-cli":
    case "claude-code":
    case "gemini-cli":
    case "opencode":
      return commandProvider(request);
    default:
      throw new SemanticGateError(`Unsupported provider: ${provider}`, "provider");
  }
}

function mockProvider(request: ProviderRequest): ProviderResponse {
  const text =
    process.env.SEMANTIC_GATE_MOCK_RESPONSE ??
    JSON.stringify({
      gate: "semantic",
      status: "APPROVED",
      score: 100,
      threshold: request.config.threshold,
      deterministicSummaryUsed: false,
      objectiveSource: "mock",
      changesReviewed: request.chunkLabel ?? "mock full review",
      hardBlockers: [],
      scoreBreakdown: [
        { category: "functional", weight: 25, score: 25, observations: "Mock provider." },
        { category: "tests", weight: 20, score: 20, observations: "Mock provider." },
        { category: "security", weight: 20, score: 20, observations: "Mock provider." },
        { category: "maintainability", weight: 15, score: 15, observations: "Mock provider." },
        { category: "architecture", weight: 10, score: 10, observations: "Mock provider." },
        { category: "performance", weight: 10, score: 10, observations: "Mock provider." },
      ],
      commandsExecuted: [],
      findings: [],
      requiredFixPlan: [],
      rerunCommands: [
        "semantic-gate run --scope changed --objective-file <objective-file> --json",
        "quality-gate . --scope changed --json --no-interactive",
      ],
      approvalNotes: "Mock provider approved the semantic review.",
      residualRisks: [],
      contextWarnings: [],
    });
  return { text, raw: { provider: "mock" } };
}

interface OpenAiCompatibleTarget {
  provider: string;
  baseUrl?: string;
  apiKeyEnv: string;
  /** Extra headers of a connection (already checked: no credential among them). */
  headers?: Record<string, string>;
  /** A connection without a declared key name may have no key at all (a local gateway); a provider always needs one. */
  keyOptional?: boolean;
}

/**
 * Where a named connection of the user's preferences points: its base URL, its key name (default <NAME>_API_KEY) and
 * its extra headers. The rules of the preferences are checked again here, so a hand-edited value never goes out.
 */
function connectionTarget(config: SemanticGateConfig): OpenAiCompatibleTarget {
  const name = config.connection as string;
  if (!config.baseUrl) {
    throw new SemanticGateError(`Connection ${name} has no baseUrl.`, "provider");
  }
  const urlProblem = baseUrlProblem(config.baseUrl, config.allowInsecureHttp === true);
  if (urlProblem) {
    throw new SemanticGateError(
      urlProblem === "INSECURE_HTTP"
        ? `Connection ${name}: plain http to a host that is not loopback would send the key in clear text; use https or confirm it with allowInsecureHttp.`
        : `Connection ${name}: the baseUrl is refused (${urlProblem}).`,
      "provider",
    );
  }
  const headers = config.headers ?? {};
  for (const [header, value] of Object.entries(headers)) {
    const problem = headerProblem(header, value);
    if (problem) {
      throw new SemanticGateError(`Connection ${name}: the header ${header} is refused (${problem}); a credential goes in the key store.`, "provider");
    }
  }
  return {
    provider: name,
    baseUrl: config.baseUrl,
    apiKeyEnv: config.apiKeyEnv ?? secretNameForProvider(name),
    headers,
    keyOptional: config.apiKeyEnv === undefined,
  };
}

async function openAiCompatibleProvider(request: ProviderRequest, defaults: OpenAiCompatibleTarget): Promise<ProviderResponse> {
  const baseUrl = defaults.baseUrl;
  if (!baseUrl) {
    throw new SemanticGateError(`${defaults.provider} provider requires baseUrl or SEMANTIC_GATE_BASE_URL.`, "provider");
  }
  const apiKey = defaults.keyOptional
    ? readOptionalApiKey(defaults.provider, defaults.apiKeyEnv, request.config)
    : readApiKey(defaults.provider, defaults.apiKeyEnv, request.config);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      ...(defaults.headers ?? {}),
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: requireModel(request.config),
      ...temperatureField(request.config),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
    }),
  });
  const json = await parseHttpJson(response);
  const text = jsonPath(json, ["choices", 0, "message", "content"]);
  if (typeof text !== "string") {
    throw new SemanticGateError("OpenAI-compatible provider returned no message content.", "provider", json);
  }
  return { text, raw: json };
}

async function anthropicProvider(request: ProviderRequest): Promise<ProviderResponse> {
  const apiKey = readApiKey("anthropic", request.config.apiKeyEnv ?? "ANTHROPIC_API_KEY", request.config);
  // API version 2026-10-21 removed temperature/top_p/top_k, so the request never carries them.
  const response = await fetch(`${anthropicBaseUrl(request.config)}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: requireModel(request.config),
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
    }),
  });
  const json = await parseHttpJson(response);
  const content = jsonPath(json, ["content"]);
  const text = Array.isArray(content)
    ? content
        .filter((item): item is { type: string; text: unknown } =>
          Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text" && "text" in item),
        )
        .map((item) => String(item.text))
        .join("\n")
    : undefined;
  if (!text) {
    const stopReason = jsonPath(json, ["stop_reason"]);
    const reason = typeof stopReason === "string" ? ` (stop_reason: ${stopReason})` : "";
    throw new SemanticGateError(`Anthropic provider returned no text content${reason}.`, "provider", json);
  }
  return { text, raw: json };
}

async function ollamaProvider(request: ProviderRequest): Promise<ProviderResponse> {
  const host = (request.config.baseUrl ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const response = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: requireModel(request.config),
      stream: false,
      format: "json",
      ...(request.config.temperature === undefined ? {} : { options: { temperature: request.config.temperature } }),
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
    }),
  });
  const json = await parseHttpJson(response);
  const text = jsonPath(json, ["message", "content"]);
  if (typeof text !== "string") {
    throw new SemanticGateError("Ollama provider returned no message content.", "provider", json);
  }
  return { text, raw: json };
}

async function geminiProvider(request: ProviderRequest): Promise<ProviderResponse> {
  const apiKey = readApiKey("gemini", request.config.apiKeyEnv ?? "GEMINI_API_KEY", request.config);
  const model = requireModel(request.config);
  // The key goes in the x-goog-api-key header, as the Gemini API docs show, so it never lands in a URL or a log.
  const response = await fetch(`${geminiBaseUrl(request.config)}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      generationConfig: {
        ...temperatureField(request.config),
        responseMimeType: "application/json",
      },
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.prompt }] }],
    }),
  });
  const json = await parseHttpJson(response);
  const parts = jsonPath(json, ["candidates", 0, "content", "parts"]);
  const text = Array.isArray(parts)
    ? parts
        .filter((part): part is { text: string; thought?: unknown } =>
          Boolean(part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" && !(part as { thought?: unknown }).thought),
        )
        .map((part) => part.text)
        .join("")
    : undefined;
  if (typeof text !== "string" || !text) {
    throw new SemanticGateError("Gemini API provider returned no text content.", "provider", json);
  }
  return { text, raw: json };
}

async function commandProvider(request: ProviderRequest): Promise<ProviderResponse> {
  const command = request.config.command ?? defaultCommandForProvider(request.config.provider);
  if (!command) {
    throw new SemanticGateError(
      "Command provider requires `command` in config. Example: semantic-gate config set command codex",
      "provider",
    );
  }
  const cwd = request.cwd ?? process.cwd();
  const requirement = cliRequirementFor(request.config.provider);
  const cliVersion = requirement ? await ensureCliVersion(requirement, command, cwd, request.config.timeoutMs) : undefined;
  const defaults = defaultCommandConfigForProvider(
    request.config.provider,
    request.config.model,
    request.config.reasoningEffort,
    request.config.codexSandbox,
    request.config.codexBypassSandbox,
    request.config.codexSkipGitRepoCheck,
    cliVersion,
  );
  const args = request.config.commandArgs ?? defaults.args ?? [];
  const promptMode = request.config.commandArgs ? request.config.commandPromptMode : defaults.promptMode ?? request.config.commandPromptMode;
  const finalArgs =
    promptMode === "argument"
      ? args.map((arg) => arg.replace("{prompt}", request.prompt))
      : args;
  const input = promptMode === "stdin" ? request.prompt : undefined;
  const runOptions: { cwd: string; input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {
    cwd,
    timeoutMs: request.config.timeoutMs,
  };
  if (input !== undefined) {
    runOptions.input = input;
  }
  if (request.config.provider === "opencode") {
    runOptions.env = { ...process.env, OPENCODE_CONFIG_CONTENT: openCodeReviewConfig(process.env.OPENCODE_CONFIG_CONTENT) };
  }
  // A command that declares apiKeyEnv gets that variable from the user's key store when the environment does not have it;
  // no other name of the store reaches it.
  const keyEnv = request.config.apiKeyEnv;
  if (keyEnv && !process.env[keyEnv] && request.config.secretStore !== false) {
    const stored = readStoredSecret(keyEnv);
    if (stored) {
      runOptions.env = { ...(runOptions.env ?? process.env), [keyEnv]: stored };
    }
  }
  const result = await runCommandOrExplain(command, finalArgs, runOptions, request.config.provider, requirement);
  if (result.code !== 0) {
    const failure = classifyCommandProviderFailure(request.config.provider, result.code ?? 1, result.stderr || result.stdout);
    throw new SemanticGateError(failure.message, "provider", failure.details);
  }
  const text = request.config.commandOutput === "json" ? result.stdout : result.stdout.trim();
  return { text, raw: { stdout: result.stdout, stderr: result.stderr, code: result.code } };
}

/**
 * What each CLI preset needs from the installed CLI. `minimum` is the oldest release whose documented flags and
 * headless behavior match the preset (checked against the official docs and changelogs on 2026-10-27).
 */
export interface CliRequirement {
  provider: string;
  name: string;
  minimum: string;
  update: string;
  install: string;
}

export const CLI_REQUIREMENTS: Readonly<Record<string, CliRequirement>> = {
  "codex-cli": {
    provider: "codex-cli",
    name: "Codex CLI",
    minimum: "0.122.0",
    update: "npm install -g @openai/codex@latest",
    install: "npm install -g @openai/codex",
  },
  "claude-code": {
    provider: "claude-code",
    name: "Claude Code",
    minimum: "2.1.0",
    update: "claude update",
    install: "npm install -g @anthropic-ai/claude-code",
  },
  "gemini-cli": {
    provider: "gemini-cli",
    name: "Gemini CLI",
    minimum: "0.30.0",
    update: "npm install -g @google/gemini-cli@latest",
    install: "npm install -g @google/gemini-cli",
  },
  opencode: {
    provider: "opencode",
    name: "OpenCode",
    minimum: "1.2.0",
    update: "opencode upgrade",
    install: "npm install -g opencode-ai",
  },
};

/** The opencode agent the review runs as: every tool denied, so the CLI cannot edit files or run commands. */
export const OPENCODE_REVIEW_AGENT = "semantic-gate-review";

function defaultCommandForProvider(provider: string | undefined): string | undefined {
  switch (provider) {
    case "codex-cli":
      return "codex";
    case "claude-code":
      return "claude";
    case "gemini-cli":
      return "gemini";
    case "opencode":
      return "opencode";
    default:
      return undefined;
  }
}

function cliRequirementFor(provider: string | undefined): CliRequirement | undefined {
  return provider ? CLI_REQUIREMENTS[provider] : undefined;
}

const checkedCliVersions = new Map<string, Promise<string>>();

/** Reads `<command> --version` once per process and fails before the model runs when it is missing, unreadable or too old. */
export function ensureCliVersion(requirement: CliRequirement, command: string, cwd: string, timeoutMs?: number): Promise<string> {
  const key = [requirement.provider, command, process.env.PATH ?? process.env.Path ?? ""].join("\u0000");
  let pending = checkedCliVersions.get(key);
  if (!pending) {
    pending = readCliVersion(requirement, command, cwd, timeoutMs);
    checkedCliVersions.set(key, pending);
    pending.catch(() => checkedCliVersions.delete(key));
  }
  return pending;
}

async function readCliVersion(requirement: CliRequirement, command: string, cwd: string, timeoutMs?: number): Promise<string> {
  const versionTimeout = Math.min(timeoutMs ?? 30_000, 30_000);
  const result = await runCommandOrExplain(command, ["--version"], { cwd, timeoutMs: versionTimeout }, requirement.provider, requirement);
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  const found = parseVersion(output);
  const details = {
    provider: requirement.provider,
    command: `${command} --version`,
    exitCode: result.code,
    minimum: requirement.minimum,
    update: requirement.update,
  };
  if (result.code !== 0 || !found) {
    const excerpt = output.trim().split(/\r?\n/).slice(0, 3).join(" | ").slice(0, 300);
    throw new SemanticGateError(
      `Could not read the ${requirement.name} version: \`${command} --version\` ${result.code !== 0 ? `exited with ${result.code}` : "printed no version number"}${excerpt ? ` (output: ${excerpt})` : ""}. The ${requirement.provider} provider needs ${requirement.name} ${requirement.minimum} or newer; update with: ${requirement.update}. The model was not called.`,
      "provider",
      { ...details, classification: "provider-cli-version-unreadable" },
    );
  }
  if (compareVersions(found, requirement.minimum) < 0) {
    throw new SemanticGateError(
      `${requirement.name} ${found} is older than the minimum ${requirement.minimum} the ${requirement.provider} provider needs (command: ${command}). Update with: ${requirement.update}. The model was not called.`,
      "provider",
      { ...details, found, classification: "provider-cli-outdated" },
    );
  }
  return found;
}

async function runCommandOrExplain(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
  provider: string | undefined,
  requirement: CliRequirement | undefined,
): Promise<Awaited<ReturnType<typeof runCommand>>> {
  try {
    return await runCommand(command, args, options);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      const install = requirement ? ` Install ${requirement.name} with: ${requirement.install}` : "";
      throw new SemanticGateError(`Command not found: ${command}.${install}`, "provider", {
        provider: provider ?? "command",
        command,
        classification: "provider-cli-missing",
      });
    }
    throw error;
  }
}

/** First `major.minor.patch` in the output; a prerelease suffix is ignored. */
export function parseVersion(output: string): string | undefined {
  const match = /(?:^|[^\d.])v?(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : undefined;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Inline opencode config (OPENCODE_CONFIG_CONTENT, loaded after the project config) that defines the review agent with
 * every permission denied. A config the user already passes inline is kept and only gains the agent.
 */
export function openCodeReviewConfig(existing: string | undefined): string {
  let base: Record<string, unknown> = {};
  if (existing && existing.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new SemanticGateError(
        "OPENCODE_CONFIG_CONTENT is set but is not valid JSON, so the read-only review agent cannot be added to it. Unset it or make it plain JSON.",
        "provider",
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SemanticGateError("OPENCODE_CONFIG_CONTENT must be a JSON object.", "provider");
    }
    base = parsed as Record<string, unknown>;
  }
  const agents = base.agent && typeof base.agent === "object" && !Array.isArray(base.agent) ? (base.agent as Record<string, unknown>) : {};
  return JSON.stringify({
    ...base,
    agent: {
      ...agents,
      [OPENCODE_REVIEW_AGENT]: {
        description: "semantic-gate review: answers from the prompt only, with every tool denied.",
        mode: "primary",
        permission: "deny",
      },
    },
  });
}

function classifyCommandProviderFailure(
  provider: string | undefined,
  exitCode: number,
  output: string,
): { message: string; details: Record<string, unknown> } {
  const text = String(output || "");
  const runtimeLines = providerRuntimeLines(text);
  const details = {
    provider: provider ?? "command",
    exitCode,
    classification: "command-failed",
    advice: "Inspect the provider command configuration and rerun semantic-gate status.",
    diagnosticExcerpt: providerDiagnosticExcerpt(text),
  };

  if (runtimeLines.some(isProviderNetworkLine)) {
    return {
      message: `Command provider exited with ${exitCode}: provider network connection failed before a semantic response was returned.`,
      details: {
        ...details,
        classification: "provider-network",
        advice:
          "Verify network/firewall/sandbox access to the provider API. This is different from an API credential failure. For local Windows Firewall with codex-cli, allow the Codex CLI and its Node runtime through the firewall from an Administrator PowerShell.",
      },
    };
  }

  if (exitCode === 124 || runtimeLines.some(isProviderTimeoutLine)) {
    return {
      message: `Command provider exited with ${exitCode}: provider timed out before a semantic response was returned.`,
      details: {
        ...details,
        classification: "provider-timeout",
        advice: "Increase --timeout-ms or reduce the semantic context size. This is different from an API credential failure.",
      },
    };
  }

  if (runtimeLines.some(isProviderAuthLine)) {
    return {
      message: `Command provider exited with ${exitCode}: provider authentication failed.`,
      details: {
        ...details,
        classification: "provider-auth",
        advice: "Check the provider login/API key, configured model, and semantic-gate status.",
      },
    };
  }

  return {
    message: `Command provider exited with ${exitCode}.`,
    details,
  };
}

function providerDiagnosticExcerpt(output: string): string {
  const runtimeLines = providerRuntimeLines(output);
  const transportLines = runtimeLines.filter(isProviderNetworkLine);
  const timeoutLines = runtimeLines.filter(isProviderTimeoutLine);
  const operationalLines = transportLines.length ? [...transportLines, ...timeoutLines] : timeoutLines;
  const diagnosticLines = operationalLines.length
    ? operationalLines
    : runtimeLines.filter((line) =>
        /error|warning|failed|connect|socket|timeout|permission|denied|unauthorized|forbidden|api\.openai\.com|\/v1\/responses/i.test(line),
      );
  const selected = diagnosticLines.length ? diagnosticLines : runtimeLines.slice(-12);
  const excerpt = selected.slice(-20).join("\n");
  return excerpt.length > 2000 ? `${excerpt.slice(0, 900)}\n...<truncated>...\n${excerpt.slice(-900)}` : excerpt;
}

function providerRuntimeLines(output: string): string[] {
  return stripAnsi(String(output || ""))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !looksLikePromptContextLine(line));
}

function isProviderNetworkLine(line: string): boolean {
  return /codex_api|responses_websocket|failed to connect|stream disconnected|falling back from websockets|reconnecting|error sending request|os error \d+|wss:\/\/|econnrefused|enotfound|etimedout|permission denied|acesso negado/i.test(line);
}

function isProviderAuthLine(line: string): boolean {
  return /401|403|unauthorized|forbidden|invalid api key|authentication failed|api key rejected/i.test(line);
}

function isProviderTimeoutLine(line: string): boolean {
  return /^command timed out(\.| after \d+ms\.)?$/i.test(line);
}

function looksLikePromptContextLine(line: string): boolean {
  return (
    /^diff --git\b|^@@\b|^index [0-9a-f]+\.\.[0-9a-f]+/i.test(line) ||
    /^[+-]/.test(line) ||
    /^\d+:\s/.test(line) ||
    /^rg:\s/i.test(line) ||
    /(^|\s)[\w./\\-]+\.(ts|tsx|js|jsx|mjs|cjs|py|md|json):\d+:/i.test(line) ||
    (/\|/.test(line) && /api\.openai\.com|responses_websocket|econnrefused|enotfound|etimedout|permission|wss:\\?\/\\?\//i.test(line)) ||
    /^[A-Za-z_$][\w$]*:\s+.*https?:\/\//.test(line) ||
    /SemanticGateError|providerDiagnosticExcerpt|runGateProcess|spawnSync|spawn\(/.test(line)
  );
}

export function defaultCommandConfigForProvider(
  provider: string | undefined,
  model: string | undefined,
  reasoningEffort: string | undefined,
  codexSandbox: SemanticGateConfig["codexSandbox"],
  codexBypassSandbox: boolean,
  codexSkipGitRepoCheck: boolean,
  cliVersion?: string,
): { command?: string; args?: string[]; promptMode?: "stdin" | "argument" } {
  // Every preset sends the prompt on stdin: a review prompt can pass the per-argument limit of the OS
  // (128 KiB on Linux, 32 KiB for a whole Windows command line).
  switch (provider) {
    case "codex-cli":
      return {
        command: "codex",
        args: codexCliArgs(model, reasoningEffort, codexSandbox, codexBypassSandbox, codexSkipGitRepoCheck),
        promptMode: "stdin",
      };
    case "claude-code":
      // --tools "" removes every built-in tool and --strict-mcp-config without --mcp-config loads no MCP server:
      // the review answers from the prompt and cannot edit files or run commands.
      return {
        command: "claude",
        args: ["--print", ...(model ? ["--model", model] : []), "--tools", "", "--strict-mcp-config"],
        promptMode: "stdin",
      };
    case "gemini-cli":
      // A piped stdin runs Gemini CLI headless; --approval-mode default (over a settings default such as auto_edit)
      // makes every tool that needs approval, such as edits and shell, be denied with no one to approve it.
      return {
        command: "gemini",
        args: [...(model ? ["--model", model] : []), "--approval-mode", "default", "--output-format", "text"],
        promptMode: "stdin",
      };
    case "opencode":
      // `opencode` alone opens the TUI; `opencode run` is the headless mode and appends piped stdin to the message.
      // OpenCode 2 runs against a shared background service by default, which never sees this process's
      // OPENCODE_CONFIG_CONTENT; --standalone starts a private server that loads the review agent.
      return {
        command: "opencode",
        args: [
          "run",
          ...(cliVersion && compareVersions(cliVersion, "2.0.0") >= 0 ? ["--standalone"] : []),
          "--agent",
          OPENCODE_REVIEW_AGENT,
          ...(model ? ["--model", model] : []),
          "--format",
          "default",
        ],
        promptMode: "stdin",
      };
    default:
      return {};
  }
}

function codexCliArgs(
  model: string | undefined,
  reasoningEffort: string | undefined,
  codexSandbox: SemanticGateConfig["codexSandbox"],
  codexBypassSandbox: boolean,
  codexSkipGitRepoCheck: boolean,
): string[] {
  const args = ["exec"];
  if (model) {
    args.push("-m", model);
  }
  if (codexBypassSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (codexSandbox) {
    args.push("--sandbox", codexSandbox);
  }
  if (codexSkipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  if (reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  }
  args.push("-");
  return args;
}

export async function listProviderModels(config: SemanticGateConfig): Promise<ProviderModel[]> {
  const provider = config.provider;
  if (!provider) {
    throw new SemanticGateError("No provider configured for model listing.", "provider");
  }
  if (config.connection) {
    const target = connectionTarget(config);
    return listOpenAiCompatibleModels(config, {
      provider: target.provider,
      baseUrl: target.baseUrl as string,
      apiKeyEnv: target.apiKeyEnv,
      requireApiKey: !target.keyOptional,
      ...(target.headers ? { headers: target.headers } : {}),
    });
  }
  switch (provider) {
    case "openrouter":
      return listOpenAiCompatibleModels(config, {
        provider: "openrouter",
        baseUrl: config.baseUrl ?? "https://openrouter.ai/api/v1",
        apiKeyEnv: config.apiKeyEnv ?? "OPENROUTER_API_KEY",
        requireApiKey: false,
      });
    case "openai":
      return listOpenAiCompatibleModels(config, {
        provider: "openai",
        baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
        apiKeyEnv: config.apiKeyEnv ?? "OPENAI_API_KEY",
        requireApiKey: true,
      });
    case "openai-compatible":
      if (!config.baseUrl) {
        throw new SemanticGateError("openai-compatible model listing requires baseUrl.", "provider");
      }
      return listOpenAiCompatibleModels(config, {
        provider: "openai-compatible",
        baseUrl: config.baseUrl,
        apiKeyEnv: config.apiKeyEnv ?? "SEMANTIC_GATE_API_KEY",
        requireApiKey: true,
      });
    case "opencode-api":
      return listOpenAiCompatibleModels(config, {
        provider: "opencode-api",
        baseUrl: config.baseUrl ?? OPENCODE_ZEN_MODELS_BASE_URL,
        apiKeyEnv: config.apiKeyEnv ?? "OPENCODE_API_KEY",
        requireApiKey: true,
      });
    case "anthropic":
    case "claude":
    case "claude-api":
      return listAnthropicModels(config);
    case "gemini":
    case "gemini-api":
      return listGeminiModels(config);
    case "ollama":
      return listOllamaModels(config);
    case "codex-cli":
      return listCodexCliModels(config);
    case "opencode":
      return listOpenCodeModels(config);
    default:
      throw new SemanticGateError(`Provider does not support model listing: ${provider}`, "provider");
  }
}

async function listOpenAiCompatibleModels(
  config: SemanticGateConfig,
  defaults: { provider: string; baseUrl: string; apiKeyEnv: string; requireApiKey: boolean; headers?: Record<string, string> },
): Promise<ProviderModel[]> {
  const apiKey = readOptionalApiKey(defaults.provider, defaults.apiKeyEnv, config);
  if (defaults.requireApiKey && !apiKey) {
    throw new SemanticGateError(
      `Missing API key for ${defaults.provider}. Set ${defaults.apiKeyEnv}, or run: semantic-gate auth set ${defaults.provider} --key-stdin`,
      "provider",
    );
  }
  const headers: Record<string, string> = { ...(defaults.headers ?? {}) };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(`${defaults.baseUrl.replace(/\/$/, "")}/models`, {
    headers,
  });
  const json = await parseHttpJson(response);
  const data = jsonPath(json, ["data"]);
  if (!Array.isArray(data)) {
    throw new SemanticGateError("Provider model list response has no data array.", "provider", json);
  }
  return data
    .map((item) => modelFromObject(item, "id"))
    .filter((model): model is ProviderModel => Boolean(model));
}

async function listAnthropicModels(config: SemanticGateConfig): Promise<ProviderModel[]> {
  const apiKey = readApiKey("anthropic", config.apiKeyEnv ?? "ANTHROPIC_API_KEY", config);
  const response = await fetch(`${anthropicBaseUrl(config)}/v1/models`, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
  });
  const json = await parseHttpJson(response);
  const data = jsonPath(json, ["data"]);
  if (!Array.isArray(data)) {
    throw new SemanticGateError("Anthropic model list response has no data array.", "provider", json);
  }
  return data
    .map((item) => modelFromObject(item, "id"))
    .filter((model): model is ProviderModel => Boolean(model));
}

async function listGeminiModels(config: SemanticGateConfig): Promise<ProviderModel[]> {
  const apiKey = readApiKey("gemini", config.apiKeyEnv ?? "GEMINI_API_KEY", config);
  const response = await fetch(`${geminiBaseUrl(config)}/models`, { headers: { "x-goog-api-key": apiKey } });
  const json = await parseHttpJson(response);
  const models = jsonPath(json, ["models"]);
  if (!Array.isArray(models)) {
    throw new SemanticGateError("Gemini model list response has no models array.", "provider", json);
  }
  return models
    .map((item) => {
      const model = modelFromObject(item, "name");
      if (!model) {
        return undefined;
      }
      return {
        ...model,
        id: model.id.startsWith("models/") ? model.id.slice("models/".length) : model.id,
      };
    })
    .filter((model): model is ProviderModel => Boolean(model));
}

async function listOllamaModels(config: SemanticGateConfig): Promise<ProviderModel[]> {
  const host = (config.baseUrl ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const response = await fetch(`${host}/api/tags`);
  const json = await parseHttpJson(response);
  const models = jsonPath(json, ["models"]);
  if (!Array.isArray(models)) {
    throw new SemanticGateError("Ollama model list response has no models array.", "provider", json);
  }
  return models
    .map((item) => modelFromObject(item, "name"))
    .filter((model): model is ProviderModel => Boolean(model));
}

async function listCodexCliModels(config: SemanticGateConfig): Promise<ProviderModel[]> {
  const command = config.modelListCommand ?? config.command ?? "codex";
  const args = config.modelListArgs ?? ["debug", "models"];
  const result = await runCommand(command, args, {
    cwd: process.cwd(),
    timeoutMs: config.timeoutMs,
  });
  if (result.code !== 0) {
    throw new SemanticGateError(`Codex CLI model listing exited with ${result.code}.`, "provider", result.stderr);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new SemanticGateError("Codex CLI model listing did not return JSON.", "provider", result.stdout.slice(0, 1000));
  }
  const models = jsonPath(parsed, ["models"]);
  if (!Array.isArray(models)) {
    throw new SemanticGateError("Codex CLI model list response has no models array.", "provider", parsed);
  }
  return models
    .map((item) => {
      const model = modelFromObject(item, "slug");
      if (!model) {
        return undefined;
      }
      if (!model.name && item && typeof item === "object" && !Array.isArray(item)) {
        const displayName = (item as Record<string, unknown>).display_name;
        if (typeof displayName === "string") {
          model.name = displayName;
        }
      }
      return model;
    })
    .filter((model): model is ProviderModel => Boolean(model));
}

async function listOpenCodeModels(config: SemanticGateConfig): Promise<ProviderModel[]> {
  const command = config.modelListCommand ?? config.command ?? "opencode";
  const args = config.modelListArgs ?? ["models"];
  const result = await runCommand(command, args, {
    cwd: process.cwd(),
    timeoutMs: config.timeoutMs,
  });
  if (result.code !== 0) {
    throw new SemanticGateError(`OpenCode model listing exited with ${result.code}.`, "provider", result.stderr);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean)
    .map((id) => ({ id }));
}

function modelFromObject(item: unknown, idKey: string): ProviderModel | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  const id = record[idKey];
  if (typeof id !== "string" || !id) {
    return undefined;
  }
  const model: ProviderModel = { id, raw: item };
  if (typeof record.display_name === "string") {
    model.name = record.display_name;
  } else if (typeof record.name === "string" && record.name !== id) {
    model.name = record.name;
  }
  return model;
}

function readApiKey(provider: string, envName: string, config: SemanticGateConfig): string {
  const value = readOptionalApiKey(provider, envName, config);
  if (!value) {
    throw new SemanticGateError(
      `Missing API key for ${provider}. Set ${envName}, or store it: semantic-gate auth set ${envName} --key-stdin (or jgates secrets set ${envName})`,
      "provider",
    );
  }
  return value;
}

function readOptionalApiKey(provider: string, envName: string, config: SemanticGateConfig): string | undefined {
  const resolveOptions: { provider: string; envName?: string; keyProvider?: string; store?: boolean } = {
    provider,
    envName,
    store: config.secretStore !== false,
  };
  if (config.apiKeyProvider !== undefined) {
    resolveOptions.keyProvider = config.apiKeyProvider;
  }
  return resolveApiKey(resolveOptions);
}

function requireModel(config: SemanticGateConfig): string {
  if (!config.model) {
    throw new SemanticGateError("Provider requires a configured model.", "provider");
  }
  return config.model;
}

async function parseHttpJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new SemanticGateError(`Provider returned non-JSON HTTP response (${response.status}).`, "provider", text);
  }
  if (!response.ok) {
    throw new SemanticGateError(`Provider HTTP error ${response.status}.`, "provider", json);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new SemanticGateError("Provider HTTP response JSON must be an object.", "provider", json);
  }
  return json as Record<string, unknown>;
}

function jsonPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[segment];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

const OPENCODE_ZEN_CHAT_BASE_URL = "https://opencode.ai/inference/openai/v1";
// Zen lists every model under /inference/v1/models, outside the chat base.
const OPENCODE_ZEN_MODELS_BASE_URL = "https://opencode.ai/inference/v1";
const ANTHROPIC_VERSION = "2026-10-21";
// Adaptive thinking is on by default on current Claude models and counts toward max_tokens.
const ANTHROPIC_MAX_TOKENS = 16_000;

function anthropicBaseUrl(config: SemanticGateConfig): string {
  return (config.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
}

function geminiBaseUrl(config: SemanticGateConfig): string {
  return (config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
}

function temperatureField(config: SemanticGateConfig): { temperature?: number } {
  return config.temperature === undefined ? {} : { temperature: config.temperature };
}
