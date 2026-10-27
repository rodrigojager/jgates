// Fingerprint of a finding. Versioned: v1 combines the tool, the rule, the normalized
// path and the occurrence number of the finding among those of the same tool, rule and file (in line order). It never
// reads the line number itself (inserting lines above keeps it), the message or the evidence (they may carry a secret
// or PII), so the hash holds nothing the finding could leak. Two findings of the same rule in the same file differ by
// occurrence, so they never collide.
import crypto from "node:crypto";
import type { ResultFinding } from "../run/types.js";

export const FINGERPRINT_VERSION = 1;
export const FINGERPRINT_PREFIX = "jgf1:";

/** Path as the fingerprint sees it: forward slashes, no leading ./ and no duplicate separators. */
export function normalizeFindingPath(p: string): string {
  const parts = p
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  return parts.join("/");
}

export function fingerprintOf(input: { tool: string; ruleId: string; path: string; occurrence: number }): string {
  const body = JSON.stringify([FINGERPRINT_VERSION, input.tool, input.ruleId, normalizeFindingPath(input.path), input.occurrence]);
  return FINGERPRINT_PREFIX + crypto.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 32);
}

/** Gives every finding its v1 fingerprint; the one it came with is kept as nativeFingerprint. Does not mutate. */
export function assignFingerprints(findings: ResultFinding[]): ResultFinding[] {
  const groups = new Map<string, number[]>();
  findings.forEach((f, index) => {
    const key = JSON.stringify([f.tool, f.ruleId, normalizeFindingPath(f.location?.path ?? "")]);
    const list = groups.get(key);
    if (list) list.push(index);
    else groups.set(key, [index]);
  });
  const out = findings.map((f) => ({ ...f }));
  for (const indexes of groups.values()) {
    const ordered = [...indexes].sort(
      (a, b) =>
        (findings[a]!.location?.line ?? 0) - (findings[b]!.location?.line ?? 0) ||
        (findings[a]!.location?.column ?? 0) - (findings[b]!.location?.column ?? 0) ||
        a - b,
    );
    ordered.forEach((index, occurrence) => {
      const f = out[index]!;
      if (f.fingerprint && !f.fingerprint.startsWith(FINGERPRINT_PREFIX) && !f.nativeFingerprint) f.nativeFingerprint = f.fingerprint;
      f.fingerprint = fingerprintOf({ tool: f.tool, ruleId: f.ruleId, path: f.location?.path ?? "", occurrence });
      f.fingerprintVersion = FINGERPRINT_VERSION;
    });
  }
  return out;
}
