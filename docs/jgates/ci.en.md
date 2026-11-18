# JGates: CI

In CI the rules are not decided by the code being checked. `jgates ci` takes them from a **policy repository** kept by whoever controls the pipeline, pinned by a hash, and refuses everything a job could use to loosen the gate. This page explains the model, how to set the policy up, what `jgates ci` refuses or trusts less, and how to protect the pipeline on GitLab and GitHub.

## The model

- **Locally** you edit everything: `jgates.yml`, profiles, templates, waivers (`.jgates/waivers.json`). It is your work area, and `jgates run` obeys it.
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

`jgates ci` is unchanged by the project waivers: it applies only the waivers of the pinned policy, never the project's `.jgates/waivers.json`, and it refuses `--waiver` and `--no-waivers`. For a deploy flow outside the governed mode that must accept no waiver at all, run `jgates run --no-waivers`.

The policy is checked out **outside** the project: on GitHub, two `actions/checkout` steps (`path: project` and `path: policy`) and the command runs in `project`; on GitLab, the project is `$CI_PROJECT_DIR` and the policy is cloned into `$CI_BUILDS_DIR`. A policy inside the analyzed project is refused with `POLICY_INSIDE_PROJECT`.

Other options: `--head <commit>` (default: the checkout's HEAD), `--scope full|changed` (in CI `changed` is widened to the whole commit), `--base <ref>`, `--profile <id>`, `--out <folder>`, `--fail-fast` and `--events-jsonl <file>`. Exit codes: 0 passed, 1 failed, 2 incomplete, 3 refused option or policy problem, 4 internal error, 130 cancelled.

### The job runs in the tools image

JGates is not published to any package registry, and nothing is installed in the job. The job runs **inside the JGates tools image**, pinned by digest, which already holds `jgates` and every tool. Keep the image in a registry your pipeline can read and name it by digest, never by a movable tag:

```yaml
# GitHub Actions
container: <registry>/jgates-tools@sha256:<digest>
# GitLab CI
# image: <registry>/jgates-tools@sha256:<digest>
```

In the job JGates is in image mode: the same adapter commands run natively inside the container. The examples also set `JGATES_TOOLS_IMAGE_DIGEST` to the digest of that image, so a policy can check that the job runs the image this JGates version pins (see below). The tools image is not published to a registry yet; until it is, build or import it into your own registry (see [getting started](getting-started.en.md#offline-machines)).

### Images and extensions

The policy owner decides whether the project may bring its own tool images, with `execution.extensionImage` in the `jgates.yml` of the policy repository:

```yaml
# jgates.yml of the policy repository
execution:
  extensionImage: pinned   # forbid | pinned; absent: the policy does not look at extensions
```

- `forbid`: any extension is refused: the `.jgates/image` of the analyzed commit and any tool that would run on an image other than the tools image (`EXTENSION_IMAGE_FORBIDDEN`).
- `pinned`: only ready images named by digest (`name@sha256:...`) are accepted. An image built from the project's Dockerfile has no fixed digest and is refused (`EXTENSION_IMAGE_UNPINNED`), and the tools image the job runs in must be the one this JGates pins: its digest comes from the image itself (`image.json`) or from `JGATES_TOOLS_IMAGE_DIGEST`, and a different one is refused (`TOOLS_IMAGE_DIGEST_MISMATCH`; `TOOLS_IMAGE_DIGEST_UNKNOWN` when it cannot be known).

The services of the project follow the policy too: a host bind mount, a privileged service and the other [host effects](services.en.md) are refused unless the policy lists them in `services.allowHostEffects`, and `writableBinds` is never accepted.

## What `jgates ci` refuses

Exit 3, before anything runs:

- `--skip`, `--only`, `--waiver`, `--no-waivers`, `--no-cache`, `--plan`, `--path` and `--template`: the job cannot choose its own rules;
- `--bridge-mode quick` or `offline`, and `--scope paths`;
- a policy without `JGATES_POLICY_SHA256`, with a different hash, with symbolic links or with references outside its folder;
- a quality policy that turns off or loosens the mandatory budgets;
- a commit with a submodule (gitlink) or with a symbolic link that resolves outside the checkout;
- an extension image, or a tools image other than the pinned one, when the policy sets `execution.extensionImage` (see [images and extensions](#images-and-extensions)).

What does not enter `jgates ci` is your personal setup: it neither reads nor writes the [user key store](security.en.md#the-user-key-store) or the [provider preferences and connections](semantic-gate.en.md#preferences-and-connections). The semantic review in CI uses the API keys of the pipeline environment and the provider settings of the project or of the policy.

## What comes self-reported

Some results depend on code the project controls, so they are not trusted:

| Trust | Meaning |
| --- | --- |
| trusted | The tool reads the code without running it. Counts normally. |
| self-reported | The tool executes project code (tests, linters that load project files). The result is marked `selfReported` and only approves if the policy sets `execution.trustSelfReported: true` (default: false). |
| excluded | Tools that read configuration or ignore files from the analyzed tree by themselves. The native scanners (gitleaks, trivy, osv-scanner, checkov, jscpd, dependency-cruiser, import-linter) do not run on their own in `jgates ci`: the hardened quality gate bridge already covers them. MegaLinter does not run: the tools image has none, and its linters are JGates tools of their own, each `trusted` or `self-reported` by its descriptor (the bridge's `megalinter` subcheck is always off and is not reported as missing). |

Suppressions written in the code (comments that silence a finding) become the step `jgates-ci.suppressions`, so they appear in the result instead of disappearing. Coverage reports that arrive inside the commit are refused, because the project supplied them.

## Review findings and exit codes

The Semgrep pack has four classes: `ERROR`, `WARNING`, ordinary `INFO` and **Review**.
Review findings appear under **To review**, separately from blocking and informational findings. They never block
and never change the exit code, including governed CI, any profile and any rigor. **Mark as reviewed** is a
per-occurrence waiver action, not approval of an ASVS requirement, and Review alone never produces
"approved with N waivers". Governed CI still accepts only the pinned policy's waivers, never the project's.
See [Quality integrations](quality-integrations.en.md) and [the ASVS map](asvs-coverage.en.md).

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
