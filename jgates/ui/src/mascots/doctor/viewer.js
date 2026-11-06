import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DoctorMascot, DOCTOR_STATES } from './doctor.js';
import { clamp } from './motion.js';

/** One actor and one WebGL context, shared by the hero and the true-size preview. */
export class DoctorViewer {
  constructor({ canvas, viewports, state = 'checking', reducedMotion = false, onError = console.error } = {}) {
    this.canvas = canvas; this.viewports = viewports; this.onError = onError;
    this.actor = new DoctorMascot({ state, reducedMotion });
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true, powerPreference:'low-power' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1,1.7));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = .96;
    this.renderer.autoClear = false;
    this.scene = new THREE.Scene(); this.scene.add(this.actor.object);
    const pmrem = new THREE.PMREMGenerator(this.renderer), room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room,.04); room.dispose(); pmrem.dispose();
    this.scene.environment = this.environment.texture; this.scene.environmentIntensity = .38;
    this.scene.add(new THREE.HemisphereLight('#fff0d9','#505b80',.75));
    const key = new THREE.DirectionalLight('#fff0da',2.3); key.position.set(-3,6,5); this.scene.add(key);
    const rim = new THREE.DirectionalLight('#b2c7ff',1.6); rim.position.set(3,4,-3); this.scene.add(rim);
    const fill = new THREE.DirectionalLight('#ffffff',.4); fill.position.set(1,1,5); this.scene.add(fill);
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const ctx = c.getContext('2d'), g = ctx.createRadialGradient(64,64,0,64,64,64);
    g.addColorStop(0,'rgba(0,0,0,.32)'); g.addColorStop(.4,'rgba(0,0,0,.18)'); g.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0,0,128,128);
    this.shadowTexture = new THREE.CanvasTexture(c);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.4,2.0),new THREE.MeshBasicMaterial({map:this.shadowTexture,transparent:true,depthWrite:false}));
    this.shadow.rotation.x=-Math.PI/2; this.shadow.position.set(.1,.012,.08); this.scene.add(this.shadow);
    this.camera = new THREE.OrthographicCamera(-2.5,2.5,2.1,-2.1,.1,50);
    this.camera.position.set(2.7,2.6,9.5); this.camera.lookAt(.20,1.68,0);
    this.angle=0; this.zoom=1; this.speed=1; this.paused=false; this.disposed=false; this.frames=0; this.lastTime=0;
    this.invalidate = () => { if (!this.frameHandle && !this.disposed && !document.hidden) this.frameHandle=requestAnimationFrame(this.frame); };
    this.frame = now => {
      this.frameHandle=0; if (this.disposed || this.contextLost) return;
      const dt = this.lastTime ? Math.min((now-this.lastTime)/1000,.05) : 0; this.lastTime=now;
      try { this.render(this.paused ? 0 : dt*this.speed); } catch(e) { this.contextLost=true; this.onError(e); return; }
      if (!this.paused && !this.actor.reducedMotion) this.invalidate();
    };
    this.onState = () => { if (this.paused || this.actor.reducedMotion) this.actor.snapNext=true; this.invalidate(); };
    this.actor.addEventListener('statechange',this.onState);
    this.resizeObserver=new ResizeObserver(this.invalidate);
    this.resizeObserver.observe(canvas); viewports.forEach(el=>this.resizeObserver.observe(el));
    this.onVisibility = () => { this.lastTime=0; this.invalidate(); };
    this.onScroll = () => this.invalidate();
    document.addEventListener('visibilitychange',this.onVisibility);
    window.addEventListener('scroll',this.onScroll,{passive:true});
    this.lost=e=>{e.preventDefault();this.contextLost=true;this.onError(new Error('The graphics context was lost. Reload to restore the preview.'));};
    canvas.addEventListener('webglcontextlost',this.lost);
    this.invalidate();
  }
  setPaused(value) { this.paused=!!value; this.lastTime=0; this.invalidate(); }
  setReducedMotion(value) { this.actor.setReducedMotion(value);this.lastTime=0;this.invalidate(); }
  render(dt=0) {
    const rect=this.canvas.getBoundingClientRect(),width=Math.round(rect.width),height=Math.round(rect.height);
    if (!width || !height) return;
    if (width!==this.width || height!==this.height) {this.renderer.setSize(width,height,false);this.width=width;this.height=height;}
    this.actor.update(dt);this.actor.object.rotation.y=this.angle;
    this.renderer.setScissorTest(false);this.renderer.setClearColor(0,0);this.renderer.clear();this.renderer.setScissorTest(true);
    for (let i=0;i<this.viewports.length;i++) {
      const b=this.viewports[i].getBoundingClientRect();
      const left=b.left-rect.left,bottom=rect.bottom-b.bottom;
      const x=Math.max(0,left),y=Math.max(0,bottom),w=Math.min(width,left+b.width)-x,h=Math.min(height,bottom+b.height)-y;
      if (w<=0 || h<=0 || b.width<1 || b.height<1) continue;
      const units=Math.max(4.15,4.30*b.height/b.width)/(i===0 ? this.zoom:1),halfW=units*b.width/b.height/2;
      this.camera.left=-halfW;this.camera.right=halfW;this.camera.top=units/2;this.camera.bottom=-units/2;this.camera.updateProjectionMatrix();
      this.renderer.setViewport(left,bottom,b.width,b.height);this.renderer.setScissor(x,y,w,h);this.renderer.clearDepth();
      this.renderer.render(this.scene,this.camera);
    }
    this.frames++;
  }
  inspect() {return {...this.actor.inspect(),frames:this.frames,paused:this.paused,contextLost:!!this.contextLost,render:{calls:this.renderer.info.render.calls,triangles:this.renderer.info.render.triangles,geometries:this.renderer.info.memory.geometries,textures:this.renderer.info.memory.textures}};}
  dispose() {
    if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.frameHandle);this.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange',this.onVisibility);window.removeEventListener('scroll',this.onScroll);
    this.canvas.removeEventListener('webglcontextlost',this.lost);this.actor.removeEventListener('statechange',this.onState);
    this.actor.dispose();this.shadow.geometry.dispose();this.shadow.material.dispose();this.shadowTexture.dispose();this.environment.dispose();this.renderer.dispose();this.renderer.forceContextLoss();
  }
}

/** Mount into the reserved UI slot. Only data-state drives the actor; no checks or installs run here. */
export function mountDoctor(element, { reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches, onError, ...options } = {}) {
  if (!(element instanceof HTMLElement)) throw new TypeError('A Doctor host element is required');
  const initial=element.getAttribute('data-state')||'checking';
  if (!Object.hasOwn(DOCTOR_STATES,initial)) throw new TypeError(`Unknown Doctor state: ${initial}`);
  const previousPosition=element.style.position;
  if(getComputedStyle(element).position==='static')element.style.position='relative';
  const canvas=document.createElement('canvas');canvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none';canvas.setAttribute('aria-hidden','true');
  element.appendChild(canvas);
  let viewer;
  try {viewer=new DoctorViewer({...options,canvas,viewports:[element],state:initial,reducedMotion,onError});}
  catch(e){canvas.remove();element.style.position=previousPosition;throw e;}
  const onChange=()=>{const state=element.getAttribute('data-state');if(Object.hasOwn(DOCTOR_STATES,state))viewer.actor.setState(state);};
  const observer=new MutationObserver(onChange);observer.observe(element,{attributes:true,attributeFilter:['data-state']});
  return { actor:viewer.actor,viewer,setState(state){viewer.actor.setState(state);element.setAttribute('data-state',state);},
    dispose(){observer.disconnect();viewer.dispose();canvas.remove();element.style.position=previousPosition;} };
}
