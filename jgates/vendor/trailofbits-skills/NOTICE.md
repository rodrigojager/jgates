# Trail of Bits skills: attribution, license and adaptation notice

- Upstream: https://github.com/trailofbits/skills
- Revision (pinned commit): `e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff` (2026-11-06)
- Creator and attribution: Trail of Bits (https://www.trailofbits.com/); plugin authors as named upstream:
  differential-review by Omar Inuwa, variant-analysis by Axel Mierczuk, insecure-defaults by Trail of Bits.
- License: Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0,
  https://creativecommons.org/licenses/by-sa/4.0/). The full license text is in `LICENSE` (copied unchanged from the
  upstream repository root) and must travel with this folder. The upstream repository has a single license for all of
  its content; no file used here carries a per-file license or copyright exception (checked at the pinned commit:
  no other LICENSE file, no license, copyright or SPDX line in the three plugins).
- Used by: the JGates Semantic methods `differential-review` (`jgates/src/core/semantic-modules/differential`),
  `variant-analysis` (`.../variant`) and `insecure-defaults` (`.../insecure-defaults`). The method
  `cross-component` (`.../cross-component`) and the root-cause correlation (`jgates/src/core/correlation`) are original
  JGates work and use no material from this folder.

## ShareAlike and attribution obligations

- Attribution: this notice names the creator, the source URL, the pinned commit and the license, and states that the
  material was modified and how (below). Keep this notice and `LICENSE` with every copy of the folder.
- ShareAlike: the adapted files in this folder (`differential-review/method.md`, `variant-analysis/method.md`,
  `insecure-defaults/method.md`) are adaptations of CC BY-SA 4.0 material and are licensed under CC BY-SA 4.0 too.
  Anyone may redistribute and adapt them under the same license. No additional terms or technological measures restrict
  them.
- Scope of ShareAlike: the JGates TypeScript modules that load these files at run time are separate works that read the
  material as data; they do not contain its text. JGates' own code keeps its own license.
- No endorsement: Trail of Bits does not endorse JGates or this adaptation.

## Kept verbatim

`insecure-defaults/categories/` holds five upstream category corpora unchanged, each a `.md` (Report when / Skip when
and worked vulnerable/secure pairs) and its `.json` (seed patterns):
`fallback-secrets`, `default-credentials`, `fail-open-security`, `permissive-access`, `debug-features`
(upstream `plugins/insecure-defaults/references/<category>.md|json`). The verification context of a candidate receives
the corpus of its own category, as upstream prescribes; the host runs the seed patterns (POSIX ERE translated to the
equivalent JavaScript classes) over the readable files.

## Adapted

| File | Upstream sources |
| --- | --- |
| `differential-review/method.md` | `plugins/differential-review/skills/differential-review/SKILL.md`, `methodology.md` |
| `variant-analysis/method.md` | `plugins/variant-analysis/skills/variant-analysis/SKILL.md`, `references/root-cause.md`, `references/searching.md`, `references/triage.md`, `references/reporting.md` |
| `insecure-defaults/method.md` | `plugins/insecure-defaults/README.md`, `commands/audit.md`, `workflows/audit.js` (Recon, Discover and Verify prompts) |

What changed, and why:

1. Execution boundary. JGates gives every context host tools that only list, read and search the resolved scope.
   Upstream's shell commands (git diff, git blame, git log -S, grep, CodeQL, Semgrep) are replaced by host code: the
   host extracts the change against the comparison baseline, finds the history of removed lines, the callers of changed
   functions and the seed-pattern matches before any model call, and gives them to the stages as untrusted data. No
   target code runs.
2. Stages and fresh contexts. Upstream's phases and parallel agents become bounded stages of the JGates executor, each
   with its own context: differential review = triage, analysis, independent challenge (one fresh context per
   candidate); variant analysis = root cause and calibration, sweep, triage (one fresh context per variant); insecure
   defaults = reconnaissance, sweep, verification (one fresh context per candidate instead of batches of sixteen).
3. Verdicts. Upstream's verdicts are mapped to JGates' three confirmation states. Upstream insecure-defaults refutes a
   candidate whose trace is incomplete; here an incomplete trace is needs-validation (an unsettled claim is never
   rejected without cited evidence and never favorable). A rejected verdict cites the code that refutes it.
4. Applicability. Upstream's "when not to use" rules are host checks: differential review needs a comparison baseline
   (an incremental scope with a base), variant analysis needs a confirmed root cause (a confirmed candidate of an earlier
   Semantic run, or a seed given by the caller), insecure defaults needs configuration or initialization paths. Without
   them the method reports not applicable with the reason and sends nothing.
5. Reporting. Upstream's markdown report files are replaced by host-written JSON evidence under the run's `evidence/`
   folder; the variant methodology table (patterns, matches, noise) and the false-positive table grouped by reason are
   kept as fields.
6. Consolidation with the JGates baseline. Weak cryptography is not a separate insecure-defaults category (the JGates
   Semgrep pack's weak-hash/weak-cipher rules and the Cloudflare baseline's cryptography class cover it); a weak
   algorithm that is the default of a configurable setting is judged as a fail-open switch. Committed-credential
   detection is left to the Quality secret scanners; default credentials are judged only as seeded or fallback accounts
   a deployment can log in with, and values are never quoted.
7. Not shipped: upstream plugin manifests, commands, agents, the adversarial-modeler agent, report templates, the
   Trail of Bits logo, CodeQL and Semgrep resources, workflows, evals and tests, and the `weak-crypto` corpus.
