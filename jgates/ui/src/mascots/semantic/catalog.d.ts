export type SemanticMascotId = "atlas" | "trace" | "verdict" | "fit" | "seal" | "folio";
export type SemanticMascotState = "waiting" | "working" | "done" | "incomplete" | "failed" | "cancelled";
export const SEMANTIC_MASCOT_IDS: readonly SemanticMascotId[];
export const SEMANTIC_MASCOT_STATES: readonly SemanticMascotState[];
export const LEGACY_SEMANTIC_MASCOTS: Readonly<Record<"scout" | "tracker" | "challenger" | "verifier", SemanticMascotId>>;
export function resolveSemanticMascot(id: string): SemanticMascotId | null;
export const SEMANTIC_MASCOT_MODELS: Readonly<Record<SemanticMascotId, { study: string; shape: string; color: string; bodyColor?: string; bodyHue?: number }>>;
export const SEMANTIC_MASCOT_FALLBACKS: Readonly<Record<SemanticMascotId, string>>;
