// Tool calling for a bounded investigation: the provider-neutral shape of one model turn that may ask for tools
// (messages, tool specs, tool calls and results, real usage), its conversion to the Anthropic Messages and the
// OpenAI-compatible chat formats, and a scripted model for tests (no tokens are spent).
//
// The package only carries the turns. The tools themselves (read, list, search inside the allowed scope) are
// implemented by the host that runs the investigation, which decides every call in code: a model asking for a tool
// is a request, never a permission.
import fs from "node:fs";
import { SemanticGateError } from "./errors.js";
import type { SemanticGateConfig } from "./types.js";

/** A tool the host offers to the model: a name, what it does and the JSON Schema of its arguments. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A tool call the model asked for. `argumentsError` is set when the arguments were not a JSON object. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentsError?: string;
}

/** What the host answered to one tool call (always text; `isError` when it refused or failed). */
export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  isError: boolean;
}

/** One message of a tool conversation, independent of the provider format. */
export type ToolMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

/** Tokens the provider reported for one turn; null when it reported none (never estimated here). */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ToolTurnRequest {
  system: string;
  messages: ToolMessage[];
  /** The tools offered on this turn. */
  tools: ToolSpec[];
  /** none: the tools stay declared (the conversation refers to them) but this turn must answer with its final text. */
  toolChoice?: "auto" | "none";
  config: SemanticGateConfig;
  /** Which context of the investigation this turn belongs to ("hunt", "validate:C1"...): the scripted model keys on it. */
  contextLabel?: string;
  /** Largest number of output tokens for this turn (the provider's own limit when absent). */
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** The scripted model of the mock provider: a script, or the path of a JSON script file. */
  script?: ToolScript | string;
}

export interface ToolTurnResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: TurnUsage | null;
  stopReason?: string;
  raw: unknown;
}

/** One scripted turn: the text and the tool calls the fake model answers with, and the usage it reports. */
export interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ id?: string; name: string; arguments?: Record<string, unknown> }>;
  usage?: TurnUsage | null;
}

/**
 * A scripted model: turns per context label (the turn index is the number of assistant messages already in the
 * conversation, so the script is stateless and deterministic), or a function of the request. A label is looked up
 * exactly, then by its stage prefix (before ":"), then under "*".
 */
export type ToolScript = { contexts: Record<string, ScriptedTurn[]> } | ((request: ToolTurnRequest) => ScriptedTurn | Promise<ScriptedTurn>);

export function loadToolScript(file: string): ToolScript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new SemanticGateError(`The mock tool script ${file} could not be read: ${error instanceof Error ? error.message : String(error)}`, "provider");
  }
  if (!parsed || typeof parsed !== "object" || !("contexts" in parsed) || typeof (parsed as { contexts: unknown }).contexts !== "object") {
    throw new SemanticGateError(`The mock tool script ${file} must be an object with "contexts".`, "provider");
  }
  return parsed as ToolScript;
}

/** The scripted answer to one turn. A script that has no turn left answers with empty text and no tool call. */
export async function scriptedTurn(script: ToolScript, request: ToolTurnRequest): Promise<ToolTurnResponse> {
  const index = request.messages.filter((m) => m.role === "assistant").length;
  let turn: ScriptedTurn | undefined;
  if (typeof script === "function") {
    turn = await script(request);
  } else {
    const label = request.contextLabel ?? "*";
    const stage = label.split(":")[0] ?? label;
    const turns = script.contexts[label] ?? script.contexts[stage] ?? script.contexts["*"] ?? [];
    turn = turns[index];
  }
  const toolCalls: ToolCall[] = (turn?.toolCalls ?? []).map((c, i) => ({ id: c.id ?? `call_${index + 1}_${i + 1}`, name: c.name, arguments: c.arguments ?? {} }));
  return { text: turn?.text ?? "", toolCalls, usage: turn?.usage ?? null, stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn", raw: { provider: "mock", scripted: true } };
}

/** Parses the arguments of a tool call as the providers send them (an object, or a JSON text of one). */
export function parseToolArguments(raw: unknown): { arguments: Record<string, unknown>; error?: string } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { arguments: raw as Record<string, unknown> };
  if (typeof raw === "string") {
    if (raw.trim() === "") return { arguments: {} };
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { arguments: parsed as Record<string, unknown> };
      return { arguments: {}, error: "the tool arguments are not a JSON object" };
    } catch {
      return { arguments: {}, error: "the tool arguments are not valid JSON" };
    }
  }
  if (raw === undefined || raw === null) return { arguments: {} };
  return { arguments: {}, error: "the tool arguments are not a JSON object" };
}

// ---- provider formats -------------------------------------------------------------------------------------------------

/** Anthropic Messages: tools and messages (tool_use blocks in the assistant turn, tool_result blocks in the next user turn). */
export function toAnthropicTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

export function toAnthropicMessages(messages: ToolMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
      out.push({ role: "assistant", content: content.length > 0 ? content : [{ type: "text", text: "" }] });
    } else {
      out.push({ role: "user", content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.callId, content: r.content, ...(r.isError ? { is_error: true } : {}) })) });
    }
  }
  return out;
}

export function fromAnthropicResponse(json: Record<string, unknown>): ToolTurnResponse {
  const content = Array.isArray(json.content) ? (json.content as Array<Record<string, unknown>>) : [];
  const text = content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => String(b.text)).join("\n");
  const toolCalls: ToolCall[] = content
    .filter((b) => b && b.type === "tool_use")
    .map((b, i) => {
      const parsed = parseToolArguments(b.input);
      return { id: typeof b.id === "string" ? b.id : `tool_${i + 1}`, name: String(b.name ?? ""), arguments: parsed.arguments, ...(parsed.error ? { argumentsError: parsed.error } : {}) };
    });
  const usage = json.usage && typeof json.usage === "object" ? (json.usage as Record<string, unknown>) : null;
  const input = usage ? sumNumbers(usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens) : null;
  const output = usage ? numberOrNull(usage.output_tokens) : null;
  return {
    text,
    toolCalls,
    usage: input !== null && output !== null ? { inputTokens: input, outputTokens: output } : null,
    ...(typeof json.stop_reason === "string" ? { stopReason: json.stop_reason } : {}),
    raw: json,
  };
}

/** OpenAI-compatible chat completions: function tools, assistant tool_calls and one "tool" message per result. */
export function toOpenAiTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function toOpenAiMessages(system: string, messages: ToolMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.text || null,
        ...(m.toolCalls.length > 0 ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}),
      });
    } else {
      for (const r of m.results) out.push({ role: "tool", tool_call_id: r.callId, content: r.content });
    }
  }
  return out;
}

export function fromOpenAiResponse(json: Record<string, unknown>): ToolTurnResponse {
  const choice = Array.isArray(json.choices) ? (json.choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = choice && typeof choice.message === "object" && choice.message ? (choice.message as Record<string, unknown>) : null;
  if (!message) throw new SemanticGateError("OpenAI-compatible provider returned no message.", "provider", json);
  const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
  const toolCalls: ToolCall[] = calls.map((c, i) => {
    const fn = c.function && typeof c.function === "object" ? (c.function as Record<string, unknown>) : {};
    const parsed = parseToolArguments(fn.arguments);
    return { id: typeof c.id === "string" ? c.id : `call_${i + 1}`, name: String(fn.name ?? ""), arguments: parsed.arguments, ...(parsed.error ? { argumentsError: parsed.error } : {}) };
  });
  const usage = json.usage && typeof json.usage === "object" ? (json.usage as Record<string, unknown>) : null;
  const input = usage ? numberOrNull(usage.prompt_tokens) : null;
  const output = usage ? numberOrNull(usage.completion_tokens) : null;
  return {
    text: typeof message.content === "string" ? message.content : "",
    toolCalls,
    usage: input !== null && output !== null ? { inputTokens: input, outputTokens: output } : null,
    ...(typeof choice?.finish_reason === "string" ? { stopReason: choice.finish_reason } : {}),
    raw: json,
  };
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function sumNumbers(first: unknown, ...rest: unknown[]): number | null {
  const head = numberOrNull(first);
  if (head === null) return null;
  return rest.reduce<number>((n, v) => n + (numberOrNull(v) ?? 0), head);
}
