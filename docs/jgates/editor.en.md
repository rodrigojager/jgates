# JGates: the tool editor

Each tool has its own area in the interface (`#/tools`, then the tool). The editor works on the **real** configuration files of the project (`pyproject.toml`, `eslint.config.js`, `.jscpd.json`...): the file's text is the source; the form is a validated projection of it. Nothing is kept in a parallel JGates format.

## A tool's area

- **Options** (the default tab): a form of the supported fields, with default value, example, unit and limits. "Use inherited value" is a control separate from `false`, `0` or empty. The "Common use" and "Advanced" groups avoid a page with hundreds of options, and the search finds a rule, a description and the field's path.
- **Files**: the files linked to the tool, with a text editor, syntax errors, diff and save. It shows "shared with pytest" when another instance uses the same file. Text editing exists even when there is no form.
- **Effective configuration**: the resolved values and where they came from, including flags and environment variables that take precedence over the file. If the resolution cannot be complete, the screen says it is partial and why; it never invents a final configuration.
- **Execution** (collapsed): version, runtime, command, context, network and the expected report.

Today there is a form for Ruff and pytest (adapters with "assisted configuration"). For the others, the Files tab is the way in.

## Real files, with a revision

A linked file has a **binding id** (`primary`, for example), which is what the interface and the CLI use. A free path is never passed: a binding outside the project root, a symlink that escapes it or an undeclared external root are refused. The same commands serve automation:

```bash
jgates tools inspect ruff-api
jgates tools config read ruff-api --file primary
jgates tools config validate ruff-api --file primary
```

`read` returns the text and a `revision` (the sha256 of the content). To write, pass the revision you read:

```bash
jgates tools config write ruff-api --file primary --from ./novo-pyproject.toml --if-match <sha256>
```

- If the file changed between the read and the write (another editor, another tab, your IDE), the answer is a conflict (`REVISION_CONFLICT`) with the base, your version and the current one to compare. Nothing is overwritten silently. `--if-match absent` creates a file that does not exist yet.
- The write is atomic (a temporary file on the same disk and a swap) and preserves the encoding, the BOM, the line endings (CRLF or LF) and the permissions. Latin-1 and UTF-16 never become UTF-8 without a warning.
- Two adapters on the same file share the revision: saving Ruff does not erase the pytest section of the same `pyproject.toml`.
- Read-only, generated, package or governed-mode files appear with the reason; JGates does not write to them.

## Form and text

1. The file is read without executing anything, and the supported fields are extracted.
2. A change in the form becomes one intent per field (`set` or inherit), never a file rewritten from scratch.
3. The format's codec computes the smallest patch over the original text: comments, order, unknown fields and advanced code stay as they were.
4. The interface shows the diff before saving; saving uses the revision above.
5. Saving invalidates the plan and the previews that depend on the file.

A value the form does not recognize (for example a `select` with a plugin it does not know) becomes read-only, with the reason and the position in the file, and the form does not delete it. The form does not invent defaults either: what is not in the file appears as "inherited".

The formats: JSON and JSONC by tree and positions (strict JSON never becomes JSONC), YAML by ranges (`anchors` and `aliases` preserved, with a warning when a shared value affects several consumers) and TOML through the Python sidecar helper (`tomlkit`). Without Python or without `tomlkit`, the TOML form is disabled and text editing continues.

## Validation

Validation runs as you type and before saving: JSON and YAML give the line and column of the error; TOML uses the helper. For formats without a validator (JSONC, INI, XML, JS and others), the interface and `tools config validate` say **"unavailable"**, never "valid". Syntax highlighting does not prove validity.

Invalid text is not lost: the buffer stays, the error appears and visual editing is suspended. The draft is saved automatically in the data folder (not in the project). Saving an invalid active configuration is an explicit choice in the text editor (`--allow-invalid` in the CLI), and it blocks the plan with `CONFIG_INVALID` (file and line) until it is fixed: nothing runs on a broken configuration.

Before a run, if there are drafts the plan would use, the interface offers "Save and use the new version" or "Use the saved version". A buffer that is not in the plan is never executed.

## What is never executed

Opening or editing a file **does not execute project code**:

- an `eslint.config.js`, `vitest.config.ts` or similar is read by static analysis (no `eval`, `require` or `import`);
- only the recognized parts (object literals, static properties, known wrappers) have visual editing; functions, `spread`, imports, environment variables and conditionals are preserved, and ambiguous visual editing is blocked with the "Edit file" option;
- editing a `csproj` or other XML never evaluates MSBuild;
- inspections that would need to run the tool (such as printing ESLint's effective configuration) are the runner's job, with declared effects, never a side effect of typing.

A rule is never turned off because the form did not recognize the value: when in doubt, the field becomes text.
