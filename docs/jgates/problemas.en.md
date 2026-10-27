# JGates: common problems

Each JGates error carries a code (`error.code`), a message and a fix instruction (`error.fix`). This page gathers the most frequent ones. When in doubt, start with the diagnosis:

```bash
jgates doctor
```

`doctor` shows the runtimes (Node, Python, Git, Docker), each tool in the plan (ready, absent or at an incompatible version), the preparation and, for what is missing, whether it is essential, optional (with the alternative) or unused, with the recipe that installs it. On a terminal it offers to install; without a terminal and without `--fix` it only reads and exits with 0 (see [getting started](primeiros-passos.en.md)).

## The run ended "incomplete" (exit 2)

Incomplete is not failed: it means evidence is missing. Look at the reason of each stage in the result.

- **`TOOL_UNAVAILABLE`.** The tool is not installed or is outside the adapter's version range. The message carries the command, and `jgates doctor --fix` offers the recipe. For the Semgrep rules, use `jgates tools prepare --instance <id>`; for Docker, check that the daemon is up.
- **`blocked` stage.** A binary, a configuration file (ESLint without `eslint.config`, for example) or the coverage provider (`@vitest/coverage-v8`, `pytest-cov`) is missing. Coverage not measured is "not measured", never 0%.
- **`INPUTS_CHANGED`.** An analyzed file changed during the run. Run again without touching the code.
- **Partial architecture coverage.** The import graph did not resolve a dependency (an alias, for example). That is a coverage gap, never an approval: adjust the alias configuration.

## Installing what is missing

- **The quality gate shows as absent, but Python is there.** The Python found lacks the quality gate's packages (`defusedxml`, `tomlkit`). `jgates doctor --fix` creates the JGates environment (`<JGATES_HOME>/tools/python`) with them, and the bridge starts using it.
- **`python -m venv` fails.** On Debian and Ubuntu the `venv` module comes in a separate package: install `python3-venv` and run `doctor --fix` again.
- **"Automatic install unavailable".** The text says why: there is no Python 3.11 or newer to create the environment; the variable `JGATES_PYTHON`, `JGATES_RUFF` or `JGATES_SEMGREP` chooses the executable (install into it, or unset the variable); the image needs a working Docker; or the system is not one JGates knows how to install Docker on (the text points to the official instructions).
- **In CI or in a script.** Without a terminal, `doctor` does not ask: `jgates doctor --fix --yes` installs the essential items, and `--include-optional` the optional ones. Docker is never installed this way: the system's command waits for a "y" on the terminal.
- **Docker was installed, but `docker` asks for `sudo`.** On Linux, your user has to join the `docker` group (`sudo usermod -aG docker $USER` and a new session). JGates does not do it for you.
- **A run that ended because a tool is missing.** In a terminal (without `--json`, `--ci` or `--no-interactive`), `jgates run` lists what is missing, offers the same recipes as `doctor` and, after installing, asks whether to run again. Anywhere else it asks nothing, the exit code is the same as before and the message points to `jgates doctor --fix`. `quality-gate` run directly, without Docker and with the local sidecar missing a tool, offers in a terminal to install it (through `jgates doctor --fix`, when `jgates` is on the PATH) or to try Docker; otherwise it prints the error as before plus the hint. The local sidecar looks for Python in this order: `JGATES_PYTHON`, `PYTHON`, the JGates environment, the `PATH`.
- **Undo.** The JGates environment is just a folder: deleting `<JGATES_HOME>/tools/python` goes back to how things were (the `PATH` and the system Python were never touched).

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
- **`STRUCTURED_EDIT_UNAVAILABLE`.** The TOML form needs Python with `tomlkit`; without it, the text remains editable.
- **`GOVERNED_LOCKED`.** The server detected governed mode (`JGATES_POLICY_DIR`). Editing is blocked on purpose.
- **Visual edit refused in JS.** A dynamic configuration (function, spread, computed import) can only be edited as text.

## The interface

- Ask for a new link with `jgates ui`; the entry link is single-use and valid for 10 minutes. The server answers on loopback only, and a proxy or a different host name gets 421.
- One run at a time: the second gets 409 while the first has not finished.
- The controls marked as unavailable, and the component filter that does not show up are in [limitations](limitacoes.en.md).

## Disk space and cache

- Run `jgates gc --dry-run` to see what retention would delete (see [data folder](pasta-de-dados.en.md)).
- A result "reused" from an earlier execution comes from the cache. To force a real execution, use `jgates run --no-cache`.

## Windows and macOS

Windows was not tested yet and macOS was not tested on a real machine (see [limitations](limitacoes.en.md)). If something fails, note the command, the `runId` and the output of `jgates doctor`.
