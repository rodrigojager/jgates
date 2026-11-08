/**
 * Semantic/AI mascots: four flat, outlined SVG characters (a different family from the six solid 3D Quality mascots).
 * Pure functions, no DOM and no framework: they return SVG markup. Colors come from the app theme variables, so light and
 * dark themes need no second drawing. Animation is plain CSS and is switched off under prefers-reduced-motion.
 */
export const SEMANTIC_MASCOT_IDS = Object.freeze(['scout', 'tracker', 'challenger', 'verifier']);
export const SEMANTIC_MASCOT_STATES = Object.freeze(['waiting', 'working', 'done', 'incomplete', 'failed', 'cancelled']);

const NAMES = {
  en: { scout: 'Scout, analysis', tracker: 'Tracker, investigation', challenger: 'Challenger, adversarial validation', verifier: 'Verifier, reporting' },
  'pt-BR': { scout: 'Batedor, análise', tracker: 'Rastreador, investigação', challenger: 'Desafiante, validação adversarial', verifier: 'Verificador, relatório' },
};
const STATES = {
  en: { waiting: 'waiting for its turn', working: 'working', done: 'done', incomplete: 'incomplete', failed: 'failed', cancelled: 'cancelled' },
  'pt-BR': { waiting: 'aguardando a vez', working: 'trabalhando', done: 'concluído', incomplete: 'incompleto', failed: 'falhou', cancelled: 'cancelado' },
};

/** Accessible label of one mascot in one state, in en or pt-BR (any other locale falls back to en). */
export function semanticMascotLabel(mascot, state, locale = 'en') {
  const l = locale === 'pt-BR' ? 'pt-BR' : 'en';
  if (!SEMANTIC_MASCOT_IDS.includes(mascot)) throw new TypeError(`Unknown Semantic mascot: ${mascot}`);
  if (!SEMANTIC_MASCOT_STATES.includes(state)) throw new TypeError(`Unknown Semantic mascot state: ${state}`);
  return `${NAMES[l][mascot]}: ${STATES[l][state]}`;
}

// Each body is drawn in a 64x64 box with an outline (currentColor) and a soft fill; `.m-anim` is the moving part.
const BODIES = {
  // Lantern with a compass-needle eye and an antenna: it maps the territory.
  scout: `<path class="m-fill" d="M32 10 46 18v20L32 50 18 38V18z"/><path class="m-line" d="M32 10 46 18v20L32 50 18 38V18zM32 4v6"/><circle class="m-dot" cx="32" cy="4" r="2.2"/><circle class="m-eye" cx="32" cy="28" r="8"/><path class="m-anim m-needle" d="M32 21.5 35 28l-3 6.5L29 28z"/>`,
  // Long body with a magnifier lens for an eye, sweeping side to side: it hunts.
  tracker: `<rect class="m-fill" x="10" y="20" width="44" height="26" rx="13"/><rect class="m-line" x="10" y="20" width="44" height="26" rx="13"/><path class="m-line" d="M18 46v6M46 46v6"/><g class="m-anim m-lens"><circle class="m-eye" cx="32" cy="33" r="8"/><path class="m-line" d="m38 39 7 7"/></g>`,
  // Shield with a stern brow and a spark: it argues the other side.
  challenger: `<path class="m-fill" d="M32 8 50 15v14c0 11-7 19-18 25C21 48 14 40 14 29V15z"/><path class="m-line" d="M32 8 50 15v14c0 11-7 19-18 25C21 48 14 40 14 29V15z"/><path class="m-line" d="m21 23 8 3M43 23l-8 3"/><circle class="m-eye" cx="26" cy="31" r="2.6"/><circle class="m-eye" cx="38" cy="31" r="2.6"/><path class="m-anim m-spark" d="m32 38 3 5h-6z"/>`,
  // Page with a folded corner and a stamp seal: it writes the record down once checked.
  verifier: `<path class="m-fill" d="M16 8h24l10 10v38H16z"/><path class="m-line" d="M16 8h24l10 10v38H16zM40 8v10h10M22 26h18M22 33h12"/><g class="m-anim m-seal"><circle class="m-eye" cx="37" cy="44" r="7"/><path class="m-line" d="m33.5 44 2.5 2.5 4.5-5"/></g>`,
};
// A badge in the lower right corner tells the state without relying on color alone.
const BADGES = {
  done: '<circle class="m-badge" cx="52" cy="52" r="9"/><path class="m-badge-line" d="m47.5 52 3 3 6-6.5"/>',
  failed: '<circle class="m-badge" cx="52" cy="52" r="9"/><path class="m-badge-line" d="m48 48 8 8m0-8-8 8"/>',
  incomplete: '<circle class="m-badge" cx="52" cy="52" r="9"/><path class="m-badge-line" d="M47 52h10"/>',
  cancelled: '<circle class="m-badge" cx="52" cy="52" r="9"/><rect class="m-badge-line" x="48" y="48" width="8" height="8" rx="1"/>',
  waiting: '<circle class="m-badge" cx="52" cy="52" r="9"/><path class="m-badge-line" d="M52 46.5V52l3.5 2"/>',
  working: '',
};

/** Stylesheet for every mascot (inject once). Variables fall back to the app theme tokens (--blue, --gold, --red, --accent). */
export const SEMANTIC_MASCOT_CSS = `
.sem-mascot{display:inline-block;width:var(--sem-mascot-size,4.5rem);max-width:100%;height:auto;aspect-ratio:1;overflow:visible;color:var(--ink,#25342e)}
.sem-mascot .m-line,.sem-mascot .m-badge-line,.sem-mascot .m-eye{fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.sem-mascot .m-fill{fill:var(--sem-tint,var(--mint,#e6efe7));stroke:none}
.sem-mascot .m-eye{fill:var(--surface,#fff)}
.sem-mascot .m-dot,.sem-mascot .m-needle,.sem-mascot .m-spark{fill:var(--sem-accent,var(--accent,#20674f));stroke:none}
.sem-mascot .m-badge{fill:var(--sem-badge,var(--surface,#fff));stroke:currentColor;stroke-width:2.4}
.sem-mascot[data-mascot=scout]{--sem-accent:var(--blue,#536a9c);--sem-tint:var(--blue-bg,#eff2f9)}
.sem-mascot[data-mascot=tracker]{--sem-accent:var(--gold,#855716);--sem-tint:var(--gold-bg,#fcf3e3)}
.sem-mascot[data-mascot=challenger]{--sem-accent:var(--red,#aa4b3e);--sem-tint:var(--red-bg,#fbefec)}
.sem-mascot[data-mascot=verifier]{--sem-accent:var(--accent,#20674f);--sem-tint:var(--mint,#e6efe7)}
.sem-mascot[data-state=waiting] .m-fill,.sem-mascot[data-state=cancelled] .m-fill{opacity:.55}
.sem-mascot[data-state=waiting],.sem-mascot[data-state=cancelled]{opacity:.8}
.sem-mascot[data-state=failed]{--sem-badge:var(--red-bg,#fbefec);color:var(--red,#aa4b3e)}
.sem-mascot[data-state=incomplete]{--sem-badge:var(--gold-bg,#fcf3e3)}
.sem-mascot[data-state=done]{--sem-badge:var(--mint,#e6efe7)}
.sem-mascot .m-anim{transform-box:fill-box;transform-origin:center}
.sem-mascot[data-state=working] .m-needle{animation:sem-spin 2.4s linear infinite}
.sem-mascot[data-state=working] .m-lens{animation:sem-sweep 1.8s ease-in-out infinite alternate}
.sem-mascot[data-state=working] .m-spark{animation:sem-flash 1s ease-in-out infinite}
.sem-mascot[data-state=working] .m-seal{animation:sem-stamp 1.6s ease-in-out infinite}
@keyframes sem-spin{to{transform:rotate(360deg)}}
@keyframes sem-sweep{from{transform:translateX(-5px)}to{transform:translateX(5px)}}
@keyframes sem-flash{50%{opacity:.2;transform:scale(1.3)}}
@keyframes sem-stamp{50%{transform:scale(.88)}}
@media (prefers-reduced-motion:reduce){.sem-mascot .m-anim{animation:none!important}}
`;

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * SVG markup of one mascot. role="img" with an aria-label for the state, plus a <title>. The animation classes only
 * move while data-state="working".
 */
export function renderSemanticMascotSvg({ mascot, state, locale = 'en' }) {
  const label = escapeAttr(semanticMascotLabel(mascot, state, locale));
  return `<svg class="sem-mascot" data-mascot="${mascot}" data-state="${state}" role="img" aria-label="${label}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" focusable="false"><title>${label}</title>${BODIES[mascot]}${BADGES[state]}</svg>`;
}
