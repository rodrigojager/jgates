// Validates the PII-only bridge response and turns it into result findings. Fail-closed: a response that does not
// have the expected shape is not interpreted, never partially trusted. The response carries no matched text, and
// the normalization adds none: a finding is rule, entity, severity, file, line and a fixed message.
import { contentHash } from "../../core/ids/index.js";
import type { NormalizedSeverity, ResultFinding } from "../../core/run/types.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export const PII_ENTITIES = ["cpf", "cnpj", "phone", "credit-card"] as const;
export const PII_SEVERITIES = ["low", "medium", "high", "critical"] as const;

export interface PiiParse {
  ok: boolean;
  findings: ResultFinding[];
  /** The bridge answered with a structured error (invalid request, target missing...). */
  bridgeError?: { code: string; message: string };
  problem?: string;
}

export function parsePiiResponse(stdout: string, opts: { stageId: string; version: string | null }): PiiParse {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout.trim());
  } catch (error) {
    return { ok: false, findings: [], problem: error instanceof Error ? error.message : String(error) };
  }
  if (!isRec(doc) || doc.schemaVersion !== 1 || doc.operation !== "pii" || typeof doc.ok !== "boolean") {
    return { ok: false, findings: [], problem: "the response is not a PII bridge response" };
  }
  if (!doc.ok) {
    const e = isRec(doc.error) ? doc.error : {};
    return { ok: false, findings: [], bridgeError: { code: typeof e.code === "string" ? e.code : "unknown", message: (typeof e.path === "string" ? `${e.path}: ` : "") + (typeof e.message === "string" ? e.message : "") } };
  }
  if (!Array.isArray(doc.findings)) return { ok: false, findings: [], problem: "findings is not a list" };
  const findings: ResultFinding[] = [];
  for (const [index, entry] of doc.findings.entries()) {
    if (
      !isRec(entry) ||
      typeof entry.rule !== "string" ||
      !(PII_ENTITIES as readonly string[]).includes(String(entry.entity)) ||
      !(PII_SEVERITIES as readonly string[]).includes(String(entry.severity)) ||
      typeof entry.path !== "string" ||
      typeof entry.message !== "string"
    ) {
      return { ok: false, findings: [], problem: `entry ${index} has no rule, entity, severity, path or message` };
    }
    const line = typeof entry.line === "number" && entry.line >= 1 ? entry.line : undefined;
    const severity = String(entry.severity);
    findings.push({
      stageId: opts.stageId,
      tool: "builtin-pii",
      ...(opts.version ? { toolVersion: opts.version } : {}),
      ruleId: entry.rule,
      category: "pii",
      severity,
      normalizedSeverity: severity as NormalizedSeverity,
      message: entry.message,
      location: { path: entry.path, ...(line !== undefined ? { line } : {}) },
      fingerprint: contentHash({ tool: "builtin-pii", rule: entry.rule, file: entry.path, line: line ?? null }),
      origin: "builtin-pii",
      blocking: true,
      blockingReason: "blocking-tool",
      waived: false,
    });
  }
  return { ok: true, findings };
}
