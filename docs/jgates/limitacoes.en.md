# JGates: known limitations

This page gathers what JGates does not do yet, what was not tested and the controls the interface shows as unavailable. Each item was checked against the code of this version. An item missing here does not mean it works: it means nobody recorded it.

## What was not tested

- **macOS.** No test ran on a real Mac. The compatibility matrix shows "not tested on a real machine" in the macOS column for every adapter. The data folder path on macOS (`~/Library/Application Support/jgates`) exists in the code and is covered by a unit test only.
- **Windows.** The automatic suite runs on Linux; JGates has not run on Windows yet. The tests that depend on Windows are marked and skip elsewhere, with the reason; the ones that need POSIX (`0600` permissions, cancellation by process group, symlinks) have no equivalent there. Before relying on JGates on Windows, run the suite on that machine (`node scripts/smoke-install.mjs` repeats the installation proof).
- **Screen reader.** Accessibility was checked with axe (WCAG 2.2 AA, no critical or serious violation in the light, dark and system themes), with the keyboard and with reduced motion. No real screen reader was used.
- **Direct installation from GitHub.** `npm install --prefix <folder> git+https://github.com/rodrigojager/jgates` and `npm install git+https://github.com/rodrigojager/jgates` inside a project were checked by hand with a local clone (`git+file://`, npm 11), including in a folder with a space in its path: `jgates --version` and `jgates doctor --json` worked. They are not in the automatic suite, and the download from GitHub itself was not exercised. The path the suite tests is the `npm pack` tarball (see [getting started](primeiros-passos.en.md)).

## Global installation from GitHub

`npm install --global git+https://github.com/rodrigojager/jgates` **does not work**. The problem is npm's, not JGates': for a global install of a git dependency, npm links the global package to a temporary clone in its cache and then deletes that clone, so the `jgates`, `quality-gate` and `semantic-gate` commands point at nothing. It also happens with `--allow-scripts`. The JGates `prepare` step finishes without error in this case. Use one of these forms instead:

- in a folder of its own: `npm install --prefix <folder> git+https://github.com/rodrigojager/jgates`, with `<folder>/node_modules/.bin` on the `PATH`;
- inside a project: `npm install git+https://github.com/rodrigojager/jgates`, and the commands through `npx`;
- global: `npm pack` in a clone, followed by `npm install --global ./jgates-<version>.tgz`.

## Semantic gate

The semantic gate is optional and described in [semantic gate](semantic-gate.en.md). Every test uses a fake provider, to spend no tokens. The **smoke with a real provider is pending**: no real review was run end to end with a real key. The behavior on timeout, exhausted budget and unavailable provider is covered by the fake provider.

## Licenses

`THIRD_PARTY_NOTICES.md` (at the repository root) lists every component. For whoever distributes an image or a package, these points matter:

- **MegaLinter is AGPL-3.0.** The sidecar image starts from the MegaLinter image. It runs as a separate process, not linked to JGates, but redistributing the image requires the source offer and the license text of MegaLinter and of the tools it bundles.
- **Semgrep registry rules** carry the Semgrep Rules License v1.0, which restricts use to internal business purposes. JGates does not distribute them; a project that enables them accepts those terms.
- **Vulnerability databases.** The Trivy database and the OSV.dev data have their own terms and are downloaded at run time, never stored in the repository.
- **Licenses not verified offline.** The licenses of the scanners in the images (Gitleaks, Trivy, OSV-Scanner, Checkov, editorconfig-checker, ls-lint, protolint and others) come from what the upstream project declares and are marked "upstream, not re-verified offline" in `THIRD_PARTY_NOTICES.md`. Check the upstream `LICENSE` before redistributing an image.
- `axe-core` and `@axe-core/playwright` are MPL-2.0 and serve the tests only; they do not enter `dist/`.

## Controls marked as unavailable in the interface

Some controls write the value to the file, but the engine does not read it yet. The interface does not hide them: it marks each one with the `data-control-unavailable` attribute and shows the reason in the field. They are:

- `execution.runner` (Configuration, Execution): each instance's runner comes from the tool binding, and the plan has no place to receive a default without changing the hash.
- The four `execution.budgets.*` limits (Configuration, Execution): written, not applied.
- `security.block-from` (Configuration, Profiles, policy): blocking by severity is decided in the quality-gate bridge, which does not read this rule.
- `missing-check.block` (Configuration, Profiles, policy): the same for blocking on a missing check.

What already works: `execution.failFast` (acts as `--fail-fast`) and `coverage.minimum`, with a minimum per component.
## Result and interface

- **Filter by component in the findings.** The findings list of the result screen would show a component filter only if some finding had `component`; the `finding` in `result.json` has no such field (only the metrics do), so the filter never appears. Adding it needs a new field in the result and the adapters filling it.
- **Governed mode detected by a variable.** The interface knows the mode is governed from the `JGATES_POLICY_DIR` variable in the server environment. In that mode the fields are locked and the write routes answer 403 `GOVERNED_LOCKED`.
- **Two plan review blocks only in the interface.** A required template without a component and an unavailable tool or architecture block the run button, but the CLI and `POST /api/runs` still accept the plan.
- **Batch saving.** A tool area saves one file at a time.
- **Policy mode.** With `jgates ui --policy <folder>` the interface edits the CI policy folder; the screens that validate a project (plan and run) are unavailable in that mode (409 `POLICY_MODE_UNAVAILABLE`).

## CI

- **Scope of `jgates ci`.** The native scanners (gitleaks, trivy, osv-scanner, checkov, jscpd, dependency-cruiser, import-linter) are left out of `jgates ci`: the hardened quality gate bridge covers them. Of MegaLinter only the verified linters run, listed in `quality-gate/sidecar/config/megalinter-linters.json`.
- **Self-reported results.** Tools that execute project code produce a `selfReported` result, which only approves if the policy trusts it (`execution.trustSelfReported`, default `false`).
- **Activation in the policy templates.** In the policy repository use the `always` activation; activation by file lets the project turn the tool on or off.
- **No proof on real pipelines.** The examples in `examples/ci` are tested as text and through the command; no GitHub or GitLab pipeline ran them end to end.

## Adapters and the bridge

- **Bridge (quality-bridge).** Of the bridge's nine capabilities, eight are `declared` (declared, no proof) in the matrix: only `file-size` has a test in the default suite. The others need the Docker smoke of the sidecar image, which was not done.
- **Trivy.** The cache covers only the vulnerability database; the Java database and the checks bundle are still downloaded on every run.
- **ESLint in a monorepo.** The ESLint from the templates runs at the workspace root, not in each component's folder.
- **Go, Rust and .NET** have partial support; the list of what is not covered is in the [compatibility](compatibilidade.en.md) matrix.

## Related

[Security](seguranca.en.md) · [common problems](problemas.en.md)
