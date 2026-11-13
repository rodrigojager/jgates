import { DerivedFormView } from "../../forms/derived/DerivedForm";
import { useKeyEditor } from "../../forms/derived/editor";
import type { DerivedField, DerivedFormData } from "../../forms/derived/types";
import { t } from "../../i18n";

// The keys of a declared component that the "Corrigir" dialog does not edit, as the derived form of its entry in
// .jgates/workspace.yml: kind, enabled, include and exclude (folder pickers), the dependency manager and its groups. Each
// key is written alone, with a diff, keeping the comments and the rest of the file.
const DIALOG_KEYS = new Set(["id", "path", "language", "framework"]);
const extraKeys = (field: DerivedField) => field.path.length > 2 && !DIALOG_KEYS.has(String(field.path[2]));

export function ComponentFields({ id, index, form, reload, onWrite }: { id: string; index: number; form: DerivedFormData; reload: () => void; onWrite: () => void }) {
  const editor = useKeyEditor(reload, onWrite);
  return (
    <details className="ws-fields" data-testid="component-fields" data-component-fields={id}>
      <summary>{t("ws_fields_summary", { name: id })}</summary>
      <p className="small muted">{t("ws_fields_lead")}</p>
      <DerivedFormView form={form} editor={editor} reload={reload} under={["components", index]} include={extraKeys} headingLevel={4} />
    </details>
  );
}
