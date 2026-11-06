import { t } from "../i18n";
import "./heartbeat.css";

// The pulse of a run, beside the run screen's state: a green heart that beats and an ECG trace (P wave, QRS complex,
// T wave) that runs while the run's process beats; a flat red line when it stopped beating. The text says the same,
// so the state never depends on color or motion alone; with reduced motion the trace stays still.

export type PulseState = "alive" | "dead";

/** One beat of the trace in a 100x40 box: baseline, P, PR segment, QRS, ST segment, T, baseline. */
const BEAT = "h14 q4 -6 8 0 h6 l3 4 l5 -26 l5 32 l3 -10 h8 q6 -9 12 0 h36";

export function Heartbeat({ state, detail }: { state: PulseState; detail?: string | null }) {
  const alive = state === "alive";
  return (
    <div className="pulse" data-state={state} data-testid="run-pulse">
      <svg className="pulse-heart" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 20.5s-7.5-4.4-9.3-9.2C1.4 7.8 3.6 4.5 7 4.5c2 0 3.3 1.1 5 3 1.7-1.9 3-3 5-3 3.4 0 5.6 3.3 4.3 6.8-1.8 4.8-9.3 9.2-9.3 9.2z" />
      </svg>
      <svg className="pulse-trace" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {alive ? (
          <g className="pulse-run">
            <path d={`M0 24 ${BEAT} ${BEAT}`} />
          </g>
        ) : (
          <path d="M0 24 h100" />
        )}
      </svg>
      <span className="pulse-text">
        <strong>{alive ? t("pulse_alive") : t("pulse_dead")}</strong>
        {detail ? <span className="small muted"> · {detail}</span> : null}
      </span>
    </div>
  );
}
