import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Mascot } from './characters.js';
import { disposeTree } from './geometry.js';

/** One WebGL context for multiple independent HTML viewports. No UI framework. */
export class MascotGallery {
  constructor({ canvas, pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 1.7), reducedMotion = false, onError = console.error } = {}) {
    this.canvas = canvas ?? document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = .96;
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, .04);
    room.dispose(); pmrem.dispose();
    this.views = new Map(); this.reducedMotion = reducedMotion; this.paused = false; this.speed = 1; this.elapsed = 0;
    this.lastTime = 0; this.disposed = false; this.frames = 0; this.onError = onError;
    this.lost = e => { e.preventDefault(); this.contextLost = true; onError(new Error('Graphics context lost. Recreate the scene to restore rendering.')); };
    this.canvas.addEventListener('webglcontextlost', this.lost);
    this.visible = true;
    this.loop = now => {
      this.frameHandle = 0;
      if (this.disposed || this.contextLost || document.hidden || !this.visible) { this.lastTime = 0; return; }
      const dt = this.lastTime ? Math.min((now - this.lastTime) / 1000, .05) : 0;
      this.lastTime = now;
      try { this.render(this.paused ? 0 : dt * this.speed); } catch (e) { onError(e); this.contextLost = true; }
      const animating = !this.paused && !this.reducedMotion && [...this.views.values()].some(v => v.actor.status === 'processing' || v.actor.age < 4);
      this.canvas.dataset.animating = String(animating);
      if (animating) this.invalidate();
    };
    this.visibility = () => { this.lastTime = 0; this.invalidate(); };
    document.addEventListener('visibilitychange', this.visibility);
    this.invalidate();
  }
  invalidate() {
    if (!this.disposed && !this.frameHandle) this.frameHandle = requestAnimationFrame(this.loop);
  }

  add(domain, element, options = {}) {
    if (this.views.has(domain)) throw new Error(`View already exists: ${domain}`);
    const scene = new THREE.Scene(); scene.environment = this.environment.texture; scene.environmentIntensity = .38;
    const actor = new Mascot(domain, { reducedMotion: this.reducedMotion, ...options }); scene.add(actor.object);
    const camera = new THREE.OrthographicCamera(-2.2, 2.2, 2.1, -2.1, .1, 50);
    camera.position.set(2.9, 2.65, 8.8); camera.lookAt(0, 1.58, 0);
    scene.add(new THREE.HemisphereLight('#fff0d9', '#505b80', .75));
    const key = new THREE.DirectionalLight('#fff0da', 2.3); key.position.set(-3, 6, 5); key.castShadow = false;
    key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = key.shadow.camera.bottom = -3.4;
    key.shadow.camera.right = key.shadow.camera.top = 3.4; key.shadow.camera.far = 16;
    key.shadow.normalBias = .03; key.shadow.bias = -.0002; key.shadow.radius = 3;
    key.target.position.set(0, 1.4, 0); scene.add(key, key.target);
    const rim = new THREE.DirectionalLight('#b2c7ff', 1.6); rim.position.set(3, 4, -3); scene.add(rim);
    const fill = new THREE.DirectionalLight('#ffffff', .4); fill.position.set(1, 1, 5); scene.add(fill);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ color: '#000000', opacity: 0 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = .012; floor.receiveShadow = true; scene.add(floor);
    // Procedural contact shadow supplies soft grounding independently of shadow-map precision.
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const ctx = c.getContext('2d'), gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(0,0,0,.38)'); gradient.addColorStop(.4, 'rgba(0,0,0,.22)'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
    const shadowTexture = new THREE.CanvasTexture(c);
    const contact = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 1.9), new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }));
    contact.rotation.x = -Math.PI / 2; contact.position.y = .018; scene.add(contact);
    const view = { domain, actor, scene, camera, element, shadowTexture, angle: 0 };
    this.views.set(domain, view);
    return actor;
  }
  get(domain) { return this.views.get(domain)?.actor; }
  setAll(status) { this.views.forEach(v => v.actor.setStatus(status)); return this; }
  setReducedMotion(enabled) { this.reducedMotion = !!enabled; this.views.forEach(v => { v.actor.reducedMotion = !!enabled; }); }
  setElasticity(value) { this.views.forEach(v => { v.actor.elasticity = Math.max(0, Math.min(1.5, value)); }); }
  render(dt = 0) {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.round(rect.width), height = Math.round(rect.height);
    if (!width || !height) return;
    if (this.width !== width || this.height !== height) { this.renderer.setSize(width, height, false); this.width = width; this.height = height; }
    this.renderer.setScissorTest(false); this.renderer.setClearColor(0x000000, 0); this.renderer.clear(); this.renderer.setScissorTest(true);
    this.elapsed += dt;
    for (const view of this.views.values()) {
      const bounds = view.element.getBoundingClientRect();
      view.actor.update(dt);
      if (bounds.bottom < rect.top || bounds.top > rect.bottom || bounds.right < rect.left || bounds.left > rect.right || bounds.width < 1 || bounds.height < 1) continue;
      const left = bounds.left - rect.left, bottom = rect.bottom - bounds.bottom;
      const heightUnits = view.domain === 'dependencies' ? 4.12 : 3.94;
      const halfW = heightUnits * bounds.width / bounds.height / 2;
      view.camera.left = -halfW; view.camera.right = halfW; view.camera.top = heightUnits / 2; view.camera.bottom = -heightUnits / 2;
      view.camera.updateProjectionMatrix();
      view.actor.object.rotation.y = view.angle;
      this.renderer.setViewport(left, bottom, bounds.width, bounds.height);
      this.renderer.setScissor(Math.max(0, left), Math.max(0, bottom), Math.min(width, left + bounds.width) - Math.max(0, left), Math.min(height, bottom + bounds.height) - Math.max(0, bottom));
      this.renderer.clearDepth(); this.renderer.render(view.scene, view.camera);
    }
    this.frames++;
    this.canvas.dataset.frames = String(this.frames);
    this.canvas.dataset.statuses = [...this.views.values()].map(v => v.actor.status).join(',');
  }
  inspect() { return { frames: this.frames, contextLost: !!this.contextLost, paused: this.paused, reducedMotion: this.reducedMotion, views: [...this.views.values()].map(v => v.actor.inspect()), render: { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, geometries: this.renderer.info.memory.geometries, textures: this.renderer.info.memory.textures } }; }
  dispose() {
    if (this.disposed) return;
    cancelAnimationFrame(this.frameHandle);
    document.removeEventListener('visibilitychange', this.visibility);
    this.canvas.removeEventListener('webglcontextlost', this.lost);
    for (const v of this.views.values()) { v.actor.dispose(); disposeTree(v.scene); v.shadowTexture.dispose(); }
    this.views.clear(); this.environment.dispose(); this.renderer.dispose(); this.renderer.forceContextLoss(); this.disposed = true;
  }
}
