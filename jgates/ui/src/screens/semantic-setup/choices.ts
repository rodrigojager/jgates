// The run-only choices of a Semantic run: purpose or explicit methods, rigor, budget and context limits (configuration screen) plus the scope
// (setup screen). None of them is written to jgates.yml: the saved settings (provider, model, limits) are edited in the
// semantic gate card. They are kept in this browser's localStorage only as the defaults of the next setup, and travel
// as the body of POST /api/semantic/scope/preview and POST /api/semantic/runs.

export type Purpose = "general-review" | "security";
export type Rigor = "quick" | "standard" | "deep";
export type ScopeMode = "full" | "selected" | "incremental";
export type DirtyMode = "none" | "all" | "paths";

export interface RunChoices {
  purpose: Purpose;
  /** Methods named explicitly, in order; empty: the purpose's methods. Each one runs as its own Semantic run. */
  methods: string[];
  rigor: Rigor;
  /** Empty: the saved settings' limit applies. */
  maxCalls: string;
  maxTokens: string;
  contextPolicy: "strict" | "bounded";
  maxFiles: string;
  maxDepth: string;
  maxBytes: string;
}

export interface ScopeChoices {
  mode: ScopeMode;
  /** One path, folder or glob per line (selected mode). */
  subjects: string;
  /** One subsystem of .jgates/architecture.yml per line (selected mode). */
  subsystems: string;
  /** One glob per line, never examined nor read. */
  exclusions: string;
  base: string;
  target: string;
  dirty: DirtyMode;
  dirtyPaths: string;
  /** Reuse prior evidence of the latest Semantic run (after current checks). */
  baseline: boolean;
}

export const DEFAULT_CHOICES: RunChoices = { purpose: "general-review", methods: [], rigor: "standard", maxCalls: "", maxTokens: "", contextPolicy: "strict", maxFiles: "", maxDepth: "", maxBytes: "" };
export const DEFAULT_SCOPE: ScopeChoices = { mode: "full", subjects: "", subsystems: "", exclusions: "", base: "", target: "", dirty: "none", dirtyPaths: "", baseline: false };

const CHOICES_KEY = "jgates.semantic.choices";
const SCOPE_KEY = "jgates.semantic.scope";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    // Storage blocked or unreadable: the defaults serve.
  }
  return fallback;
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not kept; the current screen still uses the value.
  }
}

export const readChoices = (): RunChoices => {
  const c = read(CHOICES_KEY, DEFAULT_CHOICES);
  // Choices kept by an earlier version have no methods; anything that is not a list of IDs is dropped.
  return { ...c, methods: Array.isArray(c.methods) ? c.methods.filter((m): m is string => typeof m === "string" && /^[a-z][a-z0-9-]{1,63}$/.test(m)) : [] };
};
export const writeChoices = (c: RunChoices): void => write(CHOICES_KEY, c);
export const readScope = (): ScopeChoices => read(SCOPE_KEY, DEFAULT_SCOPE);
export const writeScope = (s: ScopeChoices): void => write(SCOPE_KEY, s);

const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

const int = (text: string): number | undefined => {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};

/** Problems the server would refuse, said before asking it (keys of the setup screen's catalog). */
export function problemsOf(choices: RunChoices, scope: ScopeChoices): string[] {
  const out: string[] = [];
  for (const [field, value] of [["maxCalls", choices.maxCalls], ["maxTokens", choices.maxTokens], ["maxFiles", choices.maxFiles], ["maxDepth", choices.maxDepth], ["maxBytes", choices.maxBytes]] as const) {
    if (value.trim() !== "" && int(value) === undefined) out.push(`semsetup_problem_number_${field}`);
  }
  if (scope.mode === "selected" && lines(scope.subjects).length + lines(scope.subsystems).length === 0) out.push("semsetup_problem_subjects");
  if (scope.mode === "incremental" && scope.base.trim() === "") out.push("semsetup_problem_base");
  if (scope.mode === "incremental" && scope.dirty === "paths" && lines(scope.dirtyPaths).length === 0) out.push("semsetup_problem_dirty");
  return out;
}

/** The request body shared by the preview and the start of a run (the same JSON Schema on the server). */
export function requestBody(choices: RunChoices, scope: ScopeChoices): Record<string, unknown> {
  const budget: Record<string, number> = {};
  const maxCalls = int(choices.maxCalls);
  const maxTokens = int(choices.maxTokens);
  if (maxCalls !== undefined) budget.maxCalls = maxCalls;
  if (maxTokens !== undefined) budget.maxTokens = maxTokens;
  const context: Record<string, unknown> = { policy: choices.contextPolicy };
  for (const [key, value] of [["maxFiles", choices.maxFiles], ["maxDepth", choices.maxDepth], ["maxBytes", choices.maxBytes]] as const) {
    const n = int(value);
    if (n !== undefined) context[key] = n;
  }
  const request: Record<string, unknown> = { mode: scope.mode, context };
  const exclusions = lines(scope.exclusions);
  if (exclusions.length > 0) request.exclusions = exclusions;
  if (scope.mode === "selected") {
    request.subjects = [...lines(scope.subjects).map((value) => ({ kind: "path", value })), ...lines(scope.subsystems).map((value) => ({ kind: "subsystem", value }))];
  }
  if (scope.mode === "incremental") {
    request.base = scope.base.trim();
    if (scope.target.trim() !== "") request.target = scope.target.trim();
    request.dirty = scope.dirty === "paths" ? lines(scope.dirtyPaths) : scope.dirty;
  }
  if (scope.baseline) request.baseline = "latest";
  return { purpose: choices.purpose, ...(choices.methods.length > 0 ? { methods: choices.methods } : {}), rigor: choices.rigor, ...(Object.keys(budget).length > 0 ? { budget } : {}), scope: request };
}
