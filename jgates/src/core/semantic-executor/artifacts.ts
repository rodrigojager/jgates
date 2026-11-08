// The artifacts a context must end with, and their validation. A stage's claims (what it examined, its candidates, a
// verdict) are accepted only from an artifact that parses and validates here; claims about files the context never
// saw, unknown candidates or evidence that points nowhere are dropped or make the artifact invalid. What a model says
// about its own progress outside the artifact is never taken.
import { normalizeScopePath } from "../semantic-scope/index.js";
import { candidateInput, type CandidateInput } from "./host-tools.js";
import { CONFIRMATIONS, type ArtifactCheck, type ArtifactCheckContext, type ArtifactContract, type Confirmation, type Evidence } from "./types.js";

export const EXPLORATION_SHAPE = `{"summary": "what you examined and concluded", "examined": ["workspace-relative paths you actually read"], "gaps": [{"path": "optional path", "reason": "what you could not examine and why"}], "candidates": [{"title": "...", "path": "...", "line": 12, "severity": "blocking|important|suggestion|nit", "category": "...", "rationale": "..."}]}`;
export const VERDICT_SHAPE = `{"candidateId": "C1", "confirmation": "confirmed|rejected|needs-validation", "reason": "why", "evidence": [{"path": "workspace-relative path you read", "line": 12, "note": "what it shows"}]}`;

export function artifactShape(contract: ArtifactContract): string {
  return contract.kind === "exploration" ? EXPLORATION_SHAPE : contract.kind === "verdict" ? VERDICT_SHAPE : contract.shape;
}

/** Parses the final text of a context as one JSON object (a fenced block is accepted); anything else is a problem. */
export function parseArtifactText(text: string | null): { value: Record<string, unknown> } | { code: "empty-output" | "malformed-output" | "not-an-object"; problem: string } {
  const raw = (text ?? "").trim();
  if (raw === "") return { code: "empty-output", problem: "the context ended without a final answer" };
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(raw);
  const body = fenced ? (fenced[1] ?? "") : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { code: "malformed-output", problem: "the final answer is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { code: "not-an-object", problem: "the final answer is not a JSON object" };
  return { value: parsed as Record<string, unknown> };
}

const str = (v: unknown, max: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export interface ExplorationArtifact {
  summary: string;
  examined: string[];
  gaps: Array<{ path?: string; reason: string }>;
  candidates: CandidateInput[];
}

function checkExploration(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  const problems: string[] = [];
  const summary = str(value.summary, 2000);
  if (summary === "") return { ok: false, problems: ["summary is required"] };
  const examined: string[] = [];
  for (const raw of Array.isArray(value.examined) ? value.examined : []) {
    const p = typeof raw === "string" ? normalizeScopePath(raw) : null;
    if (p && ctx.seen.has(p)) examined.push(p);
    else problems.push(`examined ${JSON.stringify(String(raw).slice(0, 120))} is dropped: this context never read it`);
  }
  const gaps: ExplorationArtifact["gaps"] = [];
  for (const g of Array.isArray(value.gaps) ? value.gaps : []) {
    if (!g || typeof g !== "object") continue;
    const reason = str((g as Record<string, unknown>).reason, 500);
    if (reason === "") continue;
    const p = typeof (g as Record<string, unknown>).path === "string" ? normalizeScopePath(String((g as Record<string, unknown>).path)) : null;
    gaps.push({ ...(p ? { path: p } : {}), reason });
  }
  const candidates: CandidateInput[] = [];
  for (const c of Array.isArray(value.candidates) ? value.candidates : []) {
    if (!c || typeof c !== "object") {
      problems.push("a candidate is not an object");
      continue;
    }
    const parsed = candidateInput(c as Record<string, unknown>);
    if ("problems" in parsed) problems.push(`a candidate is dropped: ${parsed.problems.join("; ")}`);
    else if (!ctx.seen.has(parsed.path)) problems.push(`the candidate at ${parsed.path} is dropped: this context never read it`);
    else if (parsed.line !== null && (ctx.lines(parsed.path) ?? Infinity) < parsed.line) problems.push(`the candidate at ${parsed.path}:${parsed.line} is dropped: the file has no such line`);
    else candidates.push(parsed);
  }
  const artifact: ExplorationArtifact = { summary, examined: [...new Set(examined)], gaps, candidates };
  return { ok: true, problems, value: artifact as unknown as Record<string, unknown> };
}

export interface VerdictArtifact {
  candidateId: string;
  confirmation: Confirmation;
  reason: string;
  evidence: Evidence[];
}

function checkVerdict(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  const problems: string[] = [];
  const candidate = ctx.candidate;
  if (!candidate) return { ok: false, problems: ["a verdict needs a candidate"] };
  if (String(value.candidateId ?? "") !== candidate.id) problems.push(`candidateId must be ${candidate.id}`);
  const confirmation = String(value.confirmation ?? "") as Confirmation;
  if (!CONFIRMATIONS.includes(confirmation)) problems.push(`confirmation must be one of ${CONFIRMATIONS.join(", ")}`);
  const reason = str(value.reason, 2000);
  if (reason === "") problems.push("reason is required");
  const evidence: Evidence[] = [];
  for (const e of Array.isArray(value.evidence) ? value.evidence : []) {
    if (!e || typeof e !== "object") {
      problems.push("an evidence entry is not an object");
      continue;
    }
    const rec = e as Record<string, unknown>;
    const p = typeof rec.path === "string" ? normalizeScopePath(rec.path) : null;
    if (!p) {
      problems.push("an evidence path is not a workspace-relative path");
      continue;
    }
    if (!ctx.seen.has(p)) {
      problems.push(`evidence ${p} was never read by this context`);
      continue;
    }
    const line = rec.line === undefined || rec.line === null ? undefined : rec.line;
    if (line !== undefined) {
      const total = ctx.lines(p);
      if (typeof line !== "number" || !Number.isInteger(line) || line < 1 || (total !== null && line > total)) {
        problems.push(`evidence ${p}:${String(line)} points to no line of the file`);
        continue;
      }
    }
    const note = str(rec.note, 500);
    evidence.push({ path: p, ...(typeof line === "number" ? { line } : {}), ...(note ? { note } : {}) });
  }
  if ((confirmation === "confirmed" || confirmation === "rejected") && evidence.length === 0) problems.push(`a ${confirmation} verdict needs at least one evidence reference this context read`);
  if (problems.length > 0) return { ok: false, problems };
  const verdict: VerdictArtifact = { candidateId: candidate.id, confirmation, reason, evidence };
  return { ok: true, problems: [], value: verdict as unknown as Record<string, unknown> };
}

/** Validates the parsed artifact of a context against its stage's contract. */
export function validateArtifact(contract: ArtifactContract, value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  if (contract.kind === "exploration") return checkExploration(value, ctx);
  if (contract.kind === "verdict") return checkVerdict(value, ctx);
  try {
    return contract.validate(value, ctx);
  } catch (error) {
    return { ok: false, problems: [`the artifact check failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
