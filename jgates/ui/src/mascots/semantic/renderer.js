import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { disposeTree } from '../actors/geometry.js';
import { SEMANTIC_MASCOT_MODELS } from './catalog.js';
import { createModel } from './models.js';

// One shared WebGL context for every Semantic mascot on the page, rendered on demand: no animation loop, nothing is
// drawn while nothing asks. Each mascot is a static pose (three-quarter view, the study's lighting and framing) drawn
// once per size into the shared offscreen canvas and copied into the mascot's own 2D canvas, so each mascot is an
// ordinary element of its card (its state can dim it with CSS) and a size seen before is redrawn from the copy without
// any WebGL work. The context is released after RELEASE_MS without a request; the copies stay.

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
const queue = new Map();
const cache = new Map();
const stats = { contexts: 0, renders: 0, paints: 0 };

function contactShadow() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const ctx = c.getContext('2d'), gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(0,0,0,.38)'); gradient.addColorStop(.4, 'rgba(0,0,0,.22)'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** The shared renderer, created on the first request. The context is asked for once, on the canvas three.js renders to. */
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
  const state = { canvas, renderer, environment, shadowTexture: contactShadow(), views: new Map(), lost: false };
  state.onLost = (event) => { event.preventDefault(); state.lost = true; };
  canvas.addEventListener('webglcontextlost', state.onLost);
  shared = state;
  return state;
}

function view(state, id) {
  let v = state.views.get(id);
  if (v) return v;
  const spec = SEMANTIC_MASCOT_MODELS[id];
  if (!spec) throw new TypeError(`Unknown Semantic mascot: ${id}`);
  const scene = new THREE.Scene(); scene.environment = state.environment.texture; scene.environmentIntensity = .38;
  const model = createModel(spec);
  model.rotation.y = -THREE.MathUtils.degToRad(ANGLE);
  scene.add(model);
  const camera = new THREE.OrthographicCamera(-2, 2, 1.9, -1.9, .1, 50);
  camera.position.set(0, 2.67, 9.25); camera.lookAt(0, 1.56, 0);
  scene.add(new THREE.HemisphereLight('#fff0d9', '#505b80', .75));
  const key = new THREE.DirectionalLight('#fff0da', 2.3); key.position.set(-3, 6, 5); scene.add(key);
  const rim = new THREE.DirectionalLight('#b2c7ff', 1.6); rim.position.set(3, 4, -3); scene.add(rim);
  const fill = new THREE.DirectionalLight('#ffffff', .4); fill.position.set(1, 1, 5); scene.add(fill);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.9), new THREE.MeshBasicMaterial({ map: state.shadowTexture, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = .018; scene.add(shadow);
  v = { scene, camera };
  state.views.set(id, v);
  return v;
}

/** Renders one mascot at a pixel size and returns a 2D canvas holding the picture (transparent background). */
function render(id, width, height) {
  const state = context();
  if (state.lost) { release(); return render(id, width, height); }
  const { scene, camera } = view(state, id);
  const halfW = UNITS * width / height / 2;
  camera.left = -halfW; camera.right = halfW; camera.top = UNITS / 2; camera.bottom = -UNITS / 2; camera.updateProjectionMatrix();
  state.renderer.setSize(width, height, false);
  state.renderer.clear();
  state.renderer.render(scene, camera);
  // Copied in the same task as the render: the drawing buffer is still the one just drawn.
  const out = document.createElement('canvas'); out.width = width; out.height = height;
  out.getContext('2d').drawImage(state.canvas, 0, 0);
  stats.renders++;
  scheduleRelease();
  return out;
}

function picture(id, width, height) {
  const key = `${id}:${width}x${height}`;
  let image = cache.get(key);
  if (!image) {
    image = render(id, width, height);
    cache.set(key, image);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  return { key, image };
}

function flush() {
  frame = 0;
  const jobs = [...queue]; queue.clear();
  for (const [target, job] of jobs) {
    try {
      if (!target.isConnected) { job.resolve(false); continue; }
      const rect = target.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) { job.resolve(false); continue; }
      const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
      const width = Math.round(rect.width * ratio), height = Math.round(rect.height * ratio);
      const key = `${job.id}:${width}x${height}`;
      if (target.dataset.picture === key) { job.resolve(true); continue; }
      const { image } = picture(job.id, width, height);
      target.width = width; target.height = height;
      const ctx = target.getContext('2d');
      ctx.clearRect(0, 0, width, height); ctx.drawImage(image, 0, 0);
      target.dataset.picture = key;
      target.dataset.painted = String(Number(target.dataset.painted ?? 0) + 1);
      stats.paints++;
      job.resolve(true);
    } catch (error) {
      job.reject(error);
    }
  }
}

/**
 * Paints mascot `id` into a 2D canvas at the canvas's displayed size (times the device pixel ratio, at most 2). Requests
 * of the same frame are drawn together on the next animation frame. Resolves true when painted (false when the canvas
 * is not displayed); rejects with WebGLUnavailableError when the page has no WebGL.
 */
export function paintSemanticMascot(target, id) {
  if (unavailable) return Promise.reject(unavailable);
  return new Promise((resolve, reject) => {
    queue.get(target)?.resolve(false);
    queue.set(target, { id, resolve, reject });
    if (!frame) frame = requestAnimationFrame(flush);
  });
}

/** A picture of one mascot as a data URL (the fallback images are made with it). */
export function renderSemanticMascotImage(id, width, height, type = 'image/webp', quality = .92) {
  return render(id, width, height).toDataURL(type, quality);
}

/** Counters for the tests: WebGL contexts created, renders done, canvases painted, and whether a context is held. */
export function inspectSemanticMascots() {
  return { ...stats, alive: shared !== null, cached: cache.size, unavailable: unavailable !== null };
}

function scheduleRelease() {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(release, RELEASE_MS);
}

/** Frees the WebGL context and the models; the painted copies stay. */
export function release() {
  clearTimeout(releaseTimer);
  const state = shared;
  if (!state) return;
  shared = null;
  state.canvas.removeEventListener('webglcontextlost', state.onLost);
  for (const v of state.views.values()) {
    v.scene.traverse(o => { if (o.material?.map) o.material.map.dispose(); });
    disposeTree(v.scene);
  }
  state.shadowTexture.dispose(); state.environment.dispose();
  state.renderer.dispose();
  if (!state.lost) state.renderer.forceContextLoss();
}
