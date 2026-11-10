// The states catalogue through the API: every reason code with its text and its action in both languages, the labels
// of the plan's actions (prepare-image, prepare-codeql...) and of the toolchain actions, so the UI shows the same
// sentence the CLI prints and never invents its own (PLAN-guided-ux.md section 9). Texts keep their {placeholders}
// and plural forms: the caller that has the numbers formats them; the plan and environment results already carry the
// formatted message of the reasons they raise.
import { REASONS } from "../../core/reasons/index.js";
import { loadCatalog, SUPPORTED_LOCALES } from "../../i18n/index.js";
import type { RouteDefinition } from "../types.js";

/** Plan action kinds that ask the person for something (kind "none" has no label), and the key of their label. */
const PLAN_ACTIONS = ["prepare-tool", "prepare-image", "prepare-codeql", "add-files", "add-template", "configure-tool", "enable-check"] as const;
/** The actions of a toolchain outcome (core/deps/toolchains.ts). */
const TOOLCHAIN_ACTIONS = ["use-default-version", "fix-version-file"] as const;

const perLocale = (key: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const locale of SUPPORTED_LOCALES) out[locale] = loadCatalog("reasons", locale)[key] ?? "";
  return out;
};

export function catalogue() {
  return {
    locales: [...SUPPORTED_LOCALES],
    reasons: Object.values(REASONS).map((entry) => ({
      code: entry.code,
      text: perLocale(entry.textKey),
      action: { ...entry.action, label: perLocale(entry.actionLabelKey) },
    })),
    planActions: PLAN_ACTIONS.map((kind) => ({ kind, label: perLocale(`plan_action_${kind.replace(/-/g, "_")}`) })),
    toolchainActions: TOOLCHAIN_ACTIONS.map((id) => ({ id, label: perLocale(`toolchain_action_${id.replace(/-/g, "_")}`) })),
  };
}

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/reasons",
    handler() {
      return { status: 200, json: { schemaVersion: 1, status: "OK", ...catalogue() } };
    },
  },
];
