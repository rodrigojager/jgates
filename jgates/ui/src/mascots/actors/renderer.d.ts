import type { MascotDomain, MascotStatus } from "../../../../src/core/mascots/index";
export interface Actor {
  status: MascotStatus;
  setStatus(status: MascotStatus, options: { hasFindings: boolean; progress: null; settled: boolean }): void;
}
export class MascotGallery {
  constructor(options: { canvas: HTMLCanvasElement; reducedMotion: boolean; onError: (error: Error) => void });
  visible: boolean;
  add(domain: MascotDomain, viewport: HTMLElement, options?: { status?: MascotStatus }): Actor;
  get(domain: MascotDomain): Actor | undefined;
  invalidate(): void;
  setReducedMotion(value: boolean): void;
  dispose(): void;
}
