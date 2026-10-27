import { api } from "../../api";
import { ErrorNotice, Loading, useAsync } from "../../components/common";
import { ApiError } from "../../api";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { ResultView } from "./ResultView";

export const screen: ScreenMeta = { id: "validations-result", path: "/validations/result/:id", area: "validations", order: 42 };

/** Resultado of a stored run, opened by its id. */
export default function ValidationsResultScreen({ params }: { params: Record<string, string> }) {
  const id = params.id as string;
  const loaded = useAsync(() => api("GET", `/api/results/${encodeURIComponent(id)}`), `result:${id}`);
  const notFound = loaded.error instanceof ApiError && loaded.error.status === 404;
  return (
    <div className="stack">
      <div>
        <div className="crumbs">
          <a href="#/validations">{t("vres_back")}</a>
        </div>
        <h1>{t("vres_title_page")}</h1>
      </div>
      {loaded.loading ? <Loading /> : null}
      {notFound ? <p>{t("vres_not_found")}</p> : loaded.error ? <ErrorNotice error={loaded.error} onRetry={loaded.reload} /> : null}
      {loaded.data ? <ResultView result={(loaded.data as any).result} previous={(loaded.data as any).previous} crashed={(loaded.data as any).result?.partial === true} /> : null}
    </div>
  );
}
