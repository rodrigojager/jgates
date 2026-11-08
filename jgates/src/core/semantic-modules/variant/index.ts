// Variant analysis (method `variant-analysis`), adapted from the Trail of Bits variant-analysis skill (CC BY-SA 4.0,
// vendor/trailofbits-skills/variant-analysis/method.md). It starts from a root cause that an earlier, independently
// validated review confirmed and looks for its other occurrences across the readable scope.
//
//   inputs        confirmed seeds: confirmed candidates of earlier Semantic runs of the workspace (newest first) and seeds
//                 the caller gives; each seed's file must still be readable and its line must exist
//   hypothesis    the same root cause ([data] reaches [operation] without [protection]) occurs elsewhere
//   method        root-cause    (explore, one context): root-cause statement, exact-match calibration, grounded axes
//                 sweep         (explore, one context): abstraction ladder per axis over the whole scope
//                 triage        (validate, a fresh context per variant): argue against it, reachable/controllable/
//                               unprotected, false-positive reason
//   output        evidence/variant-analysis/variants.json (seeds with their source run, axes with the methodology table,
//                 variants with verdicts, false positives grouped by reason); every variant carries the seed's
//                 root_cause_key, so the root-cause correlation groups it with its seed
//   applicability not applicable without a confirmed root cause (VARIANT_NO_CONFIRMED_ROOT_CAUSE)
//   overlap       the Cloudflare baseline's hunting searches variants only inside the coverage units of the same run and
//                 only for high/critical candidates it just proposed; this module starts from a validated finding of an
//                 earlier run (any method), searches the whole readable scope along host-checked axes and triages every
//                 variant in its own fresh context. It adds no generic audit prompt.
import { normalizeScopePath } from "../../semantic-scope/index.js";
import type { ArtifactCheck, ArtifactCheckContext, Candidate, InvestigationModule, ModuleApplicability, ModuleApplicabilityInput, ModuleBriefInput, ModuleFinalizeInput, ModuleFinalizeOutput } from "../../semantic-executor/index.js";
import { checkCandidates, checkVerdict, isObj, list, priorSemanticRuns, seenPaths, seenRef, str, strings, briefJson } from "../complementary/shared.js";
import { loadTobMethod, tobProvenance, type TobMethodMaterial } from "../complementary/vendor.js";

export const VARIANT_ANALYSIS_METHOD = "variant-analysis";
export const VARIANT_MODULE_ID = "variant-analysis";
export const VARIANTS_FILE = "evidence/variant-analysis/variants.json";
export const STAGES = { rootCause: "root-cause", sweep: "sweep", triage: "triage" } as const;
const MAX_SEEDS = 5;

/** A confirmed root cause given by the caller (an earlier run's confirmed record, a reviewed finding). */
export interface VariantSeedInput {
  title: string;
  path: string;
  line?: number | null;
  rootCause: string;
  severity?: string;
  category?: string;
  /** Stable identity of the root cause (a fingerprint); variants carry it as root_cause_key. */
  key?: string;
  source?: { runId?: string; candidateId?: string; method?: string };
}

export interface VariantSeed {
  id: string;
  key: string;
  title: string;
  path: string;
  line: number | null;
  severity: string;
  category: string;
  rootCause: string;
  source: { kind: "prior-run" | "caller"; runId: string | null; candidateId: string | null; method: string | null };
  validation: { reason: string; evidence: unknown[] } | null;
}

interface RootCauseSeed {
  seed_id: string;
  reproduced: boolean;
  root_cause: string;
  exact_match: { path: string; line: number | null } | null;
  axes: Array<{ id: string; description: string; constructs: string[]; leads: string[] }>;
  reason: string | null;
}

/** The confirmed seeds of earlier runs (and the caller's), deduplicated by root-cause key. */
export function collectSeeds(input: Pick<ModuleApplicabilityInput, "runDir" | "readable" | "readFile">, given: readonly VariantSeedInput[] = []): { seeds: VariantSeed[]; dropped: Array<{ title: string; path: string; reason: string }> } {
  const raw: Array<Omit<VariantSeed, "id">> = [];
  for (const g of given) {
    raw.push({ key: g.key ?? `${g.path}:${g.line ?? "-"}:${g.title}`, title: g.title, path: g.path, line: g.line ?? null, severity: g.severity ?? "important", category: g.category ?? "security", rootCause: g.rootCause, source: { kind: "caller", runId: g.source?.runId ?? null, candidateId: g.source?.candidateId ?? null, method: g.source?.method ?? null }, validation: null });
  }
  for (const run of priorSemanticRuns(input.runDir)) {
    const outcome = (run.result.semanticRun as { outcome?: { investigation?: { module?: { id?: string }; candidates?: unknown } } } | undefined)?.outcome;
    const inv = outcome?.investigation;
    for (const c of list(inv?.candidates)) {
      if (!isObj(c) || c.status !== "confirmed") continue;
      const details = isObj(c.details) ? { ...(isObj(c.details.record) ? c.details.record : {}), ...c.details } : {};
      const validation = isObj(c.validation) ? c.validation : null;
      const key = str(details.root_cause_key ?? details.fingerprint, 200) || `${run.runId}/${String(c.id)}`;
      raw.push({
        key,
        title: str(c.title, 200),
        path: String(c.path ?? ""),
        line: typeof c.line === "number" ? c.line : null,
        severity: String(c.severity ?? "important"),
        category: String(c.category ?? "security"),
        rootCause: str(details.root_cause ?? details.root_cause_statement ?? c.rationale, 1000),
        source: { kind: "prior-run", runId: run.runId, candidateId: String(c.id ?? ""), method: str(inv?.module?.id, 80) || null },
        validation: validation ? { reason: str(validation.reason, 1000), evidence: list(validation.evidence).slice(0, 5) } : null,
      });
    }
  }
  const seeds: VariantSeed[] = [];
  const dropped: Array<{ title: string; path: string; reason: string }> = [];
  const keys = new Set<string>();
  for (const s of raw) {
    if (keys.has(s.key)) continue;
    const p = normalizeScopePath(s.path);
    if (!p || s.title === "" || s.rootCause === "") {
      dropped.push({ title: s.title, path: s.path, reason: "the record has no usable path, title or root cause" });
      continue;
    }
    if (!input.readable(p)) {
      dropped.push({ title: s.title, path: p, reason: "its file is not readable in this scope" });
      continue;
    }
    const text = input.readFile(p);
    const lines = text === null ? 0 : text.split(/\r?\n/).length;
    if (s.line !== null && s.line > lines) {
      dropped.push({ title: s.title, path: p, reason: `its line ${s.line} no longer exists (the file has ${lines})` });
      continue;
    }
    if (seeds.length >= MAX_SEEDS) {
      dropped.push({ title: s.title, path: p, reason: `at most ${MAX_SEEDS} seeds per run` });
      continue;
    }
    keys.add(s.key);
    seeds.push({ ...s, path: p, id: `S${seeds.length + 1}` });
  }
  return { seeds, dropped };
}

const seedsOf = (inputs: Readonly<Record<string, unknown>> | undefined): VariantSeed[] => (inputs?.seeds as VariantSeed[] | undefined) ?? [];

const ROOT_SHAPE = `{"summary": "...", "seeds": [{"seed_id": "S1", "reproduced": true, "root_cause": "this exists because [data] reaches [operation] without [protection]", "exact_match": {"path": "the seed file you read", "line": 12}, "axes": [{"id": "short-id", "description": "...", "constructs": ["identifiers or code shapes to search"], "leads": ["files you saw where the constructs occur"]}], "reason": "when not reproduced: why"}]}`;
const SWEEP_SHAPE = `{"summary": "...", "axes": [{"id": "<axis id>", "state": "searched|pending", "patterns": [{"level": 0, "pattern": "what you searched", "matches": 3, "noise": 1}], "reason": "required when pending"}], "candidates": [{"title": "...", "path": "...", "line": 12, "severity": "blocking|important|suggestion|nit", "rationale": "...", "seed_id": "S1", "axis": "<axis id>", "level": 1, "missing_protection": "..."}]}`;
const TRIAGE_SHAPE = `{"candidateId": "C1", "confirmation": "confirmed|rejected|needs-validation", "reason": "...", "evidence": [{"path": "...", "line": 12, "note": "..."}], "severity": "blocking|important|suggestion|nit (surviving variants)", "reachable": true, "controllable": true, "unprotected": true, "safe_reason": "required when rejected: the protection that makes it safe", "confidence": "low|medium|high"}`;

function checkRootCause(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  const problems: string[] = [];
  const summary = str(value.summary, 1500);
  if (summary === "") return { ok: false, problems: ["summary is required"] };
  const seeds = seedsOf(ctx.run?.inputs);
  const byId = new Map(seeds.map((s) => [s.id, s]));
  const out: RootCauseSeed[] = [];
  const gaps: Array<{ path?: string; reason: string }> = [];
  for (const raw of list(value.seeds)) {
    if (!isObj(raw)) continue;
    const seed = byId.get(String(raw.seed_id ?? ""));
    if (!seed || out.some((o) => o.seed_id === seed.id)) {
      problems.push(`a seed entry is dropped: ${JSON.stringify(String(raw.seed_id ?? "").slice(0, 20))} is unknown or repeated`);
      continue;
    }
    const rootCause = str(raw.root_cause, 600);
    let reproduced = raw.reproduced === true;
    let reason = str(raw.reason, 400) || null;
    const exact = isObj(raw.exact_match) ? seenRef(raw.exact_match.path, raw.exact_match.line, ctx, problems, `${seed.id} exact match`) : null;
    if (reproduced && (!exact || exact.path !== seed.path || rootCause === "")) {
      problems.push(`${seed.id}: claimed reproduced without a root cause and an exact match in ${seed.path} this context read; it is not searched`);
      reproduced = false;
      reason = reason ?? "the calibration did not show the root cause at the seed";
    }
    const axes: RootCauseSeed["axes"] = [];
    for (const a of list(raw.axes)) {
      if (!isObj(a)) continue;
      const id = str(a.id, 60).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
      const leads = seenPaths(a.leads, ctx, problems, `${seed.id} axis ${id}`);
      if (id === "" || leads.length === 0) {
        problems.push(`${seed.id}: axis ${JSON.stringify(id)} is dropped: an axis needs grounded leads this context saw`);
        continue;
      }
      if (axes.some((x) => x.id === id)) continue;
      axes.push({ id, description: str(a.description, 400), constructs: strings(a.constructs, 120, 10), leads });
    }
    if (reproduced && axes.length === 0) problems.push(`${seed.id}: no grounded axis; only the seed's own neighbourhood can be searched`);
    if (!reproduced) gaps.push({ path: seed.path, reason: `${seed.id} (${seed.title}) not reproduced: ${reason ?? "no reason given"}` });
    out.push({ seed_id: seed.id, reproduced, root_cause: rootCause, exact_match: exact, axes: reproduced ? axes : [], reason: reproduced ? null : reason });
  }
  for (const s of seeds) if (!out.some((o) => o.seed_id === s.id)) gaps.push({ path: s.path, reason: `${s.id} (${s.title}) was not analyzed by the root-cause stage` });
  const examined = [...new Set(out.flatMap((o) => [...(o.exact_match ? [o.exact_match.path] : []), ...o.axes.flatMap((a) => a.leads)]))];
  return { ok: true, problems, value: { summary, seeds: out }, examined, gaps };
}

function checkSweep(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  const problems: string[] = [];
  const summary = str(value.summary, 1500);
  if (summary === "") return { ok: false, problems: ["summary is required"] };
  const seeds = seedsOf(ctx.run?.inputs);
  const root = (ctx.accepted?.[STAGES.rootCause]?.seeds as RootCauseSeed[] | undefined) ?? [];
  const reproduced = root.filter((r) => r.reproduced);
  const axisIds = new Set(reproduced.flatMap((r) => r.axes.map((a) => a.id)));
  const axes: Array<{ id: string; state: "searched" | "pending"; patterns: Array<{ level: number; pattern: string; matches: number | null; noise: number | null }>; reason: string | null }> = [];
  const gaps: Array<{ path?: string; reason: string }> = [];
  for (const a of list(value.axes)) {
    if (!isObj(a)) continue;
    const id = String(a.id ?? "");
    if (!axisIds.has(id) || axes.some((x) => x.id === id)) {
      problems.push(`axis ${JSON.stringify(id.slice(0, 60))} is dropped: not an accepted axis, or repeated`);
      continue;
    }
    const patterns = list(a.patterns)
      .filter(isObj)
      .map((p) => ({ level: typeof p.level === "number" && p.level >= 0 && p.level <= 3 ? Math.floor(p.level) : 0, pattern: str(p.pattern, 200), matches: typeof p.matches === "number" ? p.matches : null, noise: typeof p.noise === "number" ? p.noise : null }))
      .filter((p) => p.pattern !== "")
      .slice(0, 12);
    let state: "searched" | "pending" = a.state === "searched" && patterns.length > 0 ? "searched" : "pending";
    let reason = str(a.reason, 400) || null;
    if (a.state === "searched" && patterns.length === 0) {
      problems.push(`axis ${id}: claimed searched without a pattern; it stays pending`);
      reason = reason ?? "no search pattern was reported";
      state = "pending";
    }
    if (state === "pending") gaps.push({ reason: `axis ${id} pending: ${reason ?? "no reason given"}` });
    axes.push({ id, state, patterns, reason: state === "pending" ? reason : null });
  }
  for (const id of axisIds) if (!axes.some((a) => a.id === id)) gaps.push({ reason: `axis ${id} was not reported by the sweep` });
  const candidates = checkCandidates(value.candidates, ctx, problems, "variant", (c, at) => {
    const seed = seeds.find((s) => s.id === String(c.seed_id ?? ""));
    const rc = reproduced.find((r) => r.seed_id === seed?.id);
    if (!seed || !rc) {
      problems.push(`the candidate at ${at.path} is dropped: it names no reproduced seed`);
      return null;
    }
    if (at.path === seed.path && (at.line === null || seed.line === null || Math.abs(at.line - seed.line) <= 3)) {
      problems.push(`the candidate at ${at.path}${at.line ? `:${at.line}` : ""} is dropped: it is the seed itself`);
      return null;
    }
    const axis = String(c.axis ?? "");
    if (!rc.axes.some((a) => a.id === axis)) problems.push(`the candidate at ${at.path} names axis ${JSON.stringify(axis.slice(0, 40))}, which is not one of ${seed.id}'s axes; it is kept`);
    return {
      seed_id: seed.id,
      root_cause_key: seed.key,
      root_cause: rc.root_cause,
      axis,
      level: typeof c.level === "number" ? c.level : null,
      missing_protection: str(c.missing_protection, 300),
      seed: { path: seed.path, line: seed.line, runId: seed.source.runId, candidateId: seed.source.candidateId },
    };
  });
  return { ok: true, problems, value: { summary, axes }, candidates, examined: [...new Set(candidates.map((c) => c.path))], gaps };
}

function checkTriage(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  return checkVerdict(value, ctx, (problems) => {
    const tri = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
    const safe = str(value.safe_reason, 300);
    if (value.confirmation === "rejected" && safe === "") problems.push("a rejected variant needs safe_reason: the protection that makes it safe");
    const confidence = ["low", "medium", "high"].includes(String(value.confidence)) ? String(value.confidence) : null;
    return { reachable: tri(value.reachable), controllable: tri(value.controllable), unprotected: tri(value.unprotected), ...(safe ? { safe_reason: safe } : {}), confidence };
  });
}

function brief(input: ModuleBriefInput): string | null {
  const seeds = seedsOf(input.inputs);
  if (input.stage.id === STAGES.rootCause) {
    return briefJson("Confirmed seeds (host-checked; their validation was done by an earlier, independent review):", seeds.map((s) => ({ seed_id: s.id, title: s.title, path: s.path, line: s.line, severity: s.severity, root_cause: s.rootCause, source: s.source, validation: s.validation })));
  }
  if (input.stage.id === STAGES.sweep) {
    const root = input.accepted[STAGES.rootCause] as { seeds?: RootCauseSeed[] } | undefined;
    return briefJson("Root causes and axes (host-validated; search every axis of every reproduced seed):", (root?.seeds ?? []).filter((r) => r.reproduced).map((r) => ({ ...r, seed: seeds.find((s) => s.id === r.seed_id) ? { path: seeds.find((s) => s.id === r.seed_id)?.path, line: seeds.find((s) => s.id === r.seed_id)?.line } : null })));
  }
  if (input.stage.id === STAGES.triage && input.candidate) {
    const d = (input.candidate.details ?? {}) as { seed_id?: string; root_cause?: string };
    const seed = seeds.find((s) => s.id === d.seed_id);
    return briefJson("The root cause this variant is claimed to share (confirmed at the seed):", { root_cause: d.root_cause ?? null, seed: seed ? { title: seed.title, path: seed.path, line: seed.line } : null });
  }
  return null;
}

function finalize(input: ModuleFinalizeInput): ModuleFinalizeOutput {
  const seeds = seedsOf(input.inputs);
  const root = (input.accepted[STAGES.rootCause] as { seeds?: RootCauseSeed[] } | undefined)?.seeds ?? [];
  const sweep = input.accepted[STAGES.sweep] as { axes?: Array<Record<string, unknown>> } | undefined;
  const variants = input.candidates.map((c: Candidate) => {
    const d = (c.details ?? {}) as Record<string, unknown>;
    const v = (d.verdict ?? {}) as Record<string, unknown>;
    return { candidate: c.id, title: c.title, path: c.path, line: c.line, severity: c.severity, status: c.status, seed: d.seed_id ?? null, root_cause_key: d.root_cause_key ?? null, axis: d.axis ?? null, level: d.level ?? null, reachable: v.reachable ?? null, controllable: v.controllable ?? null, unprotected: v.unprotected ?? null, confidence: v.confidence ?? null, reason: c.validation?.reason ?? c.reason ?? null, evidence: c.validation?.evidence ?? [] };
  });
  const falsePositives = new Map<string, string[]>();
  for (const c of input.candidates) {
    if (c.status !== "rejected") continue;
    const reason = String(((c.details ?? {}) as { verdict?: { safe_reason?: string } }).verdict?.safe_reason ?? c.validation?.reason ?? "rejected");
    falsePositives.set(reason, [...(falsePositives.get(reason) ?? []), `${c.path}${c.line ? `:${c.line}` : ""}`]);
  }
  const doc = {
    schemaVersion: 1,
    kind: "semantic-variant-analysis",
    method: VARIANT_ANALYSIS_METHOD,
    generatedAt: input.now.toISOString(),
    seeds: seeds.map((s) => ({ ...s, analysis: root.find((r) => r.seed_id === s.id) ?? null })),
    droppedSeeds: (input.inputs?.dropped as unknown[] | undefined) ?? [],
    methodology: sweep?.axes ?? [],
    variants,
    falsePositives: [...falsePositives.entries()].map(([reason, locations]) => ({ reason, locations })),
  };
  const notReproduced = root.filter((r) => !r.reproduced);
  return {
    files: [{ path: VARIANTS_FILE, content: `${JSON.stringify(doc, null, 2)}\n` }],
    gaps: notReproduced.map((r) => ({ code: "SEED_NOT_REPRODUCED", reason: `${r.seed_id} was not reproduced in the current source: ${r.reason ?? "no reason"}` })),
    report: { seeds: seeds.length, reproduced: root.filter((r) => r.reproduced).length, variants: variants.length, confirmed: variants.filter((v) => v.status === "confirmed").length, rejected: variants.filter((v) => v.status === "rejected").length },
  };
}

export function variantAnalysisModule(options: { seeds?: VariantSeedInput[]; material?: TobMethodMaterial } = {}): InvestigationModule {
  const material = options.material ?? loadTobMethod("variant-analysis", ["root-cause", "sweep", "triage"]);
  const b = material.blocks;
  return {
    id: VARIANT_MODULE_ID,
    version: "1",
    title: "Variant analysis",
    objective: b.objective as string,
    provenance: tobProvenance("variant-analysis", material.sha256, { added: "seeds from validated findings of earlier runs; host-checked axes, calibration and variant records; triage in fresh contexts" }),
    minimum: { exploreCalls: 2, reserveCalls: 1 },
    applicability: (input): ModuleApplicability => {
      const { seeds, dropped } = collectSeeds(input, options.seeds ?? []);
      if (seeds.length === 0) {
        return {
          applicable: false,
          code: "VARIANT_NO_CONFIRMED_ROOT_CAUSE",
          missing: "confirmed root cause",
          reason: `variant analysis needs a confirmed root cause: no earlier Semantic run of this workspace has a confirmed finding whose file is readable in this scope, and no seed was given${dropped.length > 0 ? ` (${dropped.length} record(s) dropped: ${dropped.map((d) => `${d.path}: ${d.reason}`).join("; ")})` : ""}`,
        };
      }
      return { applicable: true, inputs: { seeds, dropped }, record: { seeds: seeds.map((s) => ({ id: s.id, key: s.key, path: s.path, line: s.line, source: s.source })), dropped } };
    },
    stages: [
      { id: STAGES.rootCause, label: "Root cause and calibration", role: "explore", required: true, contexts: "once", instructions: b["root-cause"] as string, artifact: { kind: "custom", shape: ROOT_SHAPE, validate: checkRootCause } },
      { id: STAGES.sweep, label: "Variant sweep", role: "explore", required: true, contexts: "once", instructions: b.sweep as string, artifact: { kind: "custom", shape: SWEEP_SHAPE, validate: checkSweep } },
      { id: STAGES.triage, label: "Independent triage", role: "validate", required: true, contexts: "per-candidate", instructions: b.triage as string, artifact: { kind: "custom", shape: TRIAGE_SHAPE, validate: checkTriage } },
    ],
    brief,
    finalize,
  };
}
