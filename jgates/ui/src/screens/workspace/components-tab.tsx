import { useState, type FormEvent } from "react";
import { api } from "../../api";
import { Dialog, ErrorNotice, Pill } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t, tOr } from "../../i18n";

export interface Classification {
  id: string;
  componentRoot: string;
  language: string | null;
  framework: string | null;
  packageManager: string | null;
  kind: string | null;
  detectedBy: string;
  detectorVersion: string;
  evidencePaths: string[];
  reasonCode: string;
  classificationStatus: "explicit" | "detected" | "ambiguous" | "unsupported" | "ignored";
  approvable: boolean;
}

export interface Declared {
  id: string;
  path: string;
  language?: string;
  framework?: string;
  kind?: string;
  enabled?: boolean;
}

const TONE: Record<string, "green" | "gold" | "red" | "blue"> = { explicit: "blue", detected: "green", ambiguous: "gold", unsupported: "red", ignored: "gold" };

export const reasonText = (code: string): string => tOr(`ws_reason_${code}`, code);

function StatusBadge({ status }: { status: string }) {
  return (
    <Pill tone={TONE[status] ?? "blue"}>
      <span data-testid="status-badge">{t(`ws_status_${status}`)}</span>
    </Pill>
  );
}

function WhyDialog({ item, templates, onClose }: { item: Classification; templates: string[]; onClose: () => void }) {
  return (
    <Dialog title={t("ws_why_title", { name: item.id })} onClose={onClose}>
      <div className="stack" data-testid="why-dialog">
        <dl className="kv">
          <dt>{t("ws_why_status")}</dt>
          <dd>
            <StatusBadge status={item.classificationStatus} />
          </dd>
          <dt>{t("ws_why_reason")}</dt>
          <dd>
            {reasonText(item.reasonCode)} <code>{item.reasonCode}</code>
          </dd>
          <dt>{t("ws_why_detector")}</dt>
          <dd>
            <code>{item.detectedBy}</code> <code>{item.detectorVersion}</code>
          </dd>
          <dt>{t("ws_why_template")}</dt>
          <dd>{templates.length > 0 ? templates.map((x) => <code key={x}>{x} </code>) : t("ws_why_no_template")}</dd>
        </dl>
        <div>
          <strong>{t("ws_why_files")}</strong>
          <ul data-testid="why-evidence">
            {item.evidencePaths.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Dialog>
  );
}

/** Declares a component or corrects a declared one; the file is changed by patch and its comments stay. */
function DeclareDialog({
  title,
  initial,
  declared,
  revision,
  onClose,
  onSaved,
}: {
  title: string;
  initial: Declared;
  declared: Declared[];
  revision: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({ id: initial.id, path: initial.path, language: initial.language ?? "", framework: initial.framework ?? "", kind: initial.kind ?? "" });
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const entry: Declared = {
      id: form.id.trim(),
      path: form.path.trim(),
      ...(form.language.trim() ? { language: form.language.trim() } : {}),
      ...(form.framework.trim() ? { framework: form.framework.trim() } : {}),
      ...(form.kind.trim() ? { kind: form.kind.trim() } : {}),
      ...(initial.enabled === false ? { enabled: false } : {}),
    };
    const next = declared.some((d) => d.id === initial.id) ? declared.map((d) => (d.id === initial.id ? entry : d)) : [...declared, entry];
    try {
      await api("PUT", "/api/workspace/settings", { expectedRevision: revision, components: next });
      toast(t("ws_saved_toast"), "ok");
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={title} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="ws-form-grid">
          <label>
            {t("ws_field_id")}
            <input type="text" required value={form.id} onChange={set("id")} pattern="[a-z0-9][a-z0-9._\-]*" />
          </label>
          <label>
            {t("ws_field_path")}
            <input type="text" required value={form.path} onChange={set("path")} />
          </label>
          <label>
            {t("ws_field_language")}
            <input type="text" value={form.language} onChange={set("language")} />
          </label>
          <label>
            {t("ws_field_framework")}
            <input type="text" value={form.framework} onChange={set("framework")} />
          </label>
          <label>
            {t("ws_field_kind")}
            <input type="text" value={form.kind} onChange={set("kind")} />
          </label>
        </div>
        <p className="small">{t("ws_declare_hint")}</p>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="row">
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? t("ws_saving") : t("ws_declare_save")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Tree({ items, configFile }: { items: Classification[]; configFile: string | null }) {
  const roots = [...new Set(items.filter((c) => ["explicit", "detected", "ambiguous"].includes(c.classificationStatus)).map((c) => c.componentRoot))].sort();
  return (
    <section className="stack" aria-labelledby="ws-tree-title">
      <h2 id="ws-tree-title">{t("ws_tree_title")}</h2>
      <ul className="ws-tree" data-testid="ws-tree">
        <li>
          <Icon name="folder" /> <code>./</code> <span className="muted">{t("ws_tree_root")}</span>
          <ul>
            {configFile ? (
              <li>
                <Icon name="file" /> <code>{configFile}</code> <span className="muted">{t("ws_tree_config")}</span>
              </li>
            ) : null}
            <li>
              <Icon name="folder" /> <code>.jgates/</code> <span className="muted">{t("ws_tree_dir")}</span>
            </li>
            {roots
              .filter((r) => r !== ".")
              .map((r) => (
                <li key={r}>
                  <Icon name="folder" /> <code>{r}/</code>
                </li>
              ))}
          </ul>
        </li>
      </ul>
      <p className="small">{t("ws_tree_note")}</p>
    </section>
  );
}

export function ComponentsTab({
  classifications,
  templates,
  settings,
  configFile,
  onChanged,
}: {
  classifications: Classification[];
  templates: Record<string, string[]>;
  settings: { revision: string | null; components: Declared[] };
  configFile: string | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [why, setWhy] = useState<Classification | null>(null);
  const [declare, setDeclare] = useState<{ title: string; initial: Declared } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const components = classifications.filter((c) => ["explicit", "detected", "ambiguous"].includes(c.classificationStatus));
  const ignored = classifications.filter((c) => c.classificationStatus === "ignored" || c.classificationStatus === "unsupported");

  const remove = async (c: Classification) => {
    setError(null);
    try {
      await api("PUT", "/api/workspace/settings", { expectedRevision: settings.revision, components: settings.components.filter((d) => d.id !== c.id) });
      toast(t("ws_saved_toast"), "ok");
      onChanged();
    } catch (e) {
      setError(e);
    }
  };

  const fromCard = (c: Classification): Declared => ({
    id: c.classificationStatus === "explicit" ? c.id : c.id.replace(/[^a-z0-9._-]/g, "-"),
    path: c.componentRoot,
    ...(c.language ? { language: c.language } : {}),
    ...(c.framework ? { framework: c.framework } : {}),
    ...(c.kind ? { kind: c.kind } : {}),
  });

  return (
    <div className="stack">
      <div className="between">
        <h2>{t("ws_components_title")}</h2>
        <button type="button" className="btn" onClick={() => setDeclare({ title: t("ws_declare_title"), initial: { id: "", path: "" } })}>
          {t("ws_new_component")}
        </button>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      {components.length === 0 ? <p>{t("ws_components_empty")}</p> : null}
      <div className="ws-cards">
        {components.map((c) => {
          const used = templates[c.id] ?? [];
          return (
            <article key={`${c.id}:${c.componentRoot}:${c.detectedBy}`} className="card ws-card" data-component={c.id} data-status={c.classificationStatus}>
              <div className="between">
                <h3>{c.id}</h3>
                <StatusBadge status={c.classificationStatus} />
              </div>
              <dl>
                <dt>{t("ws_card_path")}</dt>
                <dd>
                  <code>{c.componentRoot}</code>
                </dd>
                <dt>{t("ws_card_language")}</dt>
                <dd>{c.language ?? t("ws_card_none")}</dd>
                <dt>{t("ws_card_framework")}</dt>
                <dd>{c.framework ?? t("ws_card_none")}</dd>
                <dt>{t("ws_card_template")}</dt>
                <dd>{used.length > 0 ? used.map((x) => <code key={x}>{x} </code>) : t("ws_card_template_none")}</dd>
              </dl>
              <div className="row">
                <button type="button" className="btn" onClick={() => setWhy(c)}>
                  <Icon name="info" />
                  {t("ws_why")}
                </button>
                {c.classificationStatus === "explicit" ? (
                  <>
                    <button type="button" className="btn" onClick={() => setDeclare({ title: t("ws_correct_title", { name: c.id }), initial: { ...fromCard(c), ...(settings.components.find((d) => d.id === c.id) ?? {}) } })}>
                      {t("ws_correct")}
                    </button>
                    <button type="button" className="btn" onClick={() => remove(c)}>
                      {t("ws_remove_declared")}
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn" onClick={() => setDeclare({ title: c.classificationStatus === "ambiguous" ? t("ws_correct_title", { name: c.id }) : t("ws_declare_title"), initial: fromCard(c) })}>
                    {c.classificationStatus === "ambiguous" ? t("ws_correct") : t("ws_declare")}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {ignored.length > 0 ? (
        <details>
          <summary>{t("ws_ignored_title", { count: ignored.length })}</summary>
          <ul>
            {ignored.map((c, i) => (
              <li key={`${c.componentRoot}:${i}`}>
                <code>{c.componentRoot}</code> {c.language ? `(${c.language}) ` : ""}
                <span className="muted">{reasonText(c.reasonCode)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <Tree items={classifications} configFile={configFile} />

      {why ? <WhyDialog item={why} templates={templates[why.id] ?? []} onClose={() => setWhy(null)} /> : null}
      {declare ? (
        <DeclareDialog title={declare.title} initial={declare.initial} declared={settings.components} revision={settings.revision} onClose={() => setDeclare(null)} onSaved={onChanged} />
      ) : null}
    </div>
  );
}
