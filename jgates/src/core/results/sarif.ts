// SARIF 2.1.0 export of the findings (optional, explicit): only what SARIF can say. Metrics and the rest of the result
// contract do not travel in it.
import type { ResultFinding, RunResult } from "../run/types.js";

export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

function levelOf(f: ResultFinding): "error" | "warning" | "note" {
  switch (f.normalizedSeverity) {
    case "critical":
    case "high":
      return "error";
    case "low":
    case "info":
      return "note";
    default:
      // medium, and unknown: an unknown severity is never turned into a low one.
      return "warning";
  }
}

export function toSarif(result: Pick<RunResult, "findings" | "version" | "runId">): Record<string, unknown> {
  const rules = new Map<string, Record<string, unknown>>();
  const key = (f: ResultFinding) => `${f.tool}/${f.ruleId}`;
  for (const f of result.findings) {
    if (rules.has(key(f))) continue;
    rules.set(key(f), {
      id: key(f),
      name: f.ruleId,
      shortDescription: { text: f.ruleId },
      ...(f.docsUrl ? { helpUri: f.docsUrl } : {}),
      ...(f.remediation ? { help: { text: f.remediation } } : {}),
      properties: { tool: f.tool, ...(f.category ? { category: f.category } : {}) },
    });
  }
  const results = result.findings.map((f) => ({
    ruleId: key(f),
    level: levelOf(f),
    message: { text: f.message },
    ...(f.location
      ? {
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.location.path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/") },
                ...(f.location.line ? { region: { startLine: f.location.line, ...(f.location.column ? { startColumn: f.location.column } : {}) } } : {}),
              },
            },
          ],
        }
      : {}),
    ...(f.fingerprint ? { partialFingerprints: { [`jgates/v${f.fingerprintVersion ?? 1}`]: f.fingerprint } } : {}),
    ...(f.waived ? { suppressions: [{ kind: "external", justification: f.waiverReason ?? "waived" }] } : {}),
    properties: { severity: f.severity, normalizedSeverity: f.normalizedSeverity, blocking: f.blocking, ...(f.baselineState ? { baselineState: f.baselineState } : {}) },
  }));
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "jgates", version: result.version, rules: [...rules.values()] } },
        automationDetails: { id: result.runId },
        results,
      },
    ],
  };
}
