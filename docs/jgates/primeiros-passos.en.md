# JGates: getting started

JGates validates a repository before an approval: it discovers the components, builds a plan you can review, runs the checks and writes a result with the decision and the evidence. JGates brings together the quality gate (`quality-gate`) and the semantic gate (`semantic-gate`); the main command is `jgates`.

This page goes from zero to the first validation. The other pages in this folder: [templates and profiles](templates-e-perfis.en.md), [editor](editor.en.md), [adapters](adaptadores.en.md) (with the [compatibility matrix](compatibilidade.en.md)).

## What you need

- Node 22 or newer, Python 3.11 or newer and Git.
- Docker is optional: only the scanners that run in a container (Gitleaks, Trivy, OSV-Scanner, Checkov and the bridge's MegaLinter) need it.
- Linux was tested. Windows was not tested yet (the tests that depend on it are marked and skip elsewhere), and macOS was not tested on a real Mac.

## Install

JGates is not published to the npm registry: it is installed from the repository on GitHub. In an empty folder (or in your project's folder):

```bash
npm install git+https://github.com/rodrigojager/jgates
npx jgates doctor
```

npm downloads the repository and runs the `prepare` script, which compiles JGates and the interface; this takes a few minutes. From there the commands are `npx jgates`, `npx quality-gate` and `npx semantic-gate` (or `node_modules/.bin/...`). The examples below write `jgates` directly, as if it were on the `PATH`.

To have `jgates` on the `PATH` without depending on a project, install it into a folder of its own and put that folder's executables on the `PATH` (on Windows, add that folder's `node_modules\.bin` to `Path`):

```bash
npm install --prefix "$HOME/jgates-tool" git+https://github.com/rodrigojager/jgates
export PATH="$HOME/jgates-tool/node_modules/.bin:$PATH"
jgates doctor
```

For a global installation, or to install on a machine that cannot reach GitHub, pack a clone and install the generated file. This is the path covered by the test `tests/install.test.js` and the script `scripts/smoke-install.mjs`, including in a folder with a space and accents in its path:

```bash
git clone https://github.com/rodrigojager/jgates.git
cd jgates
npm install
npm pack
npm install --global ./jgates-0.3.0.tgz
jgates doctor
```

Instead of `--global`, you can install the file inside your project (`npm install /path/to/the/clone/jgates-0.3.0.tgz`) and use `npx jgates`. To repeat the installation proof (for example on Windows), run `node scripts/smoke-install.mjs` at the root of the clone, with JGates already built (`npm --prefix jgates run build`).

`npm install --global git+https://github.com/rodrigojager/jgates` **does not work**: for a global install of a git dependency, npm links the commands to a temporary clone that it then deletes. Use the folder with `--prefix`, the installation inside the project or the tarball (see [limitations](limitacoes.en.md)).

## Check the machine

```bash
jgates doctor
```

`doctor` shows the runtimes (Node, Python, Git, Docker) and, for each tool in the plan, whether it is ready, absent or at an incompatible version. For what is missing, it gives the classification, taken from the project's configuration (`.jgates/tools.yml`):

- **essential**: an enabled check does not run without it, and there is no other runner; the text also shows how to switch the check off for one run (`jgates run --skip tool:<id>`);
- **optional**: there is an alternative, and the text says which (the image pinned in the lock when the local tool is missing; the local tool when the image or Docker is missing), with the line to change in `tools.yml`;
- **unused**: no enabled check needs it.

Each missing item carries the recipe that installs it, shown before it runs: the command, the network hosts and where it writes. On a terminal, `doctor` first asks whether to install the essential items and then, in a separate question, the optional ones; any answer other than "y" cancels without installing. When nothing essential is missing it does not ask, unless you pass `--fix`:

```bash
jgates doctor --fix
```

- `jgates doctor --fix --yes` installs the essential items without asking, and `--include-optional` adds the optional ones.
- With `--json`, `--ci`, `--no-interactive` or without a terminal, `doctor` never asks. The JSON carries, for each runtime and tool, `classification` (`essential`, `optional`, `unused`), `alternative`, `recipe` (the preview) and, at the top, the `install` list of what is missing.
- Without `--fix` and without a terminal, it only reads the environment (it does not even create the data folder) and exits with 0. With `--fix`, it exits with 1 when an installation that ran failed.

The recipes:

- **Python packages** (the quality gate's packages, Ruff and Semgrep): they go into an environment of JGates's own at `<JGATES_HOME>/tools/python`, created with `python -m venv` from your Python 3.11 or newer, without touching the system Python. The network is PyPI (`pypi.org`, `files.pythonhosted.org`), or the index of `PIP_INDEX_URL`. The Ruff and Semgrep adapters and the quality gate's bridge look for the tools there after `JGATES_RUFF`, `JGATES_SEMGREP` and `JGATES_PYTHON` and before the `PATH`; the project's Python (the one pytest uses) is still the one on the `PATH`.
- **Images and rules**: the same preparation as `jgates tools prepare --instance <id>` (see [adapters](adaptadores.en.md)).
- **Docker**: JGates shows the official command of the detected system (`apt-get` on Debian and Ubuntu, `dnf` on Fedora, `brew` on macOS, `winget` on Windows) and runs it only after a "y" on the terminal; the command itself asks for `sudo`, and `--yes` does not cover it. With Docker installed and stopped, the recipe starts it (`sudo systemctl start docker` on Linux). On a system JGates does not know, the text points to the official instructions. The macOS and Windows commands were not tested on those machines yet.

JGates never runs `sudo` by itself.

## Discover and configure

```bash
jgates discover
jgates init --profile standard --no-interactive
jgates config validate
```

- `discover` reads only the project's files (nothing is executed) and lists the components and languages: in the example repository, `api` (Python), `web` and `libs/shared` (TypeScript).
- `init` creates `jgates.yml` and `.jgates/profiles.yml` with the profile you choose (`minimal`, `standard` or `strict`; the default is `standard`) and the templates of the stacks it found. If a configuration already exists it refuses with `CONFIG_EXISTS` and changes nothing.
- `config validate` checks the syntax, schema and references of the files, and names the file and line of each problem.

The project files are versioned with the code (`jgates.yml`, `.jgates/*.yml`, `.jgates/lock.json`). What JGates produces (runs, caches, prepared tools, drafts) goes to the data folder, outside the project: `~/.local/state/jgates` on Linux (or `XDG_STATE_HOME`), `Library/Application Support/jgates` on macOS and `%LOCALAPPDATA%\jgates` on Windows. `JGATES_HOME` changes the folder.

## See the plan and run

```bash
jgates plan
jgates run
```

`plan` installs nothing, executes nothing and changes nothing. It shows three groups: what will run (with the effective command and where each decision came from), what is left out, and the requirements without coverage. A required requirement that no check covers makes the plan not approvable.

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
| 2 | `incomplete` | Something required could not be proven (missing tool, partial coverage, reduced run). It never becomes approved. |
| 3 | `invalid` | Invalid usage or configuration; nothing was executed. |
| 4 | internal error | A failure of JGates itself. |
| 130 | `cancelled` | The run was interrupted. |

## Result and history

```bash
jgates history
jgates report <runId> --format json
jgates report <runId> --format sarif --out ./relatorio.sarif
```

Each run writes a `result.json` in the data folder. `report --format json` returns that file without changing a byte, and `--format sarif` produces a SARIF 2.1.0 for code review tools. `report <runId> --agent-context` produces the safe summary to paste into an agent.

## The interface

```bash
jgates ui --no-open
```

`ui` starts a local server on this computer only (`127.0.0.1`). It does not print the session secret: the entry link, single-use and valid for 10 minutes, is in a file in the data folder (the `launcher` field of the `--json` output). Open that file in the browser. Without `--no-open`, JGates opens the browser itself.

Main screens: Overview (`#/overview`), Workspace (`#/workspace`), Tools (`#/tools`), Configuration (`#/config`), Environment (`#/environment`), Preferences (`#/preferences`, with the Providers and keys screen at `#/preferences/providers`) and Help (`#/help`). Everything the interface does has an equivalent command.

## In CI and with agents

The commands accept `--json` (one single document on stdout; human progress goes to stderr) and `--no-interactive` (never waits for an answer: missing data becomes an error with the fix instruction). An agent's cycle is plan, run, fix and run again, without changing the criteria; the skill `jgates/skill/SKILL.md` describes the cycle. In a CI pipeline that enforces the rules, the command is `jgates ci`, described in [CI](ci.en.md).

```bash
jgates run --profile standard --scope changed --base main --no-interactive --json
```

A run with `reduced: true` (something the profile requires was turned off for that run only) never closes the cycle as approved. See [templates and profiles](templates-e-perfis.en.md).
