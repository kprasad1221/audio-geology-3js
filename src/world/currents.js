// ─────────────────────────────────────────────────────────────────────────────
//  CURRENTS — cobalt observatory.
//
//  A reduced-density supporting surface (128 × 128) plus up to 4,096 instanced
//  ribbons. Each ribbon starts at a fixed anchor and follows an artistic
//  slope-following direction field derived from D. This is not a fluid solver:
//  the path is integrated fresh every frame from the current field, on the GPU.
//
//  Exact mappings
//    direction   = normalize(mix(−∇D, ⊥∇D, flowMix) · smoothstep(0, 0.1, |∇D|) + bias · +v)
//                  (+v is "older": the direction the field itself translates)
//    path        = RK2 midpoint, `segments` steps of length/segments in uv
//    visible     = smoothstep(0.003, 0.05, D.smooth): ribbons thin out and collapse in silent ground
//    count       = 1024 · 4^Detail · density  (Detail 0.5 → 2,048)
//    width       = 0.05 · (1.35 − 0.7 · Detail) · width, never below 1 px on screen
//    colour      = cobalt by height, silver Kajiya–Kay highlight along the ribbon,
//                  brighter tips, copper only where the newest rows are loud
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import CustomShaderMaterial from 'three-custom-shader-material/vanilla';
import { P, SIZE, CURRENTS_TREATMENTS } from '../params.js';
import { makeGrid } from './stage.js';
import { VOICES_GLSL } from './voices.js';

const MAX_RIBBONS = 4096;
const SEG_MAX = 8;
const SUPPORT_N = 128;

function makeRibbons() {
  // One ribbon: SEG_MAX segments → SEG_MAX + 1 cross-sections × 2 vertices.
  const s = [], side = [], idx = [];
  for (let k = 0; k <= SEG_MAX; k++) { s.push(k / SEG_MAX, k / SEG_MAX); side.push(-1, 1); }
  for (let k = 0; k < SEG_MAX; k++) { const a = k * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((SEG_MAX + 1) * 2 * 3), 3));
  g.setAttribute('aS', new THREE.Float32BufferAttribute(s, 1));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setIndex(idx);
  // Anchors: the R2 low-discrepancy sequence, so any prefix of the list is evenly
  // spread. Lowering the count thins the ribbons everywhere instead of cropping a region.
  const anchor = new Float32Array(MAX_RIBBONS * 2), seed = new Float32Array(MAX_RIBBONS);
  const g2 = 1.32471795724474602596, a1 = 1 / g2, a2 = 1 / (g2 * g2);
  for (let i = 0; i < MAX_RIBBONS; i++) {
    anchor[i * 2] = 0.02 + 0.96 * ((0.5 + a1 * (i + 1)) % 1);
    anchor[i * 2 + 1] = 0.01 + 0.97 * ((0.5 + a2 * (i + 1)) % 1);
    seed[i] = ((i * 0.618033988749) % 1);
  }
  g.setAttribute('aAnchor', new THREE.InstancedBufferAttribute(anchor, 2));
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
  g.instanceCount = 2048;
  return g;
}

export function createCurrents(U, keyDir) {
  const group = new THREE.Group();
  const C = {
    uFlowMix: { value: 1 }, uBias: { value: 0.22 }, uLen: { value: 0.1 }, uSegs: { value: 8 },
    uWidth: { value: 0.035 }, uMinPx: { value: 1.0 }, uViewport: { value: new THREE.Vector2(1, 1) },
    uKeyDir: { value: keyDir }, uLift: { value: 0.035 },
    uDeep: { value: new THREE.Color('#0b2a6e') }, uCobalt: { value: new THREE.Color('#2f6be0') },
    uSilver: { value: new THREE.Color('#cfe6fb') }, uCopper: { value: new THREE.Color('#e0a467') },
    uNavy: { value: new THREE.Color('#06121c') },
  };
  const uniforms = { ...U, ...C };

  // ── Supporting surface ───────────────────────────────────────────────────
  const supportMat = new CustomShaderMaterial({
    baseMaterial: THREE.MeshStandardMaterial,
    uniforms,
    vertexShader: /* glsl */`
      uniform sampler2D uD;
      uniform float uRelief, uSize;
      varying float vH;
      ${VOICES_GLSL}
      void main() {
        vec4 d = texture2D(uD, uv);
        vec3 m = voiceMotion(uv, voiceHN(d.r), uv.y, 0, 6) * mix(0.35, 1.0, smoothstep(0.0, 0.08, d.r));
        csm_Position = position + vec3(0.0, (d.r + m.x) * uRelief, 0.0);
        csm_Normal = normalize(vec3(-uRelief * (d.g + m.y) / uSize, 1.0, uRelief * (d.b + m.z) / uSize));
        vH = d.r;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uNavy, uDeep;
      varying float vH;
      void main() {
        float low = 1.0 - smoothstep(0.004, 0.08, vH);
        csm_DiffuseColor = vec4(mix(uNavy * 2.2, uNavy, low), 1.0);
        csm_Emissive = uDeep * low * 0.1;              // a faint cobalt glow in the channels
        csm_Roughness = 0.6; csm_Metalness = 0.1;
      }`,
    roughness: 0.6, metalness: 0.2,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  const support = new THREE.Mesh(makeGrid(SUPPORT_N), supportMat);
  support.frustumCulled = false;

  // ── Ribbons ──────────────────────────────────────────────────────────────
  const ribbonMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      uniform sampler2D uD;
      uniform float uRelief, uSize, uFlowMix, uBias, uLen, uSegs, uWidth, uMinPx, uLift;
      uniform vec2 uViewport;
      attribute float aS, aSide, aSeed;
      attribute vec2 aAnchor;
      varying vec3 vT, vN, vW, vVoiceCol;
      varying float vS, vE, vAge, vHt, vSide, vVoice, vFlash;
      ${VOICES_GLSL}

      vec2 flowDir(vec2 p) {
        vec2 g = texture2D(uD, p).gb;
        float m = length(g);
        vec2 dir = mix(-g, vec2(-g.y, g.x), uFlowMix) / max(m, 1e-4);
        dir *= smoothstep(0.0, 0.1, m);           // trust the slope only where there is one
        dir += vec2(0.0, uBias);                  // documented bias toward older history
        return dir / max(length(dir), 1e-4);
      }
      vec3 toWorld(vec2 p, float h) { return vec3((p.x - 0.5) * uSize, h * uRelief, (0.5 - p.y) * uSize); }

      void main() {
        float segs = uSegs;
        float k = min(floor(aS * ${SEG_MAX.toFixed(1)} + 0.5), segs);   // cross-section index, clamped
        float hstep = uLen / segs;
        // Centre the filament on its anchor: start half a length upstream.
        vec2 p = aAnchor - flowDir(aAnchor) * uLen * 0.5;
        for (int i = 0; i < ${SEG_MAX}; i++) {
          if (float(i) >= k) break;
          vec2 d1 = flowDir(p);
          vec2 d2 = flowDir(p + d1 * hstep * 0.5);
          p += d2 * hstep;
        }
        p = clamp(p, vec2(0.0), vec2(1.0));
        vec4 d = texture2D(uD, p);
        vec2 dir = flowDir(p);
        // ride the same voice motion as the supporting surface
        vec3 m = voiceMotion(p, voiceHN(d.r), p.y, 0, 6) * mix(0.35, 1.0, smoothstep(0.0, 0.08, d.r));
        vec3 N = normalize(vec3(-uRelief * (d.g + m.y) / uSize, 1.0, uRelief * (d.b + m.z) / uSize));
        vec3 T = normalize(vec3(dir.x * uSize, uRelief * dot(d.gb, dir), -dir.y * uSize));
        vec3 B = normalize(cross(T, N));
        float e = smoothstep(0.003, 0.05, d.r);                       // energy
        float s = k / segs;
        float taper = pow(sin(3.14159 * clamp(s, 0.02, 0.98)), 0.6);
        // this ribbon's voice is fixed by its anchor; its record is read along its length
        int vk = voiceIndex(aAnchor.x, voiceHN(texture2D(uD, aAnchor).r), aSeed);
        vec2 lo = voiceAt(vk, p.y);
        vVoiceCol = uBandCol[vk]; vVoice = lo.x * uVoiceColor; vFlash = lo.y * uVoiceColor;
        float halfW = uWidth * e * taper * (0.75 + 0.5 * aSeed) * (1.0 + 0.35 * vFlash);
        vec3 c = toWorld(p, d.r + m.x) + N * uLift;
        vec3 w = c + B * aSide * halfW;
        // Keep a minimum on-screen width so thin ribbons never shimmer.
        vec4 cc = projectionMatrix * modelViewMatrix * vec4(c, 1.0);
        vec4 wc = projectionMatrix * modelViewMatrix * vec4(w, 1.0);
        vec2 px = (wc.xy / wc.w - cc.xy / cc.w) * 0.5 * uViewport;
        float pw = length(px);
        if (e > 0.02 && pw < uMinPx) wc = cc + (wc - cc) * (uMinPx / max(pw, 1e-3));
        if (e <= 0.02) wc = cc;                                       // collapse in quiet ground
        gl_Position = wc;
        vT = T; vN = N; vW = w; vS = s; vE = e; vAge = p.y; vHt = d.r; vSide = aSide;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uKeyDir, uDeep, uCobalt, uSilver, uCopper;
      varying vec3 vT, vN, vW, vVoiceCol;
      varying float vS, vE, vAge, vHt, vSide, vVoice, vFlash;
      void main() {
        vec3 T = normalize(vT), N = normalize(vN);
        vec3 V = normalize(cameraPosition - vW);
        vec3 L = normalize(uKeyDir);
        float tl = dot(T, L), th = dot(T, normalize(L + V));
        float kkDiff = sqrt(max(0.0, 1.0 - tl * tl));                // Kajiya–Kay
        float kkSpec = pow(sqrt(max(0.0, 1.0 - th * th)), 48.0);
        float facing = clamp(dot(N, L) * 0.6 + 0.4, 0.0, 1.0);
        float prof = sqrt(max(0.0, 1.0 - vSide * vSide * 0.85));      // a soft cylindrical profile
        vec3 base = mix(uDeep, uCobalt, smoothstep(0.01, 0.4, vHt));
        vec3 col = base * (0.35 + 0.85 * kkDiff * facing) * prof;
        col += uSilver * kkSpec * facing * (0.3 + 0.5 * smoothstep(0.6, 1.0, vS)) * prof * smoothstep(0.02, 0.25, vHt);
        float fresh = (1.0 - smoothstep(0.0, 0.12, vAge)) * smoothstep(0.15, 0.5, vHt);
        col = mix(col, uCopper * (0.5 + kkSpec), fresh * 0.75);
        // voices: the ribbon takes its voice's colour while that voice sounds, flashes on onsets
        vec3 vc = vVoiceCol * (0.3 + 0.9 * kkDiff * facing) * prof + uSilver * kkSpec * 0.35 * prof;
        col = mix(col, vc, clamp(vVoice, 0.0, 1.0) * 0.85);
        col += vVoiceCol * vFlash * 0.55 * prof;
        gl_FragColor = vec4(col * (0.35 + 0.65 * vE), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const ribbonGeo = makeRibbons();
  const ribbons = new THREE.Mesh(ribbonGeo, ribbonMat);
  ribbons.frustumCulled = false;

  group.add(support, ribbons);

  let count = 2048;
  return {
    name: 'currents', group,
    radius: () => P.currents.radius,
    shadow: { y: -0.02, opacity: 0.0 },
    setViewport(w, h, pr = 1) { C.uViewport.value.set(w, h); C.uMinPx.value = Math.max(1, 0.9 * pr); },
    update() {
      const det = P.detail.currents, c = P.currents, t = CURRENTS_TREATMENTS[c.treatment] || CURRENTS_TREATMENTS.orderly;
      C.uFlowMix.value = c.flowMix; C.uBias.value = c.bias; C.uLen.value = c.length;
      C.uSegs.value = Math.max(2, Math.min(SEG_MAX, Math.round(c.segments)));
      count = Math.min(MAX_RIBBONS, Math.round(1024 * Math.pow(4, det) * t.density));
      ribbonGeo.instanceCount = count;
      C.uWidth.value = 0.05 * (1.35 - 0.7 * det) * t.width;
    },
    // Apply a named treatment's parameters (Inspect, authored states).
    applyTreatment(name) {
      const t = CURRENTS_TREATMENTS[name]; if (!t) return;
      Object.assign(P.currents, { treatment: name, radius: t.radius, flowMix: t.flowMix, bias: t.bias, length: t.length, segments: t.segments });
    },
    triangles: () => 2 * (SUPPORT_N - 1) ** 2 + count * SEG_MAX * 2,
    mapping: () => {
      const det = P.detail.currents, c = P.currents;
      return [
        ['direction', `mix(−∇D, ⊥∇D, ${c.flowMix.toFixed(2)}) + bias ${c.bias.toFixed(2)} toward older rows`],
        ['field radius', `D sampled at ${c.radius} texels`],
        ['path', `${C.uSegs.value} RK2 steps, length ${c.length.toFixed(3)} uv`],
        ['count', `${count} ribbons  ← Detail ${det.toFixed(2)}`],
        ['width', `${C.uWidth.value.toFixed(3)} units, ≥ 1 px on screen  ← Detail`],
        ['colour', 'cobalt by height · silver highlight along the ribbon · copper = loud newest rows'],
        ['voices', `${P.voices.layout.currents} · each ribbon belongs to one voice (by ${P.voices.layout.currents === 'woven' ? 'its index' : P.voices.layout.currents === 'register' ? 'its anchor\'s frequency' : 'its anchor\'s height'}); colour = that voice's record along the ribbon; onsets widen (+35 %) and flash`],
      ];
    },
  };
}
