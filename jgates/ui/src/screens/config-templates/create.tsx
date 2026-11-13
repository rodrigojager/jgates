import { useEffect, useState } from "react";
import { yamlHref } from "../../forms/derived/api";
import { api } from "../../api";
import { DiffView } from "../../components/DiffView";
import { Dialog, ErrorNotice, Loading, Spinner, useAsync } from "../../components/common";
import { ValuePicker } from "../../components/pickers";
import { Stepper } from "../../components/Stepper";
import { t } from "../../i18n";

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EFFECTS = ["readsCode", "writesOutputs", "mayChangeCode", "executesProjectCode", "usesNetwork"] as const;
type Effects = Record<(typeof EFFECTS)[number], boolean>;
const STEPS = ["purpose", "match", "command", "review"] as const;
type Step = (typeof STEPS)[number];

const DEFAULT_EFFECTS: Effects = { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false };

interface Model {
  label: string;
  languages: string[];
  frameworks: string[];
  command: string[];
  capability: string;
  effects: Effects;
  evidence: { kind: "exit-code" } | { kind: "test-runner"; runner: string };
  extraCapabilities: boolean;
}

interface FilePreview {
  file: string;
  created: boolean;
  diff: string;
}

/** A list of values chosen one at a time from a picker: the chosen ones as removable chips, the picker to add another. */
function PickList({ id, source, label, values, onChange }: { id: string; source: "language" | "framework"; label: string; values: string[]; onChange: (next: string[]) => void }) {
  const [pending, setPending] = useState("");
  const add = () => {
    const value = pending.trim();
    if (value === "") return;
    if (!values.includes(value)) onChange([...values, value]);
    setPending("");
  };
  return (
    <div className="field stack tight" data-testid={`pick-${source}`}>
      <span className="field-label" id={`${id}-label`}>
        {label}
      </span>
      {values.length > 0 ? (
        <ul className="tpl-chips" aria-label={label}>
          {values.map((v) => (
            <li key={v} className="row tpl-chip">
              <code>{v}</code>
              <button type="button" className="btn" aria-label={t("cft_w_remove", { value: v })} onClick={() => onChange(values.filter((x) => x !== v))}>
                {t("cft_w_remove_short")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row wrap">
        <div className="grow">
          <ValuePicker id={id} source={{ name: source }} value={pending} fieldLabel={label} labelledBy={`${id}-label`} onChange={setPending} />
        </div>
        <button type="button" className="btn" disabled={pending.trim() === ""} onClick={add}>
          {t("cft_w_add")}
        </button>
      </div>
    </div>
  );
}

/**
 * "Criar template" and "Editar": a stepper that asks one thing at a time (what the template checks, what it matches,
 * the command, the review with the diff of every file it writes). The command is a list: the executable and one entry
 * per argument, so an argument with spaces in it stays one argument.
 */
export function TemplateWizard({ folder, editing, revision, onClose, onDone }: { folder: string; editing: string | null; revision: string | null; onClose: () => void; onDone: (id: string) => void }) {
  const detail = useAsync<{ model: Model | null }>(() => (editing ? api("GET", `/api/config/templates/${encodeURIComponent(editing)}`) : Promise.resolve({ model: null })), `template-edit:${editing ?? ""}`);
  const [step, setStep] = useState<Step>("purpose");
  const [id, setId] = useState(editing ?? "");
  const [label, setLabel] = useState("");
  const [capability, setCapability] = useState("");
  const [languages, setLanguages] = useState<string[]>([]);
  const [frameworks, setFrameworks] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState<string[]>([]);
  const [evidence, setEvidence] = useState("exit-code");
  const [effects, setEffects] = useState<Effects>(DEFAULT_EFFECTS);
  const [preview, setPreview] = useState<FilePreview[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);

  const model = detail.data?.model ?? null;
  useEffect(() => {
    if (!model) return;
    setLabel(model.label);
    setCapability(model.capability);
    setLanguages(model.languages);
    setFrameworks(model.frameworks);
    setCommand(model.command[0] ?? "");
    setArgs(model.command.slice(1));
    setEvidence(model.evidence.kind === "test-runner" ? model.evidence.runner : "exit-code");
    setEffects(model.effects);
  }, [model]);

  const vector = [command.trim(), ...args].filter((v) => v !== "");
  const idOk = ID_RE.test(id);
  const stepOk: Record<Step, boolean> = { purpose: idOk && capability !== "", match: true, command: command.trim() !== "", review: true };
  const index = STEPS.indexOf(step);
  const reachable = (target: Step): boolean => STEPS.slice(0, STEPS.indexOf(target)).every((s) => stepOk[s]);

  const body = () => ({
    id,
    ...(label.trim() ? { label: label.trim() } : {}),
    languages,
    frameworks,
    command: vector,
    capability,
    effects,
    evidence: evidence === "exit-code" ? { kind: "exit-code" } : { kind: "test-runner", runner: evidence },
  });

  const go = async (target: Step) => {
    setError(null);
    if (target === "review") {
      setBusy("preview");
      try {
        const p = await api<{ files: FilePreview[] }>("POST", "/api/config/template-preview", { ...body(), ...(editing ? { edit: true } : {}) });
        setPreview(p.files);
        setStep("review");
      } catch (e) {
        setError(e);
      } finally {
        setBusy(null);
      }
      return;
    }
    setStep(target);
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      if (editing) {
        const { id: _id, ...rest } = body();
        await api("PUT", `/api/config/templates/${encodeURIComponent(editing)}`, { ...rest, expectedRevision: revision });
      } else await api("POST", "/api/config/templates", body());
      onDone(id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const title = editing ? t("cft_w_edit_title", { id: editing }) : t("cft_create_title");
  if (editing && detail.error) {
    return (
      <Dialog title={title} onClose={onClose} wide>
        <ErrorNotice error={detail.error} onRetry={detail.reload} />
      </Dialog>
    );
  }
  if (editing && !detail.data) {
    return (
      <Dialog title={title} onClose={onClose} wide>
        <Loading />
      </Dialog>
    );
  }
  if (editing && !model) {
    return (
      <Dialog title={title} onClose={onClose} wide>
        <div className="notice warn" role="status" data-testid="tpl-not-editable">
          <p>{t("cft_w_not_editable")}</p>
        </div>
        <a className="btn" href={yamlHref(`.jgates/templates/${editing}.yml`, "")}>
          {t("cft_d_open_yaml")}
        </a>
      </Dialog>
    );
  }

  return (
    <Dialog title={title} onClose={onClose} wide>
      <div className="stack" data-testid="template-wizard">
        <p className="small muted">{editing ? t("cft_w_edit_lead") : t("cft_create_lead", { folder })}</p>
        <Stepper
          label={t("cft_w_steps")}
          current={step}
          onSelect={(target) => void go(target as Step)}
          steps={STEPS.map((s, i) => ({ id: s, label: t(`cft_w_step_${s}`), disabled: busy !== null || !reachable(s), done: i < index }))}
        />

        {step === "purpose" ? (
          <section className="stack" aria-labelledby="cft-w-purpose">
            <h3 id="cft-w-purpose">{t("cft_w_purpose_title")}</h3>
            <div className="field">
              <label className="field-label" htmlFor="cft-w-id">
                {t("cft_create_id")}
              </label>
              <input id="cft-w-id" className="input" data-free-text="identifier" value={id} disabled={editing !== null} onChange={(e) => setId(e.target.value)} autoComplete="off" spellCheck={false} autoFocus={editing === null} aria-describedby="cft-w-id-help" />
              <span className="small muted" id="cft-w-id-help">
                {t("cft_create_id_help")}
              </span>
              {id !== "" && !idOk ? (
                <span className="small field-problem" role="alert">
                  {t("cft_w_id_invalid")}
                </span>
              ) : null}
            </div>
            <div className="field">
              <label className="field-label" htmlFor="cft-w-label">
                {t("cft_create_label")}
              </label>
              <input id="cft-w-label" className="input" data-free-text="open-text" value={label} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />
            </div>
            <div className="field stack tight">
              <span className="field-label" id="cft-w-capability-label">
                {t("cft_create_capability")}
              </span>
              <ValuePicker id="cft-w-capability" source={{ name: "capability" }} value={capability} fieldLabel={t("cft_create_capability")} labelledBy="cft-w-capability-label" onChange={setCapability} />
              <span className="small muted">{t("cft_w_capability_help")}</span>
            </div>
          </section>
        ) : null}

        {step === "match" ? (
          <section className="stack" aria-labelledby="cft-w-match">
            <h3 id="cft-w-match">{t("cft_w_match_title")}</h3>
            <p className="small muted">{t("cft_w_match_help")}</p>
            <PickList id="cft-w-language" source="language" label={t("cft_create_languages")} values={languages} onChange={setLanguages} />
            <PickList id="cft-w-framework" source="framework" label={t("cft_create_frameworks")} values={frameworks} onChange={setFrameworks} />
            <p className="small muted">{languages.length + frameworks.length === 0 ? t("cft_w_match_none") : t("cft_w_match_some")}</p>
          </section>
        ) : null}

        {step === "command" ? (
          <section className="stack" aria-labelledby="cft-w-command">
            <h3 id="cft-w-command">{t("cft_w_command_title")}</h3>
            <div className="field">
              <label className="field-label" htmlFor="cft-w-executable">
                {t("cft_w_executable")}
              </label>
              <input id="cft-w-executable" className="input mono" data-free-text="command" value={command} onChange={(e) => setCommand(e.target.value)} autoComplete="off" spellCheck={false} placeholder="go" aria-describedby="cft-w-executable-help" />
              <span className="small muted" id="cft-w-executable-help">
                {t("cft_w_executable_help")}
              </span>
            </div>
            <fieldset className="field stack tight">
              <legend className="field-label">{t("cft_w_args")}</legend>
              <p className="small muted">{t("cft_w_args_help")}</p>
              <ul className="tpl-args">
                {args.map((arg, i) => (
                  <li key={i} className="row">
                    <input className="input mono grow" data-free-text="arguments" aria-label={t("cft_w_arg_n", { n: i + 1 })} value={arg} onChange={(e) => setArgs(args.map((a, k) => (k === i ? e.target.value : a)))} autoComplete="off" spellCheck={false} />
                    <button type="button" className="btn" aria-label={t("cft_w_arg_remove", { n: i + 1 })} onClick={() => setArgs(args.filter((_, k) => k !== i))}>
                      {t("cft_w_remove_short")}
                    </button>
                  </li>
                ))}
              </ul>
              <div>
                <button type="button" className="btn" onClick={() => setArgs([...args, ""])}>
                  {t("cft_w_arg_add")}
                </button>
              </div>
            </fieldset>
            <p className="small muted" data-testid="command-vector">
              {vector.length > 0 ? t("cft_create_vector", { vector: JSON.stringify(vector) }) : t("cft_create_command_help")}
            </p>
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
          </section>
        ) : null}

        {step === "review" ? (
          <section className="stack" aria-labelledby="cft-w-review" data-testid="template-review">
            <h3 id="cft-w-review">{t("cft_w_review_title")}</h3>
            <p className="small muted">{t("cft_w_review_help")}</p>
            {(preview ?? []).map((f) => (
              <div key={f.file} className="stack tight" data-file={f.file}>
                <p>
                  <code>{f.file}</code> {f.created ? <span className="small muted">{t("cft_w_new_file")}</span> : null}
                </p>
                <DiffView diff={f.diff} />
              </div>
            ))}
          </section>
        ) : null}

        {error ? <ErrorNotice error={error} /> : null}
        <div className="row wrap">
          <button type="button" className="btn" disabled={index === 0 || busy !== null} onClick={() => void go(STEPS[index - 1] as Step)}>
            {t("back")}
          </button>
          {step !== "review" ? (
            <button type="button" className="btn primary" data-testid="tpl-next" disabled={!stepOk[step] || busy !== null} onClick={() => void go(STEPS[index + 1] as Step)}>
              {busy === "preview" ? <Spinner /> : null}
              {step === "command" ? t("cft_w_to_review") : t("cft_w_next")}
            </button>
          ) : (
            <button type="button" className="btn primary" data-testid="tpl-save" disabled={busy !== null} onClick={save}>
              {busy === "save" ? <Spinner /> : null}
              {editing ? t("cft_w_save") : t("cft_create_confirm")}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
