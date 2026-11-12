// One key at a time (ADR-0009): set or remove one key path of one configuration file, with the revision the form was
// read from. The YAML codec patches only that key (comments, key order, quoting and unknown keys stay byte for byte),
// the result must not bring a syntax or schema problem the file did not already have, and a preview gives the diff
// without writing anything.
import { patchYamlFile, patchYamlText, readRevision, YamlPatchError, type YamlEdit } from "../../codecs/yaml/index.js";
import { parseYamlText, validateDocument } from "../../config/load/index.js";
import type { ResolveResult } from "../../config/resolve/index.js";
import { unifiedDiff } from "../../documents/diff.js";
import { translator } from "../../../i18n/index.js";
import type { JsonSchema } from "../types.js";
import { describe, patternOf } from "./fields.js";
import { DerivedFormError, locateConfigFile, seedOf, type LocatedFile } from "./files.js";
import { loadConfigSchema, schemaEntryOfKind, type ConfigKind } from "./schemas.js";
import type { KeyEditPreview, KeyEditRequest, KeyEditSave } from "./types.js";

const t = translator("forms");
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const BOM = "﻿";
const MAX_PATH = 32;

export interface KeyEditOptions {
  /** The effective configuration: an instance a template declares gets its adapter written with its first key. */
  resolved?: ResolveResult | null;
}

function problemsOf(kind: ConfigKind, file: string, text: string): Array<{ path: string; code: string; message: string }> {
  const parsed = parseYamlText(text.startsWith(BOM) ? text.slice(1) : text, file);
  const all = [...parsed.diagnostics];
  if (parsed.value !== undefined && parsed.diagnostics.length === 0) {
    if (isObject(parsed.value)) all.push(...validateDocument(kind as Parameters<typeof validateDocument>[0], parsed.value, file, { doc: parsed.doc, lineCounter: parsed.lineCounter }));
  }
  return all.map((d) => ({ path: d.path, code: d.code, message: d.message }));
}

function checkPath(path: ReadonlyArray<string | number>): void {
  const bad = (detail: string) => new DerivedFormError("PATH_INVALID", t("forms_derived_path_invalid", { detail }), null, { path });
  if (!Array.isArray(path) || path.length === 0) throw bad("empty");
  if (path.length > MAX_PATH) throw bad(`longer than ${MAX_PATH}`);
  for (const s of path) {
    if (typeof s === "number" ? !Number.isInteger(s) || s < 0 : typeof s !== "string" || s === "") throw bad(JSON.stringify(s));
  }
}

function valueOf(request: KeyEditRequest): unknown {
  if ("value" in request && request.value !== undefined) return request.value;
  if (typeof request.yaml === "string") {
    const parsed = parseYamlText(request.yaml, "value");
    if (parsed.diagnostics.length > 0) throw new DerivedFormError("VALUE_YAML_INVALID", t("forms_derived_yaml_invalid", { detail: parsed.diagnostics[0]?.message ?? "-" }), null);
    return parsed.value === undefined ? null : parsed.value;
  }
  throw new DerivedFormError("VALUE_MISSING", t("forms_derived_value_missing", { path: patternOf(request.path) }), null);
}

/** The schema kind of the containers along a path: an object of declared keys, a map entry, a list item. */
function containerKinds(root: JsonSchema, path: ReadonlyArray<string | number>): Array<"object" | "map" | "array" | null> {
  const out: Array<"object" | "map" | "array" | null> = [];
  let node: unknown = root;
  for (let i = 0; i < path.length; i++) {
    const d = describe(node, root, String(path[i - 1] ?? ""));
    out.push(d.group ?? null);
    const seg = path[i] as string | number;
    if (d.group === "object") node = (d.properties ?? {})[String(seg)];
    else if (d.group === "map") node = d.entry;
    else if (d.group === "array") node = d.item;
    else if (d.branches) {
      const branch = d.branches.map((b) => describe(b, root, "")).find((b) => b.group === "object" && (b.properties ?? {})[String(seg)] !== undefined);
      out[out.length - 1] = branch ? "object" : null;
      node = branch ? (branch.properties ?? {})[String(seg)] : undefined;
    } else node = undefined;
    if (node === undefined) {
      while (out.length < path.length) out.push(null);
      break;
    }
  }
  return out;
}

function getIn(root: unknown, path: ReadonlyArray<string | number>): { found: boolean; value: unknown } {
  let node = root;
  for (const s of path) {
    if (Array.isArray(node) && typeof s === "number" && s < node.length) node = node[s];
    else if (isObject(node) && typeof s === "string" && Object.prototype.hasOwnProperty.call(node, s)) node = node[s];
    else return { found: false, value: undefined };
  }
  return { found: true, value: node };
}

interface Planned {
  located: LocatedFile;
  base: string;
  exists: boolean;
  revision: string | null;
  edits: YamlEdit[];
  pruned: string[];
  text: string;
  changed: boolean;
  seed: string | null;
}

function plan(dir: string, request: KeyEditRequest, options: KeyEditOptions): Planned {
  const located = locateConfigFile(dir, request.file);
  if (located.generated) throw new DerivedFormError("FILE_GENERATED", t("forms_derived_file_generated", { file: located.file }), null, { file: located.file });
  checkPath(request.path);
  const rev = readRevision(located.abs);
  if (rev.hash !== request.expectedRevision) {
    throw new DerivedFormError("REVISION_CONFLICT", t("forms_derived_conflict", { file: located.file }), t("forms_derived_conflict_fix"), { file: located.file, currentRevision: rev.hash, expectedRevision: request.expectedRevision });
  }
  const seed = seedOf(located.kind);
  if (!rev.exists && seed === null) throw new DerivedFormError("FILE_MISSING", t("forms_derived_file_missing", { file: located.file }), t("forms_derived_file_missing_fix"), { file: located.file });
  const base = rev.exists ? rev.text : (seed as string);
  const parsed = parseYamlText(base.startsWith(BOM) ? base.slice(1) : base, located.file);
  if (parsed.value === undefined || parsed.diagnostics.length > 0) {
    throw new DerivedFormError("FILE_PARSE", t("forms_derived_parse", { file: located.file, detail: parsed.diagnostics[0]?.message ?? "-" }), t("forms_derived_parse_fix"), { file: located.file, line: parsed.diagnostics[0]?.line ?? null });
  }
  const current = parsed.value;
  const path = [...request.path];
  const edits: YamlEdit[] = [];
  const pruned: string[] = [];
  if (request.op === "set") {
    const value = valueOf(request);
    // The first key of an instance a template declares creates its entry with the template's adapter.
    if (located.kind === "tools" && path[0] === "tools" && typeof path[1] === "string" && path.length >= 3 && path[2] !== "adapter" && !getIn(current, ["tools", path[1]]).found) {
      const declared = options.resolved && isObject(options.resolved.config.tools) ? options.resolved.config.tools[path[1]] : undefined;
      if (isObject(declared) && typeof declared.adapter === "string") edits.push({ op: "set", path: ["tools", path[1], "adapter"], value: declared.adapter });
    }
    edits.push({ op: "set", path, value });
  } else if (getIn(current, path).found) {
    // A removal that leaves a block of declared keys empty (execution: {}) removes the block too; an entry of a map or
    // an item of a list stays (it is an id the person wrote, not a container).
    const root = loadConfigSchema((schemaEntryOfKind(located.kind) as { schema: string }).schema);
    const kinds = containerKinds(root, path);
    // kinds[i] is the kind of the container that holds path[i] (kinds[0]: the document).
    let target = path;
    while (target.length >= 2) {
      const parentPath = target.slice(0, -1);
      const parent = getIn(current, parentPath).value;
      if (!isObject(parent) || Object.keys(parent).length !== 1) break;
      // The parent is a block of declared keys, held under a declared key itself (not a map entry, not a list item).
      if (kinds[parentPath.length] !== "object" || kinds[parentPath.length - 1] !== "object") break;
      pruned.push(patternOf(parentPath));
      target = parentPath;
    }
    edits.push({ op: "delete", path: target });
  }
  let text = base;
  if (edits.length > 0) {
    try {
      text = patchYamlText(base, edits).text;
    } catch (error) {
      if (error instanceof YamlPatchError) throw new DerivedFormError("EDIT_FAILED", t("forms_derived_patch_failed", { file: located.file, detail: error.message }), null, { reason: error.code });
      throw error;
    }
  }
  return { located, base, exists: rev.exists, revision: rev.hash, edits, pruned, text, changed: !rev.exists || text !== base, seed };
}

function newProblems(p: Planned): Array<{ path: string; code: string; message: string }> {
  const key = (x: { path: string; code: string; message: string }) => `${x.path}|${x.code}|${x.message}`;
  const before = new Set((p.exists ? problemsOf(p.located.kind, p.located.file, p.base) : []).map(key));
  return problemsOf(p.located.kind, p.located.file, p.text).filter((x) => !before.has(key(x)));
}

/** The diff of one key edit and the problems it would bring, without writing. */
export function previewKeyEdit(dir: string, request: KeyEditRequest, options: KeyEditOptions = {}): KeyEditPreview {
  const p = plan(dir, request, options);
  const problems = newProblems(p);
  const before = p.exists ? p.base : "";
  return {
    status: "ok",
    file: p.located.file,
    revision: p.revision,
    changed: p.changed && p.edits.length > 0,
    diff: p.edits.length > 0 ? unifiedDiff(before, p.text) : "",
    text: p.text,
    pruned: p.pruned,
    problems,
    writable: problems.length === 0,
  };
}

/** Writes one key edit when the file still has the revision that was read and the result brings no new problem. */
export function saveKeyEdit(dir: string, request: KeyEditRequest, options: KeyEditOptions = {}): KeyEditSave {
  const p = plan(dir, request, options);
  if (p.edits.length === 0 || !p.changed) return { status: "unchanged", file: p.located.file, revision: p.revision, changed: false, diff: "", pruned: [] };
  const problems = newProblems(p);
  if (problems.length > 0) {
    const first = problems[0] as { path: string; code: string; message: string };
    throw new DerivedFormError("EDIT_INVALID", t("forms_derived_invalid", { file: p.located.file, path: first.path || "-", message: first.message }), t("forms_derived_invalid_fix"), { file: p.located.file, problems });
  }
  try {
    const written = patchYamlFile(p.located.abs, p.edits, { expectedHash: p.revision, ...(p.exists ? {} : { createWith: p.seed as string }) });
    if (!written.changed) return { status: "unchanged", file: p.located.file, revision: written.hash, changed: false, diff: "", pruned: [] };
    return { status: "saved", file: p.located.file, previousRevision: p.revision, revision: written.hash, changed: true, diff: unifiedDiff(p.exists ? p.base : "", p.text), pruned: p.pruned };
  } catch (error) {
    if (error instanceof YamlPatchError) {
      if (error.code === "YAML_CONFLICT") {
        throw new DerivedFormError("REVISION_CONFLICT", t("forms_derived_conflict", { file: p.located.file }), t("forms_derived_conflict_fix"), { file: p.located.file, currentRevision: readRevision(p.located.abs).hash, expectedRevision: request.expectedRevision });
      }
      throw new DerivedFormError("EDIT_FAILED", t("forms_derived_patch_failed", { file: p.located.file, detail: error.message }), null, { reason: error.code });
    }
    throw error;
  }
}


