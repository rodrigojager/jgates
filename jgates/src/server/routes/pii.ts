// PII settings by patch: the screen reads the state of each entity (file, effective and "not supported") and writes
// only what the user changed into .jgates/pii.yml, keeping comments and the rest of the file. A change the
// detector cannot honor is refused with the reason; nothing is dropped in silence.
import fs from "node:fs";
import path from "node:path";
import { SUPPORTED_ENTITIES, UNSUPPORTED_ENTITIES, SEVERITIES, entityStates } from "../../adapters/builtin-pii/settings.js";
import { patchYamlFile, patchYamlText, readRevision, YamlPatchError, type YamlEdit } from "../../core/codecs/yaml/index.js";
import { parseYamlText, validateDocument } from "../../core/config/load/index.js";
import { resolveConfig } from "../../core/config/resolve/index.js";
import { resolveSelection } from "../../core/selection/index.js";
import { translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";

const FILE = ".jgates/pii.yml";
const SUPPORTED_LOCALES = ["pt-BR"];
const REMEDIATION_MODES = ["none"];
const SEED = "schemaVersion: 1\n";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function describe(server: ServerContext): Rec {
  const abs = path.join(server.projectDir, FILE);
  const revision = readRevision(abs);
  const parsed = revision.exists ? parseYamlText(revision.text, FILE) : null;
  const written = parsed && isRec(parsed.value) ? parsed.value : {};
  const resolved = resolveConfig(server.projectDir);
  const selection = resolved.ok ? resolveSelection(resolved, {}) : undefined;
  const states = entityStates(resolved.ok ? resolved.config : { pii: written }, selection?.ok ? selection : undefined);
  const writtenEntities = isRec(written.entities) ? written.entities : {};
  const detection = isRec(written.detection) ? written.detection : {};
  const reporting = isRec(written.reporting) ? written.reporting : {};
  const remediation = isRec(written.remediation) ? written.remediation : {};
  const rows: Rec[] = [
    ...states.map((s) => {
      const raw = writtenEntities[s.id];
      const own: Rec = isRec(raw) ? raw : {};
      return {
        id: s.id,
        supported: true,
        enabled: s.enabled,
        severity: s.severity,
        decidedBy: s.decidedBy,
        source: s.source,
        // Whether the file says it: a decision of a profile or of this run alone is shown, not rewritten.
        inFile: { enabled: typeof own.enabled === "boolean" ? own.enabled : null, severity: typeof own.severity === "string" ? own.severity : null },
      };
    }),
    ...UNSUPPORTED_ENTITIES.map((id) => ({ id, supported: false })),
  ];
  return {
    schemaVersion: 1,
    status: "OK",
    file: FILE,
    exists: revision.exists,
    revision: revision.hash,
    valid: parsed ? parsed.diagnostics.length === 0 : true,
    instanceEnabled: typeof written.enabled === "boolean" ? written.enabled : null,
    entities: rows,
    detection: {
      locale: typeof detection.locale === "string" ? detection.locale : "pt-BR",
      validateCheckDigits: detection.validateCheckDigits === true,
    },
    reporting: { redactMatchedValues: reporting.redactMatchedValues !== false },
    remediation: { mode: typeof remediation.mode === "string" ? remediation.mode : "none" },
    supported: { locales: SUPPORTED_LOCALES, remediationModes: REMEDIATION_MODES, severities: [...SEVERITIES], redactMatchedValues: [true] },
  };
}

const PATHS: Array<[string[], "boolean" | "severity" | "string"]> = [
  [["enabled"], "boolean"],
  [["severity"], "severity"],
  [["detection", "locale"], "string"],
  [["detection", "validateCheckDigits"], "boolean"],
  [["reporting", "redactMatchedValues"], "boolean"],
  [["remediation", "mode"], "string"],
  ...SUPPORTED_ENTITIES.flatMap((e): Array<[string[], "boolean" | "severity" | "string"]> => [
    [["entities", e, "enabled"], "boolean"],
    [["entities", e, "severity"], "severity"],
  ]),
];

function refuseEdit(t: ReturnType<typeof translator>, code: string, key: string, params: Record<string, string>, status = 422): HttpError {
  return new HttpError(status, code, t(key, params), null, params.path ? { path: params.path } : {});
}

/** Rejects an edit the detector cannot honor or that is not a PII setting. */
function checkEdit(t: ReturnType<typeof translator>, edit: YamlEdit): void {
  const where = edit.path.join(".");
  const entry = PATHS.find(([p]) => p.length === edit.path.length && p.every((seg, i) => seg === edit.path[i]));
  if (!entry) {
    const entity = edit.path[0] === "entities" && typeof edit.path[1] === "string" ? edit.path[1] : null;
    if (entity && (UNSUPPORTED_ENTITIES as readonly string[]).includes(entity)) throw refuseEdit(t, "PII_ENTITY_UNSUPPORTED", "pii_route_entity_unsupported", { entity, path: where });
    throw refuseEdit(t, "PII_PATH_UNKNOWN", "pii_route_path_unknown", { path: where });
  }
  if (edit.op === "delete") return;
  const kind = entry[1];
  const value = edit.value;
  if (kind === "boolean" && typeof value !== "boolean") throw refuseEdit(t, "PII_VALUE_INVALID", "pii_route_not_boolean", { path: where });
  if (kind === "severity" && !(SEVERITIES as readonly unknown[]).includes(value)) throw refuseEdit(t, "PII_VALUE_INVALID", "pii_route_bad_severity", { path: where });
  if (kind === "string" && typeof value !== "string") throw refuseEdit(t, "PII_VALUE_INVALID", "pii_route_not_text", { path: where });
  if (where === "detection.locale" && !SUPPORTED_LOCALES.includes(value as string)) throw refuseEdit(t, "PII_OPTION_UNSUPPORTED", "pii_route_locale_unsupported", { path: where, locales: SUPPORTED_LOCALES.join(", ") });
  if (where === "reporting.redactMatchedValues" && value !== true) throw refuseEdit(t, "PII_OPTION_UNSUPPORTED", "pii_route_redact_unsupported", { path: where });
  if (where === "remediation.mode" && !REMEDIATION_MODES.includes(value as string)) throw refuseEdit(t, "PII_OPTION_UNSUPPORTED", "pii_route_remediation_unsupported", { path: where });
}

const edit = {
  type: "object",
  properties: {
    op: { enum: ["set", "delete"] },
    path: { type: "array", items: { type: "string", minLength: 1, maxLength: 64 }, minItems: 1, maxItems: 4 },
    value: { anyOf: [{ type: "string", maxLength: 64 }, { type: "boolean" }] },
  },
  required: ["op", "path"],
  additionalProperties: false,
};

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/pii",
    handler({ server }) {
      return { status: 200, json: describe(server) };
    },
  },
  {
    method: "PUT",
    path: "/api/pii",
    body: {
      type: "object",
      properties: {
        expectedRevision: { anyOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }] },
        edits: { type: "array", items: edit, minItems: 1, maxItems: 40 },
      },
      required: ["expectedRevision", "edits"],
      additionalProperties: false,
    },
    handler({ body, server }) {
      const t = translator("pii");
      const b = body as { expectedRevision: string | null; edits: YamlEdit[] };
      for (const e of b.edits) checkEdit(t, e);
      const abs = path.join(server.projectDir, FILE);
      const current = readRevision(abs);
      if (b.expectedRevision !== current.hash) {
        throw new HttpError(409, "REVISION_CONFLICT", t("pii_route_conflict"), t("pii_route_conflict_fix"), { currentRevision: current.hash });
      }
      try {
        // The result must still be a valid pii.yml before anything is written.
        const next = patchYamlText(current.exists ? current.text : SEED, b.edits);
        const parsed = parseYamlText(next.text, FILE);
        const problems = [...parsed.diagnostics, ...(parsed.value === undefined ? [] : validateDocument("pii", parsed.value, FILE, { doc: parsed.doc, lineCounter: parsed.lineCounter }))];
        if (problems.length > 0) {
          const first = problems[0] as { message: string; path: string };
          throw new HttpError(422, "PII_INVALID", t("pii_route_invalid", { message: first.message }), null, { path: first.path });
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        patchYamlFile(abs, b.edits, { expectedHash: current.hash, createWith: SEED });
      } catch (error) {
        if (error instanceof YamlPatchError) {
          if (error.code === "YAML_CONFLICT") throw new HttpError(409, "REVISION_CONFLICT", t("pii_route_conflict"), t("pii_route_conflict_fix"), {});
          throw new HttpError(422, error.code, error.message);
        }
        throw error;
      }
      server.log("pii settings saved");
      return { status: 200, json: describe(server) };
    },
  },
];
