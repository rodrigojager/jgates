// The registry of Semantic investigation modules: importing this file registers every built-in module with the
// executor (registerInvestigationModule), keyed by the method a Semantic plan names. Each module lives in its own
// folder and is added here with one line; a module whose vendored material is missing is not registered and its method
// stays unavailable (the plan blocks it with SEMANTIC_METHOD_UNAVAILABLE) instead of running without its method.
import { investigationModuleFor, registerInvestigationModule, registeredInvestigationModules, type InvestigationModule } from "../semantic-executor/index.js";
import { SECURITY_AUDIT_METHOD, securityAuditModule } from "./cloudflare/index.js";
import { GENERAL_REVIEW_METHOD, generalReviewModule } from "./general-review/index.js";
import { DIFFERENTIAL_METHOD, differentialReviewModule } from "./differential/index.js";
import { VARIANT_ANALYSIS_METHOD, variantAnalysisModule } from "./variant/index.js";
import { INSECURE_DEFAULTS_METHOD, insecureDefaultsModule } from "./insecure-defaults/index.js";
import { CROSS_COMPONENT_METHOD, crossComponentModule } from "./cross-component/index.js";
import { PROPERTY_METHOD, propertyReasoningModule } from "./property/index.js";
import { POST_PATCH_METHOD, postPatchModule } from "./post-patch/index.js";
import { SUPPLY_CHAIN_METHOD, supplyChainModule } from "./supply-chain/index.js";
import { REPRODUCTION_METHOD, confirmByReproductionModule } from "./reproduction/index.js";

export interface SemanticModuleEntry {
  method: string;
  /** Builds the module (may throw when its material is missing). */
  create: () => InvestigationModule;
}

/** The built-in modules, by method. */
export const SEMANTIC_MODULES: readonly SemanticModuleEntry[] = [
  { method: GENERAL_REVIEW_METHOD, create: () => generalReviewModule() },
  { method: SECURITY_AUDIT_METHOD, create: () => securityAuditModule() },
  // Complementary methods: each checks its own applicability before any context starts (see the module headers).
  { method: DIFFERENTIAL_METHOD, create: () => differentialReviewModule() },
  { method: VARIANT_ANALYSIS_METHOD, create: () => variantAnalysisModule() },
  { method: INSECURE_DEFAULTS_METHOD, create: () => insecureDefaultsModule() },
  { method: CROSS_COMPONENT_METHOD, create: () => crossComponentModule() },
  // Property reasoning proposes invariants and tests; post-patch validation executes a reproducer in isolated fixtures;
  // supply-chain assessment interprets the lockfile signals of the deterministic check (see the module headers).
  { method: PROPERTY_METHOD, create: () => propertyReasoningModule() },
  { method: POST_PATCH_METHOD, create: () => postPatchModule() },
  { method: SUPPLY_CHAIN_METHOD, create: () => supplyChainModule() },
  // Confirm by reproduction executes a reproducer per needs-validation finding of an earlier run, on request only: no
  // purpose, profile, template or default selects it (see the module header).
  { method: REPRODUCTION_METHOD, create: () => confirmByReproductionModule() },
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
export * as differentialReview from "./differential/index.js";
export * as variantAnalysis from "./variant/index.js";
export * as insecureDefaults from "./insecure-defaults/index.js";
export * as crossComponent from "./cross-component/index.js";
export * as complementaryVendor from "./complementary/vendor.js";
export * as propertyReasoning from "./property/index.js";
export * as postPatch from "./post-patch/index.js";
export * as supplyChain from "./supply-chain/index.js";
export * as reproduction from "./reproduction/index.js";
