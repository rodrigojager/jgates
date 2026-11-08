// The material each security-audit context receives besides the scope (the host-validated outputs of earlier stages),
// in the order upstream's prompts give it: the hunter receives the architecture summary verbatim, its assigned units
// with their assignment block map, the exact selected blocks copied verbatim, the excluded blocks with reasons and the
// carried exclusions; the critic the ledger after the wave; a validator only its candidate, the linked unit checks,
// the architecture facts and the relevant companion validation blocks, never another validator's conclusion.
import type { ModuleBriefInput } from "../../semantic-executor/index.js";
import { recordOf, planOf, STAGE, type HuntValue } from "./checks.js";
import type { LedgerUnit } from "./ledger.js";
import { analyzePrior } from "./prior.js";
import { companionCompanions, type VendoredMaterial } from "./source.js";
import { buildLedger } from "./state.js";

const PROFILE: Record<string, string> = {
  quick: "quick: ledger units coarsened to surface x boundary x attack class (the host fixes the subsystem to the all-in-scope identity); one hunting wave and one final coverage critic.",
  standard: "standard: the workflow as written; one hunting wave per run, then the coverage critic (its accepted gaps are deferred to the next run).",
  deep: "deep: split units per subsystem and lifecycle mode; candidate refutation and final record verification stay separate fresh contexts.",
};

const json = (v: unknown): string => JSON.stringify(v, null, 1);

function blockCatalog(material: VendoredMaterial): string {
  const ordinary = [...material.blocks.values()].filter((b) => b.kind === "ordinary").map((b) => b.ref);
  const lines = ["Block references you may use (exact):", `  ordinary: ${ordinary.join(" | ")}`];
  for (const c of material.companions) {
    const refs = [...material.blocks.values()].filter((b) => b.file === c.file).map((b) => `${b.kind === "section" ? "[section] " : ""}${b.name}`);
    lines.push(`  ${c.file}#: ${refs.join(" | ")}`);
  }
  return lines.join("\n");
}

function companionGuide(material: VendoredMaterial): string {
  return ["Domain companion files and when to use them (select a companion only for a boundary reconnaissance found):", ...material.companions.map((c) => `- ${c.file} (${c.title}): ${c.whenToUse.replace(/\s+/g, " ")}`)].join("\n");
}

const unitBrief = (u: LedgerUnit): Record<string, unknown> => ({
  coverage_id: u.coverage_id,
  canonical_refs: u.canonical_refs,
  subsystem: u.subsystem,
  boundary: u.boundary,
  surface: u.surface,
  attack_class: u.attack_class,
  starting_paths: u.starting_paths,
  ordinary_attack_class_block: u.ordinary_attack_class_block,
  selected_companion_blocks: u.selected_companion_blocks,
  excluded_blocks: u.excluded_blocks,
  prior_status: u.prior_status,
});

export function moduleBrief(material: VendoredMaterial, input: ModuleBriefInput): string | null {
  const plan = planOf(input.accepted);
  const res = input.scope.resolution;
  const scopeLine = `Resolved scope: ${res.mode}; ${input.scope.toExamine.length} subject(s) to examine; inherited coverage ${res.inheritedCoverage.state} (${res.inheritedCoverage.code}): ${res.inheritedCoverage.message}`;
  const profile = `Run profile (rigor): ${PROFILE[input.rigor] ?? input.rigor}`;
  switch (input.stage.id) {
    case STAGE.recon:
      return [scopeLine, profile, companionGuide(material)].join("\n\n");
    case STAGE.plan: {
      const prior = analyzePrior({ runDir: input.runDir, scope: input.scope, rigor: input.rigor, readFile: input.readFile });
      const priorLines = [`Prior-run input: ${prior.message}`];
      for (const { unit, source } of prior.units) priorLines.push(`  unit ${unit.coverage_id}: prior ${unit.status}, source ${source}`);
      for (const { record, source } of prior.records) priorLines.push(`  record ${String(record.fingerprint)}: prior ${String(record.verdict)}, source ${source}`);
      return [
        scopeLine,
        profile,
        `Reconnaissance facts (host-validated; verify any fact you rely on):\n${json(input.accepted[STAGE.recon] ?? { note: "reconnaissance produced no accepted result" })}`,
        companionGuide(material),
        blockCatalog(material),
        priorLines.join("\n"),
      ].join("\n\n");
    }
    case STAGE.hunt: {
      if (!plan) return "No coverage plan was accepted: there is no assigned unit. Report only what you can attribute; the run is not complete.";
      const assigned = plan.units
        .filter((u) => u.status === "planned" && !u.carried)
        .sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9) || (a.coverage_id < b.coverage_id ? -1 : 1));
      const blocks = new Set<string>();
      for (const u of assigned) {
        if (u.ordinary_attack_class_block) blocks.add(u.ordinary_attack_class_block);
        for (const b of u.selected_companion_blocks) blocks.add(b);
      }
      const texts = [...blocks].sort().map((ref) => `--- ${ref} ---\n${material.blocks.get(ref)?.text ?? "(missing)"}`);
      return [
        scopeLine,
        profile,
        `architecture.md (verbatim):\n${plan.architecture}`,
        `Assigned coverage units, in priority order (every one appears exactly once in your units):\n${json(assigned.map(unitBrief))}`,
        `Selected attack-class blocks (verbatim):\n${texts.join("\n\n") || "(none)"}`,
        `Excluded blocks (do not duplicate this work):\n${json([...new Map(assigned.flatMap((u) => u.excluded_blocks).map((e) => [e.block, e])).values()])}`,
        `Carried and unchanged prior exclusions (do not re-report these roots):\n${json(plan.exclusions)}`,
        `Units owned elsewhere (do not duplicate): ${plan.units.filter((u) => u.carried).map((u) => u.coverage_id).join(", ") || "none"}`,
      ].join("\n\n");
    }
    case STAGE.critic: {
      if (!plan) return "No coverage plan was accepted.";
      const ledger = buildLedger({ accepted: input.accepted, candidates: input.candidates }, "afterHunt");
      const hunt = input.accepted[STAGE.hunt] as unknown as HuntValue | undefined;
      return [
        scopeLine,
        profile,
        `architecture.md (verbatim):\n${plan.architecture}`,
        `Coverage ledger after the hunting wave:\n${json(ledger.map((u) => ({ ...unitBrief(u), status: u.status, reviewed_paths: u.reviewed_paths, checks: u.local_checks.map((c) => ({ invariant: c.invariant, result: c.result, reviewed_paths: c.reviewed_paths })), result_fingerprints: u.result_fingerprints, unresolved: u.unresolved })))}`,
        `Current candidates: ${json(input.candidates.map((c) => ({ fingerprint: recordOf(c)?.fingerprint ?? null, title: c.title, state: c.status })))}`,
        `Uncovered boundaries the hunter returned: ${json(hunt?.uncovered ?? [])}`,
        `Prior-ledger gap summary: ${plan.prior.message}; units seeded from it: ${plan.units.filter((u) => u.added_by === "prior-run").map((u) => `${u.coverage_id} (${u.prior_status})`).join(", ") || "none"}`,
        blockCatalog(material),
      ].join("\n\n");
    }
    case STAGE.refute:
    case STAGE.verify: {
      const c = input.candidate;
      if (!c || !plan) return null;
      const ids = ((c.details as { coverage_ids?: unknown } | undefined)?.coverage_ids as string[] | undefined) ?? [];
      const ledger = buildLedger({ accepted: input.accepted, candidates: [] }, "afterCritic");
      const linked = ledger.filter((u) => ids.includes(u.coverage_id));
      const files = new Set<string>();
      for (const u of linked) for (const b of u.selected_companion_blocks) files.add(b.split("#")[0] ?? "");
      const validation = [...files].flatMap((f) => companionCompanions(material, f).filter((r) => r.endsWith("#Validation rules") || r.endsWith("#Core discipline"))).map((ref) => `--- ${ref} ---\n${material.blocks.get(ref)?.text ?? ""}`);
      const parts = [
        `Architecture facts (verbatim summary):\n${plan.architecture}`,
        `Linked coverage-unit checks:\n${json(linked.map((u) => ({ coverage_id: u.coverage_id, boundary: u.boundary, attack_class: u.attack_class, checks: u.local_checks.map((k) => ({ agent_id: k.agent_id, invariant: k.invariant, result: k.result, reviewed_paths: k.reviewed_paths })) })))}`,
        `Relevant companion validation blocks (verbatim):\n${validation.join("\n\n") || "(none selected)"}`,
      ];
      const carried = (c.details as { carried?: unknown } | undefined)?.carried;
      if (carried) parts.push(`This record is carried from a prior run (${json(carried)}); re-check it against the current source like any other candidate.`);
      return parts.join("\n\n");
    }
    default:
      return null;
  }
}
