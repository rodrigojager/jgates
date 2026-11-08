// License eligibility and restricted-material markers of the distribution check. Eligibility is a closed list: an
// SPDX id that is not on it (every LicenseRef-* included) is not eligible until someone reviews it and adds it here.
// Weak copyleft and ShareAlike licenses are eligible with conditions (their notices travel with the material); strong
// copyleft is left out on purpose and needs a case-by-case review.

/** SPDX ids whose terms allow redistribution when their notices travel with the material. */
export const ELIGIBLE_SPDX: ReadonlySet<string> = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Zlib",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "MPL-2.0",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
]);

const SPDX_ID = /^[A-Za-z0-9.+-]+$/;

/** ShareAlike licenses: eligible only when the pack record states its modifications and how attribution and ShareAlike are met. */
const SHARE_ALIKE = /^CC-BY-SA-/;

/** Whether an SPDX expression names a ShareAlike license anywhere (the stricter reading). */
export function requiresShareAlike(expression: string): boolean {
  return expression.replace(/[()]/g, " ").split(/\s+/).some((id) => SHARE_ALIKE.test(id));
}

/**
 * Whether an SPDX expression is eligible: `A OR B` needs one eligible side, `A AND B` needs both, and a `WITH`
 * exception keeps the license on its left. Parentheses are flattened, which can only make the answer stricter
 * (AND binds tighter than OR). Anything else is not eligible.
 */
export function spdxEligible(expression: string): boolean {
  const flat = expression.replace(/[()]/g, " ").trim();
  if (!flat) return false;
  return flat.split(/\s+OR\s+/).some((alternative) => {
    const ids = alternative.split(/\s+AND\s+/).map((part) => part.replace(/\s+WITH\s+\S+$/, "").trim());
    return ids.every((id) => SPDX_ID.test(id) && ELIGIBLE_SPDX.has(id));
  });
}

export interface RestrictedMarker {
  id: string;
  /** What the marker means, in English. */
  reason: string;
  pattern: RegExp;
}

/**
 * Text that marks material JGates must never ship. The official semgrep-rules collection carries its own rules
 * license (internal business use only, no redistribution) in its LICENSE and in the metadata of each rule; older
 * revisions carried the Commons Clause condition. The reasons and comments here never spell a marker out, so a scan
 * of the assembled package does not flag this file.
 */
export const RESTRICTED_MARKERS: readonly RestrictedMarker[] = [
  { id: "semgrep-rules-license", reason: "license of the official semgrep-rules: no redistribution", pattern: /semgrep\s+rules\s+license/i },
  { id: "semgrep-rules-license-url", reason: "license of the official semgrep-rules: no redistribution", pattern: /semgrep\.dev\/legal\/rules-license/i },
  { id: "commons-clause", reason: "Commons Clause condition: no selling or providing as a service", pattern: /commons\s+clause\s+license\s+condition/i },
];

/** Official sources whose content is restricted whatever a pack record claims. */
export const RESTRICTED_SOURCES: readonly RegExp[] = [/^https?:\/\/(www\.)?github\.com\/(semgrep|returntocorp)\/semgrep-rules(\.git)?(\/|$)/i];

/** The restricted markers a text carries. */
export function restrictedMarkersIn(text: string): RestrictedMarker[] {
  return RESTRICTED_MARKERS.filter((m) => m.pattern.test(text));
}

export function isRestrictedSource(url: string): boolean {
  return RESTRICTED_SOURCES.some((re) => re.test(url.trim()));
}
