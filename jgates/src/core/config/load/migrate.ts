// The migration reader of the configuration: older documents load as the current schema, with a notice for every
// setting it dropped. Container-first (ADR-0004) removed the runner choice: every check runs in the JGates tools image.
//   - jgates.yml schema 1 -> 2: `execution.runner` (local | container) is gone;
//   - .jgates/tools.yml: the `runner` of an instance (ruff's local/container choice, the scanners' local refusal) is
//     gone; the file keeps its schema version 1.
// The file on disk is never rewritten here; the editor keeps the user's text. A notice never makes the configuration
// invalid.
import { translator } from "../../../i18n/index.js";
import type { DocumentKind } from "./types.js";

/** The schema version jgates.yml is written with. */
export const ROOT_SCHEMA_VERSION = 2;

export interface ConfigNotice {
  kind: "migration";
  /** CONFIG_MIGRATED: a setting the current schema no longer has was dropped while reading. */
  code: "CONFIG_MIGRATED";
  file: string;
  /** Path of the dropped field, for example "execution.runner" or "tools.ruff.runner". */
  path: string;
  pathSegments: string[];
  /** The schema version the document declared, and the one it was read as. */
  from: number;
  to: number;
  message: string;
}

export interface MigrationOutcome {
  value: unknown;
  notices: ConfigNotice[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Reads an older document as the current schema. Returns the value to validate (a copy when something changed, the
 * same value otherwise) and one notice per dropped setting.
 */
export function migrateDocument(kind: DocumentKind, value: unknown, file: string): MigrationOutcome {
  if (!isRecord(value)) return { value, notices: [] };
  const t = translator("config");
  const notices: ConfigNotice[] = [];
  const declared = typeof value.schemaVersion === "number" ? value.schemaVersion : null;
  if (kind === "root" && declared === 1) {
    const next: Record<string, unknown> = { ...value, schemaVersion: ROOT_SCHEMA_VERSION };
    if (isRecord(value.execution) && "runner" in value.execution) {
      const { runner, ...execution } = value.execution;
      next.execution = execution;
      notices.push({
        kind: "migration",
        code: "CONFIG_MIGRATED",
        file,
        path: "execution.runner",
        pathSegments: ["execution", "runner"],
        from: 1,
        to: ROOT_SCHEMA_VERSION,
        message: t("config_migrated_execution_runner", { file, value: String(runner) }),
      });
    }
    return { value: next, notices };
  }
  if (kind === "tools" && isRecord(value.tools)) {
    let tools: Record<string, unknown> | null = null;
    for (const [id, body] of Object.entries(value.tools)) {
      if (!isRecord(body) || !("runner" in body)) continue;
      const { runner, ...rest } = body;
      tools ??= { ...value.tools };
      tools[id] = rest;
      const version = declared ?? 1;
      notices.push({
        kind: "migration",
        code: "CONFIG_MIGRATED",
        file,
        path: `tools.${id}.runner`,
        pathSegments: ["tools", id, "runner"],
        from: version,
        to: version,
        message: t("config_migrated_tool_runner", { file, tool: id, value: String(runner) }),
      });
    }
    return tools ? { value: { ...value, tools }, notices } : { value, notices };
  }
  return { value, notices };
}
