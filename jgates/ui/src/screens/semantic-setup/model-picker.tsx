import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../../i18n";

/** The value of the model control: null keeps the default (the CLI's own, or the user's preference). */
export type ModelValue = string | null;

const OTHER = "__other__";
const DEFAULT = "__default__";
/** Up to this many models a plain select is the clearest control; above it, a searchable combobox. */
const SELECT_LIMIT = 30;
/** Options the combobox shows at once; the rest are reached by typing. */
const SHOWN = 80;

interface Props {
  /** Models to offer (detected or suggested). */
  models: string[];
  value: ModelValue;
  onChange: (value: ModelValue) => void;
  /** The text of the "keep the default" choice, or null when a model is required. */
  defaultLabel: string | null;
  /** One line under the control: where the list comes from. */
  help: string;
  loading?: boolean;
  disabled?: boolean;
}

/**
 * The model of the provider step. A short list is a select with "Outro…" for a free name; a long one (opencode lists
 * hundreds) is a combobox that filters as you type and also accepts a name that is not listed.
 */
export function ModelPicker(props: Props) {
  return props.models.length > SELECT_LIMIT ? <ModelCombobox {...props} /> : <ModelSelect {...props} />;
}

function ModelSelect({ models, value, onChange, defaultLabel, help, loading, disabled }: Props) {
  const id = useId();
  const listed = value !== null && models.includes(value);
  const [other, setOther] = useState(value !== null && !listed);
  useEffect(() => {
    // A value chosen elsewhere (the suggested default arriving with the list) closes or opens the free field.
    if (value !== null && models.includes(value)) setOther(false);
    else if (value !== null) setOther(true);
  }, [value, models]);
  const selected = other ? OTHER : value === null ? (defaultLabel !== null ? DEFAULT : "") : value;
  return (
    <div className="field semprov-model" data-testid="semprov-model">
      <label className="field-label" htmlFor={`${id}-select`}>
        {t("semprov_model_label")}
      </label>
      <select
        id={`${id}-select`}
        className="input"
        value={selected}
        disabled={disabled}
        aria-describedby={`${id}-help`}
        onChange={(e) => {
          const v = e.target.value;
          if (v === OTHER) {
            setOther(true);
            onChange(value !== null && !models.includes(value) ? value : "");
          } else {
            setOther(false);
            onChange(v === DEFAULT || v === "" ? null : v);
          }
        }}
      >
        {defaultLabel !== null ? <option value={DEFAULT}>{defaultLabel}</option> : <option value="">{t("semprov_model_pick")}</option>}
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        <option value={OTHER}>{t("semprov_model_other")}</option>
      </select>
      {other ? (
        <>
          <label className="field-label" htmlFor={`${id}-other`}>
            {t("semprov_model_other_label")}
          </label>
          <input id={`${id}-other`} className="input mono" type="text" spellCheck={false} disabled={disabled} value={value ?? ""} placeholder={t("semprov_model_other_placeholder")} onChange={(e) => onChange(e.target.value)} />
        </>
      ) : null}
      <p className="small muted" id={`${id}-help`}>
        {loading ? t("semprov_models_loading") : help}
      </p>
    </div>
  );
}

function ModelCombobox({ models, value, onChange, defaultLabel, help, loading, disabled }: Props) {
  const id = useId();
  const listId = `${id}-list`;
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const text = value ?? "";
  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    return q === "" ? models : models.filter((m) => m.toLowerCase().includes(q));
  }, [models, text]);
  const shown = matches.slice(0, SHOWN);
  useEffect(() => setActive(0), [text]);

  const choose = (m: string) => {
    onChange(m);
    setOpen(false);
    input.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && open && shown[active]) {
      e.preventDefault();
      choose(shown[active] as string);
    } else if (e.key === "Escape" && open) {
      // Closes the list only; a dialog around it stays open.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="field semprov-model" data-testid="semprov-model">
      <label className="field-label" htmlFor={`${id}-input`}>
        {t("semprov_model_label")}
      </label>
      <div className="semprov-combo">
        <input
          ref={input}
          id={`${id}-input`}
          className="input mono"
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-describedby={`${id}-help`}
          {...(open && shown[active] ? { "aria-activedescendant": `${id}-opt-${active}` } : {})}
          value={text}
          placeholder={defaultLabel ?? t("semprov_model_search")}
          onChange={(e) => {
            onChange(e.target.value === "" ? null : e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKey}
        />
        {open ? (
          <ul id={listId} role="listbox" className="semprov-options" aria-label={t("semprov_model_options", { count: matches.length })}>
            {shown.map((m, i) => (
              <li
                key={m}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "active" : undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(m);
                }}
              >
                {m}
              </li>
            ))}
            {matches.length === 0 ? (
              <li role="option" aria-selected={false} aria-disabled="true" className="muted">
                {t("semprov_model_free", { model: text.trim() })}
              </li>
            ) : null}
            {matches.length > shown.length ? (
              <li role="option" aria-selected={false} aria-disabled="true" className="muted">
                {t("semprov_model_more", { count: matches.length - shown.length })}
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
      <p className="small muted" id={`${id}-help`}>
        {loading ? t("semprov_models_loading") : `${help} ${t("semprov_model_combo_help", { count: models.length })}`}
      </p>
    </div>
  );
}
