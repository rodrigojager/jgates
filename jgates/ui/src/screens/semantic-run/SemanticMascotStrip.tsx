import { useEffect } from "react";
import { getLocale, t, tOr } from "../../i18n";
import { SEMANTIC_MASCOT_CSS, renderSemanticMascotSvg } from "../../mascots/semantic/index.js";

/** The snapshot of GET /api/semantic/runs/:id/mascots (core/semantic-mascots); never a Quality snapshot. */
export interface SemanticMascotSnapshot {
  schemaVersion: 1;
  runId: string | null;
  running: boolean;
  cancelled: boolean;
  mascots: Array<{ mascot: string; state: string; stages: Array<{ id: string; state: string }>; progress: { completed: number; total: number } | null }>;
}

let installed = false;

/**
 * The mascot stylesheet as a constructed sheet: the server's CSP (style-src 'self') refuses an injected <style> element,
 * and a constructed sheet is not inline markup. Installed once per page.
 */
function useMascotStyles(): void {
  useEffect(() => {
    if (installed) return;
    installed = true;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(SEMANTIC_MASCOT_CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      // An old engine without constructed sheets: the SVGs still render, without the theme colors and motion.
    }
  }, []);
}

const stageLabel = (id: string): string => {
  const base = id.slice(id.lastIndexOf("/") + 1);
  return tOr(`semrun_stage_${base.replace(/[^a-z0-9]+/gi, "_")}`, base);
};

/** The four AI mascots of a Semantic run, each with its state and the stages it owns. */
export function SemanticMascotStrip({ snapshot }: { snapshot: SemanticMascotSnapshot | null | undefined }) {
  useMascotStyles();
  if (!snapshot) return null;
  const locale = getLocale();
  return (
    <section className="card flat stack" aria-labelledby="sem-mascots" data-testid="semantic-mascots" data-running={snapshot.running} data-cancelled={snapshot.cancelled}>
      <h2 id="sem-mascots">{t("semrun_mascots_title")}</h2>
      <p className="muted small">{t("semrun_mascots_lead")}</p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
        {snapshot.mascots.map((m) => (
          <li key={m.mascot} className="card flat stack" data-mascot={m.mascot} data-state={m.state} style={{ alignItems: "center", textAlign: "center", gap: 6 }}>
            <span style={{ display: "inline-flex" }} dangerouslySetInnerHTML={{ __html: renderSemanticMascotSvg({ mascot: m.mascot, state: m.state, locale }) }} />
            <strong>{t(`semrun_mascot_${m.mascot}`)}</strong>
            <span className="small muted">{t(`semrun_mascot_${m.mascot}_role`)}</span>
            <span className="small">{tOr(`semrun_mascot_state_${m.state}`, m.state)}</span>
            {m.progress ? <span className="small muted">{t("semrun_mascot_progress", { done: m.progress.completed, total: m.progress.total })}</span> : null}
            {m.stages.length > 0 ? (
              <ul className="small muted" style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
                {m.stages.map((s) => (
                  <li key={s.id} data-stage={s.id} data-state={s.state}>
                    {stageLabel(s.id)} · {tOr(`semrun_mascot_state_${s.state}`, s.state)}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
