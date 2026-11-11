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

const BRIDGE_ADAPTER = "quality-bridge";

/** The individual instances that took over each capability of the retired bridge (lint, unit and coverage come from the stack templates). */
const BRIDGE_REPLACEMENTS: ReadonlyArray<{ id: string; adapter: string; capability: string }> = [
  { id: "semgrep", adapter: "semgrep", capability: "sast" },
  { id: "gitleaks", adapter: "gitleaks", capability: "secrets" },
  { id: "osv-scanner", adapter: "osv-scanner", capability: "dependencies" },
  { id: "trivy", adapter: "trivy", capability: "dependencies" },
  { id: "trivy", adapter: "trivy", capability: "iac" },
  { id: "checkov", adapter: "checkov", capability: "iac" },
  { id: "jscpd", adapter: "jscpd", capability: "duplication" },
  { id: "file-size", adapter: "file-size", capability: "file-size" },
];
/** The individual instance that took over each subcheck of the bridge (the rest of the subchecks have no instance of their own). */
const SUBCHECK_INSTANCE: Readonly<Record<string, string>> = { semgrep: "semgrep", gitleaks: "gitleaks", trivy: "trivy", "osv-scanner": "osv-scanner", checkov: "checkov", jscpd: "jscpd", "file-size": "file-size" };

/** `tool:quality-bridge.<subcheck>` (or the whole bridge) in the checks of a profile: the selector that replaces it, or null. */
function bridgeSelector(selector: string): { found: boolean; replacement: string | null } {
  const match = /^tool:quality-bridge(?:\.([A-Za-z0-9._-]+))?$/.exec(selector);
  if (!match) return { found: false, replacement: null };
  const instance = match[1] ? SUBCHECK_INSTANCE[match[1]] : undefined;
  return { found: true, replacement: instance ? `tool:${instance}` : null };
}

const BRIDGE_ALL = ["lint", "sast", "secrets", "dependencies", "duplication", "iac", "coverage", "unit", "file-size"];

/** The instances replacing one bridge instance; an id the file already declares is left alone (the user's own wins). */
function bridgeReplacements(bridge: Record<string, unknown>, existing: Record<string, unknown>): Record<string, unknown> {
  const declared = Array.isArray(bridge.capabilities) ? bridge.capabilities.filter((c): c is string => typeof c === "string") : BRIDGE_ALL;
  const out: Record<string, { adapter: string; enabled?: boolean; capabilities: string[] }> = {};
  for (const r of BRIDGE_REPLACEMENTS) {
    if (!declared.includes(r.capability) || r.id in existing) continue;
    const instance = (out[r.id] ??= { adapter: r.adapter, ...(bridge.enabled === false ? { enabled: false } : {}), capabilities: [] });
    instance.capabilities.push(r.capability);
  }
  return out;
}

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
  if (kind === "profiles" && isRecord(value.profiles)) {
    // The retired bridge in the checks of a profile: `tool:quality-bridge.<subcheck>` becomes the selector of the instance
    // that took the subcheck over; the ones without an instance (MegaLinter, project tests, coverage) are dropped.
    let profiles: Record<string, unknown> | null = null;
    for (const [id, body] of Object.entries(value.profiles)) {
      if (!isRecord(body) || !isRecord(body.checks)) continue;
      const checks: Record<string, unknown> = {};
      let changed = false;
      for (const [selector, check] of Object.entries(body.checks)) {
        const found = bridgeSelector(selector);
        if (!found.found) {
          checks[selector] = check;
          continue;
        }
        changed = true;
        if (found.replacement && !(found.replacement in body.checks)) checks[found.replacement] = check;
        const version = declared ?? 1;
        notices.push({
          kind: "migration",
          code: "CONFIG_MIGRATED",
          file,
          path: `profiles.${id}.checks.${selector}`,
          pathSegments: ["profiles", id, "checks", selector],
          from: version,
          to: version,
          message: found.replacement ? t("config_migrated_bridge_selector", { file, profile: id, selector, replacement: found.replacement }) : t("config_migrated_bridge_selector_dropped", { file, profile: id, selector }),
        });
      }
      if (!changed) continue;
      profiles ??= { ...value.profiles };
      profiles[id] = { ...body, checks };
    }
    return profiles ? { value: { ...value, profiles }, notices } : { value, notices };
  }
  if (kind === "tools" && isRecord(value.tools)) {
    let tools: Record<string, unknown> | null = null;
    // The retired quality bridge: its instance becomes the individual instances that cover the same capabilities.
    for (const [id, body] of Object.entries(value.tools)) {
      if (!isRecord(body) || body.adapter !== BRIDGE_ADAPTER) continue;
      tools ??= { ...value.tools };
      delete tools[id];
      const replaced = bridgeReplacements(body, tools);
      for (const [name, instance] of Object.entries(replaced)) tools[name] = instance;
      const version = declared ?? 1;
      notices.push({
        kind: "migration",
        code: "CONFIG_MIGRATED",
        file,
        path: `tools.${id}`,
        pathSegments: ["tools", id],
        from: version,
        to: version,
        message: t("config_migrated_quality_bridge", { file, tool: id, count: Object.keys(replaced).length, tools: Object.keys(replaced).join(", ") }),
      });
    }
    const current: Record<string, unknown> = tools ?? value.tools;
    for (const [id, body] of Object.entries(current)) {
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
