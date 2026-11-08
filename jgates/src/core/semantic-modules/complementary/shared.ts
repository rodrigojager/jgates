// Helpers shared by the complementary Semantic modules (differential review, variant analysis, insecure defaults,
// cross-component reasoning): host checks of artifact parts (paths a context saw, candidates, verdicts), masking of
// host-made brief material, and the reading of earlier Semantic runs of the same workspace.
import fs from "node:fs";
import path from "node:path";
import { emptyCounts, maskText, strictMaskRules } from "../../../adapters/semantic-gate/mask.js";
import { normalizeScopePath } from "../../semantic-scope/index.js";
import { CONFIRMATIONS, FINDING_SEVERITIES, type ArtifactCandidate, type ArtifactCheck, type ArtifactCheckContext, type ArtifactVerdict, type Confirmation, type Evidence, type FindingSeverity } from "../../semantic-executor/index.js";

export const str = (v: unknown, max: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const strings = (v: unknown, max: number, limit: number): string[] => list(v).map((x) => str(x, max)).filter((x) => x !== "").slice(0, limit);

const CODE = /\.(js|mjs|cjs|jsx|ts|mts|cts|tsx|py|rb|go|java|kt|cs|php|rs|scala|swift|c|cc|cpp|h|hpp)$/i;
export const isCodePath = (p: string): boolean => CODE.test(p);
export const isTestPath = (p: string): boolean => /(^|\/)(tests?|__tests__|spec|specs|fixtures?)(\/|$)|[._-](test|spec)\.[a-z]+$/i.test(p);

/** Host-made text for a brief (diffs, history subjects, matched lines): masked with the strict rules. */
export function maskBrief(text: string): string {
  const rules = strictMaskRules();
  return maskText(text, emptyCounts(rules), rules);
}

/** The workspace paths of an artifact list that this context saw; the others are dropped with a problem. */
export function seenPaths(raw: unknown, ctx: ArtifactCheckContext, problems: string[], where: string): string[] {
  const out: string[] = [];
  for (const f of list(raw)) {
    const p = typeof f === "string" ? normalizeScopePath(f) : null;
    if (p && ctx.seen.has(p)) out.push(p);
    else problems.push(`${where}: ${JSON.stringify(String(f).slice(0, 100))} is dropped: this context never read it`);
  }
  return [...new Set(out)];
}

/** A workspace path and line this context saw (null with a problem otherwise). */
export function seenRef(rawPath: unknown, rawLine: unknown, ctx: ArtifactCheckContext, problems: string[], where: string): { path: string; line: number | null } | null {
  const p = typeof rawPath === "string" ? normalizeScopePath(rawPath) : null;
  if (!p || !ctx.seen.has(p)) {
    problems.push(`${where}: ${JSON.stringify(String(rawPath ?? "").slice(0, 100))} was never read by this context`);
    return null;
  }
  if (rawLine === undefined || rawLine === null) return { path: p, line: null };
  if (typeof rawLine !== "number" || !Number.isInteger(rawLine) || rawLine < 1 || (ctx.lines(p) ?? Infinity) < rawLine) {
    problems.push(`${where}: ${p}:${String(rawLine)} points to no line of the file`);
    return null;
  }
  return { path: p, line: rawLine };
}

/**
 * The candidates of an artifact: each needs a title, a path this context read, an existing line (optional), a severity
 * and a rationale; `details` builds the module's record of it (null drops it with the problem it pushed).
 */
export function checkCandidates(raw: unknown, ctx: ArtifactCheckContext, problems: string[], category: string, details: (c: Record<string, unknown>, at: { path: string; line: number | null }) => Record<string, unknown> | null): ArtifactCandidate[] {
  const out: ArtifactCandidate[] = [];
  for (const item of list(raw)) {
    if (!isObj(item)) {
      problems.push("a candidate is not an object");
      continue;
    }
    const title = str(item.title, 200);
    const rationale = str(item.rationale, 1500);
    const severity = String(item.severity ?? "") as FindingSeverity;
    if (title === "" || rationale === "" || !FINDING_SEVERITIES.includes(severity)) {
      problems.push("a candidate is dropped: it needs a title, a rationale and a valid severity");
      continue;
    }
    const at = seenRef(item.path, item.line, ctx, problems, `candidate ${JSON.stringify(title.slice(0, 60))}`);
    if (!at) continue;
    const d = details(item, at);
    if (!d) continue;
    out.push({ title, path: at.path, line: at.line, severity, category, rationale, details: d });
  }
  return out;
}

/**
 * A per-candidate verdict with module fields: the confirmation, its reason, evidence this context read (required for
 * confirmed and rejected), an optional corrected severity, and `extra` (the module's fields, kept in the details).
 */
export function checkVerdict(value: Record<string, unknown>, ctx: ArtifactCheckContext, extra: (problems: string[]) => Record<string, unknown>): ArtifactCheck {
  const problems: string[] = [];
  const candidate = ctx.candidate;
  if (!candidate) return { ok: false, problems: ["a verdict needs a candidate"] };
  if (String(value.candidateId ?? "") !== candidate.id) problems.push(`candidateId must be ${candidate.id}`);
  const confirmation = String(value.confirmation ?? "") as Confirmation;
  if (!CONFIRMATIONS.includes(confirmation)) problems.push(`confirmation must be one of ${CONFIRMATIONS.join(", ")}`);
  const reason = str(value.reason, 2000);
  if (reason === "") problems.push("reason is required");
  const evidence: Evidence[] = [];
  for (const e of list(value.evidence)) {
    if (!isObj(e)) continue;
    const at = seenRef(e.path, e.line, ctx, problems, "evidence");
    if (!at) continue;
    const note = str(e.note, 500);
    evidence.push({ path: at.path, ...(at.line !== null ? { line: at.line } : {}), ...(note ? { note } : {}) });
  }
  if ((confirmation === "confirmed" || confirmation === "rejected") && evidence.length === 0) problems.push(`a ${confirmation} verdict needs at least one evidence reference this context read`);
  const severity = value.severity === undefined || value.severity === null ? undefined : (String(value.severity) as FindingSeverity);
  if (severity !== undefined && !FINDING_SEVERITIES.includes(severity)) problems.push(`severity must be one of ${FINDING_SEVERITIES.join(", ")}`);
  const fields = extra(problems);
  if (problems.length > 0) return { ok: false, problems };
  const verdict: ArtifactVerdict = { confirmation, reason, evidence, ...(severity && confirmation !== "rejected" ? { severity } : {}), details: { ...(candidate.details ?? {}), verdict: fields } };
  return { ok: true, problems: [], value: { candidateId: candidate.id, confirmation, reason, evidence, ...fields }, verdict, examined: evidence.map((e) => e.path) };
}

/** Earlier Semantic runs of the same workspace (the sibling folders of a run folder), newest first. */
export function priorSemanticRuns(runDir: string, limit = 20): Array<{ runId: string; dir: string; result: Record<string, unknown> }> {
  const root = path.dirname(runDir);
  const self = path.basename(runDir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(root).filter((n) => n.startsWith("sem_") && n !== self);
  } catch {
    return [];
  }
  const out: Array<{ runId: string; dir: string; result: Record<string, unknown>; at: number }> = [];
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")) as Record<string, unknown>;
      out.push({ runId: name, dir, result, at: fs.statSync(path.join(dir, "result.json")).mtimeMs });
    } catch {
      // A run without a readable result has no confirmed record to offer.
    }
  }
  return out
    .sort((a, b) => b.at - a.at || (a.runId < b.runId ? 1 : -1))
    .slice(0, limit)
    .map(({ runId, dir, result }) => ({ runId, dir, result }));
}

/** The JSON of a brief section, compact and masked. */
export const briefJson = (title: string, value: unknown): string => `${title}\n${maskBrief(JSON.stringify(value, null, 1))}`;
