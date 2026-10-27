import { useId, type ReactNode } from "react";
import { Icon } from "./icons";

/**
 * A field the governed mode fixes: it shows the value, cannot be edited and says why. Screens use it in place
 * of the editable control whenever the shell reports mode "governed" for that setting; the reason is always visible text
 * (not a tooltip), linked to the field with aria-describedby.
 */
export function LockedField({ label, value, reason, mono }: { label: string; value: ReactNode; reason: string; mono?: boolean }) {
  const id = useId();
  return (
    <div className="field locked" data-locked="true">
      <span className="field-label" id={`${id}-label`}>
        {label}
      </span>
      <div className={`locked-value${mono ? " mono" : ""}`} role="textbox" aria-readonly="true" aria-labelledby={`${id}-label`} aria-describedby={`${id}-reason`} tabIndex={0}>
        <Icon name="lock" />
        <span className="grow">{value}</span>
      </div>
      <p className="small" id={`${id}-reason`}>
        {reason}
      </p>
    </div>
  );
}
