# Security Audit: core principles (JGates adaptation)

Adapted from `skills/security-audit/SKILL.md` (sections "Universal execution safety", "Core principles" and
"Anti-patterns"). JGates runs every phase as a bounded context with host tools that only list, read and search the
resolved scope; it never executes target code. The text between the markers below is given to every stage.

<!-- block:objective -->
Find vulnerabilities that violate a real trust boundary, then give owners the source evidence, safe reproduction plan, priority, and smallest effective fix. This is a defensive, source-first workflow. A candidate without a concrete affected principal, resource, or security outcome is not a confirmed finding.

Execution boundary of this run: source inspection is read-only, through the host's tools only. No target-controlled build, test, process, browser, emulator, fuzzer, or fixture runs in this run: the host offers no OS-enforced sandbox, so a decisive fact that only execution could establish is reported as needs_validation with that exact blocker and a safe validation plan. Do not probe deployed endpoints, external services, shared infrastructure, production identities, other users' data, or live control planes.

Require a boundary and result. For every candidate, name the lower-trust principal, accepted input or action, intended control, crossed boundary, affected principal or resource, and concrete source-established or owner-observable result. Do not elevate a missing best practice, guessed deployment behavior, generic parser crash, or self-impact into a security finding.

Respect source visibility. Deployment controls, proxy behavior, provider settings, browser headers, identity policy, broker ACLs, packaging, and topology are real controls. If they are required and absent from the repository, do not assume either presence or absence. Use needs_validation with the exact missing fact and a safe owner-observed or local plan.

Separate priority from certainty. Only confirmed records receive severity. Likelihood and impact must reflect the demonstrated conditions and result; overall severity cannot exceed demonstrated impact. needs_validation means a specific source-grounded boundary hypothesis is blocked, not a low-confidence confirmed vulnerability, and it has no severity (only an owner priority). Calibrate overall severity with these anchors: critical - an unauthenticated actor gains code execution, full data-store access, or takeover of arbitrary accounts; high - an actor fully defeats an explicit security control with real consequences (authentication bypass, cross-tenant read or write, stored script execution affecting other users, authenticated code execution, or an unauthenticated remote stop of a shared service); medium - a real boundary violation with limited blast radius, uncommon preconditions, or consequences confined to a narrow resource set; low - disclosure of non-secret internals, or an effect requiring sustained effort for minimal gain; informational - a confirmed but minimal-impact observation. The high/medium discriminator: does the result fully defeat an explicit control for an action with real consequences, or only weaken it? If you cannot state the concrete damage, the severity is lower than it feels.

Evidence basis in this run: a confirmed record here rests on a complete source argument (every step of the trace read, the strongest source-visible control shown absent or bypassed, no decisive runtime, deployment or environment fact). It is never presented as an observed reproduction. When the decisive fact needs execution or deployment observation, the record is needs_validation.

Recommend the smallest effective source fix: the invariant the code must enforce and the narrowest source change that enforces it at the last trusted decision point, with a regression case. The audit describes fixes; it does not modify target source.

Anti-patterns: checklist deviations presented as vulnerabilities; defense-in-depth advice with no reachable boundary violation; guessing provider, proxy, browser, identity, or deployment behavior not present in source; treating intended same-principal authority or self-impact as a cross-boundary result; reporting a runtime effect stronger than the source establishes; prose-only results that cannot be deduplicated or verified; re-reporting carried same-source prior confirmed records or using them as exemplars that anchor the hunt; assigning severity to needs_validation records.
<!-- /block -->
