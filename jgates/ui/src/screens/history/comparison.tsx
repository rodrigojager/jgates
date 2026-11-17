import { api } from "../../api";
import { ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";

interface Brief {
  fingerprint: string | null;
  tool: string;
  ruleId: string;
  severity: string;
  message: string;
  path: string | null;
  line: number | null;
  blocking: boolean;
}

interface Compare {
  base: string;
  head: string;
  comparable: boolean;
  warnings: Array<{ code: string; message: string }>;
  counts: { new: number; resolved: number; kept: number; newReview?: number; keptReview?: number; resolvedReview?: number; newInformational?: number; keptInformational?: number; resolvedInformational?: number };
  new: Brief[];
  resolved: Brief[];
  kept: Brief[];
  newReview?: Brief[];
  keptReview?: Brief[];
  resolvedReview?: Brief[];
  newInformational?: Brief[];
  keptInformational?: Brief[];
  resolvedInformational?: Brief[];
}

/** `group` is the id of the enclosing heading, so the same title in several groups still names each section apart. */
function FindingList({ id, title, tone, items, total, group }: { id: string; title: string; tone: "green" | "red" | "blue"; items: Brief[]; total: number; group?: string }) {
  return (
    <section className="stack" aria-labelledby={group ? `${id} ${group}` : id} data-compare={id}>
      <h3 id={id}>
        {title} <Pill tone={tone}>{total}</Pill>
      </h3>
      {items.length === 0 ? (
        <p className="small muted">{t("history_compare_none")}</p>
      ) : (
        <ul className="history-findings">
          {items.map((f, i) => (
            <li key={`${f.fingerprint ?? f.ruleId}-${i}`}>
              <strong>{f.ruleId}</strong> <span className="small muted">{f.tool}</span>
              {f.blocking ? <Pill tone="red">{t("history_compare_blocking")}</Pill> : null}
              <div className="small">{f.message}</div>
              <div className="small muted">
                {tOr(`history_severity_${f.severity}`, f.severity)}
                {f.path ? (
                  <>
                    {" · "}
                    <code>{f.line ? `${f.path}:${f.line}` : f.path}</code>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The run `head` against the run `base`: what was resolved, what is new and what stayed, with the warning when they are not like for like. */
export function Comparison({ base, head, onClose }: { base: string; head: string; onClose: () => void }) {
  const cmp = useAsync(() => api<Compare>("GET", `/api/history/compare?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`), `compare:${base}:${head}`);
  if (cmp.loading && !cmp.data) return <Loading />;
  if (cmp.error) return <ErrorNotice error={cmp.error} onRetry={cmp.reload} />;
  const d = cmp.data as Compare;
  return (
    <section className="card flat stack" aria-labelledby="history-compare-title" data-testid="history-compare">
      <div className="between">
        <h2 id="history-compare-title">{t("history_compare_title", { base: d.base, head: d.head })}</h2>
        <button type="button" className="btn" onClick={onClose}>
          {t("close")}
        </button>
      </div>
      {d.warnings.length > 0 ? (
        <div className="notice warn" role="alert" data-testid="history-compare-warning">
          <Icon name="alert" />
          <div>
            <strong>{t("history_compare_not_comparable")}</strong>
            <ul>
              {d.warnings.map((w) => (
                <li key={w.code} data-warning={w.code}>
                  {tOr(`history_warning_${w.code}`, w.message)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <div className="notice ok" role="status">
          <Icon name="check" />
          <span>{t("history_compare_comparable")}</span>
        </div>
      )}
      <div className="history-columns">
        <FindingList id="resolved" title={t("history_compare_resolved")} tone="green" items={d.resolved} total={d.counts.resolved} />
        <FindingList id="new" title={t("history_compare_new")} tone="red" items={d.new} total={d.counts.new} />
        <FindingList id="kept" title={t("history_compare_kept")} tone="blue" items={d.kept} total={d.counts.kept} />
      </div>
      <section className="stack" aria-labelledby="history-compare-informational">
        <h3 id="history-compare-informational">{t("history_informational_heading")}</h3>
        <div className="history-columns">
          <FindingList id="resolved-informational" title={t("history_compare_resolved")} tone="green" items={d.resolvedInformational ?? []} total={d.counts.resolvedInformational ?? 0} group="history-compare-informational" />
          <FindingList id="new-informational" title={t("history_compare_new")} tone="blue" items={d.newInformational ?? []} total={d.counts.newInformational ?? 0} group="history-compare-informational" />
          <FindingList id="kept-informational" title={t("history_compare_kept")} tone="blue" items={d.keptInformational ?? []} total={d.counts.keptInformational ?? 0} group="history-compare-informational" />
        </div>
      </section>
      <section className="stack" aria-labelledby="history-compare-review" data-testid="history-compare-review">
        <h3 id="history-compare-review">{t("history_review_heading")}</h3>
        <div className="history-columns">
          <FindingList id="resolved-review" title={t("history_compare_resolved")} tone="green" items={d.resolvedReview ?? []} total={d.counts.resolvedReview ?? 0} group="history-compare-review" />
          <FindingList id="new-review" title={t("history_compare_new")} tone="blue" items={d.newReview ?? []} total={d.counts.newReview ?? 0} group="history-compare-review" />
          <FindingList id="kept-review" title={t("history_compare_kept")} tone="blue" items={d.keptReview ?? []} total={d.counts.keptReview ?? 0} group="history-compare-review" />
        </div>
      </section>
    </section>
  );
}
