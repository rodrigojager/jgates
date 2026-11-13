import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import { Editor } from "../../components/Editor";
import { ErrorNotice, Loading, Pill, Updating, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { currentQuery } from "../../app/route";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import "./config-yaml.css";

// Configuração > YAML. The real files of the JGates in the editor: the structure is checked while typing (syntax, schema,
// references) with the problems marked in the text and listed with file, key and line; save with the revision that was
// read; discard and export. What is typed and not saved is kept as a draft on the server. A link opens a file at a key:
// #/config/yaml?file=.jgates/tools.yml&path=tools.zap.target (or &line=12).
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
  missing: string[];
}

interface Opened extends FileEntry {
  text: string;
  draft: { text: string; baseRevision: string | null; updatedAt: string; stale: boolean } | null;
  at?: { path: string; line: number; column: number; resolved: boolean };
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

interface Target {
  path: string;
  line: number | null;
  n: number;
}

const AUTOSAVE_MS = 500;
const CHECK_MS = 350;

function targetFromHash(n: number): Target {
  const q = currentQuery();
  const line = Number(q.get("line"));
  return { path: q.get("path") ?? "", line: Number.isInteger(line) && line > 0 ? line : null, n };
}

function Diagnostics({ list, file, onGoto }: { list: Diagnostic[]; file: string; onGoto: (line: number) => void }) {
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
      {d.inThisFile && d.line ? (
        <button type="button" className="link-btn small" data-testid="diag-goto" onClick={() => onGoto(d.line as number)}>
          {t("cfy_goto", { line: d.line })}
        </button>
      ) : null}
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

function Opened({ list, entry, target, onChanged }: { list: FileList; entry: FileEntry; target: Target; onChanged: () => void }) {
  const toast = useToast();
  const [loadTick, setLoadTick] = useState(0);
  const query = `file=${encodeURIComponent(entry.file)}${target.path ? `&path=${encodeURIComponent(target.path)}` : ""}`;
  const opened = useAsync<Opened>(() => api("GET", `/api/config/yaml/file?${query}`), `yaml:${query}:${loadTick}`);
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [revision, setRevision] = useState<string | null>(null);
  const [recovered, setRecovered] = useState<Opened["draft"]>(null);
  // null until the first check of the text on the screen answers.
  const [result, setResult] = useState<{ valid: boolean; diagnostics: Diagnostic[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkTick, setCheckTick] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [jump, setJump] = useState(0);
  const [jumpLine, setJumpLine] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  const checkSeq = useRef(0);

  // A new document arrived (another file, a reload, a save): the screen state starts from it.
  useEffect(() => {
    const d = opened.data;
    if (!d) return;
    setSaved(d.text);
    setRevision(d.revision);
    setText(d.draft ? d.draft.text : d.text);
    setRecovered(d.draft);
    setResult(null);
    setCheckTick((n) => n + 1);
    setConflict(false);
    setError(null);
  }, [opened.data]);

  // The structure is checked while typing: a pause after the last key asks the server (nothing is written).
  useEffect(() => {
    if (text === null) return;
    const mine = ++checkSeq.current;
    setChecking(true);
    const handle = window.setTimeout(() => {
      api<{ valid: boolean; diagnostics: Diagnostic[] }>("POST", "/api/config/yaml/check", { file: entry.file, text }).then(
        (r) => {
          if (mine !== checkSeq.current) return;
          setResult({ valid: r.valid, diagnostics: r.diagnostics });
          setChecking(false);
        },
        (e) => {
          if (mine !== checkSeq.current) return;
          setError(e);
          setChecking(false);
        },
      );
    }, CHECK_MS);
    return () => window.clearTimeout(handle);
  }, [text, checkTick, entry.file]);

  const dirty = text !== null && text !== saved;
  const governed = list.mode === "governed";
  const reason = governed ? t("cfy_governed_reason", { policy: list.governed?.policy ?? "" }) : null;
  const diagnostics = result && !result.valid ? result.diagnostics : null;
  const mine = (diagnostics ?? []).filter((d) => d.inThisFile);
  const blocked = mine.length > 0;

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
    keepDraft(next);
  };

  const recheck = () => setCheckTick((n) => n + 1);

  const save = async (allowInvalid: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api("PUT", "/api/config/yaml/file", { file: entry.file, text, expectedRevision: revision, ...(allowInvalid ? { allowInvalid: true } : {}) });
      toast(t("cfy_saved", { file: entry.file }), "ok");
      setLoadTick((n) => n + 1);
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === "CONFIG_INVALID") {
        const details = (e.body.details as { diagnostics?: Diagnostic[] } | undefined)?.diagnostics;
        if (details) setResult({ valid: false, diagnostics: details });
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

  const goto = (line: number) => {
    setJumpLine(line);
    setJump((n) => n + 1);
  };
  // The first opening lands on the key of the link (the line of the key, else the line asked for); later loads keep the cursor.
  const landing = loadTick === 0 ? (opened.data.at ? opened.data.at.line : target.line) : null;
  const editorLine = jumpLine ?? landing;
  const keyMissing = loadTick === 0 && opened.data.at !== undefined && !opened.data.at.resolved;

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
          <Updating active={opened.reloading} />
        </div>
        <div className="row wrap">
          <button type="button" className="btn" disabled={busy} onClick={recheck}>
            {t("cfy_check")}
          </button>
          <button type="button" className="btn primary" disabled={busy || !dirty || governed || checking || blocked} onClick={() => void save(false)}>
            {t("cfy_save")}
          </button>
          {blocked && dirty && !governed ? (
            <button type="button" className="btn" disabled={busy} title={t("cfy_save_anyway_hint")} onClick={() => void save(true)}>
              {t("cfy_save_anyway")}
            </button>
          ) : null}
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
      {keyMissing ? (
        <div className="notice" role="status" data-testid="key-missing">
          <Icon name="info" />
          <p className="small">{t("cfy_at_missing", { path: target.path })}</p>
        </div>
      ) : null}
      {result?.valid && !checking ? (
        <div className="notice ok" role="status" data-testid="check-ok">
          <Icon name="check-circle" />
          <p className="small">{t("cfy_check_ok")}</p>
        </div>
      ) : null}
      {diagnostics ? <Diagnostics list={diagnostics} file={entry.file} onGoto={goto} /> : null}
      {error ? <ErrorNotice error={error} /> : null}

      <Editor
        key={`${entry.file}:${loadTick}:${opened.data.revision}`}
        value={text}
        format="yaml"
        readOnly={governed}
        label={t("cfy_editor_label", { file: entry.file })}
        line={editorLine}
        lineJump={jump}
        markers={mine.filter((d) => d.line).map((d) => ({ line: d.line as number, message: d.message }))}
        onChange={onChange}
      />
      <p className="small muted">{t("cfy_keys")}</p>
    </div>
  );
}

export default function ConfigYamlScreen() {
  const toast = useToast();
  const [tick, setTick] = useState(0);
  // A link can name the file to open and the key in it (#/config/yaml?file=.jgates/tools.yml&path=tools.zap.target).
  const [selected, setSelected] = useState<string | null>(() => currentQuery().get("file"));
  const [target, setTarget] = useState<Target>(() => targetFromHash(0));
  const [creating, setCreating] = useState<string | null>(null);
  const [createError, setCreateError] = useState<unknown>(null);
  const list = useAsync<FileList>(() => api("GET", "/api/config/yaml"), `yaml-list:${tick}`);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // The same screen reached again by another link (another file or key) opens there.
  useEffect(() => {
    const onHash = () => {
      const file = currentQuery().get("file");
      if (!file) return;
      setSelected(file);
      setTarget((old) => targetFromHash(old.n + 1));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const create = async (file: string) => {
    setCreating(file);
    setCreateError(null);
    try {
      await api("POST", "/api/config/yaml/create", { file });
      toast(t("cfy_created", { file }), "ok");
      setSelected(file);
      setTarget((old) => ({ path: "", line: null, n: old.n + 1 }));
      refresh();
    } catch (e) {
      setCreateError(e);
    } finally {
      setCreating(null);
    }
  };

  if (list.error) return <ErrorNotice error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const files = list.data.files;
  const missing = list.data.missing ?? [];
  const wantsMissing = selected !== null && missing.includes(selected);
  const current = wantsMissing ? undefined : (files.find((f) => f.file === selected) ?? files[0]);
  const governed = list.data.mode === "governed";

  return (
    <div className="stack">
      <div>
        <h1>{t("cfy_title")}</h1>
        <p>{t("cfy_lead")}</p>
      </div>
      <Updating active={list.reloading} />
      {!current && !wantsMissing && missing.length === 0 ? (
        <p className="small muted">{t("cfy_none")}</p>
      ) : (
        <div className="yaml-layout">
          <nav aria-label={t("cfy_files_label")}>
            <ul className="yaml-files" data-testid="yaml-files">
              {files.map((f) => (
                <li key={f.file}>
                  <button type="button" className="file-item" aria-current={f.file === current?.file ? "true" : undefined} data-file={f.file} onClick={() => setSelected(f.file)}>
                    <span className="grow">
                      <code>{f.file}</code>
                    </span>
                    {f.state !== "saved" ? <Pill tone={f.state === "conflict" ? "red" : undefined}>{t(f.state === "conflict" ? "cfy_state_conflict" : "cfy_state_draft")}</Pill> : null}
                  </button>
                </li>
              ))}
              {missing.map((file) => (
                <li key={file} data-missing={file}>
                  <div className="file-item row" aria-current={wantsMissing && selected === file ? "true" : undefined}>
                    <button type="button" className="link-btn grow" data-file={file} onClick={() => setSelected(file)}>
                      <code>{file}</code> <span className="small muted">{t("cfy_missing_tag")}</span>
                    </button>
                    <button type="button" className="btn small" data-testid="create-file" data-file={file} disabled={governed || creating !== null} onClick={() => void create(file)}>
                      {t("cfy_create")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </nav>
          {current ? (
            <Opened key={`${current.file}:${target.n}`} list={list.data} entry={current} target={target} onChanged={refresh} />
          ) : (
            <div className="stack" data-testid="yaml-missing" data-file={selected ?? undefined}>
              <h2>
                <code>{selected}</code>
              </h2>
              <p>{t("cfy_missing_file", { file: selected ?? "" })}</p>
              {createError ? <ErrorNotice error={createError} /> : null}
              <div className="row">
                <button type="button" className="btn primary" disabled={governed || creating !== null} onClick={() => selected && void create(selected)}>
                  {t("cfy_create")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
