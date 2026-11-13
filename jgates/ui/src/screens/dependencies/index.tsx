import { useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Loading, Pill, Spinner, Updating, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { DerivedFormView } from "../../forms/derived/DerivedForm";
import { loadForm } from "../../forms/derived/api";
import { useKeyEditor } from "../../forms/derived/editor";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { useShell } from "../../app/shell-context";
import "./dependencies.css";

// Configuração > Dependências: .jgates/dependencies.yml as the derived form of the file (private registries by ecosystem
// and the install override), with the package manager each component uses above it. The registry takes the NAME of the
// secret that holds the token, never the token: the screen has no field for a value and never shows one. A project
// without the file creates it from here.
export const screen: ScreenMeta = { id: "dependencies", path: "/config/dependencies", area: "config", navLabel: "dep_nav", navPath: "/config/dependencies", order: 49, icon: "file" };

const FILE = ".jgates/dependencies.yml";

interface Declared {
  id: string;
  path: string;
  dependencies?: { manager?: string; groups?: string[] };
}
interface Settings {
  components: Declared[];
}
interface Classification {
  id: string;
  componentRoot: string;
  packageManager: string | null;
  classificationStatus: string;
}

function Managers() {
  const settings = useAsync(() => api<Settings>("GET", "/api/workspace/settings"), "dep-settings");
  const discovery = useAsync(() => api<{ inventory: { classifications: Classification[] } }>("GET", "/api/workspace/discovery"), "dep-discovery");
  if ((settings.loading && !settings.data) || (discovery.loading && !discovery.data)) return <Loading />;
  const error = settings.error ?? discovery.error;
  if (error && (!settings.data || !discovery.data)) return <ErrorNotice error={error} onRetry={() => (settings.reload(), discovery.reload())} />;
  const found = (discovery.data?.inventory.classifications ?? []).filter((c) => ["explicit", "detected", "ambiguous"].includes(c.classificationStatus));
  const declared = new Map((settings.data?.components ?? []).map((c) => [c.id, c]));
  return (
    <section className="stack" aria-labelledby="dep-managers">
      <h2 id="dep-managers">{t("dep_managers_title")}</h2>
      <p className="small muted">{t("dep_managers_lead")}</p>
      {found.length === 0 ? (
        <p className="small muted">{t("dep_managers_empty")}</p>
      ) : (
        <div className="card flat table-wrap">
          <table aria-label={t("dep_managers_label")} data-testid="dep-managers">
            <thead>
              <tr>
                <th scope="col">{t("dep_col_component")}</th>
                <th scope="col">{t("dep_col_manager")}</th>
                <th scope="col">{t("dep_col_groups")}</th>
              </tr>
            </thead>
            <tbody>
              {found.map((c) => {
                const own = declared.get(c.id)?.dependencies;
                return (
                  <tr key={`${c.id}:${c.componentRoot}`} data-component={c.id}>
                    <th scope="row">
                      {c.id} <code className="muted">{c.componentRoot}</code>
                    </th>
                    <td>
                      {own?.manager ? (
                        <>
                          <code>{own.manager}</code> <Pill tone="blue">{t("dep_declared")}</Pill>
                        </>
                      ) : c.packageManager ? (
                        <>
                          <code>{c.packageManager}</code> <span className="small muted">{t("dep_detected")}</span>
                        </>
                      ) : (
                        <span className="muted">{t("dep_none")}</span>
                      )}
                    </td>
                    <td>{own?.groups && own.groups.length > 0 ? own.groups.map((g) => <code key={g}>{g} </code>) : <span className="muted">{t("dep_none")}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="small">
        <a href="#/workspace">{t("dep_managers_edit")}</a>
      </p>
    </section>
  );
}

export default function DependenciesScreen() {
  const { info } = useShell();
  const form = useAsync(() => loadForm({ file: FILE }), "dep-form");
  const editor = useKeyEditor(form.reload);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const governed = info?.mode === "governed";

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      await api("POST", "/api/config/yaml/create", { file: FILE });
      form.reload();
    } catch (e) {
      setError(e);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="stack" aria-busy={form.reloading ? true : undefined}>
      <div>
        <h1>{t("dep_title")}</h1>
        <p>{t("dep_lead")}</p>
      </div>
      <Updating active={form.reloading} />
      <Managers />
      <section className="stack" aria-labelledby="dep-registries">
        <h2 id="dep-registries">{t("dep_registries_title")}</h2>
        <div className="notice info" role="note">
          <Icon name="lock" />
          <p className="small">{t("dep_secret_note")}</p>
        </div>
        {error ? <ErrorNotice error={error} /> : null}
        {form.error && !form.data ? (
          <ErrorNotice error={form.error} onRetry={form.reload} />
        ) : !form.data ? (
          <Loading />
        ) : !form.data.file.exists ? (
          <div className="card pad stack" data-testid="dep-missing">
            <p>{t("dep_missing")}</p>
            <div>
              <button type="button" className="btn primary" disabled={creating || governed} onClick={() => void create()} aria-busy={creating || undefined}>
                {creating ? <Spinner /> : <Icon name="file" />}
                {t("dep_create")}
              </button>
            </div>
          </div>
        ) : (
          <DerivedFormView form={form.data} editor={editor} reload={form.reload} include={(f) => f.path[0] !== "schemaVersion"} headingLevel={3} />
        )}
      </section>
    </div>
  );
}
