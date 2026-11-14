// Step 3: the components in words ("Projeto Python na pasta raiz") with the files that identified them and the state of
// each fact, corrected with selects that follow each other (the frameworks and the managers of the chosen language,
// D26), a component declared in a dialog inside the wizard, and the compose checkbox. Step 4 is step-profile.tsx.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Loading, Pill, Spinner } from "../../components/common";
import { Icon } from "../../components/icons";
import { t } from "../../i18n";
import type { Declared } from "../workspace/components-tab";
import { DeclareDialog } from "../workspace/declare-dialog";
import { advance, fetchProject, type FieldState, type ProjectComponent, type ProjectInfo } from "./api";
import { EquivalentCommand, StepNav } from "./parts";
import type { StepProps } from "./Wizard";

interface Edit {
  language: string;
  framework: string;
  manager: string;
}

const detectedOf = (c: ProjectComponent): Edit => ({ language: c.language ?? "", framework: c.framework ?? "", manager: c.dependencies?.manager ?? "" });
const ambiguous = (c: ProjectComponent): boolean => c.status === "ambiguous" || c.dependencies?.state === "ambiguous";

const FIELD_TONE: Partial<Record<FieldState, "green" | "gold" | "red" | "blue">> = { declared: "blue", detected: "green", found: "green", ambiguous: "gold", unknown: "gold", missing: "gold", unsupported: "red" };

/**
 * The managers offered for a component and a language (D26): the language's own managers, with the detected one and
 * the candidates first when the language is the detected one. A language without a manager JGates installs with: none.
 */
export function managersFor(c: ProjectComponent, language: string, vocabulary: ProjectInfo["vocabulary"]): string[] {
  const own = vocabulary.find((l) => l.id === language)?.managers ?? [];
  const first = language === (c.language ?? "") ? [c.dependencies?.manager, ...(c.dependencies?.candidates ?? [])].filter((m): m is string => Boolean(m) && own.includes(m as string)) : [];
  return [...new Set([...first, ...own])];
}

function FieldBadge({ state, changed, testId }: { state: FieldState; changed: boolean; testId: string }) {
  return (
    <span data-testid={testId} data-state={changed ? "changed" : state}>
      <Pill tone={changed ? "blue" : FIELD_TONE[state]}>{changed ? t("wizard_field_changed") : t(`wizard_field_${state}`)}</Pill>
    </span>
  );
}

interface WorkspaceSettings {
  components: Declared[];
  revision: string | null;
}

export function ProjectStep({ view, act, busy, back }: StepProps) {
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [useServices, setUseServices] = useState(false);
  const [declaring, setDeclaring] = useState<WorkspaceSettings | null>(null);
  const [opening, setOpening] = useState(false);
  const declareButton = useRef<HTMLButtonElement>(null);
  const servicesRead = useRef(false);
  const load = useCallback(() => {
    fetchProject().then((next) => {
      setInfo(next);
      setError(null);
      const saved = new Map(view.setup.choices.components.map((c) => [c.id, c]));
      setEdits((current) =>
        Object.fromEntries(
          next.components.map((c) => {
            const base = detectedOf(c);
            const choice = current[c.id] ?? saved.get(c.id);
            return [c.id, { language: choice?.language ?? base.language, framework: choice?.framework ?? base.framework, manager: choice?.manager ?? base.manager }];
          }),
        ),
      );
      if (!servicesRead.current) setUseServices(view.setup.choices.services?.use ?? next.servicesDefault);
      servicesRead.current = true;
    }, setError);
    // The saved choices are read once, when the step opens; a reload after a declaration keeps the edits on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(load, [load]);

  if (!info) return error ? <ErrorNotice error={error} onRetry={load} /> : <Loading label={t("wizard_loading_project")} />;

  const set = (id: string, patch: Partial<Edit>) => setEdits((all) => ({ ...all, [id]: { ...(all[id] as Edit), ...patch } }));
  // A new language takes its own frameworks and managers: the ones of the old language would be a wrong pair (D26).
  const changeLanguage = (c: ProjectComponent, language: string) => set(c.id, { language, framework: "", manager: managersFor(c, language, info.vocabulary)[0] ?? "" });
  const next = () => {
    const components = info.components.flatMap((c) => {
      const edit = edits[c.id];
      const base = detectedOf(c);
      if (!edit || (edit.language === base.language && edit.framework === base.framework && edit.manager === base.manager)) return [];
      return [{ id: c.id, ...(edit.language ? { language: edit.language } : {}), ...(edit.framework ? { framework: edit.framework } : {}), ...(edit.manager ? { manager: edit.manager } : {}) }];
    });
    void act(() => advance("project", { components, services: { use: useServices } }));
  };
  const openDeclare = async () => {
    if (opening) return;
    setOpening(true);
    try {
      setDeclaring(await api<WorkspaceSettings>("GET", "/api/workspace/settings"));
    } catch (e) {
      setError(e);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="stack" data-testid="wizard-step-project">
      <p className="wizard-lead">{t("wizard_project_lead")}</p>
      {error ? <ErrorNotice error={error} /> : null}
      {info.components.length === 0 ? <p>{t("wizard_project_none")}</p> : null}
      <ul className="wizard-cards" aria-label={t("wizard_project_components")}>
        {info.components.map((c) => {
          const base = detectedOf(c);
          const edit = edits[c.id] ?? base;
          const language = info.vocabulary.find((l) => l.id === edit.language);
          const managers = managersFor(c, edit.language, info.vocabulary);
          const ids = { language: `wz-${c.id}-language`, framework: `wz-${c.id}-framework`, manager: `wz-${c.id}-manager` };
          const lockfile = edit.language === base.language ? c.dependencies?.lockfile ?? null : null;
          return (
            <li key={c.id} className="card flat stack" data-component={c.id} data-ambiguous={ambiguous(c) ? "true" : "false"}>
              <div className="row wrap">
                <Icon name="folder" />
                <strong data-testid="wizard-component-sentence">{c.sentence}</strong>
                {ambiguous(c) ? <Pill tone="gold">{t("wizard_project_ambiguous")}</Pill> : null}
              </div>
              {c.evidence.length > 0 ? (
                <p className="small muted wizard-break" data-testid="wizard-component-evidence">
                  {t("wizard_project_evidence")}:{" "}
                  {c.evidence.map((file, i) => (
                    <span key={file}>
                      {i > 0 ? ", " : ""}
                      <code>{file}</code>
                    </span>
                  ))}
                </p>
              ) : null}
              <div className="wizard-fields">
                <div className="stack tight">
                  <label htmlFor={ids.language}>{t("wizard_project_language")}</label>
                  <select id={ids.language} value={edit.language} onChange={(e) => changeLanguage(c, e.target.value)}>
                    {edit.language === "" ? <option value="">{t("wizard_project_choose")}</option> : null}
                    {info.vocabulary.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                  <FieldBadge state={c.fields.language.state} changed={edit.language !== base.language} testId="wizard-field-language" />
                  {c.fields.language.reason && edit.language === base.language ? <span className="small muted">{c.fields.language.reason}</span> : null}
                </div>
                <div className="stack tight">
                  <label htmlFor={ids.framework}>{t("wizard_project_framework")}</label>
                  <select id={ids.framework} value={edit.framework} onChange={(e) => set(c.id, { framework: e.target.value })}>
                    <option value="">{t("wizard_project_framework_none")}</option>
                    {(language?.frameworks ?? []).map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <FieldBadge state={edit.framework === "" ? "none" : c.fields.framework.state === "none" ? "detected" : c.fields.framework.state} changed={edit.framework !== base.framework} testId="wizard-field-framework" />
                </div>
                <div className="stack tight">
                  <label htmlFor={ids.manager}>{t("wizard_project_manager")}</label>
                  {managers.length > 0 ? (
                    <select id={ids.manager} value={managers.includes(edit.manager) ? edit.manager : ""} onChange={(e) => set(c.id, { manager: e.target.value })} data-testid="wizard-manager">
                      {managers.includes(edit.manager) ? null : <option value="">{t("wizard_project_choose_manager")}</option>}
                      {managers.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span id={ids.manager} className="small">
                      {t("wizard_project_manager_none")}
                    </span>
                  )}
                  <FieldBadge state={edit.language === base.language ? c.fields.manager.state : managers.length > 0 ? "detected" : "none"} changed={edit.manager !== base.manager && managers.length > 0} testId="wizard-field-manager" />
                  {c.fields.manager.reason && edit.language === base.language ? <span className="small muted">{c.fields.manager.reason}</span> : null}
                </div>
                <div className="stack tight">
                  <span>{t("wizard_project_lockfile_label")}</span>
                  <span className="small mono wizard-break">{lockfile ?? t("wizard_project_no_lockfile")}</span>
                  <FieldBadge state={edit.language === base.language ? c.fields.lockfile.state : "none"} changed={false} testId="wizard-field-lockfile" />
                  {c.fields.lockfile.reason && edit.language === base.language ? <span className="small muted">{c.fields.lockfile.reason}</span> : null}
                </div>
                {c.dependencies && edit.language === base.language ? (
                  <div className="stack tight">
                    <span>{t("wizard_project_version")}</span>
                    <span className="small">
                      {c.dependencies.languageVersion ?? t("wizard_project_version_default")}
                      {c.dependencies.languageVersionSource ? ` · ${c.dependencies.languageVersionSource}` : ""}
                    </span>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="row wrap">
        {/* Never disabled while it loads: a disabled button loses the focus, and the dialog gives the focus back to it. */}
        <button type="button" className="btn" ref={declareButton} onClick={() => void openDeclare()} aria-busy={opening} data-testid="wizard-declare">
          {opening ? <Spinner /> : <Icon name="folder" />}
          {t("wizard_project_declare_button")}
        </button>
      </div>
      {declaring ? (
        <DeclareDialog
          title={t("wizard_project_declare_title")}
          initial={{ id: "", path: "" }}
          declared={declaring.components}
          revision={declaring.revision}
          onClose={() => {
            setDeclaring(null);
            declareButton.current?.focus();
          }}
          onSaved={load}
        />
      ) : null}
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
