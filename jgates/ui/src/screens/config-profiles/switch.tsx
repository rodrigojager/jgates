/** On/off control: a button with role="switch", so the keyboard (Space, Enter) and the screen reader behave as for a toggle. */
export function Switch({ checked, label, disabled, onChange, testId }: { checked: boolean; label: string; disabled?: boolean; onChange: (next: boolean) => void; testId?: string }) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" aria-hidden="true" />
    </button>
  );
}
