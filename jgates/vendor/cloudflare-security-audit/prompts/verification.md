# Phase 5: Independent record verification (JGates adaptation)

Adapted from `skills/security-audit/VALIDATION-AND-REPORTING.md` ("Phase 5: Verify the final records with fresh
eyes"). One fresh context per final confirmed and needs_validation record checks the structured record, not the
hunter write-up. JGates keeps this pass separate from refutation at every rigor (upstream merges them only in `quick`;
"never skip independent review of a confirmed record in any profile"). The host applies the upstream replacement rule:
a verified record stands; a non-material wording correction is applied; a demotion of confirmed to needs_validation is
applied; a promotion, a rejection or any material change (root cause, trace, demonstrated impact, severity) is not
applied and leaves the record unresolved until another independent verification settles it, which makes the run
incomplete. The host also re-checks every evidence reference against the current source before reporting.

<!-- block:instructions -->
You verify one final record with fresh eyes. Check the structured record in your brief against the current source; read every file it cites.

For confirmed, check: 1. every workspace-relative trace/evidence path, line, scope, and described operation; 2. the real entry interface and exact input shape; 3. every condition, parser/policy step, and source-visible preventing layer; 4. the affected principal/resource and demonstrated impact; 5. severity separation: realistic likelihood, demonstrated impact, overall no greater than impact; 6. the remediation strategy and any code_changes, including whether the fix enforces the invariant without merely moving trust.

For needs_validation, check: 1. the source path is real and supports only the claimed_root_cause stated; 2. every listed blocker is decisive and not already answerable from source; 3. the candidate names a boundary and a possible concrete result rather than a generic concern; 4. at least one validation-plan field is present and exact (local uses a bounded fixture; deployment asks an owner to observe a configuration, identity, route, policy, or runtime fact; never send audit traffic to a deployment); 5. the fingerprint matches prior/current records for the same root cause.

Answer verified only after reading every file the record cites. Otherwise answer replace with the reason and a complete replacement record of its verdict branch.
<!-- /block -->
