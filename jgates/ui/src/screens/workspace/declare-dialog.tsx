import { useState, type FormEvent } from "react";
import { api } from "../../api";
import { Dialog, ErrorNotice, Loading, Spinner, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";
import type { Declared } from "./components-tab";

interface VocabularyFramework {
  id: string;
  label: string;
}
interface VocabularyLanguage {
  id: string;
  label: string;
  supported: boolean;
  frameworks: VocabularyFramework[];
}
export interface Vocabulary {
  languages: VocabularyLanguage[];
  folders: Array<{ path: string; detected: boolean }>;
}

/** Select value of the "Outro…" option (never a canonical id: ids have no underscore at the start). */
const OTHER = "__other__";

/** The id discovery would give a folder (same rule as the core's makeId), unique among the declared ones. */
export function suggestId(folder: string, taken: string[]): string {
  const clean = folder.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  const base = clean === "" || clean === "." ? "root" : clean.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "");
  const stem = base === "" ? "component" : base;
  let id = stem;
  for (let n = 2; taken.includes(id); n += 1) id = `${stem}-${n}`;
  return id;
}

/** A free value turned into the canonical id when it names a known entry ("C++" -> cpp), else lowercased. */
function canonical(value: string, known: Array<{ id: string; label: string }>): string {
  const v = value.trim().toLowerCase();
  return known.find((k) => k.id === v || k.label.toLowerCase() === v)?.id ?? v;
}

/** Splits a saved value into the select choice and the free text behind "Outro…". */
function choiceOf(value: string | undefined, known: Array<{ id: string }>): { choice: string; other: string } {
  if (!value) return { choice: "", other: "" };
  return known.some((k) => k.id === value) ? { choice: value, other: "" } : { choice: OTHER, other: value };
}

function uniqueFrameworks(languages: VocabularyLanguage[]): VocabularyFramework[] {
  const seen = new Map<string, VocabularyFramework>();
  for (const l of languages) for (const f of l.frameworks) if (!seen.has(f.id)) seen.set(f.id, f);
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label, "en"));
}

function Help({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} className="ws-help">
      {children}
    </p>
  );
}

/** Declares a component or corrects a declared one; the file is changed by patch and its comments stay. */
export function DeclareDialog(props: { title: string; initial: Declared; declared: Declared[]; revision: string | null; onClose: () => void; onSaved: () => void }) {
  const vocabulary = useAsync(() => api("GET", "/api/workspace/vocabulary") as Promise<Vocabulary>, "ws-vocabulary");
  return (
    <Dialog title={props.title} onClose={props.onClose}>
      {vocabulary.error ? (
        <ErrorNotice error={vocabulary.error} onRetry={vocabulary.reload} />
      ) : !vocabulary.data ? (
        <Loading />
      ) : (
        <DeclareForm {...props} vocabulary={vocabulary.data} />
      )}
    </Dialog>
  );
}

function DeclareForm({
  initial,
  declared,
  revision,
  onClose,
  onSaved,
  vocabulary,
}: {
  initial: Declared;
  declared: Declared[];
  revision: string | null;
  onClose: () => void;
  onSaved: () => void;
  vocabulary: Vocabulary;
}) {
  const toast = useToast();
  const languages = vocabulary.languages;
  const taken = declared.filter((d) => d.id !== initial.id).map((d) => d.id);
  const lang0 = choiceOf(initial.language, languages);
  const allFrameworks = uniqueFrameworks(languages);
  const fw0 = choiceOf(initial.framework, initial.language ? (languages.find((l) => l.id === initial.language)?.frameworks ?? []) : allFrameworks);

  const [path, setPath] = useState(initial.path);
  const [id, setId] = useState(initial.id);
  // A new declaration follows the path until the user edits the identifier.
  const [idTouched, setIdTouched] = useState(initial.id !== "");
  const [language, setLanguage] = useState(lang0.choice);
  const [languageOther, setLanguageOther] = useState(lang0.other);
  const [framework, setFramework] = useState(fw0.choice);
  const [frameworkOther, setFrameworkOther] = useState(fw0.other);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const selected = languages.find((l) => l.id === language);
  // With the language left to detection every known framework is offered; otherwise only the language's own.
  const frameworks = language === "" ? allFrameworks : (selected?.frameworks ?? []);
  const supported = languages.filter((l) => l.supported);
  const unsupported = languages.filter((l) => !l.supported);
  const typedLanguage = language === OTHER && languageOther.trim() ? languages.find((l) => l.id === canonical(languageOther, languages)) : undefined;
  const notice: string | null =
    selected && !selected.supported
      ? t("ws_language_unsupported_notice", { name: selected.label })
      : language === OTHER && languageOther.trim()
        ? typedLanguage
          ? typedLanguage.supported
            ? null
            : t("ws_language_unsupported_notice", { name: typedLanguage.label })
          : t("ws_language_unknown_notice")
        : null;
  const frameworkHelp =
    language === ""
      ? t("ws_help_framework_all")
      : selected && frameworks.length === 0
        ? t("ws_help_framework_none_known", { name: selected.label })
        : t("ws_help_framework");

  const changePath = (value: string) => {
    setPath(value);
    if (!idTouched) setId(value.trim() ? suggestId(value, taken) : "");
  };
  const changeLanguage = (value: string) => {
    setLanguage(value);
    // A framework of another language would be a wrong pair: back to Nenhum (a typed one stays).
    const next = value === "" ? allFrameworks : (languages.find((l) => l.id === value)?.frameworks ?? []);
    if (framework !== OTHER && !next.some((f) => f.id === framework)) setFramework("");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const lang = language === OTHER ? canonical(languageOther, languages) : language;
    const fw = framework === OTHER ? canonical(frameworkOther, allFrameworks) : framework;
    // Fields the dialog does not edit (kind, include, exclude, enabled) are kept as they are in the file.
    const entry: Declared = { ...initial, id: id.trim(), path: path.trim() };
    delete entry.language;
    delete entry.framework;
    if (lang) entry.language = lang;
    if (fw) entry.framework = fw;
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
    <form className="stack" onSubmit={submit} data-testid="declare-form">
      <div className="ws-form-grid">
        <div className="ws-field">
          <label htmlFor="ws-decl-path">{t("ws_field_path")}</label>
          <input
            id="ws-decl-path"
            type="text"
            required
            autoFocus
            autoComplete="off"
            list="ws-decl-folders"
            value={path}
            onChange={(e) => changePath(e.target.value)}
            aria-describedby="ws-decl-path-help"
          />
          <datalist id="ws-decl-folders">
            {vocabulary.folders.map((f) => (
              <option key={f.path} value={f.path}>
                {f.detected ? t("ws_folder_detected") : ""}
              </option>
            ))}
          </datalist>
          <Help id="ws-decl-path-help">{t("ws_help_path")}</Help>
        </div>

        <div className="ws-field">
          <label htmlFor="ws-decl-id">{t("ws_field_id")}</label>
          <input
            id="ws-decl-id"
            type="text"
            required
            autoComplete="off"
            spellCheck={false}
            value={id}
            pattern="[a-z0-9][a-z0-9._\-]*"
            title={t("ws_help_id")}
            onChange={(e) => {
              setId(e.target.value);
              setIdTouched(true);
            }}
            aria-describedby="ws-decl-id-help"
          />
          <Help id="ws-decl-id-help">{t("ws_help_id")}</Help>
        </div>

        <div className="ws-field">
          <label htmlFor="ws-decl-language">{t("ws_field_language")}</label>
          <select id="ws-decl-language" value={language} onChange={(e) => changeLanguage(e.target.value)} aria-describedby="ws-decl-language-help">
            <option value="">{t("ws_language_detect")}</option>
            <optgroup label={t("ws_language_group_supported")}>
              {supported.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </optgroup>
            <optgroup label={t("ws_language_group_unsupported")}>
              {unsupported.map((l) => (
                <option key={l.id} value={l.id}>
                  {t("ws_language_unsupported_option", { name: l.label })}
                </option>
              ))}
            </optgroup>
            <option value={OTHER}>{t("ws_option_other")}</option>
          </select>
          <Help id="ws-decl-language-help">{t("ws_help_language")}</Help>
          {language === OTHER ? (
            <>
              <label htmlFor="ws-decl-language-other">{t("ws_field_language_other")}</label>
              <input
                id="ws-decl-language-other"
                type="text"
                required
                autoComplete="off"
                spellCheck={false}
                maxLength={60}
                value={languageOther}
                onChange={(e) => setLanguageOther(e.target.value)}
                aria-describedby="ws-decl-language-other-help"
              />
              <Help id="ws-decl-language-other-help">{t("ws_help_language_other")}</Help>
            </>
          ) : null}
          {notice ? (
            <div className="notice info" role="status" data-testid="language-notice">
              <Icon name="info" />
              <span>{notice}</span>
            </div>
          ) : null}
        </div>

        <div className="ws-field">
          <label htmlFor="ws-decl-framework">{t("ws_field_framework")}</label>
          <select id="ws-decl-framework" value={framework} onChange={(e) => setFramework(e.target.value)} aria-describedby="ws-decl-framework-help">
            <option value="">{t("ws_framework_none")}</option>
            {frameworks.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
            <option value={OTHER}>{t("ws_option_other")}</option>
          </select>
          <Help id="ws-decl-framework-help">{frameworkHelp}</Help>
          {framework === OTHER ? (
            <>
              <label htmlFor="ws-decl-framework-other">{t("ws_field_framework_other")}</label>
              <input
                id="ws-decl-framework-other"
                type="text"
                required
                autoComplete="off"
                spellCheck={false}
                maxLength={60}
                value={frameworkOther}
                onChange={(e) => setFrameworkOther(e.target.value)}
                aria-describedby="ws-decl-framework-other-help"
              />
              <Help id="ws-decl-framework-other-help">{t("ws_help_framework_other")}</Help>
            </>
          ) : null}
        </div>
      </div>
      <p className="small">{t("ws_declare_hint")}</p>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="row">
        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? <Spinner /> : null}
          {saving ? t("ws_saving") : t("ws_declare_save")}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}
