// Calls of the derived forms: the form, the preview and the save of one key, and the whole-file read and write the undo
// uses (the YAML screen's routes, so an undo restores the exact bytes the file had before the last save).
import { ApiError, api } from "../../api";
import type { DerivedFormData, FormSource, KeyEditPreview, KeyEditRequest, KeyEditSave, KeyPath } from "./types";

export const formKey = (source: FormSource): string => ("file" in source ? `file:${source.file}` : `instance:${source.instance}`);

export function formUrl(source: FormSource): string {
  return "file" in source ? `/api/forms/derived/file?file=${encodeURIComponent(source.file)}` : `/api/forms/derived/instance/${encodeURIComponent(source.instance)}`;
}

export async function loadForm(source: FormSource): Promise<DerivedFormData> {
  return (await api<{ form: DerivedFormData }>("GET", formUrl(source))).form;
}

export async function previewKey(request: KeyEditRequest): Promise<KeyEditPreview> {
  return (await api<{ preview: KeyEditPreview }>("POST", "/api/forms/derived/key/preview", request)).preview;
}

export async function saveKey(request: KeyEditRequest): Promise<KeyEditSave> {
  return (await api<{ save: KeyEditSave }>("PUT", "/api/forms/derived/key", request)).save;
}

/** The text and revision of a configuration file; null when it does not exist yet. */
export async function readFileText(file: string): Promise<{ text: string; revision: string } | null> {
  try {
    const view = await api<{ text: string; revision: string }>("GET", `/api/config/yaml/file?file=${encodeURIComponent(file)}`);
    return { text: view.text, revision: view.revision };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Writes back the bytes a file had (the undo), only while the file is still at `expectedRevision`. */
export async function restoreFile(file: string, text: string, expectedRevision: string): Promise<{ revision: string }> {
  return api<{ revision: string }>("PUT", "/api/config/yaml/file", { file, text, expectedRevision, allowInvalid: true });
}

/** A query value that keeps "/" readable (the YAML screen decodes it with URLSearchParams). */
const queryValue = (s: string): string => encodeURIComponent(s).replace(/%2F/g, "/");

/** The YAML editor at a key: #/config/yaml?file=<file>&path=<key path> (T17 opens the file at that key). */
export function yamlHref(file: string, path: string): string {
  return `#/config/yaml?file=${queryValue(file)}${path ? `&path=${queryValue(path)}` : ""}`;
}

/** The dotted text of a key path (list indexes in brackets), as the server writes it. */
export function pathText(path: KeyPath): string {
  let out = "";
  for (const seg of path) out += typeof seg === "number" ? `[${seg}]` : out === "" ? seg : `.${seg}`;
  return out;
}
