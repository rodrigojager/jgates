# JGates: using it with AI agents

JGates does not host an agent. It gives an agent (or a CI script) stable contracts and evidence: a plan that can be reviewed, a result bound to the state of the code and a safe summary of the failures. The limits on attempts, time and cost stay in the external orchestration.

## The cycle

1. The agent asks for the plan and the result in structured output.
2. It receives the failures, the evidence, the files and the command to reproduce.
3. It fixes the code in the proper workspace or branch.
4. It runs again and receives a result bound to the new state.
5. It stops when the requirements are satisfied or the agent's budget runs out.

```bash
jgates plan --json
```

```bash
jgates run --no-interactive --json --events-jsonl eventos.jsonl
```

Automation rules: `--no-interactive` never waits for input (missing data becomes a structured error with the fix instruction); `--json` prints exactly one document on stdout, with human progress on stderr; `--events-jsonl` writes the events to a separate file, with `runId`, `sequence` and `type`. The exit code tells the decision: 0 approved, 1 failed, 2 incomplete, 3 invalid usage or configuration, 4 internal error, 130 cancelled (see [getting started](primeiros-passos.en.md)).

## Context for the agent

```bash
jgates report <runId> --agent-context
```

The command (and the "Copy to the agent" button of the interface, which uses the same function) produces a text summary: the frozen policy instruction, the decision, what stayed incomplete or reduced, the stages, the metrics, the findings with file and line and the "How to reproduce" section. This summary:

- has masking applied: no secret or personal data value;
- sends nothing to a provider;
- marks code comments, README, scanner logs and error messages as **data**, between delimiters, and tells the agent not to treat them as instructions. Delimiters do not eliminate prompt injection; they only make the boundary explicit.

To plug into a code review flow, the same result comes out as SARIF:

```bash
jgates report <runId> --format sarif --out resultado.sarif
```

## What the agent must not do

Fix the gate instead of the code. That is why the result shows when the policy changed:

- a run with `reduced: true` (by `--skip`, for example) **never** closes the cycle as approved; it shows what was turned off;
- the result stores in `provenance` the hashes of the configuration, the policy and the templates, to compare with the previous cycle; turning a rule off, widening an `exclude` or creating a waiver changes those hashes, and it is a new plan review, not proof that the code passed the earlier criteria;
- the summary for the agent starts with the frozen policy instruction: fix the code, do not edit `jgates.yml`, the `.jgates/` folder, thresholds, rules, waivers or baseline, and, if a criterion looks wrong, describe the problem and stop;
- waivers need a rule, a path, a reason and an expiry, and an expired waiver does not apply.

In local mode the user can change their own policy. Protection against the code author changing the gate needs the external policy and [governed mode](seguranca.en.md).

## Personal data in the project files

`jgates pii check` finds personal data in the files of the next commit without printing the value, and `jgates pii fix` corrects it through the tool the project configures, only after confirmation or `--yes`, keeping the originals for `jgates pii fix --undo`. An agent runs `pii fix --yes` only when the user authorized it, never uses `--diff` in an automated run (it shows the values), does not bypass the optional `jgates hooks install pre-commit` hook with `--no-verify`, and does not try to recover a value from the files. See [security](seguranca.en.md#personal-data-in-the-project-files).

## The skills

The repository ships three skills: `jgates/skill/SKILL.md` (the `jgates` cycle, including `jgates ci`), `use-jgates-quality` and `use-jgates-semantic` (the commands of each component). An agent never edits the CI policy or its hash to make a job pass. The JGates commands follow the contract above; the semantic gate enters only when requested (see [semantic gate](semantic-gate.en.md)).
