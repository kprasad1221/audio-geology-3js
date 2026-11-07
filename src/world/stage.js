// ─────────────────────────────────────────────────────────────────────────────
//  The stage every study shares: scene, camera + bookmarks, lights, contact
//  shadow, the survey frame (rulers in real units), and geometry helpers.
//
//  Field ↔ world: u (frequency) runs along +x, v (history, 0 = now) runs from
//  the front edge (+z) to the back (−z), height runs along +y.
//    x = (u − 0.5) · SIZE     z = (0.5 − v) · SIZE     y = h · relief
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { N, SIZE, BOOKMARKS } from '../params.js';

export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Grid in the XZ plane with uv = (u, v). One vertex per field texel when n = N.
export function makeGrid(n) {
  const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, u = i / (n - 1), v = j / (n - 1);
    pos[k * 3] = (u - 0.5) * SIZE; pos[k * 3 + 1] = 0; pos[k * 3 + 2] = (0.5 - v) * SIZE;
    uv[k * 2] = u; uv[k * 2 + 1] = v;
  }
  const idx = [];
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx.push(a, b, c, b, d, c);           // counter-clockwise seen from +y
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * n * 3).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

// Shared GLSL: sample the canonical field at exact texel centres (it is nearest-filtered).
export const FIELD_GLSL = /* glsl */`
  float fieldAt(sampler2D H, vec2 uv) {
    vec2 t = (floor(uv * ${(N - 1).toFixed(1)} + 0.5) + 0.5) / ${N.toFixed(1)};
    return texture2D(H, t).r;
  }
  // Bilinear read of the nearest-filtered field, for points that fall between texels.
  float fieldLinear(sampler2D H, vec2 uv) {
    vec2 p = uv * ${N.toFixed(1)} - 0.5;
    vec2 i = floor(p), f = p - i;
    float a = texture2D(H, (i + vec2(0.5, 0.5)) / ${N.toFixed(1)}).r;
    float b = texture2D(H, (i + vec2(1.5, 0.5)) / ${N.toFixed(1)}).r;
    float c = texture2D(H, (i + vec2(0.5, 1.5)) / ${N.toFixed(1)}).r;
    float d = texture2D(H, (i + vec2(1.5, 1.5)) / ${N.toFixed(1)}).r;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }`;

export function createStage(renderer) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 120);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = !reducedMotion.matches;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 3; controls.maxDistance = 34;

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  // One warm grazing key, one cool restrained fill.
  const key = new THREE.DirectionalLight(0xffe6c8, 2.6);
  const fill = new THREE.HemisphereLight(0xcfe2ea, 0x5d5244, 0.55);
  scene.add(key, key.target, fill);
  const keyDir = new THREE.Vector3();
  const lightState = { azimuth: 215, elevation: 30 };
  function setLight(azDeg, elevDeg = lightState.elevation) {
    lightState.azimuth = azDeg; lightState.elevation = elevDeg;
    const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elevDeg);
    keyDir.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
    key.position.copy(keyDir).multiplyScalar(12);
  }
  setLight(215);

  // Contact shadow: a soft dark rectangle under the specimen (no shadow maps).
  const shadowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(64, 64, 18, 64, 64, 64);
    g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(0.62, 'rgba(0,0,0,0.32)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(SIZE * 1.3, SIZE * 1.3),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, color: 0x3a3020, opacity: 0.35, toneMapped: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.renderOrder = -1;
  scene.add(shadow);

  // ── Camera bookmarks with eased, user-directed moves ─────────────────────
  const tween = { active: false, t: 0, dur: 0.9, from: null, to: null };
  const snap = () => ({ position: camera.position.clone(), target: controls.target.clone(), fov: camera.fov });
  // Bookmarks are authored for a 16:10 viewport; narrower views pull back so the
  // specimen still fits across.
  let active = 'survey';
  const fit = () => Math.pow(Math.max(1, 1.45 / Math.max(camera.aspect, 0.3)), 0.85);
  function goTo(name, instant = false) {
    active = typeof name === 'string' ? name : null;
    const b = typeof name === 'string' ? BOOKMARKS[name] : name;
    const target = new THREE.Vector3(...b.target);
    const position = new THREE.Vector3(...b.position).sub(target).multiplyScalar(typeof name === 'string' ? fit() : 1).add(target);
    const to = { position, target, fov: b.fov ?? camera.fov };
    if (instant || reducedMotion.matches) {
      camera.position.copy(to.position); controls.target.copy(to.target); camera.fov = to.fov;
      camera.updateProjectionMatrix(); controls.update(); tween.active = false; return;
    }
    Object.assign(tween, { active: true, t: 0, from: snap(), to });
  }
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  controls.addEventListener('start', () => { tween.active = false; active = null; });   // the hand always wins
  const refit = () => { if (active) goTo(active, true); };
  function update(dt) {
    if (tween.active) {
      tween.t = Math.min(1, tween.t + dt / tween.dur);
      const e = ease(tween.t);
      camera.position.lerpVectors(tween.from.position, tween.to.position, e);
      controls.target.lerpVectors(tween.from.target, tween.to.target, e);
      camera.fov = THREE.MathUtils.lerp(tween.from.fov, tween.to.fov, e);
      camera.updateProjectionMatrix();
      if (tween.t >= 1) tween.active = false;
    }
    controls.update();
  }
  goTo('survey', true);

  return { scene, camera, controls, key, fill, keyDir, lightState, setLight, shadow, goTo, refit, update };
}

// ── Survey frame: rulers along the frequency (front) and history (left) edges ──
// Tick positions come from the real column ↔ Hz mapping and the real history window.
export function createSurvey(scene) {
  const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false });
  const geo = new THREE.BufferGeometry();
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  scene.add(lines);
  const labels = [];       // { text, world: Vector3, kind }
  const FRONT = SIZE / 2 + 0.45, LEFT = -SIZE / 2 - 0.45, Y = 0.0;

  function build({ hzTicks, secondTicks }) {
    const p = [];
    labels.length = 0;
    // frequency ruler (front)
    p.push(-SIZE / 2, Y, FRONT, SIZE / 2, Y, FRONT);
    for (const t of hzTicks) {
      const x = (t.u - 0.5) * SIZE;
      p.push(x, Y, FRONT, x, Y, FRONT + (t.major ? 0.28 : 0.14));
      if (t.label) labels.push({ text: t.label, world: new THREE.Vector3(x, Y, FRONT + 0.55), kind: 'hz' });
    }
    labels.push({ text: 'frequency →', world: new THREE.Vector3(SIZE * 0.25, Y, FRONT + 1.15), kind: 'axis' });
    // history ruler (left)
    p.push(LEFT, Y, SIZE / 2, LEFT, Y, -SIZE / 2);
    for (const t of secondTicks) {
      const z = (0.5 - t.v) * SIZE;
      p.push(LEFT, Y, z, LEFT - 0.22, Y, z);
      labels.push({ text: t.label, world: new THREE.Vector3(LEFT - 0.55, Y, z), kind: 's' });
    }
    labels.push({ text: 'history', world: new THREE.Vector3(LEFT - 1.25, Y, 0.0), kind: 'axis' });
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    geo.computeBoundingSphere();
  }
  return { lines, labels, build, mat };
}
