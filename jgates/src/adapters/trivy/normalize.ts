// Reads the JSON report of `trivy fs --format json` (SchemaVersion 2; fixtures of 0.72.0 in
// tests/fixtures/parsers/security/trivy) and the metadata of the vulnerability database it downloaded.
// Fail-closed: another schema version, a report written by a version outside the parser's range or an entry without
// its identifier proves nothing.
import fs from "node:fs";
import path from "node:path";
import { finding, versionProblem, workspacePath, type AnalysisFacts, type ParseOptions, type ParseResult, type ScannerFinding } from "../container-scanner/index.js";
import { trivyManifest } from "./manifest.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const list = (v: unknown): unknown[] | null => (v === undefined || v === null ? [] : Array.isArray(v) ? v : null);

export const TRIVY_SCHEMA_VERSION = 2;
/** The repository Trivy 0.72 downloads its database from when the log does not say. */
export const TRIVY_DEFAULT_DB = "mirror.gcr.io/aquasec/trivy-db:2";

export function parseTrivyReport(text: string, options: ParseOptions): ParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ok: false, findings: [], problem: error instanceof Error ? error.message : String(error) };
  }
  if (!isRec(doc)) return { ok: false, findings: [], problem: "the report is not an object" };
  if (doc.SchemaVersion !== TRIVY_SCHEMA_VERSION) return { ok: false, findings: [], problem: `SchemaVersion ${JSON.stringify(doc.SchemaVersion)} is not ${TRIVY_SCHEMA_VERSION}` };
  const reported = isRec(doc.Trivy) ? str(doc.Trivy.Version) : null;
  const version = versionProblem(trivyManifest, options.version, reported);
  if (version) return { ok: false, findings: [], problem: version, reportedVersion: reported };
  const results = list(doc.Results);
  if (results === null) return { ok: false, findings: [], problem: "Results is not a list" };
  const findings: ScannerFinding[] = [];
  const common = { tool: trivyManifest.toolName, version: reported ?? options.version };
  for (const [index, result] of results.entries()) {
    if (!isRec(result) || typeof result.Target !== "string") return { ok: false, findings: [], problem: `result ${index} has no Target` };
    const file = workspacePath(result.Target, options.cwd);
    const vulns = list(result.Vulnerabilities);
    const misconfigs = list(result.Misconfigurations);
    const secrets = list(result.Secrets);
    const licenses = list(result.Licenses);
    if (!vulns || !misconfigs || !secrets || !licenses) return { ok: false, findings: [], problem: `result ${index} has a list that is not a list` };
    for (const v of vulns) {
      if (!isRec(v) || !str(v.VulnerabilityID) || !str(v.PkgName)) return { ok: false, findings: [], problem: `a vulnerability of ${result.Target} has no VulnerabilityID or PkgName` };
      const fixed = str(v.FixedVersion);
      findings.push(
        finding({
          ...common,
          capability: "dependencies",
          category: "dependencies",
          ruleId: v.VulnerabilityID as string,
          severity: str(v.Severity) ?? "UNKNOWN",
          message: `${v.PkgName}@${str(v.InstalledVersion) ?? "?"}: ${str(v.Title) ?? v.VulnerabilityID}${fixed ? ` (fixed in ${fixed})` : ""}`,
          file,
          docsUrl: str(v.PrimaryURL) ?? undefined,
          extra: [v.PkgName, v.InstalledVersion ?? null],
        }),
      );
    }
    for (const m of misconfigs) {
      if (!isRec(m) || !str(m.ID)) return { ok: false, findings: [], problem: `a misconfiguration of ${result.Target} has no ID` };
      // Only failures are findings; a report with successes (--include-non-failures) lists them too.
      if (str(m.Status) !== null && m.Status !== "FAIL") continue;
      const cause = isRec(m.CauseMetadata) ? m.CauseMetadata : {};
      const line = typeof cause.StartLine === "number" && cause.StartLine >= 1 ? cause.StartLine : undefined;
      findings.push(
        finding({
          ...common,
          capability: "iac",
          category: "iac",
          ruleId: m.ID as string,
          severity: str(m.Severity) ?? "UNKNOWN",
          message: str(m.Message) ?? str(m.Title) ?? (m.ID as string),
          file,
          line,
          docsUrl: str(m.PrimaryURL) ?? undefined,
          extra: str(cause.Resource),
        }),
      );
    }
    for (const s of secrets) {
      if (!isRec(s) || !str(s.RuleID)) return { ok: false, findings: [], problem: `a secret of ${result.Target} has no RuleID` };
      // No evidence: the match is masked by Trivy, but the gate keeps no part of a secret line at all.
      findings.push(
        finding({
          ...common,
          capability: "secrets",
          category: "secrets",
          ruleId: s.RuleID as string,
          severity: str(s.Severity) ?? "CRITICAL",
          message: str(s.Title) ?? (s.RuleID as string),
          file,
          line: typeof s.StartLine === "number" && s.StartLine >= 1 ? s.StartLine : undefined,
        }),
      );
    }
    for (const l of licenses) {
      if (!isRec(l) || !str(l.Name)) return { ok: false, findings: [], problem: `a license of ${result.Target} has no Name` };
      findings.push(
        finding({
          ...common,
          capability: "licenses",
          category: "licenses",
          ruleId: `license:${l.Name as string}`,
          severity: str(l.Severity) ?? "UNKNOWN",
          message: `${str(l.PkgName) ?? result.Target}: ${l.Name as string}`,
          file: workspacePath(str(l.FilePath) ?? result.Target, options.cwd),
          extra: str(l.PkgName),
        }),
      );
    }
  }
  return { ok: true, findings, reportedVersion: reported };
}

/** The repository the database came from, as Trivy logs it (`repo="..."` of the download). */
export function databaseSource(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/).filter((l) => /\[vulndb\]/.test(l));
  for (const line of lines.reverse()) {
    const m = /repo="([^"]+)"/.exec(line);
    if (m && /successfully downloaded|Downloading artifact/i.test(line)) return m[1] ?? null;
  }
  return null;
}

/** Facts of the vulnerability database: the metadata Trivy keeps next to it in its cache folder. */
export function trivyFacts(cacheDir: string, stderr: string): AnalysisFacts {
  let meta: unknown;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(cacheDir, "db", "metadata.json"), "utf8"));
  } catch {
    return {};
  }
  if (!isRec(meta)) return {};
  return {
    database: {
      source: databaseSource(stderr) ?? TRIVY_DEFAULT_DB,
      updatedAt: str(meta.UpdatedAt),
      nextUpdate: str(meta.NextUpdate),
      downloadedAt: str(meta.DownloadedAt),
      reported: str(meta.UpdatedAt) !== null,
      networkRequired: true,
    },
  };
}
