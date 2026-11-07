// ─────────────────────────────────────────────────────────────────────────────
//  Voice layers: shared uniforms and GLSL for every study.
//
//  Where a voice lives (uLayout):
//    register   along the frequency axis: each voice over its own columns
//    elevation  by height: low voices in the basins, high voices on the crests
//    woven      scattered grains or ribbons, each belonging to one voice
//
//  What it does there:
//    colour     its palette colour × its level, read from the band history at the
//               ground's age, so each voice's rhythm travels back with the rows
//               (mixed toward the present by uVoiceNow)
//    glint      onsets lower roughness and add a little emission
//    motion     one noise octave per voice: low voices move broad folds, high voices
//               fine ripples (audio frequency → spatial frequency). Spatial
//               frequencies 2 … 80 cycles across the field; amplitude ∝ level;
//               each octave drifts in its own direction at a speed set by its level.
//
//  None of this writes into the canonical field.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { N, NB, P, LAYOUTS, VOICE_PALETTES, BAND_EDGES } from '../params.js';
import { bands } from '../bands.js';

export const VOICE_FREQS = [2.0, 3.4, 5.8, 9.8, 16.6, 28.0, 47.0, 80.0];   // cycles across the field
export const H_REF = 0.6;     // field height that counts as "high" for the elevation layout
export const PRESENCE = [0.22, 0.92];   // level → presence curve (shared with the score drawing)

export function createVoiceUniforms() {
  return {
    uBandHist: { value: bands.tex },
    uBandLive: { value: new Float32Array(NB) },
    uBandOnsetLive: { value: new Float32Array(NB) },
    uBandGain: { value: new Float32Array(NB).fill(1) },
    uBandPhase: { value: new Float32Array(NB) },
    uBandCol: { value: Array.from({ length: NB }, () => new THREE.Color()) },
    uBandEdgeU: { value: new Float32Array(NB + 1) },
    uVoiceColor: { value: 0.6 }, uVoiceMotion: { value: 0.6 }, uVoiceNow: { value: 0.3 }, uLayout: { value: 2 },
  };
}

export function setVoicePalette(VU, study) {
  (VOICE_PALETTES[study] || VOICE_PALETTES.strata).forEach((h, k) => VU.uBandCol.value[k].set(h));
}

export function setVoiceEdges(VU, hzToColumn) {
  BAND_EDGES.forEach((f, k) => { VU.uBandEdgeU.value[k] = hzToColumn(f) / (N - 1); });
  VU.uBandEdgeU.value[0] = 0; VU.uBandEdgeU.value[NB] = 1.0001;   // the outer bands own the ends of the axis
}

export function updateVoiceUniforms(VU, study) {
  const v = P.voices;
  VU.uBandLive.value.set(bands.world.level);
  VU.uBandOnsetLive.value.set(bands.world.onset);
  VU.uBandPhase.value.set(bands.world.phase);
  for (let k = 0; k < NB; k++) VU.uBandGain.value[k] = v.gains[k];
  VU.uVoiceColor.value = v.amount * v.color;
  VU.uVoiceMotion.value = v.amount * v.motion;
  VU.uVoiceNow.value = v.now;
  VU.uLayout.value = LAYOUTS[v.layout[study]] ?? 2;
}

export const VOICES_GLSL = /* glsl */`
  uniform sampler2D uBandHist;
  uniform float uBandLive[8];
  uniform float uBandOnsetLive[8];
  uniform float uBandGain[8];
  uniform float uBandPhase[8];
  uniform vec3  uBandCol[8];
  uniform float uBandEdgeU[9];
  uniform float uVoiceColor, uVoiceMotion, uVoiceNow, uLayout;

  float vhash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

  // Value noise with its derivatives (Inigo Quilez): x = value in −1..1, yz = d/dp.
  vec3 noised(vec2 x) {
    vec2 i = floor(x), f = fract(x);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    float a = vhash(i), b = vhash(i + vec2(1.0, 0.0)), c = vhash(i + vec2(0.0, 1.0)), d = vhash(i + vec2(1.0, 1.0));
    float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
    return vec3(-1.0 + 2.0 * (a + k1 * u.x + k2 * u.y + k4 * u.x * u.y), 2.0 * du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
  }

  // Grains: nearest cell of a jittered grid. x = cell hash, y = distance to the next cell (F2 − F1), z = cell centre (v)
  vec3 voiceCell(vec2 x) {
    vec2 n = floor(x), f = fract(x);
    float d1 = 8.0, d2 = 8.0; vec2 cell = n, centre = n;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = vec2(vhash(n + g), vhash(n + g + 19.19)) * 0.8 + 0.1;
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; cell = n + g; centre = n + g + o; } else if (d < d2) { d2 = d; }
    }
    return vec3(vhash(cell + 7.7), sqrt(d2) - sqrt(d1), centre.y);
  }

  float voiceHN(float h) { return clamp(sqrt(max(h, 0.0) / ${H_REF.toFixed(2)}), 0.0, 1.0); }

  // The record of voice k at age v (0 = now): x = presence, y = onset; × its gain.
  // Presence = smoothstep(${PRESENCE[0]}, ${PRESENCE[1]}, level): a voice colours and moves the ground
  // while it sounds and lets go between notes, instead of tinting everything a little.
  vec2 voiceAt(int k, float v) {
    float row = floor(clamp(v, 0.0, 1.0) * ${(N - 1).toFixed(1)} + 0.5);
    vec2 h = texture2D(uBandHist, vec2((float(k) + 0.5) / 8.0, (row + 0.5) / ${N.toFixed(1)})).rg;
    vec2 r = mix(h, vec2(uBandLive[k], uBandOnsetLive[k]), uVoiceNow) * uBandGain[k];
    return vec2(smoothstep(${PRESENCE[0].toFixed(2)}, ${PRESENCE[1].toFixed(2)}, r.x), r.y);
  }

  // How much a location belongs to voice k. u: frequency axis, hN: normalised height, id: element hash.
  float voiceWeight(int k, float u, float hN, float id) {
    if (uLayout < 0.5) {
      float a = uBandEdgeU[k], b = uBandEdgeU[k + 1], s = 0.004;
      return smoothstep(a - s, a + s, u) * (1.0 - smoothstep(b - s, b + s, u));
    }
    if (uLayout < 1.5) {
      float d = (clamp(hN, 0.0625, 0.9375) * 8.0 - 0.5) - float(k);
      return exp(-3.125 * d * d);                    // σ = 0.4 band: weights sum to ≈ 1
    }
    return float(int(min(floor(id * 8.0), 7.0)) == k);
  }

  // The single voice an element belongs to (ribbons, grains).
  int voiceIndex(float u, float hN, float id) {
    if (uLayout > 1.5) return int(min(floor(id * 8.0), 7.0));
    if (uLayout > 0.5) return int(clamp(floor(hN * 8.0), 0.0, 7.0));
    int k = 0;
    for (int i = 1; i < 8; i++) if (u >= uBandEdgeU[i]) k = i;
    return k;
  }

  // All voices at a location: rgb = their colours mixed by strength, a = total strength; onset out.
  vec4 voiceMix(float u, float hN, float id, float v, out float onset) {
    vec3 col = vec3(0.0); float s = 0.0; onset = 0.0;
    for (int k = 0; k < 8; k++) {
      float w = voiceWeight(k, u, hN, id);
      vec2 lo = voiceAt(k, v);
      col += uBandCol[k] * w * lo.x; s += w * lo.x; onset += w * lo.y;
    }
    return vec4(s > 1e-4 ? col / s : vec3(0.0), s);
  }

  // Motion: octaves k0 … k1−1. Returns (height, d/du, d/dv) in field units.
  vec3 voiceMotion(vec2 uv, float hN, float v, int k0, int k1) {
    const float VF[8] = float[8](${VOICE_FREQS.map(f => f.toFixed(1)).join(', ')});
    vec3 acc = vec3(0.0);
    for (int k = 0; k < 8; k++) {
      if (k < k0 || k >= k1) continue;
      float w = uLayout > 1.5 ? 1.0 : voiceWeight(k, uv.x, hN, 0.0);
      float f = VF[k];
      float a = 0.025 * pow(VF[0] / f, 0.7) * voiceAt(k, v).x * w;
      float ang = float(k) * 2.39996;
      vec3 n = noised(uv * f + vec2(cos(ang), sin(ang)) * uBandPhase[k] + float(k) * 17.13);
      acc += a * vec3(n.x, n.yz * f);
    }
    return acc * uVoiceMotion;
  }
`;
