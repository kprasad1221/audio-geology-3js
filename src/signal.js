// ─────────────────────────────────────────────────────────────────────────────
//  SIGNAL — Spectrum → Math (gain) → Lag → Resample → Attention → CHOP to TOP
//
//  Unchanged from web study 01 except for one new stage: Attention, a smooth
//  per-column weight applied after Resample. With Attention at full range the
//  weight is 1 everywhere and the row is identical to study 01's.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { N, BINS, FFT_SIZE, P } from './params.js';

const MIN_B = 1, MAX_B = 420;          // analyser bins mapped onto columns 0 … 255
const TAPER_OCT = 1 / 3;               // Attention edge taper, in octaves

export const signal = {
  bins: new Float32Array(BINS),        // raw spectrum 0..1
  lagged: new Float32Array(BINS),      // Lag CHOP state
  row: new Float32Array(N),            // the 256 × 1 row written into the field
  weight: new Float32Array(N).fill(1), // Attention weight per column
  slow: new Float32Array(N),           // a slow average, used to find the dominant register
  peakCol: 0,
  sampleRate: 48000,                   // nominal for the test signal; the AudioContext's rate otherwise
  tex: null,
};
signal.tex = new THREE.DataTexture(signal.row, N, 1, THREE.RedFormat, THREE.FloatType);
signal.tex.minFilter = signal.tex.magFilter = THREE.NearestFilter;
signal.tex.needsUpdate = true;

// ── Column ↔ frequency (the Resample CHOP's mapping, made explicit) ───────────
export function columnToBin(x, r = P.resample) {
  const u = x / (N - 1);
  return (1 - r) * (MIN_B + u * (MAX_B - MIN_B)) + r * (MIN_B * Math.pow(MAX_B / MIN_B, u));
}
export const binWidthHz = () => signal.sampleRate / FFT_SIZE;
export const columnToHz = x => columnToBin(x) * binWidthHz();
export function hzToColumn(f) {
  if (f <= columnToHz(0)) return 0;
  if (f >= columnToHz(N - 1)) return N - 1;
  let lo = 0, hi = N - 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; (columnToHz(m) < f) ? (lo = m) : (hi = m); }
  return (lo + hi) / 2;
}
export const isFullAttention = () => P.attnLo == null && P.attnHi == null;
export function attentionColumns() {
  return [P.attnLo == null ? 0 : hzToColumn(P.attnLo), P.attnHi == null ? N - 1 : hzToColumn(P.attnHi)];
}
export function formatHz(f) {
  if (f >= 1000) return `${(f / 1000).toFixed(f >= 10000 ? 1 : (f >= 2000 ? 1 : 2)).replace(/\.0+$/, '')} kHz`;
  return `${Math.round(f)} Hz`;
}

const smoothstep = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

// Rebuild the Attention weights. Called when the range, floor, lin→log or sample rate changes.
export function rebuildWeights() {
  if (isFullAttention()) { signal.weight.fill(1); return; }
  const [c0, c1] = attentionColumns();
  const l0 = Math.log2(columnToHz(c0)), l1 = Math.log2(columnToHz(c1));
  for (let x = 0; x < N; x++) {
    const l = Math.log2(columnToHz(x));
    const w = (P.attnLo == null ? 1 : smoothstep(l0 - TAPER_OCT, l0, l)) *
              (P.attnHi == null ? 1 : 1 - smoothstep(l1, l1 + TAPER_OCT, l));
    signal.weight[x] = P.attnFloor + (1 - P.attnFloor) * w;
  }
}

// One simulation step of the Signal chain. `read(bins)` fills the raw spectrum.
export function cookSignal(read) {
  const { bins, lagged, row, weight, slow } = signal;
  read(bins);
  // Math CHOP (gain) + Lag CHOP: a one-pole low-pass that keeps `lag` of the old value.
  for (let i = 0; i < BINS; i++) lagged[i] = lagged[i] * P.lag + bins[i] * P.gain * (1 - P.lag);
  // Resample CHOP: 512 bins → 256 columns, blending linear and log spacing.
  let peak = 0, peakV = -1;
  for (let x = 0; x < N; x++) {
    const b = columnToBin(x);
    const i0 = Math.floor(b), f = b - i0;
    const v = (lagged[i0] * (1 - f) + lagged[Math.min(i0 + 1, BINS - 1)] * f) * weight[x];   // × Attention
    row[x] = v;
    slow[x] = slow[x] * 0.97 + v * 0.03;
    if (slow[x] > peakV) { peakV = slow[x]; peak = x; }
  }
  signal.peakCol = peak;
  signal.tex.needsUpdate = true;
}

export function clearSignalState() {
  signal.lagged.fill(0); signal.row.fill(0); signal.slow.fill(0);
  signal.tex.needsUpdate = true;
}
