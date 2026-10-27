# JGates: the data folder

JGates does not write its data inside the project. Results, logs, plans, drafts and caches live in a **data folder** of the user. The project receives only configuration (`jgates.yml`, `.jgates/`) and what you ask it to write.

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
  tools/                     tool rules and caches (by hash)
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

The workspace `<id>` comes from the real path of the project. If you move the project, the old history stays there under the old id; relink it with `jgates workspaces relink <oldId> --cwd <new path>` and it shows up in the new one's history.

The language (Portuguese or English) comes from `--locale`, the `JGATES_LOCALE` variable or the interface Preferences, which store it in `preferences.json`.

## What JGates never does

- It does not delete files from your project. If a tool creates or changes a file in the workspace during the run, `result.json` lists the change (`workspaceChanges`), and deleting it is up to you. The only command that changes project files is `jgates pii fix`, and only after your confirmation (or `--yes`), with the originals kept for `--undo` (see [security](seguranca.en.md#personal-data-in-the-project-files)).
- It does not delete the user's global caches (the npm, pip or Ruff cache outside the data folder).
- It does not store secrets: secret and personal data values are masked before writing. The exception is the originals of `jgates pii fix`, which need the content for `--undo`: they stay in `pii-fix/`, readable by the user only, and expire in 7 days (`fix.backupRetentionDays` in `.jgates/pii.yml`).

## Inspect and clean

```bash
jgates workspaces list
jgates history --limit 5
jgates gc --dry-run
```

`gc --dry-run` shows what retention would delete, without deleting. To really delete, `jgates gc --yes`. The default retention is 30 days, 2 GiB per workspace and 10 GiB in total, and it protects the run marked as baseline, the preserved runs and the runs without a final result younger than 1 hour. Adjust with `--max-age-days`, `--max-workspace-mb` and `--max-total-mb`, or with the variables `JGATES_RETENTION_DAYS`, `JGATES_RETENTION_WORKSPACE_MB` and `JGATES_RETENTION_TOTAL_MB`. The cleanup only touches `workspaces/` inside the data folder. `gc` also lists the expired originals of `jgates pii fix` (`piiFix` in `--json`) and, with `--yes`, deletes them; they expire by the date written at fix time, not by the limits above.

The Storage screen (`#/preferences/storage`) shows the space used per workspace, lets you relink a moved workspace and delete the artifacts of a run (with confirmation).

## Result cache

Each stage has a key made of the JGates version, the content of the analyzed files and the configuration. If the key did not change, the previous result is reused and `result.json` says from which run. Any change to an analyzed file invalidates the stages (it is conservative). A stage that runs project code or depends on the network is never reused. To ignore the cache in one execution, use `jgates run --no-cache` or `JGATES_NO_CACHE=1`.
