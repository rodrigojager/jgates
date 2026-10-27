import { useEffect, useState } from "react";
import { Icon } from "../components/icons";
import { ft } from "./i18n";
import type { FieldView } from "./model";

export interface WidgetProps {
  field: FieldView;
  /** DOM id of the main control (the field label points to it). */
  id: string;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}

const asList = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

function NumberWidget({ field, id, value, disabled, onChange }: WidgetProps) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setText(value === undefined ? "" : String(value));
    setProblem(null);
  }, [value]);
  const min = typeof field.schema.minimum === "number" ? field.schema.minimum : null;
  const max = typeof field.schema.maximum === "number" ? field.schema.maximum : null;
  return (
    <div className="stack tight">
      <div className="row">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          className="input number"
          value={text}
          disabled={disabled}
          {...(min !== null ? { min } : {})}
          {...(max !== null ? { max } : {})}
          placeholder={field.example ?? ""}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            const n = Number(next);
            if (next.trim() === "" || !Number.isInteger(n)) return setProblem(ft("number_invalid"));
            if ((min !== null && n < min) || (max !== null && n > max)) return setProblem(ft("number_range", { min: min ?? "-", max: max ?? "-" }));
            setProblem(null);
            onChange(n);
          }}
        />
        {field.unit ? <span className="muted small">{field.unit}</span> : null}
      </div>
      {problem ? (
        <span className="small field-problem" role="alert">
          {problem}
        </span>
      ) : null}
    </div>
  );
}

function TextWidget({ field, id, value, disabled, onChange }: WidgetProps) {
  return <input id={id} type="text" className="input" value={typeof value === "string" ? value : ""} disabled={disabled} placeholder={field.example ?? ""} spellCheck={false} onChange={(e) => onChange(e.target.value)} />;
}

function SelectWidget({ field, id, value, disabled, onChange }: WidgetProps) {
  const options: string[] = Array.isArray(field.schema.enum) ? field.schema.enum.map(String) : [];
  return (
    <select id={id} className="input" value={typeof value === "string" ? value : ""} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {typeof value !== "string" ? <option value="">{ft("select_choose")}</option> : null}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function RadioWidget({ field, id, value, disabled, onChange }: WidgetProps) {
  const options: string[] = Array.isArray(field.schema.enum) ? field.schema.enum.map(String) : [];
  return (
    <div className="row wrap" role="radiogroup" id={id} aria-labelledby={`${id}-label`}>
      {options.map((o) => (
        <label key={o} className="row choice">
          <input type="radio" name={id} value={o} checked={value === o} disabled={disabled} onChange={() => onChange(o)} />
          <code>{o}</code>
        </label>
      ))}
    </div>
  );
}

function BooleanWidget({ id, value, disabled, onChange }: WidgetProps) {
  return (
    <label className="row choice">
      <input id={id} type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {ft("bool_true")}
    </label>
  );
}

function ListWidget({ field, id, value, disabled, onChange }: WidgetProps) {
  const items = asList(value);
  const [draft, setDraft] = useState("");
  const add = () => {
    const item = draft.trim();
    if (!item) return;
    onChange([...items, item]);
    setDraft("");
  };
  const move = (from: number, to: number) => {
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item as string);
    onChange(next);
  };
  return (
    <div className="stack tight" role="group" aria-labelledby={`${id}-label`}>
      {items.length === 0 ? <span className="muted small">{ft("list_empty")}</span> : null}
      {items.length > 0 ? (
        <ul className="chips">
          {items.map((item, i) => (
            <li key={`${item}-${i}`} className="chip">
              <code>{item}</code>
              {field.ordered ? (
                <>
                  <button type="button" className="chip-btn" disabled={disabled || i === 0} aria-label={ft("list_up", { item })} onClick={() => move(i, i - 1)}>
                    {ft("list_up_short")}
                  </button>
                  <button type="button" className="chip-btn" disabled={disabled || i === items.length - 1} aria-label={ft("list_down", { item })} onClick={() => move(i, i + 1)}>
                    {ft("list_down_short")}
                  </button>
                </>
              ) : null}
              <button type="button" className="chip-btn" disabled={disabled} aria-label={ft("list_remove", { item })} onClick={() => onChange(items.filter((_, j) => j !== i))}>
                {ft("list_remove_short")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row">
        <input
          id={id}
          type="text"
          className="input"
          value={draft}
          disabled={disabled}
          placeholder={field.example ?? ""}
          aria-label={ft("list_new_item", { field: field.label })}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn" disabled={disabled || draft.trim() === ""} onClick={add}>
          {ft("list_add")}
        </button>
      </div>
    </div>
  );
}

function MapWidget({ field, id, value, disabled, onChange }: WidgetProps) {
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : [];
  const [key, setKey] = useState("");
  const split = (text: string) => text.split(",").map((s) => s.trim()).filter(Boolean);
  const put = (k: string, values: string[]) => onChange({ ...Object.fromEntries(entries), [k]: values });
  return (
    <div className="stack tight" role="group" aria-labelledby={`${id}-label`}>
      {entries.length === 0 ? <span className="muted small">{ft("list_empty")}</span> : null}
      {entries.map(([k, v]) => (
        <div key={k} className="row wrap map-row">
          <code className="map-key">{k}</code>
          <input
            type="text"
            className="input grow"
            defaultValue={asList(v).join(", ")}
            disabled={disabled}
            aria-label={`${ft("map_values")}: ${k}`}
            spellCheck={false}
            onBlur={(e) => {
              const next = split(e.target.value);
              if (JSON.stringify(next) !== JSON.stringify(asList(v))) put(k, next);
            }}
          />
          <button type="button" className="btn" disabled={disabled} aria-label={ft("map_remove", { key: k })} onClick={() => onChange(Object.fromEntries(entries.filter(([e]) => e !== k)))}>
            {ft("list_remove_short")}
          </button>
        </div>
      ))}
      <div className="row">
        <input id={id} type="text" className="input" value={key} disabled={disabled} placeholder={field.example ?? ""} aria-label={ft("map_key")} spellCheck={false} onChange={(e) => setKey(e.target.value)} />
        <button
          type="button"
          className="btn"
          disabled={disabled || key.trim() === "" || entries.some(([k]) => k === key.trim())}
          onClick={() => {
            put(key.trim(), []);
            setKey("");
          }}
        >
          {ft("map_add")}
        </button>
      </div>
    </div>
  );
}

export function Widget(props: WidgetProps) {
  switch (props.field.widget) {
    case "number":
      return <NumberWidget {...props} />;
    case "text":
      return <TextWidget {...props} />;
    case "select":
      return <SelectWidget {...props} />;
    case "radio":
      return <RadioWidget {...props} />;
    case "boolean":
      return <BooleanWidget {...props} />;
    case "list-map":
      return <MapWidget {...props} />;
    default:
      return <ListWidget {...props} />;
  }
}

/** The value a field takes when the user stops inheriting: the tool default when known, otherwise an empty value. */
export function startValue(field: FieldView): unknown {
  if (field.defaultValue !== undefined) return field.defaultValue;
  switch (field.widget) {
    case "number":
      return typeof field.schema.minimum === "number" ? field.schema.minimum : 0;
    case "boolean":
      return false;
    case "select":
    case "radio":
      return Array.isArray(field.schema.enum) ? field.schema.enum[0] : "";
    case "text":
      return "";
    case "list-map":
      return {};
    default:
      return [];
  }
}

export function OpenAtLine({ line, onOpen }: { line: number | null; onOpen: () => void }) {
  return (
    <button type="button" className="btn link-btn" onClick={onOpen}>
      <Icon name="file" />
      {line ? ft("open_at_line", { line }) : ft("open_in_file")}
    </button>
  );
}
