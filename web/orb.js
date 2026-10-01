// The orb: a GPU particle sphere with flowing ribbons, drifting dust and bloom.
// It idles on its own, swells with the mic level while Lan talks, and flows
// faster and pulses while the assistant is speaking.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Ashima 3D simplex noise (MIT).
const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const COMMON_UNIFORMS = `
uniform float uTime; uniform float uFlow; uniform float uLevel; uniform float uSpeak;
uniform float uPixelRatio; uniform float uScale;
uniform vec3 uColorA; uniform vec3 uColorB; uniform vec3 uColorC;
`;

const POINT_FRAG = /* glsl */ `
${COMMON_UNIFORMS}
varying float vAlpha; varying vec3 vColor;
void main(){
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a *= a;
  gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
}`;

// Surface shell: fibonacci-distributed points, breathing with noise, bright at the rim.
const SHELL_VERT = /* glsl */ `
${COMMON_UNIFORMS}
${NOISE}
attribute float aSeed;
varying float vAlpha; varying vec3 vColor;
void main(){
  vec3 p = position;
  float n = snoise(p * 1.4 + vec3(0.0, 0.0, uTime * 0.10));
  float n2 = snoise(p * 3.6 + vec3(uTime * 0.35));
  float amp = 0.03 + uLevel * 0.20 + uSpeak * 0.06;
  float r = 1.0 + n * amp + n2 * (0.01 + uLevel * 0.06);
  vec4 mv = modelViewMatrix * vec4(p * r, 1.0);
  vec3 nrm = normalize(normalMatrix * p);
  float rim = 1.0 - abs(nrm.z);
  float back = nrm.z < 0.0 ? 0.55 : 1.0;
  float twinkle = 0.75 + 0.25 * sin(uTime * (1.2 + aSeed * 2.5) + aSeed * 60.0);
  vAlpha = (0.13 + 1.15 * pow(rim, 2.4)) * back * twinkle * (0.55 + 0.45 * fract(aSeed * 13.7));
  vAlpha *= 1.0 + uLevel * 1.2 + uSpeak * 0.5;
  vColor = mix(uColorA, uColorB, smoothstep(-0.3, 0.9, n) * 0.85 + rim * 0.15);
  vColor = mix(vColor, uColorC, smoothstep(0.55, 0.95, n2) * 0.35);
  gl_PointSize = (1.1 + aSeed * 1.5) * uPixelRatio * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

// Ribbons: sheets of particles that hug the sphere, flow around it and curl
// off the surface at their tips, like the bands in orb.jpg.
const RIBBON_VERT = /* glsl */ `
${COMMON_UNIFORMS}
${NOISE}
attribute vec3 aParams;   // u along, v across, ribbon index
attribute float aSeed;
varying float vAlpha; varying vec3 vColor;
mat3 rotY(float a){float c=cos(a),s=sin(a);return mat3(c,0.,-s, 0.,1.,0., s,0.,c);}
mat3 rotX(float a){float c=cos(a),s=sin(a);return mat3(1.,0.,0., 0.,c,s, 0.,-s,c);}
mat3 rotZ(float a){float c=cos(a),s=sin(a);return mat3(c,s,0., -s,c,0., 0.,0.,1.);}
float hash(float n){return fract(sin(n)*43758.5453);}
void main(){
  float u = aParams.x, v = aParams.y, k = aParams.z;
  float h1 = hash(k * 3.1 + 1.0), h2 = hash(k * 7.7 + 2.0), h3 = hash(k * 11.3 + 3.0);
  float arc = 1.6 + h1 * 1.4;
  float dir = h3 > 0.5 ? 1.0 : -1.0;
  float phi = u * arc + uFlow * (0.07 + h2 * 0.06) * dir + h3 * 6.2831;
  float taper = pow(sin(3.14159 * u), 0.7);
  // the band's centre line wanders in latitude; its width breathes along its length
  float centre = sin(u * 3.0 + uFlow * 0.35 + k * 1.7) * (0.30 + 0.15 * h2);
  float width = (0.16 + 0.14 * h1) * (0.75 + 0.25 * sin(u * 5.0 - uFlow * 0.5 + k)) * (1.0 + uSpeak * 0.3 + uLevel * 0.5);
  float theta = centre + v * width * taper;
  vec3 p = vec3(cos(theta) * cos(phi), sin(theta), cos(theta) * sin(phi));
  // fold the sheet off the surface as it flows, and curl the tips outward
  float fold = sin(u * 6.0 - uFlow * 0.8 + k * 2.0);
  float lift = 0.02 + (v * 0.5 + 0.5) * width * 0.9 * max(fold, 0.0)
             + pow(u, 6.0) * (0.30 + 0.25 * h2) * (0.6 + 0.4 * v);
  float n = snoise(p * 2.5 + vec3(uTime * 0.18));
  lift += n * (0.015 + uLevel * 0.10);
  p *= 1.0 + lift;
  p = rotZ(h1 * 2.0 - 1.0) * rotX(h2 * 2.4 - 1.2) * rotY(h3 * 6.28) * p;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float edge = pow(abs(v), 4.0);
  float shimmer = 0.6 + 0.4 * sin(u * 40.0 - uFlow * 3.0 + v * 6.0);
  float pulse = 1.0 + uSpeak * 0.7 * (0.5 + 0.5 * sin(uTime * 6.0 - u * 12.0));
  vAlpha = 0.5 * taper * (0.22 + 0.8 * edge) * shimmer * (0.5 + 0.5 * aSeed) * pulse * (1.0 + uLevel);
  vColor = mix(uColorB, uColorC, clamp(edge * 0.8 + 0.5 * max(fold, 0.0) * (v * 0.5 + 0.5), 0.0, 1.0));
  gl_PointSize = (1.0 + aSeed * 1.4) * uPixelRatio * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

// Dust: particles drifting outward from the surface and fading.
const DUST_VERT = /* glsl */ `
${COMMON_UNIFORMS}
attribute float aSeed;
varying float vAlpha; varying vec3 vColor;
void main(){
  vec3 dir = normalize(position);
  float life = fract(aSeed * 7.0 + uTime * (0.012 + aSeed * 0.02) * (1.0 + uSpeak * 2.0 + uLevel * 3.0));
  float rad = 1.04 + life * (0.55 + aSeed * 0.6);
  float a = uTime * 0.04 * (aSeed - 0.5);
  float c = cos(a), s = sin(a);
  dir = vec3(c * dir.x - s * dir.z, dir.y, s * dir.x + c * dir.z);
  vec4 mv = modelViewMatrix * vec4(dir * rad, 1.0);
  vAlpha = pow(1.0 - life, 2.0) * smoothstep(0.0, 0.08, life) * (0.35 + 0.65 * aSeed);
  vColor = mix(uColorB, uColorA, aSeed);
  gl_PointSize = (1.2 + aSeed * 2.0) * uPixelRatio * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

function fibonacciSphere(count) {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = g * i + (Math.random() - 0.5) * 0.4;
    pos.set([Math.cos(t) * r, y, Math.sin(t) * r], i * 3);
    seed[i] = Math.random();
  }
  return { pos, seed };
}

export class Orb {
  constructor(canvas, anchor) {
    this.canvas = canvas;
    this.anchor = anchor;
    this.level = 0; this.levelTarget = 0;
    this.speak = 0; this.speaking = false; this.kick = 0;
    this.flow = 0; this.time = 0;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    this.camera.position.set(0, 0, 9);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.uniforms = {
      uTime: { value: 0 }, uFlow: { value: 0 }, uLevel: { value: 0 }, uSpeak: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() }, uScale: { value: 30 },
      uColorA: { value: new THREE.Color() }, uColorB: { value: new THREE.Color() }, uColorC: { value: new THREE.Color() },
    };
    const mat = (vertexShader) => new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader, fragmentShader: POINT_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });

    // shell
    const shell = fibonacciSphere(22000);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(shell.pos, 3));
    sg.setAttribute('aSeed', new THREE.BufferAttribute(shell.seed, 1));
    this.group.add(new THREE.Points(sg, mat(SHELL_VERT)));

    // ribbons
    const RIBBONS = 4, ALONG = 420, ACROSS = 22;
    const n = RIBBONS * ALONG * ACROSS;
    const params = new Float32Array(n * 3), rseed = new Float32Array(n), rpos = new Float32Array(n * 3);
    let i = 0;
    for (let k = 0; k < RIBBONS; k++) for (let a = 0; a < ALONG; a++) for (let b = 0; b < ACROSS; b++, i++) {
      params.set([(a + Math.random()) / ALONG, (b / (ACROSS - 1)) * 2 - 1 + (Math.random() - 0.5) * 0.08, k], i * 3);
      rseed[i] = Math.random();
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rpos, 3));
    rg.setAttribute('aParams', new THREE.BufferAttribute(params, 3));
    rg.setAttribute('aSeed', new THREE.BufferAttribute(rseed, 1));
    const ribbons = new THREE.Points(rg, mat(RIBBON_VERT));
    ribbons.frustumCulled = false;
    this.group.add(ribbons);

    // dust
    const dust = fibonacciSphere(1800);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(dust.pos, 3));
    dg.setAttribute('aSeed', new THREE.BufferAttribute(dust.seed, 1));
    const dustPts = new THREE.Points(dg, mat(DUST_VERT));
    dustPts.frustumCulled = false;
    this.group.add(dustPts);

    // soft inner haze + halo behind the particles
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const grd = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    grd.addColorStop(0, 'rgba(255,255,255,0.20)');
    grd.addColorStop(0.55, 'rgba(255,255,255,0.28)');
    grd.addColorStop(0.68, 'rgba(255,255,255,0.10)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, 256, 256);
    this.haze = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.35,
    }));
    this.haze.scale.setScalar(3.0);
    this.scene.add(this.haze);

    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.95, 0.6, 0.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.clock = new THREE.Clock();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('scroll', () => this.place(), { passive: true });
    new ResizeObserver(() => this.resize()).observe(anchor);
    this.resize();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  setTheme({ bg, a, b, c }) {
    this.scene.background = new THREE.Color(bg);
    this.uniforms.uColorA.value.set(a);
    this.uniforms.uColorB.value.set(b);
    this.uniforms.uColorC.value.set(c);
    this.haze.material.color.set(a);
  }

  setLevel(x) { this.levelTarget = Math.min(1, Math.max(0, x)); }
  setSpeaking(on) { this.speaking = on; }
  pulse() { this.kick = 1; }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    // point sizes are authored for a 900px-tall window
    this.uniforms.uScale.value = (h / 900) * this.camera.position.z;
    this.place();
  }

  place() {
    const w = window.innerWidth, h = window.innerHeight;
    // map the anchor's box into world space at z = 0
    const r = this.anchor.getBoundingClientRect();
    const worldH = 2 * this.camera.position.z * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const px = worldH / h;
    const cx = (r.left + r.width / 2 - w / 2) * px;
    const cy = -(r.top + r.height / 2 - h / 2) * px;
    const radius = (Math.min(r.width, r.height) / 2) * px * 0.78;
    this.base = { x: cx, y: cy, s: radius };
    this.group.position.set(cx, cy, 0);
    this.haze.position.set(cx, cy, -0.5);
  }

  loop() {
    requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.time += dt;
    this.level += (this.levelTarget - this.level) * Math.min(1, dt * (this.levelTarget > this.level ? 18 : 5));
    const speakTarget = this.speaking ? 0.65 + 0.35 * Math.sin(this.time * 7.5) * Math.sin(this.time * 2.3) : 0;
    this.speak += (speakTarget + this.kick * 0.5 - this.speak) * Math.min(1, dt * 6);
    this.kick *= Math.pow(0.02, dt);
    this.flow += dt * (1 + this.speak * 2.2 + this.level * 2.5);

    const u = this.uniforms;
    u.uTime.value = this.time; u.uFlow.value = this.flow;
    u.uLevel.value = this.level; u.uSpeak.value = this.speak;

    const breathe = 1 + Math.sin(this.time * 0.8) * 0.008 + this.level * 0.07 + this.speak * 0.025;
    this.group.scale.setScalar(this.base.s * breathe);
    this.group.rotation.y += dt * (0.05 + this.speak * 0.12);
    this.group.rotation.x = 0.25 + Math.sin(this.time * 0.13) * 0.08;
    this.haze.scale.setScalar(this.base.s * 3.0 * breathe);
    this.haze.material.opacity = 0.16 + this.level * 0.2 + this.speak * 0.08;
    this.bloom.strength = 0.95 + this.level * 0.45 + this.speak * 0.2;
    this.composer.render();
  }
}
