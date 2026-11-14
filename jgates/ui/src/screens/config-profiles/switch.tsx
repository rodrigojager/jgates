/**
 * On/off control: a button with role="switch", so the keyboard (Space, Enter) and the screen reader behave as for a toggle.
 * `pending`: this switch's write is in flight (aria-busy and a turning ring in the knob until the answer arrives).
 */
export function Switch({ checked, label, disabled, reason, pending, onChange, testId }: { checked: boolean; label: string; disabled?: boolean; reason?: string | null; pending?: boolean; onChange: (next: boolean) => void; testId?: string }) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={pending ? true : undefined}
      disabled={disabled}
      title={disabled && !pending && reason ? reason : undefined}
      data-testid={testId}
      data-pending={pending ? "true" : undefined}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" aria-hidden="true">
        {pending ? <span className="spinner" /> : null}
      </span>
    </button>
  );
}
