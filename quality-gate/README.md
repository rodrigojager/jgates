# quality-gate

`quality-gate` is the quality gate of [JGates](../README.md): a deterministic check of a repository (budgets for file and change size, linters, security scanners, duplication, infrastructure files, test and coverage evidence) that ends in a score and a decision. It does not call any AI model; the optional AI review is the [semantic gate](../semantic-gate/README.md).

## How JGates uses it

The main command, `jgates`, runs it through the quality bridge (`jgates run`): it builds the plan, calls the gate and stores the result with the decision. In CI, `jgates ci` runs it with rules taken from a policy repository (see [CI](../docs/jgates/ci.en.md)). You only need `quality-gate` directly when you want the component alone, without the plan, the history and the interface.

## Direct use

```bash
quality-gate . --scope changed --threshold 90 --format=json,md --output .quality/reports
quality-gate . --scope full --output .quality/reports/full
quality-gate . --scope paths --path docs --output .quality/reports/docs
```

- `--scope changed` (the default) checks what changed in Git; `--base <ref>` and `--head <ref>` set the range. `full` checks the whole project and `paths` checks the folders given with `--path` (which requires `--scope paths`).
- Files are filtered with `.gitignore`, `.jgates.ignore` and `.quality-gate.ignore` (gitignore-style `!path` re-inclusion works), and with `--exclude`, `--include` and `--ignore-file`.
- The headless `--json --no-interactive` mode for agents and scripts never prompts; `--ci` is the headless mode for pipelines.
- Under `--output` the gate writes `quality-report.json`, `quality-report.md` and `quality-scope.json`. Each report carries `scoreAppliesTo` (`changed-files`, `entire-project` or `selected-paths`): never present the score of a changed scope as the score of the whole project.
- Exit codes: `0` approved, `1` rejected (a deterministic violation), `2` needs changes (for example, requested evidence is missing or invalid), `3` invalid policy or operational error.

`quality-gate --help` lists every option.

## Docker and the sidecar image

The full scan runs the analyzers inside the sidecar image, built from this folder's `Dockerfile` (based on MegaLinter, so it is large). When Docker is available and the image `jgates/quality-sidecar:latest` does not exist yet, `quality-gate` builds it on the first run. Useful options: `--image <image>` (or the `QUALITY_SIDECAR_IMAGE` variable) to use an image you already have, `--no-build` to forbid the build, `--pull` to pull instead, and `--no-start-docker` to not start Docker.

Without Docker, the bundled Python sidecar runs locally in `full` mode, and a required tool that is not installed fails the gate explicitly. The reduced modes `--mode quick` and `--mode offline` exist for local diagnosis only: their evidence is partial and they are not an approval.

## Quality policy

A built-in budget gate runs in every mode and needs no language runtime. It measures file bytes and lines, changed files and lines, patch bytes, changed binary files and Git hotspots. The profiles `relaxed`, `standard` and `strict` bring the default limits; any limit can be overridden on the command line (`--max-file-lines`, `--max-changed-files`, `--max-diff-bytes` and others; `0` turns off that one limit) or in `.quality-gate-policy.json` (or `--policy-file <path>`). The file can also declare change rules ("a change under `contracts/` requires a change under `tests/`"), which apply only to `--scope changed`. See `examples/quality-gate-policy.example.json` for the full shape.

The gate also reads evidence produced by other tools, in neutral formats: a dependency graph (`--dependency-graph`), generic quality evidence with metrics and checks (`--evidence-report`) and JUnit XML (`--test-report`, with `--min-tests`). A requested evidence file that is missing or invalid is not approval. Examples are in `examples/`.

## Documentation

- [Getting started](../docs/jgates/primeiros-passos.en.md) and [CI](../docs/jgates/ci.en.md).
- [Adapters and the bridge](../docs/jgates/adaptadores.en.md) and the [compatibility matrix](../docs/jgates/compatibilidade.en.md).
- [Known limitations](../docs/jgates/limitacoes.en.md) and [third-party licenses](../THIRD_PARTY_NOTICES.md).
