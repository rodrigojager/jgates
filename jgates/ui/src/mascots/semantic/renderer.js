import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { disposeTree } from '../actors/geometry.js';
import { SEMANTIC_MASCOT_MODELS, SEMANTIC_MASCOT_STATES } from './catalog.js';
import { createModel } from './models.js';
import { SemanticActor } from './actor.js';

// One shared WebGL context for every Semantic mascot on the page. Each mascot is its own 2D canvas in its card (so its
// state can dim it with CSS): the shared context draws one mascot at a time (three-quarter view, the study's lighting
// and framing) and the picture is copied into that mascot's canvas.
//
// Frames are drawn only while something moves: a mascot that works, or one playing the reaction of the state it has
// just entered (actor.js). A mascot that is first shown appears in its state as it is, without a reaction, and a
// settled mascot is not drawn again: its picture is kept per size and reused. With `prefers-reduced-motion` nothing
// moves at all. The context is released after RELEASE_MS without a frame; the pictures stay.

const ANGLE = 18; // degrees: the study's default three-quarter turn
const UNITS = 3.85; // visible height in model units, the study's card framing
const RELEASE_MS = 15_000;
const CACHE_LIMIT = 48;

export class WebGLUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'WebGLUnavailableError'; }
}

let shared = null;
let unavailable = null;
let releaseTimer = 0;
let frame = 0;
let lastTime = 0;
let clock = 0; // seconds of animation so far: the beat the brains of all mascots share
let motionQuery = null;
let motionOverride = null;
const slots = new Map();
const variants = {};
const cache = new Map();
const stats = { contexts: 0, renders: 0, paints: 0, frames: 0 };

function reducedMotion() {
  if (motionOverride !== null) return motionOverride;
  if (!motionQuery && typeof globalThis.matchMedia === 'function') {
    motionQuery = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
    motionQuery.addEventListener?.('change', applyMotion);
  }
  return !!motionQuery?.matches;
}

function applyMotion() {
  const reduced = reducedMotion();
  for (const slot of slots.values()) { slot.actor?.setReducedMotion(reduced); slot.dirty = true; }
  schedule();
}

function contactShadow() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const ctx = c.getContext('2d'), gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(0,0,0,.38)'); gradient.addColorStop(.4, 'rgba(0,0,0,.22)'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** The shared renderer and its stage (lights, ground shadow, camera), created on the first request. */
function context() {
  if (unavailable) throw unavailable;
  if (shared) return shared;
  const canvas = document.createElement('canvas');
  canvas.className = 'semantic-mascots-gl';
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'low-power' });
  if (!gl) { unavailable = new WebGLUnavailableError('WebGL 2 is not available'); throw unavailable; }
  stats.contexts++;
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = .96;
  renderer.setClearColor(0x000000, 0);
  const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, .04); room.dispose(); pmrem.dispose();
  const scene = new THREE.Scene(); scene.environment = environment.texture; scene.environmentIntensity = .38;
  const camera = new THREE.OrthographicCamera(-2, 2, 1.9, -1.9, .1, 50);
  camera.position.set(0, 2.67, 9.25); camera.lookAt(0, 1.56, 0);
  scene.add(new THREE.HemisphereLight('#fff0d9', '#505b80', .75));
  const key = new THREE.DirectionalLight('#fff0da', 2.3); key.position.set(-3, 6, 5); scene.add(key);
  const rim = new THREE.DirectionalLight('#b2c7ff', 1.6); rim.position.set(3, 4, -3); scene.add(rim);
  const fill = new THREE.DirectionalLight('#ffffff', .4); fill.position.set(1, 1, 5); scene.add(fill);
  const shadowTexture = contactShadow();
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.9), new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = .018; scene.add(shadow);
  const state = { canvas, renderer, environment, shadowTexture, scene, camera, width: 0, height: 0, lost: false };
  state.onLost = (event) => { event.preventDefault(); state.lost = true; };
  canvas.addEventListener('webglcontextlost', state.onLost);
  shared = state;
  return state;
}

/** Draws one model on the stage at a pixel size; the picture is in the shared canvas until the task ends. */
function draw(model, width, height) {
  let state = context();
  if (state.lost) { release(); state = context(); }
  const { scene, camera, renderer } = state;
  const halfW = UNITS * width / height / 2;
  camera.left = -halfW; camera.right = halfW; camera.top = UNITS / 2; camera.bottom = -UNITS / 2; camera.updateProjectionMatrix();
  // Resizing reallocates the drawing buffer: only when the size really changed.
  if (state.width !== width || state.height !== height) { renderer.setSize(width, height, false); state.width = width; state.height = height; }
  model.rotation.y = -THREE.MathUtils.degToRad(ANGLE);
  scene.add(model);
  try { renderer.clear(); renderer.render(scene, camera); } finally { scene.remove(model); }
  stats.renders++;
  scheduleRelease();
  return state.canvas;
}

function remember(key, source, width, height) {
  const copy = document.createElement('canvas'); copy.width = width; copy.height = height;
  copy.getContext('2d').drawImage(source, 0, 0);
  cache.delete(key); cache.set(key, copy);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function show(slot, source, width, height, key) {
  const target = slot.target;
  if (target.width !== width || target.height !== height) { target.width = width; target.height = height; }
  const ctx = target.getContext('2d');
  ctx.clearRect(0, 0, width, height); ctx.drawImage(source, 0, 0);
  slot.key = key; slot.dirty = false;
  target.dataset.picture = key;
  target.dataset.painted = String(Number(target.dataset.painted ?? 0) + 1);
  stats.paints++;
}

function answer(slot, value, error) {
  const waiting = slot.waiting; slot.waiting = [];
  for (const w of waiting) error ? w.reject(error) : w.resolve(value);
}

function drop(slot) {
  slots.delete(slot.target);
  slot.actor?.dispose(); slot.actor = null;
  answer(slot, false);
}

function schedule() {
  if (!frame && slots.size && typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(tick);
}

function tick(now) {
  frame = 0;
  if (document.hidden) { lastTime = 0; return; } // resumed by the visibility listener
  const dt = lastTime ? Math.min((now - lastTime) / 1000, .05) : 0;
  lastTime = now; clock += dt; stats.frames++;
  const reduced = reducedMotion();
  const busy = [...slots.values()].some(s => s.actor?.animating);
  let moving = false;
  for (const slot of [...slots.values()]) {
    try {
      const target = slot.target;
      if (!target.isConnected) { drop(slot); continue; }
      const rect = target.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) { answer(slot, false); continue; }
      const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
      const width = Math.round(rect.width * ratio), height = Math.round(rect.height * ratio);
      const key = `${slot.id}:${slot.state}:${width}x${height}`;
      const actor = slot.actor;
      const animating = !!actor?.animating;
      // A waiting mascot breathes, at half the rate, while another one is at work; alone it stays still.
      const ambient = !animating && !reduced && busy && slot.state === 'waiting' && !!actor && stats.frames % 2 === 0;
      target.dataset.animating = String(animating);
      if (!animating && !ambient && !slot.dirty && slot.key === key) { answer(slot, true); continue; }
      const visible = rect.bottom > 0 && rect.right > 0 && rect.top < globalThis.innerHeight && rect.left < globalThis.innerWidth;
      if ((animating || ambient) && !visible && !slot.dirty && slot.key) {
        // Out of sight: the action goes on, nothing is drawn.
        actor.update(dt, clock); moving ||= animating; answer(slot, true); continue;
      }
      if (!animating && !ambient && !actor && cache.has(key)) { show(slot, cache.get(key), width, height, key); answer(slot, true); continue; }
      const live = slot.actor ??= new SemanticActor(slot.id, { state: slot.state, reducedMotion: reduced, variant: variants[slot.id] });
      live.update(dt, clock);
      const picture = draw(live.object, width, height);
      // Copied in the same task as the render: the drawing buffer is still the one just drawn.
      show(slot, picture, width, height, key);
      if (live.animating) moving = true;
      else if (slot.state !== 'waiting' || !busy) remember(key, picture, width, height);
      target.dataset.animating = String(live.animating);
      answer(slot, true);
    } catch (error) {
      answer(slot, false, error);
      if (error instanceof WebGLUnavailableError) { for (const other of slots.values()) answer(other, false, error); return; }
    }
  }
  if (moving) schedule(); else lastTime = 0;
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { lastTime = 0; if (!document.hidden) schedule(); });

/**
 * Shows mascot `id` in `state` in a 2D canvas, at the canvas's displayed size (times the device pixel ratio, at most 2).
 * The first call for a canvas shows the state as it is; a later call with another state plays that state's reaction, and
 * "working" keeps moving until the state changes. Resolves true once painted (false when the canvas is not displayed);
 * rejects with WebGLUnavailableError when the page has no WebGL. Call forgetSemanticMascot when the canvas goes away.
 */
export function paintSemanticMascot(target, id, state = 'done') {
  if (unavailable) return Promise.reject(unavailable);
  if (!SEMANTIC_MASCOT_MODELS[id]) return Promise.reject(new TypeError(`Unknown Semantic mascot: ${id}`));
  if (!SEMANTIC_MASCOT_STATES.includes(state)) return Promise.reject(new TypeError(`Unknown Semantic mascot state: ${state}`));
  let slot = slots.get(target);
  if (slot && slot.id !== id) { drop(slot); slot = null; }
  if (!slot) { slot = { target, id, state, actor: null, key: '', dirty: true, waiting: [] }; slots.set(target, slot); }
  else if (slot.state !== state) {
    slot.state = state; slot.dirty = true;
    slot.actor?.setState(state);
  } else slot.dirty = true; // the size may have changed
  return new Promise((resolve, reject) => { slot.waiting.push({ resolve, reject }); schedule(); });
}

/** Plays the reaction of the mascot's current state again. */
export function replaySemanticMascot(target) {
  const slot = slots.get(target);
  if (!slot) return;
  slot.actor ??= new SemanticActor(slot.id, { state: slot.state, reducedMotion: reducedMotion(), variant: variants[slot.id] });
  slot.actor.replay(); slot.dirty = true; schedule();
}

/** Stops showing a mascot in a canvas that is going away. */
export function forgetSemanticMascot(target) {
  const slot = slots.get(target);
  if (slot) drop(slot);
}

/** Forces reduced motion on or off; null follows the system preference again. */
export function setSemanticMascotMotion(reduced) {
  motionOverride = reduced === null || reduced === undefined ? null : !!reduced;
  applyMotion();
}

/**
 * Shows another variant of a mascot (catalog.js lists them; null goes back to the default one). For comparing two
 * builds side by side in the lab; the product shows the default.
 */
export function setSemanticMascotVariant(id, variant) {
  const spec = SEMANTIC_MASCOT_MODELS[id];
  if (!spec) throw new TypeError(`Unknown Semantic mascot: ${id}`);
  if (variant !== null && variant !== undefined && !spec.variants?.includes(variant)) throw new TypeError(`Unknown variant of ${id}: ${variant}`);
  if (variant === null || variant === undefined) delete variants[id]; else variants[id] = variant;
  for (const key of [...cache.keys()]) if (key.startsWith(`${id}:`)) cache.delete(key);
  for (const slot of slots.values()) if (slot.id === id) { slot.actor?.dispose(); slot.actor = null; slot.dirty = true; }
  schedule();
}

/** A picture of one mascot in its resting pose, as a data URL (the fallback images are made with it). */
export function renderSemanticMascotImage(id, width, height, type = 'image/webp', quality = .92) {
  const spec = SEMANTIC_MASCOT_MODELS[id];
  if (!spec) throw new TypeError(`Unknown Semantic mascot: ${id}`);
  const model = createModel(spec, { variant: variants[id] });
  try {
    const out = document.createElement('canvas'); out.width = width; out.height = height;
    out.getContext('2d').drawImage(draw(model, width, height), 0, 0);
    return out.toDataURL(type, quality);
  } finally {
    model.traverse(o => { if (o.material?.map) o.material.map.dispose(); });
    disposeTree(model);
  }
}

/** Counters for the tests: contexts created, renders, canvases painted, frames, and what is moving now. */
export function inspectSemanticMascots() {
  const shown = [...slots.values()];
  return { ...stats, alive: shared !== null, cached: cache.size, unavailable: unavailable !== null, reducedMotion: reducedMotion(),
    animating: shown.filter(s => s.actor?.animating).length,
    mascots: shown.map(s => ({ id: s.id, state: s.state, animating: !!s.actor?.animating, ...(s.actor ? { pose: s.actor.inspect() } : {}) })) };
}

function scheduleRelease() {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    // Never under a mascot that is still moving.
    if ([...slots.values()].some(s => s.actor?.animating)) scheduleRelease(); else release();
  }, RELEASE_MS);
}

/** Frees the WebGL context and the models; the painted pictures stay. */
export function release() {
  clearTimeout(releaseTimer);
  const state = shared;
  if (!state) return;
  shared = null;
  state.canvas.removeEventListener('webglcontextlost', state.onLost);
  for (const slot of slots.values()) { slot.actor?.dispose(); slot.actor = null; }
  state.shadowTexture.dispose(); state.environment.dispose();
  disposeTree(state.scene);
  state.renderer.dispose();
  if (!state.lost) state.renderer.forceContextLoss();
}
