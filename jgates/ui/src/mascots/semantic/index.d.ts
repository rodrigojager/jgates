export const SEMANTIC_MASCOT_IDS: readonly ["scout", "tracker", "challenger", "verifier"];
export const SEMANTIC_MASCOT_STATES: readonly ["waiting", "working", "done", "incomplete", "failed", "cancelled"];
export const SEMANTIC_MASCOT_CSS: string;
export function semanticMascotLabel(mascot: string, state: string, locale?: string): string;
export function renderSemanticMascotSvg(input: { mascot: string; state: string; locale?: string }): string;
