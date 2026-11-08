# Cloudflare security-audit skill: attribution and adaptation notice

- Upstream: https://github.com/cloudflare/security-audit-skill
- Revision (pinned commit): `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (2026-09-14), path `skills/security-audit`
- License: MIT, Copyright (c) 2025-2026 Cloudflare, Inc. The full upstream license text is in `LICENSE` and must
  travel with this folder.
- Used by: the JGates Semantic method `security-audit` (`jgates/src/core/semantic-modules/cloudflare`).

## Kept verbatim

`attack-classes/` holds the upstream `ATTACK-CLASSES.md` and the ten domain companion files unchanged
(`AI-AND-LLM.md`, `CLIENT-SIDE.md`, `CLOUD-AND-DEPLOYMENT.md`, `DATA-ISOLATION-AND-LIFECYCLE.md`,
`DESKTOP-MOBILE-AND-LOCAL-IPC.md`, `MEMORY-SAFETY-AND-BINARY.md`, `PROTOCOLS-RPC-AND-MESSAGING.md`,
`RESOURCE-EXHAUSTION-AND-AVAILABILITY.md`, `SUPPLY-CHAIN-AND-RELEASE.md`, `WEB-PROTOCOL-AND-AUTH.md`). As upstream
requires, the hunting context receives each selected block copied verbatim (ordinary blocks, and for each companion its
Core discipline, the chosen classes, Universal moves and Validation rules); block references are checked against these
files.

## Adapted

`prompts/` holds the phase instructions adapted from `SKILL.md`, `RECONNAISSANCE.md`, `HUNTING.md` and
`VALIDATION-AND-REPORTING.md`. Each file names its upstream sections. The adaptation keeps the six phases, the
deterministic coverage ledger (canonical references, RFC 3986 coverage IDs, the state table, prior-run handling), the
candidate gate and the three distinct verdict branches, the independent refutation in a fresh context with freedom to
reject, the separate fresh verification of every retained record, and the report structure. What changed, and why:

1. Execution boundary. JGates gives every context host tools that only list, read and search the resolved scope; no
   OS-enforced sandbox exists, so no target code runs. Every ledger check is a source check (`method: "source"`,
   `artifact: null`) and the artifact-promotion procedure does not apply. A decisive fact that needs execution is a
   `needs_validation` blocker with a local validation plan, exactly as upstream prescribes when a sandbox control is
   unavailable.
2. Evidence basis of `confirmed`. Upstream's `confirmed` record carries an observed local `execution`. Here a
   `confirmed` record carries `source_argument` and `evidence_basis: "source-argument"` instead, only when the source
   alone establishes the boundary result with no decisive runtime, deployment or environment fact; it is never
   presented as a reproduction. Everything else of the confirmed branch (root cause, intended behavior, ordered trace,
   evidence, conditions, remediation, severity with overall not above impact, confidence) is kept.
3. Agent fan-out. Upstream's parallel agents become bounded separate contexts of the JGates executor: the four
   reconnaissance agents are one reconnaissance context with their four sections; the parent's synthesis is a fresh
   coverage-planning context; one hunting context per run owns the planned units of the resolved scope; one fresh
   coverage critic follows (its capacity is reserved before hunting, like validation); one fresh refutation context
   per candidate; one fresh verification context per retained record, kept separate from refutation at every rigor.
4. Hunting waves. One hunting wave runs per run at every rigor, then the critic, as upstream's `quick` profile does:
   accepted missing units and reassignments are recorded `deferred` and become current work of the next run through
   the prior-ledger handling. The `standard` and `deep` loop "repeat waves until a clean critic pass" is therefore
   spread across runs, and the report never claims clean coverage when the critic proposed work.
5. Parent and validators. The parent's files are host code: the host derives every coverage ID, enforces the ledger
   state table, applies hunting, critic and decision results to the ledger, re-checks every evidence reference
   against the current source, and writes `findings.json`, `coverage-ledger.json`, `run-metadata.json`,
   `REPORT.md`, `FINDINGS-DETAIL.md`, `NEEDS-VALIDATION.md` and an agent context. The upstream
   `validate-findings.cjs`, `validate-coverage-ledger.cjs`, their tests and `report-schema.json` are not shipped;
   their checks are reimplemented in the module (`records.ts`, `ledger.ts`, `checks.ts`).
6. Additions. The ledger gains the status `unsupported` (a class this source-only run cannot examine) and a derived
   state (examined, pending, unsupported, not-applicable, out-of-scope); records gain `impact` (the affected principal
   or resource and result) and, for `needs_validation`, an owner `priority` that is not a severity. Prior ledgers are
   read only from the baseline Semantic run a scope names, never from a Git reference.
7. Replacement rule of Phase 5. A verified record stands; a demotion of `confirmed` to `needs_validation` applies; a
   promotion, a rejection or a material change is not applied and leaves the record unresolved (the run is
   incomplete) until another independent verification settles it.

Upstream `README.md`, the installation instructions and the file-writing setup of full audit mode (output directory,
write isolation, scratch and artifact directories) are not vendored: JGates owns the run folder and its artifacts.
