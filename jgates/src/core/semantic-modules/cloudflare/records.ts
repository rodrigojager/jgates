// The candidate records of the security audit and their checks, adapted from the upstream report-schema.json and
// validate-findings.cjs: the three verdict branches (confirmed, needs_validation, rejected) stay distinct, every
// record has a stable source-derived fingerprint, a repository trace that begins at its entrypoint and ends at its
// sink, and evidence that points to a line the deciding context read. JGates runs no target code, so a confirmed
// record carries its source argument (evidence basis "source-argument") instead of an observed execution.
import { normalizeScopePath } from "../../semantic-scope/index.js";
import type { FindingSeverity } from "../../semantic-executor/index.js";

export const FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
export const SCORES = ["informational", "low", "medium", "high", "critical"] as const;
export type Score = (typeof SCORES)[number];
export const CONFIDENCES = ["low", "medium", "high"] as const;
export const CONDITION_KINDS = ["authentication_level", "authorization_role", "user_interaction", "system_configuration", "network_routing", "environmental_dependency", "data_state", "timing_dependency", "third_party_dependency"] as const;
export type Verdict = "confirmed" | "needs_validation" | "rejected";
export const VERDICTS: readonly Verdict[] = ["confirmed", "needs_validation", "rejected"];

/** The JGates severity of a Cloudflare score (a confirmed overall severity or a needs_validation owner priority). */
export function jgatesSeverity(score: Score): FindingSeverity {
  return score === "critical" || score === "high" ? "blocking" : score === "medium" ? "important" : score === "low" ? "suggestion" : "nit";
}

export const toConfirmation = (v: Verdict): "confirmed" | "needs-validation" | "rejected" => (v === "needs_validation" ? "needs-validation" : v);

export interface TraceEntry {
  kind: "entrypoint" | "propagation" | "sink";
  file: string;
  line: number;
  scope: string;
  description: string;
}

export interface EvidenceEntry {
  file: string;
  line: number;
  description: string;
}

export interface RecordCheckContext {
  /** Files the deciding context saw: every trace and evidence file must be one of them. */
  seen: ReadonlySet<string>;
  lines(path: string): number | null;
}

const TRACE_SHAPE = `"trace": [{"kind": "entrypoint|propagation|sink", "file": "workspace-relative path you read", "line": 12, "scope": "function or route", "description": "what happens here"}], "evidence": [{"file": "...", "line": 12, "description": "what it shows"}]`;
export const CONFIRMED_SHAPE = `{"fingerprint": "stable-root-cause-id", "title": "...", "description": "...", "root_cause": "...", "intended_behavior": "...", "impact": "affected principal or resource and the concrete result", ${TRACE_SHAPE}, "conditions": [{"kind": "${CONDITION_KINDS.join("|")}", "description": "..."}], "source_argument": "why the source alone establishes the result (no execution was run)", "remediation": {"strategy": "smallest source fix and regression case", "code_changes": [{"file_name": "...", "fixed_code": "..."}]}, "severity": {"likelihood": {"score": "${SCORES.join("|")}", "reason": "..."}, "impact": {"score": "...", "reason": "..."}, "overall_severity": "..."}, "confidence": {"score": "low|medium|high", "reason": "..."}}`;
export const NEEDS_VALIDATION_SHAPE = `{"fingerprint": "...", "title": "...", "description": "...", "claimed_root_cause": "...", "impact": "possible affected principal or resource and result", "priority": "${SCORES.join("|")} (owner priority, not a severity)", ${TRACE_SHAPE}, "conditions": [], "blockers": ["the exact missing fact"], "validation_plan": {"local": "bounded local fixture or test (optional)", "deployment": "owner-observed check (optional); at least one of the two"}}`;
export const REJECTED_SHAPE = `{"fingerprint": "...", "title": "...", "description": "...", "claimed_root_cause": "...", ${TRACE_SHAPE}, "reason": "the control or fact that refutes it"}`;

/** Fields a branch must not carry (upstream: additionalProperties false and distinct verdict contracts). */
const FORBIDDEN: Record<Verdict, readonly string[]> = {
  confirmed: ["claimed_root_cause", "blockers", "validation_plan", "reason", "priority"],
  needs_validation: ["severity", "execution", "remediation", "reason", "root_cause", "confidence", "source_argument"],
  rejected: ["severity", "execution", "remediation", "blockers", "validation_plan", "root_cause", "confidence", "source_argument", "priority"],
};

const text = (v: unknown, max = 4000): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Checks one record of a verdict branch; returns the normalized record (with `verdict`) or the problems. */
export function checkRecord(raw: unknown, verdict: Verdict, ctx: RecordCheckContext): { record: Record<string, unknown> } | { problems: string[] } {
  const problems: string[] = [];
  if (!isObj(raw)) return { problems: ["the record is not an object"] };
  const fingerprint = typeof raw.fingerprint === "string" ? raw.fingerprint.trim() : "";
  if (!FINGERPRINT.test(fingerprint)) problems.push(`fingerprint must match ${FINGERPRINT.source}`);
  const out: Record<string, unknown> = { verdict, fingerprint };
  for (const field of ["title", "description"]) {
    const v = text(raw[field], field === "title" ? 300 : 4000);
    if (!v) problems.push(`${field} is required`);
    out[field] = v;
  }
  for (const f of FORBIDDEN[verdict]) if (raw[f] !== undefined && raw[f] !== null) problems.push(`a ${verdict} record must not carry ${f}`);
  const ref = (file: unknown, line: unknown, where: string): { file: string; line: number } | null => {
    const p = typeof file === "string" ? normalizeScopePath(file) : null;
    if (!p) {
      problems.push(`${where}: the file is not a workspace-relative path`);
      return null;
    }
    if (!ctx.seen.has(p)) {
      problems.push(`${where}: ${p} was never read by this context`);
      return null;
    }
    const total = ctx.lines(p);
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1 || (total !== null && line > total)) {
      problems.push(`${where}: ${p}:${String(line)} points to no line of the file`);
      return null;
    }
    return { file: p, line };
  };
  const trace: TraceEntry[] = [];
  const rawTrace = Array.isArray(raw.trace) ? raw.trace : [];
  if (rawTrace.length === 0) problems.push("trace needs at least one entry");
  rawTrace.forEach((t, i) => {
    if (!isObj(t)) return problems.push(`trace[${i}] is not an object`);
    const kind = String(t.kind ?? "");
    if (!["entrypoint", "propagation", "sink"].includes(kind)) problems.push(`trace[${i}].kind must be entrypoint, propagation or sink`);
    const r = ref(t.file, t.line, `trace[${i}]`);
    const scope = text(t.scope, 300);
    const description = text(t.description, 1000);
    if (!scope || !description) problems.push(`trace[${i}] needs scope and description`);
    if (r) trace.push({ kind: kind as TraceEntry["kind"], ...r, scope, description });
  });
  const kinds = rawTrace.map((t) => (isObj(t) ? String(t.kind ?? "") : ""));
  if (kinds.length === 1 && !["entrypoint", "sink"].includes(kinds[0] ?? "")) problems.push("a one-entry trace is an entrypoint or a sink");
  if (kinds.length > 1 && (kinds[0] !== "entrypoint" || kinds[kinds.length - 1] !== "sink" || kinds.slice(1, -1).some((k) => k !== "propagation"))) {
    problems.push("a multi-step trace begins at entrypoint, ends at sink and uses propagation only between them");
  }
  out.trace = trace;
  const evidence: EvidenceEntry[] = [];
  const rawEvidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  if (rawEvidence.length === 0) problems.push("evidence needs at least one entry");
  rawEvidence.forEach((e, i) => {
    if (!isObj(e)) return problems.push(`evidence[${i}] is not an object`);
    const r = ref(e.file, e.line, `evidence[${i}]`);
    const description = text(e.description, 1000);
    if (!description) problems.push(`evidence[${i}] needs a description`);
    if (r) evidence.push({ ...r, description });
  });
  out.evidence = evidence;
  const conditions: Array<{ kind: string; description: string }> = [];
  for (const [i, c] of (Array.isArray(raw.conditions) ? raw.conditions : []).entries()) {
    if (!isObj(c) || !(CONDITION_KINDS as readonly string[]).includes(String(c.kind)) || !text(c.description)) problems.push(`conditions[${i}] needs a known kind and a description`);
    else conditions.push({ kind: String(c.kind), description: text(c.description, 1000) });
  }
  const need = (field: string): string => {
    const v = text(raw[field]);
    if (!v) problems.push(`${field} is required for a ${verdict} record`);
    return v;
  };
  if (verdict === "confirmed") {
    out.root_cause = need("root_cause");
    out.intended_behavior = need("intended_behavior");
    out.impact = need("impact");
    out.source_argument = need("source_argument");
    out.conditions = conditions;
    const rem = isObj(raw.remediation) ? raw.remediation : {};
    const strategy = text(rem.strategy);
    if (!strategy) problems.push("remediation.strategy is required for a confirmed record");
    const changes = (Array.isArray(rem.code_changes) ? rem.code_changes : []).filter(isObj).map((c) => ({ file_name: text(c.file_name, 300), fixed_code: typeof c.fixed_code === "string" ? c.fixed_code.slice(0, 8000) : "" })).filter((c) => c.file_name);
    out.remediation = { strategy, ...(changes.length > 0 ? { code_changes: changes } : {}) };
    const sev = isObj(raw.severity) ? raw.severity : {};
    const score = (v: unknown, where: string): Score | null => {
      const s = isObj(v) ? String(v.score ?? "") : "";
      if (!(SCORES as readonly string[]).includes(s) || !text(isObj(v) ? v.reason : "")) {
        problems.push(`severity.${where} needs a score (${SCORES.join(", ")}) and a reason`);
        return null;
      }
      return s as Score;
    };
    const likelihood = score(sev.likelihood, "likelihood");
    const impact = score(sev.impact, "impact");
    const overall = String(sev.overall_severity ?? "");
    if (!(SCORES as readonly string[]).includes(overall)) problems.push("severity.overall_severity is required");
    else if (impact && SCORES.indexOf(overall as Score) > SCORES.indexOf(impact)) problems.push("severity.overall_severity cannot exceed the demonstrated impact");
    out.severity = {
      likelihood: { score: likelihood, reason: text(isObj(sev.likelihood) ? sev.likelihood.reason : "", 1000) },
      impact: { score: impact, reason: text(isObj(sev.impact) ? sev.impact.reason : "", 1000) },
      overall_severity: overall,
    };
    const conf = isObj(raw.confidence) ? raw.confidence : {};
    if (!(CONFIDENCES as readonly string[]).includes(String(conf.score)) || !text(conf.reason)) problems.push("confidence needs a score (low, medium, high) and a reason");
    out.confidence = { score: String(conf.score ?? ""), reason: text(conf.reason, 1000) };
    out.evidence_basis = "source-argument";
  } else if (verdict === "needs_validation") {
    out.claimed_root_cause = need("claimed_root_cause");
    out.impact = need("impact");
    const priority = String(raw.priority ?? "");
    if (!(SCORES as readonly string[]).includes(priority)) problems.push(`priority must be one of ${SCORES.join(", ")} (an owner priority, not a severity)`);
    out.priority = priority;
    out.conditions = conditions;
    const blockers = (Array.isArray(raw.blockers) ? raw.blockers : []).map((b) => text(b, 1000)).filter((b) => b !== "");
    if (blockers.length === 0) problems.push("blockers needs at least one exact missing fact");
    out.blockers = [...new Set(blockers)];
    const plan = isObj(raw.validation_plan) ? raw.validation_plan : {};
    const local = text(plan.local);
    const deployment = text(plan.deployment);
    if (!local && !deployment) problems.push("validation_plan needs a local or a deployment step");
    out.validation_plan = { ...(local ? { local } : {}), ...(deployment ? { deployment } : {}) };
  } else {
    out.claimed_root_cause = need("claimed_root_cause");
    out.reason = need("reason");
  }
  return problems.length > 0 ? { problems } : { record: out };
}

/** The files a record cites (trace and evidence). */
export function recordFiles(record: Record<string, unknown>): string[] {
  const files = new Set<string>();
  for (const t of (record.trace as TraceEntry[] | undefined) ?? []) files.add(t.file);
  for (const e of (record.evidence as EvidenceEntry[] | undefined) ?? []) files.add(e.file);
  return [...files].sort();
}

/** The location a candidate is reported at: the sink (last trace entry). */
export function recordLocation(record: Record<string, unknown>): { path: string; line: number } {
  const trace = (record.trace as TraceEntry[] | undefined) ?? [];
  const last = trace[trace.length - 1];
  const ev = ((record.evidence as EvidenceEntry[] | undefined) ?? [])[0];
  return last ? { path: last.file, line: last.line } : { path: ev?.file ?? "", line: ev?.line ?? 1 };
}

/** The JGates severity of a decided or proposed record. */
export function recordSeverity(record: Record<string, unknown>): FindingSeverity {
  if (record.verdict === "confirmed") {
    const overall = String((record.severity as { overall_severity?: unknown } | undefined)?.overall_severity ?? "medium") as Score;
    return jgatesSeverity((SCORES as readonly string[]).includes(overall) ? overall : "medium");
  }
  const p = String(record.priority ?? "medium") as Score;
  return jgatesSeverity((SCORES as readonly string[]).includes(p) ? p : "medium");
}

/** What a record's change means for a fresh verification: the material fields upstream names. */
export function materialChange(before: Record<string, unknown>, after: Record<string, unknown>): string | null {
  if (before.verdict !== after.verdict) return `the verdict changes from ${String(before.verdict)} to ${String(after.verdict)}`;
  if (before.fingerprint !== after.fingerprint) return "a different fingerprint names a separate root cause";
  const locs = (r: Record<string, unknown>): string => ((r.trace as TraceEntry[] | undefined) ?? []).map((t) => `${t.kind}:${t.file}:${t.line}`).join(",");
  if (locs(before) !== locs(after)) return "the trace changes";
  const sev = (r: Record<string, unknown>): string => String((r.severity as { overall_severity?: unknown } | undefined)?.overall_severity ?? r.priority ?? "");
  if (sev(before) !== sev(after)) return "the severity changes";
  return null;
}
