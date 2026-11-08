# Semantic mascots

The Semantic gate has its own four mascots. They are flat outlined SVG characters and a different family from the six
Quality mascots; Quality's mascots never show AI work and these never show a Quality domain.

| Mascot | Responsibility | Stages it shows |
|---|---|---|
| Scout | Analysis: map the code and plan the coverage | `reconnaissance`, `coverage-planning`, `semantic-context` |
| Tracker | Investigation: hunt for candidate problems | `hunting`, `hunt`, `semantic-review` |
| Challenger | Adversarial validation: try to refute coverage and candidates | `coverage-critic`, `refutation`, `validate` |
| Verifier | Reporting: independent verification of the final records | `verification` and any reporting stage |

Each stage belongs to exactly one mascot. A stage id is read without its module prefix (`security-audit/hunting` is
`hunting`).

## Where the grouping comes from

- **Cloudflare security audit** (pinned workflow in `jgates/vendor/cloudflare-security-audit/prompts`): reconnaissance
  and coverage planning only build a picture and a plan (Scout); hunting is the one phase that produces candidates
  (Tracker); the coverage critic and the per-candidate refutation are independent contexts whose job is to disprove
  (Challenger); verification re-checks every retained record in a fresh context before the report (Verifier).
- **General review** (the Semantic prompts in `semantic-gate/templates`, run by the `hunt` / `validate` stages of the
  built-in investigation module): `hunt` examines and reports candidates (Tracker), `validate` judges each candidate
  in a fresh context (Challenger). The context-gathering step maps to Scout.
- A stage id that is not listed still gets one mascot, chosen by its role: a verify-mode stage or a report/summary id goes
  to Verifier, a `validate` stage to Challenger, an id about recon/plan/context/scope to Scout, anything else to
  Tracker. A new module therefore needs no code change to appear.

The prompts are the reason for four mascots rather than one per prompt: six Cloudflare prompts collapse to the four
responsibilities above, and the general review reuses them.

## States

Waiting, working, done, incomplete, failed and cancelled. A badge in the corner repeats the state, so color is not the
only signal.

- `done` needs every stage of the mascot to be completed. Missing stages, an exhausted budget or a stage that was not run
  show `incomplete`; an invalid, timed-out or failed stage shows `failed`.
- A run that is no longer running never leaves a mascot waiting or working.
- A cancelled run never shows a mascot as done: stages that finished before the cancellation show `incomplete` (their
  evidence is kept, the run is not complete), the rest show `cancelled`.

## Accessibility and themes

Every SVG has `role="img"` and an accessible label for the mascot and its state, in English and Portuguese. Colors come from
the app theme variables, so light and dark themes use the same drawing; the size follows `--sem-mascot-size` and
shrinks with its container. The animation (a needle, a lens sweep, a spark, a stamp) runs only while working and is turned
off under `prefers-reduced-motion`.
