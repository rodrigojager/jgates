// Which project files the derived forms read and write, and their errors. Only the configuration files of JGates are
// reachable (jgates.yml, the fragments of .jgates/, the templates of .jgates/templates/, the lock read-only), by a
// relative path that must stay inside the project after links are followed.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../../i18n/index.js";
import { kindOfFile, loadConfigSchema, schemaEntryOfKind, type ConfigKind } from "./schemas.js";

const t = translator("forms");

export type DerivedFormErrorCode =
  | "FILE_NOT_CONFIG"
  | "FILE_OUTSIDE_PROJECT"
  | "FILE_GENERATED"
  | "FILE_MISSING"
  | "FILE_PARSE"
  | "REVISION_CONFLICT"
  | "EDIT_INVALID"
  | "EDIT_FAILED"
  | "PATH_INVALID"
  | "VALUE_MISSING"
  | "VALUE_YAML_INVALID"
  | "INSTANCE_NOT_FOUND"
  | "SCHEMA_NOT_FOUND"
  | "ADAPTER_NOT_FOUND";

export class DerivedFormError extends Error {
  constructor(
    readonly code: DerivedFormErrorCode,
    message: string,
    readonly fix: string | null = null,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DerivedFormError";
  }
}

const isInside = (parent: string, child: string): boolean => {
  const r = path.relative(parent, child);
  return r === "" ? false : !r.startsWith("..") && !path.isAbsolute(r);
};

export interface LocatedFile {
  /** Relative path with forward slashes, as given. */
  file: string;
  kind: ConfigKind;
  /** Absolute path (the real path when the file exists). */
  abs: string;
  generated: boolean;
}

/** Resolves a configuration file of the project; refuses anything else and links that leave the project. */
export function locateConfigFile(dir: string, file: string): LocatedFile {
  const normalized = file.replace(/\\/g, "/");
  const kind = normalized.split("/").some((s) => s === ".." || s === "." || s === "") ? null : kindOfFile(normalized);
  if (kind === null || path.isAbsolute(normalized)) throw new DerivedFormError("FILE_NOT_CONFIG", t("forms_derived_file_unknown", { file }), t("forms_derived_file_unknown_fix"), { file });
  const abs = path.join(dir, ...normalized.split("/"));
  let real = abs;
  try {
    real = fs.realpathSync(abs);
    if (!isInside(fs.realpathSync(dir), real)) throw new DerivedFormError("FILE_OUTSIDE_PROJECT", t("forms_derived_file_outside", { file }), null, { file });
  } catch (error) {
    if (error instanceof DerivedFormError) throw error;
    real = abs;
  }
  return { file: normalized, kind, abs: real, generated: kind === "lock" };
}

/** The text a missing file starts from: its schemaVersion, as its schema fixes it. */
export function seedOf(kind: ConfigKind): string | null {
  const entry = schemaEntryOfKind(kind);
  if (!entry || kind === "template" || kind === "lock") return null;
  const props = loadConfigSchema(entry.schema).properties as Record<string, { const?: unknown }> | undefined;
  const version = props?.schemaVersion?.const;
  return typeof version === "number" ? `schemaVersion: ${version}\n` : null;
}
