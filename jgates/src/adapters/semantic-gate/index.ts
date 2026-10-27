// Semantic gate as an optional integration. It runs only when the project configures it
// (jgates.yml > extensions.semantic-gate with a provider) AND the run asks for it (`jgates run --semantic`); never by
// default, never from a template, and `jgates init` writes no provider. Its conclusion is recorded in `result.semantic`,
// apart from the decision: the hook runs after the decision of the core is computed and cannot change it, so an
// unavailable provider, a timeout or an exhausted budget never approves nor fails the core.
// The review context is filtered (sensitive files, excludes, include) and masked before the prompt is built (mask.ts,
// masking.ts): secrets always, the PII entities and the project's patterns as configured, then the external tools of
// .jgates/pii.yml (core/mask-tools), fail-closed. The providers and the prompt come from the semantic-gate package
// (loaded on demand); the tests pass a fake provider and never spend model tokens. The prompt texts are files of the
// package (semantic-gate/templates) that the project may replace or extend (prompts.ts); the sha256 of the prompts in
// effect is recorded in the outcome and, by the run, in the provenance of the result.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { ResultSemantic, SemanticHook } from "../../core/run/types.js";
import { emptyCounts, isExcluded, isSensitivePath, maskDeep, maskText, strictMaskRules, totalCount, type MaskCounts } from "./mask.js";
import { maskWithTools, parseInclude, parseMasking, toolSummary, type MaskingSettings } from "./masking.js";
import { gatePromptSettings, parsePrompts, promptsRecord, type PromptSettings, type PromptsRecord } from "./prompts.js";
import { vaultBlocked } from "../../core/secrets/index.js";
import { baseUrlProblem, publicResolution, resolveProviderSettings, userPreferencesBlocked, type ProviderResolution } from "../../core/providers/index.js";

export const EXTENSION_KEY = "semantic-gate";
export const ROOT_CONFIG = "jgates.yml";

export type SemanticScope = "changed" | "full" | "paths";

/** What the project declared under extensions.semantic-gate (credentials are never here: only the env var name). */
export interface SemanticSettings {
  provider: string;
  model: string | null;
  scope: SemanticScope;
  paths: string[];
  excludes: string[];
  /** Allow list: when not empty, only these paths go to the provider (excludes and secret files still leave). */
  include: string[];
  masking: MaskingSettings;
  /** Project prompt files (system and review), resolved inside the configuration folder. */
  prompts: PromptSettings;
  /** true when the configuration (and so the prompt files) came from another folder than the workspace (a CI policy). */
  governed: boolean;
  objective: string;
  timeoutSeconds: number;
  maxContextChars: number;
  /** Largest number of provider calls of one review (one per context chunk). */
  maxCalls: number;
  threshold: number;
  baseUrl: string | null;
  /** The project's explicit confirmation that a plain http baseUrl that is not loopback is accepted. */
  allowInsecureHttp: boolean;
  apiKeyEnv: string | null;
  command: string | null;
  commandArgs: string[];
  commandPromptMode: "stdin" | "argument";
  commandOutput: "text" | "json";
  /** Cost per call when the project knows it (currency units); null when not informed. */
  costPerCall: number | null;
}

export interface SemanticState {
  /** off: nothing configured (the default); configured: a provider is set; invalid: the block has problems. */
  state: "off" | "configured" | "invalid";
  provider: string | null;
  model: string | null;
  scope: SemanticScope | null;
  settings: SemanticSettings | null;
  /**
   * The provider fields in effect (baseUrl, model, apiKeyEnv), each with its origin: the project, the user's
   * preferences (a provider's preference or a named connection), or the provider's default. null when off.
   */
  effective: ProviderResolution | null;
  problems: string[];
}

const DEFAULT_OBJECTIVE = "Review the changes for correctness, tests, security, maintainability, architecture and performance.";
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const KNOWN = new Set(["enabled", "provider", "model", "scope", "paths", "excludes", "include", "masking", "prompts", "objective", "timeoutSeconds", "maxContextChars", "maxCalls", "threshold", "baseUrl", "allowInsecureHttp", "apiKeyEnv", "command", "commandArgs", "commandPromptMode", "commandOutput", "costPerCall"]);

/**
 * Reads the block of the workspace. Missing file, missing block or no provider means off. `configDir` is where
 * jgates.yml and .jgates/pii.yml are read from when it is not the workspace (a CI policy, in governed mode).
 * The provider fields the project leaves out come from the user's preferences (core/providers), unless
 * `preferences` is false or the process blocked them (jgates ci), then from the provider's default.
 */
export function readSemanticState(workspacePath: string, options: { configDir?: string; env?: NodeJS.ProcessEnv; preferences?: boolean } = {}): SemanticState {
  const configDir = options.configDir ?? workspacePath;
  const off: SemanticState = { state: "off", provider: null, model: null, scope: null, settings: null, effective: null, problems: [] };
  let block: unknown;
  try {
    const doc = parseYaml(fs.readFileSync(path.join(configDir, ROOT_CONFIG), "utf8")) as unknown;
    block = isRec(doc) && isRec(doc.extensions) ? doc.extensions[EXTENSION_KEY] : undefined;
  } catch {
    return off;
  }
  if (block === undefined || block === null) return off;
  if (!isRec(block)) return { ...off, state: "invalid", problems: [`extensions.${EXTENSION_KEY} must be a mapping`] };
  const problems: string[] = [];
  for (const key of Object.keys(block)) if (!KNOWN.has(key)) problems.push(`extensions.${EXTENSION_KEY}.${key} is not a known option`);
  const num = (key: string, fallback: number, min: number): number => {
    const v = block[key];
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min) {
      problems.push(`extensions.${EXTENSION_KEY}.${key} must be a number >= ${min}`);
      return fallback;
    }
    return v;
  };
  const scopeRaw = block.scope;
  const scope: SemanticScope = scopeRaw === "full" || scopeRaw === "paths" || scopeRaw === "changed" ? scopeRaw : "changed";
  if (scopeRaw !== undefined && scope !== scopeRaw) problems.push(`extensions.${EXTENSION_KEY}.scope must be changed, full or paths`);
  const prefix = `extensions.${EXTENSION_KEY}`;
  const include = parseInclude(block.include, prefix, problems);
  const masking = parseMasking(block.masking, prefix, configDir, problems);
  const prompts = parsePrompts(block.prompts, prefix, configDir, problems);
  const provider = typeof block.provider === "string" && block.provider.trim() !== "" ? block.provider.trim() : null;
  if (block.enabled === false || provider === null) return { ...off, problems, state: problems.length > 0 ? "invalid" : "off" };
  const cost = block.costPerCall;
  const settings: SemanticSettings = {
    provider,
    model: typeof block.model === "string" && block.model !== "" ? block.model : null,
    scope,
    paths: strings(block.paths),
    excludes: strings(block.excludes),
    include,
    masking,
    prompts,
    governed: path.resolve(configDir) !== path.resolve(workspacePath),
    objective: typeof block.objective === "string" && block.objective.trim() !== "" ? block.objective : DEFAULT_OBJECTIVE,
    timeoutSeconds: num("timeoutSeconds", 120, 1),
    maxContextChars: num("maxContextChars", 160_000, 1000),
    maxCalls: num("maxCalls", 4, 1),
    threshold: num("threshold", 90, 0),
    baseUrl: typeof block.baseUrl === "string" && block.baseUrl.trim() !== "" ? block.baseUrl.trim() : null,
    allowInsecureHttp: block.allowInsecureHttp === true,
    apiKeyEnv: typeof block.apiKeyEnv === "string" ? block.apiKeyEnv : null,
    command: typeof block.command === "string" ? block.command : null,
    commandArgs: strings(block.commandArgs),
    commandPromptMode: block.commandPromptMode === "argument" ? "argument" : "stdin",
    commandOutput: block.commandOutput === "json" ? "json" : "text",
    costPerCall: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
  };
  if (settings.baseUrl !== null) {
    const problem = baseUrlProblem(settings.baseUrl, settings.allowInsecureHttp);
    if (problem) problems.push(`${prefix}.baseUrl is refused (${problem}): ${BASE_URL_RULE}`);
  }
  const effective = resolveProviderSettings(
    provider,
    { baseUrl: settings.baseUrl, model: settings.model, apiKeyEnv: settings.apiKeyEnv },
    { env: options.env ?? process.env, ...(options.preferences === false ? { preferences: false } : {}) },
  );
  if (effective.kind === "unknown") {
    problems.push(
      `${prefix}.provider ${provider} is neither a provider of the semantic gate nor a connection of the user's preferences${effective.preferences === "ignored" ? " (the user's preferences are not used here: jgates ci uses only the project and the environment)" : " (jgates providers add <name> creates one)"}`,
    );
  }
  return { state: problems.length > 0 ? "invalid" : "configured", provider, model: effective.model.value, scope, settings, effective, problems };
}

const BASE_URL_RULE = "http or https only, no user, password, query or fragment in it, and plain http only for loopback unless allowInsecureHttp: true confirms it (the key would travel in clear text)";

// ---- the semantic-gate package (loaded on demand) ----------------------------------------------------------------------

export interface ProviderRequest {
  prompt: string;
  system: string;
  config: Record<string, unknown>;
  cwd?: string;
  chunkLabel?: string;
}
export type CallProvider = (request: ProviderRequest) => Promise<{ text: string; raw: unknown }>;

/** The prompts in effect, as the semantic-gate package resolves them (texts plus their hashes). */
export interface EffectivePrompts {
  system: string;
  review: string;
  info: { sha256: string; system: { mode: string; sha256: string }; review: { mode: string; sha256: string } };
}

interface Gate {
  defaultConfig: Record<string, unknown>;
  collectGitReviewContext(cwd: string, config: Record<string, unknown>): Promise<any>;
  buildPromptChunks(objective: { text: string; source: string }, context: any, config: Record<string, unknown>, prompts?: EffectivePrompts): Array<{ label: string; prompt: string }>;
  systemPrompt(prompts?: EffectivePrompts): string;
  resolvePrompts(settings?: Record<string, { mode: string; file: string }>): EffectivePrompts;
  parseProviderResult(text: string): unknown;
  normalizeGateResult(parsed: unknown, context: Record<string, unknown>): any;
  mergeLocalFallbackResult(parts: any[], context: Record<string, unknown>): any;
  callProvider: CallProvider;
}

function distCandidates(env: NodeJS.ProcessEnv): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [env.JGATES_SEMANTIC_GATE_DIST, path.resolve(here, "..", "..", "..", "..", "semantic-gate", "dist"), path.resolve(here, "..", "..", "..", "node_modules", "semantic-gate", "dist")].filter((p): p is string => !!p);
}

export async function loadGate(env: NodeJS.ProcessEnv = process.env): Promise<Gate> {
  for (const dir of distCandidates(env)) {
    if (!fs.existsSync(path.join(dir, "providers.js"))) continue;
    const load = (name: string): Promise<any> => import(pathToFileURL(path.join(dir, name)).href);
    const [config, context, prompt, result, providers] = await Promise.all([load("config.js"), load("context.js"), load("prompt.js"), load("result.js"), load("providers.js")]);
    if (typeof prompt.resolvePrompts !== "function") throw new Error(`the semantic-gate package at ${dir} is too old (no prompt files); rebuild it`);
    return {
      defaultConfig: config.defaultConfig,
      collectGitReviewContext: context.collectGitReviewContext,
      buildPromptChunks: prompt.buildPromptChunks,
      systemPrompt: prompt.systemPrompt,
      resolvePrompts: prompt.resolvePrompts,
      parseProviderResult: result.parseProviderResult,
      normalizeGateResult: result.normalizeGateResult,
      mergeLocalFallbackResult: result.mergeLocalFallbackResult,
      callProvider: providers.callProvider,
    };
  }
  throw new Error("the semantic-gate package is not built (semantic-gate/dist)");
}

/** The model listing of the semantic-gate package (jgates secrets test): lists the models with the key, no token spent. */
export interface ModelLister {
  defaultConfig: Record<string, unknown>;
  listProviderModels(config: Record<string, unknown>): Promise<Array<{ id: string }>>;
}

export async function loadModelLister(env: NodeJS.ProcessEnv = process.env): Promise<ModelLister> {
  for (const dir of distCandidates(env)) {
    if (!fs.existsSync(path.join(dir, "providers.js"))) continue;
    const load = (name: string): Promise<any> => import(pathToFileURL(path.join(dir, name)).href);
    const [config, providers] = await Promise.all([load("config.js"), load("providers.js")]);
    return { defaultConfig: config.defaultConfig, listProviderModels: providers.listProviderModels };
  }
  throw new Error("the semantic-gate package is not built (semantic-gate/dist)");
}

// ---- the review ---------------------------------------------------------------------------------------------------------

export interface SemanticDeps {
  /** Replaces the provider call (tests pass a fake). */
  callProvider?: CallProvider;
  /** Replaces the package loader (tests). */
  loadGate?: () => Promise<Gate>;
}

class Timeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Timeout(`no answer within ${ms} ms`)), ms);
    const onAbort = (): void => reject(new Error("cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
  });
}

// Text of the result (reasons, findings) is masked with every entity on, whatever the context settings say.
const brief = (text: string): string => maskText(text, {}, strictMaskRules()).replace(/\s+/g, " ").slice(0, 300);

function baseOutcome(state: SemanticState, extra: Partial<ResultSemantic> = {}, prompts?: PromptsRecord): ResultSemantic {
  const s = state.settings;
  return {
    requested: true,
    state: "not-configured",
    separateFromDecision: true,
    provider: state.provider,
    model: state.model,
    scope: state.scope,
    limits: s ? { timeoutSeconds: s.timeoutSeconds, maxContextChars: s.maxContextChars, maxCalls: s.maxCalls } : null,
    cost: { reported: s?.costPerCall != null, perCall: s?.costPerCall ?? null, total: null },
    calls: 0,
    ...(state.effective ? { effective: publicResolution(state.effective) } : {}),
    ...(prompts ? { prompts } : {}),
    ...extra,
  };
}

/**
 * The review of one run. Returns an outcome for every request, including the cases where nothing could be sent
 * (not configured, invalid, package missing, budget); the provider is called only when everything before holds.
 */
export async function runSemanticReview(
  workspacePath: string,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; now?: () => Date; configDir?: string; vault?: boolean; preferences?: boolean },
  deps: SemanticDeps = {},
): Promise<ResultSemantic> {
  const started = Date.now();
  const env = options.env ?? process.env;
  // The user key store gives the key a provider declares (apiKeyEnv or its default name) and the names of passEnv of
  // the PII tools, to that process only; a run that must use only the environment (jgates ci) never reads it.
  const vault = options.vault !== false && !vaultBlocked();
  // The user's provider preferences fill what the project leaves out; jgates ci (blocked) uses only the project.
  const preferences = options.preferences !== false && !userPreferencesBlocked();
  const state = readSemanticState(workspacePath, { env, preferences, ...(options.configDir ? { configDir: options.configDir } : {}) });
  const done = (outcome: ResultSemantic): ResultSemantic => ({ ...outcome, durationMs: Date.now() - started });
  if (state.state === "off" || !state.settings) {
    return done(baseOutcome(state, { state: "not-configured", reason: "No provider is configured (jgates.yml > extensions.semantic-gate.provider); nothing was sent." }));
  }
  if (state.state === "invalid") {
    return done(baseOutcome(state, { state: "not-configured", reason: `The semantic-gate settings are invalid: ${state.problems.join("; ")}` }));
  }
  const s = state.settings;
  const eff = state.effective as ProviderResolution;
  let gate: Gate;
  try {
    gate = await (deps.loadGate ?? (() => loadGate(env)))();
  } catch (error) {
    return done(baseOutcome(state, { state: "unavailable", reason: brief(error instanceof Error ? error.message : String(error)) }));
  }
  // The prompt files are read once, before anything is collected: the hash recorded is the one of the texts sent.
  let prompts: EffectivePrompts;
  let promptsInfo: PromptsRecord;
  try {
    prompts = gate.resolvePrompts(gatePromptSettings(s.prompts));
    promptsInfo = promptsRecord(prompts.info, s.prompts, s.governed);
  } catch (error) {
    return done(baseOutcome(state, { state: "unavailable", reason: `${brief(error instanceof Error ? error.message : String(error))}; nothing was sent.` }));
  }
  const outcome = (extra: Partial<ResultSemantic>): ResultSemantic => baseOutcome(state, extra, promptsInfo);
  const config: Record<string, unknown> = {
    ...gate.defaultConfig,
    scope: s.scope,
    provider: s.provider,
    threshold: s.threshold,
    paths: s.paths,
    excludes: s.excludes,
    maxContextChars: s.maxContextChars,
    timeoutMs: s.timeoutSeconds * 1000,
    writeReports: false,
    // Only the values of the project and of the user go in: the provider's defaults are applied by the package.
    ...(eff.model.value ? { model: eff.model.value } : {}),
    ...(eff.baseUrl.value && eff.baseUrl.origin !== "default" ? { baseUrl: eff.baseUrl.value } : {}),
    ...(eff.apiKeyEnv.value && eff.apiKeyEnv.origin !== "default" ? { apiKeyEnv: eff.apiKeyEnv.value } : {}),
    ...(eff.kind === "connection" ? { connection: s.provider, headers: eff.headerValues } : {}),
    ...((eff.baseUrl.origin === "project" && s.allowInsecureHttp) || eff.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
    ...(s.command ? { command: s.command, commandArgs: s.commandArgs } : {}),
    commandPromptMode: s.commandPromptMode,
    commandOutput: s.commandOutput,
    ...(vault ? {} : { secretStore: false }),
  };

  // 1. Collect, then exclude and mask: nothing of the raw context reaches the prompt builder.
  const rules = s.masking;
  const counts: MaskCounts = emptyCounts(rules);
  let context: any;
  try {
    context = await gate.collectGitReviewContext(workspacePath, config);
  } catch (error) {
    return done(outcome({ state: "unavailable", reason: brief(error instanceof Error ? error.message : String(error)) }));
  }
  const excluded: Array<{ path: string; reason: string }> = [];
  const kept = (context.changedFiles as Array<{ path: string }>).filter((f) => {
    if (isSensitivePath(f.path)) return excluded.push({ path: f.path, reason: "sensitive-file" }), false;
    if (isExcluded(f.path, s.excludes)) return excluded.push({ path: f.path, reason: "excluded" }), false;
    if (s.include.length > 0 && !isExcluded(f.path, s.include)) return excluded.push({ path: f.path, reason: "not-included" }), false;
    return true;
  });
  const safe = maskDeep({ ...context, changedFiles: kept }, counts, rules);
  const objective = { text: maskText(s.objective, counts, rules), source: "jgates.yml" };
  let tools: Array<Record<string, unknown>> | undefined;
  const contextInfo = (): Record<string, unknown> => ({
    files: kept.length,
    excluded,
    masked: { total: totalCount(counts), ...counts },
    ...(tools ? { tools } : {}),
  });
  const blocked = (): ResultSemantic =>
    done(
      outcome({
        state: "blocked",
        code: "MASKING_BLOCKED",
        reason: `The masking found ${totalCount(counts) > 0 ? `${totalCount(counts)} value(s)` : "sensitive data"} and masking.onMatch is block; nothing was sent.`,
        context: contextInfo(),
      }),
    );
  if (rules.onMatch === "block" && totalCount(counts) > 0) return blocked();

  // The external tools of .jgates/pii.yml work on a copy of the masked file texts; any doubt sends nothing.
  if (rules.tools.length > 0 && kept.length > 0) {
    const masked = await maskWithTools(safe.changedFiles as Array<Record<string, unknown>>, rules.tools, { env, vault, ...(options.signal ? { signal: options.signal } : {}) });
    tools = toolSummary(masked.outcomes);
    for (const [label, n] of Object.entries(masked.counts)) counts[label] = (counts[label] ?? 0) + n;
    if (!masked.ok) {
      return done(outcome({ state: "unavailable", code: masked.code, reason: `${brief(masked.reason)}; nothing was sent.`, context: contextInfo() }));
    }
    if (rules.onMatch === "block" && (masked.detected || totalCount(counts) > 0)) return blocked();
    safe.changedFiles = masked.files;
  }

  // 2. Prompt and budget.
  let chunks: Array<{ label: string; prompt: string }>;
  try {
    chunks = kept.length === 0 ? [] : gate.buildPromptChunks(objective, safe, config, prompts);
  } catch (error) {
    return done(outcome({ state: "budget-exhausted", reason: brief(error instanceof Error ? error.message : String(error)), context: contextInfo() }));
  }
  if (kept.length === 0) {
    return done(outcome({ state: "unavailable", reason: "No file matched the scope after the exclusions; nothing was sent.", context: contextInfo() }));
  }
  if (chunks.length > s.maxCalls) {
    return done(outcome({ state: "budget-exhausted", reason: `The context needs ${chunks.length} calls and the limit is ${s.maxCalls}; nothing was sent.`, context: { ...contextInfo(), chunks: chunks.length } }));
  }

  // 3. Calls. Any failure leaves the core decision as it was; the outcome says why.
  const call = deps.callProvider ?? gate.callProvider;
  const parts: any[] = [];
  let calls = 0;
  const gateContext = { config, objective, gitContext: safe, provider: s.provider, ...(eff.model.value ? { model: eff.model.value } : {}) };
  for (const chunk of chunks) {
    calls++;
    try {
      const response = await withTimeout(call({ prompt: chunk.prompt, system: gate.systemPrompt(prompts), config, cwd: workspacePath, chunkLabel: chunk.label }), s.timeoutSeconds * 1000, options.signal);
      parts.push(gate.normalizeGateResult(gate.parseProviderResult(response.text), gateContext));
    } catch (error) {
      const timedOut = error instanceof Timeout || /timed out|timeout/i.test(error instanceof Error ? error.message : "");
      return done(outcome({ state: timedOut ? "timeout" : "unavailable", reason: brief(error instanceof Error ? error.message : String(error)), context: contextInfo(), calls }));
    }
  }
  const merged = parts.length === 1 ? parts[0] : gate.mergeLocalFallbackResult(parts, gateContext);
  const findings = (merged.findings as Array<Record<string, unknown>>).map((f) => ({
    severity: String(f.severity ?? ""),
    category: String(f.category ?? ""),
    ...(typeof f.path === "string" ? { path: f.path } : {}),
    ...(typeof f.line === "number" ? { line: f.line } : {}),
    message: brief(String(f.message ?? "")),
  }));
  return done(
    outcome({
      state: "completed",
      context: contextInfo(),
      calls,
      cost: { reported: s.costPerCall != null, perCall: s.costPerCall, total: s.costPerCall != null ? s.costPerCall * calls : null },
      conclusion: {
        status: String(merged.status),
        score: Number(merged.score),
        threshold: Number(merged.threshold),
        summary: brief(String(merged.approvalNotes ?? merged.changesReviewed ?? "")),
        hardBlockers: (merged.hardBlockers as unknown[]).map((b) => brief(String(b))),
        findings,
      },
    }),
  );
}

/** The hook of one run: absent when the run did not ask for the semantic gate (then nothing is loaded nor called). */
export function semanticHook(requested: boolean, deps: SemanticDeps = {}): SemanticHook | undefined {
  if (!requested) return undefined;
  return (ctx) => runSemanticReview(ctx.workspacePath, { env: ctx.env, ...(ctx.signal ? { signal: ctx.signal } : {}) }, deps);
}
