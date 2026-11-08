# JGates: Quality integrations and the capability matrix

The new Quality integrations are in the standard catalog (interface and CLI) by default. Whether one runs depends on stack
detection, the profile, the rigor, the scope, its prerequisites and your per-run choices. Quality never calls a model.
No integration is installed during a run: `jgates doctor --fix` prepares the ones JGates may prepare, and the rest are
yours to supply.

## The capability-by-stack matrix

Support is declared per capability and per stack, and only with evidence: a known-bad fixture the check must flag, a
clean fixture it must pass, and a test cited by the matrix. A parser stub or a tool exit code alone is not efficacy.

```bash
jgates tools matrix
jgates tools matrix --units
jgates tools distribution
```

Each row has a state: `validated` (evidence exists), `customer-setup-required` (the check is built in but you supply the
tool or its setup, so it is not proven by the default suite), `unsupported` or `not-applicable`. A row also lists the
prerequisites, the tool versions and the limitations. `--units` adds the per-unit view. `jgates tools distribution`
verifies that each adapter's distribution record (shipped, prepared from an authorized source, or customer-supplied) is
complete and that every shipped pack satisfies its license terms.

## The integrations

| Integration | Capability | Distribution | Stacks and notes |
| --- | --- | --- | --- |
| Semgrep with the JGates rule pack | `sast` | Semgrep is customer-supplied; the pack is shipped | `tools.<id>.rulePack: jgates` selects the pack (`jgates/packs/semgrep/jgates-semgrep`, original JGates rules, MIT). Validated for Python, JavaScript and TypeScript. The official Semgrep registry rules are never shipped. |
| zizmor | `ci-cd` | Prepared from an authorized source | Audits GitHub Actions workflows. |
| oasdiff | `api-compatibility` | Customer-supplied | Needs an OpenAPI 3 file and a git ref or file as the reference. No code-first contract extraction. |
| Build check | `typecheck` | Customer-supplied | Validated for TypeScript, Python, Go, Rust and C#; JavaScript, F# and Visual Basic are unsupported. The `typescript-tsc` template activates on any `tsconfig.json`. |
| CodeQL | `dataflow` | Customer-supplied | JGates ships a built-in adapter only. You install the CodeQL CLI (2.15+, `JGATES_CODEQL` or the PATH) and hold the entitlement for your repository. The adapter is exercised with a stand-in that replays CodeQL-shaped SARIF; a real CodeQL is not run by the default suite. |
| Schemathesis | `api-contract` | Prepared from an authorized source | Needs an OpenAPI 3 file and a running HTTP target. |
| ZAP | `dast` | Customer-supplied | Passive and active modes against a running HTTP target; active mode attacks the target, so use it only on systems you own. Needs Docker and the ZAP image. |
| Mutation testing | `mutation` | Customer-supplied | Validated for JavaScript and Python; TypeScript needs your setup. |
| Supply chain | `supply-chain` | Shipped | Reads lockfiles (npm and Python); reports install scripts, missing integrity hashes and unpinned or untrusted sources. |
| Trivy image mode | `dependencies` and `images` | Prepared from an authorized source | Scans a container image, not only the file system. |
| govulncheck | `dependencies` | Customer-supplied | Go modules. |
| cargo-audit | `dependencies` | Customer-supplied | Rust crates. |

For a customer-supplied tool the adapter, the supported versions, the official acquisition and setup links and a readiness
check are built in; `jgates doctor` reports what is missing. Nothing is downloaded while a run is in progress.

## Quality subdimensions

The six mascot domains are organized into subdimensions. They only organize the presentation: a check has one primary
domain and one subdimension, so no execution is counted twice, and a subdimension with no selected check is reported as
not covered.

- Quality: lint, types, builds, maintainability, reliability, api-compatibility.
- Security: injection, authorization, tenant-isolation, secrets, cryptography, privacy, business-logic, runtime-evidence.
- Dependencies: vulnerabilities, licenses, supply-chain.
- Tests: unit-integration, contracts, properties, mutation, regressions, post-patch.
- Architecture: layer-boundaries, cycles, cross-module-effects, invariants.
- Infrastructure: iac, ci-cd, deployment, images.

## Limitations

- A row marked `customer-setup-required` is not proven here; the matrix says so instead of hiding it.
- macOS was not tested on real hardware.
- A per-instance `timeoutSeconds` in `tools.yml` is ignored by external adapters.
- Official Semgrep registry rules are under a license that does not allow redistribution, so they are never shipped.
