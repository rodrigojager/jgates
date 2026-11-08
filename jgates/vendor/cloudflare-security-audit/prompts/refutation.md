# Phase 3: Independent candidate refutation (JGates adaptation)

Adapted from `skills/security-audit/VALIDATION-AND-REPORTING.md` ("Phase 3: Independently validate every candidate",
"Candidate-verifier prompt"). Every unique candidate goes to a fresh context that did not hunt it and receives only
the candidate, its linked coverage-unit checks, the architecture facts needed to interpret the path and the exact
relevant companion validation blocks; it never receives another verifier's conclusion. No target code runs in this
run, so the sandbox and promotion paragraphs of the upstream prompt are replaced by the source-only boundary.

<!-- block:instructions -->
You did not write this candidate. Try to refute it from repository source. Do not contact deployed endpoints or external/shared services, and run nothing: this run has no OS-enforced sandbox, so a decisive fact that only execution could establish stays a needs_validation blocker.

1. Verify every trace and evidence file, positive line number, scope, and description. Confirm the first entry is a real lower-trust entrypoint and the last is the claimed sink or boundary effect.
2. Reconstruct the strongest source-visible validation, identity, authorization, normalization, lifecycle, framework, and containment controls on the path: read the callers, wrappers, guards, sanitizers, middleware, query builders and configuration the path goes through, not only the lines the candidate cites. Where the architecture summary names a comparable baseline, note whether it shares the pattern, as calibration, never as grounds to dismiss.
3. For a proposed confirmed candidate, independently re-establish the complete source argument: inputs, interface shape, conditions, and the affected principal/resource. Do not infer a stronger result.
4. Verify that likelihood, impact, confidence, and the proposed source fix match only what the evidence establishes.
5. For a proposed needs_validation candidate, decide whether the blocker is genuinely outside source observation. If source refutes the trace, reject it. If the missing fact remains decisive, keep needs_validation and make the local and owner-observed plans exact and non-destructive.
6. Preserve the fingerprint for the same source-derived root cause across every state.

You can promote needs_validation to confirmed only after independently establishing the complete path. Demote a proposed confirmation to needs_validation when a specific deployment or runtime fact remains unknown. Use rejected when source, a visible control, missing meaningful impact, or an impossible prerequisite refutes the claim, and cite the control you read. needs_validation is never a parking place for a speculative idea. Every evidence reference you return points to a file and line you read in this context. A corrected record replaces the hunter's wording.
<!-- /block -->
