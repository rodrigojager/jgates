// Normalizes the reports of `st run --report json,junit` (Schemathesis 4.x; fixtures of 4.33.1 in
// tests/fixtures/runtime-api/recorded) into result findings. The JSON run report says whether the run finished, what
// was tested, the network/schema errors and the failure codes with their severity; the JUnit report carries each failing
// test case with its codes and the reproduction (`curl ...`). Fail-closed: a report that is not the expected document,
// a run that did not finish or tested nothing, or failures the JUnit report does not explain prove nothing.
import { contentHash } from "../../core/ids/index.js";
import type { NormalizedSeverity, ResultFinding } from "../../core/run/types.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export interface SchemathesisParse {
  ok: boolean;
  findings: ResultFinding[];
  /** Network, schema or internal errors the run reported: the run did not test what it should have. */
  errors: string[];
  /** Operations actually tested. */
  tested: number;
  /** Why the reports could not be interpreted. */
  problem?: string;
}

const SEVERITIES: Record<string, NormalizedSeverity> = { critical: "critical", high: "high", medium: "medium", low: "low", info: "info", informational: "info" };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  });
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1] as string) : null;
};

export interface JUnitCase {
  /** The API operation ("GET /users/{id}"). */
  operation: string;
  failures: Array<{ testCaseId: string | null; codes: Array<{ code: string; title: string }>; detail: string; reproduction: string | null }>;
  errors: string[];
}

/** The test cases of a Schemathesis JUnit report, with each failure's codes, first detail line and curl reproduction. */
export function parseJUnit(xml: string): JUnitCase[] | null {
  if (!/<testsuites[\s>]/.test(xml)) return null;
  const cases: JUnitCase[] = [];
  const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m = caseRe.exec(xml); m; m = caseRe.exec(xml)) {
    const operation = attr(m[1] as string, "name") ?? "";
    const body = m[3] ?? "";
    const failures: JUnitCase["failures"] = [];
    const errors: string[] = [];
    const failRe = /<(failure|error)\b[^>]*>([\s\S]*?)<\/\1>/g;
    for (let f = failRe.exec(body); f; f = failRe.exec(body)) {
      const text = decodeXml(f[2] as string);
      if (f[1] === "error") {
        errors.push(text.trim().split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 2).join(": "));
        continue;
      }
      const codes = [...text.matchAll(/^- (ST\d+) (.+)$/gm)].map((c) => ({ code: c[1] as string, title: (c[2] as string).trim() }));
      const testCaseId = /Test Case ID: (\S+)/.exec(text)?.[1] ?? null;
      const reproduction = /Reproduce with:\s*\n\s*(curl [^\n]+)/.exec(text)?.[1]?.trim() ?? null;
      // The first explanatory line after the codes (for example "Additional properties are not allowed ...").
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
      const detail = lines.find((l) => !/^\d+\. Test Case ID:/.test(l) && !/^- ST\d+/.test(l) && !/^(Received|Documented):/.test(l)) ?? "";
      failures.push({ testCaseId, codes, detail, reproduction });
    }
    cases.push({ operation, failures, errors });
  }
  return cases;
}

/** Findings of one run: one per failing test case and failure code, each with its reproduction. */
export function parseSchemathesisReports(jsonText: string, junitText: string, opts: { stageId: string; version: string | null; specPath: string; target: string }): SchemathesisParse {
  const fail = (problem: string): SchemathesisParse => ({ ok: false, findings: [], errors: [], tested: 0, problem });
  let doc: unknown;
  try {
    doc = JSON.parse(jsonText);
  } catch (error) {
    return fail(`JSON report: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRec(doc) || !isRec(doc.operations) || !Array.isArray(doc.failures) || !Array.isArray(doc.errors) || typeof doc.complete !== "boolean") return fail("the JSON report is not a Schemathesis run report");
  if (doc.complete !== true) return fail(`the run did not finish (stop reason: ${String(doc.stop_reason ?? "unknown")})`);
  const tested = typeof doc.operations.tested === "number" ? doc.operations.tested : 0;
  const errors = doc.errors.map((e) => (isRec(e) ? `${str(e.title) ?? "error"}${typeof e.count === "number" ? ` (${e.count})` : ""}` : String(e)));
  const severityOf = new Map<string, { severity: string; title: string }>();
  for (const f of doc.failures) {
    const code = isRec(f) ? str(f.code) : null;
    if (!isRec(f) || !code) return fail("a failure of the JSON report has no code");
    severityOf.set(code, { severity: str(f.severity) ?? "unknown", title: str(f.title) ?? code });
  }
  const cases = parseJUnit(junitText);
  if (cases === null) return fail("the JUnit report is not a test-suites document");
  for (const c of cases) for (const e of c.errors) if (!errors.includes(e)) errors.push(`${c.operation}: ${e}`);

  const findings: ResultFinding[] = [];
  const explained = new Set<string>();
  for (const c of cases) {
    for (const failure of c.failures) {
      if (failure.codes.length === 0) return fail(`a failure of ${c.operation} has no ST code`);
      for (const { code, title } of failure.codes) {
        explained.add(code);
        const known = severityOf.get(code);
        const native = known?.severity ?? "unknown";
        const normalized = SEVERITIES[native] ?? "unknown";
        const reproduction = failure.reproduction ?? `st run ${opts.specPath} --url ${opts.target} (test case ${failure.testCaseId ?? "?"})`;
        findings.push({
          stageId: opts.stageId,
          tool: "schemathesis",
          ...(opts.version ? { toolVersion: opts.version } : {}),
          ruleId: code,
          category: "api-contract",
          severity: native,
          normalizedSeverity: normalized,
          message: `${title}: ${c.operation}${failure.detail && failure.detail !== title ? ` (${failure.detail})` : ""}`,
          location: { path: opts.specPath },
          // The operation and the code identify the violation; the generated input and the target port do not.
          fingerprint: contentHash({ tool: "schemathesis", rule: code, spec: opts.specPath, operation: c.operation }),
          origin: "schemathesis",
          // A contract violation found against the running target always blocks: the API does not do what it declares.
          blocking: true,
          blockingReason: "blocking-tool",
          waived: false,
          evidence: `reproduce: ${reproduction}${failure.testCaseId ? ` [test case ${failure.testCaseId}]` : ""}`,
        });
      }
    }
  }
  // Every failure code of the run report must be explained by a test case of the JUnit report.
  const missing = [...severityOf.keys()].filter((code) => !explained.has(code));
  if (missing.length > 0) return fail(`the JUnit report does not explain the failures ${missing.join(", ")}`);
  // Codes are repeated per test case; the same operation and code are one finding.
  const unique = new Map<string, ResultFinding>();
  for (const f of findings) if (!unique.has(f.fingerprint as string)) unique.set(f.fingerprint as string, f);
  return { ok: true, findings: [...unique.values()], errors, tested };
}
