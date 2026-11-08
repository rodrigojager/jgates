# Variant analysis (adapted for the JGates bounded executor)

Adapted from Trail of Bits, `plugins/variant-analysis/skills/variant-analysis/SKILL.md` and
`references/root-cause.md`, `references/searching.md`, `references/triage.md`, `references/reporting.md`
(https://github.com/trailofbits/skills, commit e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff), licensed CC BY-SA 4.0.
This adaptation is licensed CC BY-SA 4.0 as well; see `../NOTICE.md` for what changed and why.

<!-- block:objective -->
Find the other instances of a bug that an earlier, independently validated review already confirmed: the variants of
one root cause across the readable scope. One root cause usually has several manifestations, and they are rarely in the
module where the first one was found. Variants exist because of developer habits, copy-paste propagation, API misuse,
framework idioms and incomplete fixes; why a variant exists predicts where it hides.
<!-- /block -->

<!-- block:root-cause -->
Understand the original issue and calibrate (upstream steps 1 and 2). The host gives you the confirmed seed(s): where
they are, what the validation established and its evidence. Read each seed location (read_file). Extract the root
cause, why the code is wrong rather than what it does, by answering: which operation is dangerous; which data makes it
dangerous; what is missing (sanitization, validation, a bounds check, an ownership or null guard); which context
enables it. State it as "this exists because [UNTRUSTED DATA] reaches [DANGEROUS OPERATION] without [REQUIRED
PROTECTION]", or for a logic bug as the violated invariant.

Calibrate: give the exact match, the seed's own line in the current source that shows the root cause. If the current
source no longer shows it, say so: that seed is not reproduced and is not searched.

Then enumerate the expansion axes, the independent directions a variant could hide in: semantically related
identifiers that play the same role (an ownerId next to a userId), other shapes of the same mistake (an inverted
condition, a wrong default return, a short-circuit error), data-type edge cases (null on both sides, empty versus null,
zero versus null, empty collections) and documentation/code mismatches. Each axis must be independently searchable
(concrete identifiers or constructs, not a theme), non-overlapping and grounded: search the scope (search_files) and list
lead files where its constructs really occur. An axis with no grounded lead is not an axis.
<!-- /block -->

<!-- block:sweep -->
Sweep (upstream steps 3 and 4: the abstraction ladder). Search the whole readable scope, never only the module of the
seed: a variant in another folder is the normal case. For each axis climb one level at a time from the exact match:
level 0 exact text, level 1 variable names abstracted, level 2 surrounding structure abstracted, level 3 the security
property itself. After each change read the new matches and judge the noise; stop climbing when more than about half
of the matches are noise and record where you stopped. Read every file you report. Exclude test trees from candidates
unless the scope is a test tree.

Report each place where the same root cause appears to occur (report_candidate or in the artifact) with the axis and
level that found it and the protection that seems to be missing. Do not report the seed itself, and do not confirm
anything: an independent triage judges every variant. Report every axis as searched (the patterns you tried, how many
matches, how many were noise) or pending (why), including the patterns that failed.
<!-- /block -->

<!-- block:triage -->
Triage one variant (upstream step 5), in a fresh context that did not find it. Argue against the candidate: the
snippet alone is never enough. Read the surrounding function, its callers and the type of every value involved, and
look specifically for what makes it safe: a guard earlier in the function or in middleware or a decorator; a
sanitizer, validator or parameterized API between source and sink; a type constraint that makes the dangerous value
unreachable; a caller set that never supplies attacker-controlled input. It survives only if you looked for these and
did not find them. Having no caller today is not a refutation: unreachable but unprotected code is a real variant at a
lower severity; say what would make it reachable.

For a survivor establish: reachable (a path from an external entry point), controllable (an attacker influences the
value that makes it dangerous) and unprotected (the protection named in the root cause is genuinely absent). Test the
edge cases normal-path reasoning misses: null equality on both sides, a function whose behavior contradicts its name,
anonymous callers, empty versus null, boundary values. A candidate that has a different protection in place is a false
positive: record why it is safe, by reason, so the pattern can be refined. Attach a severity to every surviving
variant, separate from your confidence.
<!-- /block -->
