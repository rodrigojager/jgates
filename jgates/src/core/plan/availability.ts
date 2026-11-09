// Why a capability enabled "when available" has no check in this project, and the one action that would enable it.
// Read only from the built-in adapter manifests (languages, stack support, distribution), the built-in templates
// that declare their tools and, when the project folder is given, whether their evidence files exist: nothing is
// probed, installed or run.
import fs from "node:fs";
import path from "node:path";
import type { Translator } from "../../i18n/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import { listBuiltinTemplates } from "../../builtin/index.js";
import type { AdapterManifest } from "../catalog/index.js";
import type { NotApplicableAction, NotApplicableAdapter, NotApplicableReason } from "./types.js";

/** Adapters that never cover a capability by themselves (the generic command declares its own, per instance). */
const NOT_COVERING = new Set(["generic-command"]);

/**
 * Settings of an instance that JGates cannot guess: without them the adapter cannot run in any project, so the
 * action names them (configure-tool). The i18n key plan_na_setting_<setting> says what each one is.
 */
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export const REQUIRED_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  schemathesis: ["target"],
  zap: ["target"],
  oasdiff: ["baseRef"],
};

/** Settings that satisfy a required one in its place (oasdiff: a reference file instead of a reference revision). */
const SETTING_ALTERNATIVES: Readonly<Record<string, readonly string[]>> = { baseRef: ["baseSpec"] };

/** The required settings (REQUIRED_SETTINGS) an instance body of the adapter leaves unset, in declaration order. */
export function missingSettings(adapterId: string | null, body: unknown): string[] {
  if (!adapterId) return [];
  const values = isObject(body) ? body : {};
  const set = (key: string) => values[key] !== undefined && values[key] !== null && values[key] !== "";
  return (REQUIRED_SETTINGS[adapterId] ?? []).filter((s) => !set(s) && !(SETTING_ALTERNATIVES[s] ?? []).some(set));
}

export interface ExplainInput {
  capability: string;
  /** Readable name of the capability (catalog label, current language). */
  label: string;
  /** Languages of the approvable components of the project. */
  languages: string[];
  /** Templates of the plan: active ones (with their resolved chain) and declared but inactive ones. */
  templates: { active: Array<{ chain: string[] }>; inactive: Array<{ source: string }> };
  /** The project folder: the evidence files of an absent template are looked up there. Absent: not looked up. */
  dir?: string;
  /** Roots of the approvable components, relative to `dir` ("." for the workspace root). */
  roots?: string[];
}

export interface Explanation {
  reasonCode: Extract<NotApplicableReason, "NO_TOOL" | "NO_TOOL_FOR_LANGUAGES" | "SETUP_REQUIRED">;
  message: string;
  adapters: NotApplicableAdapter[];
  action: NotApplicableAction;
}

export const emptyAction = (kind: NotApplicableAction["kind"]): NotApplicableAction => ({
  kind,
  adapter: null,
  tools: [],
  template: null,
  templateState: null,
  files: [],
  docs: [],
  settings: [],
});

/** prepare-tool for instances whose tool is missing here, with the adapter's official acquisition links. */
export function prepareAction(adapterId: string | null, tools: string[]): NotApplicableAction {
  const manifest = adapterId ? builtinManifests().find((m) => m.id === adapterId) : undefined;
  return { ...emptyAction("prepare-tool"), adapter: adapterId, tools, docs: [...(manifest?.distribution?.acquisition ?? manifest?.distribution?.setup ?? [])] };
}

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

interface Evidence {
  path: string;
  contains: string | null;
}

const evidenceOf = (entry: unknown): Evidence | null => {
  if (typeof entry === "string") return { path: entry.replace(/\\/g, "/"), contains: null };
  if (isObject(entry) && typeof entry.path === "string") return { path: entry.path.replace(/\\/g, "/"), contains: typeof entry.contains === "string" ? entry.contains : null };
  return null;
};

const evidenceText = (e: Evidence): string => (e.contains !== null ? `${e.path} (${e.contains})` : e.path);

/** Same rule as template activation: the file exists (a `*` in the last segment matches names) and has the line. */
function hasEvidence(dir: string, rel: string, contains: string | null): boolean {
  const slash = rel.lastIndexOf("/");
  const leaf = rel.slice(slash + 1);
  if (leaf.includes("*")) {
    const folder = slash < 0 ? "" : rel.slice(0, slash);
    const matcher = new RegExp(`^${leaf.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
    let names: string[];
    try {
      names = fs.readdirSync(path.join(dir, ...folder.split("/").filter(Boolean)));
    } catch {
      return false;
    }
    return names.some((name) => matcher.test(name) && hasEvidence(dir, folder === "" ? name : `${folder}/${name}`, contains));
  }
  try {
    const abs = path.join(dir, ...rel.split("/"));
    if (!fs.statSync(abs).isFile()) return false;
    if (contains === null) return true;
    return fs.readFileSync(abs, "utf8").split(/\r?\n/).some((line) => line.trimStart().startsWith(contains));
  } catch {
    return false;
  }
}

type TemplateState = "active" | "declared" | "absent";

interface TemplateHit {
  ref: string;
  adapter: string;
  /** Every evidence file of the template (text form). */
  files: string[];
  /** The evidence files found in the project; null when the project folder was not given. */
  found: string[] | null;
  state: TemplateState;
}

/** Order of preference: what is already there, then what one added template turns on, then what needs files. */
function rank(hit: TemplateHit): number {
  if (hit.state === "active") return 0;
  if (hit.state === "declared") return 1;
  if (hit.files.length === 0) return 3;
  if (hit.found !== null && hit.found.length > 0) return 2;
  return 4;
}

/** The built-in templates that bring the adapter for the capability, for the project's languages (or any language). */
function templatesFor(adapterId: string, capability: string, input: ExplainInput): TemplateHit[] {
  const hits: TemplateHit[] = [];
  for (const item of listBuiltinTemplates()) {
    const config = isObject(item.value.config) ? item.value.config : {};
    const tools = isObject(config.tools) ? config.tools : {};
    const brings = Object.values(tools).some(
      (body) => isObject(body) && body.adapter === adapterId && (!Array.isArray(body.capabilities) || body.capabilities.includes(capability)),
    );
    if (!brings) continue;
    const match = isObject(item.value.match) ? item.value.match : {};
    const forLanguages = Array.isArray(match.languages) ? match.languages.filter((l): l is string => typeof l === "string") : [];
    if (forLanguages.length > 0 && !forLanguages.some((l) => input.languages.includes(l))) continue;
    const evidence = (Array.isArray(match.files) ? match.files : []).map(evidenceOf).filter((e): e is Evidence => e !== null);
    let found: string[] | null = null;
    if (input.dir !== undefined) {
      const dir = input.dir;
      const roots = [...new Set([".", ...(input.roots ?? [])])].sort();
      found = [];
      for (const root of roots) {
        for (const e of evidence) {
          const rel = root === "." ? e.path : `${root}/${e.path}`;
          if (hasEvidence(dir, rel, e.contains) && !found.includes(rel)) found.push(rel);
        }
      }
    }
    const state: TemplateState = input.templates.active.some((a) => a.chain.includes(item.ref))
      ? "active"
      : input.templates.inactive.some((i) => i.source === item.ref)
        ? "declared"
        : "absent";
    hits.push({ ref: item.ref, adapter: adapterId, files: evidence.map(evidenceText), found, state });
  }
  return hits;
}

/**
 * Explains a capability without any candidate check: JGates has no tool for it, its tools do not cover the project's
 * languages, or a tool applies but needs setup (a template to add, evidence files, settings such as a target URL).
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
  // The best template over every usable adapter (stable: adapters in manifest order, templates by id).
  const candidates = usable.flatMap((a) => templatesFor(a.id, input.capability, input));
  const template = candidates.reduce<TemplateHit | null>((best, hit) => (best === null || rank(hit) < rank(best) ? hit : best), null);
  const first = (template ? usable.find((a) => a.id === template.adapter) : undefined) ?? (usable[0] as NotApplicableAdapter);
  const needs = usable.map((a) => (a.prerequisites.length > 0 ? `${a.label} (${a.prerequisites.join("; ")})` : a.label)).join("; ");
  const setup = (hint: string): string => `${t("plan_na_setup_required", { label: input.label, needs })} ${hint}`;
  const settings = [...(REQUIRED_SETTINGS[first.id] ?? [])];
  let message: string;
  let action: NotApplicableAction;
  if (settings.length > 0) {
    // Settings JGates cannot guess (a running target, a reference revision): name them, and the template if any.
    const what = settings.map((s) => t(`plan_na_setting_${s}`)).join("; ");
    const files = template && template.state !== "active" && (template.found === null || template.found.length === 0) ? template.files : [];
    const withTemplate = template && template.state === "absent" ? ` ${t("plan_na_hint_settings_template", { template: template.ref })}` : "";
    const withFiles = files.length > 0 ? ` ${t("plan_na_hint_settings_files", { files: files.join(", ") })}` : "";
    message = setup(`${t("plan_na_hint_settings", { adapter: first.id, settings: settings.join(", "), what })}${withFiles}${withTemplate}`);
    action = {
      ...emptyAction("configure-tool"),
      adapter: first.id,
      template: template?.ref ?? null,
      templateState: template?.state ?? null,
      files,
      docs: first.docs,
      settings,
    };
  } else if (template && template.state === "absent" && rank(template) <= 3) {
    // One added template turns it on: it needs no evidence, or its evidence is already here.
    const found = template.found ?? [];
    message = t(found.length > 0 ? "plan_na_template_absent_found" : "plan_na_template_absent", { label: input.label, adapter: first.label, template: template.ref, files: found.join(", ") });
    action = { ...emptyAction("add-template"), adapter: first.id, template: template.ref, templateState: "absent", files: found, docs: first.docs };
  } else if (template && template.files.length > 0) {
    message = setup(t(template.state === "absent" ? "plan_na_hint_template_absent" : "plan_na_hint_template_files", { template: template.ref, files: template.files.join(", ") }));
    action = { ...emptyAction("add-files"), adapter: first.id, template: template.ref, templateState: template.state, files: template.files, docs: first.docs };
  } else {
    message = setup(t("plan_na_hint_declare_tool", { adapter: first.id }));
    action = { ...emptyAction("configure-tool"), adapter: first.id, docs: first.docs };
  }
  return { reasonCode: "SETUP_REQUIRED", message, adapters, action };
}
