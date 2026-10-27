// Reads the JSON report of `checkov --output json` (Checkov 3; fixtures of 3.3.8 in
// tests/fixtures/parsers/security/checkov): one document per framework (or a list of them), or the official empty
// summary when nothing applies. Fail-closed: any other shape, or a report written by a version outside the parser's
// range (summary.checkov_version), proves nothing.
import { finding, versionProblem, workspacePath, type ParseOptions, type ParseResult, type ScannerFinding } from "../container-scanner/index.js";
import { checkovManifest } from "./manifest.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const COUNTERS = ["passed", "failed", "skipped", "parsing_errors", "resource_count"];

/** Checkov's zero-resource answer: only the counters (all 0) and its version. */
function isEmptySummary(doc: Rec): boolean {
  const keys = Object.keys(doc).sort();
  const expected = [...COUNTERS, "checkov_version"].sort();
  return JSON.stringify(keys) === JSON.stringify(expected) && COUNTERS.every((c) => doc[c] === 0) && str(doc.checkov_version) !== null;
}

export function parseCheckovReport(text: string, options: ParseOptions): ParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ok: false, findings: [], problem: error instanceof Error ? error.message : String(error) };
  }
  const documents = Array.isArray(doc) ? doc : [doc];
  if (documents.length === 0) return { ok: false, findings: [], problem: "the report is an empty list" };
  const findings: ScannerFinding[] = [];
  let reported: string | null = null;
  for (const [index, d] of documents.entries()) {
    if (!isRec(d)) return { ok: false, findings: [], problem: `document ${index} is not an object` };
    if (isEmptySummary(d)) {
      reported = str(d.checkov_version);
      continue;
    }
    if (!isRec(d.results) || !isRec(d.summary)) return { ok: false, findings: [], problem: `document ${index} has no results or summary object` };
    reported = str(d.summary.checkov_version) ?? reported;
    if (typeof d.summary.parsing_errors === "number" && d.summary.parsing_errors > 0) {
      return { ok: false, findings: [], problem: `Checkov could not parse ${d.summary.parsing_errors} file(s) of ${String(d.check_type ?? "?")}` };
    }
    const failed = d.results.failed_checks ?? [];
    if (!Array.isArray(failed)) return { ok: false, findings: [], problem: `document ${index} has failed_checks that is not a list` };
    for (const c of failed) {
      if (!isRec(c) || !str(c.check_id)) return { ok: false, findings: [], problem: `a failed check of document ${index} has no check_id` };
      const range = Array.isArray(c.file_line_range) ? c.file_line_range : [];
      const line = typeof range[0] === "number" && range[0] >= 1 ? range[0] : undefined;
      const file = str(c.file_abs_path) ?? (str(c.file_path) ? `${options.cwd}/${(c.file_path as string).replace(/^\/+/, "")}` : null);
      if (!file) return { ok: false, findings: [], problem: `the failed check ${String(c.check_id)} has no file` };
      findings.push(
        finding({
          tool: checkovManifest.toolName,
          version: reported ?? options.version,
          capability: "iac",
          category: "iac",
          ruleId: c.check_id as string,
          // Offline Checkov has no severity (Prisma Cloud data); a missing one is MEDIUM, as the bridge always did.
          severity: str(c.severity) ?? "MEDIUM",
          message: `${str(c.check_name) ?? c.check_id}${str(c.resource) ? ` (${String(c.resource)})` : ""}`,
          file: workspacePath(file, options.cwd),
          line,
          docsUrl: str(c.guideline) ?? undefined,
          extra: str(c.resource),
        }),
      );
    }
  }
  const version = versionProblem(checkovManifest, options.version, reported);
  if (version) return { ok: false, findings: [], problem: version, reportedVersion: reported };
  return { ok: true, findings, reportedVersion: reported };
}
