import { useEffect, useMemo, useRef } from "react";
import { ErrorNotice, Loading, Updating, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { DerivedFormView } from "../../forms/derived/DerivedForm";
import { loadForm } from "../../forms/derived/api";
import { useKeyEditor } from "../../forms/derived/editor";
import type { DerivedFormData } from "../../forms/derived/types";
import { t } from "../../i18n";

/** "Editar" on a card asks the editor to come into view: which profile, and a counter so asking twice works. */
export interface ScrollRequest {
  ref: string;
  n: number;
}

/**
 * The profile as a form: name, description, parent, intensity, scope, gates and the sequence, derived from the profile
 * schema (ADR-0009) and written one key at a time. The checks are the tree below (switches and modes), so the `checks`
 * keys stay out of this form. A starter profile cannot be edited here: it says so.
 */
export function ProfileEditor({
  profile,
  id,
  name,
  file,
  writes,
  editable,
  request,
  onHandled,
  onChanged,
}: {
  profile: string;
  id: string;
  name: string;
  file: string;
  /** Counts the writes made outside this form (it reads its file again after each one). */
  writes: number;
  editable: boolean;
  request: ScrollRequest | null;
  onHandled: () => void;
  onChanged: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const section = useRef<HTMLElement>(null);
  const loaded = useAsync(() => loadForm({ file }), `profile-form:${file}:${id}:${writes}`);
  const editor = useKeyEditor(loaded.reload, () => onChanged());

  // "Editar" brings the editor into view and names it: the heading takes the focus.
  useEffect(() => {
    if (!request || request.ref !== profile) return;
    section.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    heading.current?.focus({ preventScroll: true });
    onHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.n, profile]);

  // Only this profile's own keys, and not its checks (the tree below edits those).
  const form = useMemo<DerivedFormData | null>(() => {
    if (!loaded.data) return null;
    const mine = (path: Array<string | number>) => path[0] === "profiles" && String(path[1]) === id && String(path[2]) !== "checks";
    return { ...loaded.data, fields: loaded.data.fields.filter((f) => mine(f.path)), groups: loaded.data.groups.filter((g) => mine(g.path)) };
  }, [loaded.data, id]);
  const under = useMemo(() => ["profiles", id], [id]);

  return (
    <section ref={section} className="card pad stack cfgp-editor" aria-labelledby="cfgp-editor-title" data-testid="profile-editor" data-editing={id}>
      <div>
        <h2 id="cfgp-editor-title" tabIndex={-1} ref={heading}>
          {t("cfgp_editor_title", { name })}
        </h2>
        <p className="small muted">{editable ? t("cfgp_editor_lead", { id, file }) : t("cfgp_editor_starter", { id })}</p>
      </div>
      {!editable ? (
        <div className="notice warn" role="status" data-testid="editor-readonly">
          <Icon name="lock" />
          <span>{t("cfgp_readonly_notice", { profile: id })}</span>
        </div>
      ) : loaded.error && !loaded.data ? (
        <ErrorNotice error={loaded.error} onRetry={loaded.reload} />
      ) : !form ? (
        <Loading />
      ) : (
        <div aria-busy={loaded.reloading ? true : undefined}>
          <Updating active={loaded.reloading} />
          <DerivedFormView form={form} editor={editor} reload={loaded.reload} under={under} headingLevel={3} />
        </div>
      )}
    </section>
  );
}
