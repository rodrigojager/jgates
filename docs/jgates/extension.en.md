# JGates: your own tools and images

JGates ships one complete tools image with the tools of Python, TypeScript and JavaScript, Go, Rust and .NET. When your project needs a tool or a language the image does not have, you extend it. Nothing is ever installed on your machine: the tool lives in a container image that you describe in the project, and JGates builds it on top of its own.

An extension has two pieces, plus an optional third:

1. **Get the tool**: either a ready image that already exists, or lines you add to `.jgates/image/Dockerfile`, which JGates builds on top of the tools image.
2. **Register the tool** in `.jgates/tools.yml` with the `generic-command` adapter: the command, its arguments, how to read the result and what it checks.
3. **A language JGates does not know** (optional): declare the component with that language in the Workspace screen, put its toolchain in the Dockerfile and register its tools. The component's checks then run like any other.

Use a descriptor for a built-in linter whose program ships in the JGates image and whose file evidence and output match the descriptor engine. The descriptor declares activation, tier, output reader and trust. Use `generic-command` for a tool or command specific to your project. [Browse the built-in catalog](tools.en.md).

## Add a tool from the interface

On the Tools screen, **Add tool** offers two paths: a tool from the catalog, and **Own**. The second is a dialog with six steps (keyboard first; `Esc` closes it and returns the focus):

1. **How to get it**: a ready image (JGates checks that the engine has it and that it is `linux/amd64`) or install it in the JGates environment with pip or uv, npm, apt, or a binary downloaded from an `https` address with its SHA-256. A preview shows the Dockerfile lines that will be added.
2. **How to run it**: the command, the arguments (one per line, no shell) and the component it runs on.
3. **How to read the result**: SARIF (recommended for analysis and security), JUnit (tests), Checkstyle, or only passed or failed.
4. **What it checks**: the capabilities of the catalog, grouped by category, plus a new own capability of your own.
5. **Review**: the exact `tools.yml` entry and Dockerfile lines, with a diff when the files exist, and the effects (network, build).
6. **Test now**: builds the image if needed, runs the tool once on a copy of the project and shows what the report gave, or why it could not be read. Saving does not depend on the test, but an untested tool is labeled "not tested" until its first successful run.

When you declare a component in a language JGates has no checks for yet (C++, for example), the dialog offers to add an own tool for it with the component already chosen.

## Add a tool from the command line

```bash
jgates tools add-custom bandit --install pip:bandit==1.8.0 --command bandit --arg -r --arg "{workspace}" --arg -f --arg sarif --arg -o --arg "{output}/bandit.sarif" --report sarif:bandit.sarif --capability sast --dry-run
jgates tools build-extension --yes
jgates tools test bandit
```

- `add-custom <id>` writes the `tools.yml` entry and, with `--install`, the Dockerfile lines. `--dry-run` only prints the diff of both files. The methods of `--install` are `pip:<package>`, `npm:<package>`, `apt:<package>` and `binary:<https address>#sha256=<hex>` (repeat the flag for more). `--image <reference>` uses a ready image instead (it must already be in the engine; use one or the other). `--arg` is repeated for each argument; `{workspace}` is the synchronized project, `{component}` the component folder and `{output}` the folder where the tool writes its report. `--capability` names what it checks (see `jgates tools list`), `--component` limits it to one component, `--network` lets it use the network when it runs and `--timeout` sets the seconds before it is stopped.
- `build-extension` builds the image from `.jgates/image/Dockerfile`. It uses the network (the install lines) and says so before it starts; it asks for confirmation on a terminal, and `--yes` skips the question.
- `test <id>` builds the image if it is out of date (`--no-build` skips that), runs the tool once and shows the findings found, or why the report could not be read.

The tool is shown as an "own tool" and **never counts as a validated capability** in the [compatibility matrix](compatibility.en.md): the review lists it with the capabilities you chose.

## The files

```yaml
# .jgates/tools.yml
schemaVersion: 1
tools:
  bandit:
    adapter: generic-command
    image: extension          # extension | tools | <image reference>
    command: bandit
    args: ["-r", "{workspace}", "-f", "sarif", "-o", "{outputDir}/bandit.sarif"]
    capabilities: [sast]
    config:
      effects: { readsCode: true, writesOutputs: true, mayChangeCode: false, executesProjectCode: false, usesNetwork: false }
      evidence: { kind: sarif, file: bandit.sarif, failOn: error }
```

```dockerfile
# .jgates/image/Dockerfile
ARG JGATES_TOOLS
FROM ${JGATES_TOOLS}
USER root
RUN UV_TOOL_DIR=/opt/jgates-ext/uv UV_TOOL_BIN_DIR=/usr/local/bin uv tool install --force --no-cache 'bandit==1.8.0'
USER 10001:10001
```

In the file, the placeholders are `{workspace}`, `{outputDir}` and `{componentRoot}`: `add-custom` writes them for what you type as `{workspace}`, `{output}` and `{component}`.

An explicit pip install can replace an executable inherited from the base image inside your extension image. If an older Dockerfile fails because that executable already exists, add `--force` to its `uv tool install` command and rebuild.

The Dockerfile must start with those two lines: JGates fills `JGATES_TOOLS` with the tools image it pins, and refuses a Dockerfile that does not. Keep the last line, so the tool runs as an unprivileged user. The image is named `jgates-ext-<workspace>:<hash>` and carries the JGates labels; projects with the same Dockerfile share it.

## How the result is read

The `evidence.kind` of the entry says how:

| `evidence.kind` | JGates reads | The check fails when |
| --- | --- | --- |
| `sarif` | SARIF 2.1.0: rule, message, file, line, severity, fingerprints | there are findings at or above `failOn` (`error`, `warning` or `note`; default `error`) |
| `junit` | JUnit XML: cases with status, duration and failure text | any case failed or errored (`failOn: failure` or `error`) |
| `checkstyle` | Checkstyle XML: file, line and severity | there are findings at or above `failOn` (default `error`) |
| `exit-code` | only the exit code | the code is not in `successExitCodes` |

A report that is missing or cannot be read is `invalid`, never `passed`. Findings of own tools appear in results, baselines, waivers and the SARIF export like any other, marked "own tool". Without a report (`exit-code`), a capability of security, architecture or tests stays unproven. See [adapters](adapters.en.md#generic-command).

## When the image is out of date

JGates fingerprints the Dockerfile, the files next to it (the build context is limited to `.jgates/image/`) and the digest of the tools image. When the fingerprint changes, the steps that use the image are blocked with the reason `EXTENSION_OUTDATED` and the action "Rebuild your image" (interface) or `jgates tools build-extension` (command line). After a JGates update the base changes, so the image is rebuilt once and the screen says why. `jgates status` lists the extension images.

The build is a preparation, never part of a run, and it may use the network. The Dockerfile is yours: JGates shows what it will build and never builds during a run.

## In CI

`jgates ci` follows the policy of the pipeline owner. With `execution.extensionImage: forbid`, any extension image (the project's `.jgates/image` and any tool on an image other than the tools image) is refused. With `pinned`, only ready images named by digest (`name@sha256:...`) are accepted, an image built from the project's Dockerfile has no fixed digest and is refused, and the tools image of the job must be the one this JGates pins. See [CI](ci.en.md#images-and-extensions).
