// Architecture as an explicit contract: reads .jgates/architecture.yml and evaluates a normalized
// dependency graph with the graph policies of the quality sidecar, through the JSON bridge (operation "architecture").
//
// Rule: an empty or partial graph never proves the absence of violations. Unresolved dependencies are a gap in
// coverage, and a required architecture check over a graph that is not complete ends `incomplete`, never `passed`.
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { loadProjectConfig } from "../config/load/index.js";
import { resolvePython, resolveSidecarDir } from "../bridge/index.js";
import { runSpec } from "../runner/index.js";
import type {
  ArchitectureContract,
  ArchitectureEvaluation,
  ArchitectureFinding,
  ArchitectureState,
  GraphCoverage,
  NormalizedGraph,
} from "./types.js";

export * from "./types.js";
export { architectureReferenceProblems } from "./references.js";

export const ARCHITECTURE_FILE = ".jgates/architecture.yml";
const t = translator("architecture");

/** An empty graph, the starting point of an extractor. */
export function emptyGraph(extractor?: string): NormalizedGraph {
  return { nodes: [], edges: [], unresolved: [], coverage: extractor ? { extractor } : {} };
}

export interface ArchitectureDeclaration {
  /** Project-relative file that declares the rules (the findings point at it). */
  file: string;
  contract: ArchitectureContract;
}

export interface ReadArchitectureResult {
  /** null when the project has no architecture.yml. */
  declaration: ArchitectureDeclaration | null;
  /** Diagnostics of the file (syntax, schema, references); empty when valid. */
  problems: Array<{ code: string; path: string; message: string; line?: number }>;
}

/** Reads and validates .jgates/architecture.yml (syntax, schema and layer references). Never throws. */
export function readArchitecture(projectDir: string): ReadArchitectureResult {
  const loaded = loadProjectConfig(projectDir);
  const doc = loaded.byKind.architecture;
  if (!doc) return { declaration: null, problems: [] };
  const problems = loaded.diagnostics
    .filter((d) => d.file === doc.file)
    .map((d) => ({ code: d.code, path: d.path, message: d.message, ...(d.line ? { line: d.line } : {}) }));
  if (problems.length > 0) return { declaration: null, problems };
  const value = doc.value as { architecture?: ArchitectureContract };
  return { declaration: { file: doc.file, contract: value.architecture ?? {} }, problems };
}

interface BridgeArchitectureResponse {
  ok: boolean;
  verified?: boolean;
  coverage?: GraphCoverage;
  rules?: ArchitectureEvaluation["rules"];
  findings?: ArchitectureFinding[];
  error?: { code: string; message: string };
}

/** Pure decision over a bridge answer; the CLI and the adapters share it. */
export function decideArchitecture(response: BridgeArchitectureResponse, required: boolean): ArchitectureEvaluation {
  const coverage: GraphCoverage = response.coverage ?? { status: "empty", extractor: null, nodes: 0, edges: 0, unresolved: 0, unresolvedSample: [], reasons: [] };
  const findings = response.findings ?? [];
  const base = { required, coverage, rules: response.rules ?? [], findings };
  const verified = response.verified === true && coverage.status === "complete";
  const blocking = findings.filter((f) => f.blocking).length;
  if (blocking > 0) return { ...base, state: "failed", verified, reason: t("architecture_failed", { count: blocking }) };
  if (!verified) {
    const reason = coverage.status === "empty" ? t("architecture_incomplete_empty") : t("architecture_incomplete_partial", { unresolved: coverage.unresolved });
    if (required) return { ...base, state: "incomplete", verified, reason };
    return { ...base, state: "passed", verified, reason: coverage.status === "empty" ? reason : t("architecture_partial_not_required", { unresolved: coverage.unresolved }) };
  }
  return { ...base, state: "passed", verified, reason: t("architecture_passed") };
}

export interface EvaluateOptions {
  graph: NormalizedGraph;
  declaration: ArchitectureDeclaration;
  /** A required architecture check: a graph that is not complete cannot end passed. */
  required: boolean;
  /** Working folder of the child process (never the workspace). */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function incomplete(options: EvaluateOptions, detail: string): ArchitectureEvaluation {
  return {
    state: "incomplete",
    verified: false,
    required: options.required,
    coverage: { status: "empty", extractor: options.graph.coverage.extractor ?? null, nodes: 0, edges: 0, unresolved: 0, unresolvedSample: [], reasons: [{ code: "bridge-failed", message: detail }] },
    rules: [],
    findings: [],
    reason: t("architecture_incomplete_bridge", { detail }),
  };
}

/** Evaluates the graph against the declared contract through the sidecar bridge. Never throws for sidecar problems. */
export async function evaluateArchitecture(options: EvaluateOptions): Promise<ArchitectureEvaluation> {
  const env = options.env ?? process.env;
  const { interpreter } = resolvePython(env);
  if (!interpreter) return incomplete(options, "Python não encontrado");
  const sidecarDir = resolveSidecarDir(env);
  if (!sidecarDir) return incomplete(options, "sidecar de qualidade não encontrado");
  const request = {
    schemaVersion: 1,
    operation: "architecture",
    required: options.required,
    graph: options.graph,
    architecture: { ...options.declaration.contract, file: options.declaration.file },
  };
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    PYTHONPATH: env.PYTHONPATH ? `${sidecarDir}${path.delimiter}${env.PYTHONPATH}` : sidecarDir,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
  const result = await runSpec(
    {
      executable: interpreter,
      args: ["-m", "quality_sidecar", "bridge"],
      cwd: options.cwd,
      stdin: JSON.stringify(request),
      timeoutMs: options.timeoutMs ?? 120_000,
      ...(options.signal ? { signal: options.signal } : {}),
    },
    { parentEnv: childEnv, envAllowlist: Object.keys(childEnv) },
  );
  if (result.spawnError) return incomplete(options, result.spawnError.message);
  if (result.timedOut) return incomplete(options, "a ponte não respondeu a tempo");
  let response: BridgeArchitectureResponse;
  try {
    response = JSON.parse(result.stdout.trim()) as BridgeArchitectureResponse;
  } catch {
    return incomplete(options, "a ponte não devolveu um documento JSON");
  }
  if (!response.ok) return incomplete(options, response.error ? `${response.error.code}: ${response.error.message}` : "a ponte recusou o pedido");
  return decideArchitecture(response, options.required);
}

export function isBlocking(state: ArchitectureState): boolean {
  return state !== "passed";
}
