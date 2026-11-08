// Cross-component reasoning (method `cross-component`), original JGates work (no third-party material).
//
//   inputs        at least two components (code folders) of the readable scope with an import relation between them,
//                 found by the host from relative imports
//   hypothesis    individually plausible actions, each allowed where it happens, combine across components into a
//                 privilege, tenant or state violation because one component assumes a guarantee another does not give
//   method        boundary-map     (explore, one context): per component the guarantees it produces and the assumptions
//                                  it consumes (each at a line it read), and multi-step flows across components
//                 chain-hunt       (explore, one context): chains of at least two steps in at least two files, each step
//                                  at a line read, with the guarantee/assumption gap and the violated property
//                 chain-challenge  (validate, a fresh context per chain): every step re-established independently; an
//                                  unestablished prerequisite caps the verdict at needs-validation
//   output        evidence/cross-component/chains.json (components, edges, boundary map, flows, chains with per-step
//                 verdicts)
//   applicability not applicable with a single component or no cross-component relation (CROSS_COMPONENT_SINGLE_COMPONENT)
//   overlap       the Cloudflare baseline has a "chained vulnerabilities and trust boundaries" attack class that a
//                 coverage unit may select for one surface and boundary; the general review's security dimension looks at
//                 the changed flow. Neither keeps a host-validated map of what each component guarantees versus what its
//                 consumers assume, nor requires every chain step to be evidenced and re-established in a fresh context.
//                 This module adds that structure and states no attack-class checklist of its own.
import path from "node:path";
import type { ArtifactCheck, ArtifactCheckContext, InvestigationModule, ModuleApplicability, ModuleApplicabilityInput, ModuleBriefInput, ModuleFinalizeInput, ModuleFinalizeOutput } from "../../semantic-executor/index.js";
import { briefJson, checkCandidates, checkVerdict, isCodePath, isObj, isTestPath, list, seenRef, str } from "../complementary/shared.js";

export const CROSS_COMPONENT_METHOD = "cross-component";
export const CROSS_COMPONENT_MODULE_ID = "cross-component";
export const CHAINS_FILE = "evidence/cross-component/chains.json";
export const STAGES = { map: "boundary-map", hunt: "chain-hunt", challenge: "chain-challenge" } as const;
export const VIOLATIONS = ["privilege", "tenant", "state", "other"] as const;

const IMPORT = /(?:require\(\s*|import\s*\(\s*|from\s+|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
const EXTS = ["", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".mts", ".cts", "/index.js", "/index.ts"];

export interface ComponentFacts {
  components: Array<{ id: string; files: string[] }>;
  edges: Array<{ from: string; to: string; via: string; line: number }>;
}

const componentOf = (p: string): string => path.posix.dirname(p) || ".";

/** Components (code folders) and the relative imports between them (no model involved). */
export function componentFacts(input: Pick<ModuleApplicabilityInput, "readableFiles" | "readFile">): ComponentFacts {
  const files = input.readableFiles().filter((p) => isCodePath(p) && !isTestPath(p));
  const set = new Set(files);
  const byComponent = new Map<string, string[]>();
  for (const p of files) byComponent.set(componentOf(p), [...(byComponent.get(componentOf(p)) ?? []), p]);
  const edges: ComponentFacts["edges"] = [];
  for (const p of files) {
    const text = input.readFile(p);
    if (text === null) continue;
    text.split(/\r?\n/).forEach((l, k) => {
      for (const m of l.matchAll(IMPORT)) {
        const spec = m[1] as string;
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(p), spec));
        const target = EXTS.map((e) => base + e).find((c) => set.has(c));
        if (target && componentOf(target) !== componentOf(p) && edges.length < 200) edges.push({ from: p, to: target, via: spec, line: k + 1 });
      }
    });
  }
  return { components: [...byComponent.entries()].map(([id, fs]) => ({ id, files: fs })).sort((a, b) => (a.id < b.id ? -1 : 1)), edges };
}

const factsOf = (inputs: Readonly<Record<string, unknown>> | undefined): ComponentFacts => (inputs?.facts as ComponentFacts | undefined) ?? { components: [], edges: [] };

const MAP_SHAPE = `{"summary": "...", "components": [{"id": "<component id>", "guarantees": [{"statement": "what it guarantees to its callers", "path": "...", "line": 12}], "assumptions": [{"statement": "what it assumes about its inputs or callers", "path": "...", "line": 12, "relies_on": "<component id>"}]}], "flows": [{"id": "F1", "principal": "who starts it", "steps": [{"component": "<component id>", "path": "...", "line": 12, "action": "..."}]}]}`;
const HUNT_SHAPE = `{"summary": "...", "flows": [{"id": "F1", "state": "examined|pending", "reason": "required when pending"}], "candidates": [{"title": "...", "path": "the step where the violation lands", "line": 12, "severity": "blocking|important|suggestion|nit", "rationale": "...", "flow": "F1", "violated": "${VIOLATIONS.join("|")}", "gap": "the guarantee one component gives versus what the next assumes", "steps": [{"path": "...", "line": 12, "action": "what the principal does here", "output": "what it obtains for the next step"}]}]}`;
const CHALLENGE_SHAPE = `{"candidateId": "C1", "confirmation": "confirmed|rejected|needs-validation", "reason": "...", "evidence": [{"path": "...", "line": 12, "note": "..."}], "severity": "optional correction", "steps": [{"index": 1, "established": true, "note": "..."}]}`;

type Ref = { path: string; line: number | null };

function checkMap(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  const problems: string[] = [];
  const summary = str(value.summary, 1500);
  if (summary === "") return { ok: false, problems: ["summary is required"] };
  const known = new Set(factsOf(ctx.run?.inputs).components.map((c) => c.id));
  const components: Array<Record<string, unknown>> = [];
  for (const c of list(value.components)) {
    if (!isObj(c) || !known.has(String(c.id)) || components.some((x) => x.id === c.id)) {
      problems.push(`a component entry is dropped: ${JSON.stringify(String(isObj(c) ? c.id : "").slice(0, 60))} is unknown or repeated`);
      continue;
    }
    const refs = (raw: unknown, kind: string): Array<Record<string, unknown>> =>
      list(raw)
        .filter(isObj)
        .flatMap((g): Array<Record<string, unknown>> => {
          const at = seenRef(g.path, g.line, ctx, problems, `${String(c.id)} ${kind}`);
          const statement = str(g.statement, 400);
          return at && statement ? [{ statement, ...at, ...(g.relies_on ? { relies_on: str(g.relies_on, 120) } : {}) }] : [];
        });
    components.push({ id: c.id, guarantees: refs(c.guarantees, "guarantee"), assumptions: refs(c.assumptions, "assumption") });
  }
  const flows: Array<{ id: string; principal: string; steps: Array<Ref & { component: string; action: string }> }> = [];
  for (const f of list(value.flows)) {
    if (!isObj(f)) continue;
    const id = str(f.id, 20);
    const steps = list(f.steps)
      .filter(isObj)
      .map((s) => {
        const at = seenRef(s.path, s.line, ctx, problems, `flow ${id} step`);
        return at ? { ...at, component: str(s.component, 120), action: str(s.action, 300) } : null;
      })
      .filter((s): s is Ref & { component: string; action: string } => s !== null);
    if (id === "" || flows.some((x) => x.id === id) || steps.length < 2 || new Set(steps.map((s) => s.path)).size < 2) {
      problems.push(`flow ${JSON.stringify(id)} is dropped: a cross-component flow needs an ID and at least two read steps in two files`);
      continue;
    }
    flows.push({ id, principal: str(f.principal, 200), steps });
  }
  const examined = [...new Set([...components.flatMap((c) => [...(c.guarantees as Ref[]), ...(c.assumptions as Ref[])].map((r) => r.path)), ...flows.flatMap((f) => f.steps.map((s) => s.path))])];
  return { ok: true, problems, value: { summary, components, flows }, examined };
}

function checkHunt(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  const problems: string[] = [];
  const summary = str(value.summary, 1500);
  if (summary === "") return { ok: false, problems: ["summary is required"] };
  const mapFlows = ((ctx.accepted?.[STAGES.map]?.flows as Array<{ id: string }> | undefined) ?? []).map((f) => f.id);
  const gaps: Array<{ path?: string; reason: string }> = [];
  const flows: Array<Record<string, unknown>> = [];
  for (const f of list(value.flows)) {
    if (!isObj(f) || !mapFlows.includes(String(f.id)) || flows.some((x) => x.id === f.id)) continue;
    const state = f.state === "examined" ? "examined" : "pending";
    const reason = str(f.reason, 400);
    if (state === "pending") gaps.push({ reason: `flow ${String(f.id)} pending: ${reason || "no reason given"}` });
    flows.push({ id: f.id, state, ...(state === "pending" ? { reason: reason || "no reason given" } : {}) });
  }
  for (const id of mapFlows) if (!flows.some((f) => f.id === id)) gaps.push({ reason: `flow ${id} was not reported by the chain hunt` });
  const candidates = checkCandidates(value.candidates, ctx, problems, "cross-component", (c) => {
    const steps = list(c.steps)
      .filter(isObj)
      .map((s, i) => {
        const at = seenRef(s.path, s.line, ctx, problems, `chain step ${i + 1}`);
        return at ? { ...at, action: str(s.action, 300), output: str(s.output, 300) } : null;
      });
    const valid = steps.filter((s): s is Ref & { action: string; output: string } => s !== null);
    if (valid.length !== steps.length || valid.length < 2 || new Set(valid.map((s) => s.path)).size < 2) {
      problems.push("a chain is dropped: it needs at least two steps in two files, every one at a line this context read");
      return null;
    }
    const gap = str(c.gap, 500);
    if (gap === "") {
      problems.push("a chain is dropped: it needs the guarantee/assumption gap it exploits");
      return null;
    }
    const violated = (VIOLATIONS as readonly string[]).includes(String(c.violated)) ? String(c.violated) : "other";
    return { flow: str(c.flow, 20) || null, violated, gap, steps: valid };
  });
  return { ok: true, problems, value: { summary, flows }, candidates, examined: [...new Set(candidates.flatMap((c) => ((c.details?.steps as Ref[]) ?? []).map((s) => s.path)))], gaps };
}

function checkChallenge(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  return checkVerdict(value, ctx, (problems) => {
    const total = ((ctx.candidate?.details?.steps as unknown[]) ?? []).length;
    const steps = list(value.steps)
      .filter(isObj)
      .map((s) => ({ index: typeof s.index === "number" ? s.index : 0, established: s.established === true, note: str(s.note, 300) }))
      .filter((s) => s.index >= 1 && s.index <= total);
    if (value.confirmation === "confirmed") {
      const missing = Array.from({ length: total }, (_, i) => i + 1).filter((i) => !steps.some((s) => s.index === i && s.established));
      if (missing.length > 0) problems.push(`a confirmed chain needs every step established; step(s) ${missing.join(", ")} are not`);
    }
    return { steps };
  });
}

function brief(input: ModuleBriefInput): string | null {
  const facts = factsOf(input.inputs);
  if (input.stage.id === STAGES.map) return briefJson("Components and the relative imports between them (host-found; not exhaustive: dynamic loading, services and data stores are not seen):", facts);
  if (input.stage.id === STAGES.hunt) return briefJson("Boundary map (host-validated):", input.accepted[STAGES.map] ?? null);
  return null;
}

function finalize(input: ModuleFinalizeInput): ModuleFinalizeOutput {
  const hunt = input.accepted[STAGES.hunt] as { flows?: Array<Record<string, unknown>> } | undefined;
  const doc = {
    schemaVersion: 1,
    kind: "semantic-cross-component",
    method: CROSS_COMPONENT_METHOD,
    generatedAt: input.now.toISOString(),
    facts: factsOf(input.inputs),
    map: input.accepted[STAGES.map] ?? null,
    flows: hunt?.flows ?? [],
    chains: input.candidates.map((c) => ({ id: c.id, title: c.title, path: c.path, line: c.line, severity: c.severity, status: c.status, details: c.details ?? null, validation: c.validation })),
  };
  const pending = (hunt?.flows ?? []).filter((f) => f.state === "pending");
  return {
    files: [{ path: CHAINS_FILE, content: `${JSON.stringify(doc, null, 2)}\n` }],
    gaps: pending.map((f) => ({ code: "FLOW_PENDING", reason: `flow ${String(f.id)}: ${String(f.reason ?? "pending")}` })),
    report: { components: doc.facts.components.length, flows: (hunt?.flows ?? []).length, chains: input.candidates.length, confirmed: input.candidates.filter((c) => c.status === "confirmed").length },
  };
}

const OBJECTIVE =
  "Find violations that only exist across components: a sequence of actions, each allowed where it happens, that combines into a privilege, tenant or state violation because one component relies on a guarantee another component does not give. Map what each component guarantees and assumes before hunting; evidence every step of a chain at a line you read; never assume a downstream effect.";

export function crossComponentModule(): InvestigationModule {
  return {
    id: CROSS_COMPONENT_MODULE_ID,
    version: "1",
    title: "Cross-component reasoning",
    objective: OBJECTIVE,
    provenance: { origin: "original JGates method", license: "JGates" },
    minimum: { exploreCalls: 2, reserveCalls: 1 },
    applicability: (input): ModuleApplicability => {
      const facts = componentFacts(input);
      if (facts.components.length < 2 || facts.edges.length === 0) {
        return { applicable: false, code: "CROSS_COMPONENT_SINGLE_COMPONENT", missing: "multi-component flow", reason: `cross-component reasoning needs at least two components with a relation between them: the readable scope has ${facts.components.length} code component(s) and ${facts.edges.length} relative import(s) across components` };
      }
      return { applicable: true, inputs: { facts }, record: { components: facts.components.length, edges: facts.edges.length } };
    },
    stages: [
      { id: STAGES.map, label: "Boundary map", role: "explore", required: true, contexts: "once", instructions: "Read the components and their relations. For each component state the guarantees it gives its callers (what it checks, normalizes, scopes to a tenant or principal) and the assumptions it makes about its inputs and callers, each at a line you read, naming the component it relies on. Then list the multi-step flows a lower-trust principal can drive across components (at least two steps in two files). Report no candidates here.", artifact: { kind: "custom", shape: MAP_SHAPE, validate: checkMap } },
      { id: STAGES.hunt, label: "Chain hunt", role: "explore", required: true, contexts: "once", instructions: "For each mapped flow, compare the exact guarantee each step produces with what the next step assumes. Report a chain as a candidate only when every step is at a line you read, each step's output is a concrete prerequisite of the next, and the result is a privilege, tenant or state violation; name the gap. Report every flow as examined or pending with the reason.", artifact: { kind: "custom", shape: HUNT_SHAPE, validate: checkHunt } },
      { id: STAGES.challenge, label: "Chain challenge", role: "validate", required: true, contexts: "per-candidate", instructions: "You challenge one chain another context reported; you are free to reject it. Re-establish every step independently by reading its code: is the action allowed for that principal, does it produce the claimed output, does the next component really accept it without the guarantee? Report each step as established or not. Confirm only when every step is established; reject citing the code that breaks the chain; otherwise answer needs-validation.", artifact: { kind: "custom", shape: CHALLENGE_SHAPE, validate: checkChallenge } },
    ],
    brief,
    finalize,
  };
}
