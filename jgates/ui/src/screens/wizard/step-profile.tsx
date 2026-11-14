// Step 4: the profile editor embedded in the wizard (ADR-0008, PLAN-guided-flows.md section 2). The profiles of the
// wizard's draft as radio cards with what each runs here (plan steps by category, in the strip's order), the quality
// mascot strip of the selected profile, its category list with the switches of Configuração > Perfil (the same
// component, writing to the draft) and "Criar perfil a partir deste" in a dialog of the wizard. Nothing is written to
// the project before "Salvar e continuar"; the preview shows the files as they will be written.
import { useCallback, useEffect, useRef, useState } from "react";
import { useShell } from "../../app/shell-context";
import { Dialog, ErrorNotice, Loading, Pill, Spinner, Updating } from "../../components/common";
import { Icon } from "../../components/icons";
import { QualityMascotStrip } from "../../components/QualityMascotStrip";
import { t, tOr } from "../../i18n";
import { CreateDialog } from "../config-profiles/profiles";
import { Protect, type CategoryView, type SelectorGroup } from "../config-profiles/protect";
import "../config-profiles/config-profiles.css";
import {
  advance,
  chooseDraftProfile,
  createDraftProfile,
  discardDraft,
  fetchDraftProfile,
  fetchProfiles,
  previewConfig,
  writeDraftSelection,
  type DraftProfile,
  type DraftProfileView,
  type ProfilesInfo,
} from "./api";
import { EquivalentCommand, StepNav } from "./parts";
import type { StepProps } from "./Wizard";

/** The name of a profile: the starters by their name in the UI language, the others by their label. */
export const profileName = (p: Pick<DraftProfile, "id" | "label" | "starter">): string => (p.starter ? t(`wizard_profile_${p.id}`) : (p.label ?? p.id));
const categoryName = (id: string): string => tOr(`wizard_category_${id}`, id);

/** Answers of requests that can overlap (arrow keys on the radios): only the last one asked is applied. */
function useLatest() {
  const counter = useRef(0);
  return () => {
    const mine = ++counter.current;
    return () => mine === counter.current;
  };
}

export function ProfileStep({ view, act, busy, back }: StepProps) {
  const { reload } = useShell();
  const [info, setInfo] = useState<ProfilesInfo | null>(null);
  const [counting, setCounting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<DraftProfileView | null>(null);
  const [writing, setWriting] = useState(0);
  const [creating, setCreating] = useState<string | null>(null);
  const [preview, setPreview] = useState<Array<{ file: string; exists: boolean; text: string }> | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const createButtons = useRef(new Map<string, HTMLButtonElement>());
  const latestCounts = useLatest();
  const latestEditor = useLatest();

  // What each profile runs, the selected one's plan and the mascots: asked again after every change of the draft.
  const loadCounts = useCallback(async () => {
    const current = latestCounts();
    setCounting(true);
    try {
      const next = await fetchProfiles();
      if (!current()) return;
      setInfo(next);
      setError(null);
      setSelected((s) => s ?? next.selected ?? next.recommended);
    } catch (e) {
      if (current()) setError(e);
    } finally {
      if (current()) setCounting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  // The editor of the selected profile (its categories and switches).
  const loadEditor = useCallback(async (ref: string) => {
    const current = latestEditor();
    try {
      const next = await fetchDraftProfile(ref);
      if (current()) setEditor(next);
    } catch (e) {
      if (current()) setError(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (selected) void loadEditor(selected);
  }, [selected, loadEditor]);

  /**
   * A write to the draft: one after the other, in the order the person made them (two arrow keys on the radios are two
   * choices, the last one wins); counted while in flight (Salvar waits for them), then the counts are asked again.
   */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const write = <T,>(work: () => Promise<T>): Promise<T> => {
    setWriting((n) => n + 1);
    const next = chain.current.then(work, work);
    chain.current = next.catch(() => undefined);
    return next.finally(() => {
      setWriting((n) => n - 1);
      void loadCounts();
    });
  };

  const choose = (id: string) => {
    setSelected(id);
    const current = latestEditor();
    void write(() => chooseDraftProfile(id)).then(
      (answer) => {
        if (current()) setEditor(answer.view);
      },
      (e) => setError(e),
    );
  };

  if (!info) return error ? <ErrorNotice error={error} onRetry={() => void loadCounts()} /> : <Loading />;

  const choice = selected ?? info.selected ?? info.recommended;
  const shownEditor = editor && editor.profile.ref === choice ? editor : null;
  const cards = info.profiles.map((p) => ({ id: p.id, ref: p.ref, label: profileName(p) }));

  const showPreview = async () => {
    if (previewing) return;
    setPreviewing(true);
    try {
      // After the writes the person already made: the preview shows the draft as they left it.
      await chain.current;
      setPreview((await previewConfig()).files);
    } catch (e) {
      setError(e);
    } finally {
      setPreviewing(false);
    }
  };
  const discard = async () => {
    if (discarding) return;
    setDiscarding(true);
    try {
      const answer = await discardDraft();
      setSelected(answer.selected);
      setEditor(null);
      await loadCounts();
      if (answer.selected) await loadEditor(answer.selected);
    } catch (e) {
      setError(e);
    } finally {
      setDiscarding(false);
    }
  };
  const save = () =>
    void act(async () => {
      const next = await advance("profile");
      void reload();
      return next;
    });

  return (
    <div className="stack" data-testid="wizard-step-profile">
      <p className="wizard-lead">{t("wizard_profile_lead")}</p>
      <p className="small muted">{t(info.draft.mode === "new" ? "wizard_profile_draft_new" : "wizard_profile_draft_existing")}</p>
      {error ? <ErrorNotice error={error} /> : null}
      <fieldset className="stack wizard-fieldset">
        <legend>{t("wizard_profile_legend")}</legend>
        <ul className="wizard-cards wizard-grid" aria-busy={counting ? true : undefined}>
          {info.profiles.map((p) => {
            const active = choice === p.ref || choice === p.id;
            const name = profileName(p);
            const text = p.starter ? t(`wizard_profile_${p.id}_text`) : (p.description ?? (p.extends ? t("wizard_profile_extends", { name: tOr(`wizard_profile_${p.extends.replace(/^builtin:/, "")}`, p.extends) }) : ""));
            return (
              <li key={p.ref}>
                <div className={`card flat stack wizard-radio${active ? " active" : ""}`} data-profile={p.id} data-total={p.error ? "" : String(p.total)}>
                  <label className="stack tight wizard-radio-label">
                    <span className="row wrap">
                      <input type="radio" name="wizard-profile" value={p.ref} checked={active} onChange={() => choose(p.ref)} />
                      <strong>{name}</strong>
                      {info.recommended === p.id ? <Pill tone="green">{t("wizard_recommended")}</Pill> : null}
                    </span>
                    {text ? <span className="small muted">{text}</span> : null}
                    {p.error ? (
                      <span className="small">{p.error}</span>
                    ) : (
                      <span className="stack tight wizard-runs">
                        <span className="small" data-testid="wizard-profile-runs">
                          {t("wizard_profile_runs", { count: p.total })}
                        </span>
                        <span className="small muted" data-testid="wizard-profile-categories">
                          {p.categories.map((c) => `${categoryName(c.id)} ${c.count}`).join(" · ")}
                        </span>
                      </span>
                    )}
                  </label>
                  <div>
                    <button
                      type="button"
                      className="btn link-btn small"
                      ref={(el) => {
                        if (el) createButtons.current.set(p.ref, el);
                        else createButtons.current.delete(p.ref);
                      }}
                      aria-label={t("wizard_profile_create_from_aria", { name })}
                      onClick={() => setCreating(p.ref)}
                    >
                      <Icon name="copy" />
                      {t("wizard_profile_create_from")}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </fieldset>
      {info.recommended === "strict" ? null : <p className="small muted">{t("wizard_profile_strict_later")}</p>}
      <Updating active={counting || writing > 0} />
      <section className="stack" aria-labelledby="wizard-profile-mascots" data-testid="wizard-profile-mascots" data-plan={info.mascots?.planHash ?? ""}>
        <h2 id="wizard-profile-mascots">
          {t("wizard_profile_mascots", { name: cards.find((c) => c.ref === choice || c.id === choice)?.label ?? choice })}
        </h2>
        <QualityMascotStrip snapshot={info.mascots} loading={counting} />
      </section>
      {info.error ? (
        <div className="notice warn" role="status">
          <Icon name="alert" />
          <span>{info.error.message}</span>
        </div>
      ) : null}
      {shownEditor ? (
        <div data-testid="wizard-profile-editor" data-editing={shownEditor.profile.ref}>
          <Protect
            key={shownEditor.profile.ref}
            categories={shownEditor.categories as CategoryView[]}
            selectors={(shownEditor.selectors ?? []) as SelectorGroup[]}
            universe={shownEditor.universe}
            plan={info.plan && info.plan.profile?.id === shownEditor.profile.ref ? info.plan : null}
            profile={shownEditor.profile.ref}
            editable={shownEditor.profile.editable === true}
            draft={{ write: (changes) => write(() => writeDraftSelection(shownEditor.profile.ref, changes)) }}
            onChanged={(answer) => {
              if (answer && (answer as { view?: DraftProfileView }).view) setEditor((answer as { view: DraftProfileView }).view);
              else void loadEditor(shownEditor.profile.ref);
            }}
          />
        </div>
      ) : (
        <Loading />
      )}
      <div className="row wrap">
        {/* Never disabled while it loads: a disabled button loses the focus, and the dialog gives the focus back to it. */}
        <button type="button" className="btn" onClick={() => void showPreview()} aria-busy={previewing}>
          {previewing ? <Spinner /> : <Icon name="file" />}
          {t("wizard_profile_preview")}
        </button>
        {info.draft.edited ? (
          <button type="button" className="btn" onClick={() => void discard()} aria-busy={discarding} data-testid="wizard-profile-discard">
            {discarding ? <Spinner /> : <Icon name="refresh" />}
            {t("wizard_profile_discard")}
          </button>
        ) : null}
      </div>
      {preview ? (
        <Dialog title={t("wizard_profile_preview_title")} onClose={() => setPreview(null)} wide>
          <div className="stack" data-testid="wizard-config-preview">
            {preview.length === 0 ? <p>{t("wizard_profile_preview_none")}</p> : null}
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
      {creating ? (
        <CreateDialog
          cards={cards}
          starters={[]}
          from={creating}
          draft={{ create: (body) => write(() => createDraftProfile(body)) }}
          onClose={() => {
            const from = creating;
            setCreating(null);
            createButtons.current.get(from)?.focus();
          }}
          onCreated={(id) => {
            const from = creating;
            setCreating(null);
            choose(id);
            // The focus goes back to where the person was; the new profile is a card of the list, already selected.
            createButtons.current.get(from)?.focus();
          }}
        />
      ) : null}
      <EquivalentCommand command={`jgates init --profile ${choice}`} />
      <StepNav onBack={back} busy={busy || writing > 0} nextDisabled={!choice} onNext={save} nextLabel={view.configured ? t("wizard_profile_save_existing") : t("wizard_profile_save")} />
    </div>
  );
}
