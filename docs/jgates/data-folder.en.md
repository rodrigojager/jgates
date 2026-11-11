# JGates: the data folder

JGates does not write its data inside the project. Results, logs, plans and drafts live in a **data folder** of the user, and the heavy parts (the tools image, the copy of the project, the dependencies, the vulnerability databases) live in the container engine as labeled volumes and images. The project receives only configuration (`jgates.yml`, `.jgates/`) and what you ask it to write.

## Where it is

| System | Default folder |
| --- | --- |
| Linux and others | `$XDG_STATE_HOME/jgates`, or `~/.local/state/jgates` |
| Windows | `%LOCALAPPDATA%\jgates` |
| macOS | `~/Library/Application Support/jgates` (not tested on a real machine) |

The `JGATES_HOME` variable changes the folder, on any system. It is created when needed, with permission for the user only (`0700` folders and `0600` files, on POSIX systems).

## What is inside

```text
jgates/
  workspaces.json            registry of the known workspaces
  preferences.json           theme and language (personal preferences)
  codeql-terms.json          the date you accepted the CodeQL terms (if you did)
  workspaces/<id>/
    runs/<runId>/            result.json, plan.json, logs, events.jsonl, outputs/
    plans/                   the last plan
    drafts/                  unsaved edit drafts
    cache/                   result cache
    snapshots/               temporary copies of another commit
    locks/                   locks
    server/                  interface login files
    pii-fix/<fixId>/         originals replaced by jgates pii fix (they hold the personal data; 7 days)
```

The folder of a run is the only folder of the host that a step container sees: it is mounted at `/output`, and the step writes its reports there. Nothing else from your machine is mounted into a step.

The workspace `<id>` comes from the real path of the project. If you move the project, the old history stays there under the old id; relink it with `jgates workspaces relink <oldId> --cwd <new path>` and it shows up in the new one's history.

The language (Portuguese or English) comes from `--locale`, the `JGATES_LOCALE` variable or the interface Preferences, which store it in `preferences.json`.

## What lives in the container engine

Every object has the label `org.jgates.managed=true`, and the volumes are shared where it makes sense. See [storage and cleanup](storage.en.md) for the full table, the sizes and how to remove them.

- `jgates-<workspace>-src`: the synchronized copy of the project that the steps read at `/workspace`. It is rebuilt from your files; the project itself is never written.
- `jgates-<workspace>-deps-<component>`: the dependencies of each component (`jgates deps`).
- `jgates-toolchains` and `jgates-cache`: language versions and browsers that projects pin, and the package caches, shared by all workspaces.
- `jgates-data`: the vulnerability databases, read-only for the steps. `jgates tools update-data` refreshes them and records when each was fetched; a database older than `execution.dataMaxAgeDays` (7 days by default) or never downloaded makes the checks that use it `incomplete` (`DATA_STALE`, `DATA_MISSING`).
- `jgates-codeql`: the CodeQL bundle, only if you prepared it with `jgates tools prepare-codeql`.

## What JGates never does

- It does not write to your project. A step runs on a copy in a volume; if a tool changes a file there, the change stays in the copy and `result.json` lists it (`workspaceChanges`). Project files change only through what you ask for: `jgates init`, the editor and the configuration screens, `jgates tools add-custom`, and `jgates pii fix`, which asks for your confirmation (or `--yes`) and keeps the originals for `--undo` (see [security](security.en.md#personal-data-in-the-project-files)).
- It does not delete the user's global caches (the npm, pip or Ruff cache outside the data folder).
- It does not store secrets: secret and personal data values are masked before writing. The exception is the originals of `jgates pii fix`, which need the content for `--undo`: they stay in `pii-fix/`, readable by the user only, and expire in 7 days (`fix.backupRetentionDays` in `.jgates/pii.yml`).
- It does not remove an engine object that has no JGates label, nor one that is in use.

## Inspect and clean

```bash
jgates workspaces list
jgates history --limit 5
jgates gc --dry-run
```

`gc --dry-run` shows what retention would delete, without deleting. To really delete, `jgates gc --yes`. The default retention is 30 days, 2 GiB per workspace and 10 GiB in total, and it protects the run marked as baseline, the preserved runs and the runs without a final result younger than 1 hour. Adjust with `--max-age-days`, `--max-workspace-mb` and `--max-total-mb`, or with the variables `JGATES_RETENTION_DAYS`, `JGATES_RETENTION_WORKSPACE_MB` and `JGATES_RETENTION_TOTAL_MB`. The cleanup only touches `workspaces/` inside the data folder. `gc` also lists the expired originals of `jgates pii fix` (`piiFix` in `--json`) and, with `--yes`, deletes them; they expire by the date written at fix time, not by the limits above.

`jgates clean` does this and more (images of other versions, volumes of workspaces that no longer exist), and `jgates uninstall` removes everything: see [storage and cleanup](storage.en.md). The Storage screen (`#/preferences/storage`) shows the space used per workspace and per category, lets you relink a moved workspace and delete the artifacts of a run (with confirmation).

## Result cache

Each stage has a key made of the JGates version, the content of the analyzed files and the configuration. If the key did not change, the previous result is reused and `result.json` says from which run. Any change to an analyzed file invalidates the stages (it is conservative). A stage that runs project code or depends on the network is never reused. To ignore the cache in one execution, use `jgates run --no-cache` or `JGATES_NO_CACHE=1`.
