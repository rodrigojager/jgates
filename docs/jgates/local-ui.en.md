# JGates: the local interface

`jgates ui` opens the interface of JGates on this computer only (`127.0.0.1`; see [getting started](getting-started.en.md#the-interface) for the entry link). This page walks through what you see there: the guided setup, the container engine choice, the configuration screens, the YAML editor, the run and the result. Everything the interface does has an equivalent command, shown next to it.

The interface follows the language chosen in Preferences (Português do Brasil or English). Long screens are grouped and collapsed with counts, every disabled control says why it is disabled, every dialog starts on its first field, and every screen also works at 375 px wide and with the keyboard only.

## The guided setup

A project without a JGates configuration opens on the **Guided setup** (the overview shows it until the setup ends). A configured project keeps it closed: **Open the wizard** (on the Workspace screen, with a select of the step to start on) reopens it at `#/setup` with your current values, without taking over the overview. The stepper on top shows the six steps; a step that is still locked says what unlocks it.

### 1. Docker

The doctor mascot examines the machine (examining, needs you, all set, could not examine) above a checklist, **What JGates needs**, with the values measured on this machine:

| Requirement | Recommended | What happens below it |
| --- | --- | --- |
| Container engine | answering | nothing runs without it: install or start it (the commands are shown, nothing runs without you) |
| Memory of the engine | 8 GB | a warning only: the larger checks may fail or take longer |
| Free disk | 15 GB | a warning only |
| CPUs | 2 | a warning only |

**The container engine executable** is a list: **Docker**, **Podman**, or **Another executable…** with its path. Each option says whether the executable was found on the `PATH`; **Test** checks that it answers and **Use this executable** saves it. The choice is saved as `containerRuntime` in `preferences.json` in the [data folder](data-folder.en.md) and is used by the interface and by every command from then on. The environment variable `JGATES_CONTAINER_RUNTIME`, when it is set, still wins over the saved choice.

The step checks again every 3 seconds while the page is open, so a Docker started from another window shows at once.

### 2. Tools

The step lists what will be downloaded, before anything is downloaded:

- the **tools image** (`jgates-tools`): its version, the download size and the space on disk, and the tools it carries, each with its version, licence and what it is used for;
- the four **security databases** (Trivy, OSV, Go vulnerability database, RustSec): where each comes from, its approximate size and which checks use it;
- the totals and the free space of the disk.

**Download the JGates tools** starts the download, with progress, speed and time left; it goes on in the background while you move on. When everything is ready the step says so and offers **Continue**.

### 3. Project

Each component discovery found is described in words: where it is, its language and framework, the package manager, the language version and the lockfile, with the files that showed it (the evidence). A component at the project root is named as such. Only what is ambiguous asks for a choice, and the package managers offered follow the chosen language. **Declare component** opens the same dialog as the Workspace screen, with a picker of the project's folders, without leaving the wizard. When the project has compose files, the step offers to use their [services](services.en.md).

### 4. Profile

Choose **Essential**, **Balanced** or **Strict** (and any profile you create), each card with how many checks run on this project. The quality mascot strip follows the selection.

The profile editor of Configuration > Profile is embedded in the step: the categories open into capabilities and tools, and each switch changes the counts at once. **Create a profile from this one** asks a name and a description and adds it to the cards. Until you confirm, everything is written to a draft kept in the data folder, never to the project: **Undo the changes** drops the draft, and **See the file before saving** shows exactly what will be written. **Save and continue** writes `jgates.yml` and `.jgates/profiles.yml` (in an existing configuration, only the files that changed).

### 5. Dependencies

One line per install unit: the manager, the lockfile, the language, what is installed (from the lockfile or from the manifest, with the commands), the volume and where it is mounted, and the network it uses (the package registry only, only while installing). The state comes from the last installation; when every unit is ready there is nothing to press.

### 6. Review

- **Gate and target**: which checks to run (quality, Semantic, or both) and on what (the full workspace, the last commit, the branch changes against a base, a comparison between two references, a pull request, or a folder), with lists of the branches, tags, recent commits and folders of the project. **Use as the project default** keeps the choice for the next validations (in `selection` of `jgates.yml`).
- **The plan by category**, named by what is checked.
- **What will not run**: each check that will not run is an item with the check and the tool, the reason and what to do, with a working button when there is an action (prepare, download, configure). A check that cannot apply to this project has no action.
- **Preparation**: what is still pending (tools image, security data, dependencies) is listed apart, one button each, and the step names exactly what it is waiting for.

**Run the first validation** starts it (or **Run as soon as it is ready** while something is being prepared).

## Configuration screens

The Configuration area holds one screen per file or subject: Profile, Tools, Execution, Workspace, Personal data, Policy, Dependencies, Extension image, Templates, Architecture, Services and the YAML files.

### How the forms work

The forms are derived from the schemas of the configuration files, so every key has a control, and they show whatever is in the file, keys you wrote by hand included (a key JGates does not know shows as a text field, never hidden). The control follows the value: a switch for yes or no, a radio or a list when the values are known, a number with its limits and presets (plus "Other value…"), a checklist, a list editor, or a picker (project files and folders, branches, tags and commits, compose services and ports, catalogue names) with "Other…" to type. Typing is the fallback, not the rule.

- Each value shows where it comes from: the file, the configuration, the profile, a template, the tool's defaults.
- **Back to inherited** removes the key from the file, so the inherited value applies again.
- **Edit in YAML** opens the YAML editor on the file, at that key.
- Every save writes one key and nothing else: the file's comments, order and other keys stay byte for byte. Before writing, a dialog shows the difference in the file; a switch saves at once. After a save, **Undo** puts the file back as it was.
- A file with an invalid key still opens: the screen lists the problem with file, key and line and a link to the YAML editor, instead of going blank.
- If the file changed on disk after the screen read it, nothing is written: the screen says so and offers **Reload the form**.

### Profile

The project's profiles, the categories of the selected one and, for each profile, the editor of `.jgates/profiles.yml` (**Edit** goes straight to it). **Create profile** asks the name (the id is derived from it) and a description; profiles can be duplicated, renamed, made the default and deleted (the default profile cannot be deleted, and the button says why). Every action shows that it is in progress and the screen keeps its content while it updates. A section edits the profile's selectors of personal data, architecture and components, and the category **Own checks** lists your own tools and offers **Add own tool**.

### Tools

**Tools in use in this project** lists what the plan runs, by category, with a link to each tool's page; your own instances are listed apart. The catalogue shows the tools of this project first (by its languages), can show all of them, and ranks a search by name. Each card says where the tool comes from once: shipped in the tools image (with its version and licence), your own, or supplied by the project. **Add tool** preselects by the project's language and goes on to the new instance's settings.

Every tool page shows its settings form, also for a tool a template brings, plus the memory, CPUs and time limit that apply with their origin. An own tool can be edited in the same six steps that created it and tested with **Test now** (see [your own tools](extension.en.md)).

### Execution, Workspace, Personal data, Policy, Dependencies, Extension image

- **Execution**: every key of `execution:` in `jgates.yml` (limits, data age, fail fast, extension image, trust in self-reported results) as controls; the changes are a draft until **Review and save** shows the difference and writes them together.
- **Workspace**: the components; **More fields** on each declared component edits its whole entry (kind, enabled, include and exclude, dependencies, groups), the discovery switch is in the scope tab, and the path of a declared component comes from a folder picker.
- **Personal data** (`#/tools/builtin-pii`): the entities table plus the form of `.jgates/pii.yml` (severity, tools, fix, hook mode).
- **Policy** (`#/policy`): the form of `.jgates/policy.yml`, created when it is missing; read-only, with the reason, when a CI policy governs the project.
- **Dependencies** (`#/config/dependencies`): the package managers JGates found and the form of `.jgates/dependencies.yml` (private registries name the secret, never the token).
- **Extension image** (`#/config/image`): the Dockerfile of your extension image, whether it is ready or outdated (with the cause) and **Rebuild**.

### Templates, Architecture and Services

- **Templates**: **Create template** is a stepper: what it checks (the capability, chosen by name), where it applies (languages and frameworks, added one at a time), the command (an executable plus a list of arguments) and a review with the difference of every file. Templates of the project can be edited and deleted; a template file that `jgates.yml` does not use is listed as **Not in jgates.yml** with **Use in this project**.
- **Architecture**: **Create architecture rules** or **Edit layers and rules** opens a stepper that proposes layers from the project's folders and rules from the layers, then shows the difference; saving changes only what changed, so comments and hand-written rules stay.
- **Services**: the compose files, the roles of the services, the target and the review are steps of the same stepper (see [services](services.en.md)).

## The YAML editor

**YAML files** (`#/config/yaml`) edits the text of `jgates.yml` and of the `.jgates` files. A link from any screen (**Edit in YAML**) opens the file with the cursor on the key; a key that is not in the file yet puts the cursor on its closest section.

- The structure is checked while you type: syntax, schema and references, with marks in the editor and a list of problems, each with the file, the key and the line (**Go to line**). Messages are in plain words (an allowed pattern, a limit, which shapes a value may take).
- **Save** is disabled while there are problems; **Save anyway** writes the text knowing that the plan will not be approvable until it is fixed.
- A configuration file that does not exist yet (architecture, personal data, dependencies, policy) is listed as **Not created**, with **Create**: it starts from a valid template.
- If the file changed on disk after you opened it, saving is refused until you look at the current version: nothing is overwritten.

## Running and reading the result

The run screen shows the five phases (sync, dependencies, services, checks, services down), each with its log closed until you open it, and the checks once, as they end. When the run ends, its state says the decision (a rejected run never reads just "finished") and **Open the result** leads to it. The result is also reachable from History (`#/validations`) and from the overview, whose next step after a run is the result.

The result screen:

- one card per check, with its own icon and word for each state: passed, failed, incomplete, blocked, not applicable, turned off; with the tool, the duration and the number of findings;
- one card per finding: severity, tool, rule, message, the fix when the tool gives one, and the `file:line`;
- filters by severity, tool, category and component;
- **Export JSON**, **Export SARIF** and **Copy for the agent** (a safe summary to paste into an agent; nothing is sent);
- what the run used (JGates version, tools image, age of the security data, dependency keys, services).

A check that cannot run says why and what to do (see the [reason codes](troubleshooting.en.md#reason-codes)). Mutation testing, for example, is not applicable while the project's own tests fail, and runs once they pass.

## Mascots

The doctor follows the machine's state (wizard step 1, the Environment screen and the overview), the quality mascot strip follows the categories of a profile (wizard step 4, Profile, Templates, the tools catalogue), and the Semantic review has six static 3D mascots, one per phase (see [Semantic mascots](semantic-mascots.en.md)).
