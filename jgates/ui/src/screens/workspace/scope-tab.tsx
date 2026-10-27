import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import { Dialog, ErrorNotice } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";
import { reasonText, type Classification } from "./components-tab";

type Mode = "auto" | "explicit" | "report-only";
const MODES: Mode[] = ["auto", "explicit", "report-only"];

export interface Settings {
  file: string;
  exists: boolean;
  revision: string | null;
  text: string;
  mode: Mode;
  include: string[];
  exclude: string[];
  valid: boolean;
  diagnostics: Array<{ message: string }>;
}

interface FileRow {
  path: string;
  rule: string | null;
  leaving: boolean;
  entering: boolean;
}

interface Preview {
  counts: { included: number; excluded: number; ambiguous: number; leaving: number; entering: number };
  truncated: boolean;
  listLimit: number;
  files: { included: FileRow[]; excluded: FileRow[]; ambiguous: FileRow[] };
  unsupported: Classification[];
  conflicting: Classification[];
}

const toLines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

function ruleText(row: FileRow, group: string): string {
  if (!row.rule) return "";
  if (row.rule === "include") return t("ws_preview_rule", { rule: t("ws_preview_rule_include") });
  if (group === "ambiguous") return t("ws_preview_rule", { rule: reasonText(row.rule) });
  return t("ws_preview_rule", { rule: row.rule });
}

function FileList({ group, rows, total, limit }: { group: "included" | "excluded" | "ambiguous"; rows: FileRow[]; total: number; limit: number }) {
  const titleKey = `ws_preview_${group}`;
  return (
    <section className="stack" aria-labelledby={`ws-files-${group}`} data-testid={`preview-${group}`}>
      <h3 id={`ws-files-${group}`}>
        {t(titleKey)} ({total})
      </h3>
      {rows.length === 0 ? (
        <p className="small">{t("ws_preview_none")}</p>
      ) : (
        <ul className="ws-files" tabIndex={0} aria-labelledby={`ws-files-${group}`}>
          {rows.map((row) => (
            <li key={row.path} data-leaving={row.leaving ? "true" : undefined}>
              <code>{row.path}</code>
              {row.leaving ? <span className="pill red">{t("ws_preview_leaves")}</span> : null}
              {row.entering ? <span className="pill green">{t("ws_preview_enters")}</span> : null}
              <span className="muted" data-testid="file-rule">
                {ruleText(row, group)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {total > rows.length ? <p className="small">{t("ws_preview_more", { limit })}</p> : null}
    </section>
  );
}

export function ScopeTab({ settings, refreshKey, onChanged }: { settings: Settings; refreshKey: number; onChanged: () => void }) {
  const toast = useToast();
  const [include, setInclude] = useState(settings.include.join("\n"));
  const [exclude, setExclude] = useState(settings.exclude.join("\n"));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showYaml, setShowYaml] = useState(false);
  const seen = useRef(settings.revision);

  // A new revision of the file (saved here, or reloaded after a conflict) resets the fields to what the file says.
  useEffect(() => {
    if (seen.current === settings.revision && preview) return;
    seen.current = settings.revision;
    setInclude(settings.include.join("\n"));
    setExclude(settings.exclude.join("\n"));
    setConflict(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.revision]);

  const includeList = toLines(include);
  const excludeList = toLines(exclude);
  const dirty = !sameList(includeList, settings.include) || !sameList(excludeList, settings.exclude);

  // The preview follows what is typed, before anything is saved.
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      api<Preview>("POST", "/api/workspace/preview", { include: includeList, exclude: excludeList }).then(
        (p) => live && (setPreview(p), setError(null)),
        (e) => live && setError(e),
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [include, exclude, settings.revision, settings.mode, refreshKey]);

  const save = async (body: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await api("PUT", "/api/workspace/settings", { expectedRevision: settings.revision, ...body });
      toast(t("ws_saved_toast"), "ok");
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === "REVISION_CONFLICT") setConflict(true);
      else setError(e);
    } finally {
      setSaving(false);
    }
  };

  const state = conflict ? "conflict" : dirty ? "unsaved" : settings.exists ? "saved" : "absent";

  return (
    <div className="stack">
      <div>
        <h2>{t("ws_scope_title")}</h2>
        <p>{t("ws_scope_lead")}</p>
      </div>

      <div className={`notice ${state === "conflict" ? "warn" : state === "unsaved" ? "info" : "ok"}`} role="status" data-testid="scope-state" data-state={state}>
        <Icon name={state === "saved" ? "check" : "alert"} />
        <div>
          <strong>{t(`ws_state_${state}`)}</strong>
          {state === "conflict" ? (
            <div className="row">
              <button type="button" className="btn" onClick={onChanged}>
                <Icon name="refresh" />
                {t("ws_conflict_reload")}
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {!settings.valid ? (
        <div className="notice warn" role="alert">
          <Icon name="alert" />
          <span>{t("ws_invalid_file", { message: settings.diagnostics[0]?.message ?? "" })}</span>
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}

      <fieldset className="ws-radios">
        <legend>
          <strong>{t("ws_mode_legend")}</strong>
        </legend>
        {MODES.map((mode) => (
          <label key={mode}>
            <input type="radio" name="ws-mode" value={mode} checked={settings.mode === mode} disabled={saving} onChange={() => save({ mode })} />
            <div>
              <strong>{t(`ws_mode_${mode}`)}</strong>
              <div className="small">{t(`ws_mode_hint_${mode}`)}</div>
            </div>
          </label>
        ))}
      </fieldset>
      {settings.mode === "explicit" ? <p className="small">{t("ws_mode_note_explicit")}</p> : null}
      <div className="row">
        <button type="button" className="btn" onClick={() => setShowYaml(true)}>
          <Icon name="file" />
          {t("ws_view_yaml")}
        </button>
      </div>

      <div className="ws-split two">
        <div className="stack">
          <label htmlFor="ws-include">
            <strong>{t("ws_include")}</strong>
          </label>
          <textarea id="ws-include" className="ws-patterns" value={include} onChange={(e) => setInclude(e.target.value)} spellCheck={false} aria-describedby="ws-include-hint" />
          <p className="small" id="ws-include-hint">
            {t("ws_include_hint")}
          </p>
        </div>
        <div className="stack">
          <label htmlFor="ws-exclude">
            <strong>{t("ws_exclude")}</strong>
          </label>
          <textarea id="ws-exclude" className="ws-patterns" value={exclude} onChange={(e) => setExclude(e.target.value)} spellCheck={false} aria-describedby="ws-exclude-hint" />
          <p className="small" id="ws-exclude-hint">
            {t("ws_patterns_hint")}
          </p>
        </div>
      </div>

      <section className="stack" aria-labelledby="ws-preview-title">
        <h2 id="ws-preview-title">{t("ws_preview_title")}</h2>
        {!preview ? (
          <p className="spinner-text" role="status">
            {t("ws_preview_loading")}
          </p>
        ) : (
          <div className="stack" data-testid="scope-preview">
            <p role="status" data-testid="preview-summary">
              {t("ws_preview_counts", preview.counts)}{" "}
              {preview.counts.leaving > 0
                ? t("ws_preview_leaving", { count: preview.counts.leaving })
                : preview.counts.entering > 0
                  ? t("ws_preview_entering", { count: preview.counts.entering })
                  : t("ws_preview_nochange")}
            </p>
            {preview.truncated ? <p className="small">{t("ws_preview_truncated")}</p> : null}
            <div className="ws-split two">
              <FileList group="excluded" rows={preview.files.excluded} total={preview.counts.excluded} limit={preview.listLimit} />
              <FileList group="ambiguous" rows={preview.files.ambiguous} total={preview.counts.ambiguous} limit={preview.listLimit} />
            </div>
            <FileList group="included" rows={preview.files.included} total={preview.counts.included} limit={preview.listLimit} />
          </div>
        )}
        <div className="row">
          <button type="button" className="btn primary" disabled={!dirty || saving || conflict} onClick={() => save({ include: includeList, exclude: excludeList })}>
            {saving ? t("ws_saving") : t("ws_save")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!dirty || saving}
            onClick={() => {
              setInclude(settings.include.join("\n"));
              setExclude(settings.exclude.join("\n"));
            }}
          >
            {t("ws_discard")}
          </button>
        </div>
      </section>

      <div className="ws-split two">
        <section className="stack" aria-labelledby="ws-unsupported-title" data-testid="unsupported">
          <h2 id="ws-unsupported-title">{t("ws_unsupported_title")}</h2>
          {preview && preview.unsupported.length === 0 ? <p>{t("ws_unsupported_none")}</p> : null}
          <ul>
            {(preview?.unsupported ?? []).map((c, i) => (
              <li key={`${c.componentRoot}:${c.language}:${i}`}>
                <strong>{t("ws_unsupported_item", { language: c.language ?? "?", path: c.componentRoot })}</strong>
                <div className="small">{t("ws_unsupported_reason")}</div>
                <div className="small">
                  <code>{c.evidencePaths.join(", ")}</code>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section className="stack" aria-labelledby="ws-conflict-title" data-testid="lockfile-conflicts">
          <h2 id="ws-conflict-title">{t("ws_conflict_title")}</h2>
          {preview && preview.conflicting.length === 0 ? <p>{t("ws_conflict_none")}</p> : null}
          <ul>
            {(preview?.conflicting ?? []).map((c, i) => (
              <li key={`${c.componentRoot}:${i}`}>
                <strong>{t("ws_conflict_item", { path: c.componentRoot, files: c.evidencePaths.filter((p) => /lock|\.yaml$|\.lockb$/i.test(p)).join(", ") || c.evidencePaths.join(", ") })}</strong>
                <div className="small">{t("ws_conflict_reason")}</div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {showYaml ? (
        <Dialog title={t("ws_yaml_title")} onClose={() => setShowYaml(false)} wide>
          {settings.exists ? (
            <pre className="command" data-testid="yaml-text" tabIndex={0}>
              {settings.text}
            </pre>
          ) : (
            <p>{t("ws_yaml_missing")}</p>
          )}
        </Dialog>
      ) : null}
    </div>
  );
}
