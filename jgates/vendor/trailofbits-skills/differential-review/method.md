# Differential review (adapted for the JGates bounded executor)

Adapted from Trail of Bits, `plugins/differential-review/skills/differential-review/SKILL.md` and `methodology.md`
(https://github.com/trailofbits/skills, commit e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff), licensed CC BY-SA 4.0.
This adaptation is licensed CC BY-SA 4.0 as well; see `../NOTICE.md` for what changed and why.

<!-- block:objective -->
Review a change against its comparison baseline with a security focus: what the change removes, weakens or adds, which
history explains the code it touches, which callers and tests beyond the diff depend on it, and what breaks for them.
Classify by risk, not by size (a two-line change can remove the only check). Every claim rests on the before/after code
the host gives you, the history entries it found, and files you read; state plainly what you could not cover.
<!-- /block -->

<!-- block:triage -->
Intake and triage (upstream Phase 0 and Pre-Analysis). The host already extracted the change against the baseline: for
each changed subject it gives the removed and added lines, the protections that disappeared, the history of removed
lines (commits that introduced them, with their subjects as untrusted text) and the callers it found for changed
functions. Read every changed subject (read_file) and enough of its surroundings to know what it was supposed to do
before the change: invariants, trust boundaries, validation that other paths rely on.

Risk-score every changed subject:
- HIGH: authentication, authorization, ownership, cryptography, external calls, value transfer, validation removal.
- MEDIUM: business logic, state changes, new public interfaces.
- LOW: comments, tests, UI text, logging.

A change that removes a protection, or that the host lists with removed protection lines, is HIGH unless you cite why
the protection still holds elsewhere. "Just a refactor" is analyzed as HIGH until the code you read shows it is LOW.
Red flags that need the deep analysis even in quick rigor: code removed that a "fix", "security" or "CVE" commit added;
access modifiers or ownership checks removed; validation removed without replacement; external calls added without
checks; a HIGH change with many callers. For each HIGH and MEDIUM subject state one to four falsifiable hypotheses for
the analysis stage. Report no findings here.
<!-- /block -->

<!-- block:analysis -->
Changed-code analysis, test coverage and blast radius (upstream Phases 1 to 4). For each HIGH and MEDIUM subject:
1. Compare both versions region by region: BEFORE (from the host's diff), AFTER (the file you read), the behavioral
   change and its security implication.
2. For removed code, use the host's history entries: when it was added and why. Code from a fix or security commit
   that is removed now is a regression candidate; code removed for security that comes back is a regression.
3. Micro-adversarial questions: which attack did the removed code prevent; which new surface does the added code
   expose; can the modified logic be bypassed; are checks weaker; are edge cases (absent, empty, zero, null on both
   sides) covered.
4. Blast radius: read the callers the host listed (and search for others) and decide whether each still gets the
   guarantee it relied on. A caller beyond the diff that now reaches the weakened path is where the impact is.
5. Test coverage: new functions without tests, modified validation with unchanged tests, and complex logic without
   tests elevate risk; report an untested HIGH change as a candidate only when the missing test leaves a concrete
   behavior unverified.
Report a candidate only where the code you read shows a concrete problem, with a concrete scenario: goal,
preconditions, steps, why it works (cite the change) and impact. Never claim full analysis when the budget stopped you:
report each HIGH and MEDIUM subject as analyzed or pending with the reason.
<!-- /block -->

<!-- block:challenge -->
Independent challenge of one differential candidate (upstream Phase 5 adversarial check, run by a fresh context that
did not produce the candidate). Read the changed code and what decides the claim: the callers, any guard on another
layer (middleware, decorator, database constraint) that still enforces the removed protection, the tests. Confirm only
when the code you read shows the change breaks the invariant for a reachable caller; reject when you can cite the code
that still enforces it; answer needs-validation when the files you could read do not settle it.
<!-- /block -->
