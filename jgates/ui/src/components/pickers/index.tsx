import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { errorText } from "../common";
import { pk } from "./i18n";
import "./pickers.css";

// Value pickers (PLAN-config-editing.md section 3): a field whose values are known somewhere (a file or folder of the
// project, a git ref, a compose service and port, an id of the workspace or of the catalogue) is a select of those
// values, loaded from GET /api/pickers/<source>, instead of a text box. Typing stays possible through "Outro..." (and
// "URL..." for a target), so a picker never restricts what the schema accepts.
//
// Usage:
//   <ValuePicker id="f-spec" source={{ name: "project-file", pattern: "\\.ya?ml$" }} value={v} fieldLabel="Spec"
//                labelledBy="f-spec-label" onChange={setV} />
// The select gets `id` (a <label htmlFor> may point at it); the typed box of "Outro..." carries data-free-text with the
// kind of open value it takes (see tests/ui/free-text.ts).

/** A value source of a derived field (core/forms/derived/sources.ts). */
export interface ValueSource {
  name: string;
  /** project-file: a regular expression (case-insensitive) over the relative path. */
  pattern?: string;
  /** The value may be a glob: the list helps, the typed text is the usual way. */
  glob?: boolean;
}

export interface PickerItem {
  value: string;
  label: string;
  secondary?: string;
  group?: string;
}

export interface PickerList {
  source: string;
  items: PickerItem[];
  truncated: boolean;
  notes: string[];
}

const OTHER = "__other__";
const URL_CHOICE = "__url__";
const MAX_SHOWN = 1000;

const cache = new Map<string, Promise<PickerList>>();

export function pickerUrl(source: ValueSource): string {
  return `/api/pickers/${encodeURIComponent(source.name)}${source.pattern ? `?pattern=${encodeURIComponent(source.pattern)}` : ""}`;
}

/** The list of a source; one request per source and pattern for the whole page (forgetPickers() asks again). */
export function loadPicker(source: ValueSource): Promise<PickerList> {
  const url = pickerUrl(source);
  let pending = cache.get(url);
  if (!pending) {
    pending = api<PickerList>("GET", url);
    cache.set(url, pending);
    pending.catch(() => cache.delete(url));
  }
  return pending;
}

/** Forgets the loaded lists (after a write that may add files, services or profiles). */
export function forgetPickers(): void {
  cache.clear();
}

export function usePicker(source: ValueSource | null): { list: PickerList | null; error: unknown; loading: boolean } {
  const key = source ? pickerUrl(source) : "";
  const [state, setState] = useState<{ key: string; list: PickerList | null; error: unknown }>({ key: "", list: null, error: null });
  useEffect(() => {
    if (!source) return;
    let live = true;
    loadPicker(source).then(
      (list) => live && setState({ key, list, error: null }),
      (error) => live && setState({ key, list: null, error }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const mine = state.key === key;
  return { list: mine ? state.list : null, error: mine ? state.error : null, loading: source !== null && !mine };
}

/** The open kind of a typed value of a source (tests/ui/free-text.ts). */
export function typedReason(source: ValueSource, url: boolean): string {
  if (url) return "url";
  if (source.name === "project-file" || source.name === "project-folder") return "project-path";
  return "identifier";
}

const groupLabel = (group: string): string => {
  const text = pk(`pk_group_${group}`);
  return text === `pk_group_${group}` ? pk("pk_group_other") : text;
};

function Options({ items }: { items: PickerItem[] }) {
  const groups: Array<{ group: string; items: PickerItem[] }> = [];
  for (const item of items) {
    const g = item.group ?? "";
    const last = groups[groups.length - 1];
    if (last && last.group === g) last.items.push(item);
    else groups.push({ group: g, items: [item] });
  }
  const option = (item: PickerItem) => (
    <option key={`${item.group ?? ""}:${item.value}`} value={item.value}>
      {item.secondary && item.secondary !== item.label ? `${item.label} (${item.secondary})` : item.label}
    </option>
  );
  if (groups.length <= 1 && !groups[0]?.group) return <>{items.map(option)}</>;
  return (
    <>
      {groups.map((g, i) =>
        g.group ? (
          <optgroup key={`${g.group}-${i}`} label={groupLabel(g.group)}>
            {g.items.map(option)}
          </optgroup>
        ) : (
          g.items.map(option)
        ),
      )}
    </>
  );
}

export interface ValuePickerProps {
  /** DOM id of the select. */
  id: string;
  source: ValueSource;
  /** The current value; null or "" when there is none. */
  value: string | null;
  /** The visible name of the field, for the accessible name of the typed box. */
  fieldLabel: string;
  /** Id of the element that names the select (when no <label htmlFor> points at it). */
  labelledBy?: string;
  describedBy?: string;
  disabled?: boolean;
  /** Text of the empty choice (shown while there is no value). */
  placeholder?: string;
  /** Offer "URL..." besides the list (targets of runtime checks). Defaults to true for service-target. */
  allowUrl?: boolean;
  /** Focus the select when it appears (the first field of a dialog). */
  autoFocus?: boolean;
  onChange: (value: string) => void;
}

/** A select of the values of a source, with "Outro..." (and "URL...") for typing. */
export function ValuePicker({ id, source, value, fieldLabel, labelledBy, describedBy, disabled, placeholder, allowUrl, autoFocus, onChange }: ValuePickerProps) {
  const { list, error, loading } = usePicker(source);
  const urlAllowed = allowUrl ?? source.name === "service-target";
  const current = value ?? "";
  const items = list?.items.slice(0, MAX_SHOWN) ?? [];
  const known = items.some((i) => i.value === current);
  const scheme = current.slice(0, current.indexOf(":") + 1).toLowerCase();
  const looksUrl = urlAllowed && (scheme === "http:" || scheme === "https:");
  // Typing: chosen by the person, or the value is a URL and the field takes URLs.
  const [typing, setTyping] = useState<"other" | "url" | null>(looksUrl && !known ? "url" : null);
  const typedId = `${id}-typed`;
  const selectRef = useRef<HTMLSelectElement>(null);
  // The select is disabled while the list loads, so the focus asked for waits for it.
  useEffect(() => {
    if (autoFocus && !loading) selectRef.current?.focus();
  }, [autoFocus, loading]);

  const choose = (next: string) => {
    if (next === OTHER) return setTyping("other");
    if (next === URL_CHOICE) return setTyping("url");
    setTyping(null);
    if (next !== "") onChange(next);
  };

  return (
    <div className="picker stack tight" data-picker={source.name}>
      <select
        id={id}
        className="input picker-select"
        value={typing === "other" ? OTHER : typing === "url" ? URL_CHOICE : current}
        disabled={disabled || loading}
        ref={selectRef}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-busy={loading ? true : undefined}
        onChange={(e) => choose(e.target.value)}
      >
        {loading ? <option value={current}>{pk("pk_loading")}</option> : null}
        {!loading && current === "" ? <option value="">{placeholder ?? pk("pk_choose")}</option> : null}
        {!loading && current !== "" && !known && typing === null ? <option value={current}>{pk("pk_current", { value: current })}</option> : null}
        {!loading ? <Options items={items} /> : null}
        {!loading && urlAllowed ? <option value={URL_CHOICE}>{pk("pk_url")}</option> : null}
        {!loading ? <option value={OTHER}>{pk("pk_other")}</option> : null}
      </select>
      {typing ? (
        <div className="row wrap picker-typed">
          <input
            id={typedId}
            type={typing === "url" ? "url" : "text"}
            className="input grow"
            value={current}
            disabled={disabled}
            spellCheck={false}
            autoFocus
            placeholder={typing === "url" ? pk("pk_url_placeholder") : ""}
            aria-label={pk(typing === "url" ? "pk_url_label" : "pk_other_label", { field: fieldLabel })}
            data-free-text={typedReason(source, typing === "url")}
            onChange={(e) => onChange(e.target.value)}
          />
          <button type="button" className="btn" disabled={disabled} onClick={() => setTyping(null)}>
            {pk("pk_back")}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="small field-problem" role="alert">
          {pk("pk_error", { message: errorText(error).message })}
        </p>
      ) : null}
      {list && list.items.length === 0 && list.notes.length === 0 ? <p className="small muted">{pk("pk_empty")}</p> : null}
      {list?.notes.map((n) => (
        <p key={n} className="small muted" data-picker-note={n}>
          {pk(`pk_note_${n}`)}
        </p>
      ))}
      {list && (list.truncated || list.items.length > MAX_SHOWN) ? <p className="small muted">{pk("pk_truncated", { count: Math.min(list.items.length, MAX_SHOWN) })}</p> : null}
    </div>
  );
}
