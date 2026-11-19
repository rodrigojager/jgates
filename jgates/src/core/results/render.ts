// The text a terminal user reads about waivers and findings: the lines after "approved with N waivers", the waivers that
// did not apply, and a short fingerprint per finding that `jgates waivers add --finding` accepts. `jgates run` and
// `jgates report <run> --format text` call the same function, so both say the same. A finding's message is never printed
// here (it may carry a secret or a personal value): the rule, the file and the line say what it is.
import { translator, type Translator } from "../../i18n/index.js";
import type { ResultFinding, RunResult } from "../run/types.js";
import { FINGERPRINT_PREFIX } from "./fingerprint.js";
import type { WaiverRecordEntry } from "./waivers.js";
import { approvalWording, approvalWordingParams, informationalCount, isInformational, isReview, reviewCount } from "./wording.js";

function decisionSummary(r: RunResult, t: Translator): string {
  const missing = r.unsatisfied.length;
  switch (r.decision) {
    case "passed": {
      // A pass with waivers is never worded as a plain approval (the decision and the exit code stay the same).
      const wording = approvalWording(r);
      const params = approvalWordingParams(wording);
      const withWaivers = wording.kind === "with-waivers";
      if (r.reduced) {
        const count = r.disabled.filter((d) => d.origin === "run").length;
        return withWaivers ? t("run_summary_passed_reduced_waivers", { count, ...params }) : t("run_summary_passed_reduced", { count });
      }
      return withWaivers ? t("run_summary_passed_waivers", params) : t("run_summary_passed");
    }
    case "failed":
      return r.complete ? t("run_summary_failed", { count: r.blockingViolations }) : t("run_summary_failed_incomplete", { count: r.blockingViolations, missing });
    case "incomplete":
      return t("run_summary_incomplete", { count: missing });
    default:
      return t("run_summary_other", { decision: r.decision });
  }
}

/**
 * The one-line summary of a result ("approved", "approved with 1 waiver", "failed: 2 blocking violations"...), with the
 * notes about a stale or dirty analysis. `jgates run` stores it in the result; `jgates report` computes it again, so a
 * result stored before the waivers block still reads as approved with waivers.
 */
export function resultSummary(r: RunResult, t: Translator = translator("run")): string {
  const notes = r.analyzed?.stale ? t("run_summary_stale") : r.analyzed?.dirty === true ? t("run_summary_dirty") : "";
  // The verdict counts only the blocking findings; the ones that do not block are added as "and N informational".
  const informational = r.decision === "passed" || r.decision === "failed" ? informationalCount(r) : 0;
  const review = r.decision === "passed" || r.decision === "failed" ? reviewCount(r) : 0;
  return decisionSummary(r, t) + (informational > 0 ? t("run_summary_informational", { count: informational }) : "") + (review > 0 ? t("run_summary_review", { count: review }) : "") + notes;
}

/** Digits of a fingerprint shown in the terminal (the first ones after `jgf1:`); any longer unique prefix works as well. */
export const SHORT_FINGERPRINT_DIGITS = 12;

/** The short fingerprint of a finding, or null when it has none (a result stored by an old version). */
export function shortFingerprint(finding: Pick<ResultFinding, "fingerprint">): string | null {
  const fp = finding.fingerprint;
  if (!fp) return null;
  const body = fp.startsWith(FINGERPRINT_PREFIX) ? fp.slice(FINGERPRINT_PREFIX.length) : fp;
  return body.slice(0, SHORT_FINGERPRINT_DIGITS);
}

/** Findings listed in the text of a run before the rest is summarized as a count. */
export const MAX_TEXT_FINDINGS = 50;

function placeOf(entry: Pick<WaiverRecordEntry, "path" | "line">): string {
  const p = entry.path ?? "*";
  return entry.line !== undefined ? `${p}:${entry.line}` : p;
}

function entryLine(t: Translator, entry: WaiverRecordEntry): string {
  const date = entry.expires ? t("waiver_text_until", { date: entry.expires }) : t("waiver_text_no_date");
  const covered = entry.findings > 1 ? `  ${t("waiver_text_covers", { count: entry.findings })}` : "";
  const source = entry.source === "project" ? "" : `  [${entry.source}]`;
  const reviewed = entry.reviewed ? `  [${t("waiver_text_reviewed", { count: entry.reviewed })}]` : "";
  return `  ${entry.rule ?? "-"}  ${placeOf(entry)}  "${entry.reason ?? ""}"  ${date}${covered}${source}${reviewed}`;
}

export interface WaiverTextOptions {
  /** The run was asked for `--no-waivers` (a stored result does not say it; its `refused` list does). */
  noWaivers?: boolean;
}

/**
 * The waiver lines of a result: the unreadable-file warning, then what `--no-waivers` refused, then the waivers that
 * applied (rule, file and line, reason, date), then the ones that were stale, expired or unmatched. Empty for a result
 * with nothing to say about waivers.
 */
export function waiverLines(result: Pick<RunResult, "waivers" | "decision" | "findings">, options: WaiverTextOptions = {}, t: Translator = translator("run")): string[] {
  const lines: string[] = [];
  const block = result.waivers;
  if (block?.problem) lines.push(t("run_text_waivers_problem", { file: block.problem.file, detail: block.problem.message }));
  if (block) {
    if (block.refused.length > 0 || options.noWaivers) {
      lines.push(t("waiver_text_refused", { count: block.refused.length }));
      for (const e of block.refused) lines.push(entryLine(t, e));
    }
    if (block.applied.length > 0) {
      lines.push(t("waiver_text_applied_title", { count: block.applied.length }));
      for (const e of block.applied) lines.push(entryLine(t, e));
    }
    const groups: Array<[string, WaiverRecordEntry[]]> = [
      ["waiver_text_stale_title", block.stale],
      ["waiver_text_expired_title", block.expired],
      ["waiver_text_unmatched_title", block.unmatched],
    ];
    for (const [key, list] of groups) {
      if (list.length === 0) continue;
      lines.push(t(key, { count: list.length }));
      for (const e of list) lines.push(entryLine(t, e) + (e.cause ? `  (${t(`waiver_text_cause_${e.cause === "line-changed" ? "line_changed" : "count_changed"}`)})` : ""));
    }
  } else {
    // A result stored before the waivers block: only its waived findings can be listed.
    const waived = (result.findings ?? []).filter((f) => f.waived === true);
    if (result.decision === "passed" && waived.length > 0) {
      lines.push(t("waiver_text_applied_title", { count: new Set(waived.map((f) => f.waiverId ?? f.waiverReason ?? "waiver")).size }));
      for (const f of waived) {
        const date = f.waiverExpires ? t("waiver_text_until", { date: f.waiverExpires }) : t("waiver_text_no_date");
        lines.push(`  ${f.ruleId}  ${f.location?.path ?? "-"}${f.location?.line !== undefined ? `:${f.location.line}` : ""}  "${f.waiverReason ?? ""}"  ${date}${f.review ? `  [${t("waiver_text_reviewed", { count: 1 })}]` : ""}`);
      }
    }
  }
  return lines;
}

/** One line per finding that is not waived (blocking first): short fingerprint, severity, rule, place. Capped. */
export function findingLines(result: Pick<RunResult, "findings" | "runId">, t: Translator = translator("run")): string[] {
  const active = (result.findings ?? []).filter((f) => !f.waived);
  if (active.length === 0) return [];
  const blocking = active.filter((f) => !isInformational(f) && !isReview(f));
  const informational = active.filter(isInformational);
  const review = active.filter(isReview);
  const lineOf = (f: ResultFinding): string => {
    const where = f.location?.path ? `${f.location.path}${f.location.line !== undefined ? `:${f.location.line}` : ""}` : "-";
    const asvs = f.asvsRequirements && f.asvsRequirements.length > 0 ? `  ${asvsLabel(f.asvsRequirements)}` : "";
    return `  ${(shortFingerprint(f) ?? "-").padEnd(SHORT_FINGERPRINT_DIGITS)}  ${f.normalizedSeverity}${f.blocking ? "*" : ""}  ${f.ruleId}  ${where}${asvs}`;
  };
  const lines: string[] = [];
  let room = MAX_TEXT_FINDINGS;
  // Keep at least one row visible for each category represented in the preview.
  const reviewSlot = Number(review.length > 0);
  if (blocking.length > 0) {
    const shown = blocking.slice(0, room - Number(informational.length > 0) - reviewSlot);
    lines.push(t("run_text_findings_title", { count: blocking.length }));
    for (const f of shown) lines.push(lineOf(f));
    room -= shown.length;
  }
  if (informational.length > 0) {
    const shown = informational.slice(0, room - reviewSlot);
    lines.push(t("run_text_informational_title", { count: informational.length }));
    for (const f of shown) lines.push(lineOf(f));
    room -= shown.length;
  }
  if (review.length > 0) {
    lines.push(t("run_text_review_title", { count: review.length }));
    for (const f of review.slice(0, room)) lines.push(lineOf(f));
  }
  if (active.length > MAX_TEXT_FINDINGS) lines.push(t("run_text_findings_more", { count: active.length - MAX_TEXT_FINDINGS, runId: result.runId }));
  if (blocking.length > 0) lines.push(t("run_text_findings_hint"));
  return lines;
}

/** The label of the requirement ids a rule was written for: "ASVS V3.3.1, V3.3.2". It never says a requirement is met. */
export function asvsLabel(ids: readonly string[]): string {
  return `ASVS ${ids.join(", ")}`;
}
