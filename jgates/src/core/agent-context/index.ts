// Safe context for a coding agent: a summary of one result that tells the agent
// to fix the code and never the criteria, marks everything a tool produced as data, and gives the command that
// reproduces the run. It is built from result.json only and sends nothing anywhere. The CLI (`jgates report <runId>
// --agent-context`) and the UI ("Copiar para o agente") call the same function, so both give the same text.
//
// What never enters it: the masked evidence of a finding, the message of a finding about sensitive data (secrets,
// personal data) and anything in a message that looks like a secret or a personal value.
import { translator } from "../../i18n/index.js";
import type { ResultFinding, ResultMetric, RunResult } from "../run/types.js";

const t = translator("agent-context");

export const AGENT_CONTEXT_SCHEMA_VERSION = 1;
export const DATA_BEGIN = "<<<JGATES-DATA";
export const DATA_END = "JGATES-DATA>>>";
const MAX_FINDINGS = 50;
const MAX_STAGES = 100;

export interface AgentContext {
  schemaVersion: 1;
  runId: string;
  decision: string;
  complete: boolean;
  text: string;
}

const SENSITIVE_CATEGORY = /secret|pii|privacy|credential|personal|sensitive|password|token/i;
const SENSITIVE_TOOL = /gitleaks|trufflehog|builtin-pii|pii|secret/i;
const SENSITIVE_RULE = /secret|pii|credential|password|token|private-key|api-key|cpf|cnpj|ssn|email/i;

/** Values that look like secrets or personal data, replaced wherever they appear in text coming from a tool. */
const SCRUBBERS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g, "[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, "[redacted]"],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[redacted]"],
  [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[redacted]"],
  [/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "[redacted]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[redacted]"],
  [/((?:password|passwd|secret|token|api[_-]?key|apikey|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]"],
  [/\b(?=[A-Za-z0-9_=-]*\d)(?=[A-Za-z0-9_=-]*[A-Za-z])[A-Za-z0-9_=-]{32,}\b/g, "[redacted]"],
];

export function scrub(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
  return out;
}

function oneLine(text: string, max = 400): string {
  const flat = scrub(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function sensitiveFinding(f: ResultFinding): boolean {
  return (f.category !== undefined && SENSITIVE_CATEGORY.test(f.category)) || SENSITIVE_TOOL.test(f.tool) || SENSITIVE_RULE.test(f.ruleId);
}

function metricValue(m: ResultMetric): string {
  if (m.measured === false || m.value === undefined) return t("agent_context_metric_unmeasured", { reason: m.reason ? ` (${oneLine(m.reason, 160)})` : "" });
  const unit = m.unit === "percent" ? "%" : m.unit === "count" ? "" : ` ${m.unit}`;
  const fraction = m.numerator !== undefined && m.denominator !== undefined ? ` (${m.numerator}/${m.denominator})` : "";
  return `${m.value}${unit}${fraction}`;
}

/** The command that repeats the run, from what the result says about its selection. */
export function reproductionCommand(result: RunResult): string {
  const parts = ["jgates", "run"];
  const sel = result.selection;
  if (sel.profile) parts.push("--profile", sel.profile);
  if (sel.scope) parts.push("--scope", sel.scope);
  parts.push("--json");
  return parts.join(" ");
}

export function buildAgentContext(result: RunResult): AgentContext {
  const lines: string[] = [];
  const push = (line = "") => void lines.push(line);
  const yesNo = (v: boolean) => (v ? t("agent_context_yes") : t("agent_context_no"));

  push(`# ${t("agent_context_title")}`);
  push();
  push(`## ${t("agent_context_instruction_title")}`);
  push(t("agent_context_instruction_1"));
  push(t("agent_context_instruction_2"));
  push(t("agent_context_instruction_3"));
  push(t("agent_context_instruction_4", { begin: DATA_BEGIN, end: DATA_END }));
  push();
  push(`## ${t("agent_context_summary_title")}`);
  push(t("agent_context_run", { runId: result.runId }));
  push(t("agent_context_decision", { decision: result.decision }));
  push(t("agent_context_complete", { value: yesNo(result.complete) }));
  if (result.partial) push(t("agent_context_partial"));
  if (result.stopped) push(t("agent_context_stopped", { cause: result.stopped.cause, detail: oneLine(result.stopped.detail ?? "", 160) }));
  if (result.reduced) push(t("agent_context_reduced", { count: result.disabled.filter((d) => d.origin === "run").length }));
  push();

  push(DATA_BEGIN);
  if (result.disabled.length > 0) {
    push(`## ${t("agent_context_disabled_title")}`);
    for (const d of result.disabled) push(t("agent_context_disabled_item", { id: oneLine(d.id, 120), origin: d.origin, reason: d.reason ? `: ${oneLine(d.reason, 160)}` : "" }));
    push();
  }
  push(`## ${t("agent_context_stages_title")}`);
  for (const s of result.stages.slice(0, MAX_STAGES)) push(t("agent_context_stage_item", { id: oneLine(s.id, 120), state: s.state, reason: s.reason ? ` (${oneLine(s.reason, 200)})` : "" }));
  push();

  const findings = result.findings.filter((f) => !f.waived || f.blocking);
  const shown = findings.slice(0, MAX_FINDINGS);
  push(`## ${t("agent_context_findings_title", { shown: shown.length, total: findings.length })}`);
  if (shown.length === 0) push(t("agent_context_findings_none"));
  for (const f of shown) {
    const loc = f.location?.path ? `${f.location.path}${f.location.line ? `:${f.location.line}` : ""}` : t("agent_context_no_location");
    const masked = sensitiveFinding(f);
    push(
      t("agent_context_finding_item", {
        severity: f.normalizedSeverity,
        blocking: `${f.blocking ? t("agent_context_finding_blocking") : ""}${f.waived ? t("agent_context_finding_waived") : ""}`,
        ruleId: oneLine(f.ruleId, 120),
        location: oneLine(loc, 200),
        message: masked ? t("agent_context_finding_masked") : oneLine(f.message),
      }),
    );
    if (f.remediation && !masked) push(t("agent_context_finding_fix", { text: oneLine(f.remediation, 300) }));
  }
  if (findings.length > shown.length) push(t("agent_context_truncated", { max: MAX_FINDINGS, command: t("agent_context_report_command", { runId: result.runId }) }));
  push();

  const metrics = (result.metrics ?? []).filter((m) => !m.id.startsWith("findings."));
  if (metrics.length > 0) {
    push(`## ${t("agent_context_metrics_title")}`);
    for (const m of metrics) push(t("agent_context_metric_item", { id: oneLine(m.id, 120), value: metricValue(m) }));
    push();
  }
  if (result.architecture?.length) {
    push(`## ${t("agent_context_architecture_title")}`);
    for (const a of result.architecture) push(t("agent_context_architecture_item", { tool: a.tool, status: a.status, unresolved: a.unresolved, reason: a.reason ? ` (${oneLine(a.reason, 200)})` : "" }));
    push();
  }
  push(DATA_END);
  push();
  push(`## ${t("agent_context_reproduce_title")}`);
  push(reproductionCommand(result));
  push(t("agent_context_report_command", { runId: result.runId }));

  return { schemaVersion: AGENT_CONTEXT_SCHEMA_VERSION, runId: result.runId, decision: result.decision, complete: result.complete, text: `${lines.join("\n")}\n` };
}
