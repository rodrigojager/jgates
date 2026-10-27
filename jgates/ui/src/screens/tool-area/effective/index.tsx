import { useCallback, useEffect, useState } from "react";
import { api } from "../../../api";
import { ErrorNotice, Loading, Pill } from "../../../components/common";
import { Icon } from "../../../components/icons";
import type { ToolTabMeta, ToolTabProps } from "../../../forms/tab";
import { t } from "../../../i18n";

// Effective configuration tab: what the tool sees, value by value, with the file and line each one comes from, the flags
// and variables of the plan's command that win over the file, and the warning when the resolution is partial.

export const tab: ToolTabMeta = { id: "effective", label: t("eff_tab"), order: 40 };

interface EffectiveValue {
  path: string;
  label: string | null;
  value: unknown;
  origin: { kind: "file"; file: string | null; line: number | null } | { kind: "default" };
}

interface Effective {
  file: string | null;
  resolution: { status: "complete" | "partial" | "unavailable"; reasons: Array<{ code: string; params: Record<string, string | number> }> };
  values: EffectiveValue[];
  prevailing: Array<{ kind: "flag" | "env"; name: string; value: string | null }>;
}

const TONE = { complete: "green", partial: "gold", unavailable: "red" } as const;

function show(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? "");
}

export default function EffectiveTab({ instance, active }: ToolTabProps) {
  const id = instance.id as string;
  const [data, setData] = useState<Effective | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ effective: Effective }>("GET", `/api/tools/${encodeURIComponent(id)}/effective`);
      setData(r.effective);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [id]);

  // Read again each time the tab is shown: the file may have been saved from another tab.
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  if (error) return <ErrorNotice error={error} onRetry={load} />;
  if (!data) return loading ? <Loading /> : null;
  const status = data.resolution.status;

  return (
    <div className="stack" data-testid="effective">
      <div className="card flat stack">
        <div className="between wrap">
          <h2>{t("eff_title")}</h2>
          <Pill tone={TONE[status]}>{t(`eff_${status}`)}</Pill>
        </div>
        <p>{t("eff_lead")}</p>
        {data.file ? (
          <p className="small">
            <code>{t("eff_file", { file: data.file })}</code>
          </p>
        ) : null}
      </div>

      {data.resolution.reasons.length > 0 ? (
        <div className="notice warn" role="status" data-testid="effective-reasons">
          <Icon name="alert" />
          <ul className="stack tight grow">
            {data.resolution.reasons.map((r, i) => (
              <li key={i} data-reason={r.code}>
                {t(`eff_reason_${r.code}`, r.params)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className="card flat stack" aria-labelledby="eff-values-title">
        <h3 id="eff-values-title">{t("eff_values")}</h3>
        {data.values.length === 0 ? (
          <p>{t("eff_no_values")}</p>
        ) : (
          <div className="table-wrap">
            <table aria-label={t("eff_values")}>
              <thead>
                <tr>
                  <th scope="col">{t("eff_col_option")}</th>
                  <th scope="col">{t("eff_col_value")}</th>
                  <th scope="col">{t("eff_col_origin")}</th>
                </tr>
              </thead>
              <tbody>
                {data.values.map((v) => (
                  <tr key={v.path} data-path={v.path} data-origin={v.origin.kind}>
                    <th scope="row">
                      <code>{v.path}</code>
                      {v.label ? (
                        <>
                          <br />
                          <span className="small muted">{v.label}</span>
                        </>
                      ) : null}
                    </th>
                    <td>
                      <code>{show(v.value)}</code>
                    </td>
                    <td>
                      {v.origin.kind === "file"
                        ? v.origin.line
                          ? t("eff_origin_file", { file: v.origin.file ?? "-", line: v.origin.line })
                          : t("eff_origin_file_noline", { file: v.origin.file ?? "-" })
                        : t("eff_origin_default")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card flat stack" aria-labelledby="eff-prevailing-title">
        <h3 id="eff-prevailing-title">{t("eff_prevailing")}</h3>
        <p className="small">{t("eff_prevailing_lead")}</p>
        {data.prevailing.length === 0 ? (
          <p>{t("eff_prevailing_none")}</p>
        ) : (
          <ul className="stack tight" data-testid="effective-prevailing">
            {data.prevailing.map((p, i) => (
              <li key={`${p.kind}:${p.name}:${i}`}>
                <span className="small muted">{p.kind === "flag" ? t("eff_prevailing_flag") : t("eff_prevailing_env")}: </span>
                <code>{p.value === null ? p.name : `${p.name} ${p.value}`}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
