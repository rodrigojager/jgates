import { useMemo, useState } from "react";
import { Details, NaAction, StateLine, capabilityStates, summaryText, type CapState, type CapabilityCatalog, type StateContext } from "../validations-review/capability-states";
import { api } from "../../api";
import { ErrorNotice, Pill } from "../../components/common";
import { Icon } from "../../components/icons";
import { LockedField } from "../../components/LockedField";
import { OriginButton, OriginLine, type OriginRef, type SaveTarget } from "../../components/origin";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";
import { Switch } from "./switch";

interface Lock {
  selector: string;
  reason: string;
  file: string | null;
  path: string | null;
}

interface ItemBase {
  selector: string;
  enabled: boolean;
  reason: string;
  decision: (OriginRef & { value: unknown }) | null;
  locked: Lock[];
  saveTo: SaveTarget | null;
}

interface RuleView extends ItemBase {
  id: string;
  label: string;
}
interface ToolView extends ItemBase {
  id: string;
  label: string;
  alsoCapabilities: string[];
  rules: RuleView[];
}
interface CapabilityView extends ItemBase {
  id: string;
  label: string;
  description: string;
  /** "available": on only where a tool for it exists; null: on means required (or it is off). */
  when?: string | null;
  tools: ToolView[];
}
export interface CategoryView extends ItemBase {
  id: string;
  label: string;
  description: string;
  capabilities: CapabilityView[];
}

type Toggle = (changes: Array<{ selector: string; enabled: boolean; when?: "available" | null }>, note?: string) => void;

type Mode = "required" | "available" | "off";
const MODES: Mode[] = ["required", "available", "off"];
const modeOf = (c: CapabilityView): Mode => (!c.enabled ? "off" : c.when === "available" ? "available" : "required");

/**
 * A capability's three states in the profile, as one labelled select: required (without a tool here the validation
 * blocks), on where a tool exists (never blocks), or off. Below it, what the plan of this profile says about it here:
 * will run (with which tools), does not apply here (why, and the action that would enable it) or off and by whom.
 */
function CapabilityRow({ capability, state, ctx, editable, busy, onToggle, profile }: { capability: CapabilityView; state: CapState | undefined; ctx: StateContext; editable: boolean; busy: boolean; onToggle: Toggle; profile: string }) {
  const lock = capability.locked[0];
  const mode = modeOf(capability);
  const id = `cap-mode-${capability.id}`;
  const change = (next: Mode) => {
    if (next === "off") onToggle([{ selector: capability.selector, enabled: false }]);
    else onToggle([{ selector: capability.selector, enabled: true, when: next === "available" ? "available" : null }]);
  };
  return (
    <div className="check-row level-capability" data-selector={capability.selector} data-enabled={capability.enabled} data-mode={mode} data-locked={lock ? "true" : "false"}>
      <div className="check-main">
        {lock ? (
          <div className="grow" data-testid="locked-item">
            <LockedField label={capability.label} value={capability.enabled ? t("cfgp_locked_on") : t("cfgp_locked_off")} reason={t("cfgp_locked_reason", { reason: lock.reason, file: lock.file ?? t("origin_no_file") })} />
          </div>
        ) : (
          <div className="grow">
            <label htmlFor={id}>
              <strong>{capability.label}</strong>
            </label>
            {capability.description ? <p className="small muted">{capability.description}</p> : null}
          </div>
        )}
        <select
          id={id}
          className="input cap-mode"
          aria-label={capability.label}
          aria-describedby={`${id}-help`}
          value={mode}
          disabled={Boolean(lock) || !editable || busy}
          onChange={(e) => change(e.target.value as Mode)}
          data-testid="capability-mode"
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {t(`cfgp_mode_${m}`)}
            </option>
          ))}
        </select>
      </div>
      <p className="small muted cap-mode-help" id={`${id}-help`}>
        {t(`cfgp_mode_${mode}_help`)}
      </p>
      {state ? (
        <div className="cap-status" data-testid="capability-status" data-state={state.kind}>
          <StateLine state={state} />
        </div>
      ) : null}
      {state?.kind === "na" ? (
        <>
          <NaAction state={state} ctx={ctx} />
          <Details na={state.na} />
        </>
      ) : null}
      <OriginLine origin={capability.decision} saveTo={editable ? capability.saveTo : null} fallback={t(`cfgp_reason_${capability.reason}`)} />
      <OriginButton selector={capability.selector} profile={profile} label={capability.label} />
    </div>
  );
}

/** One check: its toggle (or the padlock with the reason when the policy locks it), the origin and "why is this on?". */
function CheckRow({ label, description, item, profile, editable, busy, onToggle, level }: { label: string; description?: string; item: ItemBase; profile: string; editable: boolean; busy: boolean; onToggle: Toggle; level: "capability" | "tool" | "rule" }) {
  const lock = item.locked[0];
  return (
    <div className={`check-row level-${level}`} data-selector={item.selector} data-enabled={item.enabled} data-locked={lock ? "true" : "false"}>
      <div className="check-main">
        {lock ? (
          <div className="grow" data-testid="locked-item">
            <LockedField
              label={label}
              value={item.enabled ? t("cfgp_locked_on") : t("cfgp_locked_off")}
              reason={t("cfgp_locked_reason", { reason: lock.reason, file: lock.file ?? t("origin_no_file") })}
            />
          </div>
        ) : (
          <div className="grow">
            <strong>{label}</strong>
            {description ? <p className="small muted">{description}</p> : null}
          </div>
        )}
        <Switch checked={item.enabled} label={label} disabled={Boolean(lock) || !editable || busy} onChange={(next) => onToggle([{ selector: item.selector, enabled: next }])} />
      </div>
      <OriginLine origin={item.decision} saveTo={editable ? item.saveTo : null} fallback={t(`cfgp_reason_${item.reason}`)} />
      <OriginButton selector={item.selector} profile={profile} label={label} />
    </div>
  );
}

function ToolRow({ tool, capabilityLabel, profile, editable, busy, onToggle }: { tool: ToolView; capabilityLabel: string; profile: string; editable: boolean; busy: boolean; onToggle: Toggle }) {
  return (
    <div className="tool-block" data-tool={tool.id}>
      <CheckRow label={tool.label} item={tool} profile={profile} editable={editable} busy={busy} onToggle={onToggle} level="tool" />
      {tool.alsoCapabilities.length > 0 ? (
        <p className="small muted tool-note">{t("cfgp_tool_shared", { capability: capabilityLabel, others: tool.alsoCapabilities.join(", ") })}</p>
      ) : null}
      {!tool.id.includes(".") ? (
        <p className="small tool-note">
          <a href={`#/tools/${encodeURIComponent(tool.id)}`}>{t("cfgp_tool_options", { tool: tool.label })}</a>
        </p>
      ) : null}
      {tool.rules.length > 0 ? (
        <div className="rules-block" role="group" aria-label={t("cfgp_rules_of", { tool: tool.label })}>
          <h5>{t("cfgp_rules")}</h5>
          {tool.rules.map((rule) => (
            <CheckRow key={rule.selector} label={rule.label} item={rule} profile={profile} editable={editable} busy={busy} onToggle={onToggle} level="rule" />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CapabilityBlock({ capability, state, ctx, profile, editable, busy, onToggle }: { capability: CapabilityView; state: CapState | undefined; ctx: StateContext; profile: string; editable: boolean; busy: boolean; onToggle: Toggle }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="capability" data-capability={capability.id}>
      <CapabilityRow capability={capability} state={state} ctx={ctx} profile={profile} editable={editable} busy={busy} onToggle={onToggle} />
      {capability.tools.length > 0 ? (
        <>
          <button type="button" className="btn link-btn tools-toggle" aria-expanded={open} aria-controls={`tools-${capability.id}`} onClick={() => setOpen(!open)}>
            <Icon name="chevron" />
            {t("cfgp_tools_toggle", { count: capability.tools.length, capability: capability.label })}
          </button>
          {open ? (
            <div id={`tools-${capability.id}`} className="tools-list">
              {capability.tools.map((tool) => (
                <ToolRow key={tool.id} tool={tool} capabilityLabel={capability.label} profile={profile} editable={editable} busy={busy} onToggle={onToggle} />
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <p className="small muted tool-note">{t("cfgp_no_tools")}</p>
      )}
    </li>
  );
}

function CategoryBlock({ category, states, ctx, profile, editable, busy, onToggle }: { category: CategoryView; states: Map<string, CapState>; ctx: StateContext; profile: string; editable: boolean; busy: boolean; onToggle: Toggle }) {
  const [open, setOpen] = useState(false);
  const caps = category.capabilities;
  const onCount = caps.filter((c) => c.enabled).length;
  // Turning a category off writes the category and each capability that is on, so nothing stays on without being said;
  // a capability the policy locks stays on. Turning it on also turns on the capabilities that have a tool to run them.
  const toggleCategory = (next: boolean) => {
    const changes = [{ selector: category.selector, enabled: next }];
    for (const cap of caps) {
      if (next && cap.tools.length > 0 && !cap.enabled) changes.push({ selector: cap.selector, enabled: true });
      if (!next && cap.enabled && cap.locked.length === 0) changes.push({ selector: cap.selector, enabled: false });
    }
    onToggle(changes);
  };
  const lockedInside = caps.filter((c) => c.locked.length > 0 && c.enabled).length;
  return (
    <section className="category" data-category={category.id} aria-labelledby={`cat-${category.id}`}>
      <div className="check-main">
        <button type="button" className="btn icon-only" aria-expanded={open} aria-controls={`cat-body-${category.id}`} aria-label={t("cfgp_category_open", { name: category.label })} onClick={() => setOpen(!open)}>
          <Icon name="chevron" />
        </button>
        <div className="grow">
          <h3 id={`cat-${category.id}`}>{category.label}</h3>
          <p className="small muted">
            {category.description} {t("cfgp_category_count", { on: onCount, total: caps.length })}
          </p>
        </div>
        {lockedInside > 0 ? <Pill tone="gold">{t("cfgp_category_locked", { count: lockedInside })}</Pill> : null}
        <Switch checked={category.enabled} label={t("cfgp_category_switch", { name: category.label })} disabled={!editable || busy} onChange={toggleCategory} testId={`category-${category.id}`} />
      </div>
      {open ? (
        <ul id={`cat-body-${category.id}`} className="capabilities">
          {caps.map((cap) => (
            <CapabilityBlock key={cap.id} capability={cap} state={states.get(cap.id)} ctx={ctx} profile={profile} editable={editable} busy={busy} onToggle={onToggle} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** "O que você quer proteger?": categories that open into capabilities, tools and rules, each with its own toggle. */
export function Protect({ categories, plan, profile, editable, onChanged }: { categories: CategoryView[]; plan: any; profile: string; editable: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // What the plan of this profile says about each capability here (will run, not applicable and why, off and by whom).
  const states = useMemo(() => {
    const catalog: CapabilityCatalog = {
      categories: categories.map((c) => ({ id: c.id, label: c.label })),
      capabilities: categories.flatMap((c) => c.capabilities.map((cap) => ({ id: cap.id, label: cap.label, description: cap.description, category: c.id, enabled: cap.enabled, when: cap.when ?? null, decision: cap.decision as any }))),
    };
    return new Map(capabilityStates(plan, catalog).flatMap((g) => g.items.map((s) => [s.id, s] as const)));
  }, [categories, plan]);
  const ctx: StateContext = { profile: editable ? profile : null, onChanged };
  const counts = { run: 0, na: 0, off: 0, blocked: 0 };
  for (const s of states.values()) counts[s.kind] += 1;

  const onToggle: Toggle = async (changes) => {
    setBusy(true);
    setError(null);
    try {
      await api("PUT", "/api/config/selection", { profile, changes });
      toast(t("cfgp_saved", { count: changes.length, profile }), "ok");
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card pad stack" aria-labelledby="cfgp-protect-title">
      <div>
        <h2 id="cfgp-protect-title">{t("cfgp_protect_title")}</h2>
        <p className="small muted">{t("cfgp_protect_lead", { profile })}</p>
      </div>
      {!editable ? (
        <div className="notice warn" role="status" data-testid="readonly-profile">
          <Icon name="lock" />
          <span>{t("cfgp_readonly_notice", { profile })}</span>
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
      {plan ? (
        <p className="small" data-testid="capability-summary">
          {summaryText(counts)}
        </p>
      ) : null}
      <div className="categories" data-testid="categories">
        {categories.map((c) => (
          <CategoryBlock key={c.id} category={c} states={states} ctx={ctx} profile={profile} editable={editable} busy={busy} onToggle={onToggle} />
        ))}
      </div>
    </section>
  );
}
