# JGates: adapters

An **adapter** connects JGates to a real tool (Ruff, ESLint, pytest, Gitleaks...). It says which capabilities the tool delivers, how to build the command, which configuration files it reads and how to interpret the result. An **instance** is an adapter applied to a component of the project (for example `ruff-api`: Ruff on the `api` component).

The list of adapters, what each one delivers, on which systems it was tested and each one's limitation is in the [compatibility matrix](compatibility.en.md). It is generated from the manifests and the test evidence; this page does not repeat the table.

## Declare an instance

Instances live in `.jgates/tools.yml`, which `jgates.yml` includes in `extends`. Each one names the adapter, the component and the configuration file the tool reads. Every instance runs in the JGates tools image (there is no runner to choose; an old `runner` key is ignored with a notice):

```yaml
schemaVersion: 1
tools:
  ruff-api:
    adapter: ruff
    component: api
    config: api/pyproject.toml
```

`config` is always a path inside the workspace (or a declared external root); a path that escapes it is refused.

## See what exists

```bash
jgates tools list
jgates tools inspect ruff-api
jgates tools matrix
```

`tools list` shows the categories, the capabilities, the adapters and the instances declared in `.jgates/tools.yml`. `tools inspect` shows one instance with its linked files. `tools matrix` prints the compatibility matrix (and `--json` brings the problems the consistency test checks).

## Support levels

Each instance shows how much JGates understands the tool:

| Level | Means |
| --- | --- |
| full integration | Assisted configuration plus the preview of the effective configuration; only when the adapter declares both and has tests for them. |
| assisted configuration | The editable file plus a form that writes to the file (today Ruff and pytest). |
| editable file | JGates knows the configuration file and edits it as text, with validation when the format allows. |
| unavailable, incompatible | The tool was not found, or the version is outside the range the adapter declares. The step comes out blocked, never approved. |

A missing tool does not fail the code, but it does not approve it either: the plan warns `TOOL_MISSING` (a tool the tools image does not have, with the image as the one action) or `TOOL_UNAVAILABLE`, the requirement stays unproven and the run comes out `incomplete` (exit 2).

## Where the tools come from

Every tool comes from the JGates tools image, whose `image.json` says which tools and versions it has; JGates never installs a tool on your machine. `jgates doctor` shows the container engine, the tools image and each instance's tool. A tool the image lacks is `TOOL_MISSING`, fixed by the tools image of this JGates version, never by a host install.

## Prepare an instance's data

Some instances need data before they run. Preparation is a separate step, with a simulation:

```bash
jgates doctor
jgates tools prepare --instance <instance> --dry-run
jgates tools prepare --instance <instance> --no-interactive
```

`--dry-run` shows versions, the network that would be used and what would be written, without downloading or writing. What was prepared is pinned in `.jgates/lock.json`, which goes into the repository: the `run` uses what was pinned. Moving an already pinned tool to an older version requires `--allow-version-change` (`VERSION_DOWNGRADE`).

`prepare` applies to Semgrep, whose local rules are downloaded once and pinned by hash. On any other instance it answers `PREPARE_NOT_SUPPORTED`.

The Semgrep adapter can also run the JGates rule pack (`tools.<id>.rulePack: jgates`, the default of the base template): original rules for JavaScript, TypeScript, Python, Go, C#, Rust, Java and PHP. Its plan item names the languages the pack covers and, when discovery found a language the pack has no rule for, says so as a limitation. The Semgrep stage of the result carries `scannedLanguages`, the number of files of each language the scan covered. For Java and PHP, which have no stack, the pack is the only language-specific check.

### The quality bridge is retired

The quality gate's bridge (MegaLinter and its sidecar image) no longer takes part in the plans. Each scanner is an instance of its own adapter, run in the tools image: Semgrep (`sast`), Gitleaks (`secrets`), OSV-Scanner and Trivy (`dependencies`), Trivy and Checkov (`iac`), jscpd (`duplication`) and file-size (`file-size`) come from the base template; lint comes from the linter of each stack (Ruff, ESLint, golangci-lint, Clippy, the .NET analyzers, ShellCheck, Hadolint) and tests and coverage from the test runner of each stack. No MegaLinter or sidecar image is ever started.

- A `.jgates/tools.yml` that still declares an instance of the `quality-bridge` adapter is read as the individual instances that cover the same capabilities; the file on disk is not rewritten, and the overview shows a notice that names the instances. The checks of a profile that name `tool:quality-bridge.<subcheck>` are read as the selector of the instance that took the subcheck over.
- `jgates ci` (governed mode) keeps reading the bridge's subchecks of the legacy quality gate with its packaged, trusted configuration; the scanners of the individual adapters that read configuration from the analyzed tree are not allowed under a policy.
- A project with no linter for its stack shows lint as not applicable here, with what to add (for example an ESLint configuration), instead of a blocked plan.

## What enters the plan

Tools with their own configuration (ESLint, Vitest, pytest, Import Linter, dependency-cruiser) only enter the plan when the project has their configuration; see [templates and profiles](templates-and-profiles.en.md). An instance declared by hand in `.jgates/tools.yml` enters when its capability is selected, and stays `blocked` if what it needs is missing (for example ESLint without an `eslint.config`). The same goes for the tools that execute project code (ESLint, Vitest, pytest): the plan shows the effect, and their result is never reused from the cache.

## Generic command

For a check without an adapter (a team script, `go test`, `cargo test`), the `generic-command` adapter runs an explicit command, without a shell. It earns no credit just for running: it must **declare its effects** and an **evidence contract** that says what the result proves. Without declared effects the plan is not approvable.

It is declared in a project template, in `.jgates/templates/api-unittest.yml`:

```yaml
schemaVersion: 1
id: api-unittest
label: API unittest tests
extends: [builtin:base]
config:
  tools:
    api-unittest:
      adapter: generic-command
      enabled: true
      capabilities: [unit]
      command: python
      args: [-m, unittest, discover, -s, "{workspace}/api"]
      config:
        support: partial
        limitations:
          - Runs unittest only, without coverage.
        effects: { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false }
        evidence: { kind: exit-code }
```

And turned on in `jgates.yml`:

```yaml
templates:
  - id: api-unittest
    source: .jgates/templates/api-unittest.yml
    activation: always
```

The evidence contracts: `exit-code` (the exit code decides), `test-runner` (`go-test` or `cargo-test`: JGates reads the runner's output) and `json-file` (the command writes a JSON that JGates validates against a schema of the workspace). Security and architecture are credited only with `json-file`; tests, with `json-file` or `test-runner`. With `exit-code`, a security, architecture or tests requirement stays `EVIDENCE_MISSING` (no coverage, plan not approvable). `support` and `limitations` appear in the plan and in the result.

## Stacks and your own tools

Go, Rust and .NET have templates of their own for lint, build, tests and dependencies; what each stack does **not** cover shows in the plan (`support.uncovered`) and in the [matrix](compatibility.en.md). None of this is presented as full coverage. For a tool or a language JGates does not ship, add [your own tool](extension.en.md): it runs in an image extended from the tools image and is read through SARIF, JUnit or Checkstyle reports (`evidence.kind`). Checks that need a running application or a database use the [project services](services.en.md).

## Operating systems

Every tool runs in a `linux/amd64` container. Linux: tested. Windows: the first-run flow was checked by hand on Windows 10 with Docker Desktop (see [limitations](limitations.en.md)); the tests that depend on Windows are marked and skip elsewhere. macOS: not tested on a real Mac. The installation proof is in [getting started](getting-started.en.md).
