# JGates: the ASVS coverage map

The ASVS coverage map lists every requirement of OWASP ASVS 5.0.0 for a chosen level and puts each one in one of five
states, built from what the validations of the project really ran. It organizes evidence and shows gaps. **It never says
that a project meets the standard, it shows no score, percentage or badge, and it has no gate**: the
sentence on every screen and in every output is "This map shows what was examined, not whether the project meets the
standard."

## The five states

| State | What it means | Why a requirement is in it |
|---|---|---|
| examined | At least one check that the mapping ties to the requirement ran to completion in the runs the map reads | The check looked for violations of part of the requirement. The row names the check, what it covers, what it misses and how many of its findings are open |
| unexamined | A mapped check could run on this project and did not | It was switched off, not selected, failed, timed out, was blocked, or there is no Semantic run of its method. The row gives the reason of each check; a run made before the scanned-languages record existed says "validate again" |
| unsupported | No JGates check is mapped to the requirement, or the mapped checks exist only for other stacks | Unmapped means unsupported: nothing is inferred from a tool name, a CWE number or a subdimension |
| not applicable | You recorded that it does not apply, with a reason | Only your decision does this; a model's proposal never does |
| awaiting evidence | It cannot be established from the repository: it needs a deployed system or a person (a document, a process, an operational setting), and no check is mapped | The mapping says which kind of evidence it awaits |

**Examined is not satisfied.** A requirement is examined when a check looked for violations of part of it. A requirement
examined by a deterministic check says so; one examined only by a Semantic unit says "AI review of the source" and is
counted apart in every total. A check reused from the cache counts, and the row says "reused".

### The checks of an opened requirement

An opened requirement lists the checks mapped to it, each with its status:

| Status | What it means |
|---|---|
| ran | It ran to completion in the runs the map reads |
| did not run | It could run on this project and did not (switched off, failed, timed out, no Semantic run of its method...) |
| not supported for this project | It should run on the project's languages but cannot: the language is present but was not scanned, the capability has no validated matrix row for the project's stack, the tool said it cannot run on this project, or the rule is unknown to this installation |
| left out (deterministic only) | A Semantic check, left out by "deterministic only" |

A check of a language the project does not have at all (a Go or Rust rule in a project with only C#) is not listed and
is counted nowhere: it bears on nothing in this project. When every check mapped to a requirement is of that kind, the
requirement stays unsupported and its reason names the project's languages and the languages the checks exist for, for
example "no JGates check covers this in C# (there are checks for: Go, Rust)". This needs a Quality run: without one the
project's languages are unknown and every check is listed. The `--json` output keeps such a check, with
`"relevant": false` and the code `LANGUAGE_ABSENT`; every other check has `"relevant": true`.

## The mapping rule

The mapping is conservative by construction, because an optimistic mapping is a false claim.

- One reviewed data file per chapter (`jgates/packs/asvs/jgates-asvs-map/5.0.0/V01.json` to `V17.json`) with one entry
  per requirement. A requirement gains a check only by an entry that says what the check covers, what it misses and why
  it bears on the requirement. The mapping refers to requirements by id and never quotes their text.
- An entry counts only after an independent review (another context that tries to refute it) marks it `reviewed`; a
  pending entry behaves as unmapped.
- A check counts as having run only when it really did. A capability counts when its stage completed and the matrix row
  is validated; a Semgrep rule counts when the Semgrep stage completed, the run used this version of the pack, and at
  least one file of the rule's language was scanned (a requirement mapped only to rules of languages the project does
  not have is unsupported for it); a Semantic unit counts when the run of its method finished and the attack-class block
  or category was examined.
- The order of decision is fixed: your "not applicable", then examined, then unexamined, then awaiting evidence, then
  unsupported.

## How the Semgrep rules and the Semantic audit feed it

The rules of the bundled Semgrep pack (see [Quality integrations](quality-integrations.en.md)) are the main deterministic
source for encoding and injection, file handling, parts of the web frontend, cryptography and secure communication; the
map shows per language what they cover. The Semantic security audit (see [the Semantic methods](semantic-methods.en.md))
feeds the requirements about authorization, business logic and data isolation through its coverage ledger, always with
the basis "AI review of the source" and only for blocks whose units were examined in that run. `insecure-defaults`
feeds configuration, the dependency checks feed the dependency requirements, Gitleaks feeds secrets, and ZAP and
Schemathesis feed runtime requirements when a target ran.

## What the pack examines, by kind of file

The bundled Semgrep pack has 636 original checks for nine kinds of file: Python, JavaScript (which also serves
TypeScript), Go, C#, Rust, Java, PHP, HTML files and configuration files. A check belongs to one kind of file and is shown
only to a project that has files of that kind: a project with no Rust never sees a Rust check, and a requirement whose
checks are all of kinds the project lacks stays unsupported for it, with the reason naming the kinds. Templates (Jinja,
Blade, Razor, EJS, Go templates, Vue files) are not read.

Almost every check is **partial**: it sees one way of breaking a requirement, in the libraries it models, and its row
says what it misses. A requirement with a deterministic check is therefore examined in part, never proved.

The table counts the requirements of each level that have at least one reviewed deterministic check, by the kind of
file of the check. A requirement counts in a column when a reviewed mapping entry ties it to a pack check of that kind;
the "any" column counts the requirements with a reviewed check of any deterministic kind, the pack's or a tool's. The
levels are cumulative (level 2 includes level 1). The numbers are computed from the pack index and the reviewed
mapping, and say nothing about whether a project meets a requirement.

| Level | Requirements | Any | Python | JavaScript | Go | C# | Rust | Java | PHP | HTML | Config |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 70 | 55 | 34 | 35 | 29 | 33 | 27 | 35 | 31 | 4 | 4 |
| 2 | 253 | 165 | 91 | 93 | 81 | 87 | 70 | 91 | 79 | 6 | 15 |
| 3 | 345 | 200 | 101 | 102 | 87 | 94 | 75 | 99 | 85 | 7 | 16 |

The remaining requirements are unsupported, await a deployed system or a person, or are examined only by an AI review.

## Informational findings

Some checks of the pack state a policy of the standard that many sound projects do not follow (for example a password policy that forces
character classes, or a secret question for recovery). Their results are **informational findings**: shown in the result, the report
and the map under their own heading, each with the words "does not block the validation". They are counted apart from
the blocking findings in the result, in the baseline comparison and in the map (an opened check shows two numbers, blocking
and informational), they never change a verdict, and they cannot be waived, because there is nothing to waive. The checks
that look for a vulnerability, precise or heuristic, are the ones that block.

A finding that comes from a pack check names the requirements the check was written for ("ASVS V3.3.1"), linked to that
row of the map. This is a label of intent: the sentence beside it never says the requirement is or is not met.

## Suggestions of "not applicable"

When a scan finds **no sign of a technology** in this project (no GraphQL, WebSocket, WebRTC, OAuth, JWT, SAML, TOTP,
LDAP, XML, mail, template, file-upload, archive or browser-DOM code), the map **suggests** that the requirements about
that technology may not apply. A suggestion appears on the row, the section or the chapter, with the reason in words
("no sign of WebSocket in this project"), and the filter "with a suggestion" lists them. It comes from small signal rules
of the pack that record what a scan saw; they are never findings. A suggestion needs every kind of file the scan
covered to have been checked for the sign, so a project with configuration or HTML files may get none for a technology
until those kinds are covered. It disappears when a later scan finds the technology.

A suggestion is never a decision. Only you record "not applicable": confirm it with
`jgates coverage asvs not-applicable <id> --from-suggestion` or on the screen, with a preview and an undo like any other
entry. JGates never writes one by itself and never in governed mode.

## The AI review unit

A requirement that no deterministic check examines can be reviewed by the opt-in `asvs-review` method (see [the Semantic
methods](semantic-methods.en.md)). Its answers are the unit kind `semantic-requirement`. The map shows such a requirement
as examined by an **AI review of the source**, always labelled so, counted apart from the deterministic checks in every
total, and only where a reviewed mapping entry allows it. A "not examinable" answer gives nothing, and the review is never
a statement that a requirement is met. With `--deterministic-only` it is left out.

## The command

```bash
jgates coverage asvs [--level 1|2|3] [--run <id>] [--semantic-run <id>] [--state <state>] [--chapter <id>] [--subdimension <id>] [--with-suggestion] [--deterministic-only] [--json]
jgates coverage asvs level <1|2|3>
jgates coverage asvs not-applicable <requirement|section|chapter> --reason "<text>" [--preview] [--yes]
jgates coverage asvs not-applicable <requirement|section|chapter> --from-suggestion [--reason "<text>"] [--preview] [--yes]
jgates coverage asvs not-applicable <requirement|section|chapter> --remove
jgates coverage asvs undo <token>
```

- With no subcommand it prints the totals, then the requirements grouped by chapter. `--level` shows another level for
  that call without changing the project's choice (level 1 has 70 requirements, level 2 has 253, level 3 has 345).
  `--run` and `--semantic-run` name the runs to read; by default it reads the last finished Quality run and the last
  finished run of each Semantic method, and warns when they analyzed different revisions. `--deterministic-only` leaves
  the Semantic units out. `--state`, `--chapter`, `--subdimension` and `--with-suggestion` filter the rows; the output prints the suggestions.
- It exits 0 whenever it could build the map, and never with a code that means the project fails the standard.
- `level`, `not-applicable` and `undo` write the project. Each shows the entry and the change first and asks;
  `--preview` writes nothing, `--yes` writes without asking, `--json` never asks. Each write prints an undo token, and
  `undo <token>` puts the file back as it was. They are refused in governed mode.
- The map is computed from the stored runs each time. It is never stored in a run and calls neither the container
  engine nor git.

## The screen

**Validations > ASVS coverage map** shows the version and level (a three-way switch that records the project's choice),
the runs it reads with links, the "deterministic only" switch, one counter per state (each is a filter, with no percentage
and no pass mark), and the requirements grouped by chapter and section or by Security subdimension. Opening a row shows
the checks (which ran, the basis, what each covers and misses, open findings that link to the result) or the kind of
evidence it awaits. "Not applicable" on a row, a section or a chapter opens a dialog with the required reason and the
entry to be written, then offers an undo; it is disabled, with the reason, in governed mode. The Quality result, the
Semantic result and the overview link to it.

## The project file `.jgates/asvs.json`

```json
{
  "version": "5.0.0",
  "level": 1,
  "notApplicable": [
    { "id": "V17", "reason": "The product has no WebRTC.", "recorded": "2026-11-14" }
  ]
}
```

It holds the ASVS version, the chosen level (level 1 while the file does not say otherwise) and the "not applicable"
entries: a requirement, a section or a chapter, with a reason of 3 to 300 characters and the date it was recorded. There
is no end date, because applicability does not expire. It is written entry by entry, with a preview and an undo; it
refuses a file that changed since it was read, and it is never rewritten when it cannot be parsed. It belongs to the
project, like the waivers; nothing about it is stored elsewhere.

## Source and licence of the text

The requirement text is the official text of OWASP ASVS 5.0.0, shipped unchanged in `jgates/vendor/owasp-asvs/`:

> OWASP Application Security Verification Standard 5.0.0, Copyright © 2008-2025 The OWASP Foundation, licensed under
> [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/).
> Source: <https://github.com/OWASP/ASVS> (release `v5.0.0_release`).

The licence applies to that folder only; JGates's code, screens and mapping stay under the project's own licence. The
text and the chapter and section names are shown in English in both interface languages, marked as English, because a
translation would be an adaptation and not the official text. The screen, the text output and the `source` block of the
JSON output carry the attribution.

## What the map never claims

- That a requirement is met, satisfied or passed, or that the project meets the standard or holds any attestation of it.
- A percentage, a score or a badge.
- That a requirement is examined when its check did not run, or when the run used another version of the pack.
- That a requirement is not applicable because a model said so.
- That a check covers more than its row says: each row states what the check misses.

See also [Quality integrations](quality-integrations.en.md), [the Semantic methods](semantic-methods.en.md) and
[security](security.en.md).
