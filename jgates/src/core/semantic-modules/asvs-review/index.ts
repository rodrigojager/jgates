// The ASVS review (method `asvs-review`), an original JGates method: an AI reading of the source against the requirements
// of the OWASP ASVS that no deterministic check examined. It runs only when asked for: no purpose, profile, template or
// default selects it, and `jgates ci` never runs a Semantic method.
//
//   inputs        for the project's ASVS level, the requirements whose evidence is the repository that the latest Quality
//                 run's map does not show as examined by a deterministic check and that are not recorded as not
//                 applicable (requirements.ts), grouped by chapter into review units
//   method        requirement-review     (explore, one fresh context per review unit): the ids and official texts of the
//                                        unit's requirements (read at run time from the vendored release file, never
//                                        stored), the scope's source through the host tools; per requirement one
//                                        answer: examined (files and lines read, no violation found or a candidate) or
//                                        not-examinable (running-system, person, outside-scope)
//                 requirement-validation (validate, a fresh context per candidate): may reject a candidate with evidence;
//                                        anything else stays needs-validation: a reading of the source against a
//                                        requirement is a lead a person validates, never a confirmed finding
//   output        evidence/asvs-review/requirements-ledger.json (schemas/coverage/asvs-review-ledger.schema.json): one
//                 answer per requirement the run answered validly, by id only. An examined answer whose reference names a
//                 file this context did not read (a file that does not exist included) or a line the file does not have
//                 is invalid and left out, with the reason in the run's gaps; so is a requirement nobody answered
//   claims        the ASVS map counts an examined answer as "AI review of the source" (counted apart from the
//                 deterministic checks) only where a reviewed mapping entry names the unit `semantic-requirement`
//                 (`asvs-review`); not-examinable gives nothing; `--deterministic-only` leaves all of it out
//   applicability not applicable, with no model call: no finished Quality run (ASVS_REVIEW_NO_QUALITY_RUN: validate the
//                 project first), nothing left to review (ASVS_REVIEW_NOTHING_TO_REVIEW), no map (ASVS_REVIEW_MAP_UNAVAILABLE)
//   overlap       the security audit hunts attack classes and insecure-defaults sweeps categories; this method answers the
//                 requirements themselves, one by one, and says plainly which ones the source cannot answer
import { normalizeScopePath, toRepositoryPath } from "../../semantic-scope/index.js";
import { CONFIRMATIONS, type ArtifactCandidate, type ArtifactCheck, type ArtifactCheckContext, type InvestigationModule, type ModuleApplicability, type ModuleBriefInput, type ModuleFinalizeInput, type ModuleFinalizeOutput, type ReviewUnit } from "../../semantic-executor/index.js";
import { ASVS_REVIEW_LEDGER_FILE, ASVS_REVIEW_NOT_EXAMINABLE_REASONS, asvsReviewLedgerProblems, type AsvsReviewAnswer, type AsvsReviewLedger, type AsvsReviewReference } from "../../coverage/asvs/review-ledger.js";
import { semanticFindingFingerprints } from "../../semantic/findings.js";
import { checkCandidates, checkVerdict, isObj, list, str } from "../complementary/shared.js";
import { OBJECTIVE, REVIEW_INSTRUCTIONS, VALIDATION_INSTRUCTIONS } from "./prompts.js";
import { requirementText, selectReviewRequirements, type AsvsReviewSelection, type PlannedRequirement } from "./requirements.js";

export { ASVS_REVIEW_MAP_UNAVAILABLE, ASVS_REVIEW_NO_QUALITY_RUN, ASVS_REVIEW_NOTHING_TO_REVIEW, ASVS_REVIEW_REFUSALS, requirementText, selectReviewRequirements, type AsvsReviewRefusal, type AsvsReviewSelection, type AsvsReviewUnitPlan, type PlannedRequirement } from "./requirements.js";

export const ASVS_REVIEW_METHOD = "asvs-review";
export const ASVS_REVIEW_MODULE_ID = "asvs-review";
export const LEDGER_FILE = ASVS_REVIEW_LEDGER_FILE;
export const STAGES = { review: "requirement-review", validation: "requirement-validation" } as const;

/** Why an examined answer counts for nothing (left out of the ledger, kept in the run's gaps). */
export interface InvalidAnswer {
  id: string;
  unit: string;
  reason: string;
}

interface AcceptedAnswer {
  id: string;
  answer: "examined" | "not-examinable";
  references?: AsvsReviewReference[];
  /** What the context said; the host decides the outcome from the candidates that survived validation. */
  claimed?: "no-violation-found" | "finding";
  reason?: AsvsReviewAnswer["reason"];
  detail?: string;
}

interface AcceptedReview {
  summary: string;
  unit: string;
  answers: AcceptedAnswer[];
  invalid: InvalidAnswer[];
  unanswered: string[];
}

const inputsOf = (inputs: Readonly<Record<string, unknown>> | undefined): AsvsReviewSelection | null => (inputs && Array.isArray(inputs.units) && Array.isArray(inputs.requirements) ? (inputs as unknown as AsvsReviewSelection) : null);

const REVIEW_SHAPE = `{"summary": "what the unit's requirements concern in this code and what you read", "requirements": [{"id": "V6.2.1", "answer": "examined|not-examinable", "references": [{"path": "workspace-relative file you read", "startLine": 1, "endLine": 40}], "outcome": "no-violation-found|finding", "reason": "running-system|person|outside-scope (not-examinable only)", "detail": "not-examinable: what is missing"}], "candidates": [{"requirement": "V6.2.1", "title": "...", "path": "...", "line": 12, "severity": "blocking|important|suggestion|nit", "rationale": "how the code you read violates the requirement"}]}`;
const VALIDATION_SHAPE = `{"candidateId": "C1", "confirmation": "needs-validation|rejected", "reason": "...", "evidence": [{"path": "...", "line": 12, "note": "..."}]}`;

const NOT_EXAMINABLE = new Set<string>(ASVS_REVIEW_NOT_EXAMINABLE_REASONS);

/** One reference of an examined answer, or why it does not hold (a file this context did not read, a line it does not have). */
function checkReference(raw: unknown, ctx: ArtifactCheckContext): AsvsReviewReference | string {
  if (!isObj(raw)) return "a reference is not an object";
  const p = typeof raw.path === "string" ? normalizeScopePath(raw.path) : null;
  const shown = JSON.stringify(String(raw.path ?? "").slice(0, 100));
  if (!p) return `${shown} is not a path inside the workspace`;
  if (!ctx.seen.has(p)) return `${shown} was never read by this context (or does not exist)`;
  const start = raw.startLine;
  const end = raw.endLine;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return `${p}: startLine and endLine must be lines, first to last`;
  if ((ctx.lines(p) ?? Infinity) < end) return `${p}:${end} points to no line of the file`;
  return { path: p, startLine: start, endLine: end };
}

function checkReview(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  const inputs = inputsOf(ctx.run?.inputs);
  const unit = ctx.unit ?? null;
  const planned = unit && inputs ? inputs.units.find((u) => u.id === unit.id) : undefined;
  if (!inputs || !unit || !planned) return { ok: false, problems: ["the review stage needs its review unit"] };
  const summary = str(value.summary, 1500);
  if (summary === "") return { ok: false, problems: ["summary is required"] };
  if (!Array.isArray(value.requirements)) return { ok: false, problems: ["requirements must be a list"] };
  const problems: string[] = [];
  const ids = new Set(planned.requirements.map((r) => r.id));

  // The candidates, each against one requirement of this unit.
  const candidates: ArtifactCandidate[] = [];
  for (const item of list(value.candidates)) {
    const requirement = isObj(item) ? str(item.requirement, 20) : "";
    if (!ids.has(requirement)) {
      problems.push(`a candidate is dropped: ${JSON.stringify(requirement)} is not a requirement of unit ${unit.id}`);
      continue;
    }
    candidates.push(...checkCandidates([item], ctx, problems, requirement, () => ({ requirement, unit: unit.id })));
  }
  const withCandidate = new Set(candidates.map((c) => c.category));

  const answers: AcceptedAnswer[] = [];
  const invalid: InvalidAnswer[] = [];
  const answered = new Set<string>();
  const refuse = (id: string, reason: string): void => {
    invalid.push({ id, unit: unit.id, reason });
    problems.push(`${id}: ${reason}; the answer counts for nothing`);
  };
  for (const raw of value.requirements) {
    const rec = isObj(raw) ? raw : null;
    const id = str(rec?.id, 20);
    if (!rec || !ids.has(id)) {
      problems.push(`an answer is dropped: ${JSON.stringify(id)} is not a requirement of unit ${unit.id}`);
      continue;
    }
    if (answered.has(id)) {
      problems.push(`${id} is answered twice; the first answer counts`);
      continue;
    }
    answered.add(id);
    if (rec.answer === "examined") {
      const refs = list(rec.references).map((r) => checkReference(r, ctx));
      const wrong = refs.find((r): r is string => typeof r === "string");
      if (wrong) {
        refuse(id, `a reference does not hold (${wrong})`);
        continue;
      }
      if (refs.length === 0) {
        refuse(id, "examined without a file and lines read");
        continue;
      }
      const claimed = rec.outcome === "finding" ? "finding" : rec.outcome === "no-violation-found" ? "no-violation-found" : null;
      if (claimed === null && !withCandidate.has(id)) {
        refuse(id, "examined without the outcome no-violation-found or finding");
        continue;
      }
      if (claimed === "finding" && !withCandidate.has(id)) {
        refuse(id, "its outcome is finding but no candidate for it was accepted");
        continue;
      }
      const references = [...new Map((refs as AsvsReviewReference[]).map((r) => [`${r.path}:${r.startLine}:${r.endLine}`, r])).values()];
      answers.push({ id, answer: "examined", references, claimed: withCandidate.has(id) ? "finding" : "no-violation-found" });
    } else if (rec.answer === "not-examinable") {
      const reason = String(rec.reason ?? "");
      if (!NOT_EXAMINABLE.has(reason)) {
        refuse(id, `not-examinable needs the reason ${ASVS_REVIEW_NOT_EXAMINABLE_REASONS.join(", ")}`);
        continue;
      }
      const detail = str(rec.detail, 500);
      answers.push({ id, answer: "not-examinable", reason: reason as AsvsReviewAnswer["reason"], ...(detail ? { detail } : {}) });
    } else refuse(id, "the answer must be examined or not-examinable");
  }
  const unanswered = planned.requirements.map((r) => r.id).filter((id) => !answered.has(id));
  if (unanswered.length > 0) problems.push(`not answered: ${unanswered.join(", ")}`);
  const accepted: AcceptedReview = { summary, unit: unit.id, answers, invalid, unanswered };
  const examined = [...new Set(answers.flatMap((a) => (a.references ?? []).map((r) => r.path)))];
  const gaps = [...invalid.map((i) => ({ reason: `${i.id}: ${i.reason}` })), ...unanswered.map((id) => ({ reason: `${id}: not answered by the review of unit ${unit.id}` }))];
  return { ok: true, problems, value: accepted as unknown as Record<string, unknown>, candidates, examined, gaps };
}

/** The validation of one candidate: it may reject it with evidence; anything else stays needs-validation. */
function checkValidation(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  const asked = String(value.confirmation ?? "");
  // A reading of the source against a requirement never confirms: a confirmed answer is kept as needs-validation.
  const confirmation = asked === "rejected" ? "rejected" : (CONFIRMATIONS as readonly string[]).includes(asked) ? "needs-validation" : asked;
  return checkVerdict({ ...value, confirmation, severity: undefined }, ctx, () => ({ asked }));
}

// ---- briefs ------------------------------------------------------------------------------------------------------------

const attribution = (version: string): string => `Requirement texts: OWASP Application Security Verification Standard ${version}, (c) The OWASP Foundation, CC BY-SA 4.0; shown for this review only.`;

function requirementsJson(version: string, requirements: readonly PlannedRequirement[]): string {
  return JSON.stringify(requirements.map((r) => ({ id: r.id, section: r.section, level: r.level, text: requirementText(version, r.id) ?? "(the official text could not be read)" })), null, 1);
}

function brief(input: ModuleBriefInput): string | null {
  const inputs = inputsOf(input.inputs);
  if (!inputs) return null;
  if (input.stage.id === STAGES.review && input.unit) {
    const planned = inputs.units.find((u) => u.id === input.unit?.id);
    if (!planned) return null;
    return [
      `Review unit ${planned.id} (${planned.name}) of OWASP ASVS ${inputs.asvsVersion}, level ${inputs.level}: answer each of these ${planned.requirements.length} requirement(s) exactly once.`,
      "No deterministic check of JGates examined them in the latest Quality run; your answer is an AI reading of the source, shown apart from the checks.",
      attribution(inputs.asvsVersion),
      requirementsJson(inputs.asvsVersion, planned.requirements),
    ].join("\n");
  }
  if (input.stage.id === STAGES.validation && input.candidate) {
    const id = (input.candidate.details as { requirement?: string } | undefined)?.requirement;
    const planned = inputs.requirements.find((r) => r.id === id);
    if (!planned) return null;
    return [`The requirement the candidate was reported against (OWASP ASVS ${inputs.asvsVersion}):`, attribution(inputs.asvsVersion), requirementsJson(inputs.asvsVersion, [planned])].join("\n");
  }
  return null;
}

// ---- the ledger --------------------------------------------------------------------------------------------------------

export interface LedgerBuild {
  ledger: AsvsReviewLedger;
  invalid: InvalidAnswer[];
  unanswered: Array<{ id: string; unit: string; reason: string }>;
}

/** The requirements ledger of a run, from the accepted review artifacts and the candidates as validation left them. */
export function buildLedger(input: Pick<ModuleFinalizeInput, "stages" | "candidates" | "scope" | "inputs">): LedgerBuild {
  const inputs = inputsOf(input.inputs);
  if (!inputs) throw new Error("asvs-review has no planned requirements");
  const reviewStage = input.stages.find((s) => s.id === STAGES.review);
  const byUnit = new Map<string, AcceptedReview>();
  for (const c of reviewStage?.contexts ?? []) {
    const value = c.accepted as unknown as AcceptedReview | undefined;
    if (c.unit && value && Array.isArray(value.answers) && !byUnit.has(c.unit)) byUnit.set(c.unit, value);
  }
  // The fingerprints the stored findings carry: every finding of the run (each candidate not rejected), in order.
  const live = input.candidates.filter((c) => c.status !== "rejected");
  const prints = semanticFindingFingerprints(live.map((c) => ({ category: c.category, path: toRepositoryPath(c.path, input.scope.prefix), line: c.line })));
  const printOf = new Map(live.map((c, i) => [c.id, prints[i] as string]));
  const requirements: AsvsReviewAnswer[] = [];
  const invalid: InvalidAnswer[] = [];
  const unanswered: LedgerBuild["unanswered"] = [];
  for (const r of inputs.requirements) {
    const review = byUnit.get(r.chapter);
    if (!review) {
      const ctx = reviewStage?.contexts.find((c) => c.unit === r.chapter);
      unanswered.push({ id: r.id, unit: r.chapter, reason: ctx ? `the review of unit ${r.chapter} gave no valid artifact (${ctx.status})` : `unit ${r.chapter} was not reviewed` });
      continue;
    }
    const bad = review.invalid.find((i) => i.id === r.id);
    if (bad) {
      invalid.push(bad);
      continue;
    }
    const a = review.answers.find((x) => x.id === r.id);
    if (!a) {
      unanswered.push({ id: r.id, unit: r.chapter, reason: `not answered by the review of unit ${r.chapter}` });
      continue;
    }
    if (a.answer === "not-examinable") {
      requirements.push({ id: r.id, unit: r.chapter, answer: "not-examinable", ...(a.reason ? { reason: a.reason } : {}), ...(a.detail ? { detail: a.detail } : {}) });
      continue;
    }
    const mine = input.candidates.filter((c) => {
      const d = c.details as { requirement?: string; unit?: string } | undefined;
      return d?.requirement === r.id && d.unit === r.chapter && c.status !== "rejected";
    });
    const findings = [...new Set(mine.map((c) => printOf.get(c.id)).filter((f): f is string => typeof f === "string"))];
    requirements.push({ id: r.id, unit: r.chapter, answer: "examined", references: a.references ?? [], ...(findings.length > 0 ? { outcome: "finding" as const, findings } : { outcome: "no-violation-found" as const }) });
  }
  const ledger: AsvsReviewLedger = { schemaVersion: 1, kind: "asvs-review-ledger", method: "asvs-review", asvsVersion: inputs.asvsVersion, level: inputs.level, requirements };
  return { ledger, invalid, unanswered };
}

function finalize(input: ModuleFinalizeInput): ModuleFinalizeOutput {
  const inputs = inputsOf(input.inputs);
  if (!inputs) throw new Error("asvs-review has no planned requirements");
  const { ledger, invalid, unanswered } = buildLedger(input);
  const problems = asvsReviewLedgerProblems(ledger);
  if (problems.length > 0) throw new Error(`the requirements ledger is not valid: ${problems.slice(0, 3).join("; ")}`);
  const examined = ledger.requirements.filter((a) => a.answer === "examined");
  return {
    files: [{ path: LEDGER_FILE, content: `${JSON.stringify(ledger, null, 2)}\n` }],
    gaps: [
      ...invalid.map((i) => ({ code: "ASVS_ANSWER_INVALID", reason: `${i.id} (unit ${i.unit}) counts for nothing: ${i.reason}` })),
      ...unanswered.map((u) => ({ code: "ASVS_REQUIREMENT_NOT_ANSWERED", reason: `${u.id}: ${u.reason}` })),
    ],
    report: {
      asvsVersion: inputs.asvsVersion,
      level: inputs.level,
      qualityRun: inputs.qualityRun,
      planned: inputs.requirements.length,
      units: inputs.units.map((u) => ({ id: u.id, requirements: u.requirements.length })),
      examined: examined.length,
      withFinding: examined.filter((a) => a.outcome === "finding").length,
      notExaminable: ledger.requirements.length - examined.length,
      invalid: invalid.length,
      unanswered: unanswered.length,
      ledger: LEDGER_FILE,
    },
  };
}

export function asvsReviewModule(): InvestigationModule {
  return {
    id: ASVS_REVIEW_MODULE_ID,
    version: "1",
    title: "ASVS review of the source",
    objective: OBJECTIVE,
    provenance: { origin: "original JGates method", standard: "OWASP ASVS (requirement texts read at run time from jgates/vendor/owasp-asvs, CC BY-SA 4.0)", ledgerSchema: "schemas/coverage/asvs-review-ledger.schema.json" },
    minimum: { exploreCalls: 1, reserveCalls: 1 },
    applicability: (input): ModuleApplicability => {
      const selected = selectReviewRequirements({ workspacePath: input.workspacePath, env: input.env, runDir: input.runDir, ...(input.home ? { home: input.home } : {}) });
      if ("code" in selected) return { applicable: false, code: selected.code, missing: selected.missing, reason: selected.reason };
      return {
        applicable: true,
        inputs: selected as unknown as Record<string, unknown>,
        record: { qualityRun: selected.qualityRun, asvsVersion: selected.asvsVersion, level: selected.level, levelSource: selected.levelSource, requirements: selected.requirements.length, units: selected.units.map((u) => ({ id: u.id, requirements: u.requirements.map((r) => r.id) })) },
      };
    },
    reviewUnits: ({ inputs }): ReviewUnit[] => (inputsOf(inputs)?.units ?? []).map((u) => ({ id: u.id, label: `${u.id} ${u.name}` })),
    stages: [
      {
        id: STAGES.review,
        label: "Requirement review",
        role: "explore",
        required: true,
        contexts: "per-unit",
        instructions: REVIEW_INSTRUCTIONS,
        artifact: { kind: "custom", shape: REVIEW_SHAPE, validate: checkReview },
      },
      {
        id: STAGES.validation,
        label: "Independent validation",
        role: "validate",
        required: true,
        contexts: "per-candidate",
        instructions: VALIDATION_INSTRUCTIONS,
        artifact: { kind: "custom", shape: VALIDATION_SHAPE, validate: checkValidation },
      },
    ],
    brief,
    finalize,
  };
}
