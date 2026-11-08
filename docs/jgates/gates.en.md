# JGates: the two gates and their sequence

JGates V2 has two gates you select independently. **Quality** is deterministic and token-free: the adapters, mascots and
results you already know. **Semantic** is model reasoning and investigation, with its own runs, history, screens and
mascots. Choosing both creates two distinct runs, never one run with two verdicts.

## Choosing the gates

The default is Quality only. The selection lives in `selection.gates` of `jgates.yml` (or a profile) and can be
overridden for one run:

```bash
jgates run --gates quality --dry-run
jgates run --gates quality,semantic --dry-run
jgates run --gates semantic --dry-run
```

`--dry-run` prints the sequence plan without running anything: which gates run, where each choice came from and, for
Semantic after Quality, whether the Quality prerequisite would hold. The interface shows the same plan in the validation
screens (gate choice) and the sequence overview.

## Run identity and sequences

- Quality runs are `run_...`, Semantic runs are `sem_...`, a sequence is `seq_...`. A run ID never serves both gates.
- A sequence is a small coordination record linking the ordered run references. It never rewrites either run's decision.
- Semantic never overwrites a Quality result. The advisory `result.semantic` block that `jgates run --semantic` writes
  keeps working as before.
- Semantic-only works with no Quality history.

## When Semantic starts after Quality

Semantic starts automatically only after a complete, current, non-reduced Quality approval. Otherwise the sequence
stops with a reason code and the Semantic run is not created: `QUALITY_FAILED`, `QUALITY_INCOMPLETE`, `QUALITY_REDUCED`,
`QUALITY_INVALID`, `QUALITY_CANCELLED`, `QUALITY_ERROR`, `QUALITY_TIMEOUT`, `QUALITY_PARTIAL`, `SOURCE_CHANGED`,
`SOURCE_UNVERIFIABLE`, `QUALITY_SCOPE_*`, `SEMANTIC_SETTINGS_CHANGED` and `QUALITY_COVERAGE_MISSING`.

```bash
jgates run --gates quality,semantic --manual-advance
jgates run --advance <sequence-id>
jgates run --gates quality,semantic --reuse-quality
```

- `--manual-advance` runs Quality and waits: the sequence stays open until you advance it with `--advance` (or from the
  interface).
- `--reuse-quality` reuses an earlier Quality run instead of running Quality again, only when it is still current for the
  same source and scope; the sequence records that provenance.
- `--advance` continues a waiting sequence once the prerequisite is met.

## Semantic runs

```bash
jgates semantic methods
jgates semantic plan --purpose general-review --rigor standard
jgates semantic run --scope selected --path <path> --purpose security --rigor deep
jgates semantic status <run_id>
jgates semantic history
jgates semantic cancel <run_id>
```

- `plan` shows what would run (scope, method, budget, blockers) and spends nothing. `run` executes it.
- `status`, `history` and `cancel` act on Semantic runs only. Cancelling stops only the processes the run started and
  keeps the partial evidence.
- Add `--events-jsonl` to stream events as JSON lines, `--run-id` to pick a run and `--quality <run_id|latest>` to attach
  a Quality run as evidence.

### Scope

The scope says which files are the subject of the review. It is independent of the rigor and the budget, and it is never
silently widened.

| Mode | Flags | Meaning |
| --- | --- | --- |
| `full-recommended` | `--scope full-recommended` | The recommended whole-project review. |
| `selected` | `--scope selected --path <p> --subsystem <s> --exclude <p>` | Only the paths or subsystems you name. |
| `incremental` | `--scope incremental --base <ref> --target <ref> --dirty --baseline` | What changed between two refs, with or without uncommitted changes; `--baseline` inherits the coverage of an earlier clean run. |

Without `--baseline`, inherited coverage is reported as `NO_BASELINE`. Scope completion is reported separately from
repository coverage.

### Context, purpose, rigor and budget

- Context: `--context-policy`, `--context-max-files`, `--context-max-depth`, `--context-max-bytes` and
  `--allow-context <path>` control how far the review may read beyond the subjects. Every refusal and expansion is
  recorded.
- `--purpose general-review|security` picks the default method; `--method <id>` picks one explicitly (see
  [the Semantic methods](semantic-methods.en.md)).
- `--rigor quick|standard|deep` sets how much of the budget is reserved for validation before hunting.
- `--budget-calls` and `--budget-tokens` cap the calls and tokens. A budget exhausted before the required validation
  makes the run incomplete, never favorable.

Missing, malformed or unfinished model output is invalid or incomplete, never an approval. Severity, confirmation state
(`confirmed`, `needs-validation`, `rejected`), execution completeness and coverage are separate fields.

## Generated regressions

Methods may propose a test that would have caught a finding. Those proposals are never applied by themselves:

```bash
jgates regressions list
```

`jgates regressions show <id>` and `jgates regressions validate <id>` inspect and validate one proposal in a sandbox;
`jgates regressions incorporate <id> --approve` adds it to the checks of the project's Quality gate, and only with `--approve`.

## The Semantic area and its mascots

`jgates ui` has a separate Semantic area (history, configuration, setup, run and results screens) and four AI mascots:
Scout, Tracker, Challenger and Verifier. Quality's six mascots never show AI work and the AI mascots never show a
Quality domain. See [the Semantic mascots](semantic-mascots.en.md).
