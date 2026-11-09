// Why a capability enabled "when available" has no check in this project, and the one action that would enable it.
// Read only from the built-in adapter manifests (languages, stack support, distribution) and the built-in templates
// that declare their tools: nothing is probed, installed or run.
import type { Translator } from "../../i18n/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import { listBuiltinTemplates } from "../../builtin/index.js";
import type { AdapterManifest } from "../catalog/index.js";
import type { NotApplicableAction, NotApplicableAdapter, NotApplicableReason } from "./types.js";

/** Adapters that never cover a capability by themselves (the generic command declares its own, per instance). */
const NOT_COVERING = new Set(["generic-command"]);

export interface ExplainInput {
  capability: string;
  /** Readable name of the capability (catalog label, current language). */
  label: string;
  /** Languages of the approvable components of the project. */
  languages: string[];
  /** Templates of the plan: active ones (with their resolved chain) and declared but inactive ones. */
  templates: { active: Array<{ chain: string[] }>; inactive: Array<{ source: string }> };
}

export interface Explanation {
  reasonCode: Extract<NotApplicableReason, "NO_TOOL" | "NO_TOOL_FOR_LANGUAGES" | "SETUP_REQUIRED">;
  message: string;
  adapters: NotApplicableAdapter[];
  action: NotApplicableAction;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export const emptyAction = (kind: NotApplicableAction["kind"]): NotApplicableAction => ({
  kind,
  adapter: null,
  tools: [],
  template: null,
  templateState: null,
  files: [],
  docs: [],
});

/** Whether the adapter can cover the capability for one of the languages (stack support first, then its languages). */
function applicable(manifest: AdapterManifest, capability: string, languages: string[]): boolean {
  const support = (manifest.stackSupport ?? []).filter((s) => s.capability === capability);
  if (support.length > 0) return support.some((s) => s.state !== "unsupported" && (s.stack === "any" || languages.includes(s.stack)));
  return !manifest.languages || manifest.languages.some((l) => languages.includes(l));
}

function prerequisitesOf(manifest: AdapterManifest, capability: string, languages: string[]): string[] {
  const support = (manifest.stackSupport ?? []).filter((s) => s.capability === capability && s.state !== "unsupported");
  const fitting = support.filter((s) => s.stack === "any" || languages.includes(s.stack));
  return [...new Set((fitting.length > 0 ? fitting : support).flatMap((s) => s.prerequisites ?? []))];
}

const evidenceText = (entry: unknown): string | null => {
  if (typeof entry === "string") return entry;
  if (isObject(entry) && typeof entry.path === "string") return typeof entry.contains === "string" ? `${entry.path} (${entry.contains})` : entry.path;
  return null;
};

/** The built-in template that brings the adapter for the capability, with the evidence files that activate it. */
function templateFor(adapterId: string, capability: string, input: ExplainInput): { ref: string; files: string[]; state: "active" | "declared" | "absent" } | null {
  for (const item of listBuiltinTemplates()) {
    const config = isObject(item.value.config) ? item.value.config : {};
    const tools = isObject(config.tools) ? config.tools : {};
    const brings = Object.values(tools).some(
      (body) => isObject(body) && body.adapter === adapterId && (!Array.isArray(body.capabilities) || body.capabilities.includes(capability)),
    );
    if (!brings) continue;
    const match = isObject(item.value.match) ? item.value.match : {};
    // Only a template for one of the project's languages (or for any language) helps here.
    const forLanguages = Array.isArray(match.languages) ? match.languages.filter((l): l is string => typeof l === "string") : [];
    if (forLanguages.length > 0 && !forLanguages.some((l) => input.languages.includes(l))) continue;
    const files = (Array.isArray(match.files) ? match.files : []).map(evidenceText).filter((f): f is string => f !== null);
    const state = input.templates.active.some((a) => a.chain.includes(item.ref))
      ? "active"
      : input.templates.inactive.some((i) => i.source === item.ref)
        ? "declared"
        : "absent";
    return { ref: item.ref, files, state };
  }
  return null;
}

/**
 * Explains a capability without any candidate check: JGates has no tool for it, its tools do not cover the project's
 * languages, or a tool applies but needs setup (evidence files, a template, a target, the tool itself).
 */
export function explainMissing(input: ExplainInput, t: Translator): Explanation {
  const covering = builtinManifests().filter((m) => !NOT_COVERING.has(m.id) && (m.capabilities.includes(input.capability) || (m.subchecks ?? []).some((s) => s.capabilities.includes(input.capability))));
  const adapters: NotApplicableAdapter[] = covering.map((m) => {
    const docs = m.distribution?.setup ?? m.distribution?.acquisition ?? [];
    return {
      id: m.id,
      label: m.displayName,
      languages: m.languages ? [...m.languages] : null,
      applicable: applicable(m, input.capability, input.languages),
      prerequisites: prerequisitesOf(m, input.capability, input.languages),
      docs: [...docs],
    };
  });
  const languages = input.languages.length > 0 ? input.languages.join(", ") : t("plan_na_no_languages");
  if (adapters.length === 0) {
    return { reasonCode: "NO_TOOL", message: t("plan_na_no_tool", { label: input.label }), adapters, action: emptyAction("none") };
  }
  const usable = adapters.filter((a) => a.applicable);
  if (usable.length === 0) {
    const listed = adapters.map((a) => (a.languages ? `${a.label}: ${a.languages.join(", ")}` : a.label)).join("; ");
    return { reasonCode: "NO_TOOL_FOR_LANGUAGES", message: t("plan_na_no_tool_for_languages", { label: input.label, adapters: listed, languages }), adapters, action: emptyAction("none") };
  }
  const first = usable[0] as NotApplicableAdapter;
  const template = templateFor(first.id, input.capability, input);
  const needs = usable.map((a) => (a.prerequisites.length > 0 ? `${a.label} (${a.prerequisites.join("; ")})` : a.label)).join("; ");
  let hint: string;
  let action: NotApplicableAction;
  if (template && template.files.length > 0) {
    hint = t(template.state === "absent" ? "plan_na_hint_template_absent" : "plan_na_hint_template_files", { template: template.ref, files: template.files.join(", ") });
    action = { ...emptyAction("add-files"), adapter: first.id, template: template.ref, templateState: template.state, files: template.files, docs: first.docs };
  } else if (template && template.state === "absent") {
    hint = t("plan_na_hint_template_add", { template: template.ref });
    action = { ...emptyAction("configure-tool"), adapter: first.id, template: template.ref, templateState: template.state, docs: first.docs };
  } else {
    hint = t("plan_na_hint_declare_tool", { adapter: first.id });
    action = { ...emptyAction("configure-tool"), adapter: first.id, docs: first.docs };
  }
  return { reasonCode: "SETUP_REQUIRED", message: `${t("plan_na_setup_required", { label: input.label, needs })} ${hint}`, adapters, action };
}
