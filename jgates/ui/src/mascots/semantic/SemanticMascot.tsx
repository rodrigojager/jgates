import { useEffect } from "react";
import { renderSemanticMascotSvg, SEMANTIC_MASCOT_CSS } from "./index.js";

const STYLE_ID = "jg-semantic-mascots";

/** One Semantic mascot (SVG, role img, state label). The shared stylesheet is injected once. */
export function SemanticMascot({ mascot, state, locale = "en" }: { mascot: string; state: string; locale?: string }) {
  useEffect(() => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = SEMANTIC_MASCOT_CSS;
    document.head.appendChild(style);
  }, []);
  return <span style={{ display: "inline-flex" }} dangerouslySetInnerHTML={{ __html: renderSemanticMascotSvg({ mascot, state, locale }) }} />;
}
