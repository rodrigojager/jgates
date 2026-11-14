import type { SemanticMascotId, SemanticMascotState } from "./catalog.js";
export class WebGLUnavailableError extends Error {}
export function paintSemanticMascot(target: HTMLCanvasElement, id: SemanticMascotId, state?: SemanticMascotState): Promise<boolean>;
export function replaySemanticMascot(target: HTMLCanvasElement): void;
export function forgetSemanticMascot(target: HTMLCanvasElement): void;
export function setSemanticMascotMotion(reduced: boolean | null): void;
export function setSemanticMascotVariant(id: SemanticMascotId, variant: string | null): void;
export function renderSemanticMascotImage(id: SemanticMascotId, width: number, height: number, type?: string, quality?: number): string;
export function inspectSemanticMascots(): {
  contexts: number; renders: number; paints: number; frames: number; alive: boolean; cached: number; unavailable: boolean; reducedMotion: boolean; animating: number;
  mascots: Array<{ id: SemanticMascotId; state: SemanticMascotState; animating: boolean; pose?: Record<string, unknown> }>;
};
export function release(): void;
