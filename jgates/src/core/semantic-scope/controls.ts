// The scope controls every Semantic module offers (CLI flags, API body, the run setup screen). They are the same for
// every purpose (general review, security) by construction: the purpose is accepted only to say so, and neither it nor
// rigor or budget is an input of a resolution.
import { CONTEXT_POLICIES, DEFAULT_CONTEXT_LIMITS, SEMANTIC_PURPOSES, SEMANTIC_RIGORS, type ScopeRequest, type SemanticPurpose } from "./types.js";

export interface ScopeControls {
  schemaVersion: 1;
  modes: Array<{ id: "full" | "selected" | "incremental"; recommended: boolean; requires: string[] }>;
  defaultMode: "full";
  subjects: { kinds: Array<"path" | "subsystem">; subsystemSource: string };
  exclusions: { strict: true; syntax: "glob" };
  comparison: { base: { required: "incremental" }; target: { default: "HEAD" }; dirty: Array<"none" | "all" | "paths">; defaultDirty: "none" };
  baseline: { values: string[]; default: null; reuse: "current-checks-only" };
  context: {
    policies: typeof CONTEXT_POLICIES;
    defaultPolicy: "strict";
    limits: { maxFiles: { default: number; min: 0 }; maxDepth: { default: number; min: 0 }; maxBytes: { default: number; min: 0 } };
    explicitAllow: true;
  };
  /** Controls that never change the resolved scope. */
  independentOf: Array<"purpose" | "rigor" | "budget">;
  purposes: typeof SEMANTIC_PURPOSES;
  rigors: typeof SEMANTIC_RIGORS;
}

/** The choices of a run as `jgates semantic run` flags (the server starts runs through the CLI). */
export function semanticChoiceArgs(choices: {
  purpose?: SemanticPurpose;
  rigor?: string;
  budget?: { maxCalls?: number; maxTokens?: number };
  scope?: ScopeRequest | null;
}): string[] {
  // Always --name=value: a value that starts with a dash is never read as another flag.
  const args: string[] = [];
  const flag = (name: string, value: string | number): void => void args.push(`--${name}=${value}`);
  const s = choices.scope;
  if (choices.purpose) flag("purpose", choices.purpose);
  if (choices.rigor) flag("rigor", choices.rigor);
  if (choices.budget?.maxCalls !== undefined) flag("budget-calls", choices.budget.maxCalls);
  if (choices.budget?.maxTokens !== undefined) flag("budget-tokens", choices.budget.maxTokens);
  if (!s) return args;
  flag("scope", s.mode ?? "full");
  for (const subject of s.subjects ?? []) flag(subject.kind === "subsystem" ? "subsystem" : "path", subject.value);
  for (const e of s.exclusions ?? []) flag("exclude", e);
  if (s.base) flag("base", s.base);
  if (s.target) flag("target", s.target);
  if (s.dirty !== undefined) for (const d of Array.isArray(s.dirty) ? s.dirty : [s.dirty]) flag("dirty", d);
  if (s.baseline) flag("baseline", s.baseline);
  if (s.context?.policy) flag("context-policy", s.context.policy);
  if (s.context?.maxFiles !== undefined) flag("context-max-files", s.context.maxFiles);
  if (s.context?.maxDepth !== undefined) flag("context-max-depth", s.context.maxDepth);
  if (s.context?.maxBytes !== undefined) flag("context-max-bytes", s.context.maxBytes);
  for (const a of s.context?.allow ?? []) flag("allow-context", a);
  return args;
}

/** The scope controls of a purpose: identical for every purpose. */
export function scopeControls(_purpose: SemanticPurpose = "general-review"): ScopeControls {
  return {
    schemaVersion: 1,
    modes: [
      { id: "full", recommended: true, requires: [] },
      { id: "selected", recommended: false, requires: ["subjects"] },
      { id: "incremental", recommended: false, requires: ["base"] },
    ],
    defaultMode: "full",
    subjects: { kinds: ["path", "subsystem"], subsystemSource: ".jgates/architecture.yml#layers" },
    exclusions: { strict: true, syntax: "glob" },
    comparison: { base: { required: "incremental" }, target: { default: "HEAD" }, dirty: ["none", "all", "paths"], defaultDirty: "none" },
    baseline: { values: ["latest", "sem_<id>"], default: null, reuse: "current-checks-only" },
    context: {
      policies: CONTEXT_POLICIES,
      defaultPolicy: "strict",
      limits: {
        maxFiles: { default: DEFAULT_CONTEXT_LIMITS.maxFiles, min: 0 },
        maxDepth: { default: DEFAULT_CONTEXT_LIMITS.maxDepth, min: 0 },
        maxBytes: { default: DEFAULT_CONTEXT_LIMITS.maxBytes, min: 0 },
      },
      explicitAllow: true,
    },
    independentOf: ["purpose", "rigor", "budget"],
    purposes: SEMANTIC_PURPOSES,
    rigors: SEMANTIC_RIGORS,
  };
}
