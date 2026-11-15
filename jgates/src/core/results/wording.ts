// "Approved with N waivers": the wording of a result that passed. The decision stays `passed` and the exit codes keep their
// meaning; this is only what every surface (the CLI text, the agent context, the screens through the server) says. One
// function turns a result into the wording key and its numbers, so all of them agree.
import type { ResultFinding, RunResult } from "../run/types.js";

export type ApprovalWordingKind = "plain" | "with-waivers";

export interface ApprovalWording {
  kind: ApprovalWordingKind;
  /** Waivers that applied to at least one finding. */
  waivers: number;
  /** Findings those waivers dismissed. */
  findings: number;
}

type WordingSource = Pick<RunResult, "decision" | "findings"> & { waivers?: Pick<NonNullable<RunResult["waivers"]>, "count" | "findings"> };

/**
 * The wording of a result's approval. Anything that did not pass is `plain` (it is not an approval at all). A result with
 * the `waivers` block reads the block; an old stored result without it is counted from its waived findings (one waiver per
 * distinct waiver id).
 */
export function approvalWording(result: WordingSource): ApprovalWording {
  const none: ApprovalWording = { kind: "plain", waivers: 0, findings: 0 };
  if (result.decision !== "passed") return none;
  if (result.waivers) {
    return result.waivers.count > 0 ? { kind: "with-waivers", waivers: result.waivers.count, findings: result.waivers.findings } : none;
  }
  const waived = (result.findings ?? []).filter((f) => f.waived === true);
  if (waived.length === 0) return none;
  const ids = new Set(waived.map((f) => f.waiverId ?? f.waiverReason ?? "waiver"));
  return { kind: "with-waivers", waivers: ids.size, findings: waived.length };
}

/**
 * An informational finding: one a tool reported as such (the adapter sets `informational`: a policy of a standard many
 * sound projects do not follow), that does not block the validation. A waived finding blocked before the waiver and is
 * not informational. The one test every surface uses; other non-blocking findings are not told apart by it.
 */
export function isInformational(f: Pick<ResultFinding, "blocking" | "waived" | "informational">): boolean {
  return f.informational === true && f.blocking !== true && f.waived !== true;
}

/** How many informational findings a result has. */
export function informationalCount(result: Pick<RunResult, "findings">): number {
  return (result.findings ?? []).filter(isInformational).length;
}

/** The message key and parameters of the wording in a catalog that holds the `*_passed` and `*_passed_waivers` keys. */
export function approvalWordingParams(wording: ApprovalWording): { waivers: number; findings: number; more: number } {
  return { waivers: wording.waivers, findings: wording.findings, more: wording.findings > wording.waivers ? 1 : 0 };
}
