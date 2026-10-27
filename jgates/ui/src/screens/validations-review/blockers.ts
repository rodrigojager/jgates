// The blockers of the review ("Revise antes de continuar"): the plan's own validity rules plus the ones the interface adds
// on top of the plan (a forced template with no component, a required architecture or tool that cannot run).

import { ApiError } from "../../api";
import { t, tOr } from "../../i18n";

export interface Blocker {
  /** Stable code: PLAN_EMPTY, TEMPLATE_INCOMPATIBLE, TARGET_MISSING, CATEGORY_EMPTY, ARCHITECTURE_NO_RULES, CONFIG_INVALID, UNSAVED_DOCUMENT, TOOL_UNAVAILABLE, VERSION_OUT_OF_RANGE... */
  code: string;
  title: string;
  message: string;
  /** How to resolve it. */
  how: string;
}

const TARGET_CODES = new Set(["PATHS_REQUIRED", "REF_UNKNOWN", "NOT_A_GIT_REPOSITORY", "GIT_UNAVAILABLE", "REFS_NOT_ALLOWED", "PATHS_NOT_ALLOWED", "SNAPSHOT_FAILED"]);
const OWN_LAYERS = new Set(["profile", "project", "call", "policy"]);
const VERSION = /Versão incompatível|versão incompatível/;

export interface UnavailableItem {
  id: string;
  tool: string;
  adapter: string | null;
  capability: string;
  reason: string;
  how: string;
  /** The profile or the project turned the check on (not a template's default): the review blocks on it. */
  blocking: boolean;
  version: boolean;
  architecture: boolean;
}

/** Where to go to fix an unavailable tool, by what is known about it. */
function howToFix(item: { adapter: string | null; reason: string }): string {
  if (VERSION.test(item.reason)) return t("vrev_how_version");
  if (item.adapter === "eslint") return t("vrev_how_eslint");
  if (item.adapter === "dependency-cruiser" || item.adapter === "import-linter") return t("vrev_how_architecture_tool");
  return t("vrev_how_tool");
}

/** The items of "vai executar" that cannot run, one per tool instance, with the way to resolve each. */
export function unavailableItems(plan: any): UnavailableItem[] {
  const out: UnavailableItem[] = [];
  for (const item of (plan?.groups?.willRun ?? []) as any[]) {
    if (item.availability?.status === "available") continue;
    const reason = String(item.availability?.reason ?? item.tool);
    out.push({
      id: item.id,
      tool: item.tool,
      adapter: item.adapter ?? null,
      capability: (item.capabilities ?? [])[0] ?? "",
      reason,
      how: howToFix({ adapter: item.adapter ?? null, reason }),
      blocking: item.requirement === "required" && OWN_LAYERS.has(String(item.state?.decision?.layer ?? "")) && ((item.includedBy ?? []) as any[]).some((i) => i.kind === "project"),
      version: VERSION.test(reason),
      architecture: (item.capabilities ?? []).includes("architecture") || item.category === "architecture",
    });
  }
  return out;
}

/** Blockers for a plan that could not be built (the server refused it with a code). */
function fromBuildError(error: ApiError): Blocker {
  if (TARGET_CODES.has(error.code)) return { code: "TARGET_MISSING", title: t("vrev_blocker_target"), message: error.message, how: error.fix ?? t("vrev_how_target") };
  if (error.code === "CONFIG_INVALID" || error.code === "ROOT_MISSING") return { code: "CONFIG_INVALID", title: t("vrev_blocker_config"), message: error.message, how: error.fix ?? t("vrev_how_config") };
  return { code: error.code, title: t("vrev_blocker_build"), message: error.message, how: error.fix ?? t("vrev_how_build") };
}

export function blockersOf(plan: any | null, error: unknown, unresolvedDrafts: number): Blocker[] {
  const out: Blocker[] = [];
  if (error instanceof ApiError) out.push(fromBuildError(error));
  else if (error) out.push({ code: "BUILD_FAILED", title: t("vrev_blocker_build"), message: t("error_network"), how: t("vrev_how_build") });
  if (plan) {
    const unavailable = unavailableItems(plan);
    const architecture = new Set<string>();
    // A fixed order: empty plan, incompatible template, empty category, architecture without rules, invalid
    // configuration, unsaved document, unavailable tool or version, then the rest of the plan's own blockers.
    const listed: Array<any> = plan.blocked ? [plan.blocked, ...plan.blockers] : plan.blockers;
    for (const b of listed) {
      if (b.code === "PLAN_EMPTY") out.push({ code: "PLAN_EMPTY", title: t("vrev_blocker_empty"), message: b.message, how: t("vrev_how_empty") });
    }
    for (const inc of plan.incompatibilities ?? []) {
      out.push({ code: "TEMPLATE_INCOMPATIBLE", title: t("vrev_blocker_template"), message: inc.message, how: t("vrev_how_template", { template: inc.template }) });
    }
    for (const b of listed) {
      if (b.code === "REQUIREMENT_UNCOVERED") out.push({ code: "CATEGORY_EMPTY", title: t("vrev_blocker_category"), message: b.message, how: t("vrev_how_category") });
    }
    // Architecture the profile or the project asked for, with no tool able to judge any rule.
    for (const r of (plan.requirements ?? []) as any[]) {
      if (r.selector !== "capability:architecture" && r.selector !== "category:architecture") continue;
      if (!OWN_LAYERS.has(String(r.requiredBy?.layer ?? ""))) continue;
      const covering = unavailable.filter((u) => (r.coveredBy ?? []).includes(u.id));
      if (covering.length === 0 || covering.length < (r.coveredBy ?? []).length) continue;
      for (const c of covering) architecture.add(c.id);
      out.push({ code: "ARCHITECTURE_NO_RULES", title: t("vrev_blocker_architecture"), message: covering.map((c) => c.reason).join(" "), how: t("vrev_how_architecture") });
    }
    for (const b of listed) {
      if (b.code === "CONFIG_INVALID") out.push({ code: "CONFIG_INVALID", title: t("vrev_blocker_config"), message: b.message, how: t("vrev_how_config") });
    }
    if (unresolvedDrafts > 0) out.push({ code: "UNSAVED_DOCUMENT", title: t("vrev_blocker_unsaved"), message: t("vrev_unsaved_message", { count: unresolvedDrafts }), how: t("vrev_how_unsaved") });
    const seen = new Set<string>();
    for (const u of unavailable) {
      if (!u.blocking || architecture.has(u.id)) continue;
      const key = `${u.version ? "V" : "T"}:${u.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ code: u.version ? "VERSION_OUT_OF_RANGE" : "TOOL_UNAVAILABLE", title: u.version ? t("vrev_blocker_version") : t("vrev_blocker_tool"), message: `${u.tool}: ${u.reason}`, how: u.how });
    }
    // The plan's own blockers that the list above does not name (a tool the plan itself refuses, the network policy...).
    for (const b of listed) {
      if (["PLAN_EMPTY", "REQUIREMENT_UNCOVERED", "CONFIG_INVALID"].includes(b.code)) continue;
      if (b.code === "TOOL_UNAVAILABLE" && unavailable.some((u) => u.blocking)) continue;
      out.push({ code: b.code, title: tOr(`vrev_blocker_${String(b.code).toLowerCase()}`, b.code), message: b.message, how: tOr(`vrev_how_${String(b.code).toLowerCase()}`, t("vrev_how_build")) });
    }
  } else if (unresolvedDrafts > 0) {
    out.push({ code: "UNSAVED_DOCUMENT", title: t("vrev_blocker_unsaved"), message: t("vrev_unsaved_message", { count: unresolvedDrafts }), how: t("vrev_how_unsaved") });
  }
  return out;
}
