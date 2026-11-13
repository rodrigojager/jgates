import { ApiError } from "../../api";
import { yamlHref } from "../../forms/derived/api";
import { Icon } from "../../components/icons";
import { t } from "../../i18n";

export interface ConfigDiagnostic {
  code: string;
  file: string;
  path?: string;
  message: string;
  suggestion?: string;
  line?: number;
  column?: number;
}

/** The diagnostics an invalid-configuration refusal carries (file, key, line), or null when the error is another one. */
export function diagnosticsOf(error: unknown): ConfigDiagnostic[] | null {
  if (!(error instanceof ApiError)) return null;
  const list = error.body?.diagnostics;
  return Array.isArray(list) && list.length > 0 ? (list as ConfigDiagnostic[]) : null;
}

/**
 * An invalid key in a configuration file: where it is, what is wrong and the way to the YAML editor (each problem links
 * to its key and line). The screen stays. `readable`: the screen around it still shows what the files hold.
 */
export function ConfigDiagnostics({ diagnostics, onRetry, readable = false }: { diagnostics: ConfigDiagnostic[]; onRetry: () => void; readable?: boolean }) {
  return (
    <div className="notice warn" role="alert" data-testid="config-diagnostics">
      <Icon name="alert" />
      <div className="grow stack" style={{ gap: 8 }}>
        <strong>{t("cfgp_diag_title", { count: diagnostics.length })}</strong>
        <p className="small">{readable ? t("cfgp_diag_text_readable") : t("cfgp_diag_text")}</p>
        <ul>
          {diagnostics.map((d, i) => (
            <li key={`${d.file}:${d.path ?? ""}:${d.code}:${i}`} data-diagnostic={d.code}>
              <code data-testid="diag-file">{d.file}</code>
              {d.path ? (
                <>
                  {" "}
                  {t("cfgp_diag_key")} <code data-testid="diag-key">{d.path}</code>
                </>
              ) : null}
              {d.line ? <span className="small muted"> {t("cfgp_diag_line", { line: d.line })}</span> : null}{" "}
              <a href={yamlHref(d.file, d.path ?? "")} className="small" data-testid="diag-line-link">
                {d.line ? t("cfgp_diag_open_line", { line: d.line }) : t("cfgp_diag_open_yaml")}
              </a>
              <div className="small">
                {d.message}
                {d.suggestion ? <span className="muted"> {t("cfgp_diag_suggestion", { name: d.suggestion })}</span> : null}
              </div>
            </li>
          ))}
        </ul>
        <div className="row wrap">
          <a className="btn primary" href={yamlHref(diagnostics[0]?.file ?? "jgates.yml", diagnostics[0]?.path ?? "")} data-testid="diag-open-yaml">
            <Icon name="file" />
            {t("cfgp_diag_open_yaml")}
          </a>
          <button type="button" className="btn" onClick={onRetry}>
            <Icon name="refresh" />
            {t("cfgp_diag_retry")}
          </button>
        </div>
      </div>
    </div>
  );
}
