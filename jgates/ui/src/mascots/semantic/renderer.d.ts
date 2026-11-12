import type { SemanticMascotId } from "./catalog.js";
export class WebGLUnavailableError extends Error {}
export function paintSemanticMascot(target: HTMLCanvasElement, id: SemanticMascotId): Promise<boolean>;
export function renderSemanticMascotImage(id: SemanticMascotId, width: number, height: number, type?: string, quality?: number): string;
export function inspectSemanticMascots(): { contexts: number; renders: number; paints: number; alive: boolean; cached: number; unavailable: boolean };
export function release(): void;
