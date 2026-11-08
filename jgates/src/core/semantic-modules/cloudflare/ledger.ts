// The deterministic coverage ledger of the security audit, adapted from the upstream RECONNAISSANCE.md ("Deterministic
// coverage ledger") and validate-coverage-ledger.cjs. The host derives every coverage_id from canonical references
// without lossy slugs, refuses duplicate IDs and identity collisions, and enforces the state table; the models only
// propose units and dispositions. JGates adds the `unsupported` status (a class this source-only run cannot examine)
// and a derived `state` for its contracts: examined, pending, unsupported, not-applicable or out-of-scope.

export const QUICK_SUBSYSTEM = "profile/quick/all-in-scope-subsystems";
export const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const PLAN_STATUSES = ["planned", "not_applicable", "out_of_scope", "unsupported"] as const;
export type UnitStatus = "planned" | "not_applicable" | "out_of_scope" | "unsupported" | "deferred" | "in_progress" | "blocked" | "covered" | "candidate";
export type UnitState = "examined" | "pending" | "unsupported" | "not-applicable" | "out-of-scope";

export const PRIOR_STATUSES = [
  "new",
  "prior_confirmed_same_source",
  "prior_confirmed_changed_source",
  "prior_needs_validation",
  "prior_deferred",
  "prior_blocked",
  "prior_out_of_scope",
  "prior_covered_same_source",
  "prior_covered_changed_source",
  "prior_rejected_claim_changed",
  "none",
] as const;

export interface CanonicalRefs {
  surface: string;
  boundary: string;
  subsystem: string;
  attack_class: string;
  lifecycle?: string;
}

export interface LedgerCheck {
  agent_id: string;
  reviewed_paths: string[];
  invariant: string;
  method: "source";
  result: string;
  artifact: null;
}

export interface LedgerUnit {
  coverage_id: string;
  canonical_refs: CanonicalRefs;
  surface: string;
  boundary: string;
  subsystem: string;
  attack_class: string;
  lifecycle?: string;
  starting_paths: string[];
  ordinary_attack_class_block: string | null;
  selected_companion_blocks: string[];
  excluded_blocks: Array<{ block: string; reason: string }>;
  prior_status: (typeof PRIOR_STATUSES)[number];
  attempts: Array<Record<string, unknown>>;
  wave: number;
  status: UnitStatus;
  agent_id: string | null;
  reviewed_paths: string[];
  local_checks: LedgerCheck[];
  result_fingerprints: string[];
  unresolved: string[];
  /** JGates: derived from status. */
  state: UnitState;
  /** Bookkeeping outside the semantic fields. */
  priority?: number;
  priority_rationale?: string;
  hardening?: string[];
  carried?: { fingerprint: string; verdict: string; baselineRunId: string };
  decisions?: Array<{ fingerprint: string; state: string; refutedBy: string | null; verifiedBy: string | null; outcome: string | null }>;
  added_by?: "coverage-planning" | "prior-run" | "coverage-critic" | "hunting";
}

/** Problems of one canonical reference (upstream: NFC, valid scalars, visible, no control/format chars, trimmed). */
export function refProblems(ref: unknown): string | null {
  if (typeof ref !== "string" || ref === "") return "a canonical reference is empty";
  if (ref !== ref.trim()) return "a canonical reference has surrounding whitespace";
  if (ref.normalize("NFC") !== ref) return "a canonical reference is not Unicode NFC";
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{FFFD}]/u.test(ref) || /\p{Cs}/u.test(ref)) return "a canonical reference has a control, format or separator character";
  if (!/[^\s]/u.test(ref)) return "a canonical reference has no visible content";
  return null;
}

/** RFC 3986 percent encoding of the UTF-8 bytes: only A-Z a-z 0-9 - . _ ~ stay; uppercase %HH for the rest. */
export function encodeRef(ref: string): string {
  let out = "";
  for (const byte of Buffer.from(ref, "utf8")) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** surface::boundary::subsystem::attack_class[::lifecycle], each encoded. */
export function coverageId(refs: CanonicalRefs): string {
  const parts = [refs.surface, refs.boundary, refs.subsystem, refs.attack_class].map(encodeRef);
  if (refs.lifecycle) parts.push(encodeRef(refs.lifecycle));
  return parts.join("::");
}

export function stateOf(status: UnitStatus): UnitState {
  if (status === "covered" || status === "candidate") return "examined";
  if (status === "unsupported") return "unsupported";
  if (status === "not_applicable") return "not-applicable";
  if (status === "out_of_scope") return "out-of-scope";
  return "pending";
}

/** The semantic tuple of a unit (what a duplicate must agree on). */
export function semanticKey(u: Pick<LedgerUnit, "canonical_refs" | "starting_paths" | "selected_companion_blocks">): string {
  return JSON.stringify([u.canonical_refs, [...u.starting_paths].sort(), [...u.selected_companion_blocks].sort()]);
}

/** The state-table and identity checks of the ledger (upstream validate-coverage-ledger.cjs, adapted). */
export function validateLedger(units: readonly LedgerUnit[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const u of units) {
    const where = u.coverage_id;
    if (ids.has(u.coverage_id)) problems.push(`${where}: duplicate coverage_id`);
    ids.add(u.coverage_id);
    if (coverageId(u.canonical_refs) !== u.coverage_id) problems.push(`${where}: coverage_id does not match its canonical references`);
    const empty = u.reviewed_paths.length === 0 && u.local_checks.length === 0;
    const owner = u.agent_id;
    if (owner !== null && !AGENT_ID.test(owner)) problems.push(`${where}: agent_id is not canonical`);
    switch (u.status) {
      case "planned":
        if (owner !== null || !empty || u.result_fingerprints.length > 0 || u.unresolved.length > 0) problems.push(`${where}: a planned unit has no owner and no evidence`);
        break;
      case "not_applicable":
      case "out_of_scope":
      case "deferred":
      case "unsupported":
        if (owner !== null || !empty || u.result_fingerprints.length > 0 || u.unresolved.length === 0) problems.push(`${where}: a ${u.status} unit has no owner, no evidence and a reason`);
        break;
      case "in_progress":
        if (owner === null || !empty || u.result_fingerprints.length > 0 || u.unresolved.length > 0) problems.push(`${where}: an in_progress unit has an owner and no evidence`);
        break;
      case "blocked":
        if (owner === null || u.reviewed_paths.length === 0 || u.local_checks.length === 0 || u.result_fingerprints.length > 0 || u.unresolved.length === 0) problems.push(`${where}: a blocked unit has owned partial evidence and a blocker`);
        break;
      case "covered":
        if (owner === null || u.reviewed_paths.length === 0 || u.local_checks.length === 0 || u.result_fingerprints.length > 0 || u.unresolved.length > 0) problems.push(`${where}: a covered unit has owned evidence and nothing unresolved`);
        break;
      case "candidate":
        if (owner === null || u.reviewed_paths.length === 0 || u.local_checks.length === 0 || u.result_fingerprints.length === 0) problems.push(`${where}: a candidate unit has owned evidence and linked fingerprints`);
        break;
    }
    if (u.local_checks.length > 0) {
      const union = new Set(u.local_checks.flatMap((c) => c.reviewed_paths));
      const unit = new Set(u.reviewed_paths);
      if (union.size !== unit.size || [...union].some((p) => !unit.has(p))) problems.push(`${where}: reviewed_paths is not the union of its checks' paths`);
      for (const c of u.local_checks) {
        if (!AGENT_ID.test(c.agent_id) || c.reviewed_paths.length === 0) problems.push(`${where}: every check has a canonical owner and reviewed paths`);
        if (c.method !== "source" || c.artifact !== null) problems.push(`${where}: this run records source checks only`);
      }
    }
    if (u.state !== stateOf(u.status)) problems.push(`${where}: state does not match status`);
  }
  const sorted = [...units].map((u) => u.coverage_id);
  if (sorted.join("\n") !== [...sorted].sort().join("\n")) problems.push("units are not sorted by coverage_id");
  return problems;
}

/** A fresh unit with empty live evidence. */
export function seedUnit(fields: Omit<LedgerUnit, "coverage_id" | "attempts" | "wave" | "agent_id" | "reviewed_paths" | "local_checks" | "result_fingerprints" | "state" | "unresolved"> & { unresolved?: string[] }): LedgerUnit {
  const status = fields.status;
  return {
    ...fields,
    coverage_id: coverageId(fields.canonical_refs),
    attempts: [],
    wave: 1,
    agent_id: null,
    reviewed_paths: [],
    local_checks: [],
    result_fingerprints: [],
    unresolved: fields.unresolved ?? [],
    state: stateOf(status),
  };
}

export const sortUnits = (units: LedgerUnit[]): LedgerUnit[] => units.sort((a, b) => (a.coverage_id < b.coverage_id ? -1 : a.coverage_id > b.coverage_id ? 1 : 0));
