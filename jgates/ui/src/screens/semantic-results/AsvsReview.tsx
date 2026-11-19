import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";

/** What the report says of an asvs-review run (server/routes/semantic-views.ts asvsReviewOf): requirement ids only. */
export interface AsvsReviewReport {
  asvsVersion: string | null;
  level: number | null;
  hasLedger: boolean;
  examined: Array<{ id: string; outcome: "finding" | "no-violation-found"; references: number }>;
  notExaminable: Array<{ id: string; reason: string | null; detail: string | null }>;
}

/** The requirements the ASVS review examined and those it could not, with the reason, said as an AI review of the source. */
export function AsvsReviewResults({ review }: { review: AsvsReviewReport }) {
  return (
    <section className="stack" aria-labelledby="semres-asvsr" data-testid="semres-asvsr">
      <h2 id="semres-asvsr">{t("semres_asvsr_title")}</h2>
      <div className="notice" role="note" data-testid="semres-asvsr-ai">
        <Icon name="info" />
        <span>{t("semres_asvsr_ai")}</span>
      </div>
      {!review.hasLedger ? <p className="small muted">{t("semres_asvsr_no_answers")}</p> : null}
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <section className="card flat stack" aria-labelledby="semres-asvsr-examined" data-testid="semres-asvsr-examined" data-count={review.examined.length}>
          <div className="between">
            <h3 id="semres-asvsr-examined">{t("semres_asvsr_examined")}</h3>
            <strong>{review.examined.length}</strong>
          </div>
          <p className="muted small">{t("semres_asvsr_examined_hint")}</p>
          {review.examined.length > 0 ? (
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {review.examined.slice(0, 400).map((a) => (
                <li key={a.id} data-requirement={a.id} data-outcome={a.outcome}>
                  <code>{a.id}</code>
                  <span className="muted">
                    {" "}
                    · {t(`semres_asvsr_outcome_${a.outcome}`)} · {t("semres_asvsr_references", { count: a.references })}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <section className="card flat stack" aria-labelledby="semres-asvsr-not" data-testid="semres-asvsr-not-examinable" data-count={review.notExaminable.length}>
          <div className="between">
            <h3 id="semres-asvsr-not">{t("semres_asvsr_not_examinable")}</h3>
            <strong>{review.notExaminable.length}</strong>
          </div>
          <p className="muted small">{t("semres_asvsr_not_examinable_hint")}</p>
          {review.notExaminable.length > 0 ? (
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {review.notExaminable.slice(0, 400).map((a) => (
                <li key={a.id} data-requirement={a.id} data-reason={a.reason ?? ""}>
                  <code>{a.id}</code>
                  <span className="muted">
                    {" "}
                    · {a.reason ? tOr(`semres_asvsr_reason_${a.reason}`, a.reason) : t("semres_asvsr_none")}
                    {a.detail ? ` (${a.detail})` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </section>
  );
}
