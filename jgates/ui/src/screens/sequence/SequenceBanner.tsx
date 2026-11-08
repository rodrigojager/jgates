import { useEffect, useState } from "react";
import { api } from "../../api";
import { t } from "../../i18n";

/** A link to the sequence a run belongs to, shown on that run's own screen (nothing when it is not part of a sequence). */
export function SequenceBanner({ runId }: { runId: string }) {
  const [sequenceId, setSequenceId] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    setSequenceId(null);
    if (!/^(run|sem)_/.test(runId)) return;
    api<{ sequences: Array<{ sequenceId: string; record: { runs: Array<{ runId: string }> } }> }>("GET", "/api/sequences?limit=200")
      .then((r) => {
        if (!stopped) setSequenceId(r.sequences.find((s) => s.record.runs.some((x) => x.runId === runId))?.sequenceId ?? null);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [runId]);
  if (!sequenceId) return null;
  return (
    <p className="muted small" data-testid="sequence-banner">
      {t("seq_banner")} <a href={`#/sequence/${sequenceId}`}>{t("seq_banner_open")}</a>
    </p>
  );
}
