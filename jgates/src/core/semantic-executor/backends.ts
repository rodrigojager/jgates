// The two backends of an investigation. Each runs one context (a fresh conversation, or a fresh process) of one
// stage inside the limits JGates gives it, and returns the final text for JGates to validate.
//
// provider tool loop: one conversation per context with the provider's tool calling (Anthropic Messages or
// OpenAI-compatible chat, or the scripted mock); every tool call is executed by the host tools, inside the scope
// guard. agent CLI: one restricted process per context (Claude Code with read-only tools, Codex in its read-only
// sandbox) started in a staged copy of the readable scope; its process status is reported as it is, and its claims
// count only from the validated final artifact. Both stop on the run's signal; the agent CLI's process tree is owned by
// the run and stopped with it (core/runner), nothing else.
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ENV_ALLOWLIST, runSpec, type ExecutionResult } from "../runner/process.js";
import { runInScope } from "../runner/scope.js";
import { estimateTokens, type BudgetMeter, type CallUsage } from "./budget.js";
import type { ContextState, HostTools, ToolCallInput, ToolResultOutput, ToolSpec } from "./host-tools.js";
import type { InvestigationStageSpec } from "./types.js";

/** One message of a tool conversation (the semantic-gate package's provider-neutral shape). */
export type ToolMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCallInput[] }
  | { role: "tool"; results: ToolResultOutput[] };

export interface TurnRequest {
  system: string;
  messages: ToolMessage[];
  tools: ToolSpec[];
  toolChoice: "auto" | "none";
  config: Record<string, unknown>;
  contextLabel: string;
  signal: AbortSignal;
  script?: unknown;
  maxOutputTokens?: number;
}

export interface TurnResponse {
  text: string;
  toolCalls: ToolCallInput[];
  usage: { inputTokens: number; outputTokens: number } | null;
  stopReason?: string;
}

export type CallTurn = (request: TurnRequest) => Promise<TurnResponse>;

export interface TranscriptEntry {
  turn: number;
  at: string;
  role: "system" | "user" | "assistant" | "tool" | "process";
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  results?: Array<{ callId: string; name: string; isError: boolean; content: string }>;
  usage?: CallUsage;
  final?: boolean;
  process?: Record<string, unknown>;
}

export interface ContextRunSpec {
  stage: InvestigationStageSpec;
  label: string;
  system: string;
  brief: string;
  state: ContextState;
  tools: HostTools;
  meter: BudgetMeter;
  maxTurns: number;
  callTimeoutMs: number;
  signal: AbortSignal;
  transcript: TranscriptEntry[];
  /** After every model call (events and checkpoints). */
  onCall: (info: { turn: number; usage: CallUsage }) => void;
  now: () => Date;
}

export type ContextStatus = "answered" | "budget" | "cancelled" | "error" | "timeout";

export interface ContextRunResult {
  status: ContextStatus;
  text: string | null;
  turns: number;
  budget?: { dimension: string; message: string };
  error?: string;
  notes: string[];
  /** The last call was a forced conclusion: the stage's budget share or the context's turn limit was reached. */
  forced?: "budget-share" | "max-turns";
}

export interface InvestigationBackend {
  kind: "provider-tools" | "agent-cli";
  describe: Record<string, unknown>;
  /** Runs before the first context (the agent CLI stages its folder and checks the CLI version). */
  prepare?(signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }>;
  runContext(spec: ContextRunSpec): Promise<ContextRunResult>;
  dispose?(): void;
}

export const FINAL_NOTE =
  "HOST NOTICE: this is the last model call your budget allows for this context. Do not call tools now: answer only with the final JSON artifact described in your instructions, stating in it what you could not examine.";

class Timeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("cancelled"));
    const timer = setTimeout(() => reject(new Timeout(`no answer within ${Math.round(ms)} ms`)), Math.max(1, ms));
    const onAbort = (): void => reject(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}

const chars = (messages: ToolMessage[]): number =>
  messages.reduce((n, m) => n + (m.role === "user" ? m.text.length : m.role === "assistant" ? m.text.length + JSON.stringify(m.toolCalls).length : m.results.reduce((k, r) => k + r.content.length, 0)), 0);

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);

// ---- provider tool loop ---------------------------------------------------------------------------------------------

export function providerToolBackend(options: { callTurn: CallTurn; config: Record<string, unknown>; script?: unknown; maxOutputTokens?: number; provider: string | null; model: string | null }): InvestigationBackend {
  return {
    kind: "provider-tools",
    describe: { kind: "provider-tools", provider: options.provider, model: options.model },
    async runContext(spec) {
      const notes: string[] = [];
      const messages: ToolMessage[] = [{ role: "user", text: spec.brief }];
      const toolSpecs = spec.tools.specs(spec.stage.reportsCandidates === true);
      spec.transcript.push({ turn: 0, at: spec.now().toISOString(), role: "system", text: spec.system });
      spec.transcript.push({ turn: 0, at: spec.now().toISOString(), role: "user", text: spec.brief });
      for (let turn = 1; ; turn++) {
        if (spec.signal.aborted) return { status: "cancelled", text: null, turns: turn - 1, notes };
        const check = spec.meter.check(spec.stage.role);
        if (!check.ok) return { status: "budget", text: null, turns: turn - 1, budget: { dimension: check.dimension, message: check.message }, notes };
        const final = check.finalCall || turn >= spec.maxTurns;
        const sent: ToolMessage[] = final ? [...messages, { role: "user", text: FINAL_NOTE }] : messages;
        if (final) spec.transcript.push({ turn, at: spec.now().toISOString(), role: "user", text: FINAL_NOTE, final: true });
        let response: TurnResponse;
        try {
          response = await withTimeout(
            options.callTurn({
              system: spec.system,
              messages: sent,
              tools: toolSpecs,
              toolChoice: final ? "none" : "auto",
              config: options.config,
              contextLabel: spec.label,
              signal: spec.signal,
              ...(options.script !== undefined ? { script: options.script } : {}),
              ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
            }),
            Math.min(spec.callTimeoutMs, check.timeLeftMs),
            spec.signal,
          );
        } catch (error) {
          if (spec.signal.aborted) return { status: "cancelled", text: null, turns: turn - 1, notes };
          // A call that started counts against the budget even without an answer.
          spec.meter.record(spec.stage.id, { inputTokens: estimateTokens(spec.system.length + chars(sent)), outputTokens: 0, reported: false });
          if (error instanceof Timeout) return { status: "timeout", text: null, turns: turn, error: errorText(error), notes };
          return { status: "error", text: null, turns: turn, error: errorText(error), notes };
        }
        const usage: CallUsage = response.usage
          ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, reported: true }
          : { inputTokens: estimateTokens(spec.system.length + chars(sent)), outputTokens: estimateTokens(response.text.length + JSON.stringify(response.toolCalls).length), reported: false };
        spec.meter.record(spec.stage.id, usage);
        spec.transcript.push({ turn, at: spec.now().toISOString(), role: "assistant", text: response.text, toolCalls: response.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })), usage, ...(final ? { final: true } : {}) });
        spec.onCall({ turn, usage });
        if (final || response.toolCalls.length === 0) {
          if (response.toolCalls.length > 0) notes.push(`${response.toolCalls.length} tool call(s) on the final turn were not executed`);
          const forced = final ? (check.finalCall ? "budget-share" : "max-turns") : undefined;
          return { status: "answered", text: response.text, turns: turn, notes, ...(forced ? { forced } : {}) };
        }
        const results = response.toolCalls.map((c) => spec.tools.execute(c, spec.state));
        messages.push({ role: "assistant", text: response.text, toolCalls: response.toolCalls }, { role: "tool", results });
        spec.transcript.push({ turn, at: spec.now().toISOString(), role: "tool", results: results.map((r) => ({ callId: r.callId, name: r.name, isError: r.isError, content: r.content })) });
      }
    },
  };
}

// ---- agent CLI wrapper ----------------------------------------------------------------------------------------------

export interface AgentCliGate {
  agentCliInvocation(provider: string, options: { model?: string; workdir: string; reasoningEffort?: string }): { command: string; args: string[]; output: "claude-json" | "text" };
  parseAgentCliOutput(output: "claude-json" | "text", stdout: string): { text: string; usage: { inputTokens: number; outputTokens: number } | null; isError: boolean; costUsd: number | null };
  CLI_REQUIREMENTS: Record<string, { name: string; minimum: string; update: string; install: string }>;
  parseVersion(output: string): string | undefined;
  compareVersions(a: string, b: string): number;
}

export interface AgentCliOptions {
  provider: "claude-code" | "codex-cli";
  gate: AgentCliGate;
  /** The executable (the CLI, or a wrapper such as node). */
  command: string;
  /** Arguments put before the restricted ones (a wrapper's script); they can never remove the restrictions. */
  prefixArgs: string[];
  model: string | null;
  reasoningEffort?: string;
  /** The staged copy of the readable scope (the CLI's working folder). */
  workdir: string;
  /** Where each invocation's stdout/stderr are logged. */
  logsDir: string;
  env: NodeJS.ProcessEnv;
  /** Variables the CLI may receive besides the default allowlist (its login and key names). */
  extraEnv: string[];
  tools: HostTools;
  /** Process events (process-started / process-finished) for the run's event stream. */
  emit: (type: "process-started" | "process-finished", data: Record<string, unknown>) => void;
}

export const CLI_NOTE =
  "You run headless with read-only tools in a folder that holds only the files you may examine. Write nothing, run nothing. Your progress messages are not recorded: only the final JSON artifact counts, and it is validated by the host. End your answer with that JSON object alone.";

export function agentCliBackend(options: AgentCliOptions): InvestigationBackend {
  const staged = new Set<string>();
  let invocation = 0;
  const run = (args: string[], stdin: string | null, timeoutMs: number, signal: AbortSignal, label: string): Promise<ExecutionResult> => {
    invocation++;
    const n = String(invocation).padStart(3, "0");
    const safe = label.replace(/[^A-Za-z0-9_.-]+/g, "-");
    return runInScope(
      {
        stepId: label,
        signal,
        onProcessStart: (info) => options.emit("process-started", { step: "semantic-review", context: label, pid: info.pid, executable: path.basename(info.executable) }),
        onProcessEnd: (r) => options.emit("process-finished", { step: "semantic-review", context: label, pid: r.pid, exitCode: r.exitCode, signal: r.signal, cancelled: r.cancelled, timedOut: r.timedOut, durationMs: r.durationMs }),
      },
      () =>
        runSpec(
          {
            executable: options.command,
            args: [...options.prefixArgs, ...args],
            cwd: options.workdir,
            stdin,
            timeoutMs,
            signal,
            stdoutFile: path.join(options.logsDir, `${n}-${safe}.stdout.log`),
            stderrFile: path.join(options.logsDir, `${n}-${safe}.stderr.log`),
          },
          { parentEnv: options.env, envAllowlist: [...DEFAULT_ENV_ALLOWLIST, ...options.extraEnv] },
        ),
    );
  };
  return {
    kind: "agent-cli",
    describe: { kind: "agent-cli", provider: options.provider, model: options.model, tools: "read-only", workdir: "staged copy of the readable scope" },
    async prepare(signal) {
      fs.mkdirSync(options.workdir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(options.logsDir, { recursive: true, mode: 0o700 });
      const requirement = options.gate.CLI_REQUIREMENTS[options.provider];
      const version = await run(["--version"], null, 30_000, signal, "version");
      if (version.cancelled) return { ok: false, reason: "cancelled" };
      const found = options.gate.parseVersion(`${version.stdout}\n${version.stderr}`);
      if (version.exitCode !== 0 || !found) return { ok: false, reason: `Could not read the ${requirement?.name ?? options.provider} version (${version.spawnError ? version.spawnError.message : `exit ${String(version.exitCode)}`}); install it with: ${requirement?.install ?? "-"}. The model was not called.` };
      if (requirement && options.gate.compareVersions(found, requirement.minimum) < 0) return { ok: false, reason: `${requirement.name} ${found} is older than the minimum ${requirement.minimum}; update with: ${requirement.update}. The model was not called.` };
      // The staged folder: only what the guard allows, masked, never a sensitive or excluded file.
      const stagingContext: ContextState = { stage: "staging", label: "staging", seen: new Set(), refused: [] };
      for (const p of options.tools.readableFiles()) {
        const r = options.tools.readForBrief(p, stagingContext);
        if (!("text" in r)) continue;
        const target = path.join(options.workdir, ...r.path.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, r.text, { mode: 0o600 });
        staged.add(r.path);
      }
      return { ok: true };
    },
    async runContext(spec) {
      const notes: string[] = [];
      if (spec.signal.aborted) return { status: "cancelled", text: null, turns: 0, notes };
      const check = spec.meter.check(spec.stage.role);
      if (!check.ok) return { status: "budget", text: null, turns: 0, budget: { dimension: check.dimension, message: check.message }, notes };
      const inv = options.gate.agentCliInvocation(options.provider, { ...(options.model ? { model: options.model } : {}), workdir: options.workdir, ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}) });
      const prompt = `${spec.system}\n\n${spec.brief}\n\n${CLI_NOTE}`;
      spec.transcript.push({ turn: 1, at: spec.now().toISOString(), role: "user", text: prompt });
      const result = await run(inv.args, prompt, Math.min(spec.callTimeoutMs, check.timeLeftMs), spec.signal, spec.label);
      const processInfo = { pid: result.pid, exitCode: result.exitCode, signal: result.signal, cancelled: result.cancelled, timedOut: result.timedOut, durationMs: result.durationMs, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes };
      if (result.cancelled || spec.signal.aborted) {
        spec.transcript.push({ turn: 1, at: spec.now().toISOString(), role: "process", process: processInfo });
        return { status: "cancelled", text: null, turns: 1, notes };
      }
      const parsed = options.gate.parseAgentCliOutput(inv.output, result.stdout);
      const usage: CallUsage = parsed.usage ? { ...parsed.usage, reported: true } : { inputTokens: estimateTokens(prompt.length), outputTokens: estimateTokens(result.stdout.length), reported: false };
      spec.meter.record(spec.stage.id, usage);
      spec.transcript.push({ turn: 1, at: spec.now().toISOString(), role: "process", process: processInfo });
      spec.transcript.push({ turn: 1, at: spec.now().toISOString(), role: "assistant", text: parsed.text, usage, final: true });
      spec.onCall({ turn: 1, usage });
      if (result.timedOut) return { status: "timeout", text: null, turns: 1, error: `the ${options.provider} process gave no answer in time`, notes };
      if (result.spawnError) return { status: "error", text: null, turns: 1, error: `${options.provider} could not start: ${result.spawnError.message}`, notes };
      if (result.exitCode !== 0 || parsed.isError) return { status: "error", text: null, turns: 1, error: `${options.provider} exited with ${String(result.exitCode)}${parsed.isError ? " (error result)" : ""}: ${result.stderr.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 300)}`, notes };
      // The CLI could open any staged file: those are what this context may cite.
      for (const p of staged) spec.state.seen.add(p);
      return { status: "answered", text: parsed.text, turns: 1, notes };
    },
    dispose() {
      fs.rmSync(options.workdir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  };
}
