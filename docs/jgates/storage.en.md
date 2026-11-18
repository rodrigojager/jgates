# JGates: storage and cleanup

Everything JGates creates on your machine is either in the [data folder](data-folder.en.md) or in the container engine, and every engine object carries the label `org.jgates.managed=true`. Cleanup selects objects by that label, never by name: an image or a volume without the label is never touched, even if its name looks like JGates's.

## What takes space

| What | Where | Comes back with |
| --- | --- | --- |
| The JGates tools image | the engine (an image) | `jgates setup` |
| Advisory data (vulnerability databases) | the volume `jgates-data` | `jgates tools update-data` |
| Language versions and browsers a project pins | the volume `jgates-toolchains` | `jgates deps prepare` |
| Package caches | the volume `jgates-cache` | the next install |
| The CodeQL bundle (if you prepared it) | the volume `jgates-codeql` | `jgates tools prepare-codeql` |
| Each project's synchronized copy | the volume `jgates-<workspace>-src` | the next run |
| Each component's dependencies | the volumes `jgates-<workspace>-deps-<component>` | `jgates deps prepare` |
| Your own images | the engine (an image per workspace) | `jgates tools build-extension` |
| Runs, logs, drafts, plans | the data folder | not recreated |

The image is the biggest item: about 2 GB to download and around 6 GB unpacked, as the last image build measured it. `jgates setup` checks that the disk has room for both, plus a margin, before it downloads, and answers `DISK_LOW` when it does not.

## See the numbers

```bash
jgates status
```

The last line shows the disk JGates uses and what is free. The **Storage** screen of the interface (`#/preferences/storage`) shows the same by category, counts shared image layers once, and offers the buttons below.

## Clean what is not in use

```bash
jgates clean --dry-run
jgates clean --yes
```

Without a scope, `clean` removes everything that is not in use: the images of other JGates versions, the volumes and own images of workspaces whose folder no longer exists, stopped JGates containers, networks left by runs, old runs (the retention of [`gc`](data-folder.en.md#inspect-and-clean)) and the old tools folder of earlier versions. It always lists every object with its size and the reason first, and removes nothing without `--yes` (or your answer on a terminal). Without a terminal and without `--yes` it stays a dry run.

An object that is in use is skipped and shown as "in use": the image this JGates version pins, a running container, a volume that a running JGates container uses, a run in progress. Each removal is reported line by line with the space freed; the exit code is 2 when something was left.

A scope limits what is cleaned:

```bash
jgates clean --images --dry-run
jgates clean --toolchains --dry-run
jgates clean --caches --dry-run
jgates clean --data --dry-run
jgates clean --orphans --dry-run
jgates clean --runs --dry-run
jgates clean --workspace <id> --dry-run
```

- `--images`: JGates images that are not in use (they come back with `jgates setup`);
- `--data`: the advisory data volumes (the checks that need them become `incomplete` with `DATA_MISSING` until `jgates tools update-data`);
- `--toolchains`: the language and browser versions volume;
- `--caches`: the shared package caches;
- `--workspace <id>`: the volumes and own images of one workspace (the id is `ws_` followed by 16 hexadecimal digits; see `jgates workspaces list`);
- `--orphans`: the objects of workspaces whose folder is gone;
- `--runs`: only the runs retention.

The interface does the same: each row of the Storage screen has Remove, Clean or Update, every action shows the list and the total first.

The sidecar image of the old quality gate (`jgates/quality-sidecar:latest`) was built by hand and has no JGates label, so it is never removed by default. It is listed separately, and `jgates clean --legacy-sidecar --yes` removes it.

## Remove everything JGates created

```bash
jgates uninstall --dry-run
jgates uninstall --yes
```

`uninstall` removes every object JGates labeled (containers, networks, volumes and images), the old tools folder and the data folder (runs, history, drafts). Without `--yes` it only lists. Before it removes the data folder it checks that it really is one (not your home folder, a drive root, a link or a folder that holds a project).

- `--keep-config-notes` keeps the preferences and the list of known workspaces in the data folder.
- The API key store (the user's `secrets.json`, see [security](security.en.md#the-user-key-store)) is removed only with `--include-key-store`, and only after a separate confirmation on a terminal.
- **Your projects are never touched.** `uninstall` lists what JGates left in them (`jgates.yml`, `.jgates/`, an installed Git hook, with the command that removes the hook) and leaves that to you.
- The last line tells how to remove the `jgates` program itself, according to how it was installed.

```bash
jgates uninstall --keep-config-notes --dry-run
jgates uninstall --include-key-store --dry-run
```

In the interface, **Remove everything from JGates…** on the Storage screen asks you to type the word shown before it removes anything.

## Runs retention

`jgates gc` applies the retention to the runs of the data folder (30 days, 2 GiB per workspace, 10 GiB in total by default) and is the runs part of `clean`; see the [data folder](data-folder.en.md#inspect-and-clean).
