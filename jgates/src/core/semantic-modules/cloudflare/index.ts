// The Cloudflare security-audit baseline as a JGates investigation module (method `security-audit`). It adapts the
// pinned upstream revision (see source.ts and jgates/vendor/cloudflare-security-audit/NOTICE.md) to the bounded
// executor: every phase is a stage with its own fresh context(s), every claim counts only from a host-validated
// artifact, and the parent's work (ledger updates, structured output, reports) is host code.
//
// Phase mapping (upstream -> JGates stage):
//   1 Reconnaissance (agents 1a-1d)            -> reconnaissance (explore, one context, four sections)
//   1 Parent synthesis + coverage ledger       -> coverage-planning (explore, one context; host derives IDs, seeds prior units)
//   2 Coverage-led hunting wave                -> hunting (explore, one context owning the planned units)
//   2 Post-wave / final coverage critic        -> coverage-critic (validate reserve, one fresh context; gaps deferred)
//   3 Candidate validation (fresh verifier)    -> refutation (validate, one fresh context per candidate)
//   4 Structured output + validators           -> host checks of every artifact and record, findings.json
//   5 Independent record verification          -> verification (validate, one fresh context per retained record) + host reference check
//   6 Target-neutral report                    -> host reporting (REPORT.md, FINDINGS-DETAIL.md, NEEDS-VALIDATION.md, agent context)
import type { InvestigationModule } from "../../semantic-executor/index.js";
import { moduleBrief } from "./brief.js";
import { checkCoveragePlan, checkCritic, checkHunting, checkReconnaissance, checkRefutation, checkVerification, CRITIC_SHAPE, HUNT_SHAPE, PLAN_SHAPE, RECON_SHAPE, REFUTE_SHAPE, STAGE, VERIFY_SHAPE } from "./checks.js";
import { finalizeAudit } from "./report.js";
import { loadVendored, UPSTREAM, type VendoredMaterial } from "./source.js";

export const SECURITY_AUDIT_METHOD = "security-audit";
export const SECURITY_AUDIT_MODULE_ID = "security-audit";

export { UPSTREAM, loadVendored, vendorDir } from "./source.js";
export { coverageId, encodeRef, validateLedger, QUICK_SUBSYSTEM } from "./ledger.js";
export { checkRecord, FINGERPRINT } from "./records.js";
export { STAGE as SECURITY_AUDIT_STAGES } from "./checks.js";
export { PHASES as SECURITY_AUDIT_PHASES } from "./report.js";
export { AUDIT_DIR, FINDINGS_FILE, LEDGER_FILE } from "./prior.js";

/** Builds the module from the vendored material (throws when the material is missing). */
export function securityAuditModule(material: VendoredMaterial = loadVendored()): InvestigationModule {
  const p = material.prompts;
  return {
    id: SECURITY_AUDIT_MODULE_ID,
    version: `1+${UPSTREAM.revision.slice(0, 7)}`,
    title: "Security audit (Cloudflare baseline)",
    objective: p.objective,
    provenance: { upstream: UPSTREAM.url, revision: UPSTREAM.revision, path: UPSTREAM.path, spdx: UPSTREAM.spdx, vendoredSha256: material.sha256 },
    // Upstream budget gate: reconnaissance, planning and one hunting call, plus the critic and one verifier reserved.
    minimum: { exploreCalls: 3, reserveCalls: 2 },
    stages: [
      { id: STAGE.recon, label: "Reconnaissance", role: "explore", required: true, contexts: "once", instructions: p.reconnaissance, artifact: { kind: "custom", shape: RECON_SHAPE, validate: checkReconnaissance(material) } },
      { id: STAGE.plan, label: "Coverage planning", role: "explore", required: true, contexts: "once", instructions: p["coverage-planning"], artifact: { kind: "custom", shape: PLAN_SHAPE, validate: checkCoveragePlan(material) } },
      { id: STAGE.hunt, label: "Hunting", role: "explore", required: true, contexts: "once", instructions: p.hunting, artifact: { kind: "custom", shape: HUNT_SHAPE, validate: checkHunting() } },
      { id: STAGE.critic, label: "Coverage critic", role: "validate", required: true, contexts: "once", instructions: p["coverage-critic"], artifact: { kind: "custom", shape: CRITIC_SHAPE, validate: checkCritic(material) } },
      { id: STAGE.refute, label: "Independent refutation", role: "validate", required: true, contexts: "per-candidate", instructions: p.refutation, artifact: { kind: "custom", shape: REFUTE_SHAPE, validate: checkRefutation() } },
      { id: STAGE.verify, label: "Fresh verification", role: "validate", required: true, contexts: "per-candidate", verify: true, instructions: p.verification, artifact: { kind: "custom", shape: VERIFY_SHAPE, validate: checkVerification() } },
    ],
    brief: (input) => moduleBrief(material, input),
    finalize: (input) => finalizeAudit(input),
  };
}
