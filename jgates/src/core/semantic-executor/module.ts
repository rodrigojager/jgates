// The built-in investigation module and the registry of modules by method. A module is a list of stages, each one a
// responsibility with its own fresh context(s); later modules (the security-audit baseline, the general review with
// evidence discipline) register themselves here and the Semantic run service runs them through the executor.
import type { InvestigationModule } from "./types.js";

export const INVESTIGATION_MODULE_ID = "investigation";

/** Hunting in one context, then an independent validation of every candidate, each in a fresh context. */
export const INVESTIGATION_MODULE: InvestigationModule = {
  id: INVESTIGATION_MODULE_ID,
  version: "1",
  title: "Bounded investigation",
  objective:
    "Find real problems in the subjects of the resolved scope (correctness, security, reliability, data handling) and establish each one with evidence from the code that can be read.",
  stages: [
    {
      id: "hunt",
      label: "Hunting",
      role: "explore",
      required: true,
      contexts: "once",
      reportsCandidates: true,
      artifact: { kind: "exploration" },
      instructions:
        "Examine the subjects to examine. Read them (read_file, search_files, list_files) and the allowed context they need. Report each plausible problem as a candidate with report_candidate, at a location you have read, with its rationale. Candidates are hypotheses: an independent validation judges them later, so do not inflate or confirm them yourself. When you are done, answer with the exploration artifact: what you examined (only files you actually read), what you could not examine and why (gaps), and any candidate you did not report yet.",
    },
    {
      id: "validate",
      label: "Independent validation",
      role: "validate",
      required: true,
      contexts: "per-candidate",
      artifact: { kind: "verdict" },
      instructions:
        "You validate one candidate that another context reported; you did not produce it and you are free to reject it. Read the code it points to and whatever allowed context decides it (callers, guards, sanitizers, configuration). Confirm it only when the code you read shows the problem; reject it when the code you read shows it cannot happen (cite the guard); answer needs-validation when the files you could read do not settle it. Every confirmed or rejected verdict cites evidence you read in this context.",
    },
  ],
};

const registry = new Map<string, InvestigationModule>([[INVESTIGATION_MODULE_ID, INVESTIGATION_MODULE]]);

/** Registers the module that executes a Semantic method (the method ID of the plan). */
export function registerInvestigationModule(methodId: string, module: InvestigationModule): void {
  registry.set(methodId, module);
}

/** The investigation module of the first method that has one; null: the method runs as a context-only review. */
export function investigationModuleFor(methodIds: readonly string[]): InvestigationModule | null {
  for (const id of methodIds) {
    const m = registry.get(id);
    if (m) return m;
  }
  return null;
}

export function registeredInvestigationModules(): Array<{ methodId: string; module: string; version: string }> {
  return [...registry.entries()].map(([methodId, m]) => ({ methodId, module: m.id, version: m.version }));
}
