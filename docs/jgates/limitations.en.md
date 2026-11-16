# JGates: known limitations

This page gathers what JGates does not do yet, what was not tested and the controls the interface shows as unavailable. Each item was checked against the code of this version. An item missing here does not mean it works: it means nobody recorded it.

## What the container-first design does not cover

- **Only `linux/amd64`.** The tools image and every step are Linux on amd64. An engine that runs another platform (an arm64 engine, for example) is reported as `UNSUPPORTED_PLATFORM`. Nothing was done for macOS or arm64 hosts.
- **A container engine is required.** There is no mode that runs the checks on the host. If no engine is installed or it is stopped, JGates says so (`ENGINE_NOT_INSTALLED`, `ENGINE_STOPPED`) and the checks do not run; they never come out as passed. The exception is JGates running inside the tools image itself (in a CI job whose container is that image).
- **Customer PII fix tools still run on the host.** The tools you declare in `.jgates/pii.yml` for `jgates pii fix` are your own programs, and they run on your machine, over a temporary copy of the files, with the protocol described in [security](security.en.md#personal-data-in-the-project-files). Only JGates's built-in detector runs in the tools image.
- **CodeQL is not bundled.** Its terms do not allow redistribution. You accept them and prepare it yourself with `jgates tools prepare-codeql`; until then the `dataflow` capability is `incomplete`. No real CodeQL runs in the JGates tests, so every CodeQL row of the matrix is `customer-setup-required`.
- **The OSV mirror covers npm, PyPI, Go, crates.io and NuGet only.** A dependency of another ecosystem is not covered by the offline OSV data; do not read a clean result as proof for it.
- **Trivy uses its embedded checks.** The checks bundle that Trivy would download is not used; the misconfiguration checks that ship inside the binary are, with the vulnerability database from the `jgates-data` volume.
- **Playwright e2e runs Chromium only.** The browsers of the project's Playwright version are fetched into the toolchain volume, and JGates fetches Chromium; Firefox and WebKit projects are not run.
- **The first download is large.** The image is about 2 GB to download and around 6 GB unpacked, plus the dependencies of each project and the vulnerability databases. See [storage and cleanup](storage.en.md).
- **Install scripts run, but in the container.** The dependency step runs the install scripts of the packages (npm `postinstall`, Python build backends) inside the container, with the network on. They cannot touch your project or machine, but they do run, and the review says so. See [security](security.en.md#shared-caches-and-install-scripts).
- **Case sensitivity.** The copy of the project in the volume is case-sensitive, like Linux. A project that only works on a case-insensitive file system fails in the container (see [common problems](troubleshooting.en.md#windows-and-wsl)).

## What was not tested

- **macOS.** No test ran on a real Mac. The compatibility matrix shows "not tested on a real machine" in the macOS column for every adapter. The data folder path on macOS (`~/Library/Application Support/jgates`) exists in the code and is covered by a unit test only.
- **Windows.** The automatic suite runs on Linux. On one Windows 10 machine with Docker Desktop, the first-run flow was checked by hand: the global install from the `npm pack` tarball (with `jgates` on the `Path`), `init`, `plan`, `run` and `ui`. The suite itself still has failures of its own on Windows (paths compared with a different letter case, checks that need POSIX: `0600` permissions, cancellation by process group, symlinks); the tests that depend on Windows are marked and skip elsewhere, with the reason. The `winget` command of the Docker recipe was not run. Before relying on JGates on another Windows machine, run the suite there (`node scripts/smoke-install.mjs` repeats the installation proof).
- **Engines other than Docker.** The checks use the Docker command line. Rancher Desktop and Podman Desktop are expected to work through their `docker` command or `JGATES_CONTAINER_RUNTIME`, but only Docker was exercised.
- **Screen reader.** Accessibility was checked with axe (WCAG 2.2 AA, no critical or serious violation in the light, dark and system themes), with the keyboard and with reduced motion. No real screen reader was used.
- **Direct installation from GitHub.** `npm install --prefix <folder> git+https://github.com/rodrigojager/jgates` and `npm install git+https://github.com/rodrigojager/jgates` inside a project were checked by hand with a local clone (`git+file://`, npm 11), including in a folder with a space in its path: `jgates --version` worked. They are not in the automatic suite, and the download from GitHub itself was not exercised. The path the suite tests is the `npm pack` tarball (see [getting started](getting-started.en.md)).
- **The tools image is not published yet.** Until it is, the pin file holds the local image `jgates-tools:dev`; `jgates tools export` and `import` move an image between machines.

## Global installation from GitHub

`npm install --global git+https://github.com/rodrigojager/jgates` **does not work**. The problem is npm's, not JGates': for a global install of a git dependency, npm links the global package to a temporary clone in its cache and then deletes that clone, so the `jgates`, `quality-gate` and `semantic-gate` commands point at nothing. It also happens with `--allow-scripts`. The JGates `prepare` step finishes without error in this case. Use one of these forms instead:

- in a folder of its own: `npm install --prefix <folder> git+https://github.com/rodrigojager/jgates`, with `<folder>/node_modules/.bin` on the `PATH`;
- inside a project: `npm install git+https://github.com/rodrigojager/jgates`, and the commands through `npx`;
- global: `npm pack` in a clone, followed by `npm install --global ./jgates-<version>.tgz`.

## Java and PHP: SAST only

JGates recognizes Java and PHP but has no stack for them. What runs on a Java or PHP project is the checks that work on any project (secrets, file size, personal data, duplication, dependency and infrastructure scans) and, when SAST is on (not under the Essential profile), Semgrep with the JGates rule pack, which has rules for eight languages: JavaScript, TypeScript, Python, Go, C#, Rust, Java and PHP. What stays missing for Java and PHP:

- no component template, lint, type check, tests, coverage, mutation testing or dependency preparation;
- the offline advisory data covers npm, PyPI, Go, crates.io and NuGet only, so vulnerable Maven or Composer dependencies are found only by what Trivy reads;
- template files (Jinja, Blade, Razor, EJS, Go templates, Vue files) are not scanned, and the pack reads HTML and configuration files only in the formats its rules name;
- a pack rule follows a value only inside one function: a value that crosses functions or files is not followed, and each family models the libraries named in its rule file's header, so most checks see one way of breaking a requirement (they are partial, and the ASVS map says what each misses);
- a language the pack has no rule for (Kotlin, Ruby and others) is named in the plan as a limitation of the Semgrep step, and the result records how many files of each language the scan covered.

In-image mode (JGates running inside the tools image, as in a CI container) uses the copy of the pack that sits in the image: it keeps the older, smaller pack until the image is rebuilt. A run started from the host always uses the pack of the installed JGates.

## Semantic gate

The semantic gate is optional, stays on the host and is described in [semantic gate](semantic-gate.en.md). Every test uses a fake provider, to spend no tokens. The **smoke with a real provider is pending**: no real review was run end to end with a real key. The behavior on timeout, exhausted budget and unavailable provider is covered by the fake provider.

## Licenses

`THIRD_PARTY_NOTICES.md` (at the repository root) lists every component. For whoever distributes an image or a package, these points matter:

- **The legacy sidecar image is AGPL-3.0.** The sidecar of the old quality gate starts from the MegaLinter image. JGates no longer builds it or uses it for the plans of `jgates run`, but `jgates ci` and the `quality-gate` command still use that layer. It runs as a separate process, not linked to JGates, but redistributing that image requires the source offer and the license text of MegaLinter and of the tools it bundles.
- **Semgrep registry rules** carry the Semgrep Rules License v1.0, which restricts use to internal business purposes. The tools image does not contain them and JGates does not distribute them; a project that enables them accepts those terms.
- **Vulnerability databases.** The Trivy database and the OSV.dev data have their own terms and are downloaded into a volume when you run `jgates setup` or `jgates tools update-data`, never stored in the repository.
- **CodeQL** is under GitHub's terms, which you accept when you prepare it.
- **Licenses not verified offline.** The licenses of the scanners in the images (Gitleaks, Trivy, OSV-Scanner, Checkov, editorconfig-checker, ls-lint, protolint and others) come from what the upstream project declares and are marked "upstream, not re-verified offline" in `THIRD_PARTY_NOTICES.md`. Check the upstream `LICENSE` before redistributing an image.
- `axe-core` and `@axe-core/playwright` are MPL-2.0 and serve the tests only; they do not enter `dist/`.

## Controls marked as unavailable in the interface

Some controls write the value to the file, but the engine does not read it yet. The interface does not hide them: it marks each one with the `data-control-unavailable` attribute and shows the reason in the field. They are:

- `execution.runner` (Configuration, Execution): each instance's runner comes from the tool binding, and the plan has no place to receive a default without changing the hash.
- The four `execution.budgets.*` limits (Configuration, Execution): written, not applied.
- `security.block-from` (Configuration, Profiles, policy): blocking by severity is decided in the quality-gate bridge, which does not read this rule.
- `missing-check.block` (Configuration, Profiles, policy): the same for blocking on a missing check.

What already works: `execution.failFast` (acts as `--fail-fast`), `execution.dataMaxAgeDays` and `coverage.minimum`, with a minimum per component. Without a `coverage.minimum`, the component's own `fail_under` (`.coveragerc`, `pyproject.toml`, `setup.cfg` or `tox.ini`) is the minimum.

## Result and interface

- **Filter by component in the findings.** The findings list of the result screen would show a component filter only if some finding had `component`; the `finding` in `result.json` has no such field (only the metrics do), so the filter never appears. Adding it needs a new field in the result and the adapters filling it.
- **Governed mode detected by a variable.** The interface knows the mode is governed from the `JGATES_POLICY_DIR` variable in the server environment. In that mode the fields are locked and the write routes answer 403 `GOVERNED_LOCKED`.
- **Two plan review blocks only in the interface.** A required template without a component and an unavailable tool or architecture block the run button, but the CLI and `POST /api/runs` still accept the plan.
- **Batch saving.** A tool area saves one file at a time.
- **Policy mode.** With `jgates ui --policy <folder>` the interface edits the CI policy folder; the screens that validate a project (plan and run) are unavailable in that mode (409 `POLICY_MODE_UNAVAILABLE`).

## CI

- **Scope of `jgates ci`.** `jgates ci` runs inside the container of the job (the tools image, pinned by digest). The scanners that read configuration or ignore files from the analyzed tree are left out of it, and the layer of the legacy quality gate bridge, with its packaged and trusted configuration, covers them. Of MegaLinter only the verified linters run, listed in `quality-gate/sidecar/config/megalinter-linters.json`.
- **Self-reported results.** Tools that execute project code produce a `selfReported` result, which only approves if the policy trusts it (`execution.trustSelfReported`, default `false`).
- **Activation in the policy templates.** In the policy repository use the `always` activation; activation by file lets the project turn the tool on or off.
- **No proof on real pipelines.** The examples in `examples/ci` are tested as text and through the command; no GitHub or GitLab pipeline ran them end to end, and the tools image has not been published to a registry yet.

## Adapters

- **Bridge (quality-bridge).** The bridge no longer takes part in the plans of `jgates run`; it serves `jgates ci`. Its capabilities are `declared` (declared, no proof) in the matrix.
- **ESLint in a monorepo.** The ESLint from the templates runs at the workspace root, not in each component's folder.
- **Go, Rust and .NET** have partial support; the list of what is not covered is in the [compatibility](compatibility.en.md) matrix.
- **Your own tools** are never counted as validated capabilities, and a per-instance `timeoutSeconds` is ignored by some external adapters.

## Related

[Security](security.en.md) · [common problems](troubleshooting.en.md)
