import { useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { Switch } from "../config-profiles/switch";
import { CreateTemplate } from "./create";
import { TemplateDetail } from "./detail";
import "./config-templates.css";

// Configuração > Templates. The templates of the catalog and of the project with the toggle and the badge, the detail
// with inheritance field by field, and "Criar template" (a project template in .jgates/templates/).
export const screen: ScreenMeta = { id: "config-templates", path: "/config/templates", area: "config", navLabel: "cft_nav", navPath: "/config/templates", order: 41, icon: "plan" };

export interface TemplateRow {
  id: string;
  label: string;
  description: string | null;
  source: string;
  origin: "builtin" | "project";
  declared: boolean;
  enabled: boolean;
  activation: "always" | "detected" | "manual";
  required: boolean;
  status: string;
  match: { languages: string[]; frameworks: string[] };
  components: string[];
  support: { level: string; uncovered: string[] } | null;
  extends: string[];
  problem: string | null;
}

interface TemplatesView {
  mode: "local" | "governed";
  governed: { policy: string } | null;
  revision: string | null;
  templates: TemplateRow[];
  conflicts: Array<{ code: string; message: string; fix: string | null; file: string | null }>;
  order: Array<{ layer: string; source: string | null }>;
  folder: string;
}

export function badgeFor(row: TemplateRow): { tone: "green" | "gold" | "blue" | undefined; text: string; key: string } {
  if (!row.enabled) return { tone: undefined, text: t("cft_badge_off"), key: "off" };
  if (row.required) return { tone: "green", text: t("cft_badge_required"), key: "required" };
  if (row.components.length > 0) return { tone: "blue", text: t(row.components.length === 1 ? "cft_badge_one" : "cft_badge_many", { count: row.components.length }), key: "components" };
  if (row.activation === "manual") return { tone: undefined, text: t("cft_badge_manual"), key: "manual" };
  return { tone: undefined, text: t("cft_badge_none"), key: "none" };
}

export default function ConfigTemplatesScreen() {
  const toast = useToast();
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const view = useAsync<TemplatesView>(() => api("GET", "/api/config/templates"), `templates:${revision}`);
  const refresh = () => setRevision((n) => n + 1);

  if (view.error) return <ErrorNotice error={view.error} onRetry={view.reload} />;
  if (!view.data) return <Loading />;
  const v = view.data;
  const governedReason = v.mode === "governed" ? t("cft_governed_reason", { policy: v.governed?.policy ?? "" }) : null;
  const project = v.templates.filter((r) => r.origin === "project");
  const catalog = v.templates.filter((r) => r.origin === "builtin");

  const toggle = async (row: TemplateRow, enabled: boolean) => {
    setBusy(row.id);
    setError(null);
    try {
      await api("PUT", `/api/config/templates/${encodeURIComponent(row.id)}/enabled`, { enabled, expectedRevision: v.revision });
      toast(t(enabled ? "cft_on" : "cft_off", { id: row.id }), "ok");
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const list = (rows: TemplateRow[], title: string, testId: string) => (
    <section className="stack" aria-labelledby={`${testId}-title`}>
      <h2 id={`${testId}-title`}>{title}</h2>
      {rows.length === 0 ? <p className="small muted">{t("cft_none_project")}</p> : null}
      <ul className="tpl-list" data-testid={testId}>
        {rows.map((row) => {
          const badge = badgeFor(row);
          const locked = governedReason ?? (row.required ? t("cft_required_reason") : null);
          return (
            <li key={row.id} className="card pad tpl-row" data-template={row.id} data-badge={badge.key}>
              <div className="tpl-main">
                <div className="row wrap">
                  <h3>{row.label}</h3>
                  <code className="small">{row.id}</code>
                  <span data-testid="tpl-badge">
                    <Pill tone={badge.tone}>{badge.text}</Pill>
                  </span>
                  {row.support ? <Pill>{t("cft_support", { level: tOr(`cft_support_${row.support.level}`, row.support.level) })}</Pill> : null}
                </div>
                {row.description ? <p className="small muted">{row.description}</p> : null}
                {row.problem ? (
                  <p className="small" role="alert">
                    <Icon name="alert" /> {row.problem}
                  </p>
                ) : null}
                {locked ? <p className="small muted tpl-reason">{locked}</p> : null}
              </div>
              <div className="row tpl-actions">
                <button type="button" className="btn" aria-label={t("cft_details_aria", { name: row.label })} onClick={() => setOpen(row.id)}>
                  {t("cft_details")}
                </button>
                <Switch checked={row.enabled} label={t("cft_toggle_aria", { name: row.label })} disabled={locked !== null || busy === row.id} onChange={(next) => toggle(row, next)} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );

  return (
    <div className="stack">
      <div className="between wrap">
        <div>
          <h1>{t("cft_title")}</h1>
          <p>{t("cft_lead")}</p>
        </div>
        <button type="button" className="btn primary" disabled={governedReason !== null} onClick={() => setCreating(true)}>
          {t("cft_create")}
        </button>
      </div>
      {governedReason ? (
        <div className="notice warn" role="status" data-testid="governed-note">
          <Icon name="lock" />
          <p className="small">{governedReason}</p>
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}

      {v.conflicts.length > 0 ? (
        <div className="notice error" role="alert" data-testid="conflicts">
          <Icon name="alert" />
          <div>
            <strong>{t("cft_conflicts")}</strong>
            <ul>
              {v.conflicts.map((c, i) => (
                <li key={i}>
                  {c.message}
                  {c.fix ? <span className="small muted"> {c.fix}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {list(project, t("cft_project_title"), "project-templates")}
      {list(catalog, t("cft_catalog_title"), "catalog-templates")}

      <section className="card pad stack" aria-labelledby="cft-order-title">
        <h2 id="cft-order-title">{t("cft_order_title")}</h2>
        <p className="small muted">{t("cft_order_lead")}</p>
        <ol className="tpl-order">
          {v.order.map((l, i) => (
            <li key={`${l.layer}:${l.source ?? ""}:${i}`}>
              <strong>{tOr(`origin_layer_${l.layer}`, l.layer)}</strong>
              {l.source ? <span className="small muted"> {l.source}</span> : null}
            </li>
          ))}
        </ol>
      </section>

      {creating ? (
        <CreateTemplate
          folder={v.folder}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            toast(t("cft_created", { id, folder: v.folder }), "ok");
            refresh();
          }}
        />
      ) : null}
      {open ? <TemplateDetail id={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
