// Every capability of the catalog with its state in this project, for the screens where a profile is picked or reviewed
// (Revisar, Escolher, Configuração > Perfil): it will run (with which tools), it does not apply here (the plain reason
// and the one action that would enable it, or "no tool for this stack yet"), it has no check and blocks, or it is off
// (in the profile file, in a starter profile, or only for this run). Nothing of the catalog is left out silently.
import { useState, type ReactNode } from "react";
import { api } from "../../api";
import { ErrorNotice, Pill, Spinner } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { adapterName, t, tOr } from "../../i18n";
import "./capability-states.css";

export type CapStateKind = "run" | "blocked" | "na" | "off";

/** Where an "off" came from: the project's profile file, a starter profile, this run only, the policy, or nobody. */
export type OffOrigin = "file" | "starter" | "run" | "policy" | "none";

export interface CapState {
  id: string;
  selector: string;
  label: string;
  description: string;
  category: string;
  kind: CapStateKind;
  /** On "when available" in the profile (null: required when on). */
  when: string | null;
  /** Labels of the checks that run it (kind run). */
  tools: string[];
  /** Labels of those checks whose tool cannot run here. */
  unavailable: string[];
  /** groups.notApplicableRequirements entry (kind na). */
  na: any | null;
  /** groups.uncoveredRequirements entry (kind blocked). */
  uncovered: any | null;
  off: { by: OffOrigin; file: string | null; source: string | null } | null;
}

export interface CatalogCapability {
  id: string;
  label: string;
  description?: string;
  category: string;
  enabled?: boolean;
  when?: string | null;
  decision?: { layer: string; source: string; file: string | null; value?: unknown } | null;
}

export interface CapabilityCatalog {
  categories: Array<{ id: string; label: string }>;
  capabilities: CatalogCapability[];
}

const capKey = (cap: string) => `vrev_cap_${cap.replace(/[^a-z0-9]+/gi, "_")}`;
const isBuiltin = (file: string | null | undefined) => typeof file === "string" && file.startsWith("builtin:");

function offOf(cap: CatalogCapability | undefined, runOff: boolean): CapState["off"] {
  const d = cap?.decision ?? null;
  if (runOff || d?.layer === "call") return { by: "run", file: null, source: d?.source ?? null };
  if (!d) return { by: "none", file: null, source: null };
  if (d.layer === "policy") return { by: "policy", file: d.file, source: d.source };
  if (isBuiltin(d.file)) return { by: "starter", file: d.file, source: d.source };
  return { by: "file", file: d.file, source: d.source };
}

/**
 * The state of every capability: the catalog's (review.catalog, or the categories of the config view) and any other the
 * plan names. Order: categories of the catalog, capabilities in catalog order.
 */
export function capabilityStates(plan: any, catalog: CapabilityCatalog | null): Array<{ id: string; label: string; items: CapState[] }> {
  const groups = plan?.groups ?? {};
  const willRun: any[] = groups.willRun ?? [];
  const na: any[] = groups.notApplicableRequirements ?? [];
  const uncovered: any[] = groups.uncoveredRequirements ?? [];
  const skipped = new Set<string>(((plan?.selection?.overrides ?? []) as any[]).filter((o) => o.source === "--skip" && o.selector).map((o) => String(o.selector)));
  const caps: CatalogCapability[] = [...(catalog?.capabilities ?? [])];
  const known = new Set(caps.map((c) => c.id));
  // Capabilities the plan names that the catalog does not (an extension's): listed too, never dropped.
  const extra = (id: string, category: string | null, label?: string) => {
    if (known.has(id) || id === "") return;
    known.add(id);
    caps.push({ id, label: label ?? tOr(capKey(id), id), category: category ?? "custom" });
  };
  for (const item of willRun) for (const c of (item.capabilities ?? []) as string[]) extra(c, item.category ?? null);
  for (const r of [...na, ...uncovered]) if (String(r.selector).startsWith("capability:")) extra(String(r.selector).slice(11), r.category ?? null, r.label);

  const states: CapState[] = caps.map((cap) => {
    const selector = `capability:${cap.id}`;
    const running = willRun.filter((i) => (i.capabilities ?? []).includes(cap.id));
    const base = {
      id: cap.id,
      selector,
      label: tOr(capKey(cap.id), cap.label),
      description: cap.description ?? "",
      category: cap.category,
      when: (cap.when ?? null) as string | null,
      tools: [...new Set(running.map((i) => String(i.label ?? i.tool)))],
      unavailable: [...new Set(running.filter((i) => i.availability && i.availability.status !== "available").map((i) => String(i.label ?? i.tool)))],
      na: null,
      uncovered: null,
      off: null,
    };
    if (running.length > 0) return { ...base, kind: "run" as const };
    const blocked = uncovered.find((r) => r.selector === selector);
    if (blocked) return { ...base, kind: "blocked" as const, uncovered: blocked };
    const notApplicable = na.find((r) => r.selector === selector);
    if (notApplicable) return { ...base, kind: "na" as const, na: notApplicable, when: notApplicable.when ?? base.when };
    return { ...base, kind: "off" as const, off: offOf(cap, skipped.has(selector)) };
  });

  const categories = [...(catalog?.categories ?? [])];
  for (const s of states) if (!categories.some((c) => c.id === s.category)) categories.push({ id: s.category, label: tOr(`vrev_cat_${s.category}`, s.category) });
  return categories
    .map((c) => ({ id: c.id, label: tOr(`vrev_cat_${c.id}`, c.label), items: states.filter((s) => s.category === c.id) }))
    .filter((g) => g.items.length > 0);
}

/** "11 vão rodar · 16 não se aplicam aqui · 1 desligada", with the singular where the count is one. */
export function summaryText(counts: Record<CapStateKind, number>): string {
  const part = (key: string, n: number) => t(n === 1 ? `${key}_one` : key, { count: n });
  const parts = [part("capst_sum_run", counts.run), part("capst_sum_na", counts.na), part("capst_sum_off", counts.off)];
  if (counts.blocked > 0) parts.push(part("capst_sum_blocked", counts.blocked));
  return parts.join(" · ");
}

/** How many capabilities are in each state, for the one-line summary. */
export function countStates(groups: Array<{ items: CapState[] }>): Record<CapStateKind, number> {
  const out: Record<CapStateKind, number> = { run: 0, blocked: 0, na: 0, off: 0 };
  for (const g of groups) for (const s of g.items) out[s.kind] += 1;
  return out;
}

// ---- the plain reason of a "not applicable here" ---------------------------------------------------------------------

/** Readable names of the settings a tool is missing (T02b: action.settings); unknown ones show as they are. */
const settingLabel = (name: string) => {
  const label = tOr(`capst_setting_${name.replace(/[^a-z0-9]+/gi, "_")}`, "");
  return label ? `${label} (${name})` : name;
};
const settingsOf = (action: any): string[] => (Array.isArray(action?.settings) ? action.settings : Array.isArray(action?.missing) ? action.missing : []).map(String);
const langLabel = (id: string) => tOr(`capst_lang_${id.replace(/[^a-z0-9]+/gi, "_")}`, id);
/** Readable name of an adapter in the current language (the manifest name is English); unknown ones as they are. */
const adapterLabel = adapterName;

const toolsOf = (action: any, fallback: string): string => ((action?.tools ?? []) as string[]).join(", ") || fallback;

export function naReason(na: any): string {
  const action = na.action ?? {};
  const adapters: any[] = na.adapters ?? [];
  const adapter = adapters.find((a) => a.id === action.adapter) ?? adapters.find((a) => a.applicable) ?? adapters[0];
  const tool = adapterLabel(adapter?.id ?? action.adapter, adapter?.label ?? action.adapter ?? "");
  const languages = ((na.languages ?? []) as string[]).map(langLabel).join(", ") || t("capst_no_language");
  switch (na.reasonCode) {
    case "NO_TOOL":
      return t("capst_reason_no_tool");
    case "NO_TOOL_FOR_LANGUAGES":
      return t("capst_reason_no_tool_for_languages", {
        languages,
        tools: adapters.map((a) => `${adapterLabel(a.id, a.label)} (${(a.languages ?? []).map(langLabel).join(", ")})`).join("; "),
      });
    case "TOOL_MISSING":
      return t("capst_reason_tool_missing", { tool: (action.tools ?? []).join(", ") || tool });
    case "CUSTOMER_SUPPLIED":
    case "SERVICES_REQUIRED":
      // The shared catalogue's sentence, already in the language of the plan.
      return String(na.message ?? t(na.reasonCode === "CUSTOMER_SUPPLIED" ? "capst_reason_customer_supplied" : "capst_reason_services_required", { tool: toolsOf(action, tool) }));
    case "CHECKS_DISABLED":
      return t("capst_reason_checks_disabled", { tools: (na.candidates ?? []).join(", ") || tool });
    case "DISABLED_FOR_RUN":
      return t("capst_reason_disabled_for_run");
    case "EVIDENCE_MISSING":
      return t("capst_reason_evidence_missing");
    default: {
      // SETUP_REQUIRED: what is missing depends on the action.
      if (action.kind === "add-files") return t("capst_reason_add_files", { tool, files: (action.files ?? []).slice(0, 4).join(", ") });
      if (action.kind === "add-template") return t("capst_reason_add_template", { tool });
      const settings = settingsOf(action);
      if (settings.length > 0) return t("capst_reason_settings", { tool, settings: settings.map(settingLabel).join(", ") });
      return t("capst_reason_configure", { tool });
    }
  }
}

// ---- the one action ----------------------------------------------------------------------------------------------

export interface StateContext {
  /** The project profile the states belong to; null when it is a starter profile (not editable here). */
  profile: string | null;
  /** Rebuilds what the screen shows after a saved change. */
  onChanged: () => void;
  /** Takes selectors out of this run's switch-offs (Revisar, Escolher); absent where there is no run. */
  onIncludeRun?: (selectors: string[]) => void;
}

/** Adds a built-in template to jgates.yml (or turns its entry on) through the templates route, with the revision read. */
async function activateTemplate(template: string): Promise<string> {
  const view = await api<any>("GET", "/api/config/templates");
  const bare = template.replace(/^builtin:/, "");
  const row = ((view.templates ?? []) as any[]).find((r) => r.source === template) ?? ((view.templates ?? []) as any[]).find((r) => r.id === bare);
  if (!row) throw new Error(t("capst_template_unknown", { template }));
  await api("PUT", `/api/config/templates/${encodeURIComponent(row.id)}/enabled`, { enabled: true, expectedRevision: view.revision });
  return String(row.label ?? row.id);
}

async function enableInProfile(profile: string, changes: Array<{ selector: string; enabled: boolean; when?: "available" | null }>): Promise<void> {
  await api("PUT", "/api/config/selection", { profile, changes });
}

function useRunner(ctx: StateContext) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      toast(await work(), "ok");
      ctx.onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function ProfileOnly({ ctx }: { ctx: StateContext }) {
  return ctx.profile ? null : (
    <a className="small" href="#/config">
      {t("capst_need_project_profile")}
    </a>
  );
}

interface PrerequisiteItem {
  id: string;
  kind: string;
  names: string[];
  commands: string[];
  action: "run" | "copy" | null;
  hosts: string[];
  message: string | null;
  fix: string | null;
}

type PrepareStep =
  | { step: "idle" }
  | { step: "checking" }
  | { step: "confirm"; item: PrerequisiteItem }
  | { step: "running"; item: PrerequisiteItem }
  | { step: "manual"; item: PrerequisiteItem | null }
  | { step: "result"; status: "done" | "failed" | "skipped" | "ready"; message: string | null };

/**
 * "Preparar <tool>" for a tool that is not installed: finds the item of the prerequisites list that installs it, shows
 * the commands and the network it reaches, runs it after the person confirms (POST /api/prerequisites/fix), shows the
 * result here and builds the plan again. A tool JGates cannot install by itself (a download it does not do, a
 * platform the tool does not support) is said plainly, with the install link. "Ver detalhes" opens the environment.
 */
export function PrepareAction({ label, tools, toolName, docs, ctx, image = false }: { label: string; tools: string[]; toolName: string; docs: string | null; ctx: StateContext; image?: boolean }) {
  const [state, setState] = useState<PrepareStep>({ step: "idle" });
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const text = t("capst_prepare", { tool: toolName });
  const busy = state.step === "checking" || state.step === "running";

  async function check() {
    setError(null);
    setState({ step: "checking" });
    try {
      const report = await api<{ items: PrerequisiteItem[] }>("GET", "/api/prerequisites");
      // A tool the tools image lacks is prepared by the image itself (the download of this version), never per tool.
      const mine = (report.items ?? []).filter((i) => (image && i.kind === "image-pull") || i.names.some((n) => tools.includes(n)));
      const runnable = mine.find((i) => i.action === "run");
      if (runnable) setState({ step: "confirm", item: runnable });
      else if (mine.length > 0) setState({ step: "manual", item: mine[0] as PrerequisiteItem });
      else if (tools.length > 0) {
        // Nothing missing any more (installed meanwhile): the plan only has to be built again.
        setState({ step: "result", status: "ready", message: null });
        ctx.onChanged();
      } else setState({ step: "manual", item: null });
    } catch (e) {
      setError(e);
      setState({ step: "idle" });
    }
  }

  async function run(item: PrerequisiteItem) {
    setError(null);
    setState({ step: "running", item });
    try {
      const r = await api<{ outcome: { status: "done" | "failed" | "skipped"; message: string | null } }>("POST", "/api/prerequisites/fix", { id: item.id });
      setState({ step: "result", status: r.outcome.status, message: r.outcome.message });
      if (r.outcome.status === "done") {
        toast(t("capst_prepare_done", { tool: toolName }), "ok");
        ctx.onChanged();
      }
    } catch (e) {
      setError(e);
      setState({ step: "confirm", item });
    }
  }

  const details = (
    <a className="small" href="#/environment" aria-label={`${t("capst_prepare_details")}: ${label}`}>
      {t("capst_prepare_details")}
    </a>
  );
  const install = docs ? (
    <a className="small" href={docs} target="_blank" rel="noopener noreferrer" aria-label={`${t("capst_prepare_install")}: ${label}`}>
      {t("capst_prepare_install")}
    </a>
  ) : null;

  return (
    <div className="stack tight capst-prepare" data-testid="prepare-action" data-step={state.step}>
      <div className="row wrap">
        {state.step === "idle" || state.step === "checking" ? (
          <button type="button" className="btn capst-btn" aria-label={`${text}: ${label}`} disabled={busy} onClick={check}>
            {state.step === "checking" ? <Spinner /> : <Icon name="tools" />}
            {text}
          </button>
        ) : null}
        {details}
        {install}
      </div>
      {state.step === "checking" ? (
        <p className="small muted" role="status">
          {t("capst_prepare_checking")}
        </p>
      ) : null}
      {state.step === "confirm" || state.step === "running" ? (
        <div className="notice capst-prepare-box" role="group" aria-label={text}>
          <div className="stack tight grow">
            <p className="small">{t("capst_prepare_will_run", { tools: state.item.names.join(", ") })}</p>
            {state.item.commands.length > 0 ? <pre className="capst-commands">{state.item.commands.join("\n")}</pre> : null}
            {state.item.hosts.length > 0 ? <p className="small muted">{t("capst_prepare_hosts", { hosts: state.item.hosts.join(", ") })}</p> : null}
            {state.step === "running" ? (
              <p className="small" role="status">
                <Spinner /> {t("capst_prepare_running", { tool: toolName })}
              </p>
            ) : (
              <div className="row wrap">
                <button type="button" className="btn primary capst-btn" aria-label={`${t("capst_prepare_confirm")}: ${label}`} onClick={() => run(state.item)}>
                  <Icon name="check" />
                  {t("capst_prepare_confirm")}
                </button>
                <button type="button" className="btn capst-btn" onClick={() => setState({ step: "idle" })}>
                  {t("capst_prepare_cancel")}
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}
      {state.step === "manual" ? (
        <div className="notice warn" role="status" data-testid="prepare-manual">
          <Icon name="alert" />
          <div className="stack tight grow">
            <p className="small">{t("capst_prepare_manual", { tool: toolName })}</p>
            {state.item?.message ? <p className="small">{state.item.message}</p> : null}
            {state.item?.action === "copy" && state.item.commands.length > 0 ? (
              <>
                <p className="small">{t("capst_prepare_copy")}</p>
                <pre className="capst-commands">{state.item.commands.join("\n")}</pre>
              </>
            ) : state.item?.fix ? (
              <p className="small">{state.item.fix}</p>
            ) : null}
            {install ? <p className="small">{t("capst_prepare_manual_link")}</p> : null}
          </div>
        </div>
      ) : null}
      {state.step === "result" ? (
        <div className={`notice ${state.status === "done" || state.status === "ready" ? "ok" : "warn"}`} role="status" data-testid="prepare-result" data-status={state.status}>
          <Icon name={state.status === "done" || state.status === "ready" ? "check" : "alert"} />
          <div className="stack tight grow">
            <p className="small">{t(`capst_prepare_result_${state.status}`, { tool: toolName })}</p>
            {state.message ? <p className="small">{state.message}</p> : null}
            {state.status === "failed" || state.status === "skipped" ? (
              <div>
                <button type="button" className="btn capst-btn" onClick={check}>
                  {t("capst_prepare_retry")}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
    </div>
  );
}

/** The action of a "not applicable here": one control or link, or the plain sentence that no tool exists. */
export function NaAction({ state, ctx }: { state: CapState; ctx: StateContext }) {
  const { busy, error, run } = useRunner(ctx);
  const na = state.na;
  const action = na.action ?? { kind: "none" };
  const tools: string[] = action.tools ?? [];
  const adapter = ((na.adapters ?? []) as any[]).find((a) => a.id === action.adapter);
  const toolName = adapterLabel(adapter?.id ?? action.adapter, adapter?.label ?? action.adapter ?? "");
  let control: ReactNode = null;

  // Several rows carry the same button text: the accessible name starts with it and names the capability.
  const named = (text: string) => ({ "aria-label": `${text}: ${state.label}` });
  // A template not yet in jgates.yml comes first (it declares the instance); what is left is shown by the next plan.
  const templatePending = Boolean(action.template) && action.templateState !== "active" && ["add-template", "add-files", "configure-tool"].includes(action.kind);
  let hint: string | null = null;

  if (na.reasonCode === "DISABLED_FOR_RUN" && ctx.onIncludeRun) {
    control = (
      <button type="button" className="btn capst-btn" {...named(t("capst_include_run"))} onClick={() => ctx.onIncludeRun?.([state.selector, ...tools.map((x) => `tool:${x}`), ...((na.candidates ?? []) as string[]).map((x) => `tool:${String(x).split("#")[0]}`)])}>
        {t("capst_include_run")}
      </button>
    );
  } else if (action.kind === "enable-check" || na.reasonCode === "CHECKS_DISABLED") {
    const selectors = tools.length > 0 ? tools.map((x) => `tool:${x}`) : [state.selector];
    control = ctx.profile ? (
      <button type="button" className="btn capst-btn" {...named(t("capst_enable_checks"))} disabled={busy} onClick={() => run(async () => (await enableInProfile(ctx.profile as string, selectors.map((selector) => ({ selector, enabled: true }))), t("capst_enabled_checks", { profile: ctx.profile as string })))}>
        {busy ? <Spinner /> : null}
        {t("capst_enable_checks")}
      </button>
    ) : (
      <ProfileOnly ctx={ctx} />
    );
  } else if (templatePending) {
    const text = t(action.kind === "add-template" ? "capst_activate" : "capst_activate_template");
    control = (
      <button type="button" className="btn capst-btn" {...named(text)} disabled={busy} onClick={() => run(async () => t("capst_template_added", { template: await activateTemplate(String(action.template)) }))}>
        {busy ? <Spinner /> : null}
        {text}
      </button>
    );
    if (action.kind === "add-files") hint = t("capst_files_hint");
    if (action.kind === "configure-tool" && settingsOf(action).length > 0) hint = t("capst_settings_hint", { settings: settingsOf(action).map(settingLabel).join(", ") });
  } else if (action.kind === "configure-tool") {
    // The settings the check still needs travel in the link, so the options form focuses and highlights them.
    const focus = settingsOf(action).length > 0 ? `focus=${encodeURIComponent(settingsOf(action).join(","))}` : "";
    const href = tools.length > 0 ? `#/tools/${encodeURIComponent(tools[0] as string)}${focus ? `?${focus}` : ""}` : `#/tools?add=${encodeURIComponent(String(action.adapter ?? ""))}${focus ? `&${focus}` : ""}`;
    const text = t(tools.length > 0 ? "capst_configure" : "capst_add_tool", { tool: toolName });
    control = (
      <a className="btn capst-btn" href={href} {...named(text)}>
        <Icon name="tools" />
        {text}
      </a>
    );
    if (tools.length === 0 && settingsOf(action).length > 0) hint = t("capst_settings_hint", { settings: settingsOf(action).map(settingLabel).join(", ") });
    // Configure first; the tool is also missing here, so it is prepared next (its own action appears then).
    if (tools.length > 0 && action.prepareNext === true) hint = t("capst_prepare_next", { tool: toolName });
  } else if (action.kind === "prepare-codeql") {
    // CodeQL is supplied by the person: the terms and the explicit acceptance are in Ambiente, which prepares it.
    const text = String(action.label || t("capst_codeql_prepare"));
    control = (
      <a className="btn capst-btn" href="#/environment" {...named(text)} data-testid="codeql-action">
        <Icon name="tools" />
        {text}
      </a>
    );
    hint = t("capst_codeql_hint");
  } else if (action.kind === "configure-services") {
    const text = String(action.label || t("capst_services_configure"));
    control = (
      <a className="btn capst-btn" href={`#/${String(action.route ?? "environment").replace(/^\/+/, "")}`} {...named(text)} data-testid="services-action">
        <Icon name="tools" />
        {text}
      </a>
    );
    hint = t("capst_services_hint");
  } else if (action.kind === "add-extension-tool") {
    const text = String(action.label || t("capst_extension_add"));
    control = (
      <a className="btn capst-btn" href={`#/${String(action.route ?? "tools").replace(/^\/+/, "")}`} {...named(text)} data-testid="extension-action">
        <Icon name="tools" />
        {text}
      </a>
    );
  } else if (action.kind === "prepare-tool" || action.kind === "prepare-image") {
    const docsLink = ((action.docs ?? []) as string[]).find((d) => /^https?:\/\//.test(d)) ?? null;
    return (
      <div className="capst-action" data-action={action.kind}>
        <PrepareAction label={state.label} tools={tools} toolName={tools.join(", ") || toolName} docs={docsLink} ctx={ctx} image={action.kind === "prepare-image"} />
      </div>
    );
  }

  const docs: string[] = (action.docs ?? []).filter((d: string) => /^https?:\/\//.test(d));
  if (!control && !docs[0] && !error) return null;
  return (
    <div className="capst-action" data-action={action.kind}>
      {control}
      {hint ? <span className="small muted">{hint}</span> : null}
      {docs[0] ? (
        <a className="small" href={docs[0]} target="_blank" rel="noopener noreferrer" {...named(t("capst_docs"))}>
          {t("capst_docs")}
        </a>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
    </div>
  );
}

/** Turn on, in the profile, a capability the profile file switched off (Revisar, Escolher); on "when available". */
function OffAction({ state, ctx }: { state: CapState; ctx: StateContext }) {
  const { busy, error, run } = useRunner(ctx);
  const off = state.off;
  if (!off) return null;
  if (off.by === "run") {
    return ctx.onIncludeRun ? (
      <div className="capst-action">
        <button type="button" className="btn capst-btn" aria-label={`${t("capst_include_run")}: ${state.label}`} onClick={() => ctx.onIncludeRun?.([state.selector])}>
          {t("capst_include_run")}
        </button>
      </div>
    ) : null;
  }
  if (off.by === "policy") return null;
  if (!ctx.profile) {
    return (
      <div className="capst-action">
        <ProfileOnly ctx={ctx} />
      </div>
    );
  }
  return (
    <div className="capst-action">
      <button
        type="button"
        className="btn capst-btn"
        aria-label={`${t("capst_turn_on")}: ${state.label}`}
        disabled={busy}
        onClick={() => run(async () => (await enableInProfile(ctx.profile as string, [{ selector: state.selector, enabled: true, when: "available" }]), t("capst_turned_on", { name: state.label, profile: ctx.profile as string })))}
      >
        {busy ? <Spinner /> : null}
        {t("capst_turn_on")}
      </button>
      <span className="small muted">{t("capst_turn_on_note")}</span>
      {error ? <ErrorNotice error={error} /> : null}
    </div>
  );
}

/** The state pill and the one-line detail of a capability (shared by every screen). */
export function StateLine({ state }: { state: CapState }) {
  switch (state.kind) {
    case "run":
      return (
        <>
          <Pill tone={state.unavailable.length > 0 ? "gold" : "green"}>{t(state.unavailable.length > 0 ? "capst_state_run_missing" : "capst_state_run")}</Pill>
          <span className="small capst-detail">
            {t("capst_run_with", { tools: state.tools.join(", ") })}
            {state.unavailable.length > 0 ? ` · ${t("capst_run_unavailable", { tools: state.unavailable.join(", ") })}` : ""}
          </span>
        </>
      );
    case "blocked":
      return (
        <>
          <Pill tone="red">{t("capst_state_blocked")}</Pill>
          <span className="small capst-detail">{t("capst_blocked_detail")}</span>
        </>
      );
    case "na":
      return (
        <>
          <Pill>{t("capst_state_na")}</Pill>
          <span className="small capst-detail">{naReason(state.na)}</span>
        </>
      );
    default: {
      const off = state.off ?? { by: "none" as const, file: null, source: null };
      return (
        <>
          <Pill>{t("capst_state_off")}</Pill>
          <span className="small capst-detail muted">{t(`capst_off_${off.by}`, { file: off.file ?? "", source: off.source ?? "" })}</span>
        </>
      );
    }
  }
}

/** The English prerequisites of the adapters (manifest text), as a secondary detail. */
export function Details({ na }: { na: any }) {
  const adapters: any[] = (na.adapters ?? []).filter((a: any) => (a.prerequisites ?? []).length > 0);
  // Without adapters (no tool at all) the reason line already says everything.
  if (adapters.length === 0) return null;
  return (
    <details className="capst-more">
      <summary className="small" aria-label={`${t("capst_details")}: ${String(na.label ?? na.selector)}`}>
        {t("capst_details")}
      </summary>
      {na.message ? <p className="small muted">{na.message}</p> : null}
      {adapters.length > 0 ? (
        <ul className="small">
          {adapters.map((a) => (
            <li key={a.id}>
              <strong>{adapterLabel(a.id, a.label)}</strong>
              {a.applicable === false ? <span className="muted"> · {t("capst_not_for_project")}</span> : null}
              <span className="muted"> · {t("capst_prereq_label")} </span>
              <span lang="en">{(a.prerequisites as string[]).join("; ")}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

/** One capability: name, state, plain reason or tools, and the action (when the screen allows changes). */
export function CapabilityRow({ state, ctx }: { state: CapState; ctx: StateContext | null }) {
  return (
    <li className={`capst-row capst-${state.kind}`} data-testid="capability-state" data-capability={state.id} data-state={state.kind}>
      <div className="capst-main">
        <strong className="capst-name">{state.label}</strong>
        <StateLine state={state} />
      </div>
      {state.kind === "blocked" && state.uncovered?.message ? <p className="small capst-sub">{state.uncovered.message}</p> : null}
      {state.kind === "blocked" && state.uncovered?.reason === "DISABLED_FOR_RUN" && ctx?.onIncludeRun ? (
        <div className="capst-action">
          <button
            type="button"
            className="btn capst-btn"
            aria-label={`${t("capst_include_run")}: ${state.label}`}
            onClick={() => ctx.onIncludeRun?.([state.selector, ...((state.uncovered.candidates ?? []) as string[]).map((x) => `tool:${String(x).split("#")[0]}`)])}
          >
            {t("capst_include_run")}
          </button>
        </div>
      ) : null}
      {state.kind === "na" ? (
        <>
          {ctx ? <NaAction state={state} ctx={ctx} /> : null}
          <Details na={state.na} />
        </>
      ) : null}
      {state.kind === "off" && ctx ? <OffAction state={state} ctx={ctx} /> : null}
    </li>
  );
}

/** Every capability, grouped by category, with a summary line; the categories open and close. */
export function CapabilityStates({ groups, ctx, title, lead, headingId }: { groups: Array<{ id: string; label: string; items: CapState[] }>; ctx: StateContext | null; title: string; lead?: string; headingId: string }) {
  const counts = countStates(groups);
  return (
    <section className="card flat stack capst" aria-labelledby={headingId} data-testid="capability-states">
      <div>
        <h2 id={headingId}>{title}</h2>
        {lead ? <p className="muted small">{lead}</p> : null}
        <p className="small" data-testid="capability-summary">
          {summaryText(counts)}
        </p>
      </div>
      {groups.map((g) => {
        const c = countStates([g]);
        return (
          <details key={g.id} className="capst-group" data-category={g.id} open>
            <summary>
              <strong>{g.label}</strong>
              <span className="small muted"> · {t("capst_group_summary", { run: c.run, total: g.items.length })}</span>
            </summary>
            <ul className="capst-list" aria-label={g.label}>
              {g.items.map((s) => (
                <CapabilityRow key={s.id} state={s} ctx={ctx} />
              ))}
            </ul>
          </details>
        );
      })}
    </section>
  );
}
