// The bar at the top of the list of agent CLIs, on the provider step and on the providers screen: "Detectar de novo"
// asks the server for all four again, and "Detectado às <time>" says when the detection on screen was made (the
// server answers from its cache, so the time can be old).
import { Spinner } from "../../components/common";
import { Icon } from "../../components/icons";
import { formatTime } from "../../components/format";
import { t } from "../../i18n";
import type { CliStatus } from "./provider-model";

/** The latest detection time of the CLIs on screen, or null before the first answer. */
export function detectedAt(data: CliStatus | null): string | null {
  if (!data) return null;
  const times = data.providers.map((p) => p.checkedAt).filter((v): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)));
  if (times.length === 0) return data.checkedAt && !Number.isNaN(Date.parse(data.checkedAt)) ? data.checkedAt : null;
  return times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

export function DetectBar({ data, busy, onDetect, testId }: { data: CliStatus | null; busy: boolean; onDetect: () => void; testId: string }) {
  const at = detectedAt(data);
  return (
    <div className="detect-bar" data-testid={testId}>
      <button type="button" className="btn" disabled={busy} aria-busy={busy} data-testid={`${testId}-button`} onClick={onDetect}>
        {busy ? <Spinner /> : <Icon name="refresh" />}
        {t("semprov_detect_again")}
      </button>
      {at ? (
        <span className="small muted" data-testid={`${testId}-at`}>
          {t("semprov_detected_at", { time: formatTime(at) })}
        </span>
      ) : null}
    </div>
  );
}
