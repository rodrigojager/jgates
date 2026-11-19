# JGates: templates, profiles and selection

Three things decide what JGates checks: the **templates** (what each stack brings), the **profiles** (how much rigor you want) and the **selection** (turning one particular check on or off, including for a single run). Everything lives in YAML files of the project, versioned with the code.

## The layers and the origin of each value

The final configuration is the sum of layers, from the weakest to the strongest: JGates defaults, templates, profile, project files (`jgates.yml` and `.jgates/*.yml`) and the options of the call (`--skip`, `--only`, `--profile`...). To find where any value came from:

```bash
jgates config resolve --explain
jgates config get /selection/profile
```

`--explain` shows, per value, the layer, the file, the path inside it and the previous value. In the interface, the origin button next to the fields (`#/config`) shows the same chain.

## Templates

A template is a configuration package for a stack: tools, exclusions and selection. `jgates init` writes in `jgates.yml` the list of those that apply to the project, each with an activation:

- `always`: always active (`base`);
- `detected`: active when the template matches the inventory (the component's language and, in some, the presence of a file);
- `manual`: only when you turn it on, for example with `--template <id>` in a run.

The built-in templates:

| Template | What for |
| --- | --- |
| `base` | Any stack: the bridge to `quality-gate` (lint, SAST, secrets, dependencies, duplication, IaC, file size) and personal data detection. |
| `python` | Python components: Ruff and the exclusion of virtual environments and caches. |
| `typescript` | TypeScript and JavaScript components. |
| `python-pytest`, `python-import-linter` | pytest with coverage, and Import Linter. |
| `typescript-eslint`, `typescript-vitest`, `typescript-dependency-cruiser` | ESLint, Vitest with coverage, and dependency-cruiser. |
| `gitleaks-history`, `trivy-licenses` | Secrets in the whole Git history, and dependency licenses. They come in by evidence (a Git repository; a dependency manifest) and run in the scanners image. |
| `python-mypy-defaults`, `python-mutmut` | mypy on Python components even without a mypy configuration, and mutation testing with mutmut. |
| `typescript-stryker` | Mutation testing of TypeScript and JavaScript with StrykerJS, when the project has a Stryker configuration. |
| `python-codeql`, `typescript-codeql`, `go-codeql`, `dotnet-codeql` | CodeQL dataflow analysis by the component's language. The CodeQL CLI is yours to supply: without it the check shows as not available here. |
| `python-typescript` | Brings the Python and TypeScript ones together for repositories with both. |
| `dotnet`, `go`, `rust` | Partial support: see [adapters](adapters.en.md). |

### Templates that enter by evidence

ESLint, dependency-cruiser, Import Linter, pytest and Vitest do not come inside the `python` and `typescript` templates. Each has its own template that only enters when the project has its configuration (`match.files` in the template):

- `typescript-eslint`: an `eslint.config.*` in the component;
- `typescript-vitest`: a `vitest.config.*`, or a `vite.config.*` with the `test:` key;
- `python-pytest`: `pytest.ini`, `conftest.py`, or the pytest section in `pyproject.toml`, `tox.ini` or `setup.cfg`;
- `python-import-linter` and `typescript-dependency-cruiser`: a `.jgates/architecture.yml` (the architecture rules) or, in Python, Import Linter's native configuration.

This way JGates does not impose a test or lint framework on those who do not use it. `jgates init` writes the new ones above in `jgates.yml` too, as `detected`, and lists all of them; `plan` shows the ones that stayed inactive. In `jgates.yml` the `templates` block is yours: you can change a template's activation, or turn on a `manual` one, without touching the rest.

## Profiles

A profile chooses the capabilities that count. The three built-in ones inherit from each other:

| Profile | Turns on | Inherits from |
| --- | --- | --- |
| `minimal` (Essential) | lint, file size and secrets | - |
| `standard` (Balanced, the `init` default) | plus SAST, dependencies, duplication, IaC and personal data | `minimal` |
| `strict` (Rigorous) | plus unit tests and coverage, required; and every other check for which a tool exists, in the "where a tool exists" mode (below) | `standard` |

The [tool catalog](tools.en.md) lists the implicit templates, their file evidence and their default tiers. Core tools are available from Essential, main tools from Balanced and extended tools from Strict, subject to the capability and matching files. In `jgates config`, choose the profile and toggle individual tools. To select one for a run, use `--only tool:<id>`. After an upgrade, the **New checks** indicator identifies tools added to the installed catalog.

### Required, where a tool exists, or off

Each capability of a profile has three modes. In the interface (`#/config`, the profiles screen) the selector reads **Required**, **Where a tool exists** and **Off**; in `.jgates/profiles.yml` they are `enabled: true`, `enabled: true` with `when: available`, and `enabled: false`:

```yaml
checks:
  capability:unit: { enabled: true }
  capability:mutation: { enabled: true, when: available }
```

- **Required** (`enabled: true`): the check must run. With no tool for it in the project, the validation is blocked and says what is missing (fail-closed: what you require is never skipped silently).
- **Where a tool exists** (`when: available`): the check runs in every component that has a tool for it. Where none does, the capability is listed as "not applicable here", with the reason and the one action that would enable it (for example, adding a template, installing a tool, preparing the scanners image), and it **never blocks** the plan or the decision.
- **Off**: it does not run.

`strict` is built this way: unit tests, coverage and personal data detection are required; every other capability the catalog knows (format check, history secrets, dataflow, licenses, integration and end-to-end tests, mutation, property tests, architecture, API compatibility and contract, type check, migration, performance, CI/CD, supply chain and DAST) is turned on **where a tool exists**. A project that has no mutation tool therefore sees mutation as "not applicable here", not as a failure, and not as a silent absence. The plan (`jgates plan`) carries these not-applicable items in its own list; when the fix is a built-in template, the action says which one to add (`add-template`).

The profiles screen, the **Choose** screen and the plan review show **every** capability with its state: "Will run", "Does not apply here" (with the reason and the action) or "Off" (with who turned it off: the profile, your file, the policy or only this run). The Choose and review screens mark the ones set to run only where a tool exists.

`init` copies the three into `.jgates/profiles.yml`, each inheriting from the built-in one (`builtin:minimal`...), and `selection.profile` in `jgates.yml` says which one applies. Your own profiles live in the same file:

```bash
jgates profiles list
jgates profiles create rapido --from standard --skip capability:duplication
jgates profiles set-default rapido
```

`profiles delete <id>` deletes a profile, and refuses the default one (`PROFILE_IN_USE`: change the default first). Each command writes by patching the YAML, preserving comments, and accepts `--if-match <sha256>` to refuse the write if the file changed since you read it (`REVISION_CONFLICT`). In governed mode, where the policy comes from outside the project, profiles and limits are not loosened: the interface shows the locked fields.

## Granular selection

A selector points to a part of the catalog:

| Selector | Example | What it reaches |
| --- | --- | --- |
| `category:<id>` | `category:security` | All capabilities of the category (quality, security, tests, architecture, dependencies, infrastructure). |
| `capability:<id>` | `capability:unit` | One capability, in every tool that delivers it. |
| `tool:<id>` | `tool:ruff` | One tool (instance or adapter). |
| `tool:<id>.<sub>` | `tool:quality-bridge.jscpd` | One subcheck of a composite tool, such as the bridge. |
| `pii:<entity>` | `pii:phone` | One entity of the personal data detection. |

When two selectors disagree in the same layer, the more specific one wins (`category` < `capability` < `tool` < rule). If they tie, enabled wins: when in doubt, more checks run. A selector that matches nothing is an error (`SELECTOR_UNMATCHED`), with a suggestion of the closest name.

## Turn off only for this run

`--skip` turns off and `--only` restricts (`plan` and `run` accept both; `config resolve` accepts `--skip`). The values apply only to that call, write nothing, and can be repeated or separated by commas:

```bash
jgates plan --skip capability:unit --skip pii:phone
jgates plan --only category:security
jgates run --profile standard --skip capability:duplication
```

The plan shows each affected item with the origin "only this run". When what you turned off is required by the profile, the result comes out with `reduced: true` and the decision never counts as approval of the full profile: an agent that fixes code does not close the cycle this way. What really has to change is the profile, and that is a revision of the plan.

In the interface, the Choose screen (`#/validations/choose`) has the "Customize this validation" panel, which does the same, and the plan review (`#/validations/review`) shows the outcome before running.

## Save a run as a profile

A selection you liked becomes a profile without writing YAML: either start from an existing profile with the turn-offs (`profiles create ... --from ... --skip ...`, above), or start from a run that already happened, with the profile plus the turn-offs of that run:

```bash
jgates history
jgates profiles save --run <runId> --as rapido
```

`save` refuses a run that does not exist (`RUN_NOT_FOUND`) and a run that used `--only` (`RUN_USED_ONLY`: a restriction does not become a profile; run again with `--skip` on the items to turn off). In the interface the same is the "Save as profile" button.
