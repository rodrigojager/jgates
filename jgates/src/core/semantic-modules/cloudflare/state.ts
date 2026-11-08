// The parent's ledger updates (upstream HUNTING.md "Parent consolidation and ledger update" and "Coverage-critic
// waves", VALIDATION-AND-REPORTING.md ledger decisions): the host alone applies the hunting results, the critic's
// proposals and the candidate decisions to the coverage plan, so the ledger is always derived from validated artifacts.
import { contextAgentId, type Candidate } from "../../semantic-executor/index.js";
import { planOf, STAGE, type CriticValue, type HuntValue } from "./checks.js";
import { sortUnits, stateOf, type LedgerCheck, type LedgerUnit } from "./ledger.js";
import { recordFiles } from "./records.js";

export interface LedgerInputs {
  accepted: Readonly<Record<string, Record<string, unknown>>>;
  candidates: readonly Candidate[];
  /** States of the stages (the reason an unclosed unit is deferred). */
  stageState?: (id: string) => string | undefined;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function defer(u: LedgerUnit, reason: string): void {
  u.status = "deferred";
  u.agent_id = null;
  u.reviewed_paths = [];
  u.local_checks = [];
  u.result_fingerprints = [];
  u.unresolved = [reason];
  u.state = stateOf(u.status);
}

const fingerprintOf = (c: Candidate): string | null => {
  const r = (c.details as { record?: { fingerprint?: unknown } } | undefined)?.record;
  return typeof r?.fingerprint === "string" ? r.fingerprint : null;
};

/**
 * The current ledger: the plan, then the hunting wave (`afterHunt`), then the critic (`afterCritic`), then the
 * candidate decisions (`final`), each step applied by the host only.
 */
export function buildLedger(inputs: LedgerInputs, upTo: "afterHunt" | "afterCritic" | "final"): LedgerUnit[] {
  const plan = planOf(inputs.accepted);
  if (!plan) return [];
  const units = clone(plan.units);
  const byId = new Map(units.map((u) => [u.coverage_id, u]));
  const hunt = inputs.accepted[STAGE.hunt] as unknown as HuntValue | undefined;
  const huntState = inputs.stageState?.(STAGE.hunt);
  for (const r of hunt?.units ?? []) {
    const u = byId.get(r.coverage_id);
    if (!u || u.status !== "planned") continue;
    u.status = r.disposition;
    u.agent_id = hunt!.agent;
    u.local_checks = clone(r.checks);
    u.reviewed_paths = [...r.reviewed_paths];
    u.result_fingerprints = [...r.candidate_fingerprints];
    u.unresolved = [...r.unresolved];
    u.state = stateOf(u.status);
    if (hunt!.hardening.length > 0) u.hardening = [...hunt!.hardening];
  }
  // Planned units nobody closed: deferred with the reason (carried units wait for their verifier).
  for (const u of units) {
    if (u.status !== "planned" || u.carried) continue;
    defer(
      u,
      !hunt
        ? huntState === "budget-exhausted"
          ? "budget_cannot_reserve_critics_and_validation: the hunting wave did not finish within its budget share"
          : `hunting_not_completed: the hunting stage ended ${huntState ?? "without a valid result"}`
        : "not_closed_by_hunting_wave: the hunting context returned no accepted result for this unit",
    );
  }
  if (upTo === "afterHunt") return sortUnits(units);
  const critic = inputs.accepted[STAGE.critic] as unknown as CriticValue | undefined;
  if (critic) {
    for (const id of critic.reassign_ids) {
      const u = byId.get(id);
      if (!u || !["blocked", "covered", "candidate"].includes(u.status)) continue;
      u.attempts.push({ wave: u.wave, status: u.status, agent_id: u.agent_id, reviewed_paths: u.reviewed_paths, local_checks: u.local_checks, result_fingerprints: u.result_fingerprints, unresolved: u.unresolved, reassignment_reason: `coverage critic ${critic.agent}: ${critic.summary || "reassigned"}` });
      u.wave += 1;
      defer(u, "single_wave_final_critic: reassigned by the coverage critic; the next run assigns a fresh owner");
    }
    for (const m of critic.missing_units) {
      if (byId.has(m.coverage_id)) continue;
      const added = clone(m);
      units.push(added);
      byId.set(added.coverage_id, added);
    }
  }
  if (upTo === "afterCritic") return sortUnits(units);
  // Candidate decisions: refutation and verification checks join the linked units with their own owners.
  for (const c of inputs.candidates) {
    const fp = fingerprintOf(c);
    if (!fp) continue;
    const linked = units.filter((u) => u.result_fingerprints.includes(fp) || u.carried?.fingerprint === fp);
    const refutedBy = c.validation ? c.validation.context : null;
    const verifiedBy = c.verification ? c.verification.context : null;
    for (const u of linked) {
      const checks: LedgerCheck[] = [];
      const add = (ctxLabel: string, paths: string[], invariant: string, result: string): void => {
        const ps = [...new Set(paths)].sort();
        if (ps.length > 0) checks.push({ agent_id: contextAgentId(ctxLabel), reviewed_paths: ps, invariant, method: "source", result, artifact: null });
      };
      const record = (c.details as { record?: Record<string, unknown> } | undefined)?.record;
      if (c.validation) add(c.validation.context, [...c.validation.evidence.map((e) => e.path), ...(record ? recordFiles(record) : [])], `independent refutation of ${fp}`, `${c.confirmation ?? c.status}: ${c.validation.reason}`);
      if (c.verification) add(c.verification.context, c.verification.evidence.map((e) => e.path), `fresh verification of ${fp}`, `${c.verification.outcome}: ${c.verification.reason}`);
      if (u.carried && u.status === "planned") {
        // A carried record's unit has no prior owner: its verifier becomes the owner and its re-check the first check.
        if (checks.length === 0) continue;
        u.status = "candidate";
        u.agent_id = checks[0]!.agent_id;
        u.result_fingerprints = [fp];
      }
      u.local_checks.push(...checks);
      u.reviewed_paths = [...new Set(u.local_checks.flatMap((k) => k.reviewed_paths))].sort();
      u.state = stateOf(u.status);
      (u.decisions ??= []).push({ fingerprint: fp, state: c.status, refutedBy, verifiedBy, outcome: c.verification?.outcome ?? null });
    }
  }
  for (const u of units) if (u.status === "planned") defer(u, u.carried ? "carried_record_not_reverified: the carried prior record received no current independent verification" : "not_assigned");
  return sortUnits(units);
}
