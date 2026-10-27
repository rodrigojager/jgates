import { useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { LockedField } from "../../components/LockedField";
import { OriginLine, type OriginRef, type SaveTarget } from "../../components/origin";
import { useToast } from "../../components/Toast";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import "./config-execution.css";

// Configuração > Execução. Runner, concurrency, network, fail-fast and budgets: policy of the repository (execution.* in
// jgates.yml), never a personal preference. The retention of runs is per user and lives in Armazenamento.
export const screen: ScreenMeta = { id: "config-execution", path: "/config/execution", area: "config", navLabel: "cfe_nav", navPath: "/config/execution", order: 43, icon: "settings" };

interface Field {
  key: string;
  kind: "enum" | "integer" | "boolean";
  options: string[] | null;
  applied: boolean;
  value: string | number | boolean | null;
  explicit: boolean;
  origin: OriginRef;
  saveTo: SaveTarget;
}

interface View {
  mode: "local" | "governed";
  governed: { policy: string } | null;
  revision: string | null;
  fields: Field[];
}

const GROUPS: Array<{ id: string; keys: string[] }> = [
  { id: "run", keys: ["runner", "concurrency", "network", "failFast"] },
  { id: "budgets", keys: ["timeoutSeconds", "budgets.totalSeconds", "budgets.memoryMegabytes", "budgets.processes", "budgets.logMegabytes"] },
];

function show(field: Field): string {
  if (field.value === null || field.value === undefined) return t("cfe_unset");
  if (field.kind === "boolean") return t(field.value ? "cfe_on" : "cfe_off");
  if (field.kind === "enum") return tOr(`cfe_opt_${field.key}_${field.value}`, String(field.value));
  return String(field.value);
}

function FieldRow({ field, locked, busy, onSave }: { field: Field; locked: string | null; busy: boolean; onSave: (key: string, value: string | number | boolean | null) => void }) {
  const initial = field.value === null || field.value === undefined ? "" : String(field.value);
  const [draft, setDraft] = useState(initial);
  const label = t(`cfe_f_${field.key}`);
  const inputId = `cfe-${field.key}`;
  const parsed = field.kind === "integer" ? Number(draft) : field.kind === "boolean" ? draft === "true" : draft;
  const valid = field.kind === "integer" ? Number.isInteger(parsed) && (parsed as number) >= 1 : draft !== "";
  const changed = draft !== initial;

  if (locked) {
    return (
      <div data-field={field.key}>
        <LockedField label={label} value={show(field)} reason={locked} />
      </div>
    );
  }
  return (
    <div className="field" data-field={field.key} {...(field.applied ? {} : { "data-control-unavailable": t("cfe_not_applied") })}>
      <div className="row wrap">
        <label htmlFor={inputId} className="field-label">
          {label}
        </label>
        {field.kind === "integer" ? (
          <input id={inputId} className="input number" type="number" min={1} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t("cfe_unset")} />
        ) : (
          <select id={inputId} className="input" value={draft} onChange={(e) => setDraft(e.target.value)}>
            {draft === "" ? <option value="">{t("cfe_unset")}</option> : null}
            {(field.kind === "boolean" ? ["false", "true"] : (field.options as string[])).map((o) => (
              <option key={o} value={o}>
                {field.kind === "boolean" ? t(o === "true" ? "cfe_on" : "cfe_off") : tOr(`cfe_opt_${field.key}_${o}`, o)}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="btn" disabled={!changed || !valid || busy} aria-label={t("cfe_save_aria", { name: label })} onClick={() => onSave(field.key, parsed)}>
          {t("save")}
        </button>
        {field.explicit ? (
          <button type="button" className="btn" disabled={busy} aria-label={t("cfe_reset_aria", { name: label })} onClick={() => onSave(field.key, null)}>
            {t("cfe_reset")}
          </button>
        ) : null}
        {!field.applied ? <Pill>{t("cfe_not_applied")}</Pill> : null}
      </div>
      <p className="small muted">{t(`cfe_h_${field.key}`)}</p>
      <OriginLine origin={field.origin} saveTo={field.saveTo} />
    </div>
  );
}

export default function ConfigExecutionScreen() {
  const toast = useToast();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const view = useAsync<View>(() => api("GET", "/api/config/execution"), `execution:${revision}`);

  if (view.error) return <ErrorNotice error={view.error} onRetry={view.reload} />;
  if (!view.data) return <Loading />;
  const v = view.data;
  const locked = v.mode === "governed" ? t("cfe_governed_reason", { policy: v.governed?.policy ?? "" }) : null;

  const save = async (key: string, value: string | number | boolean | null) => {
    setBusy(true);
    setError(null);
    try {
      await api("PUT", "/api/config/execution", { expectedRevision: v.revision, changes: { [key]: value } });
      toast(t("cfe_saved", { name: t(`cfe_f_${key}`) }), "ok");
      setRevision((n) => n + 1);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div>
        <h1>{t("cfe_title")}</h1>
        <p>{t("cfe_lead")}</p>
      </div>
      {locked ? (
        <div className="notice warn" role="status" data-testid="governed-note">
          <Icon name="lock" />
          <p className="small">{locked}</p>
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}

      {GROUPS.map((group) => (
        <section key={group.id} className="card pad stack" aria-labelledby={`cfe-${group.id}-title`}>
          <h2 id={`cfe-${group.id}-title`}>{t(`cfe_group_${group.id}`)}</h2>
          {group.keys.map((key) => {
            const field = v.fields.find((f) => f.key === key);
            return field ? <FieldRow key={`${key}:${String(field.value)}:${v.revision}`} field={field} locked={locked} busy={busy} onSave={save} /> : null;
          })}
        </section>
      ))}

      <div className="notice ok">
        <Icon name="info" />
        <p className="small">
          {t("cfe_retention_note")} <a href="#/preferences/storage">{t("cfe_retention_link")}</a>
        </p>
      </div>
    </div>
  );
}
