import { useState } from "react";
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
  tools: ToolView[];
}
export interface CategoryView extends ItemBase {
  id: string;
  label: string;
  description: string;
  capabilities: CapabilityView[];
}

type Toggle = (changes: Array<{ selector: string; enabled: boolean }>, note?: string) => void;

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

function CapabilityBlock({ capability, profile, editable, busy, onToggle }: { capability: CapabilityView; profile: string; editable: boolean; busy: boolean; onToggle: Toggle }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="capability" data-capability={capability.id}>
      <CheckRow label={capability.label} description={capability.description} item={capability} profile={profile} editable={editable} busy={busy} onToggle={onToggle} level="capability" />
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

function CategoryBlock({ category, profile, editable, busy, onToggle }: { category: CategoryView; profile: string; editable: boolean; busy: boolean; onToggle: Toggle }) {
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
            <CapabilityBlock key={cap.id} capability={cap} profile={profile} editable={editable} busy={busy} onToggle={onToggle} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** "O que você quer proteger?": categories that open into capabilities, tools and rules, each with its own toggle. */
export function Protect({ categories, profile, editable, onChanged }: { categories: CategoryView[]; profile: string; editable: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

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
      <div className="categories" data-testid="categories">
        {categories.map((c) => (
          <CategoryBlock key={c.id} category={c} profile={profile} editable={editable} busy={busy} onToggle={onToggle} />
        ))}
      </div>
    </section>
  );
}
