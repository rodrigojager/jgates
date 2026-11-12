import { useMemo, type ReactNode } from "react";
import { ErrorNotice, Loading, Pill, Updating, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { ft } from "../i18n";
import { formKey, loadForm, pathText, yamlHref } from "./api";
import { FieldControl, labelFor } from "./controls";
import { ReviewDialog, UndoBar, useKeyEditor, type KeyEditor, type WriteEvent } from "./editor";
import { display, editIsNoop, fieldTitle, groupTitle, isWritten, originText, removeRequest, setRequest } from "./model";
import type { DerivedField, DerivedFormData, DerivedGroup, FieldEdit, FormSource, KeyPath } from "./types";
import "../forms.css";
import "./derived.css";

// The derived form (ADR-0009): any configuration file, or one tool instance, rendered from what the server derives of
// its JSON schema and of the file as it is. Every key gets the control of its widget, the keys the schema does not know
// come as custom text fields, each value says where it comes from, can go back to what it inherits and opens the YAML
// editor at its key. Writes are per key, reviewed as a diff (a switch saves at once and offers the undo).
//
// Reuse (T13-T16 put it in the guided screens):
//   <DerivedForm source={{ instance: "zizmor" }} />                 the settings of a tool instance
//   <DerivedForm source={{ file: "jgates.yml" }} under={["execution"]} />   one section of a file
//   <DerivedForm source={{ file: ".jgates/pii.yml" }} include={(f) => f.path[0] !== "schemaVersion"} onWrite={...} />
// A screen that already holds the form data renders <DerivedFormView form={data} editor={useKeyEditor(reload)} />.

export interface DerivedFormProps {
  /** What to edit: a configuration file of the project ({ file }) or a tool instance ({ instance }). */
  source: FormSource;
  /** Only the keys under this key path (["execution"], ["tools", "zap", "auth"]); the whole form by default. */
  under?: KeyPath;
  /** Keeps only the fields this accepts (after `under`). */
  include?: (field: DerivedField) => boolean;
  /** Shows the values without any control that writes. */
  readOnly?: boolean;
  /** After each write (a save or an undo), with the new revision of the file. */
  onWrite?: (event: WriteEvent) => void;
  /** Heading level of the top groups (3 by default; nested groups go one level down, up to 6). */
  headingLevel?: 2 | 3 | 4;
}

const domId = (id: string) => `df-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

const startsWith = (path: KeyPath, prefix: KeyPath) => prefix.length <= path.length && prefix.every((s, i) => String(path[i]) === String(s));

function Heading({ level, id, children }: { level: number; id: string; children: ReactNode }) {
  const L = Math.min(6, Math.max(2, level));
  if (L === 2) return <h2 id={id}>{children}</h2>;
  if (L === 3) return <h3 id={id}>{children}</h3>;
  if (L === 4) return <h4 id={id}>{children}</h4>;
  if (L === 5) return <h5 id={id}>{children}</h5>;
  return <h6 id={id}>{children}</h6>;
}

interface RenderContext {
  form: DerivedFormData;
  editor: KeyEditor;
  readOnly: boolean;
  fields: DerivedField[];
  groups: DerivedGroup[];
}

/** The value of a field a `showWhen` names (an overlay's field name inside the same section). */
function visible(field: DerivedField, ctx: RenderContext): boolean {
  const cond = field.showWhen;
  if (!cond) return true;
  const other = ctx.fields.find((f) => f.group === field.group && (f.id === cond.field || f.id.endsWith(`.${cond.field}`)));
  if (!other) return true;
  const edit = ctx.editor.edits.get(other.id);
  const value = edit && "value" in edit ? edit.value : other.value;
  return JSON.stringify(value) === JSON.stringify(cond.equals);
}

function FieldRow({ field, ctx, level }: { field: DerivedField; ctx: RenderContext; level: number }) {
  const { form, editor } = ctx;
  const id = domId(field.id);
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  const title = fieldTitle(field);
  const edit = editor.edits.get(field.id);
  const pending = edit !== undefined && !editIsNoop(field, edit);
  const writable = !ctx.readOnly && form.file.editable && form.available;
  const disabled = !writable || field.widget === "readonly";
  const failure = editor.failures.get(field.id);
  const children = ctx.fields.filter((f) => f.group === field.id);
  const inherited = field.state === "inherited";
  return (
    <div className={`df-field${pending ? " changed" : ""}`} data-field={field.id} data-state={field.state} data-widget={field.widget} data-pending={pending ? "true" : undefined}>
      <div className="df-field-head">
        {labelFor(field) ? (
          <label id={labelId} htmlFor={id} className="field-label">
            {title}
          </label>
        ) : (
          <span id={labelId} className="field-label">
            {title}
          </span>
        )}
        {field.label.secondary !== title ? <code className="muted df-key">{field.label.secondary}</code> : null}
        {field.state === "custom" ? <Pill tone="blue">{ft("df_state_custom")}</Pill> : null}
        {field.state === "invalid" ? <Pill tone="red">{ft("df_state_invalid")}</Pill> : null}
        {field.foreign ? <Pill tone="gold">{ft("df_state_foreign")}</Pill> : null}
        {pending ? <Pill tone="gold">{ft("df_state_pending")}</Pill> : null}
      </div>
      <p className="small muted df-help" id={helpId}>
        {field.state === "custom" ? ft("df_custom_help") : (field.help ?? "")}
      </p>
      <FieldControl
        field={field}
        id={id}
        labelId={labelId}
        helpId={helpId}
        title={title}
        edit={edit}
        disabled={disabled}
        busy={editor.busy.has(field.id)}
        onEdit={(next) => editor.setEdit(field, editIsNoop(field, next) ? null : next)}
        onSwitch={(value) => void editor.saveNow(field, title, setRequest(form, field, { value }))}
      />
      {field.diagnostics.length > 0 ? (
        <div className="notice warn df-diagnostics" role="note">
          <Icon name="alert" />
          <ul className="df-problems">
            {field.diagnostics.map((d, i) => (
              <li key={`${d.code}-${i}`}>
                {d.message}
                {d.line ? <span className="muted"> {ft("df_line", { line: d.line })}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {failure ? <ErrorNotice error={failure} /> : null}
      <p className="small df-origin" data-testid="df-origin" data-origin={field.origin.kind}>
        <span>{originText(field, form)}</span>
        {inherited ? <span className="muted">{` ${display(field.value) ? ft("df_inherited_value", { value: display(field.value) }) : ft("df_inherited_none")}`}</span> : null}
        {field.origin.kind !== "file" && field.origin.file ? (
          <>
            {" "}
            <code>{field.origin.file}</code>
            {field.origin.path ? (
              <>
                {" "}
                <code>{field.origin.path}</code>
              </>
            ) : null}
          </>
        ) : null}
      </p>
      <div className="row wrap df-actions">
        {pending && writable ? (
          <>
            <button type="button" className="btn primary" aria-label={`${ft("df_review_save")}: ${title}`} onClick={() => editor.review(field, title, setRequest(form, field, edit as FieldEdit))}>
              {ft("df_review_save")}
            </button>
            <button type="button" className="btn" aria-label={`${ft("df_discard")}: ${title}`} onClick={() => editor.setEdit(field, null)}>
              {ft("df_discard")}
            </button>
          </>
        ) : null}
        {isWritten(field) && writable && field.widget !== "readonly" ? (
          <button type="button" className="btn" aria-label={`${ft("df_inherit")}: ${title}`} onClick={() => editor.review(field, title, removeRequest(form, field))}>
            {ft("df_inherit")}
          </button>
        ) : null}
        <a className="btn link-btn df-yaml-link" href={yamlHref(field.link.file || form.file.file, field.link.path || field.id)} aria-label={`${ft("df_edit_yaml")}: ${title}`}>
          <Icon name="file" />
          {ft("df_edit_yaml")}
        </a>
      </div>
      {children.length > 0 ? (
        <div className="df-nested">
          <Children parent={field.id} ctx={ctx} level={level + 1} />
        </div>
      ) : null}
    </div>
  );
}

function GroupSection({ group, ctx, level }: { group: DerivedGroup; ctx: RenderContext; level: number }) {
  const headingId = `${domId(group.id)}-heading`;
  const title = groupTitle(group);
  const empty = !ctx.fields.some((f) => startsWith(f.path, group.path)) && !ctx.groups.some((g) => g.group === group.id);
  return (
    <section className={`df-group df-group-${group.kind}`} aria-labelledby={headingId} data-group={group.id} data-kind={group.kind}>
      <div className="df-group-head">
        <Heading level={level} id={headingId}>
          {title}
        </Heading>
        {group.label.secondary !== title ? <code className="muted df-key">{group.label.secondary}</code> : null}
        <a className="link-btn small" href={yamlHref(group.link.file || ctx.form.file.file, group.link.path || group.id)} aria-label={`${ft("df_edit_yaml")}: ${title}`}>
          {ft("df_edit_yaml")}
        </a>
      </div>
      {group.help ? <p className="small muted">{group.help}</p> : null}
      {empty ? <p className="small muted">{group.kind === "map" ? ft("df_map_empty") : group.kind === "array" ? ft("df_array_empty") : ft("df_group_empty")}</p> : null}
      <Children parent={group.id} ctx={ctx} level={level + 1} />
    </section>
  );
}

function Children({ parent, ctx, level }: { parent: string; ctx: RenderContext; level: number }) {
  const fields = ctx.fields.filter((f) => f.group === parent && visible(f, ctx));
  const groups = ctx.groups.filter((g) => g.group === parent);
  return (
    <>
      {fields.map((f) => (
        <FieldRow key={f.id} field={f} ctx={ctx} level={level} />
      ))}
      {groups.map((g) => (
        <GroupSection key={g.id} group={g} ctx={ctx} level={level} />
      ))}
    </>
  );
}

export interface DerivedFormViewProps {
  form: DerivedFormData;
  editor: KeyEditor;
  /** Reads the form again (the conflict notice offers it). */
  reload: () => void;
  under?: KeyPath;
  include?: (field: DerivedField) => boolean;
  readOnly?: boolean;
  headingLevel?: 2 | 3 | 4;
}

/** The form for data already loaded (the screen owns the request); see DerivedForm for the usual case. */
export function DerivedFormView({ form, editor, reload, under, include, readOnly, headingLevel }: DerivedFormViewProps) {
  const ctx = useMemo<RenderContext>(() => {
    const prefix = under ?? (form.section as KeyPath | undefined) ?? [];
    const fields = form.fields.filter((f) => startsWith(f.path, prefix) && (!include || include(f)));
    const groups = form.groups.filter((g) => startsWith(g.path, prefix) && g.path.length > 0);
    return { form, editor, readOnly: readOnly === true, fields, groups };
  }, [form, editor, under, include, readOnly]);
  // The top of the tree: the group at the prefix when there is one, else whatever has no shown parent.
  const ids = new Set([...ctx.groups.map((g) => g.id), ...ctx.fields.map((f) => f.id)]);
  const prefix = pathText(under ?? (form.section as KeyPath | undefined) ?? []);
  const rootFields = ctx.fields.filter((f) => !ids.has(f.group) || f.group === prefix);
  const rootGroups = ctx.groups.filter((g) => g.id !== prefix && (!ids.has(g.group) || g.group === prefix));
  const level = headingLevel ?? 3;
  const editable = form.file.editable && !readOnly;
  return (
    <div className="stack df-form" data-testid="derived-form" data-file={form.file.file} data-revision={form.file.revision ?? ""}>
      <div className="row wrap df-file">
        <Icon name="file" />
        <code>{form.file.file}</code>
        {!form.file.exists ? <Pill tone="blue">{ft("df_file_missing")}</Pill> : null}
        {!editable ? <Pill>{ft("df_read_only")}</Pill> : null}
      </div>
      {!form.available ? (
        <div className="notice error" role="alert" data-testid="df-unavailable">
          <Icon name="alert" />
          <div className="stack tight">
            <strong>{ft("df_unavailable_title")}</strong>
            {form.diagnostics.map((d, i) => (
              <p key={`${d.code}-${i}`} className="small">
                {d.message}
                {d.line ? ` ${ft("df_line", { line: d.line })}` : ""}
              </p>
            ))}
            <a className="btn link-btn" href={yamlHref(form.file.file, "")}>
              <Icon name="file" />
              {ft("df_edit_yaml")}
            </a>
          </div>
        </div>
      ) : null}
      <UndoBar editor={editor} />
      <div className="df-tree">
        {rootFields.filter((f) => visible(f, ctx)).map((f) => (
          <FieldRow key={f.id} field={f} ctx={ctx} level={level} />
        ))}
        {rootGroups.map((g) => (
          <GroupSection key={g.id} group={g} ctx={ctx} level={level} />
        ))}
      </div>
      <ReviewDialog editor={editor} onReload={reload} />
    </div>
  );
}

/** Loads the derived form of a file or tool instance and renders it with the per-key write model. */
export function DerivedForm({ source, under, include, readOnly, onWrite, headingLevel }: DerivedFormProps) {
  const key = formKey(source);
  const loaded = useAsync(() => loadForm(source), `derived-form:${key}`);
  const editor = useKeyEditor(loaded.reload, onWrite);
  if (loaded.loading && !loaded.data) return <Loading />;
  if (loaded.error && !loaded.data) return <ErrorNotice error={loaded.error} onRetry={loaded.reload} />;
  if (!loaded.data) return null;
  return (
    <div className="stack" aria-busy={loaded.reloading ? true : undefined}>
      <Updating active={loaded.reloading} />
      <DerivedFormView form={loaded.data} editor={editor} reload={loaded.reload} {...(under ? { under } : {})} {...(include ? { include } : {})} readOnly={readOnly === true} {...(headingLevel ? { headingLevel } : {})} />
    </div>
  );
}
