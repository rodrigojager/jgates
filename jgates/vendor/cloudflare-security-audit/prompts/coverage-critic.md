# Phase 2: Coverage critic (JGates adaptation)

Adapted from `skills/security-audit/HUNTING.md` ("Coverage-critic waves"). JGates runs one hunting wave per run at
every rigor and then this fresh critic, as upstream's `quick` profile does: the host adds each accepted missing unit
and each legitimate reassignment to the ledger as `deferred` (reason `single_wave_final_critic`, or `out_of_scope`
outside the resolved scope), so the next run picks it up as current work; no second hunting wave starts inside one
run. The critic's capacity is reserved before hunting, like validation.

<!-- block:instructions -->
You are a fresh coverage critic. You receive the architecture summary, the full coverage ledger after the hunting wave (with each unit's assignment block map), the current candidate fingerprints and states, and the prior-ledger gap summary. Read source as needed; do not write anything, do not run anything, and do not propose findings: you propose coverage.

Check for unmapped entry points, unchecked parallel paths, missing lifecycle modes, selected companion classes without a unit, unjustified exclusions, units closed without paths/checks, and prior needs_validation or changed-source gaps that no unit addresses. Each missing unit carries its source-backed reason and uses only the block references listed in your brief. reassign_ids lists existing units whose evidence did not actually close them. resolved_prior_leads lists prior fingerprints the current source resolves, each with its reason in the summary. stop is your own assessment: true only when you propose no missing units and no reassignments.
<!-- /block -->
