import { Pill } from "../../components/common";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { useShell } from "../../app/shell-context";

export const screen: ScreenMeta = { id: "about", path: "/about", order: 95, icon: "info" };

// The interface is offline and makes no external request, so the documentation is named by its path in the repository.
const DOCS = [
  { id: "compat_pt", file: "docs/jgates/compatibilidade.pt-BR.md" },
  { id: "compat_en", file: "docs/jgates/compatibilidade.en.md" },
  { id: "start_pt", file: "docs/jgates/primeiros-passos.pt-BR.md" },
  { id: "start_en", file: "docs/jgates/primeiros-passos.en.md" },
] as const;

export default function AboutScreen() {
  const { info } = useShell();
  return (
    <div className="stack">
      <div>
        <h1>{t("about_title")}</h1>
        <p>{t("about_lead")}</p>
      </div>
      <section className="card flat stack" aria-labelledby="about-facts">
        <h2 id="about-facts">{t("about_facts")}</h2>
        <dl className="kv">
          <dt>{t("about_version")}</dt>
          <dd data-testid="about-version">{info?.version ?? "-"}</dd>
          <dt>{t("about_mode")}</dt>
          <dd data-testid="about-mode">
            {info ? <Pill tone={info.mode === "governed" ? "gold" : "green"}>{info.mode === "governed" ? t("about_mode_governed") : t("about_mode_local")}</Pill> : "-"}
          </dd>
          <dt>{t("about_workspace")}</dt>
          <dd>
            <code data-testid="about-path">{info?.workspace.path ?? "-"}</code>
          </dd>
        </dl>
      </section>
      <section className="card flat stack" aria-labelledby="about-docs">
        <h2 id="about-docs">{t("about_docs")}</h2>
        <p className="small">{t("about_docs_note")}</p>
        <ul>
          {DOCS.map((d) => (
            <li key={d.id}>
              {t(`about_doc_${d.id}`)}: <code>{d.file}</code>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
