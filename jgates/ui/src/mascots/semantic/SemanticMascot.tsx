import { useEffect, useRef, useState } from "react";
import { SEMANTIC_MASCOT_FALLBACKS, SEMANTIC_MASCOT_STATES, resolveSemanticMascot, type SemanticMascotState } from "./catalog.js";
import "./semantic-mascots.css";

// Once a page has found no WebGL, every later mascot goes straight to its pre-rendered image.
let webgl: "unknown" | "unavailable" = "unknown";

/**
 * One Semantic mascot: its 3D model, animated for its state (drawn by the shared renderer into this mascot's own canvas, or
 * the pre-rendered still image where WebGL is unavailable). The state is written next to it by the strip, like Quality's
 * status. A mascot appears in its state as it is; when the state changes it plays the reaction of the new state, and
 * "working" keeps moving. `label` is the accessible name (what the mascot does and its state); an old role id of a stored
 * run resolves to its phase mascot. `className` sizes it (the strips give it their viewport size).
 */
export function SemanticMascot({ mascot, state, label, className }: { mascot: string; state: string; label: string; className?: string }) {
  const id = resolveSemanticMascot(mascot);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<"webgl" | "fallback">(webgl === "unavailable" ? "fallback" : "webgl");
  // A state the models do not know is drawn as incomplete.
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
    <span className={className ? `sem3d ${className}` : "sem3d"} role="img" aria-label={label} data-mascot={id ?? mascot} data-state={state} data-render={id ? mode : "none"}>
      {id && mode === "webgl" ? <canvas ref={canvas} className="sem3d-model" aria-hidden="true" /> : null}
      {id && mode === "fallback" ? <img className="sem3d-model" src={SEMANTIC_MASCOT_FALLBACKS[id]} alt="" draggable={false} /> : null}
    </span>
  );
}
