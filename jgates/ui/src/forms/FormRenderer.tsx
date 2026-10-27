import { Icon } from "../components/icons";
import { ft } from "./i18n";
import { display, effective, matches, type FieldView, type FormView, type Pending } from "./model";
import { OpenAtLine, Widget, startValue } from "./widgets";
import "./forms.css";

// Small renderer over the data schema + UI schema the server sends (an own renderer instead of JSON Forms).
// Groups "Uso comum" (open) and "Avançado" (collapsed), sections inside each group, one row per field.

export interface FormRendererProps {
  view: FormView;
  pending: Map<string, Pending>;
  query: string;
  readOnly: boolean;
  onPending: (field: FieldView, next: Pending) => void;
  openAt: (line: number | null) => void;
}

const domId = (field: FieldView) => `field-${field.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

function FieldRow({ field, pending, readOnly, onPending, openAt }: { field: FieldView; pending: Pending | undefined; readOnly: boolean; onPending: FormRendererProps["onPending"]; openAt: FormRendererProps["openAt"] }) {
  const id = domId(field);
  const shown = effective(field, pending);
  const changed = pending !== undefined;
  const helpId = `${id}-help`;

  if (field.state === "unrecognized") {
    return (
      <div className="field unrecognized" data-field={field.id} data-state="unrecognized">
        <div className="field-head">
          <span className="field-label" id={`${id}-label`}>
            {field.label}
          </span>
          <code className="muted">{field.documentPath}</code>
        </div>
        <div className="notice warn">
          <Icon name="alert" />
          <div className="stack tight grow">
            <strong>{ft("unrecognized_title")}</strong>
            <p className="small">{ft("unrecognized_lead")}</p>
            <p className="small">
              {ft("value")}: <code>{display(field.value)}</code>
            </p>
            {field.problems.map((p) => (
              <p key={p} className="small">
                <code>{p}</code>
              </p>
            ))}
            <div>
              <OpenAtLine line={field.position?.line ?? null} onOpen={() => openAt(field.position?.line ?? null)} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`field${changed ? " changed" : ""}`} data-field={field.id} data-state={shown.inherited ? "inherited" : "set"}>
      <div className="field-head">
        <label className="field-label" id={`${id}-label`} htmlFor={id}>
          {field.label}
        </label>
        <code className="muted">{field.documentPath}</code>
        {field.position && !shown.inherited ? (
          <button type="button" className="link-btn small" onClick={() => openAt(field.position?.line ?? null)}>
            {ft("open_at_line", { line: field.position.line })}
          </button>
        ) : null}
      </div>
      <p className="small muted" id={helpId}>
        {field.help}
      </p>
      <div className="field-body">
        <Widget field={field} id={id} value={shown.inherited ? undefined : shown.value} disabled={readOnly || shown.inherited} onChange={(value) => onPending(field, { op: "set", value })} />
        <label className="row choice inherit">
          <input
            type="checkbox"
            checked={shown.inherited}
            disabled={readOnly}
            aria-label={`${ft("inherit")} (${field.label})`}
            onChange={(e) => onPending(field, e.target.checked ? { op: "inherit" } : { op: "set", value: field.state === "set" ? field.value : startValue(field) })}
          />
          {ft("inherit")}
        </label>
      </div>
      {shown.inherited ? (
        <p className="small muted">{field.defaultValue !== undefined ? ft("inherited_default", { value: display(field.defaultValue) }) : ft("inherited_no_default")}</p>
      ) : null}
    </div>
  );
}

function Group({ view, group, fields, props, open }: { view: FormView; group: "common" | "advanced"; fields: FieldView[]; props: FormRendererProps; open: boolean }) {
  if (fields.length === 0) return null;
  const body = view.sections
    .map((s) => ({ section: s, fields: fields.filter((f) => f.section === s.id) }))
    .filter((s) => s.fields.length > 0)
    .map(({ section, fields: list }) => (
      <section key={section.id} className="form-section" aria-label={section.label}>
        <h3>{section.label}</h3>
        {list.map((f) => (
          <FieldRow key={f.id} field={f} pending={props.pending.get(f.id)} readOnly={props.readOnly} onPending={props.onPending} openAt={props.openAt} />
        ))}
      </section>
    ));
  const title = ft(group === "common" ? "group_common" : "group_advanced");
  if (group === "common") {
    return (
      <div className="card flat stack form-group" data-group="common">
        <h2>{title}</h2>
        {body}
      </div>
    );
  }
  return (
    <details className="card flat form-group" data-group="advanced" open={open}>
      <summary>
        <h2>{title}</h2>
        <span className="muted small">{fields.length}</span>
      </summary>
      <div className="stack">{body}</div>
    </details>
  );
}

export function FormRenderer(props: FormRendererProps) {
  const { view, query, pending } = props;
  const visible = view.fields.filter((f) => matches(f, query, pending.get(f.id)));
  const common = visible.filter((f) => f.group === "common");
  const advanced = visible.filter((f) => f.group === "advanced");
  const advancedOpen = query.trim() !== "" || advanced.some((f) => pending.has(f.id) || f.state === "unrecognized");
  return (
    <div className="stack" data-testid="form">
      <p className="small muted" role="status">
        {visible.length === 0 ? ft("search_empty", { query }) : ft("search_count", { count: visible.length, total: view.fields.length })}
      </p>
      <Group view={view} group="common" fields={common} props={props} open />
      {/* Re-keyed by the open state, so a search opens the group without fighting the user's own toggle afterwards. */}
      <Group key={advancedOpen ? "open" : "closed"} view={view} group="advanced" fields={advanced} props={props} open={advancedOpen} />
    </div>
  );
}
