# Semantic mascots

The Semantic gate has its own six mascots, one per phase of the Cloudflare security-audit method. They are animated 3D
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

Each mascot is a three-quarter view with the study's lighting, drawn by one shared WebGL context into the mascot's own
canvas. A mascot that is first shown appears in its state as it is; when its state changes it plays the reaction of the
new state for a few seconds and then holds a pose that depends on the state alone. Only "working" keeps moving (and
Atlas after a failure, whose needle never stops), and frames are drawn only while something moves (a settled mascot is
redrawn from a copy). The movement follows the Quality mascots: eased phases and damped springs, a small hop and arched
eyes for success, a recoil and worried brows for failure, a lean and a half-closed eye for doubt. The arms are
rubber hoses, as in the cartoons the family comes from: one hose of even thickness that reaches the hand in a single
arc and never shows an elbow, ending in a plain mitt of the body's color. At rest they hang at the sides; a hand in
front of the body is reached round the body, never through it.

| Mascot | Working | Done | Incomplete | Failed |
|---|---|---|---|---|
| Atlas | looks for north: the needle (a red half for north, a light half for south, over the fixed rose) swings to one side and the other, at most 20 degrees, each swing with its own angle and duration and a small quiver as it stops | the needle returns to north | the needle wavers and stops off north | the needle spins without end like a haunted compass, now racing, now almost stopping |
| Trace | hunts: the lens sways along a trail, darts at a find and the rattle shakes | a nod, a flash across the lens, a shake of the rattle | the head tilts: the trail was lost | rears back, then hangs its head |
| Verdict | holds a balance: the candidate (a cube) tips it, the evidence (another cube) swings it back, and it comes to rest level | leaps, comes down as a gavel does until the whole face of its head is flat on the block, and stays leaning on it | one pan still down, with the candidate alone | the beam swings wildly and hangs to one side, empty |
| Fit | takes a mass with no shape (each one turned another way), models it in three pats into the shape of a socket and seats it; three records, then the next batch | every socket holds its record | one record seated, one half modelled | the square record jams at the triangular socket |
| Seal | stamps one approval mark after another along the receipt | three marks in a row | hovers over a receipt with one mark | the mark it leaves is a red cross |
| Folio | writes the two lines of the report with a pencil of its own color and raises the bars of its chart | the whole report, the bars cheer | a report that stops halfway | the chart collapses |

While a mascot works, currents run along the tracks of the brain in the capsule, each track at its own speed and some
against the others, on a clock all the mascots share; the brain glows steadily once done, and gives three slow sparks
and goes dark on a failure. A waiting mascot is dimmed and only breathes while another one works; a cancelled one comes
to rest. "Working" also pulses the badge. With `prefers-reduced-motion` nothing moves: every state shows its still pose
(for "working", one moment of the action).

Two mascots have a second build that is kept for comparison (`variants` in
`jgates/ui/src/mascots/semantic/catalog.js`; the first name is the one shown): Verdict weighing with its palms and
hopping to strike the block instead of holding a balance, and Seal with arms instead of without.

Where WebGL is unavailable each mascot shows its pre-rendered still image (`jgates/ui/src/mascots/semantic/fallback/`,
rendered from the same models by `node jgates/scripts/render-semantic-mascots.mjs`) with the same label and badge. The
pictures have a transparent background, so the light and dark themes use the same drawing.

Every mascot has `role="img"` and an accessible label with its name, phase and state, in English and Portuguese.
