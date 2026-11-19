# JGates: common problems

Each JGates error carries a code (`error.code`), a message and a fix instruction (`error.fix`). This page gathers the most frequent ones. When in doubt, start with the readiness of the machine:

```bash
jgates status
```

`status` shows the container engine, the tools image, the age of the vulnerability data and what the current project has ready. `jgates doctor` goes further: it classifies what the plan of the project is missing as essential, optional or unused and offers to prepare it (see [getting started](getting-started.en.md)). Neither installs a scanner, a linter or a test runner on your machine, because none is needed there.

## The run ended "incomplete" (exit 2)

Incomplete is not failed: it means evidence is missing. Look at the reason of each stage in the result; the codes are in the [list of reasons](#reason-codes) below.

- **`TOOL_MISSING` and `TOOL_UNAVAILABLE`.** The tools image of this JGates version does not have the tool, or its version is outside the range the adapter accepts. Run `jgates setup` to download the image this version pins. A tool is never installed on the host.
- **`blocked` stage.** A configuration file (ESLint without `eslint.config`, for example) or the coverage provider (`@vitest/coverage-v8`, `pytest-cov`) is missing from the project. Coverage not measured is "not measured", never 0%.
- **`INPUTS_CHANGED`.** An analyzed file changed during the run. Run again without touching the code.
- **Partial architecture coverage.** The import graph did not resolve a dependency (an alias, for example). That is a coverage gap, never an approval: adjust the alias configuration.

## The container engine

- **`ENGINE_NOT_INSTALLED`.** No Docker-compatible engine was found. Install one (Docker Desktop, Rancher Desktop, Podman Desktop, or Docker Engine on Linux), or point `JGATES_CONTAINER_RUNTIME` at its executable, then run `jgates setup`.
- **`ENGINE_STOPPED`.** The engine is installed but not running. Start it (on a terminal, `jgates setup --yes` starts it when that needs no administrator password) and run again.
- **`docker` asks for `sudo` on Linux.** Your user has to join the `docker` group (`sudo usermod -aG docker $USER` and a new session). JGates does not do it for you.
- **`ENGINE_LOST`.** The engine stopped during the run, so the checks that were running are incomplete. Start it and run again.
- **`UNSUPPORTED_PLATFORM`.** The engine runs a platform other than Linux amd64 (an arm64 engine, for example). JGates uses only `linux/amd64` images in this release.
- **Low memory (`ENGINE_LOW_MEMORY`).** A step asks for 4 GB of memory and 2 CPUs by default. Raise the engine's memory (Docker Desktop: Settings, Resources; on Windows with WSL 2 the limit can also be set in `.wslconfig`) and run `jgates status` to see the new figure.
- **The image (`IMAGE_MISSING`, `IMAGE_PULL_FAILED`, `IMAGE_VERSION_MISMATCH`).** Run `jgates setup`: it downloads the image this version pins and reuses what already arrived. Behind a registry you cannot reach, use [`jgates tools export` and `import`](getting-started.en.md#offline-machines).
- **`DISK_LOW`.** The download needs room for the compressed and the unpacked image plus a margin. Free space or run `jgates clean` (see [storage and cleanup](storage.en.md)).

## Windows and WSL

- **Docker Desktop is waiting for WSL.** Docker Desktop's default backend is WSL 2, which Windows must have enabled; follow Docker's and Microsoft's installation pages, then run `jgates status`.
- **Memory.** WSL 2 takes its memory limit from the Windows side. If `ENGINE_LOW_MEMORY` appears on a machine with plenty of RAM, raise the limit in Docker Desktop's Resources or in `%UserProfile%\.wslconfig`.
- **"Git refused the repository" / `detected dubious ownership`.** The folder belongs to another account (often the Administrators group, when an elevated terminal created it), and Git refuses to read it from your user. The result then applies to the folder contents, not to a commit, and the message carries the command Git suggests: `git config --global --add safe.directory <folder>`. Run it once, or take ownership of the folder.
- **Case sensitivity.** Windows and macOS file systems ignore the case of file names, while the copy of your project in the volume is Linux and does not. An import such as `from Utils import x` that finds `utils.py` on Windows fails in the container. The failure is real: fix the case in the code, and the project then works on Linux servers too.
- **Docker Desktop terms.** Docker Desktop has license terms of its own that depend on who uses it. Rancher Desktop, Podman Desktop and Docker Engine work with JGates as well.

## Reason codes

JGates explains why something did not run with a fixed code, a text in your language and one action. The raw text of the engine only shows in the details.

- **`ENGINE_NOT_INSTALLED`**: no engine; install one or set `JGATES_CONTAINER_RUNTIME`.
- **`ENGINE_STOPPED`**: the engine is stopped; start it.
- **`ENGINE_LOW_MEMORY`**: the engine has less memory than a check of the plan needs; raise it in the engine's resources.
- **`DISK_LOW`**: not enough free space to download the tools; open Storage or free space.
- **`IMAGE_MISSING`**: the tools image was not downloaded; `jgates setup`.
- **`IMAGE_PULLING`**: the download is in progress; keep configuring.
- **`IMAGE_PULL_FAILED`**: the download stopped; `jgates setup` again.
- **`IMAGE_VERSION_MISMATCH`**: the image is of another JGates version; `jgates setup`.
- **`TOOL_MISSING`**: a tool the plan needs is not in the image; the image of this version is the only fix.
- **`ENGINE_LOST`**: the engine stopped during the run; start it and run again.
- **`UNSUPPORTED_PLATFORM`**: the engine is not Linux amd64.
- **`DEPENDENCIES_NOT_READY`**: the dependencies of a component are not prepared; `jgates deps status`.
- **`DEPENDENCIES_FAILED`**: installing them failed; read the log and `jgates deps prepare` again.
- **`DATA_MISSING`**: a vulnerability database was never downloaded; `jgates tools update-data`.
- **`STEP_MEMORY_LIMIT`**. A check reached its memory limit and stopped before it could finish. Lower the number of simultaneous checks in the execution settings and run again.
- **`DATA_STALE`**: it is older than `execution.dataMaxAgeDays`; `jgates tools update-data`.
- **`CUSTOMER_SUPPLIED`**: CodeQL is yours to prepare; `jgates tools prepare-codeql`.
- **`EXTENSION_OUTDATED`**: your own image changed; `jgates tools build-extension`.
- **`SERVICES_NOT_READY`**: a service did not become healthy in time; see [services](services.en.md).
- **`SERVICES_REQUIRED`**: a check needs services and none is set up; see [services](services.en.md).
- **`NOT_APPLICABLE_TO_PROJECT`**: the check does not apply to this project; it never blocks.
- **`MUTATION_TESTS_FAILING`**: mutation testing did not run because the project's own tests fail; it needs them green to start. Fix the failing tests and run again.
- **`HOST_EXECUTION_REFUSED`**: a step would have run outside the container, so JGates refused it. There is no action for you: report it as a defect.

## The plan is refused (exit 3)

- **`PLAN_EMPTY`.** Nothing was selected. Review the profile, the scope and `--only`.
- **`PLAN_NOT_APPROVABLE`.** The plan has a block (`CONFIG_INVALID` with `file:line`, a requirement without coverage, `EVIDENCE_MISSING` on a generic command). Run `jgates plan` and read "How to resolve".
- **`PLAN_STALE`, `PLAN_TAMPERED`.** A saved plan (`--plan`) no longer matches the project or was altered. Generate the plan again.
- **`PLAN_WITH_FLAGS`.** `--plan` does not combine with the flags that build the plan.
- **`OPTION_NOT_SUPPORTED`.** In a project with `jgates.yml`, the old flags (`--bridge-mode` and the like) do not apply; choose by profile, `--skip` or `--only`.
- **`CONFIG_EXISTS`.** There is already a configuration. `jgates init` does not overwrite it.

```bash
jgates config validate
jgates plan
```

## The configuration does not save

- **`REVISION_CONFLICT`.** The file changed on disk since you opened it. The interface shows the base, your and the current versions; choose which to keep. From the CLI, pass the new `--if-match`.
- **`STRUCTURED_EDIT_UNAVAILABLE`.** The structured TOML form is unavailable; the text remains editable.
- **`GOVERNED_LOCKED`.** The server detected governed mode (`JGATES_POLICY_DIR`). Editing is blocked on purpose.
- **Visual edit refused in JS.** A dynamic configuration (function, spread, computed import) can only be edited as text.

## The interface

- Ask for a new link with `jgates ui`; the entry link is single-use and valid for 10 minutes. The server answers on loopback only, and a proxy or a different host name gets 421.
- One run at a time: the second gets 409 while the first has not finished.
- The controls marked as unavailable, and the component filter that does not show up are in [limitations](limitations.en.md).

## Disk space and cache

- Run `jgates status` for the space JGates uses and `jgates clean --dry-run` to see what is not in use (see [storage and cleanup](storage.en.md)).
- Run `jgates gc --dry-run` to see what the retention of runs would delete (see [data folder](data-folder.en.md)).
- A result "reused" from an earlier execution comes from the cache. To force a real execution, use `jgates run --no-cache`.
- The largest items are the tools image and the dependency volumes. Deleting the vulnerability data only makes the next `jgates setup` or `jgates tools update-data` download it again.

## macOS

macOS was not tested on a real machine (see [limitations](limitations.en.md)). If something fails, note the command, the `runId` and the output of `jgates status`.
