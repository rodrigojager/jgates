// Normalizes the SARIF 2.1.0 file `codeql database analyze --format=sarif-latest` writes into result findings, on top of
// the shared SARIF reader (`core/evidence/sarif-read.ts`). Fail-closed: a document that is not SARIF, a run whose
// driver is not CodeQL, or a result without a rule, a message or a location proves nothing (an empty `results` list
// is the clean answer). High and critical findings and every `error` block, an unknown level blocks too.
import { readSarif } from "../../core/evidence/sarif-read.js";
import { contentHash } from "../../core/ids/index.js";
import type { ResultFinding } from "../../core/run/types.js";

export interface CodeqlParse {
  ok: boolean;
  findings: ResultFinding[];
  /** The version the driver reports (semanticVersion), when the SARIF says one. */
  driverVersion: string | null;
  /** Why the output could not be interpreted. */
  problem?: string;
}

export function parseCodeqlSarif(text: string, opts: { stageId: string; version: string | null; root: string }): CodeqlParse {
  const read = readSarif(text, { driver: /codeql/i, root: opts.root, requireLocation: true });
  if (!read.ok) return { ok: false, findings: [], driverVersion: null, problem: read.problem ?? "unreadable SARIF" };
  const findings: ResultFinding[] = read.findings.map((f) => {
    const blocking = !f.known || f.normalizedSeverity === "critical" || f.normalizedSeverity === "high" || f.level === "error";
    const cwe = f.tags.filter((x) => /cwe-\d+/i.test(x));
    const filePath = f.path as string;
    return {
      stageId: opts.stageId,
      tool: "codeql",
      ...(opts.version ? { toolVersion: opts.version } : {}),
      ruleId: f.ruleId,
      category: "dataflow",
      severity: f.securitySeverity !== undefined ? `${f.level} (security-severity ${f.securitySeverity})` : f.level,
      normalizedSeverity: f.normalizedSeverity,
      message: cwe.length > 0 ? `${f.message} [${cwe.map((c) => c.replace(/^external\/cwe\//i, "").toUpperCase()).join(", ")}]` : f.message,
      location: { path: filePath, ...(f.line !== undefined ? { line: f.line } : {}), ...(f.column !== undefined ? { column: f.column } : {}) },
      fingerprint: contentHash({ tool: "codeql", rule: f.ruleId, file: filePath, line: f.line ?? null, message: f.message, native: f.nativeFingerprint }),
      ...(f.nativeFingerprint ? { nativeFingerprint: f.nativeFingerprint } : {}),
      origin: "codeql",
      blocking,
      ...(blocking ? { blockingReason: "blocking-tool" as const } : {}),
      waived: false,
      ...(f.help ? { remediation: f.help.slice(0, 500) } : {}),
    };
  });
  return { ok: true, findings, driverVersion: read.driverVersion };
}
