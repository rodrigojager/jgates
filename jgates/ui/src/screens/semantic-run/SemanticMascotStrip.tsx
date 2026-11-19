import type { IconName } from "../../components/icons";
import { MascotStatus, type MascotTone } from "../../components/MascotStatus";
import { t, tOr } from "../../i18n";
import { resolveSemanticMascot } from "../../mascots/semantic/catalog.js";
import { SemanticMascot } from "../../mascots/semantic/SemanticMascot";
import "../../components/mascot-strip.css";

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

// The same icons and colours as Quality's status: waiting its turn is the amber warning, work turns the icon.
const STATUS: Record<string, { icon: IconName; tone: MascotTone }> = {
  waiting: { icon: "hourglass", tone: "alert" },
  working: { icon: "refresh", tone: "busy" },
  done: { icon: "check", tone: "passed" },
  failed: { icon: "alert", tone: "failed" },
  incomplete: { icon: "info", tone: "neutral" },
  cancelled: { icon: "stop", tone: "neutral" },
};
const STAGE_TONES: Record<string, MascotTone> = { completed: "passed", done: "passed", failed: "failed" };

/**
 * The six AI mascots of a Semantic run, one per phase, laid out like the Quality strip: each says what it does (not a
 * name), shows its status with the same icon and colour, and lists the stages it owns in small lines.
 */
export function SemanticMascotStrip({ snapshot }: { snapshot: SemanticMascotSnapshot | null | undefined }) {
  if (!snapshot) return null;
  return (
    <section className="semantic-mascots stack" aria-label={t("semrun_mascots_label")} data-testid="semantic-mascots" data-running={snapshot.running} data-cancelled={snapshot.cancelled}>
      <ul className="mascot-strip-grid">
        {snapshot.mascots.map((m) => {
          // A stored run may still carry an old role id (scout, tracker, challenger, verifier): it shows its phase mascot.
          const id = resolveSemanticMascot(m.mascot) ?? m.mascot;
          const role = tOr(`semrun_mascot_${id}_role`, id);
          const state = tOr(`semrun_mascot_state_${m.state}`, m.state);
          const status = STATUS[m.state] ?? STATUS.incomplete!;
          return (
            <li key={m.mascot} className="mascot-strip-item" data-mascot={id} data-state={m.state}>
              <SemanticMascot className="mascot-strip-viewport" mascot={id} state={m.state} label={`${role}: ${state}`} />
              <strong>{role}</strong>
              <MascotStatus status={m.state} tone={status.tone} icon={status.icon} label={state} testId="semantic-mascot-state" />
              {m.progress ? <small>{t("semrun_mascot_progress", { done: m.progress.completed, total: m.progress.total })}</small> : null}
              {m.stages.length > 0 ? (
                <ul className="mascot-strip-lines" aria-label={t("semrun_mascot_stages")}>
                  {m.stages.map((s) => (
                    <li key={s.id} data-stage={s.id} data-state={s.state} data-tone={STAGE_TONES[s.state]}>
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
