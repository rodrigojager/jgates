import "./stepper.css";

export interface StepperStep {
  id: string;
  label: string;
  /** Not selectable now (a step that needs an earlier one first, or a busy screen). */
  disabled?: boolean;
  /** Finished: shows a check instead of its number. */
  done?: boolean;
}

/**
 * A generic, numbered stepper: a nav with an ordered list of buttons. The current step carries aria-current="step".
 * It does not own the state: the screen says which step is current and what a click does.
 */
export function Stepper({ steps, current, onSelect, label }: { steps: StepperStep[]; current: string | null; onSelect: (id: string) => void; label: string }) {
  return (
    <nav aria-label={label} className="stepper-nav">
      <ol className="stepper">
        {steps.map((step) => (
          <li key={step.id}>
            <button
              type="button"
              data-step={step.id}
              data-state={step.done ? "done" : current === step.id ? "current" : "todo"}
              onClick={() => onSelect(step.id)}
              disabled={step.disabled === true}
              {...(current === step.id ? { "aria-current": "step" as const } : {})}
            >
              {step.label}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
