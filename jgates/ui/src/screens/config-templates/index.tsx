import { useState } from "react";
import { api } from "../../api";
import { Dialog, ErrorNotice, Loading, Pill, Updating, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { ProjectMascotStrip } from "../../components/ProjectMascotStrip";
import { useToast } from "../../components/Toast";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { Switch } from "../config-profiles/switch";
import { TemplateWizard } from "./create";
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
  unreferenced: boolean;
}

interface TemplatesView {
  mode: "local" | "governed";
  governed: { policy: string } | null;
  revision: string | null;
  templates: TemplateRow[];
  /** The languages of the project's components (javascript counts as typescript). */
  projectLanguages?: string[];
  conflicts: Array<{ code: string; message: string; fix: string | null; file: string | null }>;
  order: Array<{ layer: string; source: string | null }>;
  folder: string;
}

/** javascript and typescript are one toolchain for the templates that serve them. */
const languageKey = (l: string): string => (/^(javascript|js|ts)$/i.test(l) ? "typescript" : l.toLowerCase());

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
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [scope, setScope] = useState<"project" | "all">("project");
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
      const answer = await api<TemplatesView>("PUT", `/api/config/templates/${encodeURIComponent(row.id)}/enabled`, { enabled, expectedRevision: v.revision });
      toast(t(enabled ? "cft_on" : "cft_off", { id: row.id }), "ok");
      // The answer is the view the GET gives: the screen takes it instead of asking again.
      if (answer?.templates) view.prime(answer);
      else refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const adopt = async (row: TemplateRow) => {
    setBusy(row.id);
    setError(null);
    try {
      const answer = await api<TemplatesView>("POST", `/api/config/templates/${encodeURIComponent(row.id)}/adopt`, { expectedRevision: v.revision });
      toast(t("cft_adopted", { id: row.id }), "ok");
      if (answer?.templates) view.prime(answer);
      else refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const answer = await api<TemplatesView>("DELETE", `/api/config/templates/${encodeURIComponent(id)}?expectedRevision=${v.revision ?? ""}`);
      toast(t("cft_deleted", { id }), "ok");
      setDeleting(null);
      if (answer?.templates) view.prime(answer);
      else refresh();
    } catch (e) {
      setDeleting(null);
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const renderRow = (row: TemplateRow) => {
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
              {row.unreferenced ? <Pill tone="gold">{t("cft_unreferenced")}</Pill> : null}
              {row.support ? <Pill>{t("cft_support", { level: tOr(`cft_support_${row.support.level}`, row.support.level) })}</Pill> : null}
            </div>
            {row.description ? <p className="small muted">{row.description}</p> : null}
            {row.problem ? (
              <p className="small" role="alert">
                <Icon name="alert" /> {row.problem}
              </p>
            ) : null}
            {locked ? <p className="small muted tpl-reason">{locked}</p> : null}
            {row.unreferenced ? <p className="small muted tpl-reason">{t("cft_unreferenced_help", { source: row.source })}</p> : null}
          </div>
          <div className="row tpl-actions">
            <button type="button" className="btn" aria-label={t("cft_details_aria", { name: row.label })} onClick={() => setOpen(row.id)}>
              {t("cft_details")}
            </button>
            {row.origin === "project" ? (
              <button type="button" className="btn" disabled={governedReason !== null || busy === row.id} aria-label={t("cft_edit_aria", { name: row.label })} onClick={() => setEditing(row.id)}>
                {t("cft_edit")}
              </button>
            ) : null}
            {row.origin === "project" ? (
              <button type="button" className="btn" disabled={governedReason !== null || busy === row.id || (row.required && row.declared)} aria-label={t("cft_delete_aria", { name: row.label })} onClick={() => setDeleting(row.id)}>
                {t("cft_delete")}
              </button>
            ) : null}
            {row.unreferenced ? (
              <button type="button" className="btn primary" disabled={governedReason !== null || busy === row.id} aria-label={t("cft_adopt_aria", { name: row.label })} onClick={() => void adopt(row)}>
                {t("cft_adopt")}
              </button>
            ) : (
              <Switch checked={row.enabled} label={t("cft_toggle_aria", { name: row.label })} disabled={locked !== null || busy === row.id} reason={locked} pending={busy === row.id} onChange={(next) => toggle(row, next)} />
            )}
          </div>
        </li>
      );
  };

  const list = (rows: TemplateRow[], title: string, testId: string) => (
    <section className="stack" aria-labelledby={`${testId}-title`}>
      <h2 id={`${testId}-title`}>{title}</h2>
      {rows.length === 0 ? <p className="small muted">{t("cft_none_project")}</p> : null}
      <ul className="tpl-list" data-testid={testId}>
        {rows.map(renderRow)}
      </ul>
    </section>
  );

  // The catalog: what applies to every project stays in view; the rest is grouped by language, collapsed and counted, and
  // by default only the languages of this project are listed (PLAN-consistency.md section 4).
  const mine = new Set(v.projectLanguages ?? []);
  const required = catalog.filter((r) => r.required);
  const optional = catalog.filter((r) => !r.required);
  const groupOf = (r: TemplateRow): string => (r.match.languages[0] ? languageKey(r.match.languages[0]) : "");
  const relevant = (r: TemplateRow) => groupOf(r) === "" || mine.has(groupOf(r)) || r.components.length > 0;
  const shown = scope === "all" ? optional : optional.filter(relevant);
  const groupIds = [...new Set(shown.map(groupOf))].sort((x, y) => (x === "" ? -1 : y === "" ? 1 : Number(mine.has(y)) - Number(mine.has(x)) || x.localeCompare(y)));
  const hiddenCount = optional.length - shown.length;
  const languageLabel = (id: string) => (id === "" ? t("lang_any") : tOr(`lang_${id}`, id));
  const catalogSection = (
    <section className="stack" aria-labelledby="catalog-templates-title">
      <h2 id="catalog-templates-title">{t("cft_catalog_title")}</h2>
      {required.length > 0 ? (
        <ul className="tpl-list" data-testid="catalog-templates">
          {required.map(renderRow)}
        </ul>
      ) : null}
      <fieldset className="row wrap" data-testid="templates-scope">
        <legend className="small">{t("cft_scope_legend")}</legend>
        <label className="row">
          <input type="radio" name="templates-scope" value="project" checked={scope === "project"} onChange={() => setScope("project")} />
          <span>{t("cft_scope_project")}</span>
        </label>
        <label className="row">
          <input type="radio" name="templates-scope" value="all" checked={scope === "all"} onChange={() => setScope("all")} />
          <span>{t("cft_scope_all")}</span>
        </label>
      </fieldset>
      <p className="small muted">{mine.size > 0 ? t("cft_scope_note", { languages: [...mine].map(languageLabel).join(", ") }) : t("cft_scope_note_none")}</p>
      {groupIds.map((id) => {
        const rows = shown.filter((r) => groupOf(r) === id);
        const active = rows.filter((r) => r.enabled).length;
        return (
          <details key={id || "any"} className="card pad tpl-group" data-group={id || "any"} data-testid="template-group">
            <summary>
              <strong>{languageLabel(id)}</strong> <span className="small muted">{t("cft_group_count", { count: rows.length, active })}</span>
            </summary>
            <ul className="tpl-list">{rows.map(renderRow)}</ul>
          </details>
        );
      })}
      {hiddenCount > 0 ? (
        <p className="small muted" data-testid="templates-scope-hidden">
          {t("cft_scope_hidden", { count: hiddenCount })}
        </p>
      ) : null}
    </section>
  );

  return (
    <div className="stack" aria-busy={view.reloading}>
      <div className="between wrap">
        <div>
          <h1>{t("cft_title")}</h1>
          <p>{t("cft_lead")}</p>
          <Updating active={view.reloading} />
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
      <ProjectMascotStrip />
      {catalogSection}

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

      {creating || editing ? (
        <TemplateWizard
          folder={v.folder}
          editing={editing}
          revision={v.revision}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onDone={(id) => {
            const wasEditing = editing !== null;
            setCreating(false);
            setEditing(null);
            toast(wasEditing ? t("cft_edited", { id }) : t("cft_created", { id, folder: v.folder }), "ok");
            refresh();
          }}
        />
      ) : null}
      {deleting ? (
        <Dialog title={t("cft_delete_title", { id: deleting })} onClose={() => setDeleting(null)}>
          <div className="stack" data-testid="delete-template">
            <p>{t("cft_delete_lead", { id: deleting })}</p>
            <div className="row">
              <button type="button" className="btn primary" disabled={busy === deleting} onClick={() => void remove(deleting)}>
                {t("cft_delete_confirm")}
              </button>
              <button type="button" className="btn" onClick={() => setDeleting(null)}>
                {t("cancel")}
              </button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {open ? <TemplateDetail id={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
