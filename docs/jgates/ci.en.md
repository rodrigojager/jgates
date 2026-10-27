# JGates: CI

In CI the rules are not decided by the code being checked. `jgates ci` takes them from a **policy repository** kept by whoever controls the pipeline, pinned by a hash, and refuses everything a job could use to loosen the gate. This page explains the model, how to set the policy up, what `jgates ci` refuses or trusts less, and how to protect the pipeline on GitLab and GitHub.

## The model

- **Locally** you edit everything: `jgates.yml`, profiles, templates, waivers. It is your work area, and `jgates run` obeys it.
- **In CI** only the owner of the pipeline defines the rules. The configuration comes from the policy folder (`--policy` or `JGATES_POLICY_DIR`), and the project's own `jgates.yml` and `.jgates/` are never read.
- The policy is pinned by `JGATES_POLICY_SHA256`, a protected CI variable. If the hash of the policy folder differs, nothing runs (exit 3).
- The commit is analyzed in a clean copy, so files that are not in the commit do not count.

## Build the policy repository

The policy repository is an ordinary repository with the same files a project has: `jgates.yml`, `.jgates/profiles.yml`, optionally `.jgates/quality-policy.json` and `.jgates/waivers.json`. To create and edit it, open the interface on the folder:

```bash
jgates ui --policy <policy-folder>
```

In this mode the Configuration and Tools screens save to the policy folder, and the CI policy screen (`#/policy`) shows the hash, the files that enter it and the ready snippets for GitHub Actions and GitLab CI. Tips:

- Give the templates of the policy the `always` activation. A template activated by a file lets the project turn the tool on or off by adding or removing that file.
- Define in the policy the profiles the CI may use; `--profile` only accepts those.
- The policy folder may not contain symbolic links, and every file the configuration names must be inside it.

## Update the hash

Every change to the policy changes its hash. After merging the change in the policy repository, copy the new hash from the CI policy screen into the protected variable `JGATES_POLICY_SHA256` (repository, group or organization variable). While the two differ, the jobs fail with `POLICY_HASH_MISMATCH`, which is the intended behavior: a policy changed without the pipeline owner knowing does not run.

## Run in CI

The examples in `examples/ci` are what the policy screen generates:

- `examples/ci/github-actions.yml` for GitHub Actions;
- `examples/ci/gitlab-ci.yml` for GitLab CI.

The command in both is the same:

```bash
jgates ci --policy <policy-folder> --sarif jgates.sarif
```

The policy is checked out **outside** the project: on GitHub, two `actions/checkout` steps (`path: project` and `path: policy`) and the command runs in `project`; on GitLab, the project is `$CI_PROJECT_DIR` and the policy is cloned into `$CI_BUILDS_DIR`. A policy inside the analyzed project is refused with `POLICY_INSIDE_PROJECT`.

Other options: `--head <commit>` (default: the checkout's HEAD), `--scope full|changed` (in CI `changed` is widened to the whole commit), `--base <ref>`, `--profile <id>`, `--out <folder>`, `--fail-fast` and `--events-jsonl <file>`. Exit codes: 0 passed, 1 failed, 2 incomplete, 3 refused option or policy problem, 4 internal error, 130 cancelled.

### Install JGates in the job

JGates is not published to any registry. Install it from the repository, in a folder outside the analyzed project, and put that folder's executables on the job's `PATH`:

```bash
npm install --prefix "$HOME/jgates-tool" git+https://github.com/rodrigojager/jgates
export PATH="$HOME/jgates-tool/node_modules/.bin:$PATH"
jgates ci --policy <policy-folder>
```

On GitHub Actions, the examples install into `$RUNNER_TEMP/jgates` and add `$RUNNER_TEMP/jgates/node_modules/.bin` to `$GITHUB_PATH`, which applies to the following steps. On GitLab CI, they install into a folder under `$CI_BUILDS_DIR`, outside `$CI_PROJECT_DIR`, and run `export PATH=...` in the same `script`.

Do not use `npm install --global git+https://github.com/rodrigojager/jgates`: for a global install of a git dependency, npm links the commands to a temporary clone that it then deletes, and `jgates` disappears (see [limitations](limitacoes.en.md)). For reproducible jobs, pin a tag or commit after the `#`, or keep the tarball (`npm pack`) in an internal store and install that file; a tarball can be installed with `--global`.

## What `jgates ci` refuses

Exit 3, before anything runs:

- `--skip`, `--only`, `--waiver`, `--no-cache`, `--plan`, `--path` and `--template`: the job cannot choose its own rules;
- `--bridge-mode quick` or `offline`, and `--scope paths`;
- a policy without `JGATES_POLICY_SHA256`, with a different hash, with symbolic links or with references outside its folder;
- a quality policy that turns off or loosens the mandatory budgets;
- a commit with a submodule (gitlink) or with a symbolic link that resolves outside the checkout.

What does not enter `jgates ci` is your personal setup: it neither reads nor writes the [user key store](seguranca.en.md#the-user-key-store) or the [provider preferences and connections](semantic-gate.en.md#preferences-and-connections). The semantic review in CI uses the API keys of the pipeline environment and the provider settings of the project or of the policy.

## What comes self-reported

Some results depend on code the project controls, so they are not trusted:

| Trust | Meaning |
| --- | --- |
| trusted | The tool reads the code without running it. Counts normally. |
| self-reported | The tool executes project code (tests, linters that load project files). The result is marked `selfReported` and only approves if the policy sets `execution.trustSelfReported: true` (default: false). |
| excluded | Tools that read configuration or ignore files from the analyzed tree by themselves. The native scanners (gitleaks, trivy, osv-scanner, checkov, jscpd, dependency-cruiser, import-linter) do not run on their own in `jgates ci`: the hardened quality gate bridge already covers them. Of MegaLinter only the verified linters run, the ones listed as `trusted` or `self-reported` in `quality-gate/sidecar/config/megalinter-linters.json`; the others are left out. |

Suppressions written in the code (comments that silence a finding) become the step `jgates-ci.suppressions`, so they appear in the result instead of disappearing. Coverage reports that arrive inside the commit are refused, because the project supplied them.

## Protect the pipeline

The policy only protects if the job that runs it cannot be removed or edited by the project.

### GitLab

- Run the job from a **compliance pipeline** or from a group **Pipeline Execution Policy**, so a merge request cannot change or drop it.
- Protect the pipeline file: restrict the branches, set CODEOWNERS on `.gitlab-ci.yml` and require approval from the owners.
- Store `JGATES_POLICY_SHA256` as a protected, masked-or-hidden group variable that only maintainers edit.
- Allow the project's job token to read the policy repository (job token allowlist of the policy project).

### GitHub

- Require the workflow through a **ruleset** with required workflows at the organization level, so it runs on every pull request and cannot be bypassed in the repository.
- Put the workflow file under **CODEOWNERS** and require review from the owners.
- Store `JGATES_POLICY_SHA256` as an organization variable, and give the token that reads the policy repository read-only access to it.
- Keep `permissions` minimal: `contents: read`, plus `security-events: write` only to upload the SARIF.
