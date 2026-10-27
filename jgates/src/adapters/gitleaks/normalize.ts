// Reads the JSON report of `gitleaks dir|git --report-format json` (fixtures of 8.30.1 in
// tests/fixtures/parsers/security/gitleaks). Fail-closed: anything but an array of findings with a rule, a file and a
// line proves nothing. The secret never leaves the parser: the command always redacts it, and the parser masks it
// again in the evidence in case a report carries it anyway.
import { finding, versionProblem, workspacePath, type ParseOptions, type ParseResult, type ScannerFinding } from "../container-scanner/index.js";
import { gitleaksManifest } from "./manifest.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
export const REDACTED = "REDACTED";

/** The match with the secret replaced by REDACTED (and never longer than a line). */
export function maskMatch(match: string, secret: string): string {
  let out = match;
  if (secret && secret !== REDACTED) out = out.split(secret).join(REDACTED);
  out = out.split(/\r?\n/)[0] ?? "";
  return out.length > 200 ? `${out.slice(0, 200)}…` : out;
}

export function parseGitleaksReport(text: string, options: ParseOptions): ParseResult {
  // One instance scans one scope: the directory (secrets) or the Git history (secrets-history).
  const capability = options.capabilities[0] === "secrets-history" ? "secrets-history" : "secrets";
  const version = versionProblem(gitleaksManifest, options.version, null);
  if (version) return { ok: false, findings: [], problem: version };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ok: false, findings: [], problem: error instanceof Error ? error.message : String(error) };
  }
  if (!Array.isArray(doc)) return { ok: false, findings: [], problem: "the report is not an array of findings" };
  const findings: ScannerFinding[] = [];
  for (const [index, entry] of doc.entries()) {
    if (!isRec(entry) || typeof entry.RuleID !== "string" || typeof entry.File !== "string" || typeof entry.StartLine !== "number") {
      return { ok: false, findings: [], problem: `finding ${index} has no RuleID, File or StartLine` };
    }
    const secret = typeof entry.Secret === "string" ? entry.Secret : "";
    const match = typeof entry.Match === "string" ? maskMatch(entry.Match, secret) : REDACTED;
    const commit = typeof entry.Commit === "string" && entry.Commit !== "" ? entry.Commit : null;
    const description = typeof entry.Description === "string" && entry.Description !== "" ? entry.Description : `Gitleaks rule ${entry.RuleID}`;
    findings.push(
      finding({
        tool: gitleaksManifest.toolName,
        version: options.version,
        capability,
        category: "secrets",
        ruleId: entry.RuleID,
        // Every leak is critical: a valid credential in the code is never a minor finding.
        severity: "critical",
        message: commit ? `${description} (commit ${commit.slice(0, 12)})` : description,
        file: workspacePath(entry.File, options.cwd),
        line: entry.StartLine >= 1 ? entry.StartLine : undefined,
        column: typeof entry.StartColumn === "number" && entry.StartColumn >= 1 ? entry.StartColumn : undefined,
        nativeFingerprint: typeof entry.Fingerprint === "string" ? entry.Fingerprint : undefined,
        evidence: match,
        extra: commit,
      }),
    );
  }
  return { ok: true, findings };
}
