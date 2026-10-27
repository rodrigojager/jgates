import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import type { Document } from "yaml";
import { isMap, isNode, isPair, type LineCounter } from "yaml";
import { translator } from "../../../i18n/index.js";
import type { ConfigDiagnostic, DocumentKind } from "./types.js";

/** Kinds with a schema: the configuration documents plus template documents (read by the resolver). */
export type SchemaKind = DocumentKind | "template";

const SCHEMA_FILES: Partial<Record<SchemaKind, string>> = {
  root: "jgates.schema.json",
  workspace: "workspace.schema.json",
  tools: "tools.schema.json",
  policy: "policy.schema.json",
  profiles: "profiles.schema.json",
  pii: "pii.schema.json",
  architecture: "architecture.schema.json",
  template: "template.schema.json",
};

/** jgates/schemas/config, found from dist/core/config/load. */
export function configSchemaDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "schemas", "config");
}

interface AjvError {
  keyword: string;
  instancePath: string;
  schemaPath?: string;
  message?: string;
  params: Record<string, unknown>;
  parentSchema?: { properties?: Record<string, unknown> };
}
type Validate = ((data: unknown) => boolean) & { errors?: AjvError[] | null };
type AjvCtor = new (opts: object) => { compile(schema: object): Validate };

const Ajv = ((Ajv2020Module as unknown as { default?: AjvCtor }).default ?? (Ajv2020Module as unknown as AjvCtor)) as AjvCtor;

const validators = new Map<SchemaKind, Validate>();

/** Strict Ajv: nothing is removed, coerced or defaulted, so the user's values are validated as written. */
function validatorFor(kind: SchemaKind): Validate | undefined {
  const file = SCHEMA_FILES[kind];
  if (!file) return undefined;
  let validate = validators.get(kind);
  if (!validate) {
    const ajv = new Ajv({ allErrors: true, strict: true, verbose: true, removeAdditional: false, coerceTypes: false, useDefaults: false });
    validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(configSchemaDir(), file), "utf8")) as object);
    validators.set(kind, validate);
  }
  return validate;
}

export function hasSchema(kind: SchemaKind): boolean {
  return SCHEMA_FILES[kind] !== undefined;
}

/** Edit distance, for the "did you mean" suggestion. */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j] as number;
      prev[j] = Math.min(above + 1, (prev[j - 1] as number) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return prev[b.length] as number;
}

/** Closest allowed name, when it is close enough to be a probable typo. */
export function suggestName(unknown: string, allowed: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const name of allowed) {
    const d = editDistance(unknown.toLowerCase(), name.toLowerCase());
    if (d < bestDistance) {
      best = name;
      bestDistance = d;
    }
  }
  if (best === undefined) return undefined;
  const limit = Math.max(1, Math.floor(Math.max(unknown.length, best.length) / 3));
  return bestDistance <= limit ? best : undefined;
}

function pointerSegments(instancePath: string): string[] {
  if (instancePath === "") return [];
  return instancePath
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function formatPath(segments: string[]): string {
  let out = "";
  for (const s of segments) {
    if (/^\d+$/.test(s)) out += `[${s}]`;
    else out += out === "" ? s : `.${s}`;
  }
  return out;
}

function locate(doc: Document.Parsed | undefined, lineCounter: LineCounter | undefined, segments: string[], keyOf?: string): { line: number; column: number } | undefined {
  if (!doc || !lineCounter) return undefined;
  let node: unknown = segments.length === 0 ? doc.contents : doc.getIn(segments, true);
  if (keyOf !== undefined && isMap(node)) {
    const pair = node.items.find((p) => isPair(p) && String(isNode(p.key) ? (p.key as { value?: unknown }).value : p.key) === keyOf);
    if (pair && isNode(pair.key)) node = pair.key;
  }
  const range = isNode(node) ? node.range : undefined;
  if (!range) return undefined;
  const pos = lineCounter.linePos(range[0]);
  return { line: pos.line, column: pos.col };
}

/**
 * Validates a parsed document against its schema. Returns schema diagnostics only; reference checks
 * live in the project loader. Kinds without a schema are not checked here.
 */
export function validateDocument(
  kind: SchemaKind,
  value: unknown,
  file: string,
  position?: { doc: Document.Parsed | undefined; lineCounter: LineCounter | undefined },
): ConfigDiagnostic[] {
  const validate = validatorFor(kind);
  if (!validate) return [];
  const t = translator("config");
  validate(value);
  const out: ConfigDiagnostic[] = [];
  for (const error of validate.errors ?? []) {
    // propertyNames reports the failing keyword and then itself; keep the one that names the key.
    if (error.schemaPath?.includes("/propertyNames/") && error.keyword !== "propertyNames") continue;
    let segments = pointerSegments(error.instancePath);
    let code = "SCHEMA_INVALID";
    let message: string;
    let suggestion: string | undefined;
    let keyOf: string | undefined;
    switch (error.keyword) {
      case "additionalProperties": {
        const name = String(error.params.additionalProperty);
        const parent = formatPath(segments);
        const allowed = Object.keys(error.parentSchema?.properties ?? {});
        suggestion = suggestName(name, allowed);
        segments = [...segments, name];
        keyOf = name;
        code = "UNKNOWN_KEY";
        message = suggestion
          ? t("config_unknown_key_suggest", { name, suggestion })
          : t("config_unknown_key", { name, where: parent === "" ? t("config_whole_document") : parent });
        break;
      }
      case "required": {
        const name = String(error.params.missingProperty);
        code = name === "schemaVersion" ? "SCHEMA_VERSION_REQUIRED" : "REQUIRED";
        message = name === "schemaVersion" ? t("config_schema_version_required") : t("config_required", { name });
        segments = [...segments, name];
        break;
      }
      case "const":
        code = "CONST";
        message = t("config_const", { value: JSON.stringify(error.params.allowedValue) });
        break;
      case "enum":
        code = "ENUM";
        message = t("config_enum", { allowed: ((error.params.allowedValues as unknown[]) ?? []).map((v) => JSON.stringify(v)).join(", ") });
        break;
      case "type":
        code = "TYPE";
        message = t("config_type", { expected: String(error.params.type) });
        break;
      case "propertyNames": {
        code = "KEY_NAME";
        const name = String(error.params.propertyName);
        message = t("config_key_name", { name });
        segments = [...segments, name];
        keyOf = name;
        break;
      }
      default:
        message = t("config_schema_detail", { detail: error.message ?? error.keyword });
    }
    const parentOfKey = keyOf !== undefined ? segments.slice(0, -1) : segments;
    const where = locate(position?.doc, position?.lineCounter, parentOfKey, keyOf);
    out.push({
      kind: "schema",
      code,
      file,
      path: formatPath(segments),
      pathSegments: segments,
      message,
      ...(suggestion ? { suggestion } : {}),
      ...(where ?? {}),
    });
  }
  return out;
}
