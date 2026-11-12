/**
 * The six Semantic (AI) mascots, one per phase of the Cloudflare security-audit method. They come from the "thinking
 * team" 3D study (shortlist 01A Atlas, 02A Trace, 03B Verdict, 04A Fit, 05C Seal, 06A Folio; satin vinyl, palette
 * direction B, clear brain capsule). Pure data, no three.js: the screens read it without loading the 3D code.
 *
 * The ids match core/semantic-mascots (SEMANTIC_MASCOTS); the old role ids of stored runs resolve to a phase mascot.
 */
export const SEMANTIC_MASCOT_IDS = Object.freeze(['atlas', 'trace', 'verdict', 'fit', 'seal', 'folio']);
export const SEMANTIC_MASCOT_STATES = Object.freeze(['waiting', 'working', 'done', 'incomplete', 'failed', 'cancelled']);
export const LEGACY_SEMANTIC_MASCOTS = Object.freeze({ scout: 'atlas', tracker: 'trace', challenger: 'verdict', verifier: 'seal' });

/** The current mascot id of a mascot id or an old role id; null for anything else. */
export function resolveSemanticMascot(id) {
  if (SEMANTIC_MASCOT_IDS.includes(id)) return id;
  return Object.hasOwn(LEGACY_SEMANTIC_MASCOTS, id) ? LEGACY_SEMANTIC_MASCOTS[id] : null;
}

/**
 * The model of each mascot: the study id, the object anatomy (objects.js) and the body color. `color` is the study's
 * phase color (Trace's tonal materials are derived from it and rotated to hue 332); the other five use their own body
 * color of palette direction B.
 */
export const SEMANTIC_MASCOT_MODELS = Object.freeze({
  atlas: Object.freeze({ study: '01A', shape: 'compass', color: '#65cabc', bodyColor: 'hsl(194,40%,44%)' }),
  trace: Object.freeze({ study: '02A', shape: 'lenscoil', color: '#f29875', bodyHue: 332 }),
  verdict: Object.freeze({ study: '03B', shape: 'gavel', color: '#b4d982', bodyColor: 'hsl(350,42%,47%)' }),
  fit: Object.freeze({ study: '04A', shape: 'shape-sorter', color: '#eac45c', bodyColor: 'hsl(31,46%,55%)' }),
  seal: Object.freeze({ study: '05C', shape: 'stamp', color: '#b99add', bodyColor: 'hsl(67,28%,48%)' }),
  folio: Object.freeze({ study: '06A', shape: 'folio', color: '#87afe5', bodyColor: 'hsl(239,27%,51%)' }),
});

/**
 * The pre-rendered image of each mascot, shown where WebGL is unavailable. Rendered from these same models by
 * jgates/scripts/render-semantic-mascots.mjs on a transparent background, so one image serves the light and dark themes.
 */
export const SEMANTIC_MASCOT_FALLBACKS = Object.freeze({
  atlas: new URL('./fallback/atlas.webp', import.meta.url).href,
  trace: new URL('./fallback/trace.webp', import.meta.url).href,
  verdict: new URL('./fallback/verdict.webp', import.meta.url).href,
  fit: new URL('./fallback/fit.webp', import.meta.url).href,
  seal: new URL('./fallback/seal.webp', import.meta.url).href,
  folio: new URL('./fallback/folio.webp', import.meta.url).href,
});
