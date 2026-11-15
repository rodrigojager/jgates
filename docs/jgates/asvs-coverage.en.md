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

## The command

```bash
jgates coverage asvs [--level 1|2|3] [--run <id>] [--semantic-run <id>] [--state <state>] [--chapter <id>] [--subdimension <id>] [--deterministic-only] [--json]
jgates coverage asvs level <1|2|3>
jgates coverage asvs not-applicable <requirement|section|chapter> --reason "<text>" [--preview] [--yes]
jgates coverage asvs not-applicable <requirement|section|chapter> --remove
jgates coverage asvs undo <token>
```

- With no subcommand it prints the totals, then the requirements grouped by chapter. `--level` shows another level for
  that call without changing the project's choice (level 1 has 70 requirements, level 2 has 253, level 3 has 345).
  `--run` and `--semantic-run` name the runs to read; by default it reads the last finished Quality run and the last
  finished run of each Semantic method, and warns when they analyzed different revisions. `--deterministic-only` leaves
  the Semantic units out. `--state`, `--chapter` and `--subdimension` filter the rows.
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
