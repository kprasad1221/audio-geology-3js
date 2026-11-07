// ─────────────────────────────────────────────────────────────────────────────
//  SEDIMENT — spectral specimen.
//
//  A fixed grid of GPU-displaced points (128 × 128, or 256 × 128 when there is
//  headroom) and up to six thin masked history slices. Points are opaque and
//  depth-tested; their round edge uses alpha-to-coverage (MSAA), not blending,
//  so there is no transparent overdraw from the mass itself.
//
//  Exact mappings
//    position    = jittered grid point at (u, v), height = bilinear H · Relief
//    density     = mix(floor, 1, smoothstep(gap, gap + 0.08, H))  — quiet ground stays
//                  sparse, loud ground fills in: the voids follow the sound
//    dust        = (0.08 + 0.2 · Detail) of points drift ±0.17 units off the surface;
//                  a further 32 % fill the mass below loud ground
//    size        = (1.5 + 1.0 · Detail) px at 12 units, clamped 1.5–4.5 px (+45 % in the register)
//    brightness  = wrapped Lambert from ∇D against the key light × height
//    spectral    = one register only: the Attention range when it is narrowed,
//                  otherwise the dominant register (slow average of the signal row).
//                  Colour = age: amber (now) → cyan → cobalt (older)
//    slices      = profiles of H at fixed ages 0, 0.5, 1, 2, 3, 4 s (real history mapping)
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { P, N, SIZE, SIM_HZ } from '../params.js';
import { FIELD_GLSL } from './stage.js';

const SLICE_SECONDS = [0, 0.5, 1, 2, 3, 4];

function makePoints(nx, ny) {
  const count = nx * ny;
  const uvA = new Float32Array(count * 2), rnd = new Float32Array(count * 3);
  let s = 1234567;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    uvA[k * 2] = (i + rand()) / nx;
    uvA[k * 2 + 1] = (j + rand()) / ny;
    rnd[k * 3] = rand(); rnd[k * 3 + 1] = rand(); rnd[k * 3 + 2] = rand();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute('aUv', new THREE.BufferAttribute(uvA, 2));
  g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 3));
  return g;
}

function makeSlices(cols = 160) {
  const u = [], top = [], idx = [];
  for (let i = 0; i <= cols; i++) { u.push(i / cols, i / cols); top.push(0, 1); }
  for (let i = 0; i < cols; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(u.length * 3), 3));
  g.setAttribute('aU', new THREE.Float32BufferAttribute(u, 1));
  g.setAttribute('aTop', new THREE.Float32BufferAttribute(top, 1));
  g.setIndex(idx);
  g.setAttribute('aV', new THREE.InstancedBufferAttribute(new Float32Array(SLICE_SECONDS.length), 1));
  g.instanceCount = SLICE_SECONDS.length;
  return g;
}

export function createSediment(U, keyDir) {
  const group = new THREE.Group();
  const D = {
    uFloor: { value: 0.16 }, uGap: { value: 0.05 }, uDust: { value: 0.18 },
    uSizePx: { value: 2 }, uPixelRatio: { value: 1 },
    uAccent: { value: new THREE.Vector2(0.3, 0.04) },
    uKeyDir: { value: keyDir },
    uPearl: { value: new THREE.Color('#ece7dc') }, uAmber: { value: new THREE.Color('#f2a24c') },
    uCyan: { value: new THREE.Color('#3fd3e6') }, uCobalt: { value: new THREE.Color('#2f5ee0') },
    uSliceCol: { value: new THREE.Color('#d9d4c8') },
  };
  const uniforms = { ...U, ...D };

  const pointMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      uniform sampler2D uH;
      uniform sampler2D uD;
      uniform float uRelief, uSize, uFloor, uGap, uDust, uSizePx, uPixelRatio;
      uniform vec2 uAccent;
      uniform vec3 uKeyDir;
      attribute vec2 aUv;
      attribute vec3 aRand;
      varying float vBright, vAccent, vAge;
      ${FIELD_GLSL}
      void main() {
        float h = fieldLinear(uH, aUv);
        vec4 d = texture2D(uD, aUv);
        float loud = smoothstep(uGap, uGap + 0.08, h);
        float dens = mix(uFloor, 1.0, loud);
        float keep = step(aRand.y, dens);
        // three kinds of grain: dust (drifts off the surface), fill (inside the mass), surface
        float dust = step(aRand.x, uDust);
        float fill = (1.0 - dust) * step(aRand.x, uDust + 0.32) * loud;
        float y = h * uRelief;
        y += dust * (aRand.z - 0.5) * 0.35;
        y *= mix(1.0, pow(fract(aRand.z * 7.13), 0.45), fill);
        vec3 pos = vec3((aUv.x - 0.5) * uSize, y, (0.5 - aUv.y) * uSize);
        vec3 N = normalize(vec3(-uRelief * d.g / uSize, 1.0, uRelief * d.b / uSize));
        float lit = clamp(dot(N, normalize(uKeyDir)) * 0.7 + 0.3, 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;
        float acc = 1.0 - smoothstep(uAccent.y * 0.55, uAccent.y, abs(aUv.x - uAccent.x));
        acc *= 1.0 - smoothstep(0.0, 0.85, aUv.y);
        acc *= smoothstep(0.01, 0.08, h);
        float size = uSizePx * (0.7 + 0.6 * aRand.z) * (12.0 / max(-mv.z, 0.1));
        size = clamp(size, 1.5, 4.5) * uPixelRatio * (1.0 + 0.45 * acc);
        gl_PointSize = keep > 0.5 ? size : 0.0;
        if (keep < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vBright = (0.5 + 0.5 * lit) * (0.7 + 0.5 * smoothstep(0.0, 0.4, h)) * (dust > 0.5 ? 0.55 : 1.0) * (1.0 - 0.4 * fill);
        vAccent = acc; vAge = aUv.y;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uPearl, uAmber, uCyan, uCobalt;
      varying float vBright, vAccent, vAge;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        float a = 1.0 - smoothstep(0.3, 0.5, r);
        if (a <= 0.01) discard;
        vec3 spec = mix(uAmber, uCyan, smoothstep(0.02, 0.28, vAge));
        spec = mix(spec, uCobalt, smoothstep(0.28, 0.65, vAge));
        vec3 col = mix(uPearl * vBright, spec * (1.1 + 0.9 * vBright), vAccent);
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    alphaToCoverage: true,
  });
  const geos = { '128x128': makePoints(128, 128), '256x128': makePoints(256, 128) };
  const points = new THREE.Points(geos[P.sediment.grid] || geos['128x128'], pointMat);
  points.frustumCulled = false;

  const sliceGeo = makeSlices();
  const sliceMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      uniform sampler2D uH;
      uniform float uRelief, uSize;
      attribute float aU, aTop, aV;
      varying float vTop, vH;
      ${FIELD_GLSL}
      void main() {
        float h = fieldLinear(uH, vec2(aU, aV));
        vec3 pos = vec3((aU - 0.5) * uSize, aTop * h * uRelief, (0.5 - aV) * uSize);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        vTop = aTop; vH = h;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSliceCol;
      varying float vTop, vH;
      void main() {
        float w = fwidth(vTop);
        float edge = 1.0 - smoothstep(0.0, w * 1.6, 1.0 - vTop);
        float mask = smoothstep(0.006, 0.04, vH);
        float a = (edge * 0.7 + 0.05 * vTop) * mask;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uSliceCol, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const slices = new THREE.Mesh(sliceGeo, sliceMat);
  slices.frustumCulled = false; slices.renderOrder = 2;

  group.add(points, slices);

  let visibleSlices = 0;
  return {
    name: 'sediment', group, points,
    radius: () => P.sediment.radius,
    shadow: { y: -0.02, opacity: 0.0 },
    setPixelRatio(pr) { D.uPixelRatio.value = pr; },
    // accent = { center: 0..1, half: 0..1 } in u
    setAccent(center, half) { D.uAccent.value.set(center, half); },
    update() {
      const det = P.detail.sediment, s = P.sediment;
      D.uFloor.value = s.floor; D.uGap.value = s.gap;
      D.uDust.value = 0.08 + 0.2 * det;
      D.uSizePx.value = 1.5 + 1.0 * det;
      const g = geos[s.grid] || geos['128x128'];
      if (points.geometry !== g) points.geometry = g;
      // history slices at real ages
      const arr = sliceGeo.attributes.aV.array;
      visibleSlices = 0;
      for (const sec of SLICE_SECONDS.slice(0, s.slices)) {
        const v = P.flow > 0 ? sec * P.flow * SIM_HZ / N : -1;
        if (v >= 0 && v <= 0.985) arr[visibleSlices++] = Math.max(v, 0.002);
      }
      sliceGeo.attributes.aV.needsUpdate = true;
      sliceGeo.instanceCount = visibleSlices;
    },
    triangles: () => visibleSlices * 160 * 2,
    pointCount: () => points.geometry.attributes.aUv.count,
    mapping: () => {
      const det = P.detail.sediment, s = P.sediment;
      return [
        ['points', `${s.grid.replace('x', ' × ')} jittered grid, bilinear H × Relief`],
        ['density', `mix(${s.floor.toFixed(2)}, 1, smoothstep(${s.gap.toFixed(2)}, ${(s.gap + 0.08).toFixed(2)}, H))`],
        ['grain', `size ${(1.5 + 1.0 * det).toFixed(2)} px, dust ${(0.08 + 0.2 * det).toFixed(2)}, fill 0.32  ← Detail`],
        ['spectral', 'one register: Attention range if narrowed, else the dominant register; colour = age'],
        ['slices', `${visibleSlices} profiles of H at 0, 0.5, 1, 2, 3, 4 s (history window permitting)`],
      ];
    },
  };
}
