import { translator } from "../../i18n/index.js";

/** Stable codes of the distribution check; the human text is in the catalog area (distribution_problem_<code>). */
export type DistributionProblemCode =
  | "DISTRIBUTION_MISSING"
  | "PROVENANCE_MISSING"
  | "PROVENANCE_INVALID"
  | "PROVENANCE_INCOMPLETE"
  | "LICENSE_NOT_ELIGIBLE"
  | "NOTICE_MISSING"
  | "RESTRICTED_MATERIAL"
  | "RESTRICTED_SOURCE"
  | "NOT_SHIPPABLE"
  | "REVIEW_PENDING"
  | "ARTIFACT_MISMATCH"
  | "UNSCANNABLE_FILE"
  | "ACQUISITION_MISSING"
  | "VERSIONS_MISSING";

export interface ProblemExtra {
  file?: string;
  detail?: string;
}

export interface DistributionProblem extends ProblemExtra {
  code: DistributionProblemCode;
  /** The pack id, the loose file name or the adapter id. */
  subject: string;
  message: string;
}

export function problem(code: DistributionProblemCode, subject: string, extra: ProblemExtra = {}): DistributionProblem {
  const t = translator("catalog");
  const message = t(`distribution_problem_${code.toLowerCase()}`, { subject, file: extra.file ?? "-", detail: extra.detail ?? "-" });
  return { code, subject, ...(extra.file !== undefined ? { file: extra.file } : {}), ...(extra.detail !== undefined ? { detail: extra.detail } : {}), message };
}
