// The registry of Semantic investigation modules: importing this file registers every built-in module with the
// executor (registerInvestigationModule), keyed by the method a Semantic plan names. Each module lives in its own
// folder and is added here with one line; a module whose vendored material is missing is not registered and its method
// stays unavailable (the plan blocks it with SEMANTIC_METHOD_UNAVAILABLE) instead of running without its method.
import { investigationModuleFor, registerInvestigationModule, registeredInvestigationModules, type InvestigationModule } from "../semantic-executor/index.js";
import { SECURITY_AUDIT_METHOD, securityAuditModule } from "./cloudflare/index.js";
import { GENERAL_REVIEW_METHOD, generalReviewModule } from "./general-review/index.js";

export interface SemanticModuleEntry {
  method: string;
  /** Builds the module (may throw when its material is missing). */
  create: () => InvestigationModule;
}

/** The built-in modules, by method. */
export const SEMANTIC_MODULES: readonly SemanticModuleEntry[] = [
  { method: GENERAL_REVIEW_METHOD, create: () => generalReviewModule() },
  { method: SECURITY_AUDIT_METHOD, create: () => securityAuditModule() },
];

/** Methods whose module could not be built, with the reason. */
export const unavailableModules: Array<{ method: string; reason: string }> = [];

for (const entry of SEMANTIC_MODULES) {
  try {
    registerInvestigationModule(entry.method, entry.create());
  } catch (error) {
    unavailableModules.push({ method: entry.method, reason: error instanceof Error ? error.message : String(error) });
  }
}

export { investigationModuleFor, registerInvestigationModule, registeredInvestigationModules };
export * as securityAudit from "./cloudflare/index.js";
export * as generalReview from "./general-review/index.js";
