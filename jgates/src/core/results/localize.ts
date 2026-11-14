import { builtinManifests } from "../../adapters/manifests.js";
import { localizeTechnical } from "../../i18n/technical.js";
import { getLocale } from "../../i18n/index.js";
import { localizedAdapterName, subcheckLabel } from "../catalog/index.js";

// A run stores ids (the stage id, its adapter) and the text of the language it ran in. What the screen shows is resolved on
// display: the name of a built-in check comes from the catalogue in the language of the screen, and the adapter parse
// problems a reason carries are translated (i18n/technical.ts). The stored file is never rewritten.

interface StoredStage {
  id?: unknown;
  label?: unknown;
  adapter?: unknown;
  reason?: unknown;
  [key: string]: unknown;
}

/** The name of a stored stage in the language of the screen, or the stored label when the catalogue has none. */
export function stageLabelFor(stage: StoredStage): string | null {
  const stored = typeof stage.label === "string" && stage.label !== "" ? stage.label : null;
  const id = typeof stage.id === "string" ? stage.id : "";
  const adapterId = typeof stage.adapter === "string" && stage.adapter !== "" ? stage.adapter : id.split("#")[0];
  const manifest = builtinManifests().find((m) => m.id === adapterId);
  if (!manifest) return stored;
  const sub = id.includes("#") ? id.slice(id.indexOf("#") + 1) : "";
  const subcheck = (manifest.subchecks ?? []).find((s) => s.id === sub);
  if (subcheck) return subcheckLabel(manifest.id, subcheck);
  // A stage named after the adapter itself (its display name was stored): show the catalogue's name.
  if (stored === null || stored === manifest.displayName) return localizedAdapterName(manifest.id, manifest.displayName);
  return stored;
}

/** A copy of a stored stage with its label and reason in the language of the screen. */
export function localizeStage<T extends StoredStage>(stage: T): T {
  const label = stageLabelFor(stage);
  const reason = typeof stage.reason === "string" && getLocale() === "pt-BR" ? localizeTechnical(stage.reason) : stage.reason;
  return { ...stage, ...(label !== null ? { label } : {}), ...(reason !== undefined ? { reason } : {}) };
}

/** A copy of a stored result whose stages are shown in the language of the screen (the other fields are untouched). */
export function localizeResult<T extends { stages?: unknown }>(result: T): T {
  if (!result || !Array.isArray(result.stages)) return result;
  return { ...result, stages: result.stages.map((s) => (s && typeof s === "object" ? localizeStage(s as StoredStage) : s)) };
}
