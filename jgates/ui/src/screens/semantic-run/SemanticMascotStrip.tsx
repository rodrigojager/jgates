import { t, tOr } from "../../i18n";
import { resolveSemanticMascot } from "../../mascots/semantic/catalog.js";
import { SemanticMascot } from "../../mascots/semantic/SemanticMascot";

/** The snapshot of GET /api/semantic/runs/:id/mascots (core/semantic-mascots); never a Quality snapshot. */
export interface SemanticMascotSnapshot {
  schemaVersion: 1;
  runId: string | null;
  running: boolean;
  cancelled: boolean;
  mascots: Array<{ mascot: string; state: string; stages: Array<{ id: string; state: string }>; progress: { completed: number; total: number } | null }>;
}

export const stageLabel = (id: string): string => {
  const base = id.slice(id.lastIndexOf("/") + 1);
  return tOr(`semrun_stage_${base.replace(/[^a-z0-9]+/gi, "_")}`, base);
};

/** The six AI mascots of a Semantic run, one per phase, each with its state and the stages it owns. */
export function SemanticMascotStrip({ snapshot }: { snapshot: SemanticMascotSnapshot | null | undefined }) {
  if (!snapshot) return null;
  return (
    <section className="card flat stack" aria-labelledby="sem-mascots" data-testid="semantic-mascots" data-running={snapshot.running} data-cancelled={snapshot.cancelled}>
      <h2 id="sem-mascots">{t("semrun_mascots_title")}</h2>
      <p className="muted small">{t("semrun_mascots_lead")}</p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
        {snapshot.mascots.map((m) => {
          // A stored run may still carry an old role id (scout, tracker, challenger, verifier): it shows its phase mascot.
          const id = resolveSemanticMascot(m.mascot) ?? m.mascot;
          const name = tOr(`semrun_mascot_${id}`, id);
          const role = tOr(`semrun_mascot_${id}_role`, "");
          const state = tOr(`semrun_mascot_state_${m.state}`, m.state);
          return (
            <li key={m.mascot} className="card flat stack" data-mascot={id} data-state={m.state} style={{ alignItems: "center", textAlign: "center", gap: 6 }}>
              <SemanticMascot mascot={id} state={m.state} label={role ? `${name}, ${role}: ${state}` : `${name}: ${state}`} />
              <strong>{name}</strong>
              {role ? <span className="small muted">{role}</span> : null}
              <span className="small" data-testid="semantic-mascot-state">{state}</span>
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
          );
        })}
      </ul>
    </section>
  );
}
