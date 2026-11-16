# JGates: Quality integrations and the capability matrix

The Quality integrations are in the standard catalog (interface and CLI) by default. Whether one runs depends on stack
detection, the profile, the rigor, the scope, its prerequisites and your per-run choices. Quality never calls a model.
Every tool runs in the JGates tools image, which holds all of them except CodeQL: nothing is installed on your machine and
nothing is installed during a run. `jgates setup` downloads the image, and the only integration you prepare yourself is
CodeQL.

## The capability-by-stack matrix

Support is declared per capability and per stack, and only with evidence: a known-bad fixture the check must flag, a
clean fixture it must pass, and a test cited by the matrix. A parser stub or a tool exit code alone is not efficacy.

```bash
jgates tools matrix
jgates tools matrix --units
jgates tools distribution
```

Each row has a state: `validated` (evidence exists), `customer-setup-required` (the check is built in but you supply the
setup, so it is not proven by the default suite), `unsupported` or `not-applicable`. A row also lists the
prerequisites, the tool versions and the limitations. `--units` adds the per-unit view. `jgates tools distribution`
verifies that each adapter's license record (shipped, prepared from an authorized source, or customer-supplied) is
complete and that every shipped pack satisfies its license terms; it is a legal record, and where the tool runs is always
the tools image.

## The integrations

| Integration | Capability | Where it comes from | Stacks and notes |
| --- | --- | --- | --- |
| Semgrep with the JGates rule pack | `sast` | Semgrep is in the tools image; the pack is shipped | `tools.<id>.rulePack: jgates` selects the pack (`jgates/packs/semgrep/jgates-semgrep`, original JGates rules, MIT). The pack has original rules for eight languages (JavaScript, TypeScript, Python, Go, C#, Rust, Java and PHP) and for HTML and configuration files (see below), including XSS, and each is validated by the vulnerable and clean twins of its language. Java and PHP have no stack in JGates: for them this is SAST only (no lint, type check, tests or dependency preparation; the offline advisory data does not cover Maven or Composer; template files are not scanned), and under the Essential profile SAST is off. The plan names the languages the pack covers and the languages of the project it lacks; the result records how many files of each language were scanned. In-image mode keeps the image's older copy of the pack until the image is rebuilt. The official Semgrep registry rules are never shipped and are not in the image. |
| zizmor | `ci-cd` | In the tools image | Audits GitHub Actions workflows. |
| oasdiff | `api-compatibility` | In the tools image | Needs an OpenAPI 3 file and a git ref or file as the reference. No code-first contract extraction. |
| Build check | `typecheck` | In the tools image; the project's own version wins | Validated for TypeScript, Python, Go, Rust and C#; JavaScript, F# and Visual Basic are unsupported. The `typescript-tsc` template activates on any `tsconfig.json`. |
| CodeQL | `dataflow` | You prepare it | Not in the image. `jgates tools prepare-codeql --accept-terms` records your acceptance of GitHub's terms, downloads the official bundle and keeps it in the `jgates-codeql` volume; until then the check is `incomplete` with `CUSTOMER_SUPPLIED`. The adapter is exercised with a stand-in that replays CodeQL-shaped SARIF; a real CodeQL is not run by the default suite. |
| Schemathesis | `api-contract` | In the tools image | Needs an OpenAPI 3 file and a running HTTP target (a [service](services.en.md): `service:<name>:<port>`). |
| ZAP | `dast` | In the tools image | Passive and active modes against a running HTTP target; active mode attacks the target, so use it only on systems you own. |
| Mutation testing | `mutation` | The project's dependencies, or the tools image | Validated for JavaScript and Python; TypeScript needs your setup. |
| Supply chain | `supply-chain` | Shipped | Reads lockfiles (npm and Python); reports install scripts, missing integrity hashes and unpinned or untrusted sources. |
| Trivy image mode | `dependencies` and `images` | In the tools image | Scans a container image, not only the file system. |
| govulncheck | `dependencies` | In the tools image | Go modules; the database is the one `jgates tools update-data` keeps. |
| cargo-audit | `dependencies` | In the tools image | Rust crates; the database is the one `jgates tools update-data` keeps. |
| cargo test | `tests` and `properties` | In the tools image | Rust crates. Runs `cargo test --offline` over the dependencies prepared in the component's volume and reads the stable libtest output: a failing test is `cargo-test.test-failed`; a failing proptest property (a function in a `proptest!` block or marked `#[proptest]`, found by reading the sources) is `cargo-test.property-failed` with the minimal failing input, plus the metrics `tests.property.total` and `tests.property.failed` when the crate uses proptest. Build artifacts stay in the run folder and proptest failure persistence is off, so the project is untouched. The `rust-cargo-test` template is added by `jgates init` to Rust components. The tests and build scripts execute, so the result is self-reported in `jgates ci`. |

For a tool you prepare yourself the adapter, the supported versions, the official links and a readiness check are built
in; `jgates status` and the plan report what is missing. Nothing is downloaded while a run is in progress. For a tool or a
language that is not in the table, see [your own tools](extension.en.md).

## The rule pack: groups and kinds of file

The JGates Semgrep pack holds original rules, named `jgates.<kind>.<name>`, for **nine kinds of file**: Python, JavaScript
(also TypeScript), Go, C#, Rust, Java, PHP, HTML files (`.html`, `.htm`) and configuration files (server, framework and
application settings such as `.conf`, `.properties`, `.ini`, `.htaccess`, `web.config`, `application.yml` and
`appsettings.json`). Templates (Jinja, Blade, Razor, EJS, Go templates, Vue files) are not read. The rule files of a kind
of file are split into **eleven groups**: interpreters, encoding, cookies-cors, web-protocol, files, passwords-sessions,
tokens-transport, crypto-params, errors-logging, configuration and signals. The earlier files (injection, taint, XSS,
crypto-auth and deserialization) are kept as they were; HTML files have a markup group and configuration files have a
server group and a framework group. The libraries each family covers are in the header of its rule file.

- **What blocks.** A rule of severity `ERROR` or `WARNING` is a vulnerability, precise or heuristic, and blocks under the
  Balanced and Strict rigors as every blocking finding does. New blocking rules apply at once.
- **What does not block.** A rule of severity `INFO` states a policy of the standard that many sound projects do not
  follow. Its result is an **informational finding**: shown, counted apart, labelled "does not block the validation", and
  never waivable.
- **Signals.** The `signals` group holds tiny rules (`jgates.<kind>.uses-<tag>`) that only record that a scan saw a
  technology (GraphQL, WebSocket, JWT, XML, mail and the like). Their results are never findings; the [ASVS
  coverage map](asvs-coverage.en.md) uses them to suggest "not applicable".
- **Requirements.** Each rule names the ASVS requirements it was written for. That is a statement of intent: only the
  reviewed mapping makes a check count in the map.
- **Engine.** The rules are written for Semgrep 1.100 or later and were last verified with Semgrep 1.184.0 (the version
  in the tools image).

## Quality subdimensions

The six mascot domains are organized into subdimensions. They only organize the presentation: a check has one primary
domain and one subdimension, so no execution is counted twice, and a subdimension with no selected check is reported as
not covered.

- Quality: lint, types, builds, maintainability, reliability, api-compatibility.
- Security: injection, authorization, tenant-isolation, secrets, cryptography, privacy, business-logic, runtime-evidence, hardening (configuration, error handling and availability; "endurecimento" in Portuguese).
- Dependencies: vulnerabilities, licenses, supply-chain.
- Tests: unit-integration, contracts, properties, mutation, regressions, post-patch.
- Architecture: layer-boundaries, cycles, cross-module-effects, invariants.
- Infrastructure: iac, ci-cd, deployment, images.

The Security subdimensions are also the second way to read the [ASVS coverage map](asvs-coverage.en.md): each mapped
requirement names its subdimensions, and the rules of the bundled Semgrep pack, the Gitleaks, ZAP and dependency checks
feed the map only when they really ran. The map says what was examined, never that a project meets the standard.

## Limitations

- A row marked `customer-setup-required` is not proven here; the matrix says so instead of hiding it.
- macOS was not tested on real hardware.
- A per-instance `timeoutSeconds` in `tools.yml` is ignored by external adapters.
- Official Semgrep registry rules are under a license that does not allow redistribution, so they are never shipped.
- The offline OSV data covers npm, PyPI, Go, crates.io and NuGet only; Trivy uses its embedded checks; Playwright e2e runs Chromium only (see [limitations](limitations.en.md)).
