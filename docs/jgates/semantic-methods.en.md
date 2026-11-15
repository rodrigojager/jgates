# JGates: the Semantic methods

A Semantic method is a reviewed way of investigating the code with a model. List them, with their availability:

```bash
jgates semantic methods
jgates semantic plan --method general-review
```

`--method <id>` picks one (several, comma-separated, each runs as its own review). The screens offer the same choice as
checkboxes, General review checked by default. `--purpose general-review` and `--purpose security` remain as a shortcut
for `--method general-review` and `--method security-audit`; with both, the methods win. A method that needs an input the run does not have (a patch, a lockfile) is reported `unavailable` with a reason code
(`METHOD_NOT_APPLICABLE` and the method's own code), spends no model call and is never shown as favorable.

## The ten methods

| Method | Selected | What it does |
| --- | --- | --- |
| `general-review` | by default | Six dimensions (correctness, tests, security, maintainability, architecture, performance): evidence planning, hunting and a challenge stage; the host decides what was examined and what is pending. |
| `security-audit` | on request | The Cloudflare security-audit baseline: reconnaissance, coverage planning, hunting, coverage critic, per-candidate refutation and verification. |
| `differential-review` | on request | Reviews a change (an incremental scope) for what it breaks. Adapted from Trail of Bits. |
| `variant-analysis` | on request | Starts from a known finding and looks for the same root cause elsewhere. Adapted from Trail of Bits. |
| `insecure-defaults` | on request | Looks for fail-open and insecure default configurations. Adapted from Trail of Bits. |
| `cross-component` | on request | Reasons across component boundaries and groups findings that share a root cause. Original JGates work. |
| `property-reasoning` | on request | States the invariants of boundary, authorization and parsing code, argues each against the code and proposes property tests. Original JGates work. |
| `post-patch-validation` | on request | Does the reproducer fail before a patch and pass after it? The host runs it, not the model. Original JGates work. |
| `supply-chain-assessment` | on request | Interprets the install-time and provenance signals of the lockfiles. Original JGates work. |
| `confirm-by-reproduction` | only when you ask, after a run | Tries to reproduce the `needs-validation` findings of an earlier run with a test that runs in a container. Original JGates work. |

### Confirm by reproduction

The tenth method starts from a finished Semantic run of a method that reads source code and tries to settle its `needs-validation` findings by execution. Nothing reproduces unless you ask: no profile, template or default turns it on. On the Semantic result each such finding has **Try to reproduce** and the list has **Try to reproduce all (N)**; the terminal does the same:

```bash
jgates semantic run --method confirm-by-reproduction --from <sem_...> [--finding C1]
```

- The cost is shown before anything starts: how many findings it will try, the most model calls it may spend (the budget of the run), and that it runs the project's tests in a container without network.
- One context per finding writes a single test in the project's test framework (pytest or `node:test`) that fails while the defect exists. The host, not the model, places it in a copy of the project and runs it in an ephemeral container of the tools image: no network, no root, a read-only tree and limits on memory, processes and time. A second, fresh context judges whether the failure is the defect the finding describes, a defect of the test or the environment.
- A finding is **confirmed by execution** (evidence basis `execution`) only when the test ran, failed, and the judgment attributes the failure to the defect. The earlier run is never rewritten: its result shows the finding as confirmed, with a link to the reproduction run, the test and its masked output.
- Anything else (the test passed, did not load, was refused, the environment failed, the budget ended) leaves the finding `needs-validation` and shows "reproduction attempted" with the reason. **A failed reproduction never rejects a finding and never lowers its severity.**
- A test that reproduced becomes a regression test proposal, applied only by `jgates regressions incorporate <id> --approve`.
- It is not applicable, with a reason code and no model call, when there is no container engine or tools image, when the dependencies of the finding's component are not prepared (`jgates deps prepare`), when no supported runner (pytest, `node:test`) runs the finding's file (`TEST_RUNNER_NOT_SUPPORTED`; Jest, Vitest, `go test`, `cargo test` and `dotnet test` are not supported yet) or when the earlier run has no `needs-validation` finding. The screen then shows the action disabled with the reason.
- It is never part of `jgates ci`, and the Quality decision is untouched.

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
- No method executes project code on the host. Two methods run tests, always in containers of the tools image without
  network (a read-only tree, no root, limits on memory, processes and time): `post-patch-validation` runs the reproducer
  and nearby tests in isolated before and after fixtures (`jgates regressions validate` runs a proposed test the same
  way), and `confirm-by-reproduction` runs one test per finding on the current code. Only those two may claim
  `reproduced`, `fixed` or the evidence basis `execution`, and only when the run executed. Without a usable container
  engine they are not applicable and nothing is claimed.
- Repository text, scanner output and imported reports are untrusted data. File access goes through a host guard that
  refuses exclusions and paths outside the scope; every refusal is recorded and lowers the affected verdicts to
  `needs-validation`.
- `property-reasoning`, `post-patch-validation` and `confirm-by-reproduction` may propose regression tests. They are applied only by
  `jgates regressions incorporate <id> --approve`.
- The security audit's coverage ledger feeds the [ASVS coverage map](asvs-coverage.en.md): a requirement is examined by
  it only when units of its attack-class block were examined in that run, always with the basis "AI review of the
  source", counted apart from the deterministic checks. A unit that a model proposed as not applicable never makes a
  requirement not applicable.
