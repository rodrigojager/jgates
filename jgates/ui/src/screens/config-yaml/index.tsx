import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import { Editor } from "../../components/Editor";
import { ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import "./config-yaml.css";

// Configuração > YAML. The real files of the JGates in the editor: "Checar estrutura" (syntax, schema, references), save
// with the revision that was read, discard and export. What is typed and not saved is kept as a draft on the server.
export const screen: ScreenMeta = { id: "config-yaml", path: "/config/yaml", area: "config", navLabel: "cfy_nav", navPath: "/config/yaml", order: 44, icon: "file" };

interface FileEntry {
  file: string;
  kind: string;
  exists: boolean;
  revision: string | null;
  state: "saved" | "draft" | "conflict";
}

interface FileList {
  mode: "local" | "governed";
  governed: { policy: string } | null;
  files: FileEntry[];
}

interface Opened extends FileEntry {
  text: string;
  draft: { text: string; baseRevision: string | null; updatedAt: string; stale: boolean } | null;
}

interface Diagnostic {
  kind: "syntax" | "schema" | "reference";
  code: string;
  file: string;
  path: string;
  message: string;
  suggestion?: string;
  line?: number;
  column?: number;
  inThisFile: boolean;
}

const AUTOSAVE_MS = 500;

function Diagnostics({ list, file }: { list: Diagnostic[]; file: string }) {
  const mine = list.filter((d) => d.inThisFile);
  const others = list.filter((d) => !d.inThisFile);
  const item = (d: Diagnostic, i: number) => (
    <li key={`${d.file}:${d.path}:${d.code}:${i}`} data-diagnostic={d.code}>
      <Pill tone="red">{t(`cfy_kind_${d.kind}`)}</Pill> <code data-testid="diag-file">{d.file}</code>
      {d.path ? (
        <>
          {" "}
          {t("cfy_field")} <code data-testid="diag-path">{d.path}</code>
        </>
      ) : null}
      {d.line ? <span className="small muted"> {t("cfy_position", { line: d.line, column: d.column ?? 1 })}</span> : null}
      <div>{d.message}</div>
      {d.suggestion ? <div className="small muted">{t("cfy_suggestion", { name: d.suggestion })}</div> : null}
    </li>
  );
  return (
    <div className="notice error" role="alert" data-testid="check-errors">
      <Icon name="alert" />
      <div className="stack tight">
        <strong>{t("cfy_errors", { count: list.length })}</strong>
        <ul className="yaml-diags">{mine.map(item)}</ul>
        {others.length > 0 ? (
          <>
            <p className="small muted">{t("cfy_other_files", { file })}</p>
            <ul className="yaml-diags">{others.map(item)}</ul>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Opened({ list, entry, onChanged }: { list: FileList; entry: FileEntry; onChanged: () => void }) {
  const toast = useToast();
  const [loadTick, setLoadTick] = useState(0);
  const opened = useAsync<Opened>(() => api("GET", `/api/config/yaml/file?file=${encodeURIComponent(entry.file)}`), `yaml:${entry.file}:${loadTick}`);
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [revision, setRevision] = useState<string | null>(null);
  const [recovered, setRecovered] = useState<Opened["draft"]>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[] | null>(null);
  const [checkedOk, setCheckedOk] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  // A new document arrived (another file, a reload, a save): the screen state starts from it.
  useEffect(() => {
    const d = opened.data;
    if (!d) return;
    setSaved(d.text);
    setRevision(d.revision);
    setText(d.draft ? d.draft.text : d.text);
    setRecovered(d.draft);
    setDiagnostics(null);
    setCheckedOk(false);
    setConflict(false);
    setError(null);
  }, [opened.data]);

  const dirty = text !== null && text !== saved;
  const governed = list.mode === "governed";
  const reason = governed ? t("cfy_governed_reason", { policy: list.governed?.policy ?? "" }) : null;

  const keepDraft = useCallback(
    (next: string) => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        if (revision === null) return;
        api("PUT", "/api/config/yaml/draft", { file: entry.file, text: next, baseRevision: revision }).then(onChanged, () => undefined);
      }, AUTOSAVE_MS);
    },
    [entry.file, revision, onChanged],
  );
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  if (opened.error) return <ErrorNotice error={opened.error} onRetry={opened.reload} />;
  if (!opened.data || text === null) return <Loading />;

  const onChange = (next: string) => {
    setText(next);
    setCheckedOk(false);
    keepDraft(next);
  };

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ valid: boolean; diagnostics: Diagnostic[] }>("POST", "/api/config/yaml/check", { file: entry.file, text });
      setDiagnostics(r.valid ? null : r.diagnostics);
      setCheckedOk(r.valid);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("PUT", "/api/config/yaml/file", { file: entry.file, text, expectedRevision: revision });
      toast(t("cfy_saved", { file: entry.file }), "ok");
      setLoadTick((n) => n + 1);
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === "CONFIG_INVALID") {
        const details = (e.body.details as { diagnostics?: Diagnostic[] } | undefined)?.diagnostics;
        if (details) {
          setDiagnostics(details);
          setCheckedOk(false);
        }
      }
      if (e instanceof ApiError && e.code === "REVISION_CONFLICT") setConflict(true);
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setBusy(true);
    try {
      await api("DELETE", `/api/config/yaml/draft?file=${encodeURIComponent(entry.file)}`);
      toast(t("cfy_discarded", { file: entry.file }), "info");
      setLoadTick((n) => n + 1);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const exportFile = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/yaml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = entry.file.split("/").pop() ?? "jgates.yml";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack" data-testid="yaml-pane" data-file={entry.file}>
      <div className="between wrap">
        <div className="row wrap">
          <h2>
            <code>{entry.file}</code>
          </h2>
          <span data-testid="yaml-state">
            <Pill tone={conflict ? "red" : dirty ? undefined : "green"}>{conflict ? t("cfy_state_conflict") : dirty ? t("cfy_state_dirty") : t("cfy_state_saved")}</Pill>
          </span>
        </div>
        <div className="row wrap">
          <button type="button" className="btn" disabled={busy} onClick={check}>
            {t("cfy_check")}
          </button>
          <button type="button" className="btn primary" disabled={busy || !dirty || governed} onClick={save}>
            {t("cfy_save")}
          </button>
          <button type="button" className="btn" disabled={busy || (!dirty && !recovered)} onClick={discard}>
            {t("cfy_discard")}
          </button>
          <button type="button" className="btn" onClick={exportFile}>
            {t("cfy_export")}
          </button>
        </div>
      </div>

      {reason ? (
        <div className="notice warn" role="status" data-testid="governed-note">
          <Icon name="lock" />
          <p className="small">{reason}</p>
        </div>
      ) : null}
      {recovered ? (
        <div className="notice" role="status" data-testid="draft-note">
          <Icon name="info" />
          <p className="small">{recovered.stale ? t("cfy_draft_stale") : t("cfy_draft_kept")}</p>
        </div>
      ) : null}
      {checkedOk ? (
        <div className="notice ok" role="status" data-testid="check-ok">
          <Icon name="check-circle" />
          <p className="small">{t("cfy_check_ok")}</p>
        </div>
      ) : null}
      {diagnostics ? <Diagnostics list={diagnostics} file={entry.file} /> : null}
      {error ? <ErrorNotice error={error} /> : null}

      <Editor key={`${entry.file}:${loadTick}:${opened.data.revision}`} value={text} format="yaml" readOnly={governed} label={t("cfy_editor_label", { file: entry.file })} onChange={onChange} />
      <p className="small muted">{t("cfy_keys")}</p>
    </div>
  );
}

export default function ConfigYamlScreen() {
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useAsync<FileList>(() => api("GET", "/api/config/yaml"), `yaml-list:${tick}`);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  if (list.error) return <ErrorNotice error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const files = list.data.files;
  const current = files.find((f) => f.file === selected) ?? files[0];

  return (
    <div className="stack">
      <div>
        <h1>{t("cfy_title")}</h1>
        <p>{t("cfy_lead")}</p>
      </div>
      {!current ? (
        <p className="small muted">{t("cfy_none")}</p>
      ) : (
        <div className="yaml-layout">
          <nav aria-label={t("cfy_files_label")}>
            <ul className="yaml-files" data-testid="yaml-files">
              {files.map((f) => (
                <li key={f.file}>
                  <button type="button" className="file-item" aria-current={f.file === current.file ? "true" : undefined} data-file={f.file} onClick={() => setSelected(f.file)}>
                    <span className="grow">
                      <code>{f.file}</code>
                    </span>
                    {f.state !== "saved" ? <Pill tone={f.state === "conflict" ? "red" : undefined}>{t(f.state === "conflict" ? "cfy_state_conflict" : "cfy_state_draft")}</Pill> : null}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <Opened key={current.file} list={list.data} entry={current} onChanged={refresh} />
        </div>
      )}
    </div>
  );
}
