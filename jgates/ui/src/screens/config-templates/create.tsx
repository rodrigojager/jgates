import { useState, type FormEvent } from "react";
import { api } from "../../api";
import { Dialog, ErrorNotice } from "../../components/common";
import { t } from "../../i18n";

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CAPABILITIES = ["unit", "lint", "coverage", "sast", "secrets", "dependencies", "duplication", "iac", "architecture"];
const EFFECTS = ["readsCode", "writesOutputs", "mayChangeCode", "executesProjectCode", "usesNetwork"] as const;
type Effects = Record<(typeof EFFECTS)[number], boolean>;

const split = (text: string): string[] => text.split(/[,\s]+/).filter(Boolean);

/** "Criar template": the model of a project template (extends the base, matches a stack, one generic command as a vector). */
export function CreateTemplate({ folder, onClose, onCreated }: { folder: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [languages, setLanguages] = useState("");
  const [frameworks, setFrameworks] = useState("");
  const [command, setCommand] = useState("");
  const [capability, setCapability] = useState("unit");
  const [evidence, setEvidence] = useState("exit-code");
  const [effects, setEffects] = useState<Effects>({ readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const vector = split(command);
  const ok = ID_RE.test(id) && vector.length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/api/config/templates", {
        id,
        ...(label.trim() ? { label: label.trim() } : {}),
        languages: split(languages),
        frameworks: split(frameworks),
        command: vector,
        capability,
        effects,
        evidence: evidence === "exit-code" ? { kind: "exit-code" } : { kind: "test-runner", runner: evidence },
      });
      onCreated(id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t("cft_create_title")} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <p className="small muted">{t("cft_create_lead", { folder })}</p>
        <label className="field">
          <span className="field-label">{t("cft_create_id")}</span>
          <input className="input" value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" spellCheck={false} />
          <span className="small muted">{t("cft_create_id_help")}</span>
        </label>
        <label className="field">
          <span className="field-label">{t("cft_create_label")}</span>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />
        </label>
        <div className="three">
          <label className="field">
            <span className="field-label">{t("cft_create_languages")}</span>
            <input className="input" value={languages} onChange={(e) => setLanguages(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <label className="field">
            <span className="field-label">{t("cft_create_frameworks")}</span>
            <input className="input" value={frameworks} onChange={(e) => setFrameworks(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <label className="field">
            <span className="field-label">{t("cft_create_capability")}</span>
            <select className="input" value={capability} onChange={(e) => setCapability(e.target.value)}>
              {CAPABILITIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="small muted">{t("cft_create_match_help")}</p>
        <label className="field">
          <span className="field-label">{t("cft_create_command")}</span>
          <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} autoComplete="off" spellCheck={false} placeholder="go test ./..." />
          <span className="small muted" data-testid="command-vector">
            {vector.length > 0 ? t("cft_create_vector", { vector: JSON.stringify(vector) }) : t("cft_create_command_help")}
          </span>
        </label>
        <fieldset className="field">
          <legend className="field-label">{t("cft_create_effects")}</legend>
          <div className="tpl-effects">
            {EFFECTS.map((key) => (
              <label key={key} className="row">
                <input type="checkbox" checked={effects[key]} onChange={(e) => setEffects({ ...effects, [key]: e.target.checked })} />
                <span>{t(`cft_effect_${key}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span className="field-label">{t("cft_create_evidence")}</span>
          <select className="input" value={evidence} onChange={(e) => setEvidence(e.target.value)}>
            <option value="exit-code">{t("cft_evidence_exit")}</option>
            <option value="go-test">{t("cft_evidence_go")}</option>
            <option value="cargo-test">{t("cft_evidence_cargo")}</option>
          </select>
          <span className="small muted">{t("cft_create_evidence_help")}</span>
        </label>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="row">
          <button type="submit" className="btn primary" disabled={!ok || busy}>
            {t("cft_create_confirm")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
