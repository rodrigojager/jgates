import { useEffect, useState } from "react";
import { api } from "../../api";
import { DiffView } from "../../components/DiffView";
import { Dialog, ErrorNotice, Loading, Spinner, useAsync } from "../../components/common";
import { ValuePicker } from "../../components/pickers";
import { Stepper } from "../../components/Stepper";
import { t } from "../../i18n";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STEPS = ["layers", "rules", "review"] as const;
type Step = (typeof STEPS)[number];

/** What the editor needs of the screen's view. */
export interface EditorView {
  file: string;
  exists: boolean;
  revision: string | null;
  layers: Array<{ id: string; label: string; paths: string[]; modules: string[] }>;
  rules: Array<{ id: string; kind: string; from?: string | null; to?: string[]; blocking: boolean }>;
}

interface Proposal {
  layers: Array<{ id: string; paths: string[] }>;
  rules: Array<{ id: string; from: string; to: string[] }>;
}

interface LayerItem {
  id: string;
  paths: string[];
  existing: boolean;
  on: boolean;
  /** A layer written by hand with module selectors only: the editor keeps it and does not change its paths. */
  modulesOnly: boolean;
}

interface RuleItem {
  key: string;
  id: string;
  from: string;
  to: string[];
  existing: boolean;
  on: boolean;
}

/** A glob of a folder the person chose. */
const globOf = (folder: string): string => {
  const clean = folder.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return clean.endsWith("/**") || clean.includes("*") ? clean : `${clean}/**`;
};

function PathsField({ id, label, paths, disabled, onChange }: { id: string; label: string; paths: string[]; disabled: boolean; onChange: (next: string[]) => void }) {
  const [pending, setPending] = useState("");
  const add = () => {
    const value = pending.trim();
    if (value === "") return;
    const glob = globOf(value);
    if (!paths.includes(glob)) onChange([...paths, glob]);
    setPending("");
  };
  return (
    <div className="stack tight">
      <span className="small" id={`${id}-label`}>
        {label}
      </span>
      <ul className="arch-paths" aria-labelledby={`${id}-label`}>
        {paths.map((p) => (
          <li key={p} className="row arch-path">
            <code>{p}</code>
            <button type="button" className="btn" disabled={disabled} aria-label={t("cfa_ed_path_remove", { path: p })} onClick={() => onChange(paths.filter((x) => x !== p))}>
              {t("cfa_ed_remove")}
            </button>
          </li>
        ))}
      </ul>
      <div className="row wrap">
        <div className="grow">
          <ValuePicker id={id} source={{ name: "project-folder", glob: true }} value={pending} fieldLabel={label} labelledBy={`${id}-label`} disabled={disabled} placeholder={t("cfa_ed_pick_folder")} onChange={setPending} />
        </div>
        <button type="button" className="btn" disabled={disabled || pending.trim() === ""} onClick={add}>
          {t("cfa_ed_add_folder")}
        </button>
      </div>
    </div>
  );
}

/**
 * The guided editor of layers and rules: the layers are proposed from the folders of the project, the rules from the
 * layers, and one save writes .jgates/architecture.yml by patch after a diff. What the file already holds (comments,
 * other kinds of rule, keys the editor does not know) is kept: only what changed is written.
 */
export function ArchitectureEditor({ view, onClose, onSaved }: { view: EditorView; onClose: () => void; onSaved: () => void }) {
  const proposal = useAsync<Proposal>(() => api("GET", "/api/config/architecture/proposal"), "architecture-proposal");
  const [step, setStep] = useState<Step>("layers");
  const [layers, setLayers] = useState<LayerItem[] | null>(null);
  const [rules, setRules] = useState<RuleItem[] | null>(null);
  const [newLayer, setNewLayer] = useState("");
  const [diff, setDiff] = useState<{ diff: string; changed: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);

  // The first state: what the file declares, then what the folders suggest (on by default, off with one click).
  useEffect(() => {
    if (!proposal.data || layers !== null) return;
    const existing: LayerItem[] = view.layers.map((l) => ({ id: l.id, paths: [...l.paths], existing: true, on: true, modulesOnly: l.paths.length === 0 }));
    const proposed: LayerItem[] = proposal.data.layers.map((l) => ({ id: l.id, paths: l.paths, existing: false, on: true, modulesOnly: false }));
    setLayers([...existing, ...proposed]);
    const known: RuleItem[] = view.rules.filter((r) => r.kind === "forbidden-dependency").map((r) => ({ key: `old:${r.id}`, id: r.id, from: r.from ?? "", to: [...(r.to ?? [])], existing: true, on: true }));
    const suggested: RuleItem[] = proposal.data.rules.map((r) => ({ key: `new:${r.id}`, id: r.id, from: r.from, to: r.to, existing: false, on: true }));
    setRules([...known, ...suggested]);
  }, [proposal.data, layers, view]);

  if (proposal.error) {
    return (
      <Dialog title={t("cfa_ed_title")} onClose={onClose} wide>
        <ErrorNotice error={proposal.error} onRetry={proposal.reload} />
      </Dialog>
    );
  }
  if (!layers || !rules) {
    return (
      <Dialog title={t("cfa_ed_title")} onClose={onClose} wide>
        <Loading />
      </Dialog>
    );
  }

  const active = layers.filter((l) => l.on);
  const activeIds = new Set(active.map((l) => l.id));
  const layerOk = (l: LayerItem): boolean => ID_RE.test(l.id) && (l.paths.length > 0 || l.modulesOnly);
  const layersOk = active.every(layerOk) && new Set(active.map((l) => l.id)).size === active.length;
  const ruleUsable = (r: RuleItem): boolean => r.from !== "" && r.to.length > 0 && activeIds.has(r.from) && r.to.every((x) => activeIds.has(x)) && !r.to.includes(r.from);
  const otherKinds = view.rules.filter((r) => r.kind !== "forbidden-dependency");
  const stepOk: Record<Step, boolean> = { layers: layersOk, rules: rules.filter((r) => r.on).every(ruleUsable), review: true };
  const index = STEPS.indexOf(step);
  const reachable = (target: Step): boolean => STEPS.slice(0, STEPS.indexOf(target)).every((s) => stepOk[s]);

  const body = () => ({
    layers: active.filter((l) => !l.modulesOnly).map((l) => ({ id: l.id, paths: l.paths })),
    rules: rules.filter((r) => r.on && ruleUsable(r)).map((r) => ({ id: r.id, from: r.from, to: r.to, ...(r.existing ? {} : { blocking: true }) })),
    removeLayers: layers.filter((l) => l.existing && !l.on).map((l) => l.id),
    removeRules: rules.filter((r) => r.existing && !r.on).map((r) => r.id),
    expectedRevision: view.revision,
  });

  const go = async (target: Step) => {
    setError(null);
    if (target === "review") {
      setBusy("preview");
      try {
        const p = await api<{ diff: string; changed: boolean }>("POST", "/api/config/architecture/preview", body());
        setDiff(p);
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
      await api("PUT", "/api/config/architecture", body());
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const setLayer = (id: string, change: Partial<LayerItem>) => setLayers(layers.map((l) => (l.id === id ? { ...l, ...change } : l)));
  const setRule = (key: string, change: Partial<RuleItem>) => setRules(rules.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const addLayer = () => {
    const id = newLayer.trim();
    if (!ID_RE.test(id) || layers.some((l) => l.id === id)) return;
    setLayers([...layers, { id, paths: [], existing: false, on: true, modulesOnly: false }]);
    setNewLayer("");
  };
  const addRule = () => {
    const [from, to] = [active[0]?.id ?? "", active[1]?.id ?? ""];
    if (from === "" || to === "") return;
    let id = `${from}-not-${to}`;
    for (let n = 2; rules.some((r) => r.id === id); n += 1) id = `${from}-not-${to}-${n}`;
    setRules([...rules, { key: `new:${id}`, id, from, to: [to], existing: false, on: true }]);
  };
  const nameOf = (rule: RuleItem): string => t("cfa_ed_rule_text", { from: rule.from || "?", to: rule.to.join(", ") || "?" });

  return (
    <Dialog title={t("cfa_ed_title")} onClose={onClose} wide>
      <div className="stack" data-testid="architecture-editor">
        <p className="small muted">{view.exists ? t("cfa_ed_lead_edit", { file: view.file }) : t("cfa_ed_lead_new", { file: view.file })}</p>
        <Stepper label={t("cfa_ed_steps")} current={step} onSelect={(target) => void go(target as Step)} steps={STEPS.map((s, i) => ({ id: s, label: t(`cfa_ed_step_${s}`), disabled: busy !== null || !reachable(s), done: i < index }))} />

        {step === "layers" ? (
          <section className="stack" aria-labelledby="cfa-ed-layers">
            <h3 id="cfa-ed-layers">{t("cfa_ed_layers_title")}</h3>
            <p className="small muted">{t("cfa_ed_layers_help")}</p>
            {layers.length === 0 ? <p className="small muted">{t("cfa_ed_layers_none")}</p> : null}
            <ul className="arch-edit-list">
              {layers.map((l) => (
                <li key={l.id} className="card flat stack" data-edit-layer={l.id}>
                  <label className="row">
                    <input type="checkbox" checked={l.on} onChange={(e) => setLayer(l.id, { on: e.target.checked })} />
                    <strong>{l.id}</strong>
                    {!l.existing ? <span className="small muted">{t("cfa_ed_proposed")}</span> : null}
                  </label>
                  {l.on && l.modulesOnly ? <p className="small muted">{t("cfa_ed_modules_only")}</p> : null}
                  {l.on && !l.modulesOnly ? <PathsField id={`cfa-ed-paths-${l.id}`} label={t("cfa_ed_paths", { id: l.id })} paths={l.paths} disabled={busy !== null} onChange={(next) => setLayer(l.id, { paths: next })} /> : null}
                  {l.on && !l.modulesOnly && l.paths.length === 0 ? (
                    <p className="small field-problem" role="alert">
                      {t("cfa_ed_paths_needed")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="row wrap">
              <label className="stack tight grow">
                <span className="small">{t("cfa_ed_new_layer")}</span>
                <input className="input" data-free-text="identifier" value={newLayer} autoComplete="off" spellCheck={false} onChange={(e) => setNewLayer(e.target.value)} />
              </label>
              <button type="button" className="btn" disabled={!ID_RE.test(newLayer.trim()) || layers.some((l) => l.id === newLayer.trim())} onClick={addLayer}>
                {t("cfa_ed_add_layer")}
              </button>
            </div>
          </section>
        ) : null}

        {step === "rules" ? (
          <section className="stack" aria-labelledby="cfa-ed-rules">
            <h3 id="cfa-ed-rules">{t("cfa_ed_rules_title")}</h3>
            <p className="small muted">{t("cfa_ed_rules_help")}</p>
            {rules.length === 0 ? <p className="small muted">{t("cfa_ed_rules_none")}</p> : null}
            <ul className="arch-edit-list">
              {rules.map((r) => (
                <li key={r.key} className="card flat stack" data-edit-rule={r.id}>
                  <label className="row">
                    <input type="checkbox" checked={r.on} onChange={(e) => setRule(r.key, { on: e.target.checked })} aria-label={t("cfa_ed_rule_use", { text: nameOf(r) })} />
                    <strong>{nameOf(r)}</strong>
                    {!r.existing ? <span className="small muted">{t("cfa_ed_proposed")}</span> : null}
                  </label>
                  {r.on ? (
                    <div className="row wrap">
                      <label className="stack tight">
                        <span className="small">{t("cfa_ed_from", { id: r.id })}</span>
                        <select className="input" value={r.from} onChange={(e) => setRule(r.key, { from: e.target.value, to: r.to.filter((x) => x !== e.target.value) })}>
                          {r.from === "" || !activeIds.has(r.from) ? <option value={r.from}>{r.from || t("cfa_ed_choose")}</option> : null}
                          {active.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.id}
                            </option>
                          ))}
                        </select>
                      </label>
                      <fieldset className="stack tight arch-to">
                        <legend className="small">{t("cfa_ed_to", { id: r.id })}</legend>
                        {active
                          .filter((l) => l.id !== r.from)
                          .map((l) => (
                            <label key={l.id} className="row">
                              <input type="checkbox" checked={r.to.includes(l.id)} onChange={(e) => setRule(r.key, { to: e.target.checked ? [...r.to, l.id] : r.to.filter((x) => x !== l.id) })} />
                              <span className="small">{l.id}</span>
                            </label>
                          ))}
                      </fieldset>
                    </div>
                  ) : null}
                  {r.on && !ruleUsable(r) ? (
                    <p className="small field-problem" role="alert">
                      {t("cfa_ed_rule_incomplete")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            <div>
              <button type="button" className="btn" disabled={active.length < 2} onClick={addRule}>
                {t("cfa_ed_add_rule")}
              </button>
            </div>
            {otherKinds.length > 0 ? <p className="small muted">{t("cfa_ed_kept", { count: otherKinds.length })}</p> : null}
          </section>
        ) : null}

        {step === "review" ? (
          <section className="stack" aria-labelledby="cfa-ed-review" data-testid="architecture-review">
            <h3 id="cfa-ed-review">{t("cfa_ed_review_title")}</h3>
            <p className="small muted">{t("cfa_ed_review_help", { file: view.file })}</p>
            {diff && diff.changed ? <DiffView diff={diff.diff} /> : <p className="notice" role="status">{t("cfa_ed_unchanged")}</p>}
          </section>
        ) : null}

        {error ? <ErrorNotice error={error} /> : null}
        <div className="row wrap">
          <button type="button" className="btn" disabled={index === 0 || busy !== null} onClick={() => void go(STEPS[index - 1] as Step)}>
            {t("back")}
          </button>
          {step !== "review" ? (
            <button type="button" className="btn primary" data-testid="arch-next" disabled={!stepOk[step] || busy !== null} onClick={() => void go(STEPS[index + 1] as Step)}>
              {busy === "preview" ? <Spinner /> : null}
              {step === "rules" ? t("cfa_ed_to_review") : t("cfa_ed_next")}
            </button>
          ) : (
            <button type="button" className="btn primary" data-testid="arch-save" disabled={busy !== null || !diff?.changed} onClick={save}>
              {busy === "save" ? <Spinner /> : null}
              {view.exists ? t("cfa_ed_save") : t("cfa_ed_create")}
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
