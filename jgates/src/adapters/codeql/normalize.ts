// Normalizes the SARIF 2.1.0 file `codeql database analyze --format=sarif-latest` writes into result findings.
// Fail-closed: a document that is not SARIF, a run whose driver is not CodeQL, or a result without a rule, a message or
// a location proves nothing (an empty `results` list is the clean answer). Severity comes from the CVSS-like
// `security-severity` of the rule when present, otherwise from the SARIF level; high and critical findings and every
// `error` block, an unknown level blocks too. The path of a finding is relative to the scan root.
import { contentHash } from "../../core/ids/index.js";
import type { NormalizedSeverity, ResultFinding } from "../../core/run/types.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

export interface CodeqlParse {
  ok: boolean;
  findings: ResultFinding[];
  /** The version the driver reports (semanticVersion), when the SARIF says one. */
  driverVersion: string | null;
  /** Why the output could not be interpreted. */
  problem?: string;
}

const LEVELS: Record<string, NormalizedSeverity> = { error: "high", warning: "medium", note: "low", none: "info" };

/** CVSS-like bands GitHub uses for the security-severity of CodeQL rules. */
function bySecuritySeverity(value: number): NormalizedSeverity {
  if (value >= 9) return "critical";
  if (value >= 7) return "high";
  if (value >= 4) return "medium";
  if (value > 0) return "low";
  return "info";
}

function uriToPath(uri: string, root: string): string {
  let p = uri;
  if (p.startsWith("file://")) p = decodeURIComponent(p.replace(/^file:\/\/\/?/, process.platform === "win32" ? "" : "/"));
  else {
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep the raw text */
    }
  }
  p = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (root && root !== "." && p.startsWith(`${root}/`)) return p;
  return root && root !== "." ? `${root}/${p}` : p;
}

export function parseCodeqlSarif(text: string, opts: { stageId: string; version: string | null; root: string }): CodeqlParse {
  const fail = (problem: string): CodeqlParse => ({ ok: false, findings: [], driverVersion: null, problem });
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (!isRec(doc) || !Array.isArray(doc.runs) || typeof doc.version !== "string" || !doc.version.startsWith("2.1")) return fail("the document is not SARIF 2.1.0 (no version 2.1.x and runs list)");
  if (doc.runs.length === 0) return fail("the SARIF has no run");
  const findings: ResultFinding[] = [];
  let driverVersion: string | null = null;
  for (const [runIndex, run] of doc.runs.entries()) {
    const driver = isRec(run) && isRec(run.tool) && isRec(run.tool.driver) ? run.tool.driver : null;
    if (!driver || !/codeql/i.test(String(driver.name ?? ""))) return fail(`run ${runIndex} is not a CodeQL run (tool.driver.name)`);
    if (!Array.isArray((run as Rec).results)) return fail(`run ${runIndex} has no results list`);
    driverVersion = str(driver.semanticVersion) ?? driverVersion;
    const rules: Rec[] = Array.isArray(driver.rules) ? driver.rules.filter(isRec) : [];
    const ruleById = new Map<string, Rec>(rules.flatMap((r) => (str(r.id) ? [[r.id as string, r] as [string, Rec]] : [])));
    for (const [index, result] of ((run as Rec).results as unknown[]).entries()) {
      if (!isRec(result)) return fail(`result ${index} is not an object`);
      const ruleRef = isRec(result.rule) ? str(result.rule.id) : null;
      const ruleId = str(result.ruleId) ?? ruleRef;
      const message = isRec(result.message) ? str(result.message.text) : null;
      if (!ruleId || !message) return fail(`result ${index} has no ruleId or message`);
      const physical = Array.isArray(result.locations) && isRec(result.locations[0]) && isRec(result.locations[0].physicalLocation) ? result.locations[0].physicalLocation : null;
      const uri = physical && isRec(physical.artifactLocation) ? str(physical.artifactLocation.uri) : null;
      if (!uri) return fail(`result ${index} (${ruleId}) has no location`);
      const region = isRec(physical?.region) ? (physical?.region as Rec) : null;
      const line = region ? num(region.startLine) : undefined;
      const column = region ? num(region.startColumn) : undefined;

      const rule = ruleById.get(ruleId) ?? (typeof result.ruleIndex === "number" ? rules[result.ruleIndex] : undefined);
      const props = rule && isRec(rule.properties) ? rule.properties : {};
      const securitySeverity = typeof props["security-severity"] === "string" || typeof props["security-severity"] === "number" ? Number(props["security-severity"]) : Number.NaN;
      const ruleLevel = rule && isRec(rule.defaultConfiguration) ? str(rule.defaultConfiguration.level) : null;
      const level = (str(result.level) ?? ruleLevel ?? "warning").toLowerCase();
      const known = Number.isFinite(securitySeverity) || level in LEVELS;
      // An unknown level is never a favorable one: it blocks as "unknown".
      const normalized: NormalizedSeverity = Number.isFinite(securitySeverity) ? bySecuritySeverity(securitySeverity) : (LEVELS[level] ?? "unknown");
      const blocking = !known || normalized === "critical" || normalized === "high" || level === "error";
      const fingerprints = isRec(result.partialFingerprints) ? result.partialFingerprints : {};
      const nativeFingerprint = str(fingerprints["primaryLocationLineHash/v1"]) ?? str(fingerprints.primaryLocationLineHash);
      const filePath = uriToPath(uri, opts.root);
      const tags = Array.isArray(props.tags) ? props.tags.filter((x): x is string => typeof x === "string") : [];
      const cwe = tags.filter((x) => /cwe-\d+/i.test(x));
      const help = rule && isRec(rule.help) ? str(rule.help.text) : null;
      findings.push({
        stageId: opts.stageId,
        tool: "codeql",
        ...(opts.version ? { toolVersion: opts.version } : {}),
        ruleId,
        category: "dataflow",
        severity: Number.isFinite(securitySeverity) ? `${level} (security-severity ${securitySeverity})` : level,
        normalizedSeverity: normalized,
        message: cwe.length > 0 ? `${message} [${cwe.map((c) => c.replace(/^external\/cwe\//i, "").toUpperCase()).join(", ")}]` : message,
        location: { path: filePath, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) },
        fingerprint: contentHash({ tool: "codeql", rule: ruleId, file: filePath, line: line ?? null, message, native: nativeFingerprint }),
        ...(nativeFingerprint ? { nativeFingerprint } : {}),
        origin: "codeql",
        blocking,
        ...(blocking ? { blockingReason: "blocking-tool" as const } : {}),
        waived: false,
        ...(help ? { remediation: help.slice(0, 500) } : {}),
      });
    }
  }
  return { ok: true, findings, driverVersion };
}
