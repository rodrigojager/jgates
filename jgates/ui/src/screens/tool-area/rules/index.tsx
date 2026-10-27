import { useState } from "react";
import { ApiError, api, documentPath } from "../../../api";
import { ErrorNotice, Loading, Pill, useAsync } from "../../../components/common";
import { Icon } from "../../../components/icons";
import { t } from "../../../i18n";

/** Starting text of a new rule: valid against the rule contract, with a pattern the author replaces. */
const NEW_RULE = (id: string) => `rules:
  - id: ${id}
    message: Descreva o problema encontrado
    severity: WARNING
    languages: [python]
    pattern: substitua(...)
`;

interface RuleFileInfo {
  entry: string | null;
  path: string | null;
  revision: string | null;
  validation: { status: "valid" | "invalid"; issues: Array<{ kind: string; code: string; message: string; line: number | null }>; rules: Array<{ id: string }> };
}

interface RulesPayload {
  rules: {
    binding: string | null;
    kind: "file" | "directory" | null;
    relPath: string | null;
    access: "read" | "write" | null;
    valid: boolean;
    problem: { code: string; message: string } | null;
    duplicates: Array<{ id: string; files: string[] }>;
    total: number;
    files: RuleFileInfo[];
  };
}

const rulesPath = (instance: string, suffix = "") => `/api/rules/${encodeURIComponent(instance)}${suffix}`;

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/\.ya?ml$/, "").replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * List of the local rule files of a Semgrep instance: search, syntax and contract status of each file, create and
 * rename. Opening a file hands the entry to the document editor of the tool area (`onOpen`).
 */
export function RulesList({ instance, onOpen, current, refreshKey, onChanged }: { instance: string; onOpen: (binding: string, entry: string | null) => void; current: string | null; refreshKey?: number; onChanged?: () => void }) {
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [tick, setTick] = useState(0);
  const list = useAsync<RulesPayload>(() => api("GET", rulesPath(instance) + (applied ? `?q=${encodeURIComponent(applied)}` : "")), `rules:${instance}:${applied}:${tick}:${refreshKey ?? 0}`);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ file: RuleFileInfo; to: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const data = list.data?.rules;
  const binding = data?.binding ?? "config";
  const canWrite = data?.kind === "directory" && data.access === "write" && data.problem?.code !== "BINDING_MISSING" && data.problem?.code !== "BINDING_REFUSED";

  async function create() {
    const id = slug(newName);
    if (!id) return;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      // Creating is an explicit action: expectedRevision null means "the file must not exist yet".
      await api("PUT", documentPath(instance, binding), { expectedRevision: null, text: NEW_RULE(id), entry: `${id}.yml` });
      setCreating(false);
      setNewName("");
      setNotice(t("rules_created", { file: `${id}.yml` }));
      setTick((n) => n + 1);
      onChanged?.();
      onOpen(binding, `${id}.yml`);
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  }

  async function rename() {
    if (!renaming || !renaming.file.entry || !renaming.file.revision) return;
    const to = `${slug(renaming.to)}.yml`;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const r = await api("POST", rulesPath(instance, "/rename"), { from: renaming.file.entry, to, expectedRevision: renaming.file.revision, binding });
      const pending = (r.rename.pending as Array<{ file: string; line: number }>) ?? [];
      setNotice(pending.length ? t("rules_renamed_pending", { file: to, count: pending.length, where: pending.map((p) => `${p.file}:${p.line}`).join(", ") }) : t("rules_renamed", { file: to }));
      setRenaming(null);
      setTick((n) => n + 1);
      onChanged?.();
    } catch (e) {
      setFailure(e instanceof ApiError && e.code === "REVISION_CONFLICT" ? new ApiError(e.status, e.code, t("rules_conflict"), null, e.body) : e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={t("rules_label")} className="card flat stack">
      <div className="between wrap">
        <h2>{t("rules_title")}</h2>
        {data ? <Pill tone={data.valid ? "green" : "red"}>{data.valid ? t("rules_valid") : t("rules_invalid")}</Pill> : null}
      </div>
      <form
        className="row wrap"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(query.trim());
        }}
      >
        <label className="grow">
          <span className="muted small">{t("rules_search")}</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("rules_search_placeholder")} style={{ width: "100%" }} />
        </label>
        <button type="submit" className="btn">
          {t("rules_search_button")}
        </button>
      </form>
      {list.loading ? <Loading /> : null}
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {data?.problem ? (
        <div className="notice warn" role="status">
          <Icon name="alert" />
          <p>{data.problem.message}</p>
        </div>
      ) : null}
      {data?.duplicates.map((d) => (
        <div key={d.id} className="notice error" role="alert">
          <Icon name="alert" />
          <p>{t("rules_duplicate", { id: d.id, files: d.files.join(", ") })}</p>
        </div>
      ))}
      {data ? (
        data.files.length === 0 ? (
          <p>{applied ? t("rules_no_match", { total: data.total }) : t("rules_empty")}</p>
        ) : (
          <ul className="file-list" data-testid="rules-list">
            {data.files.map((f) => {
              const label = f.entry ?? f.path ?? "-";
              return (
                <li key={label}>
                  <div className="row wrap">
                    <button type="button" className="file-item grow" aria-current={current === f.entry ? "true" : undefined} onClick={() => onOpen(binding, f.entry)}>
                      <Icon name="file" />
                      <span className="grow">
                        <code>{label}</code>
                        <br />
                        <span className="muted small">{f.validation.rules.map((r) => r.id).join(", ") || "-"}</span>
                      </span>
                      <Pill tone={f.validation.status === "valid" ? "green" : "red"}>{f.validation.status === "valid" ? t("rules_file_valid") : t("rules_file_invalid")}</Pill>
                    </button>
                    {canWrite && f.entry ? (
                      <button type="button" className="btn" disabled={busy} onClick={() => setRenaming({ file: f, to: f.entry?.replace(/\.ya?ml$/, "") ?? "" })}>
                        {t("rules_rename")}
                      </button>
                    ) : null}
                  </div>
                  {f.validation.issues.map((i, n) => (
                    <p key={n} className="small" role="alert">
                      <Icon name="alert" /> {i.line ? t("rules_issue_at", { line: i.line, message: i.message }) : i.message}
                    </p>
                  ))}
                  {renaming?.file === f ? (
                    <form
                      className="row wrap"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void rename();
                      }}
                    >
                      <label className="grow">
                        <span className="muted small">{t("rules_new_name")}</span>
                        <input value={renaming.to} onChange={(e) => setRenaming({ file: f, to: e.target.value })} style={{ width: "100%" }} />
                      </label>
                      <button type="submit" className="btn primary" disabled={busy || slug(renaming.to) === ""}>
                        {t("rules_rename_confirm")}
                      </button>
                      <button type="button" className="btn" onClick={() => setRenaming(null)}>
                        {t("rules_cancel")}
                      </button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )
      ) : null}
      {canWrite ? (
        creating ? (
          <form
            className="row wrap"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label className="grow">
              <span className="muted small">{t("rules_new_name")}</span>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} style={{ width: "100%" }} />
            </label>
            <button type="submit" className="btn primary" disabled={busy || slug(newName) === ""}>
              {t("rules_create_confirm")}
            </button>
            <button type="button" className="btn" onClick={() => setCreating(false)}>
              {t("rules_cancel")}
            </button>
          </form>
        ) : (
          <div>
            <button type="button" className="btn" onClick={() => setCreating(true)}>
              <Icon name="file" />
              {t("rules_new")}
            </button>
          </div>
        )
      ) : null}
      {notice ? (
        <div className="notice ok" role="status">
          <Icon name="check" />
          <p>{notice}</p>
        </div>
      ) : null}
      {failure ? <ErrorNotice error={failure} /> : null}
    </section>
  );
}
