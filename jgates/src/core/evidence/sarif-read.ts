// Shared SARIF 2.1.0 reader (CodeQL and any tool a user registers). Fail-closed: a document that is not SARIF 2.1.x,
// a run without a results list, or (when required) a result without a rule, a message or a location proves nothing.
// An empty `results` list is the clean answer. Severity comes from the CVSS-like `security-severity` when present,
// otherwise from the SARIF level; an unknown level is never a favorable one.
import type { NormalizedSeverity } from "../run/types.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

export interface SarifFinding {
  ruleId: string;
  message: string;
  /** Path as the report wrote it, relative to `root` when one was given; null when the result has no location. */
  path: string | null;
  line?: number;
  column?: number;
  /** The SARIF level (result, else rule default, else "warning"), lower case. */
  level: string;
  securitySeverity?: number;
  normalizedSeverity: NormalizedSeverity;
  /** false: the level is not one SARIF defines and there is no security-severity (callers must block). */
  known: boolean;
  nativeFingerprint: string | null;
  tags: string[];
  help: string | null;
  driver: string;
}

export interface SarifRead {
  ok: boolean;
  findings: SarifFinding[];
  driverName: string | null;
  driverVersion: string | null;
  problem?: string;
}

export interface SarifOptions {
  /** Every run's tool.driver.name must match (CodeQL: /codeql/i). */
  driver?: RegExp;
  /** Prefix for the paths (a component root), so they stay relative to the workspace. Default ".". */
  root?: string;
  /** A result without a location is a failure of the report (default true). */
  requireLocation?: boolean;
}

const LEVELS: Record<string, NormalizedSeverity> = { error: "high", warning: "medium", note: "low", none: "info" };

/** CVSS-like bands GitHub uses for the security-severity of rules. */
export function severityBySecurityScore(value: number): NormalizedSeverity {
  if (value >= 9) return "critical";
  if (value >= 7) return "high";
  if (value >= 4) return "medium";
  if (value > 0) return "low";
  return "info";
}

function uriToPath(uri: string, root: string): string {
  const fileUri = uri.startsWith("file://");
  let p = fileUri ? uri.slice("file://".length) : uri;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep the raw text */
  }
  // The URI describes the tool's filesystem, which may differ from the host's.
  if (fileUri) p = p.replace(/^\/(?=[A-Za-z]:\/)/, "");
  p = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (root && root !== "." && p.startsWith(`${root}/`)) return p;
  return root && root !== "." ? `${root}/${p}` : p;
}

export function readSarif(text: string, opts: SarifOptions = {}): SarifRead {
  const root = opts.root ?? ".";
  const requireLocation = opts.requireLocation ?? true;
  const fail = (problem: string): SarifRead => ({ ok: false, findings: [], driverName: null, driverVersion: null, problem });
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (!isRec(doc) || !Array.isArray(doc.runs) || typeof doc.version !== "string" || !doc.version.startsWith("2.1")) return fail("the document is not SARIF 2.1.0 (no version 2.1.x and runs list)");
  if (doc.runs.length === 0) return fail("the SARIF has no run");
  const findings: SarifFinding[] = [];
  let driverName: string | null = null;
  let driverVersion: string | null = null;
  for (const [runIndex, run] of doc.runs.entries()) {
    const driver = isRec(run) && isRec(run.tool) && isRec(run.tool.driver) ? run.tool.driver : null;
    if (!driver) return fail(`run ${runIndex} has no tool.driver`);
    const name = String(driver.name ?? "");
    if (opts.driver && !opts.driver.test(name)) return fail(`run ${runIndex} is not a ${opts.driver.source.replace(/\\/g, "")} run (tool.driver.name)`);
    if (!Array.isArray((run as Rec).results)) return fail(`run ${runIndex} has no results list`);
    driverName = str(driver.name) ?? driverName;
    driverVersion = str(driver.semanticVersion) ?? str(driver.version) ?? driverVersion;
    const rules: Rec[] = Array.isArray(driver.rules) ? driver.rules.filter(isRec) : [];
    const ruleById = new Map<string, Rec>(rules.flatMap((r) => (str(r.id) ? [[r.id as string, r] as [string, Rec]] : [])));
    for (const [index, result] of ((run as Rec).results as unknown[]).entries()) {
      if (!isRec(result)) return fail(`result ${index} is not an object`);
      const ruleRef = isRec(result.rule) ? str(result.rule.id) : null;
      const ruleId = str(result.ruleId) ?? ruleRef;
      const message = isRec(result.message) ? (str(result.message.text) ?? str(result.message.markdown)) : null;
      if (!ruleId || !message) return fail(`result ${index} has no ruleId or message`);
      const physical = Array.isArray(result.locations) && isRec(result.locations[0]) && isRec(result.locations[0].physicalLocation) ? result.locations[0].physicalLocation : null;
      const uri = physical && isRec(physical.artifactLocation) ? str(physical.artifactLocation.uri) : null;
      if (!uri && requireLocation) return fail(`result ${index} (${ruleId}) has no location`);
      const region = isRec(physical?.region) ? (physical?.region as Rec) : null;
      const line = region ? num(region.startLine) : undefined;
      const column = region ? num(region.startColumn) : undefined;

      const rule = ruleById.get(ruleId) ?? (typeof result.ruleIndex === "number" ? rules[result.ruleIndex] : undefined);
      const props = rule && isRec(rule.properties) ? rule.properties : {};
      const resultProps = isRec(result.properties) ? result.properties : {};
      const rawScore = resultProps["security-severity"] ?? props["security-severity"];
      const securitySeverity = typeof rawScore === "string" || typeof rawScore === "number" ? Number(rawScore) : Number.NaN;
      const ruleLevel = rule && isRec(rule.defaultConfiguration) ? str(rule.defaultConfiguration.level) : null;
      const level = (str(result.level) ?? ruleLevel ?? "warning").toLowerCase();
      const scored = Number.isFinite(securitySeverity);
      const fingerprints = isRec(result.partialFingerprints) ? result.partialFingerprints : {};
      const plain = isRec(result.fingerprints) ? result.fingerprints : {};
      const firstFingerprint = [...Object.values(fingerprints), ...Object.values(plain)].find((v) => typeof v === "string" && v !== "");
      const tagList = Array.isArray(props.tags) ? props.tags.filter((x): x is string => typeof x === "string") : [];
      findings.push({
        ruleId,
        message,
        path: uri ? uriToPath(uri, root) : null,
        ...(line !== undefined ? { line } : {}),
        ...(column !== undefined ? { column } : {}),
        level,
        ...(scored ? { securitySeverity } : {}),
        normalizedSeverity: scored ? severityBySecurityScore(securitySeverity) : (LEVELS[level] ?? "unknown"),
        known: scored || level in LEVELS,
        nativeFingerprint: str(fingerprints["primaryLocationLineHash/v1"]) ?? str(fingerprints.primaryLocationLineHash) ?? (typeof firstFingerprint === "string" ? firstFingerprint : null),
        tags: tagList,
        help: rule && isRec(rule.help) ? str(rule.help.text) : null,
        driver: name,
      });
    }
  }
  return { ok: true, findings, driverName, driverVersion };
}
