import { ApiError, api } from "../../api";
import { ErrorNotice, Loading, useAsync } from "../../components/common";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { SemanticMascotStrip, type SemanticMascotSnapshot } from "../semantic-run/SemanticMascotStrip";
import { SemanticResultsView, type SemanticReport } from "./ResultsView";

export const screen: ScreenMeta = { id: "semantic-results", path: "/semantic/results/:id", area: "semantic", order: 54 };

/** Results of one stored Semantic run, opened by its sem_ ID. */
export default function SemanticResultsScreen({ params }: { params: Record<string, string> }) {
  const id = params.id as string;
  const loaded = useAsync(() => api<{ report: SemanticReport; mascots: SemanticMascotSnapshot }>("GET", `/api/semantic/runs/${encodeURIComponent(id)}/report`), `semantic-report:${id}`);
  const notFound = loaded.error instanceof ApiError && loaded.error.status === 404;
  return (
    <div className="stack">
      <div>
        <div className="crumbs">
          <a href="#/semantic">{t("semres_back")}</a>
        </div>
        <h1>{t("semres_title", { runId: id })}</h1>
      </div>
      {loaded.loading && !loaded.data ? <Loading /> : null}
      {notFound ? <p>{t("semres_not_found")}</p> : loaded.error ? <ErrorNotice error={loaded.error} onRetry={loaded.reload} /> : null}
      {loaded.data ? (
        <>
          {loaded.data.report.lifecycle === "running" ? (
            <p>
              <a href={`#/semantic/runs/${encodeURIComponent(id)}`}>{t("semres_follow_live")}</a>
            </p>
          ) : null}
          <SemanticMascotStrip snapshot={loaded.data.mascots} />
          <SemanticResultsView report={loaded.data.report} />
        </>
      ) : null}
    </div>
  );
}
