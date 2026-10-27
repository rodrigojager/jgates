import fs from "node:fs";
import { LineCounter, parseDocument, type Document } from "yaml";
import { translator } from "../../../i18n/index.js";
import { DEFAULT_LIMITS, type ConfigDiagnostic, type YamlLimits } from "./types.js";

export interface ParsedYaml {
  /** Plain JS value; undefined when there is a syntax or limit problem. */
  value: unknown;
  /** Parsed document, kept to map field paths back to lines. */
  doc: Document.Parsed | undefined;
  lineCounter: LineCounter;
  diagnostics: ConfigDiagnostic[];
}

function measureDepth(value: unknown, limit: number, depth = 1): number {
  if (depth > limit) return depth;
  let max = depth;
  if (Array.isArray(value)) {
    for (const item of value) max = Math.max(max, measureDepth(item, limit, depth + 1));
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) max = Math.max(max, measureDepth(item, limit, depth + 1));
  }
  return max;
}

/** Cheap pre-scan of flow nesting so a hostile `[[[[...` never reaches the parser's recursion. */
function flowDepthExceeds(text: string, limit: number): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x5b || c === 0x7b) {
      depth++;
      if (depth > limit) return true;
    } else if ((c === 0x5d || c === 0x7d) && depth > 0) depth--;
    else if (c === 0x0a) depth = 0;
  }
  return false;
}

/**
 * Parses YAML safely: core schema only (no custom tags, so nothing can execute code or build objects),
 * unique keys, a size limit, a depth limit and an alias limit. Never throws.
 */
export function parseYamlText(text: string, file: string, limits: YamlLimits = DEFAULT_LIMITS): ParsedYaml {
  const t = translator("config");
  const lineCounter = new LineCounter();
  const diagnostics: ConfigDiagnostic[] = [];
  const fail = (code: string, message: string, extra: Partial<ConfigDiagnostic> = {}): ParsedYaml => {
    diagnostics.push({ kind: "syntax", code, file, path: "", pathSegments: [], message, ...extra });
    return { value: undefined, doc: undefined, lineCounter, diagnostics };
  };

  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > limits.maxBytes) return fail("YAML_TOO_LARGE", t("config_yaml_too_large", { size: bytes, limit: limits.maxBytes }));
  if (flowDepthExceeds(text, limits.maxDepth)) return fail("YAML_TOO_DEEP", t("config_yaml_too_deep", { limit: limits.maxDepth }));

  let doc: Document.Parsed;
  try {
    doc = parseDocument(text, {
      lineCounter,
      schema: "core",
      version: "1.2",
      uniqueKeys: true,
      merge: false,
      prettyErrors: false,
    });
  } catch (error) {
    if (error instanceof RangeError) return fail("YAML_TOO_DEEP", t("config_yaml_too_deep", { limit: limits.maxDepth }));
    return fail("YAML_SYNTAX", t("config_yaml_syntax", { detail: (error as Error).message }));
  }

  for (const err of doc.errors) {
    const pos = err.linePos?.[0];
    diagnostics.push({
      kind: "syntax",
      code: err.code === "DUPLICATE_KEY" ? "YAML_DUPLICATE_KEY" : "YAML_SYNTAX",
      file,
      path: "",
      pathSegments: [],
      message: t("config_yaml_syntax", { detail: err.message.split("\n")[0] ?? err.code }),
      ...(pos ? { line: pos.line, column: pos.col } : {}),
    });
  }
  // An unresolved tag (!!js/function, !ruby/object, ...) is only a warning for the parser: refuse it here.
  for (const warning of doc.warnings) {
    if (warning.code !== "TAG_RESOLVE_FAILED") continue;
    const pos = warning.linePos?.[0];
    diagnostics.push({
      kind: "syntax",
      code: "YAML_TAG_FORBIDDEN",
      file,
      path: "",
      pathSegments: [],
      message: t("config_yaml_tag_forbidden", { detail: warning.message.split("\n")[0] ?? "" }),
      ...(pos ? { line: pos.line, column: pos.col } : {}),
    });
  }
  if (diagnostics.length > 0) return { value: undefined, doc, lineCounter, diagnostics };

  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: limits.maxAliases });
  } catch (error) {
    if (error instanceof RangeError) return fail("YAML_TOO_DEEP", t("config_yaml_too_deep", { limit: limits.maxDepth }));
    return fail("YAML_ALIAS_LIMIT", t("config_yaml_alias_limit", { limit: limits.maxAliases }));
  }
  if (measureDepth(value, limits.maxDepth) > limits.maxDepth) {
    return fail("YAML_TOO_DEEP", t("config_yaml_too_deep", { limit: limits.maxDepth }));
  }
  return { value, doc, lineCounter, diagnostics };
}

/** Reads and parses a YAML file; an unreadable file is a syntax-level diagnostic. */
export function parseYamlFile(absolute: string, file: string, limits: YamlLimits = DEFAULT_LIMITS): ParsedYaml {
  const t = translator("config");
  let size: number;
  try {
    size = fs.statSync(absolute).size;
  } catch (error) {
    return {
      value: undefined,
      doc: undefined,
      lineCounter: new LineCounter(),
      diagnostics: [{ kind: "syntax", code: "FILE_UNREADABLE", file, path: "", pathSegments: [], message: t("config_file_unreadable", { detail: (error as Error).message }) }],
    };
  }
  // Check the size before reading so a huge file is never loaded into memory.
  if (size > limits.maxBytes) {
    return {
      value: undefined,
      doc: undefined,
      lineCounter: new LineCounter(),
      diagnostics: [{ kind: "syntax", code: "YAML_TOO_LARGE", file, path: "", pathSegments: [], message: t("config_yaml_too_large", { size, limit: limits.maxBytes }) }],
    };
  }
  let text: string;
  try {
    text = fs.readFileSync(absolute, "utf8");
  } catch (error) {
    return {
      value: undefined,
      doc: undefined,
      lineCounter: new LineCounter(),
      diagnostics: [{ kind: "syntax", code: "FILE_UNREADABLE", file, path: "", pathSegments: [], message: t("config_file_unreadable", { detail: (error as Error).message }) }],
    };
  }
  return parseYamlText(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, file, limits);
}
