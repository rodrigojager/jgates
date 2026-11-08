// The general review as an investigation module (method `general-review`). It keeps the six review dimensions of the
// semantic-gate rubric (templates/semantic-review-skill.md: functional correctness, tests, maintainability,
// architecture, performance/reliability, security) and adds the discipline of the executor around them:
//   evidence-planning  what to read per dimension and which focused hypotheses to test (explore, one context)
//   hunting            test the hypotheses against the code that was read; report each dimension examined or pending
//   challenge          an independent fresh context per candidate that is free to reject it
// The host, not the model, decides what a dimension's state is: a dimension counts as examined only when the hunting
// artifact lists files that context actually read; everything else stays pending with its reason. The same module runs
// in every scope mode (full-recommended, selected, incremental): the scope decides the subjects, never the dimensions.
import fs from "node:fs";
import path from "node:path";
import { normalizeScopePath } from "../../semantic-scope/index.js";
import type { ArtifactCheck, ArtifactCheckContext, ArtifactCandidate, FindingSeverity, InvestigationModule, ModuleBriefInput, ModuleFinalizeInput, ModuleFinalizeOutput } from "../../semantic-executor/index.js";
import { FINDING_SEVERITIES } from "../../semantic-executor/index.js";

export const GENERAL_REVIEW_METHOD = "general-review";
export const GENERAL_REVIEW_MODULE_ID = "general-review";
export const COVERAGE_FILE = "evidence/general-review/dimension-coverage.json";
export const STAGES = { plan: "evidence-planning", hunt: "hunting", challenge: "challenge" } as const;

export interface Dimension {
  id: string;
  label: string;
  /** What to examine (from the rubric's hard blockers of that dimension). */
  focus: string;
}

/** The six dimensions of the general review, in report order. */
export const DIMENSIONS: readonly Dimension[] = [
  { id: "functional-correctness", label: "Functional correctness", focus: "the requirement is implemented; common error paths work; boundaries (null, empty, zero, off-by-one, encoding, concurrency) hold; called APIs and contracts exist; failures are not hidden from the caller." },
  { id: "tests", label: "Tests and regression", focus: "changed behavior has behavior-level tests; bug fixes have regression tests; tests assert observable behavior and do not mock away the integration point they protect." },
  { id: "maintainability", label: "Maintainability", focus: "no needless complexity, duplication or dead paths; names and structure make the code changeable; no removal of useful validation, error handling or observability." },
  { id: "architecture", label: "Architecture", focus: "module boundaries and public contracts are preserved or have a migration path; dependencies point the right way; a local helper is not bypassed." },
  { id: "performance-reliability", label: "Performance and reliability", focus: "unbounded loops, queries or memory; missing timeouts, retries or cleanup; races and ordering; resource leaks; behavior under partial failure." },
  { id: "security", label: "Semantic security", focus: "authentication and authorization on the changed flow; input reaching privileged operations without validation at the right boundary; cross-tenant access; risky file, network or command operations; information disclosure. Never look for secrets or personal data." },
];
const DIMENSION_IDS = new Set(DIMENSIONS.map((d) => d.id));

const OBJECTIVE =
  "Review the subjects of the resolved scope as a careful maintainer would, across six dimensions: functional correctness, tests and regression, maintainability, architecture, performance and reliability, and semantic security. Establish every claim with code you read; say plainly which dimensions you examined and which stay pending.";

const dimensionList = DIMENSIONS.map((d) => `- ${d.id} (${d.label}): ${d.focus}`).join("\n");

const PLAN_SHAPE = `{"summary": "what the subjects are and how you will review them", "dimensions": [{"id": "${DIMENSIONS.map((d) => d.id).join("|")}", "files": ["workspace-relative paths to read for this dimension"], "hypotheses": ["a focused, falsifiable suspicion to test in this dimension"], "not_applicable": "optional: why the dimension needs no examination here"}]}`;
const HUNT_SHAPE = `{"summary": "...", "dimensions": [{"id": "<dimension id>", "state": "examined|pending", "reviewed_paths": ["files you actually read for it"], "checks": ["what you verified and what you found"], "reason": "required when pending: what stopped you"}], "candidates": [{"title": "...", "path": "...", "line": 12, "severity": "blocking|important|suggestion|nit", "category": "<dimension id>", "rationale": "...", "hypothesis": "the planned hypothesis it tests"}], "gaps": [{"path": "optional", "reason": "..."}]}`;

const str = (v: unknown, max: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

interface PlanEntry {
  id: string;
  files: string[];
  hypotheses: string[];
  notApplicable: string | null;
}
interface PlanValue {
  summary: string;
  dimensions: PlanEntry[];
}
interface HuntEntry {
  id: string;
  state: "examined" | "pending";
  reviewedPaths: string[];
  checks: string[];
  reason: string | null;
}
interface HuntValue {
  summary: string;
  dimensions: HuntEntry[];
}

function checkPlan(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  const problems: string[] = [];
  const summary = str(value.summary, 1500);
  if (summary === "") return { ok: false, problems: ["summary is required"] };
  if (!Array.isArray(value.dimensions)) return { ok: false, problems: ["dimensions must be a list"] };
  const seenIds = new Set<string>();
  const dimensions: PlanEntry[] = [];
  for (const raw of value.dimensions) {
    const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const id = String(rec?.id ?? "");
    if (!rec || !DIMENSION_IDS.has(id)) {
      problems.push(`a dimension entry is dropped: ${JSON.stringify(id.slice(0, 60))} is not one of the six dimensions`);
      continue;
    }
    if (seenIds.has(id)) {
      problems.push(`dimension ${id} is listed twice; the first entry counts`);
      continue;
    }
    seenIds.add(id);
    const files: string[] = [];
    for (const f of Array.isArray(rec.files) ? rec.files : []) {
      const p = typeof f === "string" ? normalizeScopePath(f) : null;
      if (p && ctx.readable(p)) files.push(p);
      else problems.push(`planned file ${JSON.stringify(String(f).slice(0, 100))} is dropped: it is not readable in this scope`);
    }
    const hypotheses = (Array.isArray(rec.hypotheses) ? rec.hypotheses : []).map((h) => str(h, 300)).filter((h) => h !== "").slice(0, 8);
    const na = str(rec.not_applicable, 300);
    dimensions.push({ id, files: [...new Set(files)], hypotheses, notApplicable: na === "" ? null : na });
  }
  const accepted: PlanValue = { summary, dimensions };
  return { ok: true, problems, value: accepted as unknown as Record<string, unknown>, examined: [...ctx.seen] };
}

function checkHunt(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  const problems: string[] = [];
  const summary = str(value.summary, 1500);
  if (summary === "") return { ok: false, problems: ["summary is required"] };
  if (!Array.isArray(value.dimensions)) return { ok: false, problems: ["dimensions must be a list"] };
  const entries = new Map<string, HuntEntry>();
  const gaps: Array<{ path?: string; reason: string }> = [];
  for (const raw of value.dimensions) {
    const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const id = String(rec?.id ?? "");
    if (!rec || !DIMENSION_IDS.has(id) || entries.has(id)) {
      problems.push(`a dimension entry is dropped: ${JSON.stringify(id.slice(0, 60))} is unknown or repeated`);
      continue;
    }
    const claimed = rec.state === "examined";
    const reviewed: string[] = [];
    for (const f of Array.isArray(rec.reviewed_paths) ? rec.reviewed_paths : []) {
      const p = typeof f === "string" ? normalizeScopePath(f) : null;
      if (p && ctx.seen.has(p)) reviewed.push(p);
      else problems.push(`${id}: reviewed path ${JSON.stringify(String(f).slice(0, 100))} is dropped: this context never read it`);
    }
    const checks = (Array.isArray(rec.checks) ? rec.checks : []).map((c) => str(c, 400)).filter((c) => c !== "").slice(0, 12);
    let reason = str(rec.reason, 400);
    let state: HuntEntry["state"] = "pending";
    if (claimed && reviewed.length > 0 && checks.length > 0) state = "examined";
    else if (claimed) {
      reason = reason || (reviewed.length === 0 ? "no file listed for it was read in this context" : "no check was reported for it");
      problems.push(`${id}: claimed examined without ${reviewed.length === 0 ? "files this context read" : "a reported check"}; it stays pending`);
    } else if (reason === "") reason = "the context did not say why it stayed pending";
    if (state === "pending") gaps.push({ reason: `${id}: ${reason}` });
    entries.set(id, { id, state, reviewedPaths: [...new Set(reviewed)], checks, reason: state === "pending" ? reason : null });
  }
  const candidates: ArtifactCandidate[] = [];
  for (const raw of Array.isArray(value.candidates) ? value.candidates : []) {
    const c = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (!c) {
      problems.push("a candidate is not an object");
      continue;
    }
    const title = str(c.title, 200);
    const p = typeof c.path === "string" ? normalizeScopePath(c.path) : null;
    const dimension = String(c.category ?? "");
    const severity = String(c.severity ?? "") as FindingSeverity;
    const rationale = str(c.rationale, 1500);
    const line = typeof c.line === "number" && Number.isInteger(c.line) && c.line >= 1 ? c.line : null;
    if (title === "" || !p || rationale === "" || !DIMENSION_IDS.has(dimension) || !FINDING_SEVERITIES.includes(severity)) {
      problems.push(`a candidate is dropped: it needs a title, a path, a rationale, a known dimension as category and a valid severity`);
      continue;
    }
    if (!ctx.seen.has(p)) {
      problems.push(`the candidate at ${p} is dropped: this context never read it`);
      continue;
    }
    if (line !== null && (ctx.lines(p) ?? Infinity) < line) {
      problems.push(`the candidate at ${p}:${line} is dropped: the file has no such line`);
      continue;
    }
    // A finding in a dimension counts as work in it only when the dimension itself was examined.
    if (entries.get(dimension)?.state !== "examined") problems.push(`the candidate at ${p} belongs to ${dimension}, which this context did not report examined; it is kept and its validation decides`);
    candidates.push({ title, path: p, line, severity, category: dimension, rationale, details: { dimension, hypothesis: str(c.hypothesis, 300) } });
  }
  for (const g of Array.isArray(value.gaps) ? value.gaps : []) {
    const reason = str((g as Record<string, unknown> | null)?.reason, 400);
    if (reason !== "") gaps.push({ reason });
  }
  const accepted: HuntValue = { summary, dimensions: DIMENSIONS.map((d) => entries.get(d.id)).filter((e): e is HuntEntry => !!e) };
  const examined = [...new Set([...entries.values()].filter((e) => e.state === "examined").flatMap((e) => e.reviewedPaths))];
  return { ok: true, problems, value: accepted as unknown as Record<string, unknown>, candidates, examined, gaps };
}

function brief(input: ModuleBriefInput): string | null {
  if (input.stage.id === STAGES.plan) {
    return ["Review dimensions (plan every one; mark a dimension not_applicable only with a reason):", dimensionList, `Scope mode: ${input.scope.resolution.mode}. The dimensions are the same in every scope mode; the scope only decides which files are subjects.`].join("\n");
  }
  if (input.stage.id === STAGES.hunt) {
    const plan = input.accepted[STAGES.plan] as unknown as PlanValue | undefined;
    return [
      "Review dimensions (report every one as examined or pending; examined needs files you read and a check you made):",
      dimensionList,
      "",
      plan ? `Evidence plan from the planning stage (host-validated):\n${JSON.stringify(plan.dimensions, null, 1)}` : "There is no accepted evidence plan; decide the hypotheses yourself and say so in the summary.",
    ].join("\n");
  }
  return null;
}

/** The coverage per dimension, derived only from host-validated artifacts and candidate decisions. */
export function dimensionCoverage(input: Pick<ModuleFinalizeInput, "accepted" | "candidates" | "stages">): Array<Record<string, unknown>> {
  const plan = input.accepted[STAGES.plan] as unknown as PlanValue | undefined;
  const hunt = input.accepted[STAGES.hunt] as unknown as HuntValue | undefined;
  const huntStage = input.stages.find((s) => s.id === STAGES.hunt);
  return DIMENSIONS.map((d) => {
    const planned = plan?.dimensions.find((p) => p.id === d.id);
    const reported = hunt?.dimensions.find((h) => h.id === d.id);
    const mine = input.candidates.filter((c) => (c.details as { dimension?: string } | undefined)?.dimension === d.id);
    const state = reported?.state === "examined" ? "examined" : "pending";
    const reason =
      state === "examined"
        ? null
        : (reported?.reason ?? (hunt ? "the hunting context did not report this dimension" : `hunting did not finish (${huntStage?.state ?? "not run"})`));
    return {
      id: d.id,
      label: d.label,
      state,
      ...(reason ? { reason } : {}),
      planned: planned ? { files: planned.files, hypotheses: planned.hypotheses, ...(planned.notApplicable ? { notApplicable: planned.notApplicable } : {}) } : null,
      reviewedPaths: reported?.reviewedPaths ?? [],
      checks: reported?.checks ?? [],
      candidates: {
        total: mine.length,
        confirmed: mine.filter((c) => c.status === "confirmed").length,
        needsValidation: mine.filter((c) => c.status === "needs-validation").length,
        rejected: mine.filter((c) => c.status === "rejected").length,
        unresolved: mine.filter((c) => c.status === "unresolved" || c.status === "open").length,
      },
    };
  });
}

function finalize(input: ModuleFinalizeInput): ModuleFinalizeOutput {
  const dimensions = dimensionCoverage(input);
  const pending = dimensions.filter((d) => d.state === "pending");
  const doc = {
    schemaVersion: 1,
    kind: "semantic-general-review-coverage",
    method: GENERAL_REVIEW_METHOD,
    scopeMode: input.scope.resolution.mode,
    rigor: input.rigor,
    generatedAt: input.now.toISOString(),
    dimensions,
  };
  return {
    files: [{ path: COVERAGE_FILE, content: `${JSON.stringify(doc, null, 2)}\n` }],
    gaps: pending.map((d) => ({ code: "DIMENSION_PENDING", reason: `${String(d.label)} was not examined: ${String(d.reason)}` })),
    report: { dimensions: dimensions.map((d) => ({ id: d.id, state: d.state, ...(d.reason ? { reason: d.reason } : {}) })), examined: dimensions.length - pending.length, pending: pending.length, scopeMode: input.scope.resolution.mode },
  };
}

export function generalReviewModule(): InvestigationModule {
  return {
    id: GENERAL_REVIEW_MODULE_ID,
    version: "1",
    title: "General review with evidence discipline",
    objective: OBJECTIVE,
    contextReviewFallback: true,
    provenance: { rubric: "semantic-gate/templates/semantic-review-skill.md", dimensions: DIMENSIONS.map((d) => d.id) },
    minimum: { exploreCalls: 2, reserveCalls: 1 },
    stages: [
      {
        id: STAGES.plan,
        label: "Evidence planning",
        role: "explore",
        required: true,
        contexts: "once",
        instructions:
          "Plan the review before judging anything. Read the subjects (read_file, search_files, list_files) enough to know what they do. For each of the six dimensions list the files that must be read to examine it and one to four focused, falsifiable hypotheses (a suspicion that the code can confirm or refute). Do not report findings in this stage. Answer with the plan artifact.",
        artifact: { kind: "custom", shape: PLAN_SHAPE, validate: checkPlan },
      },
      {
        id: STAGES.hunt,
        label: "Hypothesis testing",
        role: "explore",
        required: true,
        contexts: "once",
        reportsCandidates: true,
        instructions:
          "Test the planned hypotheses against the code: read the files each dimension needs, and report a candidate (report_candidate or in the artifact) only where the code you read shows a problem, with the dimension as its category. Candidates are hypotheses that an independent challenge judges later; do not confirm them yourself. Then report every one of the six dimensions: examined (with the files you read and what you checked) or pending (with the reason). Never mark a dimension examined for files you did not read.",
        artifact: { kind: "custom", shape: HUNT_SHAPE, validate: checkHunt },
      },
      {
        id: STAGES.challenge,
        label: "Independent challenge",
        role: "validate",
        required: true,
        contexts: "per-candidate",
        instructions:
          "You challenge one candidate that another context reported; you did not produce it and you are free to reject it. Read the code it points to and what decides it (callers, guards, tests). Confirm it only when the code you read shows the problem; reject it when the code you read shows it cannot happen (cite the guard); answer needs-validation when the files you could read do not settle it. Every confirmed or rejected verdict cites evidence you read in this context.",
        artifact: { kind: "verdict" },
      },
    ],
    brief,
    finalize,
  };
}

/** Reads the coverage record a run wrote (null when the run has none). */
export function readDimensionCoverage(runDir: string): Array<Record<string, unknown>> | null {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(runDir, COVERAGE_FILE), "utf8")) as { dimensions?: Array<Record<string, unknown>> };
    return Array.isArray(doc.dimensions) ? doc.dimensions : null;
  } catch {
    return null;
  }
}
