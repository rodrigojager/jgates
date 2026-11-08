# JGates: the Semantic methods

A Semantic method is a reviewed way of investigating the code with a model. List them, with their availability:

```bash
jgates semantic methods
jgates semantic plan --method general-review
```

`--method <id>` picks one; `--purpose general-review` and `--purpose security` pick the default method for that purpose.
A method that needs an input the run does not have (a patch, a lockfile) is reported `unavailable` with a reason code
(`METHOD_NOT_APPLICABLE` and the method's own code), spends no model call and is never shown as favorable.

## The nine methods

| Method | Purpose | What it does |
| --- | --- | --- |
| `general-review` | general | Six dimensions (correctness, tests, security, maintainability, architecture, performance): evidence planning, hunting and a challenge stage; the host decides what was examined and what is pending. |
| `security-audit` | security | The Cloudflare security-audit baseline: reconnaissance, coverage planning, hunting, coverage critic, per-candidate refutation and verification. |
| `differential-review` | on request | Reviews a change (an incremental scope) for what it breaks. Adapted from Trail of Bits. |
| `variant-analysis` | on request | Starts from a known finding and looks for the same root cause elsewhere. Adapted from Trail of Bits. |
| `insecure-defaults` | on request | Looks for fail-open and insecure default configurations. Adapted from Trail of Bits. |
| `cross-component` | on request | Reasons across component boundaries and groups findings that share a root cause. Original JGates work. |
| `property-reasoning` | on request | States the invariants of boundary, authorization and parsing code, argues each against the code and proposes property tests. Original JGates work. |
| `post-patch-validation` | on request | Does the reproducer fail before a patch and pass after it? The host runs it, not the model. Original JGates work. |
| `supply-chain-assessment` | on request | Interprets the install-time and provenance signals of the lockfiles. Original JGates work. |

## Sources, pins and attribution

- The security audit adapts [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) pinned
  at `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (MIT, Cloudflare, Inc.), vendored in `jgates/vendor/cloudflare-security-audit`.
- Differential review, variant analysis and insecure defaults adapt [trailofbits/skills](https://github.com/trailofbits/skills)
  pinned at `e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff` (CC-BY-SA-4.0, Trail of Bits), vendored in
  `jgates/vendor/trailofbits-skills`. The adapted `method.md` files are CC BY-SA 4.0 too (ShareAlike); each pack carries its
  license, a `NOTICE.md` with the modifications and a `jgates-pack.json` record.
- The licenses and the rest of what ships are listed in `THIRD_PARTY_NOTICES.md`. `jgates tools distribution` checks every
  shipped pack against its record.

```bash
jgates tools distribution
```

## What the methods can and cannot claim

- A confirmed finding from a source-reading method carries the evidence basis `source-argument`: the model argued it from
  the code. It is never presented as reproduced.
- No method executes project code. The one exception is `post-patch-validation`, which runs the reproducer and nearby
  tests in isolated before and after fixtures under a sandbox that cannot write, use the network or start processes;
  only that method may claim `reproduced` or `fixed`, and only when the run executed.
- Repository text, scanner output and imported reports are untrusted data. File access goes through a host guard that
  refuses exclusions and paths outside the scope; every refusal is recorded and lowers the affected verdicts to
  `needs-validation`.
- `property-reasoning` and `post-patch-validation` may propose regression tests. They are applied only by
  `jgates regressions incorporate <id> --approve`.
