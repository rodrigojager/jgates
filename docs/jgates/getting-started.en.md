# JGates: getting started

JGates validates a repository before an approval: it discovers the components, builds a plan you can review, runs the checks and writes a result with the decision and the evidence. JGates brings together the quality gate (`quality-gate`) and the semantic gate (`semantic-gate`); the main command is `jgates`.

Every check runs inside a container of one complete JGates tools image. Your project is copied into a Docker volume and is never modified; its dependencies are installed into volumes of their own. So the only thing you install on your machine is JGates and a container engine.

This page goes from zero to the first validation. The other pages in this folder: [templates and profiles](templates-and-profiles.en.md), [editor](editor.en.md), [adapters](adapters.en.md) (with the [compatibility matrix](compatibility.en.md)), [services](services.en.md), [your own tools](extension.en.md), [storage and cleanup](storage.en.md) and [common problems](troubleshooting.en.md).

## What you need

- Node 22 or newer and Git, to run JGates itself.
- A Docker-compatible container engine, running on a `linux/amd64` system. Docker Desktop, Rancher Desktop, Podman Desktop, or Docker Engine on Linux all work. Docker Desktop has license terms of its own that depend on who uses it and how; read them on Docker's site, or choose one of the alternatives. To use another executable than `docker`, set `JGATES_CONTAINER_RUNTIME`.
- Memory for the engine: 4 GB or more is recommended (a step asks for 4 GB and 2 CPUs by default), and room on the disk for the tools image: about 2 GB to download and around 6 GB unpacked.
- Nothing else. No scanner, linter, test runner or language runtime of the project is installed on your machine: they all come in the tools image.

On Windows, Docker Desktop needs WSL 2; see [common problems](troubleshooting.en.md#windows-and-wsl). Linux is the tested system; the first-run flow was also checked by hand on Windows 10 (see [limitations](limitations.en.md)), and macOS was not tested on a real Mac.

## Install JGates

JGates is not published to the npm registry: it is installed from the repository on GitHub. In an empty folder (or in your project's folder):

```bash
npm install git+https://github.com/rodrigojager/jgates
npx jgates --version
```

npm downloads the repository and runs the `prepare` script, which compiles JGates and the interface; this takes a few minutes. From there the commands are `npx jgates`, `npx quality-gate` and `npx semantic-gate` (or `node_modules/.bin/...`). The examples below write `jgates` directly, as if it were on the `PATH`.

To have `jgates` on the `PATH` without depending on a project, install it into a folder of its own and put that folder's executables on the `PATH` (on Windows, add that folder's `node_modules\.bin` to `Path`):

```bash
npm install --prefix "$HOME/jgates-tool" git+https://github.com/rodrigojager/jgates
export PATH="$HOME/jgates-tool/node_modules/.bin:$PATH"
jgates help
```

For a global installation, or to install on a machine that cannot reach GitHub, pack a clone and install the generated file. This is the path covered by the test `tests/install.test.js` and the script `scripts/smoke-install.mjs`, including in a folder with a space and accents in its path:

```bash
git clone https://github.com/rodrigojager/jgates.git
cd jgates
npm install
npm pack
npm install --global ./jgates-0.3.0.tgz
jgates help
```

On Windows, `npm install --global` puts `jgates`, `quality-gate` and `semantic-gate` in `%APPDATA%\npm`, a folder the Node.js installer already adds to `Path`: open a new terminal and `jgates --version` answers from any folder. To update, run `jgates update`; in a clone, run `npm pack` again and repeat the `npm install --global` with the new file. After an update, `jgates setup` downloads the tools of the new version.

`npm install --global git+https://github.com/rodrigojager/jgates` **does not work**: for a global install of a git dependency, npm links the commands to a temporary clone that it then deletes. Use the folder with `--prefix`, the installation inside the project or the tarball (see [limitations](limitations.en.md)).

## Prepare the machine

```bash
jgates setup
jgates status
```

`setup` prepares this machine in five steps and prints each one: **Engine** (finds the container engine and checks that it answers), **Disk** (checks there is room for the download plus a margin), **Image** (downloads the tools image at the version this JGates pins, with progress), **Volumes** (creates the shared volumes) and **Data** (downloads the vulnerability databases). It is safe to run again: a ready machine finishes in seconds. It exits with 0 when the machine is ready and 2 when it is not, and each reason has a code and an action (see the [list of reasons](troubleshooting.en.md#reason-codes)).

- `--yes` starts a stopped engine when its start command needs no administrator password, and waits for it.
- `--no-data` skips the vulnerability databases; the checks that need them stay `incomplete` until you download them (see below).
- `--from <file>` loads the image from a file written by `jgates tools export` instead of downloading it (see [offline machines](#offline-machines)).

`status` answers "can this machine run checks?" on one screen: the engine (version, memory, CPUs), the tools image and its version, the extension images, the age of each vulnerability database against its limit, the dependencies and services of the current workspace and the disk JGates uses. It changes nothing.

`doctor` keeps its own flow: it diagnoses the same things, classifies what is missing as essential, optional or unused for the plan of the current project, offers to prepare it (on a terminal, or with `--fix`), and prints the status block at the end. It never installs a tool on your machine; what it may offer is to install or start the container engine (the system's official command, shown before it runs and never run silently), to download the tools image and to prepare data.

```bash
jgates doctor
```

A recipe that installs Docker is shown with the system's command (`apt-get` on Debian and Ubuntu, `dnf` on Fedora, `brew` on macOS, `winget` on Windows) and runs only after a "y" on the terminal; the command itself asks for `sudo`, and `--yes` does not cover it. The macOS and Windows commands were not tested on those machines yet.

## The first-run guided setup

In the interface (`jgates ui`), a project that has not finished setting up opens the **Guided setup** (`#/setup`) by itself. It has six steps and each one shows the equivalent command:

1. **Docker**: checks the engine and, when it is missing or stopped, shows the commands to install or start it (nothing runs without you) and the alternatives to Docker Desktop. It checks again every 3 seconds while the page is open.
2. **Tools**: downloads the JGates tools image, with progress, speed and time left. The download goes on in the background, so you can move to the next steps; if the server restarts, download again and what already arrived is reused. The step also shows the disk space needed and the age of the security data.
3. **Project**: shows what discovery found (components, language, framework, package manager, language version, lockfile) and asks only about what is ambiguous. It also offers the compose [services](services.en.md) of the project.
4. **Profile**: Minimal, Balanced or Strict. Strict turns on everything that has a tool for this project; what does not apply shows with its reason and never blocks. You can preview the file before saving, and adjust each capability later in Configuration, without editing YAML.
5. **Dependencies**: prepares the project's dependencies in volumes (the first time takes a few minutes), or waits for the tools to finish downloading.
6. **Review**: lists the plan (how many checks will run, which use the network) and starts the first validation, now or as soon as the preparation ends.

**Redo the guided setup** (on the Workspace screen or at `#/setup`) opens it again with your current values. Everything the wizard does has a command: `jgates setup`, `jgates init`, `jgates deps prepare` and `jgates run`.

## Discover and configure

```bash
jgates discover
jgates init --profile standard --no-interactive
jgates config validate
```

- `discover` reads only the project's files (nothing is executed) and lists the components and languages: in the example repository, `api` (Python), `web` and `libs/shared` (TypeScript).
- `init` creates `jgates.yml` and `.jgates/profiles.yml` with the profile you choose (`minimal`, `standard` or `strict`; the default is `standard`) and the templates of the stacks it found. If a configuration already exists it refuses with `CONFIG_EXISTS` and changes nothing.
- `config validate` checks the syntax, schema and references of the files, and names the file and line of each problem.

The project files are versioned with the code (`jgates.yml`, `.jgates/*.yml`, `.jgates/lock.json`). What JGates produces (runs, drafts, plans) goes to the [data folder](data-folder.en.md), outside the project, and the heavy parts live in the container engine.

## Prepare what the checks need

### The project's dependencies

Tests, type checks and builds need the project's own dependencies. The packages in your `.venv` or `node_modules` are built for your system and cannot run in a Linux container, so JGates installs them itself, from your manifests and lockfiles, into one volume per component (`jgates-<workspace>-deps-<component>`). Nothing is written to the project, and the install scripts of the packages run inside the container.

```bash
jgates deps status
jgates deps prepare
jgates deps clean
```

- `deps status` shows, per component, whether the dependencies are ready, outdated, missing or failed, and the manager JGates detected (pip, uv, poetry, pdm, pipenv, npm, yarn, pnpm, go, cargo, dotnet). `--component <id>` limits it to one.
- `deps prepare` installs them. A run also prepares what it needs; this command is for doing it ahead of time. The volume has a key made of the lockfile, the manifest, the manager, the language version and the image version: when the key does not change nothing is reinstalled, and a failed install never replaces a good volume.
- `deps clean` deletes the dependency volumes of the workspace.
- A component without a lockfile installs from the manifest and shows a note ("versions may vary"); in `jgates ci` that is a blocker.
- When a component pins a language version other than the image's default (`.python-version`, `.nvmrc`, `go.mod`, `rust-toolchain.toml`, `global.json`), JGates installs it into the shared volume `jgates-toolchains`. If it cannot be obtained, the checks of that component are not ready, with the reason and an action. To use the image's default version this time, set `JGATES_TOOLCHAIN_DEFAULT` to `1` (every language) or to a list such as `python,node`.
- For a private registry, declare it in `.jgates/dependencies.yml`: the URL and the **name** of the secret that holds the token, never the token. The value comes from your [key store](security.en.md#the-user-key-store) or from the CI environment, reaches the install container only in memory and in `/tmp`, and is masked in logs.

```yaml
# .jgates/dependencies.yml
schemaVersion: 1
registries:
  node:
    url: https://registry.example.org/npm/
    tokenSecret: NPM_TOKEN
```

### Advisory data

Vulnerability scanners run without network, so the databases live in the volume `jgates-data` and are refreshed apart from the run:

```bash
jgates tools update-data
```

It refreshes the Trivy, OSV, Go and RustSec databases and records when each was fetched; the result records it too. A database older than the limit (7 days by default, `execution.dataMaxAgeDays` in `jgates.yml`) makes the checks that use it `incomplete` with `DATA_STALE`, and one never downloaded with `DATA_MISSING`: a scan with old or no data is never reported as clean. The policy of a governed run can require a lower limit. `jgates setup` already downloads them, and `jgates status` shows the age of each. The OSV mirror covers npm, PyPI, Go, crates.io and NuGet only.

### CodeQL

CodeQL is not in the tools image: its terms do not allow redistributing it. If you want the `dataflow` capability, you prepare it yourself:

```bash
jgates tools prepare-codeql --accept-terms
```

The command asks you to accept GitHub's CodeQL terms, records the acceptance with its date in the JGates home (never in the project), downloads the bundle of the official release, checks its SHA-256 and unpacks it into the volume `jgates-codeql`, which a check mounts read-only without network. Whether to prepare it is your choice; until you do, the capability is `incomplete` with `CUSTOMER_SUPPLIED`.

### Offline machines

On a machine that cannot reach the registry, export the image where there is access and import it where there is none:

```bash
jgates tools export jgates-tools.tar
jgates tools import jgates-tools.tar
```

`export` writes the image as a tarball plus its record, and `import` verifies it by digest before loading it. `jgates setup --from jgates-tools.tar` loads and prepares in one step.

## See the plan and run

```bash
jgates plan
jgates run
```

`plan` installs nothing, executes nothing and changes nothing. It shows three groups: what will run (with the effective command and where each decision came from), what is left out, and the requirements without coverage. A required requirement that no check covers makes the plan not approvable. A check that does not apply to the project shows as "does not apply here", with the reason and what to do, and never blocks.

`run` executes exactly one plan. To execute exactly the plan you reviewed:

```bash
jgates plan --out ./plano.json
jgates run --plan ./plano.json --no-interactive
```

If the project or the plan changed after it was saved, `run --plan` refuses (`PLAN_STALE` or `PLAN_TAMPERED`, exit 3) instead of running something else.

### Exit codes

| Code | Decision | Meaning |
| --- | --- | --- |
| 0 | `passed` | Every required requirement was covered and passed. |
| 1 | `failed` | Some requirement failed. |
| 2 | `incomplete` | Something required could not be proven (missing tool, partial coverage, missing data, services that did not start, reduced run). It never becomes approved. |
| 3 | `invalid` | Invalid usage or configuration; nothing was executed. |
| 4 | internal error | A failure of JGates itself. |
| 130 | `cancelled` | The run was interrupted. |

## Result and history

```bash
jgates history
jgates report <runId> --format json
jgates report <runId> --format sarif --out ./relatorio.sarif
```

Each run writes a `result.json` in the data folder. `report --format json` returns that file without changing a byte, and `--format sarif` produces a SARIF 2.1.0 for code review tools. `report <runId> --agent-context` produces the safe summary to paste into an agent; the same summary is written to `agent-context.md` in the run folder, and the output of `jgates run` ends with its path ("To fix... read"). At a terminal, `run` shows colors and a live line with the time of the running step; `--plain` gives the lean output for agents and logs.

## The interface

```bash
jgates ui --no-open
```

`ui` starts a local server on this computer only (`127.0.0.1`). It does not print the session secret: the entry link, single-use and valid for 10 minutes, is in a file in the data folder (the `launcher` field of the `--json` output). Open that file in the browser. Without `--no-open`, JGates opens the browser itself.

Main screens: Overview (`#/overview`), Workspace (`#/workspace`), Tools (`#/tools`), Configuration (`#/config`), with Services (`#/config/services`), Environment (`#/environment`), Semantic (AI) (the review setup at `#/semantic/setup` and the Providers and keys screen at `#/semantic/providers`), Preferences (`#/preferences`), with Storage (`#/preferences/storage`), and Help (`#/help`). Everything the interface does has an equivalent command.

The workspace button at the top of the sidebar switches to another project: pick one of the known workspaces, type a folder path, or use **Browse...** to walk the folders of this machine (the drives on Windows) and open one. A folder already set up for JGates or Git is marked in the list. A project without configuration opens on the guided setup.

**Declaring a component.** On the Workspace screen, the **Declare** button (dialog "Declare component") suggests the project's folders (the detected components are marked "detected component"). **Language** is a list in two groups, "With JGates checks" and "Recognized, no tools yet" (C++, for example: the component appears in the inventory and no check runs on it, and the dialog offers to add an [own tool](extension.en.md) for it), plus "Detect from the folder" and "Other...". **Framework** lists only the frameworks of the chosen language. The values written to `.jgates/workspace.yml` are lowercase ids.

**Reading the log of a step.** In the run screen, the logs of a step are shown as one block per tool, with its "Standard output" and "Error output" inside. What JGates itself recorded (program, arguments, folder, exit code, duration) is in a collapsed "Command executed" line, not in the output. Many tools write progress and warnings to the error output, and that is normal: whether a step failed is told by its state in the table, not by the log text. The block of a failed step comes highlighted and open first.

## In CI and with agents

The commands accept `--json` (one single document on stdout; human progress goes to stderr) and `--no-interactive` (never waits for an answer: missing data becomes an error with the fix instruction). An agent's cycle is plan, run, fix and run again, without changing the criteria; the skill `jgates/skill/SKILL.md` describes the cycle. In a CI pipeline that enforces the rules, the command is `jgates ci`, described in [CI](ci.en.md).

```bash
jgates run --profile standard --scope changed --base main --no-interactive --json
```

A run with `reduced: true` (something the profile requires was turned off for that run only) never closes the cycle as approved. See [templates and profiles](templates-and-profiles.en.md).
