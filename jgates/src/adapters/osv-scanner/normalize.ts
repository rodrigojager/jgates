// Reads the JSON report of `osv-scanner scan source --format json` (v2; fixtures of 2.4.0 in
// tests/fixtures/parsers/security/osv-scanner). One finding per vulnerability group (an advisory and its aliases) of a
// package. Fail-closed: a document without the results list, or a package or group of an unknown shape, proves nothing.
import { finding, versionProblem, workspacePath, type ParseOptions, type ParseResult, type ScannerFinding } from "../container-scanner/index.js";
import { osvScannerManifest } from "./manifest.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Severity label of a CVSS base score (the max_severity of a group). */
export function severityOfScore(score: number): string {
  if (score >= 9) return "CRITICAL";
  if (score >= 7) return "HIGH";
  if (score >= 4) return "MEDIUM";
  if (score > 0) return "LOW";
  return "UNKNOWN";
}

export function parseOsvReport(text: string, options: ParseOptions): ParseResult {
  const version = versionProblem(osvScannerManifest, options.version, null);
  if (version) return { ok: false, findings: [], problem: version };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ok: false, findings: [], problem: error instanceof Error ? error.message : String(error) };
  }
  if (!isRec(doc) || !Array.isArray(doc.results)) return { ok: false, findings: [], problem: "the report has no results list" };
  const findings: ScannerFinding[] = [];
  for (const [index, result] of doc.results.entries()) {
    if (!isRec(result) || !isRec(result.source) || !str(result.source.path) || !Array.isArray(result.packages)) {
      return { ok: false, findings: [], problem: `result ${index} has no source path or packages list` };
    }
    const file = workspacePath(result.source.path as string, options.cwd);
    for (const pkg of result.packages) {
      if (!isRec(pkg) || !isRec(pkg.package) || !str(pkg.package.name)) return { ok: false, findings: [], problem: `a package of ${file} has no name` };
      const vulns = pkg.vulnerabilities ?? [];
      const groups = pkg.groups ?? [];
      if (!Array.isArray(vulns) || !Array.isArray(groups)) return { ok: false, findings: [], problem: `the package ${String(pkg.package.name)} has no vulnerabilities or groups list` };
      const byId = new Map<string, Rec>();
      for (const v of vulns) {
        if (!isRec(v) || !str(v.id)) return { ok: false, findings: [], problem: `a vulnerability of ${String(pkg.package.name)} has no id` };
        byId.set(v.id as string, v);
      }
      // Without groups (an older shape) every vulnerability is its own group.
      const effective = groups.length > 0 ? groups : vulns.map((v) => ({ ids: [(v as Rec).id], aliases: (v as Rec).aliases ?? [], max_severity: "" }));
      for (const g of effective) {
        if (!isRec(g) || !Array.isArray(g.ids) || !str(g.ids[0])) return { ok: false, findings: [], problem: `a group of ${String(pkg.package.name)} has no ids` };
        const id = g.ids[0] as string;
        const vuln = byId.get(id) ?? {};
        const score = Number(g.max_severity);
        const dbSeverity = isRec(vuln.database_specific) ? str(vuln.database_specific.severity) : null;
        const severity = Number.isFinite(score) && str(g.max_severity) ? severityOfScore(score) : (dbSeverity ?? "UNKNOWN");
        const name = pkg.package.name as string;
        const pkgVersion = str(pkg.package.version) ?? "?";
        const aliases = Array.isArray(g.aliases) ? g.aliases.filter((a): a is string => typeof a === "string" && a !== id) : [];
        findings.push(
          finding({
            tool: osvScannerManifest.toolName,
            version: options.version,
            capability: "dependencies",
            category: "dependencies",
            ruleId: id,
            severity,
            message: `${name}@${pkgVersion}: ${str(vuln.summary) ?? id}${aliases.length > 0 ? ` (${aliases.join(", ")})` : ""}${str(g.max_severity) ? ` [CVSS ${String(g.max_severity)}]` : ""}`,
            file,
            docsUrl: `https://osv.dev/vulnerability/${encodeURIComponent(id)}`,
            extra: [name, pkgVersion, str(pkg.package.ecosystem)],
          }),
        );
      }
    }
  }
  return { ok: true, findings };
}
