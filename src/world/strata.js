// ─────────────────────────────────────────────────────────────────────────────
//  STRATA — mineral daylight.
//
//  One 256 × 256 surface displaced by the field, a perimeter skirt that cuts the
//  specimen out of the ground, and a contour material.
//
//  Exact mappings
//    height      = mix(H, D.smooth, broad) · Relief        (broad: Inspect, default 0.35)
//    normal      = mix(∇D, ∇H, fine)                      (fine = 0.25 + 0.75 · Detail)
//    bands       = height-in-field-units · bandCount       (12–36, default 24)
//    contours    = AA line at every band (fixed to the field)
//    laminations = one line per 0.25 s of deposit, ×4 finer; they travel with the
//                  rows, so they show time the way real strata do
//                  (contrast = 0.2 + 0.8 · Detail, fine lines = Detail)
//    colour      = chalk; pale sea-green in absolute lows, deeper in hollows
//                  (curvature > 0); iron-ochre on crests (curvature < 0) and steep faces
//    cut faces   = the same band coordinate continued down the skirt, so every
//                  contour line on the surface meets its stratum on the cut edge
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import CustomShaderMaterial from 'three-custom-shader-material/vanilla';
import { N, SIZE, P } from '../params.js';
import { makeGrid, FIELD_GLSL } from './stage.js';

const BASE = 0.55;   // thickness of the specimen below height 0, scene units

const COMMON_FRAG = /* glsl */`
  uniform vec3 uChalk, uSand, uSea, uSeaDeep, uOchre, uInk;
  uniform float uBands, uBandContrast, uFineLines;
  float hash1(float n) { return fract(sin(n * 91.345 + 3.1) * 47453.5453); }
  vec3 layerColor(float idx) {
    float r = hash1(idx);
    vec3 c = uChalk;
    c = mix(c, uSand,  step(0.46, r) * (1.0 - step(0.68, r)));
    c = mix(c, uSea,   step(0.68, r) * (1.0 - step(0.86, r)));
    c = mix(c, uOchre, step(0.86, r));
    return c;
  }
  // Anti-aliased line at every integer of x, about widthPx wide; fades out
  // before the lines get denser than ~3 px apart so they never crawl.
  float lineAA(float x, float widthPx) {
    float w = fwidth(x);
    float d = abs(fract(x - 0.5) - 0.5) / max(w, 1e-5);
    return (1.0 - smoothstep(widthPx * 0.5, widthPx * 0.5 + 1.0, d)) * (1.0 - smoothstep(0.16, 0.36, w));
  }`;

function makeSkirt(n = N) {
  const edges = [
    { a: [0, 0], b: [1, 0], nrm: [0, 0, 1] },    // front: v = 0, the newest signal row
    { a: [1, 0], b: [1, 1], nrm: [1, 0, 0] },    // right: highest frequency
    { a: [1, 1], b: [0, 1], nrm: [0, 0, -1] },   // back: oldest history
    { a: [0, 1], b: [0, 0], nrm: [-1, 0, 0] },   // left: lowest frequency
  ];
  const pos = [], nrm = [], edge = [], top = [], perim = [], idx = [];
  edges.forEach((e, ei) => {
    const base = pos.length / 3;
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1);
      const u = e.a[0] + (e.b[0] - e.a[0]) * t, v = e.a[1] + (e.b[1] - e.a[1]) * t;
      const x = (u - 0.5) * SIZE, z = (0.5 - v) * SIZE;
      for (const isTop of [1, 0]) {
        pos.push(x, 0, z); nrm.push(...e.nrm); edge.push(u, v); top.push(isTop); perim.push((ei + t) * SIZE);
      }
    }
    for (let k = 0; k < n - 1; k++) {
      const t0 = base + k * 2, b0 = t0 + 1, t1 = t0 + 2, b1 = t0 + 3;
      idx.push(t0, b0, t1, t1, b0, b1);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 2));
  g.setAttribute('aTop', new THREE.Float32BufferAttribute(top, 1));
  g.setAttribute('aPerim', new THREE.Float32BufferAttribute(perim, 1));
  g.setIndex(idx);
  return g;
}

export function createStrata(U) {
  const group = new THREE.Group();
  const S = {
    uBroad: { value: P.strata.broad }, uFine: { value: 0.6 },
    uBands: { value: P.strata.bands }, uBandContrast: { value: 0.6 }, uFineLines: { value: 0.5 },
    uBase: { value: BASE }, uSimSteps: U.uSimSteps, uFlow: U.uFlow,
    uChalk: { value: new THREE.Color('#e6e8dc') }, uSand: { value: new THREE.Color('#d9cfb6') },
    uSea: { value: new THREE.Color('#7eaaa0') }, uSeaDeep: { value: new THREE.Color('#4f7f7a') },
    uOchre: { value: new THREE.Color('#a9622f') }, uInk: { value: new THREE.Color('#1f3537') },
  };
  const uniforms = { ...U, ...S };

  // ── Surface ──────────────────────────────────────────────────────────────
  const surfaceMat = new CustomShaderMaterial({
    baseMaterial: THREE.MeshStandardMaterial,
    uniforms,
    vertexShader: /* glsl */`
      uniform sampler2D uH;
      uniform sampler2D uD;
      uniform vec2 uTexel;
      uniform float uRelief, uSize, uBroad, uFine;
      varying float vH, vCurv, vSlope, vAge;
      ${FIELD_GLSL}
      void main() {
        float hf = fieldAt(uH, uv);
        vec4 d = texture2D(uD, uv);
        float h = mix(hf, d.r, uBroad);
        float hl = fieldAt(uH, uv - vec2(uTexel.x, 0.0)), hr = fieldAt(uH, uv + vec2(uTexel.x, 0.0));
        float hd = fieldAt(uH, uv - vec2(0.0, uTexel.y)), hu = fieldAt(uH, uv + vec2(0.0, uTexel.y));
        vec2 gFine = vec2(hr - hl, hu - hd) / (2.0 * uTexel);
        vec2 g = mix(d.gb, gFine, uFine);
        csm_Position = position + vec3(0.0, h * uRelief, 0.0);
        csm_Normal = normalize(vec3(-uRelief * g.x / uSize, 1.0, uRelief * g.y / uSize));
        vH = h; vCurv = d.a; vSlope = uRelief * length(d.gb) / uSize; vAge = uv.y;
      }`,
    fragmentShader: /* glsl */`
      uniform float uSimSteps, uFlow;
      varying float vH, vCurv, vSlope, vAge;
      ${COMMON_FRAG}
      void main() {
        // Deposit time of this row: rows move uFlow per 60 Hz step, so the row now at
        // index r was written r / uFlow steps ago. Laminations stay attached to it.
        float moving = step(0.5, uFlow);
        float depo = (uSimSteps - vAge * ${(N - 1).toFixed(1)} / max(uFlow, 1.0)) / 15.0;   // 1 per 0.25 s
        float bandX = vH * uBands;
        // base: chalk, with an alternating deposit tint
        vec3 c = mix(uChalk, uSand, 0.35 * step(0.5, fract(floor(depo) * 0.5)) * moving);
        // absolute lows take a pale sea-green; hollows deepen it, crests and steep faces take ochre
        c = mix(c, mix(uChalk, uSea, 0.32), 1.0 - smoothstep(0.012, 0.07, vH));
        float hollow = smoothstep(0.0015, 0.012, vCurv);
        float ridge = smoothstep(0.0015, 0.012, -vCurv);
        float steep = smoothstep(0.3, 1.2, vSlope);
        c = mix(c, uSea, hollow * 0.75);
        c = mix(c, uSeaDeep, hollow * smoothstep(0.08, 0.4, vH) * 0.5);
        // ochre seams come in deposits: stronger on alternate laminations, like bedded iron
        float bed = 0.6 + 0.4 * smoothstep(0.2, 0.5, abs(fract(depo * 0.5) - 0.5));
        float seam = clamp(ridge * 0.9 + steep * 0.5, 0.0, 1.0) * smoothstep(0.03, 0.12, vH) * bed;
        c = mix(c, uOchre, seam * 0.85);
        c = mix(c, layerColor(floor(bandX)), 0.14);
        // height contours (fixed to the field) and deposit laminations (moving with it)
        float contour = lineAA(bandX, 1.0);
        float lam = lineAA(depo, 1.0) * moving;
        float lamFine = lineAA(depo * 4.0, 0.7) * moving * uFineLines;
        c = mix(c, uInk, (contour * 0.34 + lam * 0.16 + lamFine * 0.1) * uBandContrast);
        csm_DiffuseColor = vec4(c, 1.0);
        csm_Roughness = mix(0.9, 0.6, seam);
        csm_Metalness = 0.0;
      }`,
    roughness: 0.85, metalness: 0,
  });
  const surface = new THREE.Mesh(makeGrid(N), surfaceMat);
  surface.frustumCulled = false;     // vertices move on the GPU

  // ── Skirt: the cut faces ─────────────────────────────────────────────────
  const skirtMat = new CustomShaderMaterial({
    baseMaterial: THREE.MeshStandardMaterial,
    uniforms,
    vertexShader: /* glsl */`
      uniform sampler2D uH;
      uniform sampler2D uD;
      uniform float uRelief, uBroad, uBase;
      attribute vec2 aEdge;
      attribute float aTop;
      attribute float aPerim;
      varying float vY, vTopY, vPerim;
      ${FIELD_GLSL}
      void main() {
        float h = mix(fieldAt(uH, aEdge), texture2D(uD, aEdge).r, uBroad);
        float topY = h * uRelief;
        float y = mix(-uBase, topY, aTop);
        csm_Position = vec3(position.x, y, position.z);
        vY = y; vTopY = topY; vPerim = aPerim;
      }`,
    fragmentShader: /* glsl */`
      uniform float uRelief, uBase;
      varying float vY, vTopY, vPerim;
      ${COMMON_FRAG}
      void main() {
        float depth = clamp((vTopY - vY) / 0.35, 0.0, 1.0);          // 0 at the surface edge
        float wobble = (0.32 * sin(vPerim * 1.7) + 0.18 * sin(vPerim * 4.3 + 1.0)) * depth;
        float bandX = (vY / max(uRelief, 1e-3)) * uBands + wobble;
        vec3 c = layerColor(floor(bandX));
        c *= mix(0.74, 1.0, smoothstep(-uBase, 0.0, vY));
        c = mix(c, uInk, lineAA(bandX, 1.0) * 0.38);
        csm_DiffuseColor = vec4(c, 1.0);
        csm_Roughness = 0.92;
        csm_Metalness = 0.0;
      }`,
    roughness: 0.9, metalness: 0,
  });
  const skirt = new THREE.Mesh(makeSkirt(), skirtMat);
  skirt.frustumCulled = false;

  group.add(surface, skirt);

  return {
    name: 'strata', group,
    radius: () => P.strata.radius,
    shadow: { y: -BASE - 0.01, opacity: 0.32 },
    update() {
      const det = P.detail.strata;
      S.uBroad.value = P.strata.broad;
      S.uFine.value = 0.25 + 0.75 * det;
      S.uBands.value = P.strata.bands;
      S.uBandContrast.value = 0.2 + 0.8 * det;
      S.uFineLines.value = det;
    },
    triangles: () => 2 * (N - 1) * (N - 1) + 4 * (N - 1) * 2,
    mapping: () => {
      const det = P.detail.strata;
      return [
        ['height', `mix(H, D.smooth, ${P.strata.broad.toFixed(2)}) × Relief ${P.relief.toFixed(2)}`],
        ['normal', `mix(∇D, ∇H, ${(0.25 + 0.75 * det).toFixed(2)})  ← Detail`],
        ['contours', `${P.strata.bands} per field unit of height, fixed to the field`],
        ['laminations', `1 per 0.25 s of deposit, travel with the rows · contrast ${(0.2 + 0.8 * det).toFixed(2)}, fine ${det.toFixed(2)}  ← Detail`],
        ['colour', 'chalk · sea-green in lows and hollows (curvature > 0) · ochre on crests and steep faces'],
        ['cut faces', 'same band coordinate continued down the skirt'],
      ];
    },
  };
}
