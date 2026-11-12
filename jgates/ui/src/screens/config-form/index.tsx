import { api } from "../../api";
import { currentQuery, navigate } from "../../app/route";
import { ErrorNotice, Loading, useAsync } from "../../components/common";
import { DerivedForm } from "../../forms/derived/DerivedForm";
import type { FormSource } from "../../forms/derived/types";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";

// Configuração > Formulário guiado: the derived form (forms/derived) of any configuration file or tool instance of the
// project, at #/config/form?file=<file> or #/config/form?instance=<id>. It is the general entry of the guided forms
// (ADR-0009) until each screen embeds the form of its own file.
export const screen: ScreenMeta = { id: "config-form", path: "/config/form", area: "config", order: 47, icon: "sliders" };

interface FormsIndex {
  files: Array<{ file: string; kind: string; exists: boolean; editable: boolean }>;
  instances: Array<{ id: string; adapter: string; label: { text: string; secondary: string } }>;
}

export default function ConfigForm() {
  const query = currentQuery();
  const file = query.get("file");
  const instance = query.get("instance");
  const source: FormSource | null = instance ? { instance } : file ? { file } : null;
  const index = useAsync(() => api<FormsIndex>("GET", "/api/forms/derived/index"), "derived-index");
  const current = instance ? `instance:${instance}` : file ? `file:${file}` : "";
  const choose = (value: string) => {
    if (value.startsWith("instance:")) navigate(`/config/form?instance=${encodeURIComponent(value.slice("instance:".length))}`);
    else if (value.startsWith("file:")) navigate(`/config/form?file=${encodeURIComponent(value.slice("file:".length))}`);
  };
  const data = index.data;
  const known = data ? [...data.files.map((f) => `file:${f.file}`), ...data.instances.map((i) => `instance:${i.id}`)] : [];
  return (
    <div className="stack" data-testid="config-form">
      <div>
        <h1>{t("cff_title")}</h1>
        <p className="muted">{t("cff_lead")}</p>
      </div>
      {index.loading && !data ? <Loading /> : null}
      {index.error ? <ErrorNotice error={index.error} onRetry={index.reload} /> : null}
      {data ? (
        <div className="stack tight cff-choose">
          <label htmlFor="cff-target" className="field-label">
            {t("cff_choose")}
          </label>
          <select id="cff-target" className="input df-select" value={current} onChange={(e) => choose(e.target.value)}>
            {current === "" || !known.includes(current) ? <option value={current}>{current === "" ? t("cff_choose_none") : current.replace(/^(file|instance):/, "")}</option> : null}
            <optgroup label={t("cff_files")}>
              {data.files.map((f) => (
                <option key={f.file} value={`file:${f.file}`}>
                  {f.exists ? f.file : t("cff_file_new", { file: f.file })}
                </option>
              ))}
            </optgroup>
            {data.instances.length > 0 ? (
              <optgroup label={t("cff_instances")}>
                {data.instances.map((i) => (
                  <option key={i.id} value={`instance:${i.id}`}>
                    {i.label.text === i.label.secondary ? i.id : `${i.label.text} (${i.id})`}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </div>
      ) : null}
      {source ? <DerivedForm key={current} source={source} /> : <p className="muted">{t("cff_pick_first")}</p>}
    </div>
  );
}
