// Steps 3 and 4: the components as discovery found them (corrected with selects, never free text) with the compose
// checkbox, and the starter profile as radio cards with what each one runs here; the configuration is previewed
// before it is written.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShell } from "../../app/shell-context";
import { Dialog, ErrorNotice, Loading, Pill, Spinner } from "../../components/common";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";
import { advance, fetchProfiles, fetchProject, previewConfig, type ProfilesInfo, type ProjectComponent, type ProjectInfo } from "./api";
import { EquivalentCommand, StepNav } from "./parts";
import type { StepProps } from "./Wizard";

interface Edit {
  language: string;
  framework: string;
  manager: string;
}

const detectedOf = (c: ProjectComponent): Edit => ({ language: c.language ?? "", framework: c.framework ?? "", manager: c.dependencies?.manager ?? "" });
const ambiguous = (c: ProjectComponent): boolean => c.status === "ambiguous" || c.dependencies?.state === "ambiguous";

export function ProjectStep({ view, act, busy, back }: StepProps) {
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [useServices, setUseServices] = useState(false);
  const load = useCallback(() => {
    fetchProject().then((next) => {
      setInfo(next);
      setError(null);
      const saved = new Map(view.setup.choices.components.map((c) => [c.id, c]));
      setEdits(
        Object.fromEntries(
          next.components.map((c) => {
            const base = detectedOf(c);
            const choice = saved.get(c.id);
            return [c.id, { language: choice?.language ?? base.language, framework: choice?.framework ?? base.framework, manager: choice?.manager ?? base.manager }];
          }),
        ),
      );
      setUseServices(view.setup.choices.services?.use ?? next.servicesDefault);
    }, setError);
    // The saved choices are read once, when the step opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(load, [load]);

  if (!info) return error ? <ErrorNotice error={error} onRetry={load} /> : <Loading />;

  const set = (id: string, patch: Partial<Edit>) => setEdits((all) => ({ ...all, [id]: { ...(all[id] as Edit), ...patch } }));
  const next = () => {
    const components = info.components.flatMap((c) => {
      const edit = edits[c.id];
      const base = detectedOf(c);
      if (!edit || (edit.language === base.language && edit.framework === base.framework && edit.manager === base.manager)) return [];
      return [{ id: c.id, ...(edit.language ? { language: edit.language } : {}), ...(edit.framework ? { framework: edit.framework } : {}), ...(edit.manager ? { manager: edit.manager } : {}) }];
    });
    void act(() => advance("project", { components, services: { use: useServices } }));
  };

  return (
    <div className="stack" data-testid="wizard-step-project">
      <p className="wizard-lead">{t("wizard_project_lead")}</p>
      {error ? <ErrorNotice error={error} /> : null}
      {info.components.length === 0 ? <p>{t("wizard_project_none")}</p> : null}
      <ul className="wizard-cards" aria-label={t("wizard_project_components")}>
        {info.components.map((c) => {
          const edit = edits[c.id] ?? detectedOf(c);
          const language = info.vocabulary.find((l) => l.id === edit.language);
          const managers = [...new Set([c.dependencies?.manager, ...(c.dependencies?.candidates ?? [])].filter((m): m is string => Boolean(m)))];
          return (
            <li key={c.id} className="card flat stack" data-component={c.id} data-ambiguous={ambiguous(c) ? "true" : "false"}>
              <div className="row wrap">
                <Icon name="folder" />
                <strong className="mono">{c.root}</strong>
                {ambiguous(c) ? <Pill tone="gold">{t("wizard_project_ambiguous")}</Pill> : <Pill tone="green">{t("wizard_project_detected")}</Pill>}
              </div>
              <div className="wizard-fields">
                <label className="stack">
                  <span>{t("wizard_project_language")}</span>
                  <select value={edit.language} onChange={(e) => set(c.id, { language: e.target.value, framework: "" })}>
                    {edit.language === "" ? <option value="">{t("wizard_project_choose")}</option> : null}
                    {info.vocabulary.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="stack">
                  <span>{t("wizard_project_framework")}</span>
                  <select value={edit.framework} onChange={(e) => set(c.id, { framework: e.target.value })}>
                    <option value="">{t("wizard_project_framework_none")}</option>
                    {(language?.frameworks ?? []).map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>
                {c.dependencies ? (
                  <label className="stack">
                    <span>{t("wizard_project_manager")}</span>
                    <select value={edit.manager} onChange={(e) => set(c.id, { manager: e.target.value })} disabled={managers.length < 2}>
                      {managers.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {c.dependencies ? (
                  <div className="stack">
                    <span>{t("wizard_project_version")}</span>
                    <span className="small">
                      {c.dependencies.languageVersion ?? t("wizard_project_version_default")}
                      {c.dependencies.languageVersionSource ? ` · ${c.dependencies.languageVersionSource}` : ""}
                    </span>
                  </div>
                ) : null}
              </div>
              {c.dependencies ? <p className="small muted">{c.dependencies.lockfile ? t("wizard_project_lockfile", { file: c.dependencies.lockfile }) : t("wizard_project_no_lockfile")}</p> : null}
            </li>
          );
        })}
      </ul>
      <p className="small">
        <a href="#/workspace">{t("wizard_project_declare")}</a>
      </p>
      {info.compose.files.length > 0 ? (
        <div className="card flat stack" data-testid="wizard-compose">
          <label className="row">
            <input type="checkbox" checked={useServices} onChange={(e) => setUseServices(e.target.checked)} />
            <span>{t("wizard_project_services")}</span>
          </label>
          <p className="small muted">{t("wizard_project_services_files", { files: info.compose.files.join(", ") })}</p>
          {useServices ? (
            <ul className="wizard-plain">
              {info.compose.services.map((s) => (
                <li key={s.name}>
                  <code>{s.name}</code> {s.image ? <span className="small muted">{s.image}</span> : null} {s.role ? <Pill>{t(`wizard_project_role_${s.role}`)}</Pill> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <p className="small muted">{t("wizard_project_no_compose")}</p>
      )}
      <EquivalentCommand command="jgates discover" />
      <StepNav onBack={back} busy={busy} onNext={next} />
    </div>
  );
}

export function ProfileStep({ view, act, busy, back }: StepProps) {
  const { reload } = useShell();
  const [info, setInfo] = useState<ProfilesInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [preview, setPreview] = useState<Array<{ file: string; exists: boolean; text: string }> | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const load = useCallback(() => {
    fetchProfiles().then((next) => {
      setInfo(next);
      setError(null);
      setChoice((c) => c ?? view.setup.choices.profile ?? next.selected ?? next.recommended);
    }, setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(load, [load]);
  const totals = useMemo(() => new Map((info?.profiles ?? []).map((p) => [p.id, p])), [info]);

  if (!info) return error ? <ErrorNotice error={error} onRetry={load} /> : <Loading />;
  const showPreview = async () => {
    if (!choice || previewing) return;
    setPreviewing(true);
    try {
      setPreview((await previewConfig(choice)).files);
    } catch (e) {
      setError(e);
    } finally {
      setPreviewing(false);
    }
  };
  const save = () =>
    void act(async () => {
      const next = await advance("profile", { profile: choice });
      void reload();
      return next;
    });

  return (
    <div className="stack" data-testid="wizard-step-profile">
      <p className="wizard-lead">{t("wizard_profile_lead")}</p>
      {error ? <ErrorNotice error={error} /> : null}
      <fieldset className="stack wizard-fieldset">
        <legend>{t("wizard_profile_legend")}</legend>
        <ul className="wizard-cards wizard-grid">
          {info.profiles.map((p) => {
            const active = choice === p.id;
            return (
              <li key={p.id}>
                <label className={`card flat stack wizard-radio${active ? " active" : ""}`} data-profile={p.id}>
                  <span className="row wrap">
                    <input type="radio" name="wizard-profile" value={p.id} checked={active} onChange={() => setChoice(p.id)} />
                    <strong>{t(`wizard_profile_${p.id}`)}</strong>
                    {info.recommended === p.id ? <Pill tone="green">{t("wizard_recommended")}</Pill> : null}
                  </span>
                  <span className="small muted">{t(`wizard_profile_${p.id}_text`)}</span>
                  {p.error ? (
                    <span className="small">{p.error}</span>
                  ) : (
                    <span className="stack wizard-runs">
                      <span className="small">{t("wizard_profile_runs", { count: totals.get(p.id)?.total ?? 0 })}</span>
                      <span className="small muted">{p.categories.map((c) => `${tOr(`wizard_category_${c.id}`, c.id)} ${c.count}`).join(" · ")}</span>
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      {info.recommended === "strict" ? null : <p className="small muted">{t("wizard_profile_strict_later")}</p>}
      <details>
        <summary>{t("wizard_profile_customize")}</summary>
        <p>{t("wizard_profile_customize_text")}</p>
        <p>
          <a href="#/config">{t("wizard_profile_customize_link")}</a>
        </p>
      </details>
      <div className="row wrap">
        {/* Never disabled while it loads: a disabled button loses the focus, and the dialog gives the focus back to it. */}
        <button type="button" className="btn" onClick={() => void showPreview()} disabled={!choice} aria-busy={previewing}>
          {previewing ? <Spinner /> : <Icon name="file" />}
          {t("wizard_profile_preview")}
        </button>
      </div>
      {preview ? (
        <Dialog title={t("wizard_profile_preview_title")} onClose={() => setPreview(null)} wide>
          <div className="stack" data-testid="wizard-config-preview">
            {preview.map((f) => (
              <section key={f.file} className="stack">
                <h3 className="mono">{f.file}</h3>
                <p className="small muted">{f.exists ? t("wizard_profile_preview_changes") : t("wizard_profile_preview_new")}</p>
                <pre className="wizard-pre">{f.text}</pre>
              </section>
            ))}
          </div>
        </Dialog>
      ) : null}
      <EquivalentCommand command={`jgates init --profile ${choice ?? "standard"}`} />
      <StepNav onBack={back} busy={busy} nextDisabled={!choice} onNext={save} nextLabel={view.configured ? t("wizard_profile_save_existing") : t("wizard_profile_save")} />
    </div>
  );
}
