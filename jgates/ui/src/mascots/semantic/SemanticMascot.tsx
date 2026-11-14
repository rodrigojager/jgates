import { useEffect, useRef, useState, type ReactNode } from "react";
import { SEMANTIC_MASCOT_FALLBACKS, SEMANTIC_MASCOT_STATES, resolveSemanticMascot, type SemanticMascotState } from "./catalog.js";
import "./semantic-mascots.css";

// Once a page has found no WebGL, every later mascot goes straight to its pre-rendered image.
let webgl: "unknown" | "unavailable" = "unknown";

const BADGES: Record<string, ReactNode> = {
  waiting: <path d="M7 3.5h10M7 20.5h10M8.5 3.5V6c0 2 1.4 3.4 3.5 6 2.1-2.6 3.5-4 3.5-6V3.5M8.5 20.5V18c0-2 1.4-3.4 3.5-6 2.1 2.6 3.5 4 3.5 6v2.5" />,
  working: <path d="M19 12a7 7 0 1 1-2.05-4.95M19 4.5V8h-3.5" />,
  done: <path d="M5.5 12.5l4 4 9-9.5" />,
  incomplete: <path d="M6.5 12h11" />,
  failed: <path d="M7 7l10 10M17 7L7 17" />,
  cancelled: <rect x="7.5" y="7.5" width="9" height="9" rx="1.2" />,
};

/**
 * One Semantic mascot: its 3D model, animated for its state (drawn by the shared renderer into this mascot's own canvas, or
 * the pre-rendered still image where WebGL is unavailable), with a corner badge for the state. A mascot appears in its
 * state as it is; when the state changes it plays the reaction of the new state, and "working" keeps moving. `label` is
 * the accessible name (mascot, phase and state); an old role id of a stored run resolves to its phase mascot.
 */
export function SemanticMascot({ mascot, state, label }: { mascot: string; state: string; label: string }) {
  const id = resolveSemanticMascot(mascot);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<"webgl" | "fallback">(webgl === "unavailable" ? "fallback" : "webgl");
  // A state the models do not know is drawn like the badge shows it.
  const shown = (SEMANTIC_MASCOT_STATES as readonly string[]).includes(state) ? (state as SemanticMascotState) : "incomplete";
  const current = useRef(shown);
  current.current = shown;
  const repaint = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = canvas.current;
    if (mode !== "webgl" || !el || !id) return;
    let alive = true;
    const paint = () => {
      import("./renderer.js")
        .then(({ paintSemanticMascot }) => (alive ? paintSemanticMascot(el, id, current.current) : false))
        .catch(() => {
          // No WebGL (or a model that could not be drawn): the same mascot from its pre-rendered image.
          webgl = "unavailable";
          if (alive) setMode("fallback");
        });
    };
    repaint.current = paint;
    // The first observation paints it; later ones only when the displayed size changed (the renderer skips the rest).
    const resize = new ResizeObserver(paint);
    resize.observe(el);
    return () => {
      alive = false;
      repaint.current = null;
      resize.disconnect();
      void import("./renderer.js").then(({ forgetSemanticMascot }) => forgetSemanticMascot(el));
    };
  }, [id, mode]);

  // A new state: the mascot reacts to it.
  useEffect(() => {
    repaint.current?.();
  }, [shown]);

  return (
    <span className="sem3d" role="img" aria-label={label} data-mascot={id ?? mascot} data-state={state} data-render={id ? mode : "none"}>
      {id && mode === "webgl" ? <canvas ref={canvas} className="sem3d-model" aria-hidden="true" /> : null}
      {id && mode === "fallback" ? <img className="sem3d-model" src={SEMANTIC_MASCOT_FALLBACKS[id]} alt="" draggable={false} /> : null}
      <span className="sem3d-badge" data-state={state} aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">{BADGES[state] ?? BADGES.incomplete}</svg>
      </span>
    </span>
  );
}
