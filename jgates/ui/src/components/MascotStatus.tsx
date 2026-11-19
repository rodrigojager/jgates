import { Icon, type IconName } from "./icons";
import "./mascot-strip.css";

/** How a status reads: its colour, or the turning icon of a mascot at work. */
export type MascotTone = "passed" | "failed" | "busy" | "alert" | "dim" | "neutral";

/**
 * The status of one mascot under its title, the same in the Quality and the Semantic strips: an icon and the status text,
 * coloured by its tone. `status` stays on the element as `data-status` for the strip's own rules and tests.
 */
export function MascotStatus({ status, tone, icon, label, className, testId }: { status: string; tone: MascotTone; icon: IconName; label: string; className?: string; testId?: string }) {
  return (
    <span className={className ? `mascot-strip-status ${className}` : "mascot-strip-status"} data-status={status} data-tone={tone} data-testid={testId}>
      <Icon name={icon} /> {label}
    </span>
  );
}
