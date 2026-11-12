import { useEffect, useState } from "react";
import { ValuePicker } from "../../components/pickers";
import { ft } from "../i18n";
import { display, freeTextReason, shownText, shownValue, withUnit } from "./model";
import type { DerivedField, DerivedOption, DerivedShape, FieldEdit } from "./types";

// The control of each derived widget (core/forms/derived/types.ts DerivedWidget): select, radio, switch, number with
// presets, checklist, list, text (a picker when the field has a value source), choice between shapes, YAML text and
// read-only. A control never saves by itself except the switch (FieldRow saves it at once and offers the undo); every
// other change is an edit the row reviews as a diff before writing.

export interface ControlProps {
  field: DerivedField;
  /** DOM id of the main control (a <label htmlFor> points at it when `labelFor(field)` is true). */
  id: string;
  /** Id of the visible label (groups of controls are named by it). */
  labelId: string;
  helpId: string;
  /** The visible name of the field. */
  title: string;
  edit: FieldEdit | undefined;
  disabled: boolean;
  onEdit: (edit: FieldEdit) => void;
  /** A switch saves at once. */
  onSwitch: (value: boolean) => void;
  /** The switch's write is in flight. */
  busy?: boolean;
}

const OTHER = "__other__";

/** Whether the visible label can be a <label htmlFor> of the main control (one control) or names a group. */
export function labelFor(field: DerivedField): boolean {
  return field.widget === "select" || field.widget === "number" || field.widget === "text" || field.widget === "yaml";
}

const optionText = (o: DerivedOption): string => (o.label && o.label !== o.secondary ? `${o.label} (${o.secondary})` : String(o.secondary ?? o.value));

function sameOption(a: unknown, b: unknown): boolean {
  return a === b || (a !== null && b !== null && a !== undefined && b !== undefined && String(a) === String(b));
}

function SwitchControl({ field, id, labelId, helpId, edit, disabled, onSwitch, busy }: ControlProps) {
  const value = shownValue(field, edit);
  const checked = value === true;
  return (
    <div className="row df-switch-row">
      <button
        id={id}
        type="button"
        role="switch"
        className="df-switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={helpId}
        aria-busy={busy ? true : undefined}
        disabled={disabled || busy}
        onClick={() => onSwitch(!checked)}
      >
        <span className="df-switch-knob" aria-hidden="true" />
      </button>
      <span className="small" aria-hidden="true">
        {value === null || value === undefined ? ft("df_switch_unset") : checked ? ft("df_switch_on") : ft("df_switch_off")}
      </span>
    </div>
  );
}

function RadioControl({ field, id, labelId, helpId, edit, disabled, onEdit }: ControlProps) {
  const value = shownValue(field, edit);
  const options = field.options ?? [];
  return (
    <div className="row wrap df-radios" role="radiogroup" id={id} aria-labelledby={labelId} aria-describedby={helpId}>
      {options.map((o, i) => (
        <label key={String(o.value)} className="row choice df-choice">
          <input type="radio" id={`${id}-${i}`} name={id} checked={sameOption(value, o.value)} disabled={disabled} onChange={() => onEdit({ value: o.value })} />
          <span>{o.label}</span>
          {o.label !== o.secondary ? <code className="muted">{o.secondary}</code> : null}
        </label>
      ))}
    </div>
  );
}

function SelectControl({ field, id, helpId, edit, disabled, onEdit }: ControlProps) {
  const value = shownValue(field, edit);
  const options = field.options ?? [];
  const index = options.findIndex((o) => sameOption(value, o.value));
  return (
    <select id={id} className="input df-select" value={index < 0 ? "" : String(index)} disabled={disabled} aria-describedby={helpId} onChange={(e) => e.target.value !== "" && onEdit({ value: options[Number(e.target.value)]?.value ?? null })}>
      {index < 0 ? <option value="">{value === null || value === undefined ? ft("df_choose") : ft("df_current_value", { value: display(value) })}</option> : null}
      {options.map((o, i) => (
        <option key={String(o.value)} value={String(i)}>
          {optionText(o)}
        </option>
      ))}
    </select>
  );
}

function numberProblem(field: DerivedField, text: string): string | null {
  const n = Number(text);
  const l = field.limits;
  if (text.trim() === "" || !Number.isFinite(n)) return ft("df_number_invalid");
  if (l?.integer && !Number.isInteger(n)) return ft("df_number_integer");
  const min = l?.minimum ?? (l?.exclusiveMinimum !== undefined ? l.exclusiveMinimum : undefined);
  const max = l?.maximum ?? (l?.exclusiveMaximum !== undefined ? l.exclusiveMaximum : undefined);
  const low = l?.minimum !== undefined ? n < l.minimum : l?.exclusiveMinimum !== undefined ? n <= l.exclusiveMinimum : false;
  const high = l?.maximum !== undefined ? n > l.maximum : l?.exclusiveMaximum !== undefined ? n >= l.exclusiveMaximum : false;
  if (low || high) return ft("df_number_range", { min: min ?? "-", max: max ?? "-" });
  return null;
}

/** A number: a select of presets plus "Outro valor..." when the schema gives presets, a number box otherwise. */
function NumberControl({ field, id, labelId, helpId, title, edit, disabled, onEdit }: ControlProps) {
  const value = shownValue(field, edit);
  const current = typeof value === "number" ? value : null;
  const presets = field.presets ?? [];
  const usePresets = presets.length >= 2;
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState(current === null ? "" : String(current));
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setText(current === null ? "" : String(current));
    setProblem(null);
  }, [current]);
  const box = (boxId: string, label?: string) => (
    <input
      id={boxId}
      type="number"
      inputMode="numeric"
      className="input df-number"
      value={text}
      disabled={disabled}
      aria-describedby={helpId}
      aria-label={label}
      aria-labelledby={label ? undefined : labelId}
      aria-invalid={problem ? true : undefined}
      autoFocus={usePresets}
      data-free-text={freeTextReason(field, "number")}
      {...(field.limits?.minimum !== undefined ? { min: field.limits.minimum } : {})}
      {...(field.limits?.maximum !== undefined ? { max: field.limits.maximum } : {})}
      onChange={(e) => {
        setText(e.target.value);
        const p = numberProblem(field, e.target.value);
        setProblem(p);
        if (!p) onEdit({ value: Number(e.target.value) });
      }}
    />
  );
  const problemLine = problem ? (
    <span className="small field-problem" role="alert">
      {problem}
    </span>
  ) : null;
  if (!usePresets) {
    return (
      <div className="stack tight">
        <div className="row wrap">
          {box(id)}
          {field.unit ? <span className="muted small">{withUnit(2, field.unit).replace(/^2\s*/, "")}</span> : null}
        </div>
        {problemLine}
      </div>
    );
  }
  const choices = current !== null && !presets.includes(current) ? [...presets, current].sort((a, b) => a - b) : presets;
  return (
    <div className="stack tight">
      <select
        id={id}
        className="input df-select"
        value={typing ? OTHER : current === null ? "" : String(current)}
        disabled={disabled}
        aria-describedby={helpId}
        onChange={(e) => {
          if (e.target.value === OTHER) return setTyping(true);
          setTyping(false);
          if (e.target.value !== "") onEdit({ value: Number(e.target.value) });
        }}
      >
        {current === null ? <option value="">{ft("df_choose")}</option> : null}
        {choices.map((n) => (
          <option key={n} value={String(n)}>
            {withUnit(n, field.unit)}
          </option>
        ))}
        <option value={OTHER}>{ft("df_other_value")}</option>
      </select>
      {typing ? (
        <div className="row wrap">
          {box(`${id}-other`, ft("df_other_value_of", { field: title }))}
          <button type="button" className="btn" onClick={() => setTyping(false)}>
            {ft("df_back_to_list")}
          </button>
        </div>
      ) : null}
      {problemLine}
    </div>
  );
}

function TextControl({ field, id, labelId, helpId, title, edit, disabled, onEdit }: ControlProps) {
  if (field.state === "custom") {
    const text = shownText(field, edit);
    const multi = text.includes("\n");
    const common = { id, className: "input df-text", value: text, disabled, spellCheck: false, "aria-labelledby": labelId, "aria-describedby": helpId, "data-free-text": freeTextReason(field), onChange: (e: { target: { value: string } }) => onEdit({ yaml: e.target.value }) };
    return multi ? <textarea {...common} rows={Math.min(10, text.split("\n").length + 1)} /> : <input type="text" {...common} />;
  }
  const value = shownValue(field, edit);
  const text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  if (field.source) {
    return <ValuePicker id={id} source={field.source} value={text} fieldLabel={title} labelledBy={labelId} describedBy={helpId} disabled={disabled} onChange={(v) => onEdit({ value: v })} />;
  }
  return <input id={id} type="text" className="input df-text" value={text} disabled={disabled} spellCheck={false} placeholder={field.example ?? ""} aria-labelledby={labelId} aria-describedby={helpId} data-free-text={freeTextReason(field)} onChange={(e) => onEdit({ value: e.target.value })} />;
}

function ChecklistControl({ field, id, labelId, helpId, edit, disabled, onEdit }: ControlProps) {
  const value = shownValue(field, edit);
  const chosen = Array.isArray(value) ? value : [];
  const options: DerivedOption[] = [...(field.options ?? [])];
  for (const v of chosen) if (!options.some((o) => sameOption(o.value, v))) options.push({ value: v as DerivedOption["value"], label: String(v), secondary: String(v) });
  const toggle = (o: DerivedOption, on: boolean) => {
    const rest = chosen.filter((v) => !sameOption(v, o.value));
    onEdit({ value: on ? [...rest, o.value] : rest });
  };
  return (
    <div className="row wrap df-checklist" role="group" id={id} aria-labelledby={labelId} aria-describedby={helpId}>
      {options.map((o, i) => (
        <label key={String(o.value)} className="row choice df-choice">
          <input type="checkbox" id={`${id}-${i}`} checked={chosen.some((v) => sameOption(v, o.value))} disabled={disabled} onChange={(e) => toggle(o, e.target.checked)} />
          <span>{o.label}</span>
          {o.label !== o.secondary ? <code className="muted">{o.secondary}</code> : null}
        </label>
      ))}
    </div>
  );
}

function ListControl({ field, id, labelId, helpId, title, edit, disabled, onEdit }: ControlProps) {
  const value = shownValue(field, edit);
  const items = Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))) : [];
  const [draft, setDraft] = useState("");
  const add = () => {
    const item = draft.trim();
    if (!item) return;
    onEdit({ value: [...items, item] });
    setDraft("");
  };
  const move = (from: number, to: number) => {
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item as string);
    onEdit({ value: next });
  };
  return (
    <div className="stack tight df-list" role="group" aria-labelledby={labelId} aria-describedby={helpId}>
      {items.length === 0 ? <span className="muted small">{value === null || value === undefined ? ft("df_list_none") : ft("df_list_empty")}</span> : null}
      {items.length > 0 ? (
        <ul className="chips">
          {items.map((item, i) => (
            <li key={`${item}-${i}`} className="chip">
              <code>{item}</code>
              <button type="button" className="chip-btn" disabled={disabled || i === 0} aria-label={ft("df_list_up", { item })} onClick={() => move(i, i - 1)}>
                {ft("df_list_up_short")}
              </button>
              <button type="button" className="chip-btn" disabled={disabled || i === items.length - 1} aria-label={ft("df_list_down", { item })} onClick={() => move(i, i + 1)}>
                {ft("df_list_down_short")}
              </button>
              <button type="button" className="chip-btn" disabled={disabled} aria-label={ft("df_list_remove", { item })} onClick={() => onEdit({ value: items.filter((_, j) => j !== i) })}>
                {ft("df_list_remove_short")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row wrap df-list-add">
        {field.source ? (
          <div className="grow">
            <ValuePicker id={id} source={field.source} value={draft} fieldLabel={title} placeholder={ft("df_list_pick")} disabled={disabled} onChange={setDraft} />
          </div>
        ) : (
          <input
            id={id}
            type="text"
            className="input grow"
            value={draft}
            disabled={disabled}
            spellCheck={false}
            aria-label={ft("df_list_new_item", { field: title })}
            data-free-text={freeTextReason(field, "item")}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
        )}
        <button type="button" className="btn" disabled={disabled || draft.trim() === ""} aria-label={ft("df_list_add_to", { field: title })} onClick={add}>
          {ft("df_list_add")}
        </button>
      </div>
    </div>
  );
}

function YamlControl({ field, id, helpId, edit, disabled, onEdit }: ControlProps) {
  const text = shownText(field, edit);
  return (
    <textarea
      id={id}
      className="input df-yaml"
      rows={Math.min(12, Math.max(3, text.split("\n").length + 1))}
      value={text}
      disabled={disabled}
      spellCheck={false}
      aria-describedby={helpId}
      data-free-text={freeTextReason(field, "yaml")}
      onChange={(e) => onEdit({ yaml: e.target.value })}
    />
  );
}

/** The shape a value has: the server's answer, or a guess from the edit's type. */
function shapeOfValue(shapes: DerivedShape[], value: unknown, fallback: number | undefined): number {
  if (fallback !== undefined) return fallback;
  const want = typeof value === "string" ? "text" : typeof value === "number" ? "number" : typeof value === "boolean" ? "switch" : Array.isArray(value) ? "list" : value && typeof value === "object" ? "group" : null;
  const found = shapes.findIndex((s) => s.widget === want || (want === "list" && s.widget === "checklist"));
  return found < 0 ? 0 : found;
}

const shapeName = (shape: DerivedShape): string => {
  const known = ft(`df_shape_${shape.widget}`);
  return known.startsWith("df_shape_") ? shape.label : `${known}${shape.label && !["text", "object", "list", "number", "boolean"].includes(shape.label) ? ` (${shape.label})` : ""}`;
};

/** A value of one of several shapes (oneOf): radios of the shapes, then the control of the chosen one. */
function ChoiceControl(props: ControlProps) {
  const { field, id, labelId, helpId, title, edit, disabled, onEdit } = props;
  const shapes = field.shapes ?? [];
  const value = shownValue(field, edit);
  const [picked, setPicked] = useState(() => shapeOfValue(shapes, field.state === "inherited" ? null : value, field.shape));
  const shape = shapes[picked] ?? shapes[0];
  const original = picked === field.shape;
  let body = null;
  if (shape) {
    const w = shape.widget;
    if (w === "text" || w === "select" || w === "radio" || w === "number" || w === "switch" || w === "readonly") {
      const inner: DerivedField = { ...field, widget: w === "switch" ? "radio" : w === "readonly" ? "readonly" : w, options: w === "switch" ? [{ value: true, label: ft("df_switch_on"), secondary: "true" }, { value: false, label: ft("df_switch_off"), secondary: "false" }] : shape.options ?? [], ...(shape.limits ? { limits: shape.limits } : {}), value: original || field.state === "inherited" ? field.value : null, text: undefined } as DerivedField;
      if (typeof inner.value === "object" && inner.value !== null) inner.value = null;
      body = <FieldControl {...props} field={inner} id={`${id}-value`} />;
    } else {
      const seeded = original ? (field.text ?? "") : "";
      const text = edit && "yaml" in edit ? edit.yaml : seeded;
      body = (
        <textarea
          id={`${id}-value`}
          className="input df-yaml"
          rows={Math.min(12, Math.max(3, text.split("\n").length + 1))}
          value={text}
          disabled={disabled}
          spellCheck={false}
          aria-label={ft("df_shape_yaml_of", { field: title })}
          aria-describedby={helpId}
          data-free-text={freeTextReason(field, "yaml")}
          onChange={(e) => onEdit({ yaml: e.target.value })}
        />
      );
    }
  }
  return (
    <div className="stack tight df-choice-field">
      {shapes.length > 1 ? (
        <div className="row wrap df-radios" role="radiogroup" id={id} aria-labelledby={labelId}>
          <span className="small muted">{ft("df_shape_label")}</span>
          {shapes.map((s, i) => (
            <label key={s.index} className="row choice df-choice">
              <input type="radio" name={id} checked={picked === i} disabled={disabled} onChange={() => setPicked(i)} />
              <span>{shapes.filter((x) => shapeName(x) === shapeName(s)).length > 1 ? `${shapeName(s)} ${shapes.slice(0, i + 1).filter((x) => shapeName(x) === shapeName(s)).length}` : shapeName(s)}</span>
            </label>
          ))}
        </div>
      ) : null}
      {body}
    </div>
  );
}

function ReadonlyControl({ field, id, edit }: ControlProps) {
  const value = shownValue(field, edit);
  return (
    <code id={id} className="df-readonly" data-readonly="true">
      {display(value) || ft("df_no_value")}
    </code>
  );
}

/** The control of a field, by its widget. */
export function FieldControl(props: ControlProps) {
  switch (props.field.widget) {
    case "switch":
      return <SwitchControl {...props} />;
    case "radio":
      return <RadioControl {...props} />;
    case "select":
      return <SelectControl {...props} />;
    case "number":
      return <NumberControl {...props} />;
    case "checklist":
      return <ChecklistControl {...props} />;
    case "list":
      return <ListControl {...props} />;
    case "choice":
      return <ChoiceControl {...props} />;
    case "yaml":
      return <YamlControl {...props} />;
    case "readonly":
      return <ReadonlyControl {...props} />;
    default:
      return <TextControl {...props} />;
  }
}
