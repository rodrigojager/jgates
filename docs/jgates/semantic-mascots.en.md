# Semantic mascots

The Semantic gate has its own six mascots, one per phase of the Cloudflare security-audit method. They are static 3D
models of the same family as the six Quality mascots (satin vinyl, the family's eyes, arms and boots) with a clear brain
capsule on top; Quality's mascots never show AI work and these never show a Quality domain.

| Mascot | Phase | Stages it shows |
|---|---|---|
| Atlas (compass) | Reconnaissance: map the code, its surfaces and trust boundaries, and plan the coverage | `reconnaissance`, `coverage-planning`, `semantic-context` |
| Trace (serpent magnifier) | Coverage-led hunting: hunt for candidates and find the coverage gaps | `hunting`, `coverage-critic`, `hunt`, `semantic-review` |
| Verdict (gavel) | Candidate validation: try to refute each candidate against the source | `refutation`, `validate` |
| Fit (shape sorter) | Structured output: schema-shaped records and the ledger check | `structured-output`, or none (done by JGates) |
| Seal (rubber stamp) | Independent verification: re-check the final records in a fresh context | `verification` |
| Folio (report clipboard) | Target-neutral reporting: the readable report from the verified records | `reporting`, `report`, or none (done by JGates) |

Each stage belongs to exactly one mascot. A stage id is read without its module prefix (`security-audit/hunting` is
`hunting`).

## Where the grouping comes from

- **Cloudflare security audit** (pinned workflow in `jgates/vendor/cloudflare-security-audit/prompts`): the six mascots
  are its six phases. Reconnaissance and the coverage plan (the parent's synthesis of phase 1) are Atlas; the hunting
  wave and its coverage critic are phase 2, Trace; the per-candidate refutation is phase 3, Verdict; verification
  re-checks every retained record in a fresh context, phase 5, Seal. Phases 4 (structured output) and 6 (reporting) are
  host code in JGates (it validates and writes the records, then derives the reports), so Fit and Folio usually own no
  model stage.
- **General review** (the Semantic prompts in `semantic-gate/templates`, run by the `hunt` / `validate` stages of the
  built-in investigation module): `hunt` examines and reports candidates (Trace), `validate` judges each candidate in a
  fresh context (Verdict). The context-gathering step maps to Atlas. It has no independent verification.
- A stage id that is not listed still gets one mascot, the closest phase: a verify-mode stage or a verification id goes to
  Seal, a report/summary id to Folio, an output/format/schema/record id to Fit, a `validate` stage or a
  refutation/critic id to Verdict, an id about recon/plan/context/scope to Atlas, anything else to Trace. A new module
  therefore needs no code change to appear.
- Runs stored with the first four mascots (`scout`, `tracker`, `challenger`, `verifier`) still read: those ids resolve to
  Atlas, Trace, Verdict and Seal.

## States

Waiting, working, done, incomplete, failed and cancelled. A badge in the corner repeats the state, so color is not the
only signal.

- `done` needs every stage of the mascot to be completed. Missing stages, an exhausted budget or a stage that was not run
  show `incomplete`; an invalid, timed-out or failed stage shows `failed`.
- A phase with no stage of its own waits while the run goes. Once the run stops, a model phase with no stage is
  `incomplete` (it did not happen, as verification in a general review), while Fit and Folio, done by JGates after the
  model stages, are `done` when every stage of the run completed and `incomplete` otherwise.
- A run that is no longer running never leaves a mascot waiting or working.
- A cancelled run never shows a mascot as done: stages that finished before the cancellation show `incomplete` (their
  evidence is kept, the run is not complete), the rest show `cancelled`.

## Rendering, accessibility and themes

The models never move. Each one is a static three-quarter pose with the study's lighting, drawn on demand from one shared
WebGL context into the mascot's own canvas (no animation loop; a size seen before is redrawn from a copy). "Waiting"
dims the model and "working" pulses the badge, which stops under `prefers-reduced-motion`. Where WebGL is unavailable
each mascot shows its pre-rendered image (`jgates/ui/src/mascots/semantic/fallback/`, rendered from the same models by
`node jgates/scripts/render-semantic-mascots.mjs`) with the same label and badge. The pictures have a transparent
background, so the light and dark themes use the same drawing.

Every mascot has `role="img"` and an accessible label with its name, phase and state, in English and Portuguese.
