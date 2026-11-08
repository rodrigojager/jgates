// Property reasoning (method `property-reasoning`), an original JGates method (the Trail of Bits property-based-testing
// skill is a reference for the question it asks; no upstream text is used). It states what must hold over the inputs
// or operation sequences of boundary-heavy, authorization, parsing and business-rule code, argues each invariant against
// the code, and proposes property tests a person may later validate and incorporate as Quality regressions.
//
//   inputs        target code in the readable scope found by the host (lines with boundary arithmetic and comparisons,
//                 authorization checks, parsing and decoding, money and quantity rules; tests excluded), and the
//                 property-testing facts it can see (fast-check or hypothesis declared in readable manifests, the attached
//                 Quality run's property-test metrics)
//   hypothesis    a stated invariant fails for some input the code accepts (an off-by-one bound, a missing ownership or
//                 role condition, a parser that accepts what it should refuse, a rule that can go negative)
//   method        invariants (explore, one context): invariants per target with domain, status (holds / violated /
//                            unknown) and, for a violation, a concrete counterexample argued from the code; optionally a
//                            node:test property test per invariant (a proposal, never executed or applied here)
//                 falsify    (validate, a fresh context per violated invariant): does the counterexample really break it,
//                            or does a guard the hunter missed prevent it
//   output        evidence/property-reasoning/invariants.json (targets with coverage, invariants with status and
//                 counterexamples, candidates with verdicts) and evidence/regressions/proposals.json (the proposed tests,
//                 with the invariant and candidate they come from). Confirmed violations carry evidence_basis
//                 "source-argument": no test was run by this method
//   applicability not applicable without boundary, authorization, parsing or business-rule code in the readable scope
//                 (PROPERTY_NO_TARGETS)
//   overlap       the general review and the Cloudflare baseline judge code paths and may notice a wrong bound; neither
//                 states invariants with their input domain, nor produces counterexamples or tests. The Quality pytest
//                 and vitest checks count and run the property tests a project already has; this module proposes new
//                 ones, which become Quality checks only through `jgates regressions incorporate --approve`.
import path from "node:path";
import type { ArtifactCheck, ArtifactCheckContext, InvestigationModule, ModuleApplicability, ModuleApplicabilityInput, ModuleBriefInput, ModuleFinalizeInput, ModuleFinalizeOutput } from "../../semantic-executor/index.js";
import { FINDING_SEVERITIES, type FindingSeverity } from "../../semantic-executor/index.js";
import { checkProposedTest, proposalsFile, REGRESSIONS_DIR } from "../../regressions/proposals.js";
import { briefJson, checkVerdict, isCodePath, isObj, isTestPath, list, maskBrief, seenRef, str } from "../complementary/shared.js";
import { attachedQualityResult } from "../supply-chain/quality-evidence.js";

export const PROPERTY_METHOD = "property-reasoning";
export const PROPERTY_MODULE_ID = "property-reasoning";
export const INVARIANTS_FILE = "evidence/property-reasoning/invariants.json";
export const STAGES = { invariants: "invariants", falsify: "falsify" } as const;
export const TARGET_KINDS = ["boundary", "authorization", "parsing", "business-rule"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

const PATTERNS: Record<TargetKind, RegExp> = {
  boundary: /(\b(min|max|clamp|limit|offset|range|bounds?|length|size|index|slice|substring|substr|page|pages|quota|capacity|start|end)\b[^\n]*(<=|>=|<|>|\+\s*1|-\s*1)|\bMath\.(min|max)\b)/i,
  authorization: /\b(authori[sz]\w*|permission\w*|is_?admin|has_?role|roles?|owner_?id|ownerId|can_?access|acl|tenant_?id|tenantId|forbidden|unauthori[sz]ed)\b/i,
  parsing: /(\b(parse\w*|decode\w*|deseriali[sz]\w*|unmarshal\w*|tokeni[sz]\w*|parseInt|parseFloat|URLSearchParams)\b|JSON\.parse|new RegExp|\.match\(|\.split\()/i,
  "business-rule": /\b(price|amount|balance|total|discount|quantity|refund|payment|stock|credit|fee|tax)\w*\b[^\n]*(<=|>=|<|>|\*|\+|-)/i,
};
const MAX_TARGET_FILES = 40;
const MAX_HITS = 4;
const MAX_PROPOSALS = 10;

export interface PropertyTarget {
  path: string;
  kinds: TargetKind[];
  hits: Array<{ kind: TargetKind; line: number; text: string }>;
}

export interface PropertyFacts {
  targets: PropertyTarget[];
  skipped: number;
  tooling: { fastCheck: boolean; hypothesis: boolean; quality: { runId: string; propertyTests: number | null } | null };
}

/** The host's search for target code and property-testing facts (no model involved). */
export function propertyFacts(input: Pick<ModuleApplicabilityInput, "readableFiles" | "readFile" | "runDir">): PropertyFacts {
  const files = input.readableFiles();
  const targets: PropertyTarget[] = [];
  let skipped = 0;
  for (const p of files) {
    if (!isCodePath(p) || isTestPath(p) || p.startsWith(`${REGRESSIONS_DIR}/`)) continue;
    const text = input.readFile(p);
    if (text === null) continue;
    const hits: PropertyTarget["hits"] = [];
    text.split(/\r?\n/).forEach((l, k) => {
      if (l.trim().startsWith("//") || l.trim().startsWith("#")) return;
      for (const kind of TARGET_KINDS) {
        if (hits.filter((h) => h.kind === kind).length < MAX_HITS && PATTERNS[kind].test(l)) hits.push({ kind, line: k + 1, text: maskBrief(l.trim().slice(0, 160)) });
      }
    });
    if (hits.length === 0) continue;
    if (targets.length >= MAX_TARGET_FILES) {
      skipped++;
      continue;
    }
    targets.push({ path: p, kinds: TARGET_KINDS.filter((k) => hits.some((h) => h.kind === k)), hits });
  }
  const manifest = (name: RegExp): string => files.filter((p) => name.test(path.posix.basename(p))).map((p) => input.readFile(p) ?? "").join("\n");
  const quality = attachedQualityResult(input.runDir);
  const metric = quality?.metrics.find((m) => m.id === "tests.property.total");
  return {
    targets,
    skipped,
    tooling: {
      fastCheck: /["']fast-check["']/.test(manifest(/^package\.json$/)),
      hypothesis: /\bhypothesis\b/i.test(manifest(/^(pyproject\.toml|requirements[\w.-]*\.txt|setup\.cfg|Pipfile)$/)),
      quality: quality ? { runId: quality.runId, propertyTests: typeof metric?.value === "number" ? metric.value : null } : null,
    },
  };
}

const factsOf = (inputs: Readonly<Record<string, unknown>> | undefined): PropertyFacts | null => (inputs?.facts as PropertyFacts | undefined) ?? null;

interface AcceptedInvariant {
  id: string;
  kind: TargetKind;
  target: { path: string; line: number | null };
  statement: string;
  domain: string;
  status: "holds" | "violated" | "unknown";
  counterexample: { input: string; expected: string; observed_by_reading: string } | null;
  test: { file: string; content: string } | null;
}

const INVARIANTS_SHAPE = `{"summary": "...", "invariants": [{"id": "I1", "kind": "${TARGET_KINDS.join("|")}", "target": {"path": "file you read", "line": 12}, "statement": "for every <input in the domain>, <what must hold>", "domain": "the inputs or operation sequences it ranges over", "status": "holds|violated|unknown", "severity": "blocking|important|suggestion|nit (violated only)", "counterexample": {"input": "a concrete input", "expected": "what the invariant requires", "observed_by_reading": "what the code you read does instead"}, "test": {"name": "short-name.test.mjs", "content": "a node:test module (node:assert); it lives at ${REGRESSIONS_DIR}/<name> and imports project files relative to that folder, e.g. ../../src/x.js"}}], "uncovered": [{"path": "target you did not state an invariant for", "reason": "..."}]}`;
const FALSIFY_SHAPE = `{"candidateId": "C1", "confirmation": "confirmed|rejected|needs-validation", "reason": "...", "evidence": [{"path": "...", "line": 12, "note": "..."}], "severity": "optional correction", "counterexample_holds": true, "guard": "required when rejected: the check that prevents the counterexample"}`;

function checkInvariants(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  const problems: string[] = [];
  const summary = str(value.summary, 1500);
  if (summary === "") return { ok: false, problems: ["summary is required"] };
  const invariants: AcceptedInvariant[] = [];
  const severities = new Map<string, FindingSeverity>();
  for (const raw of list(value.invariants)) {
    if (!isObj(raw)) continue;
    const id = str(raw.id, 20).replace(/[^A-Za-z0-9_-]+/g, "") || `I${invariants.length + 1}`;
    if (invariants.some((i) => i.id === id)) {
      problems.push(`invariant ${id} is repeated; the repetition is dropped`);
      continue;
    }
    const kind = (TARGET_KINDS as readonly string[]).includes(String(raw.kind)) ? (raw.kind as TargetKind) : null;
    const statement = str(raw.statement, 600);
    const target = isObj(raw.target) ? seenRef(raw.target.path, raw.target.line, ctx, problems, `invariant ${id} target`) : null;
    if (!kind || statement === "" || !target) {
      problems.push(`invariant ${id} is dropped: it needs a kind, a statement and a target this context read`);
      continue;
    }
    let status: AcceptedInvariant["status"] = raw.status === "holds" || raw.status === "violated" ? raw.status : "unknown";
    const ce = isObj(raw.counterexample) ? { input: str(raw.counterexample.input, 400), expected: str(raw.counterexample.expected, 400), observed_by_reading: str(raw.counterexample.observed_by_reading, 600) } : null;
    if (status === "violated" && (!ce || ce.input === "" || ce.expected === "")) {
      problems.push(`invariant ${id}: claimed violated without a concrete counterexample (input and expected); it stays unknown`);
      status = "unknown";
    }
    const test = raw.test === undefined || raw.test === null ? null : checkProposedTest(raw.test, problems, `invariant ${id} test`);
    if (status === "violated") severities.set(id, FINDING_SEVERITIES.includes(String(raw.severity) as FindingSeverity) ? (raw.severity as FindingSeverity) : "important");
    invariants.push({ id, kind, target, statement, domain: str(raw.domain, 400), status, counterexample: status === "violated" ? ce : null, test });
    if (invariants.length >= 40) break;
  }
  const facts = factsOf(ctx.run?.inputs);
  const gaps: Array<{ path?: string; reason: string }> = [];
  for (const u of list(value.uncovered)) if (isObj(u)) gaps.push({ ...(typeof u.path === "string" ? { path: u.path } : {}), reason: `no invariant stated: ${str(u.reason, 300) || "no reason given"}` });
  for (const t of facts?.targets ?? []) if (!invariants.some((i) => i.target.path === t.path)) gaps.push({ path: t.path, reason: `no invariant was stated for this ${t.kinds.join("/")} code` });
  if (invariants.filter((i) => i.test).length > MAX_PROPOSALS) problems.push(`at most ${MAX_PROPOSALS} tests are kept as proposals`);
  const candidates = invariants
    .filter((i) => i.status === "violated")
    .map((i) => ({
      title: `Invariant ${i.id} violated: ${i.statement.slice(0, 150)}`,
      path: i.target.path,
      line: i.target.line,
      severity: severities.get(i.id) ?? ("important" as FindingSeverity),
      category: "property",
      rationale: `Counterexample: ${i.counterexample?.input} should give ${i.counterexample?.expected}; ${i.counterexample?.observed_by_reading}`.slice(0, 1500),
      details: { invariant_id: i.id, kind: i.kind, statement: i.statement, domain: i.domain, counterexample: i.counterexample, test: i.test?.file ?? null, evidence_basis: "source-argument" },
    }));
  return { ok: true, problems, value: { summary, invariants }, candidates, examined: [...new Set(invariants.map((i) => i.target.path))], gaps };
}

function checkFalsify(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  return checkVerdict(value, ctx, (problems) => {
    const guard = str(value.guard, 400);
    if (value.confirmation === "rejected" && guard === "") problems.push("a rejected violation needs guard: the check that prevents the counterexample");
    return { counterexample_holds: typeof value.counterexample_holds === "boolean" ? value.counterexample_holds : null, ...(guard ? { guard } : {}), evidence_basis: "source-argument" };
  });
}

function brief(input: ModuleBriefInput): string | null {
  const facts = factsOf(input.inputs);
  if (!facts) return null;
  if (input.stage.id === STAGES.invariants) {
    return [
      briefJson("Target code found by the host (lines that look like boundary, authorization, parsing or business-rule logic; read the files, the lines are only pointers):", facts.targets),
      facts.skipped > 0 ? `${facts.skipped} more target file(s) exist beyond the first ${MAX_TARGET_FILES}.` : "",
      briefJson("Property-testing facts:", facts.tooling),
      `A test you propose is a node:test module that would live at ${REGRESSIONS_DIR}/<name>: import project files relative to that folder and use only node:test and node:assert (no network, no file writes, no child processes). It is a proposal: nothing runs it now, and it becomes part of the project only if a person validates and incorporates it.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (input.stage.id === STAGES.falsify && input.candidate) {
    const accepted = (input.accepted[STAGES.invariants] as { invariants?: AcceptedInvariant[] } | undefined)?.invariants ?? [];
    const inv = accepted.find((i) => i.id === (input.candidate?.details as { invariant_id?: string } | undefined)?.invariant_id);
    return inv?.test ? briefJson("The property test proposed with this invariant (untrusted; not executed):", { name: inv.test.file, content: inv.test.content }) : null;
  }
  return null;
}

function finalize(input: ModuleFinalizeInput): ModuleFinalizeOutput {
  const facts = factsOf(input.inputs);
  const accepted = (input.accepted[STAGES.invariants] as { invariants?: AcceptedInvariant[] } | undefined)?.invariants ?? [];
  const candidateOf = (id: string) => input.candidates.find((c) => (c.details as { invariant_id?: string } | undefined)?.invariant_id === id) ?? null;
  const proposals = proposalsFile(
    input.runDir,
    PROPERTY_METHOD,
    accepted
      .filter((i) => i.test)
      .slice(0, MAX_PROPOSALS)
      .map((i) => {
        const c = candidateOf(i.id);
        return {
          file: i.test!.file,
          content: i.test!.content,
          title: `Property ${i.id}: ${i.statement.slice(0, 160)}`,
          rationale: `${i.kind} invariant over ${i.domain || "its inputs"} at ${i.target.path}${i.target.line ? `:${i.target.line}` : ""}; status ${i.status}${c ? `, candidate ${c.id} ${c.status}` : ""}.`,
          origin: { stage: STAGES.invariants, candidate: c?.id ?? null, candidateStatus: c?.status ?? null, invariant: i.id },
          execution: null,
        };
      }),
  );
  const doc = {
    schemaVersion: 1,
    kind: "semantic-property-reasoning",
    method: PROPERTY_METHOD,
    generatedAt: input.now.toISOString(),
    evidenceBasis: "source-argument",
    targets: (facts?.targets ?? []).map((t) => ({ path: t.path, kinds: t.kinds, invariants: accepted.filter((i) => i.target.path === t.path).map((i) => i.id) })),
    tooling: facts?.tooling ?? null,
    invariants: accepted.map((i) => ({ ...i, test: i.test ? { file: i.test.file, proposal: proposals.proposals.find((p) => p.origin.invariant === i.id)?.id ?? null } : null, candidate: candidateOf(i.id)?.id ?? null, candidateStatus: candidateOf(i.id)?.status ?? null })),
    candidates: input.candidates.map((c) => ({ id: c.id, title: c.title, path: c.path, line: c.line, severity: c.severity, status: c.status, details: c.details ?? null, validation: c.validation })),
  };
  const uncovered = (facts?.targets ?? []).filter((t) => !accepted.some((i) => i.target.path === t.path));
  return {
    files: [
      { path: INVARIANTS_FILE, content: `${JSON.stringify(doc, null, 2)}\n` },
      ...(proposals.proposals.length > 0 ? [{ path: proposals.path, content: proposals.content }] : []),
    ],
    gaps: uncovered.map((t) => ({ code: "PROPERTY_TARGET_NOT_COVERED", path: t.path, reason: `no invariant was stated for this ${t.kinds.join("/")} code` })),
    report: { targets: facts?.targets.length ?? 0, invariants: accepted.length, violated: accepted.filter((i) => i.status === "violated").length, confirmed: input.candidates.filter((c) => c.status === "confirmed").length, proposals: proposals.proposals.length },
  };
}

const OBJECTIVE =
  "State what must hold over the inputs (or operation sequences) of boundary-heavy, authorization, parsing and business-rule code, and argue each invariant against the code you read. An invariant names its domain precisely (which inputs, which states) and what must hold for every element of it. A violation needs a concrete counterexample from the domain and the code path that produces the wrong result; an invariant you cannot settle stays unknown. Proposed property tests are reviewable material only: they are never run or applied by this method.";

export function propertyReasoningModule(): InvestigationModule {
  return {
    id: PROPERTY_MODULE_ID,
    version: "1",
    title: "Property reasoning",
    objective: OBJECTIVE,
    provenance: { origin: "original JGates method", reference: "https://github.com/trailofbits/skills/tree/main/plugins/property-based-testing (question only; no upstream text used)" },
    minimum: { exploreCalls: 1, reserveCalls: 1 },
    applicability: (input): ModuleApplicability => {
      const facts = propertyFacts(input);
      if (facts.targets.length === 0) {
        return { applicable: false, code: "PROPERTY_NO_TARGETS", missing: "boundary, authorization, parsing or business-rule code", reason: "property reasoning needs boundary-heavy, authorization, parsing or business-rule code in the readable scope; the host found none (test files and comments do not count)" };
      }
      return { applicable: true, inputs: { facts }, record: { targets: facts.targets.map((t) => ({ path: t.path, kinds: t.kinds })), skipped: facts.skipped, tooling: facts.tooling } };
    },
    stages: [
      {
        id: STAGES.invariants,
        label: "Invariants and counterexamples",
        role: "explore",
        required: true,
        contexts: "once",
        instructions:
          "Read the target files your brief lists (and the context they need). For each target state the invariants that matter: bounds and lengths (inclusive or exclusive, empty and maximal inputs), authorization (who may act on which object, under which role or tenant), parsing (what is accepted, what must be refused, round-trips), business rules (totals, signs, limits). Give each invariant its domain and a status: holds (say what in the code guarantees it), violated (give a concrete counterexample input, what the invariant requires and what the code you read does instead) or unknown. Where useful, add a small deterministic node:test property test for the invariant (iterate over boundary values and a fixed sample; no randomness without a fixed seed). List targets you did not cover and why.",
        artifact: { kind: "custom", shape: INVARIANTS_SHAPE, validate: checkInvariants },
      },
      {
        id: STAGES.falsify,
        label: "Counterexample challenge",
        role: "validate",
        required: true,
        contexts: "per-candidate",
        instructions:
          "You judge one claimed invariant violation another context reported; you are free to reject it. Follow the counterexample through the code you read: callers that validate first, guards, types, defaults. Confirm it only when the code you read produces the wrong result for that input; reject it when a check prevents the input or the result (cite the guard); answer needs-validation when the files you can read do not settle it. Your evidence is a source argument: never claim the test was run.",
        artifact: { kind: "custom", shape: FALSIFY_SHAPE, validate: checkFalsify },
      },
    ],
    brief,
    finalize,
  };
}
