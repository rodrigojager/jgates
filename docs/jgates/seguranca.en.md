# JGates: security

JGates reads and runs tools over code that may not be trusted, and it has a local interface. This page says what it protects, how, and what it does **not** promise. The limits that still exist are in [limitations](limitacoes.en.md).

## Untrusted repository

- Discovering and editing the configuration **does not run code** from the project. Reading an `eslint.config.js` is only parsing text.
- Before any execution the plan shows which steps run project code (tests, ESLint, Vitest, pytest). Such a step never comes from the cache.
- The local runner is not a sandbox. Strong isolation exists only in the container runner and, as a guarantee against the code author, in the external policy and in [governed mode](#governed-mode). `network: false` on the local runner is not advertised as a guarantee.
- The container runner uses the image pinned by digest in `.jgates/lock.json`, network off, a read-only file system, the workspace mounted read-only, an unprivileged user, `--cap-drop ALL` and `no-new-privileges`. It refuses `--privileged` and `docker.sock`.

## Local server and interface

`jgates ui` starts a server on loopback only (`127.0.0.1`). On every request it validates:

- the `Host` header (421 if unexpected), the origin and `Sec-Fetch-Site` (403);
- the session, through an `HttpOnly`, `SameSite=Strict` cookie, obtained with a single-use link inside a launcher file (`0600`); the secret is never printed to the terminal;
- the anti-CSRF token in the `X-JGates-CSRF` header on every mutation (403);
- the type, the size and the JSON schema of the body (415, 413, 400).

The content policy (`script-src 'self'`, `style-src 'self'`) forbids inline script and style. The interface never renders HTML coming from a report or a log: the content is escaped.

The interface does not receive free paths. Each editable file has a binding id, resolved on the server to a canonical path; a binding outside the workspace, a symlink that escapes it and an undeclared external root are refused, and saving checks the revision (409 `REVISION_CONFLICT` if the file changed).

## Secrets and personal data

- Secrets never enter the configuration. The semantic gate receives only the **name** of the environment variable (`apiKeyEnv`); the value comes from the environment or from the [user key store](#the-user-key-store).
- Secret and PII findings do not carry the raw value: it is masked in the adapter, in `result.json`, in SARIF and in the agent context.
- The semantic-gate context is masked before it leaves the machine: secrets and secret files always; the PII entities, the patterns and the external tools as the project configures them (`extensions.semantic-gate.masking`). An external tool that fails or answers inconsistently makes JGates send nothing. See [the semantic gate](semantic-gate.en.md#what-the-provider-receives).
- The [data folder](pasta-de-dados.en.md) is permissioned for the current user only (`0700` folders, `0600` files on POSIX systems). There is no debug copy with secrets.
- The configuration is read with limits: 1 MiB, 64 levels, 50 aliases, YAML without executable tags and without command interpolation.

## The user key store

API keys stored through the **Preferences > Providers and keys** screen of `jgates ui`, with `jgates secrets set` or with `semantic-gate auth set` live in a single file of the user, **outside every project** and outside the [data folder](pasta-de-dados.en.md): `secrets.json` in the semantic-gate configuration folder (`SEMANTIC_GATE_HOME`, else `%APPDATA%\semantic-gate` on Windows, else `$XDG_CONFIG_HOME/semantic-gate`, by default `~/.config/semantic-gate`). The folder is `0700` and the file `0600` on POSIX systems; the write is atomic (a temporary file renamed over it).

- None of these keys goes to the project, to results, logs, cache, drafts, history or undo.
- The environment variable wins over the store, and the listing says where each value comes from. `jgates ci` never reads nor writes the store: in CI only the environment counts.
- The value enters only the environment of the process that declares the name (the provider through `apiKeyEnv` or the default name; a PII tool through `passEnv`).
- No output returns the value, not even part of it: listings show name, state, source and date.
- On the screen, the value is typed in a password field without autocomplete that is emptied after saving, and it stays neither in the page nor in the browser storage; a stored key shows as `********` with its date. The local server does not log the body of these requests and no answer repeats the value. A write needs the session, the origin and the CSRF token like the other routes, and it is refused in the governed mode (`JGATES_POLICY_DIR`) and while the CI policy is edited (`jgates ui --policy`).
- A `0600` file **is not** an operating system keychain: any program running as your user can read it, and it goes along in a backup of your home folder. On a shared machine or one without disk encryption, prefer the environment variable fed by a secrets manager. Keychain, Credential Manager and libsecret support is in the backlog.

## Personal data in the project files

So that personal data (CPF, CNPJ, card, phone, or what a tool of yours recognizes) does not reach git, JGates checks and fixes the project files, always through an explicit command. `jgates run` still does not touch the project.

```bash
jgates pii check
jgates pii check --staged
jgates pii fix --dry-run --diff <path>
jgates pii fix --yes <path>
jgates pii fix --undo <fixId>
```

- **Scope.** Without an option, what goes into the next commit: the changed files and the untracked ones. `--staged` covers only what is in the index, `--changed` only the changed tracked files, `--all` the whole project (except what Git ignores), and paths cover the files named (a folder covers what is in it). Binary files and files larger than 8 MiB are left out, and listed.
- **`jgates pii check`** detects with the built-in detector (the entities turned on in `pii.yml`) and with the tools of `fix.tools` in `check` mode, on a temporary copy, changing nothing. It exits 0 without findings, 1 with findings and 2 when a detector did not complete, with the files and the count by label. The value found never appears in the output, in the JSON (`--json`) or in a log. With `--staged`, it reads the content of the index, which is what goes into the commit.
- **`jgates pii fix`** corrects only through a tool named in `fix.tools`: the built-in detector only detects. Without a configured tool, the command says so, exits with 3 and changes nothing. With a tool:
  1. it copies the files of the scope to a temporary folder inside the [data folder](pasta-de-dados.en.md) and runs the tools there, in order, in `fix` mode, with the [same protocol as the semantic gate](semantic-gate.en.md#external-pii-tools);
  2. it shows the files that would change and the count by label; `--diff` shows the diff on the terminal (never written to a log or a result) and `--dry-run` stops there;
  3. it asks (or takes `--yes`) and applies file by file, by atomic write, only if the project file still has the bytes of the copy; a file that changed in the meantime is skipped and listed;
  4. it keeps the originals for `jgates pii fix --undo [<fixId>]`, which restores them byte for byte (a file changed after the fix is not overwritten).
- **Nothing is applied** if a tool fails, times out, prints no status, prints an invalid or inconsistent status, touches a file outside the list, creates, removes or replaces a file with a link, or changes a project file outside the copy while it runs. The command exits with 2 and says why.
- **Exit codes of `pii fix`.** 0 when everything was applied or there was nothing to fix; 1 when something is left (a preview with `--dry-run`, a change not confirmed, a file skipped or refused); 2 when a tool failed and nothing was applied; 3 for usage or configuration (including no `fix.tools`). Without `--yes` and without a terminal (a script, an agent) nothing is applied: the command shows the summary and exits 1.
- **`--staged`** refuses, and lists, a file with part of its changes outside the index: the part in the index cannot be fixed alone without risk. The fixed files go back to the index (`git add` of those only), and the `--undo` of that fix puts the previous content back in the index.
- **The originals hold the personal data.** They stay in `workspaces/<id>/pii-fix/<fixId>/`, readable by the user only, for 7 days (`fix.backupRetentionDays`); after that `jgates gc --yes` deletes them, and so does the next `jgates pii fix` of the same project.
- **The git history is not cleaned.** Fixing the file does not remove from the history a value that was already committed: it stays in the earlier commits and in every clone. To rewrite the history, use [`git filter-repo`](https://github.com/newren/git-filter-repo) and treat the data as exposed.

```yaml
# .jgates/pii.yml
schemaVersion: 1
tools:
  corp-dlp:
    command: node
    args: ["{configDir}/tools/corp-dlp-adapter.mjs"]
    timeoutSeconds: 60
fix:
  tools: [corp-dlp]        # in order; empty: pii fix changes nothing
  includes: ["**"]
  excludes: ["vendor/**"]  # apply to pii check and pii fix
  backupRetentionDays: 7
```

## Git hook before the commit

Optional: a `pre-commit` hook (`<hook>` is `pre-commit`) that stops (or fixes) a commit that carries personal data in the staged files. It is off until you install it.

```bash
jgates hooks install <hook>
jgates hooks uninstall <hook>
```

- **`hook.mode`** in `.jgates/pii.yml` decides what the hook does, read when you run `install`: `block` (the default) runs `jgates pii check --staged` and stops the commit with the list and the hint `jgates pii fix --staged`; `fix` runs `jgates pii fix --staged --yes`, puts the fixed files back in the index and lets the commit go on; `off` writes no hook. In `fix` mode without a correction tool (`fix.tools`), the hook says so and falls back to the `block` behavior: personal data never goes through silently.
- **It never replaces yours.** With a `pre-commit` hook that jgates did not write, or with `core.hooksPath` set, `install` changes nothing and shows the line to add to your own hook.
- **The mark.** The hook has the line `# jgates-hook: pre-commit`; `uninstall` removes only a hook with that mark.
- **Which jgates runs.** The hook holds the absolute path of the node and of the CLI file that ran `install` (no `PATH` lookup), so it runs the same jgates that installed it. If that file is gone, the hook blocks the commit and tells you to run `install` again or `uninstall`. Move or update jgates, then run `install` again.
- **Windows.** The hook is a `sh` script, which Git for Windows runs in Git Bash; the paths are written with forward slashes.
- `git commit --no-verify` skips the hook, as with any Git hook.

## Supply chain

Direct dependencies sit at versions pinned in the lockfile, with origin and integrity checked; the Python tools use `==`; every image has its base by digest and every binary downloaded at build time is checked with `sha256`. The test `jgates/tests/server-routes-security.test.js` checks these pins (lockfile, image digests, Python versions), and the licenses are in `THIRD_PARTY_NOTICES.md`. No package is published: the product is the repository on GitHub.

## False or old result

A result is bound to the plan, the configuration and the state of the code (`analyzed`, `provenance`). If an analyzed file changes during the run, the result is marked `stale` and a `passed` becomes `incomplete` (`INPUTS_CHANGED`). A reduced run (`reduced`, by `--skip`, for example) never shows up as equivalent to a complete one. Local logs and hashes do not replace trust in the executor.

## Governed mode

`jgates ci` is the governed mode: the rules come from an external policy checked by SHA-256, the commit is analyzed in a clean copy and the job does not choose its own rules (no `--skip`, `--waiver`, `--plan` and the like). JGates does not loosen this mode and the interface, when it detects it, blocks editing. The native scanners stay out of `jgates ci` (the hardened bridge covers them), and what comes from tools that execute project code is marked self-reported. Details in [CI](ci.en.md). To stop the code author from changing the gate, use the external policy and a controlled runner.

## Telemetry

JGates sends no telemetry. Semgrep runs with `--metrics=off`; for third-party scanners, JGates does not claim a control it does not have.

## Reporting a problem

Do not put secrets in issues. Describe the command, the output of `jgates doctor` and the `runId`.

```bash
jgates doctor
```
