import { qualityBridgeManifest } from "../../../adapters/quality-bridge/manifest.js";
import { DEFAULT_SELECTION, planSubchecks, stageIdOf } from "../../../adapters/quality-bridge/requirements.js";
import type { LoadedDocument } from "../load/types.js";
import { flatten, isPlainObject, type LayerOp } from "./pointer.js";

/**
 * Maps every kind of document into leaf operations on the effective configuration.
 * Lists of objects with an id (templates, components, required evidence) become maps by id, so they merge by id
 * and never by index; lists of plain values are leaves (replaced, unless an explicit add/remove/replace).
 */

/** Profile used when neither the call nor jgates.yml names one. */
export const DEFAULT_PROFILE = "builtin:standard";

/** Templates assumed when jgates.yml declares none: the base always, the stack templates when detected. */
export const IMPLICIT_TEMPLATES = [
  { id: "base", source: "builtin:base", activation: "always" },
  { id: "python", source: "builtin:python", activation: "detected" },
  { id: "typescript", source: "builtin:typescript", activation: "detected" },
  { id: "dotnet", source: "builtin:dotnet", activation: "detected" },
] as const;

export interface SourcedOps {
  source: string;
  file: string | null;
  ops: LayerOp[];
}

function byId(list: unknown, key: string, segments: string[], fileKey: string, out: LayerOp[]): void {
  if (!Array.isArray(list)) return;
  list.forEach((item, index) => {
    if (!isPlainObject(item) || typeof item[key] !== "string") return;
    const id = item[key] as string;
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) if (k !== key) rest[k] = v;
    const fileSegments = [fileKey, String(index)];
    if (Object.keys(rest).length === 0) flatten({}, [...segments, id], fileSegments, out);
    else for (const [k, v] of Object.entries(rest)) flatten(v, [...segments, id, k], [...fileSegments, k], out);
  });
}

/** Operations of one project document (the project layer). */
export function projectDocumentOps(doc: LoadedDocument): LayerOp[] {
  const value = isPlainObject(doc.value) ? doc.value : {};
  const out: LayerOp[] = [];
  const plain = (key: string, target: string[] = [key]): void => {
    if (value[key] !== undefined) flatten(value[key], target, [key], out);
  };
  switch (doc.kind) {
    case "root":
      plain("selection");
      plain("execution");
      plain("extensions");
      byId(value.templates, "id", ["templates"], "templates", out);
      break;
    case "workspace":
      plain("discovery", ["workspace", "discovery"]);
      plain("include", ["workspace", "include"]);
      plain("exclude", ["workspace", "exclude"]);
      byId(value.components, "id", ["workspace", "components"], "components", out);
      break;
    case "tools":
      plain("tools");
      plain("bindings");
      break;
    case "policy":
      if (value.rules !== undefined) flatten(value.rules, ["policy", "rules"], ["rules"], out);
      byId(value.requiredEvidence, "check", ["policy", "requiredEvidence"], "requiredEvidence", out);
      if (value.exceptions !== undefined) flatten(value.exceptions, ["policy", "exceptions"], ["exceptions"], out);
      break;
    case "pii":
      // The settings of the builtin-pii instance: `enabled` is the instance's own switch (tools.builtin-pii.enabled).
      for (const [k, v] of Object.entries(value)) {
        if (k === "schemaVersion") continue;
        if (k === "enabled") flatten(v, ["tools", "builtin-pii", "enabled"], [k], out);
        else flatten(v, [doc.kind, k], [k], out);
      }
      break;
    case "architecture":
      for (const [k, v] of Object.entries(value)) if (k !== "schemaVersion") flatten(v, [doc.kind, k], [k], out);
      break;
    case "profiles":
      break; // definitions only; the selected profile is its own layer
  }
  return out;
}

/** True when a project document declares the template list (then the implicit list does not apply). */
export function declaresTemplates(doc: LoadedDocument): boolean {
  return doc.kind === "root" && isPlainObject(doc.value) && Array.isArray(doc.value.templates);
}

/** Operations of a template document: its `config` is written in the shape of the effective configuration. */
export function templateOps(value: Record<string, unknown>): LayerOp[] {
  const config = value.config;
  if (!isPlainObject(config)) return [];
  const out: LayerOp[] = [];
  for (const [k, v] of Object.entries(config)) flatten(v, [k], ["config", k], out);
  return out;
}

/** Operations of one profile body: checks, and the intensity and scope of the selection. */
export function profileOps(body: Record<string, unknown>, fileSegments: string[]): LayerOp[] {
  const out: LayerOp[] = [];
  if (body.checks !== undefined) flatten(body.checks, ["checks"], [...fileSegments, "checks"], out);
  if (body.intensity !== undefined) flatten(body.intensity, ["selection", "intensity"], [...fileSegments, "intensity"], out);
  if (body.scope !== undefined) flatten(body.scope, ["selection", "scope"], [...fileSegments, "scope"], out);
  return out;
}

/** The defaults layer: JGates' own defaults and the default selection of each adapter. */
export function defaultLayers(withImplicitTemplates: boolean): SourcedOps[] {
  const engine: LayerOp[] = [];
  flatten(DEFAULT_PROFILE, ["selection", "profile"], null, engine);
  flatten(1, ["execution", "concurrency"], null, engine);
  flatten("explicit", ["execution", "network"], null, engine);
  if (withImplicitTemplates) {
    for (const t of IMPLICIT_TEMPLATES) {
      flatten(t.source, ["templates", t.id, "source"], null, engine);
      flatten(t.activation, ["templates", t.id, "activation"], null, engine);
    }
  }
  const bridge: LayerOp[] = [];
  const ids = (qualityBridgeManifest.subchecks ?? []).map((s) => s.id);
  for (const plan of planSubchecks(DEFAULT_SELECTION, ids)) {
    // Off by the adapter's default selection (origin "profile" in the bridge table); on otherwise.
    const enabled = !(plan.disabled && plan.disabled.origin === "profile");
    flatten(enabled, ["checks", `tool:${stageIdOf(plan.subcheckId)}`, "enabled"], null, bridge);
  }
  return [
    { source: "jgates", file: null, ops: engine },
    { source: `adapter:${qualityBridgeManifest.id}`, file: null, ops: bridge },
  ];
}
