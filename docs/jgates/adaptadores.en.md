# JGates: adapters

An **adapter** connects JGates to a real tool (Ruff, ESLint, pytest, Gitleaks...). It says which capabilities the tool delivers, how to build the command, which configuration files it reads and how to interpret the result. An **instance** is an adapter applied to a component of the project (for example `ruff-api`: Ruff on the `api` component).

The list of adapters, what each one delivers, on which systems it was tested and each one's limitation is in the [compatibility matrix](compatibilidade.en.md). It is generated from the manifests and the test evidence; this page does not repeat the table.

## Declare an instance

Instances live in `.jgates/tools.yml`, which `jgates.yml` includes in `extends`. Each one names the adapter, the component, the runner (`local` or `container`) and the configuration file the tool reads:

```yaml
schemaVersion: 1
tools:
  ruff-api:
    adapter: ruff
    component: api
    runner: container
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

A missing tool does not fail the code, but it does not approve it either: the plan warns `TOOL_UNAVAILABLE`, the requirement stays unproven and the run comes out `incomplete` (exit 2).

## Prepare a tool

JGates installs nothing on its own during a `run`. Preparation is a separate step, with a simulation:

```bash
jgates doctor
jgates tools prepare --instance ruff-api --dry-run
jgates tools prepare --instance ruff-api --no-interactive
```

`--dry-run` shows versions, the network that would be used and what would be written, without downloading or writing. What was prepared is pinned in `.jgates/lock.json`, which goes into the repository: the `run` uses what was pinned. Moving an already pinned tool to an older version requires `--allow-version-change` (`VERSION_DOWNGRADE`).

`prepare` applies to container instances (below) and to Semgrep, whose local rules are downloaded once and pinned by hash. On a local instance of a tool you install yourself (Ruff from `pip`, for example), it answers `PREPARE_NOT_SUPPORTED`, and `jgates doctor` shows the install command.

### Tools in a container

An instance with `runner: container` runs the tool in an image, without network, with the workspace read-only. The image is chosen and pinned by `tools prepare`, and the `run` downloads nothing:

```bash
jgates tools prepare --instance ruff-api --image ruff:0.17.2 --dry-run
jgates tools prepare --instance ruff-api --image ruff:0.17.2 --no-interactive
```

`--image` accepts `name:tag` or `name@sha256:...`. If the image is not in the runtime, `prepare` warns that it will do a `docker pull` and from which host, and in an interactive terminal asks for your confirmation first. The result, with the digest and the version from the image label, goes to `.jgates/lock.json`. Without `--image`, the image already pinned in the lockfile applies, otherwise the one from the JGates sidecar. The `JGATES_*_IMAGE` variables of the development versions no longer exist: the image lives in the lockfile, versioned with the project.

### The bridge's scanners in the sidecar image

The quality gate's bridge runs MegaLinter, Semgrep, Gitleaks, Trivy, Checkov, OSV-Scanner and jscpd. On a machine that does not have them installed (on Windows, MegaLinter only exists in the image), each one would come out `missing`. When Docker answers and the sidecar image `jgates/quality-sidecar:latest` exists, the run sends those scanners to the image and keeps the built-in subchecks (file size, the project's tests and coverage) on the host; the two answers become one, and the plan and the result do not change shape. Build the image once, from the `quality-gate` folder of the installed package or of the clone (it is based on MegaLinter: large, and the first build takes a while):

```bash
docker build -t jgates/quality-sidecar:latest <path>/quality-gate
```

- `JGATES_BRIDGE_RUNNER` chooses: `auto` (the default) uses the image only when a requested scanner is not on the host; `local` never uses it; `container` always does.
- The container gets the workspace read-only, its own output folder in the run folder, the network (Trivy, OSV-Scanner and Semgrep's `p/default` download their databases and rules) and a cache in the data folder (`<data folder>/cache/quality-sidecar`, a few GB after the first run), so the next runs reuse the databases. It runs as your user on Linux and macOS and as `nobody` on Windows, never as root.
- Without Docker or without the image, the missing scanners say so in the result, with the command that builds the image.
- `jgates ci` (governed mode) and a sidecar of your own (`JGATES_SIDECAR_DIR`) always run on the host.

## What enters the plan

Tools with their own configuration (ESLint, Vitest, pytest, Import Linter, dependency-cruiser) only enter the plan when the project has their configuration; see [templates and profiles](templates-e-perfis.en.md). An instance declared by hand in `.jgates/tools.yml` enters when its capability is selected, and stays `blocked` if what it needs is missing (for example ESLint without an `eslint.config`). The same goes for the tools that execute project code (ESLint, Vitest, pytest): the plan shows the effect, and their result is never reused from the cache.

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

## Partial support

Go, Rust and .NET have partial-support templates. Go and Rust: discovery, explicit configuration and `go test` / `cargo test` through the generic command. .NET: the current `dotnetweb` flavor chain through the bridge, without its own integration for build, tests, coverage or analyzers. What each one does **not** cover appears in the plan (`support.uncovered`) and in the [matrix](compatibilidade.en.md). None of this is presented as full coverage.

## Operating systems

Linux: tested. Windows: the first-run flow was checked by hand on Windows 10 with Docker Desktop, where the bridge's scanners run in the sidecar image (see [limitations](limitacoes.en.md)); the tests that depend on Windows are marked and skip elsewhere. macOS: not tested on a real Mac. The installation proof is in [getting started](primeiros-passos.en.md).
