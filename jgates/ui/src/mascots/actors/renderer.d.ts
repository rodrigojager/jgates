import type { MascotDomain, MascotStatus } from "../../../../src/core/mascots/index";
export interface Actor {
  status: MascotStatus;
  setStatus(status: MascotStatus, options: { hasFindings: boolean; progress: null; settled: boolean }): void;
}
export class MascotGallery {
  constructor(options: { canvas: HTMLCanvasElement; reducedMotion: boolean; onError: (error: Error) => void });
  visible: boolean;
  add(domain: MascotDomain, viewport: HTMLElement, options?: { status?: MascotStatus }): Actor;
  bind(domain: MascotDomain, element: HTMLElement): Actor | undefined;
  get(domain: MascotDomain): Actor | undefined;
  readonly canvas: HTMLCanvasElement;
  readonly disposed: boolean;
  readonly contextLost?: boolean;
  /** Dims a mascot that waits for its turn in a run (eased; `immediate` shows it at once). */
  setDimmed(domain: MascotDomain, dimmed: boolean, options?: { immediate?: boolean }): void;
  invalidate(): void;
  setReducedMotion(value: boolean): void;
  dispose(): void;
}
