# JGates ASVS mapping pack

Original data written for JGates, under the MIT license (see `LICENSE`). For each version of the OWASP Application
Security Verification Standard it holds one file per chapter (`<version>/V01.json` to `V17.json`) with exactly one
entry per requirement, and `<version>/unmapped-rules.json`, which lists the rules of the JGates Semgrep pack that no
entry maps, each with a reason.

- Provenance: authored in this repository. The entries refer to requirements by id (`V1.2.4`) and never quote,
  translate or paraphrase their text. The official text is a separate data file under CC BY-SA 4.0 in
  `jgates/vendor/owasp-asvs`, with its own license and notice; that license does not extend to this pack.
- Skeleton: at the start every entry has no check, the status `unmapped` and no evidence class. A requirement gains a
  check only by an entry that says what the check covers, what it misses and why it bears on the requirement, and the
  entry counts only after an independent review sets its status to `reviewed` (or the owner's review to
  `owner-reviewed`). A `pending` entry counts for nothing.
- Format: `jgates/schemas/coverage/asvs-map.schema.json` (chapter files) and
  `jgates/schemas/coverage/asvs-unmapped-rules.schema.json`.
