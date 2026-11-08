# Phase 2: Coverage-led hunting (JGates adaptation)

Adapted from `skills/security-audit/HUNTING.md` ("Required hunter prompt", "Core hunting method", "Core validation
rules", "Structured hunter result"). Upstream assigns isolated hunters from the ledger; JGates runs one bounded hunting
context per run that owns the planned units of the resolved scope (the host lists them in priority order with their
assignment block map and the verbatim text of every selected block, as the required hunter prompt does). There is no
sandbox and no artifact promotion in this run, so every check is a source check (`method: "source"`, `artifact: null`)
and the promotion procedure block does not apply. Units the hunter does not close are recorded `deferred`; the
coverage critic runs next. The host checks every unit and candidate against the structured-result contract.

<!-- block:instructions -->
Your goal is to find source-grounded security invariant failures in your assigned coverage units, and you must end with exactly one JSON object matching the structured-result contract at the end of these instructions.

## Defensive vulnerability-finding method

Your goal is to find source-grounded security invariant failures and the smallest fix, not to expand harm beyond the boundary result. Stay within source review. Do not contact deployed endpoints, provider APIs, registries, identity systems, message brokers, shared services, or other users.

READ THE CODE AT DEPTH. Follow each assigned input through parsing, identity, authorization, normalization, state, derived copies, and the final sink. Read sibling, legacy, batch, retry, cancellation, migration, and error paths that produce the same effect. Compare sibling controls for equivalence, not only presence, and compare what one component guarantees with what the next component assumes.

WORK FROM A CONCRETE INVARIANT:
1. Name the lower-trust principal and starting capability.
2. Name the accepted value, action, state transition, or resource selector.
3. Locate the control that should reject, bind, isolate, limit, or revoke it.
4. Trace the exact source path after that decision.
5. Stop at the smallest affected dummy record, wrong return value, process-integrity effect, or locally observable shared-resource effect that the source establishes.
6. State a source-level change and regression case that enforce the invariant.

DEPTH BOUND: trace only paths that can reach your assigned boundary or whose guarantees that boundary relies on. Stop a line of investigation as soon as the invariant is settled either way, and record the result in your structured output (a covered, candidate, or blocked disposition, or an uncovered entry) instead of continuing to search.

TEST SAD PATHS AND DISAGREEMENTS. Check absent, empty, zero, negative, maximum, over-limit, duplicate, mixed encoding, stale, revoked, reordered, concurrent, partially migrated, failed dependency, and rollback state only where the interface accepts them. Compare canonicalization and units at every parser or policy handoff. For multi-step issues, treat each output as a prerequisite and do not assume a later boundary. If any prerequisite is not established, record a blocker.

When a proposed high or critical candidate reveals a reusable root cause, search paths owned by the assigned coverage IDs for lexical, structural, and logical variants. Consolidate the same root cause, but establish each variant's conditions and impact independently. Return a variant with no current coverage unit as uncovered.

NO EXECUTION IN THIS RUN. The host offers no OS-enforced sandbox, so no target-controlled build, test, process or fixture runs. When execution would settle the claim, return needs_validation with that exact blocker and the narrowest local check (an existing unit test, minimal function harness, dummy-tenant service call, small malformed fixture, deterministic race schedule, or locally rendered policy) in validation_plan.local. Never stress availability, invoke a live target, or use a real credential.

A deployment, browser, provider, broker, OS, proxy, package, secret, or identity fact outside source is not proof either way. If one such fact is decisive, return a needs_validation record with the exact missing observation and safe owner-observed check.

## Candidate gate

1. A candidate needs a complete workspace-relative source trace and evidence for the claimed root cause, including the strongest source-visible control.
2. A proposed confirmed record needs a complete source argument: meaningful impact across a stated boundary, complete conditions, and no visible preventing layer, with no decisive fact left to runtime, deployment or environment.
3. Do not strengthen a crash into code execution, ordinary work into shared availability, or a same-principal action into privilege gain.
4. If a required fact is not source-visible, use needs_validation. Name exact blockers; do not give it severity or speculative completion.
5. A missing best practice with no affected principal/resource is excluded or hardening, not a finding. A candidate disproved by source is not needs_validation.
6. Use the same source-derived fingerprint for the same root cause in every state. It must match ^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$ and must not include a line, wave, agent, severity, or verdict.
7. Return an empty candidate array when nothing survives these gates.

Scope is your coverage obligation, not permission to duplicate excluded work. If an unexpected different boundary appears, return it under uncovered so the parent creates a stable ledger unit. Do not re-report the carried prior exclusions listed in your brief.

Every assigned coverage ID appears exactly once in units. A covered unit needs nonempty reviewed_paths and checks, no unresolved fact, and no candidate. A candidate unit has the same evidence and is the only state that carries linked fingerprints. A blocked unit is a partial review with nonempty paths, checks, and unresolved facts but no fingerprint. Every reviewed path is a file you read in this context. A trace with several entries begins at entrypoint, ends at sink, and labels intermediate steps propagation.
<!-- /block -->
