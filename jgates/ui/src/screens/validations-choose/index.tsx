import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { navigate } from "../../app/route";
import { useShell } from "../../app/shell-context";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { readRequest, writeRequest, type TargetKind, type ValidationRequest } from "../validations-review/request";

export const screen: ScreenMeta = { id: "validations-choose", path: "/validations/choose", area: "validations", navLabel: "vch_nav", navPath: "/validations/choose", order: 31, icon: "sliders" };

const TARGETS: TargetKind[] = ["changed", "full", "paths", "commit", "compare"];

const capLabel = (cap: string): string => tOr(`vrev_cap_${cap.replace(/[^a-z0-9]+/gi, "_")}`, cap);
const catLabel = (cat: string | null): string => (cat ? tOr(`vrev_cat_${cat}`, cat) : t("vrev_cat_none"));

interface CapRow {
  capability: string;
  category: string | null;
  enabled: boolean;
  required: boolean;
  tools: string[];
}

/** One row per capability of the plan of the chosen profile, grouped by category. */
function rowsOf(plan: any): Array<[string | null, CapRow[]]> {
  const rows = new Map<string, CapRow>();
  for (const item of [...plan.groups.willRun, ...plan.groups.notApplicableOrDisabled] as any[]) {
    if (item.availability?.status === "not_executable") continue;
    for (const capability of (item.capabilities ?? []) as string[]) {
      const row: CapRow = rows.get(capability) ?? { capability, category: item.category ?? null, enabled: false, required: false, tools: [] };
      row.enabled ||= item.state.enabled === true;
      row.required ||= item.state.enabled === true && item.requirement === "required";
      if (!row.tools.includes(item.label)) row.tools.push(item.label);
      rows.set(capability, row);
    }
  }
  const byCategory = new Map<string | null, CapRow[]>();
  for (const row of rows.values()) byCategory.set(row.category, [...(byCategory.get(row.category) ?? []), row]);
  return [...byCategory.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
}

function Customize({ profile, skip, onSkip, onSaved }: { profile: any; skip: string[]; onSkip: (next: string[]) => void; onSaved: (id: string | null) => void }) {
  const toast = useToast();
  // The plan of the chosen profile as it is, to know what the profile asks for; not kept as the last plan.
  const base = useAsync(() => api("POST", "/api/plans", { profile: profile.ref, scope: "full", preview: true }), `choose-base:${profile.ref}`);
  const [naming, setNaming] = useState(false);
  const [newId, setNewId] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const plan = (base.data as any)?.plan;
  const rows = useMemo(() => (plan ? rowsOf(plan) : []), [plan]);
  const removed = useMemo(() => {
    const out: CapRow[] = [];
    for (const [, list] of rows) for (const row of list) if (skip.includes(`capability:${row.capability}`)) out.push(row);
    return out;
  }, [rows, skip]);
  const requiredRemoved = removed.some((r) => r.required);

  function toggle(row: CapRow, on: boolean) {
    const selector = `capability:${row.capability}`;
    onSkip(on ? skip.filter((s) => s !== selector) : [...new Set([...skip, selector])]);
  }

  async function save(mode: "create" | "update") {
    setBusy(true);
    setFailure(null);
    try {
      const id = mode === "create" ? newId.trim() : profile.id;
      await api("POST", "/api/validations/profile", { mode, id, skip, ...(mode === "create" ? { from: profile.ref } : {}) });
      toast(t(mode === "create" ? "vch_saved_new" : "vch_saved_current", { id }), "ok");
      setNaming(false);
      setNewId("");
      onSaved(id);
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="card flat" data-testid="customize">
      <summary>
        <strong>{t("vch_customize_title")}</strong>
      </summary>
      <div className="stack" style={{ marginTop: 12 }}>
        <p className="muted">{t("vch_customize_lead", { profile: profile.label ?? profile.id })}</p>
        {base.loading ? <p className="spinner-text" role="status">{t("plan_building")}</p> : null}
        {base.error ? <ErrorNotice error={base.error} onRetry={base.reload} /> : null}
        {rows.map(([category, list]) => (
          <fieldset key={category ?? "none"} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>
              <strong>{catLabel(category)}</strong>
            </legend>
            <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0", display: "grid", gap: 6 }}>
              {list.map((row) => {
                const off = skip.includes(`capability:${row.capability}`);
                const checked = row.enabled && !off;
                return (
                  <li key={row.capability}>
                    <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                      <input type="checkbox" checked={checked} disabled={!row.enabled} onChange={(e) => toggle(row, e.target.checked)} />
                      <span>
                        {capLabel(row.capability)} <span className="muted small">({row.tools.join(", ")})</span>
                        {row.required ? <span className="small"> · {t("vrev_req_required")}</span> : null}
                        {!row.enabled ? <span className="muted small"> · {t("vch_outside_profile")}</span> : null}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        ))}
        {removed.length > 0 ? (
          <div className="notice warn" role="status" data-testid="reduced-warning">
            <Icon name="alert" />
            <div>
              <strong>{t("vch_reduced_title")}</strong>
              <div>{t(requiredRemoved ? "vch_reduced_required" : "vch_reduced_optional", { list: removed.map((r) => capLabel(r.capability)).join(", ") })}</div>
              <div className="muted small">{t("vch_reduced_scope")}</div>
            </div>
          </div>
        ) : (
          <p className="muted small">{t("vch_customize_nothing")}</p>
        )}
        {failure ? <ErrorNotice error={failure} /> : null}
        <div className="row wrap">
          {naming ? (
            <>
              <label className="row" style={{ gap: 6 }}>
                <span>{t("vch_new_profile_id")}</span>
                <input value={newId} onChange={(e) => setNewId(e.target.value)} pattern="[a-z0-9][a-z0-9._-]*" aria-describedby="vch-id-help" />
              </label>
              <button type="button" className="btn primary" disabled={busy || newId.trim() === ""} onClick={() => save("create")}>
                {t("vch_save_create")}
              </button>
              <button type="button" className="btn" onClick={() => setNaming(false)}>
                {t("vch_cancel")}
              </button>
              <span id="vch-id-help" className="muted small">
                {t("vch_new_profile_help")}
              </span>
            </>
          ) : (
            <>
              <button type="button" className="btn" disabled={skip.length === 0 || busy} onClick={() => setNaming(true)}>
                {t("vch_save_as_profile")}
              </button>
              <button type="button" className="btn" disabled={skip.length === 0 || busy || profile.origin !== "project"} onClick={() => save("update")}>
                {t("vch_save_in_current")}
              </button>
              {profile.origin !== "project" && skip.length > 0 ? <span className="muted small">{t("vch_builtin_note")}</span> : null}
            </>
          )}
        </div>
      </div>
    </details>
  );
}

export default function ChooseScreen() {
  const { info } = useShell();
  const [request, setRequest] = useState<ValidationRequest>(() => readRequest());
  const [version, setVersion] = useState(0);
  const data = useAsync(() => api("GET", "/api/validations/choose"), `choose:${version}`);
  const choose = data.data as any;
  // A starter profile the project already redefines (init writes them to profiles.yml) is shown once, as the project's.
  const all: any[] = choose?.profiles ?? [];
  const profiles = all.filter((p) => p.origin === "project" || !all.some((q) => q.origin === "project" && q.id === p.id));
  const selectedId = request.profile ?? choose?.default ?? null;
  const selected = profiles.find((p) => p.ref === selectedId || p.id === selectedId) ?? null;

  useEffect(() => {
    if (choose && request.profile === null && choose.default) setRequest((r) => ({ ...r, profile: choose.default }));
  }, [choose, request.profile]);

  const set = (patch: Partial<ValidationRequest>) => setRequest((r) => ({ ...r, ...patch }));
  const git = info?.git ?? null;

  function review() {
    writeRequest(request);
    navigate("/validations/review");
  }

  return (
    <div className="stack">
      <div>
        <h1>{t("vch_title")}</h1>
        <p>{t("vch_lead")}</p>
      </div>
      {data.loading ? <Loading /> : null}
      {data.error ? <ErrorNotice error={data.error} onRetry={data.reload} /> : null}

      <section className="card flat stack" aria-labelledby="vch-workspace">
        <h2 id="vch-workspace">{t("vch_workspace_title")}</h2>
        <dl className="kv">
          <dt>{t("vch_workspace_path")}</dt>
          <dd>{info?.workspace.path ?? "-"}</dd>
          <dt>{t("vch_workspace_branch")}</dt>
          <dd>{git ? (git.detached ? t("vch_detached") : (git.branch ?? "-")) : t("vch_no_git")}</dd>
          <dt>{t("vch_workspace_commit")}</dt>
          <dd>{git?.commit ? git.commit.slice(0, 12) : "-"}</dd>
        </dl>
        {git?.dirty ? (
          <div className="notice warn" role="status" data-testid="dirty-warning">
            <Icon name="alert" />
            <span>{t("vch_dirty")}</span>
          </div>
        ) : null}
      </section>

      <section className="card flat stack" aria-labelledby="vch-target">
        <h2 id="vch-target">{t("vch_target_title")}</h2>
        <div role="radiogroup" aria-labelledby="vch-target" className="stack" style={{ gap: 8 }}>
          {TARGETS.map((target) => (
            <label key={target} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
              <input type="radio" name="vch-target" value={target} checked={request.target === target} onChange={() => set({ target })} />
              <span>
                <strong>{t(`vch_target_${target}`)}</strong>
                <span className="muted small"> · {t(`vch_target_${target}_hint`)}</span>
              </span>
            </label>
          ))}
        </div>
        {request.target === "paths" ? (
          <label className="stack" style={{ gap: 4 }}>
            <span>{t("vch_field_path")}</span>
            <input value={request.path} onChange={(e) => set({ path: e.target.value })} placeholder="src" />
          </label>
        ) : null}
        {request.target === "commit" ? (
          <label className="stack" style={{ gap: 4 }}>
            <span>{t("vch_field_commit")}</span>
            <input value={request.head} onChange={(e) => set({ head: e.target.value })} placeholder="HEAD~1" />
          </label>
        ) : null}
        {request.target === "compare" ? (
          <div className="stack" style={{ gap: 8 }}>
            <label className="stack" style={{ gap: 4 }}>
              <span>{t("vch_field_base")}</span>
              <input value={request.base} onChange={(e) => set({ base: e.target.value })} placeholder="main" />
            </label>
            <label className="stack" style={{ gap: 4 }}>
              <span>{t("vch_field_head")}</span>
              <input value={request.head} onChange={(e) => set({ head: e.target.value })} placeholder="HEAD" />
            </label>
            <p className="muted small">{t("vch_compare_note")}</p>
          </div>
        ) : null}
      </section>

      <section className="stack" aria-labelledby="vch-profiles">
        <h2 id="vch-profiles">{t("vch_profiles_title")}</h2>
        <ul className="grid" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }} data-testid="profile-cards">
          {profiles.map((p) => {
            const active = selected?.ref === p.ref;
            return (
              <li key={p.ref}>
                <label className="card flat stack" style={{ height: "100%", cursor: "pointer", borderColor: active ? "var(--accent)" : undefined }} data-profile={p.id}>
                  <span className="row">
                    <input type="radio" name="vch-profile" value={p.id} checked={active} onChange={() => set({ profile: p.ref, skip: [] })} />
                    <strong>{p.label ?? p.id}</strong>
                    {p.isDefault ? <Pill tone="green">{t("vch_default")}</Pill> : null}
                  </span>
                  <span className="muted small">{p.description ?? t("vch_profile_no_description")}</span>
                  <span className="muted small">
                    {p.id}
                    {p.extends ? ` · ${t("vch_extends", { base: p.extends })}` : ""}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </section>

      {choose ? (
        <section className="card flat stack" aria-labelledby="vch-criteria" data-testid="criteria">
          <div className="between wrap">
            <h2 id="vch-criteria">{t("vch_criteria_title")}</h2>
            <a href="#/config">{t("vch_criteria_adjust")}</a>
          </div>
          {choose.criteria.present ? (
            <>
              <p>{t("vch_criteria_summary", { rules: choose.criteria.rules.length, evidence: choose.criteria.requiredEvidence, exceptions: choose.criteria.exceptions })}</p>
              {choose.criteria.rules.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {(choose.criteria.rules as any[]).map((r) => (
                    <li key={r.rule}>
                      <code>{r.rule}</code>
                      {r.threshold !== null ? ` · ${t("vch_criteria_threshold", { value: r.threshold })}` : ""}
                      {r.severity ? ` · ${t("vch_criteria_severity", { value: r.severity })}` : ""}
                      {r.locked ? ` · ${t("vch_criteria_locked")}` : ""}
                      {!r.enabled ? ` · ${t("vch_criteria_off")}` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p>{t("vch_criteria_default")}</p>
          )}
        </section>
      ) : null}

      {selected ? <Customize key={selected.ref} profile={selected} skip={request.skip} onSkip={(skip) => set({ skip })} onSaved={(id) => { setVersion((n) => n + 1); set({ skip: [], ...(id ? { profile: id } : {}) }); }} /> : null}

      <div className="row wrap">
        <button type="button" className="btn primary" onClick={review} disabled={!selected}>
          <Icon name="plan" />
          {t("vch_review")}
        </button>
        {request.skip.length > 0 ? <span className="muted small">{t("vch_skip_count", { count: request.skip.length })}</span> : null}
      </div>
    </div>
  );
}
