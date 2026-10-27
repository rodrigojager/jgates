import path from "node:path";
import { parseAllDocuments } from "yaml";
import { translator } from "../../i18n/index.js";
import { tomlCodec, TOML_UNAVAILABLE } from "../codecs/toml/index.js";

/**
 * Syntax validation by format, without executing anything: JSON with JSON.parse, YAML with the `yaml` library
 * (parse only, aliases are never expanded), TOML with the sidecar helper when Python is available. Formats without a parser available in the package (TOML, JSONC, INI,
 * XML, JS/TS) answer "unavailable" instead of guessing; JS/TS configuration is never loaded to be checked.
 */

export type DocumentFormat = "json" | "jsonc" | "yaml" | "toml" | "ini" | "xml" | "javascript" | "typescript" | "text";

export interface SyntaxIssue {
  message: string;
  line: number | null;
  column: number | null;
}

export interface ValidationResult {
  format: DocumentFormat;
  /** "unavailable": no syntax check for this format (the text can still be edited and saved). */
  status: "valid" | "invalid" | "unavailable";
  errors: SyntaxIssue[];
  /** Code and message when status is "unavailable". */
  reason: { code: "SYNTAX_VALIDATION_UNAVAILABLE"; message: string } | null;
}

const JSONC_NAMES = /^(tsconfig(\..+)?|jsconfig(\..+)?|devcontainer|\.devcontainer|\.eslintrc|\.babelrc|\.swcrc|settings|extensions|launch|tasks)\.json$/i;

/** Format of a document from its file name. */
export function formatOf(fileName: string): DocumentFormat {
  const base = path.basename(fileName).toLowerCase();
  const ext = path.extname(base);
  if (ext === ".json") return JSONC_NAMES.test(base) ? "jsonc" : "json";
  if (ext === ".jsonc" || ext === ".json5") return "jsonc";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".toml") return "toml";
  if (ext === ".ini" || ext === ".cfg" || base === ".editorconfig" || base === ".flake8" || base === ".pylintrc") return "ini";
  if (ext === ".xml" || ext === ".csproj" || ext === ".props" || ext === ".targets") return "xml";
  if ([".js", ".cjs", ".mjs", ".jsx"].includes(ext)) return "javascript";
  if ([".ts", ".cts", ".mts", ".tsx"].includes(ext)) return "typescript";
  return "text";
}

function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      last = i;
    }
  }
  return { line, column: offset - last };
}

function validateJson(text: string): SyntaxIssue[] {
  try {
    JSON.parse(text);
    return [];
  } catch (error) {
    const message = (error as Error).message;
    const lc = /line (\d+) column (\d+)/.exec(message);
    if (lc) return [{ message, line: Number(lc[1]), column: Number(lc[2]) }];
    const at = /position (\d+)/.exec(message);
    if (at) {
      const { line, column } = lineColumnAt(text, Number(at[1]));
      return [{ message, line, column }];
    }
    return [{ message, line: null, column: null }];
  }
}

function validateYaml(text: string): SyntaxIssue[] {
  const errors: SyntaxIssue[] = [];
  for (const doc of parseAllDocuments(text, { prettyErrors: true })) {
    for (const e of doc.errors) {
      const pos = e.linePos?.[0];
      errors.push({ message: e.message.split("\n")[0] ?? e.message, line: pos?.line ?? null, column: pos?.col ?? null });
    }
  }
  return errors;
}

/** Validates the syntax of `text` as `format`. Never executes the text. */
export function validateText(format: DocumentFormat, text: string): ValidationResult {
  const t = translator("documents");
  if (format === "json") {
    const errors = validateJson(text);
    return { format, status: errors.length ? "invalid" : "valid", errors, reason: null };
  }
  if (format === "yaml") {
    const errors = validateYaml(text);
    return { format, status: errors.length ? "invalid" : "valid", errors, reason: null };
  }
  if (format === "toml") {
    // Checked by the sidecar helper (tomlkit); without Python the answer stays "unavailable".
    const doc = tomlCodec.read(text);
    if (doc.ok) return { format, status: "valid", errors: [], reason: null };
    if (!doc.errors.some((e) => e.code === TOML_UNAVAILABLE)) {
      const errors = doc.errors.map((e) => ({ message: e.message, line: e.line ?? null, column: e.column ?? null }));
      return { format, status: "invalid", errors, reason: null };
    }
  }
  return {
    format,
    status: "unavailable",
    errors: [],
    reason: { code: "SYNTAX_VALIDATION_UNAVAILABLE", message: t("documents_validation_unavailable", { format }) },
  };
}
