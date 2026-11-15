// Suggestions of "not applicable" (PLAN-product-changes.md section 8). ADR-0013 stands: only the user's recorded decision
// makes a requirement not applicable. JGates only proposes the decision when it has evidence that the requirement does
// not concern the project, and the user confirms it (the same write as any "not applicable" entry: a preview, one entry
// in .jgates/asvs.json, an undo, refused in governed mode). Nothing here writes.
//
// A suggestion comes from the `applies` of a reviewed mapping entry, for a requirement that is unsupported, unexamined or
// awaiting evidence (never one a check examined, never one already recorded as not applicable):
//   - technology: every Semgrep stage of the Quality run completed and was interpreted with the installed pack, records
//     which languages it scanned and which signals matched; no tag of the entry matched; and for every language the
//     scan covered or the project has, a signal rule of each tag ran (a `semgrep-rule` unit of this JGates's pack).
//     A language with no signal rule for the tag gives no suggestion: absence of knowledge is not absence of the
//     technology;
//   - languages.only: the project's languages are known and none is one of those;
//   - languages.exempt: the project's languages are known and every one is exempt.
// The first that holds, in that order, is the suggestion. It disappears by itself when a later run finds the technology.
import { semgrepManifest, type PackRule } from "../../../adapters/semgrep/index.js";
import { labelOf } from "../../discovery/vocabulary.js";
import { getLocale, translator } from "../../../i18n/index.js";
import type { ExemptReason, MappingApplies } from "./mapping.js";
import { scannedLanguagesOf, signalsOf, type CheckUnitList, type QualityRunRecord } from "./units.js";

const t = translator("coverage");

export const ASVS_SUGGESTION_KINDS = ["technology", "languages-only", "languages-exempt"] as const;
export type AsvsSuggestionKind = (typeof ASVS_SUGGESTION_KINDS)[number];

/** A proposed "not applicable" decision; never a decision itself. */
export interface AsvsSuggestion {
  kind: AsvsSuggestionKind;
  /** technology: the tags of the entry, none of which the scan found. */
  tags?: string[];
  /** languages-only: the languages the requirement concerns; languages-exempt: the project's languages, all exempt. */
  languages?: string[];
  /** languages-exempt: why those languages rule the weakness out (closed list). */
  reasonId?: ExemptReason;
  /** The reason in words, in the language of the call; what the confirmation records unless the user edits it. */
  reason: string;
}

export interface SuggestionContext {
  quality: QualityRunRecord | null;
  units: CheckUnitList;
  /** The rules of this JGates's pack, by id. */
  rules: ReadonlyMap<string, PackRule>;
  /** The languages the Quality run saw in the project; null when unknown. */
  languages: ReadonlySet<string> | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** The pack language a language is read by: TypeScript by the JavaScript rules. */
const packLanguage = (language: string): string => (language === "typescript" ? "javascript" : language);
/** Kinds of file the scan counts that are not a programming language. */
const NOT_A_LANGUAGE = new Set(["html", "config"]);
/** Whether a language list of `applies` names a language (`javascript` there stands for TypeScript too). */
const names = (list: readonly string[], language: string): boolean => list.includes(language) || (language === "typescript" && list.includes("javascript"));

const listOf = (items: readonly string[], type: "conjunction" | "disjunction"): string => {
  try {
    return new Intl.ListFormat(getLocale(), { type }).format(items);
  } catch {
    return items.join(", ");
  }
};
const technologyLabel = (tag: string): string => {
  const key = `coverage_technology_${tag.replace(/-/g, "_")}`;
  const out = t(key);
  return out === key ? tag : out;
};
const languageLabels = (languages: readonly string[]): string[] => languages.map(labelOf);

/** Whether the Quality run looked for the technologies of every tag and found none (see the header). */
function technologyAbsent(tags: readonly string[], ctx: SuggestionContext): boolean {
  if (!ctx.quality || tags.length === 0) return false;
  const result = isObj(ctx.quality.result) ? ctx.quality.result : {};
  const stages = objs(result.stages).filter((s) => s.kind !== "composite" && s.adapter === semgrepManifest.id);
  if (stages.length === 0) return false;
  for (const stage of stages) {
    if (stage.state !== "completed" || stage.interpreted !== true) return false;
    const signals = signalsOf(stage);
    const scanned = scannedLanguagesOf(stage);
    if (!signals || !scanned) return false;
    // A tag the record does not hold was not looked for; a tag with a match is used.
    for (const tag of tags) if (signals[tag] !== 0) return false;
    const covered = new Set<string>();
    for (const [language, files] of Object.entries(scanned)) if (files > 0) covered.add(packLanguage(language));
    for (const language of ctx.languages ?? []) covered.add(packLanguage(language));
    if (covered.size === 0) return false;
    const ran = ctx.units.units.filter((u) => u.unit === "semgrep-rule" && u.state === "completed" && u.run.gate === "quality" && u.run.runId === ctx.quality?.runId && u.stageId === stage.id);
    for (const tag of tags) {
      for (const language of covered) {
        const has = ran.some((u) => {
          const rule = ctx.rules.get(u.id);
          return rule !== undefined && rule.signal === tag && rule.language === language;
        });
        if (!has) return false;
      }
    }
  }
  return true;
}

/** The project's programming languages, sorted; null when unknown or when none is known. */
function programmingLanguages(ctx: SuggestionContext): string[] | null {
  if (!ctx.languages) return null;
  const out = [...ctx.languages].filter((l) => !NOT_A_LANGUAGE.has(l)).sort();
  return out.length > 0 ? out : null;
}

/** The suggestion an entry's `applies` gives in the runs read, or null. The caller decides whether the row may carry one. */
export function suggestionFor(applies: MappingApplies | null, ctx: SuggestionContext): AsvsSuggestion | null {
  if (!applies) return null;
  const tags = applies.technology ?? [];
  if (tags.length > 0 && technologyAbsent(tags, ctx)) {
    const sorted = [...tags].sort();
    return { kind: "technology", tags: sorted, reason: t("coverage_suggestion_technology", { technologies: listOf(sorted.map(technologyLabel), "disjunction") }) };
  }
  const languages = programmingLanguages(ctx);
  const only = applies.languages?.only;
  if (only && languages && !languages.some((l) => names(only, l))) {
    const sorted = [...only].sort();
    return { kind: "languages-only", languages: sorted, reason: t("coverage_suggestion_languages_only", { languages: listOf(languageLabels(sorted), "disjunction") }) };
  }
  const exempt = applies.languages?.exempt;
  if (exempt && languages && languages.every((l) => names(exempt.languages, l))) {
    const key = `coverage_suggestion_exempt_${exempt.reason.replace(/-/g, "_")}`;
    return { kind: "languages-exempt", languages, reasonId: exempt.reason, reason: t(key, { languages: listOf(languageLabels(languages), "conjunction") }) };
  }
  return null;
}

/** Whether two suggestions propose the same decision for the same reason (what lets a section or chapter carry it once). */
export function sameSuggestion(a: AsvsSuggestion | null | undefined, b: AsvsSuggestion | null | undefined): boolean {
  if (!a || !b) return false;
  return a.kind === b.kind && (a.tags ?? []).join(",") === (b.tags ?? []).join(",") && (a.languages ?? []).join(",") === (b.languages ?? []).join(",") && a.reasonId === b.reasonId;
}
