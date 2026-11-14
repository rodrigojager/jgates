// The choice of the gate and of the target, one component for the wizard's review (step 6) and for Escolher: radios for
// the gate (Quality, Semantic, both; Semantic is offered disabled, with the reason and its action, while it has no
// provider) and for the target (workspace, last commit, branch changes naming their base, comparison, pull request,
// folder), selects of branches, tags and recent commits instead of typed references, the folder picker for a folder,
// and "Usar como padrão do projeto", which saves the choice in jgates.yml > selection.
import { useEffect, useState } from "react";
import { api } from "../../api";
import { ErrorNotice } from "../../components/common";
import { ValuePicker, usePicker } from "../../components/pickers";
import { t } from "../../i18n";
import type { GateChoice, TargetKind, ValidationRequest } from "./request";

/** What GET /api/validations/choose says about the gates and the saved default (the rest of it is Escolher's). */
export interface ChooseSelection {
  gates: { semantic: { configured: boolean; reason: { code: string; message: string } | null; action: { type: string; route: string; label: string } | null } };
  saved: { gates: string[] | null; scope: "changed" | "full" | "paths" | null; paths: string[] };
}

const GATES: GateChoice[] = ["quality", "semantic", "both"];
const TARGETS: TargetKind[] = ["full", "last-commit", "changed", "compare", "pr", "paths"];
const NEEDS_GIT: ReadonlySet<TargetKind> = new Set(["last-commit", "changed", "compare", "pr"]);
/** The branches a base is looked for in, first match wins. */
const BASES = ["main", "master", "trunk", "develop"];

/** The request a project's saved default stands for (jgates.yml > selection), to preselect it. */
export function savedRequest(saved: ChooseSelection["saved"] | undefined): Partial<ValidationRequest> {
  if (!saved) return {};
  const out: Partial<ValidationRequest> = {};
  if (saved.gates) out.gates = saved.gates.includes("semantic") ? (saved.gates.includes("quality") ? "both" : "semantic") : "quality";
  if (saved.scope === "full") out.target = "full";
  else if (saved.scope === "changed") out.target = "changed";
  else if (saved.scope === "paths") {
    out.target = "paths";
    out.path = saved.paths[0] ?? "";
  }
  return out;
}

/** Why the chosen target cannot be reviewed yet, or null: the folder and the two ends of a pull request are needed. */
export function targetProblem(request: ValidationRequest): "path" | "refs" | null {
  if (request.gates !== "semantic" && request.target === "paths" && request.path.trim() === "") return "path";
  if (request.target === "pr" && (request.base.trim() === "" || request.head.trim() === "")) return "refs";
  return null;
}

const key = (target: TargetKind): string => target.replace(/-/g, "_");

/** "Quality, Semantic or both" as the list the project saves. */
const gatesList = (gates: GateChoice): string[] => (gates === "both" ? ["quality", "semantic"] : [gates]);

interface Props {
  request: ValidationRequest;
  set: (patch: Partial<ValidationRequest>) => void;
  data: ChooseSelection | null;
  /** The branch the workspace is on, or null (no Git, or a detached HEAD); null `git` is a folder that is not a repository. */
  git: { branch: string | null; detached: boolean } | null;
  /** Prefix of the ids (the wizard and Escolher never show at once, but each id is unique anyway). */
  idPrefix: string;
  /** Called after the default was saved, so the caller can read it again. */
  onSaved?: () => void;
}

export function GateTargetChoice({ request, set, data, git, idPrefix, onSaved }: Props) {
  const semantic = data?.gates.semantic ?? null;
  const semanticOff = semantic !== null && !semantic.configured;
  const repository = git !== null;
  const refs = usePicker(repository ? { name: "git-ref" } : null);
  const branches = (refs.list?.items ?? []).filter((i) => i.group === "branch").map((i) => i.value);
  const base = BASES.find((b) => branches.includes(b)) ?? null;
  const current = git?.detached ? null : (git?.branch ?? null);
  const problem = targetProblem(request);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  // The base a branch is compared with, and the branch of a pull request, start at what the repository says.
  useEffect(() => {
    if ((request.target === "changed" || request.target === "compare" || request.target === "pr") && request.base === "" && base) set({ base });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.target, request.base, base]);
  useEffect(() => {
    if (request.target === "pr" && request.head === "" && current) set({ head: current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.target, request.head, current]);
  // A request from before the gate was disabled cannot keep selecting it.
  useEffect(() => {
    if (semanticOff && request.gates !== "quality") set({ gates: "quality" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [semanticOff, request.gates]);
  // A request of an older screen: the project at one commit is read as a comparison of that commit.
  useEffect(() => {
    if (request.target === "commit") set({ target: "compare" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.target]);
  // A target that needs Git cannot stay chosen in a folder that is not a repository.
  useEffect(() => {
    if (!repository && NEEDS_GIT.has(request.target)) set({ target: "full" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repository, request.target]);

  const saveable = request.target === "full" || request.target === "changed" || (request.target === "paths" && request.path.trim() !== "");
  const dirty = (): void => setSaved(false);

  async function saveDefault() {
    setSaving(true);
    setFailure(null);
    try {
      const scope = request.target === "paths" ? "paths" : request.target === "changed" ? "changed" : "full";
      await api("PUT", "/api/validations/selection", { gates: gatesList(request.gates), scope, ...(scope === "paths" ? { paths: [request.path.trim()] } : {}) });
      setSaved(true);
      onSaved?.();
    } catch (e) {
      setFailure(e);
    } finally {
      setSaving(false);
    }
  }

  const targetLabel = (target: TargetKind): string => {
    if (target === "changed") return base || request.base ? t("gtc_target_changed_named", { base: request.base || (base as string) }) : t("vch_target_changed");
    return t(`gtc_target_${key(target)}`);
  };
  const noGit = !repository;
  const id = (name: string) => `${idPrefix}-${name}`;

  return (
    <>
      <section className="card flat stack" aria-labelledby={id("gates")} data-testid="gate-choice">
        <h2 id={id("gates")}>{t("vch_gates_title")}</h2>
        <p className="muted small">{t("vch_gates_lead")}</p>
        <div role="radiogroup" aria-labelledby={id("gates")} className="stack" style={{ gap: 8 }}>
          {GATES.map((gates) => {
            const off = semanticOff && gates !== "quality";
            return (
              <label key={gates} className="row" style={{ gap: 8, alignItems: "flex-start" }} data-gate={gates} data-disabled={off ? "true" : undefined}>
                <input
                  type="radio"
                  name={id("gates")}
                  value={gates}
                  checked={request.gates === gates}
                  disabled={off}
                  aria-describedby={off ? id("semantic-off") : undefined}
                  onChange={() => {
                    set({ gates });
                    dirty();
                  }}
                />
                <span>
                  <strong>{t(`vch_gates_${gates}`)}</strong>
                  <span className="muted small"> · {t(`vch_gates_${gates}_hint`)}</span>
                </span>
              </label>
            );
          })}
        </div>
        {semanticOff ? (
          <div className="notice warn" role="status" id={id("semantic-off")} data-testid="semantic-off">
            <div className="stack tight grow">
              <p className="small">{semantic?.reason?.message}</p>
              {semantic?.action ? (
                <div>
                  <a className="btn" href={`#/${semantic.action.route}`}>
                    {semantic.action.label}
                  </a>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {request.gates === "both" ? (
          <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" checked={request.manualAdvance} onChange={(e) => set({ manualAdvance: e.target.checked })} />
            <span>
              {t("vch_gates_manual")}
              <span className="muted small"> · {t("vch_gates_manual_hint")}</span>
            </span>
          </label>
        ) : null}
      </section>

      <section className="card flat stack" aria-labelledby={id("target")} data-testid="target-choice">
        <h2 id={id("target")}>{t("vch_target_title")}</h2>
        <div role="radiogroup" aria-labelledby={id("target")} className="stack" style={{ gap: 8 }}>
          {TARGETS.map((target) => {
            const off = NEEDS_GIT.has(target) && noGit;
            return (
              <div key={target} className="stack tight" data-target={target}>
                <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                  <input
                    type="radio"
                    name={id("target")}
                    value={target}
                    checked={request.target === target}
                    disabled={off}
                    aria-describedby={off ? id("no-git") : undefined}
                    onChange={() => {
                      set({ target });
                      dirty();
                    }}
                  />
                  <span>
                    <strong>{targetLabel(target)}</strong>
                    <span className="muted small"> · {t(`gtc_target_${key(target)}_hint`)}</span>
                  </span>
                </label>
                {request.target === target && target === "last-commit" ? <p className="small muted gtc-sub">{t("gtc_last_commit_note")}</p> : null}
                {request.target === target && target === "changed" ? (
                  <div className="gtc-sub stack tight">
                    <label htmlFor={id("changed-base")}>{t("vch_field_base")}</label>
                    <ValuePicker id={id("changed-base")} source={{ name: "git-ref" }} value={request.base || null} fieldLabel={t("vch_field_base")} placeholder={t("gtc_choose_ref")} onChange={(base) => set({ base })} />
                    {!base && !request.base ? <p className="small muted">{t("gtc_changed_no_base")}</p> : null}
                  </div>
                ) : null}
                {request.target === target && (target === "compare" || target === "pr") ? (
                  <div className="gtc-sub stack tight">
                    <label htmlFor={id(`${target}-base`)}>{t(target === "pr" ? "gtc_pr_base" : "vch_field_base")}</label>
                    <ValuePicker id={id(`${target}-base`)} source={{ name: "git-ref" }} value={request.base || null} fieldLabel={t(target === "pr" ? "gtc_pr_base" : "vch_field_base")} placeholder={t("gtc_choose_ref")} onChange={(next) => set({ base: next })} />
                    <label htmlFor={id(`${target}-head`)}>{t(target === "pr" ? "gtc_pr_head" : "vch_field_head")}</label>
                    <ValuePicker id={id(`${target}-head`)} source={{ name: "git-ref" }} value={request.head || null} fieldLabel={t(target === "pr" ? "gtc_pr_head" : "vch_field_head")} placeholder={t(target === "pr" ? "gtc_choose_ref" : "gtc_work_tree")} onChange={(next) => set({ head: next })} />
                    {target === "pr" && problem === "refs" ? (
                      <p className="small field-problem" role="status" data-testid="refs-problem">
                        {t("gtc_pr_required")}
                      </p>
                    ) : null}
                    <p className="muted small">{t(target === "pr" ? "gtc_pr_note" : "gtc_compare_note")}</p>
                  </div>
                ) : null}
                {request.target === target && target === "paths" ? (
                  <div className="gtc-sub stack tight">
                    <label htmlFor={id("path")}>{t("vch_field_path")}</label>
                    <ValuePicker id={id("path")} source={{ name: "project-folder" }} value={request.path || null} fieldLabel={t("vch_field_path")} placeholder={t("gtc_choose_folder")} describedBy={problem === "path" ? "vch-path-problem" : undefined} onChange={(path) => set({ path })} />
                    {problem === "path" ? (
                      <span className="small field-problem" id="vch-path-problem" role="status" data-testid="path-problem">
                        {t("vch_path_required")}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {noGit ? (
          <p className="small muted" id={id("no-git")}>
            {t("gtc_no_git")}
          </p>
        ) : null}

        <div className="stack tight gtc-default" data-testid="save-default-block">
          <div className="row wrap">
            <button type="button" className="btn" disabled={!saveable || saving} aria-describedby={id("default-note")} onClick={() => void saveDefault()} data-testid="save-default">
              {t("gtc_save_default")}
            </button>
            {saved ? (
              <span className="small" role="status" data-testid="default-saved">
                {t("gtc_default_saved")}
              </span>
            ) : null}
          </div>
          <p className="small muted" id={id("default-note")}>
            {saveable ? t("gtc_default_note") : t("gtc_default_not_saveable")}
            {data?.saved.scope ? ` ${t("gtc_default_current", { gates: gatesText(data.saved.gates), scope: t(`gtc_scope_${data.saved.scope}`) })}` : ""}
          </p>
          {failure ? <ErrorNotice error={failure} /> : null}
        </div>
      </section>
    </>
  );
}

function gatesText(gates: string[] | null): string {
  if (!gates || gates.length === 0) return t("vch_gates_quality");
  return gates.includes("semantic") ? (gates.includes("quality") ? t("vch_gates_both") : t("vch_gates_semantic")) : t("vch_gates_quality");
}
