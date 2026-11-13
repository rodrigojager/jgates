import { useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Loading, Pill, Spinner, Updating, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import "./extension-image.css";

// Configuração > Imagem de extensão: a viewer of .jgates/image/Dockerfile (the project's own image, built on top of the
// JGates tools image), its state (ready, outdated and why) and "Reconstruir", which runs the same build as
// `jgates tools build-extension`. The Dockerfile is not edited here: it comes from an own tool (Ferramentas) or from the
// project.
export const screen: ScreenMeta = { id: "extension-image", path: "/config/image", area: "config", navLabel: "img_nav", navPath: "/config/image", order: 50, icon: "terminal" };

type Status = "none" | "ready" | "outdated" | "unknown";

interface View {
  file: string;
  exists: boolean;
  dockerfile: { text: string; truncated: boolean; bytes: number } | null;
  state: { status: Status; cause: "never-built" | "files-changed" | "base-changed" | null; tag: string | null };
  building: boolean;
  build?: { ok: boolean; built: boolean; tag: string | null; logFile: string | null; removed: string[]; failure: { code: string; message: string; fix: string; details: string } | null };
}

const TONE: Record<Status, "green" | "gold" | "red" | "blue"> = { ready: "green", outdated: "gold", unknown: "blue", none: "blue" };

export default function ExtensionImageScreen() {
  const view = useAsync<View>(() => api("GET", "/api/extension"), "extension-image");
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<View["build"] | null>(null);

  if (view.error && !view.data) return <ErrorNotice error={view.error} onRetry={view.reload} />;
  if (!view.data) return <Loading />;
  const v = view.data;
  const status = v.state.status;

  const rebuild = async () => {
    setBuilding(true);
    setError(null);
    setResult(null);
    try {
      const answer = await api<View>("POST", "/api/extension/build", {});
      setResult(answer.build ?? null);
      view.prime(answer);
    } catch (e) {
      setError(e);
    } finally {
      setBuilding(false);
    }
  };

  return (
    <div className="stack" aria-busy={view.reloading || building ? true : undefined}>
      <div>
        <h1>{t("img_title")}</h1>
        <p>{t("img_lead")}</p>
      </div>
      <Updating active={view.reloading} />

      <section className="card pad stack" aria-labelledby="img-state-title" data-testid="img-state" data-status={status}>
        <div className="row wrap">
          <h2 id="img-state-title">{t("img_state_title")}</h2>
          <Pill tone={TONE[status]}>{t(`img_status_${status}`)}</Pill>
        </div>
        <p data-testid="img-state-text">{status === "outdated" && v.state.cause ? t(`img_cause_${v.state.cause}`) : t(`img_status_text_${status}`)}</p>
        {v.state.tag ? (
          <p className="small muted">
            {t("img_tag")} <code>{v.state.tag}</code>
          </p>
        ) : null}
        {v.exists ? (
          <>
            <div className="row wrap">
              <button type="button" className="btn primary" disabled={building || v.building} onClick={() => void rebuild()} aria-busy={building || undefined}>
                {building ? <Spinner /> : <Icon name="refresh" />}
                {building ? t("img_rebuilding") : t("img_rebuild")}
              </button>
            </div>
            <p className="small muted">{t("img_rebuild_note")}</p>
          </>
        ) : null}
        {error ? <ErrorNotice error={error} /> : null}
        {result ? (
          result.ok ? (
            <div className="notice ok" role="status" data-testid="img-built">
              <Icon name="check" />
              <p>{result.built ? t("img_built", { tag: result.tag ?? "-" }) : t("img_current", { tag: result.tag ?? "-" })}</p>
            </div>
          ) : (
            <div className="notice error" role="alert" data-testid="img-failed">
              <Icon name="alert" />
              <div className="stack tight">
                <strong>{result.failure?.message}</strong>
                <p className="small">{result.failure?.fix}</p>
                {result.failure?.details ? <pre className="img-log">{result.failure.details}</pre> : null}
              </div>
            </div>
          )
        ) : null}
      </section>

      <section className="stack" aria-labelledby="img-file-title">
        <h2 id="img-file-title">{t("img_file_title")}</h2>
        <p className="small">
          <Icon name="file" /> <code>{v.file}</code>
        </p>
        {v.dockerfile ? (
          <>
            <pre className="img-dockerfile" tabIndex={0} aria-label={t("img_file_label")} data-testid="img-dockerfile">
              {v.dockerfile.text}
            </pre>
            {v.dockerfile.truncated ? <p className="small muted">{t("img_file_truncated")}</p> : null}
          </>
        ) : (
          <div className="card pad stack" data-testid="img-missing">
            <p>{t("img_missing")}</p>
            <div>
              <a className="btn primary" href="#/tools?custom=1">
                {t("img_add_tool")}
              </a>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
