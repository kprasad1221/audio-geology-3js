// ─────────────────────────────────────────────────────────────────────────────
//  VOICES — eight frequency bands, each followed as its own voice.
//
//  The spectrum is already there (the analyser's FFT); a band is the mean of the
//  bins between two edges. The four low voices read a second, 4096-point FFT
//  (11.7 Hz bins, 85 ms window): fine enough to separate 30–60 Hz from 60–150 Hz.
//  The four high voices read the 1024-point FFT the field uses (46.9 Hz, 21 ms),
//  which keeps their timing sharp. Per voice, per 60 Hz step:
//
//    range   a slow peak and a slow floor follow the band, so every voice uses its
//            own 0..1 (hats and kicks differ by tens of dB; both should read)
//    level   envelope: fast attack, release from 0.24 s (sub) to 0.06 s (air)
//    onset   a rise larger than `onset` × the band's recent average rise triggers a
//            pulse of 1 that decays with a 0.1 s half-life (66 ms refractory)
//    phase   advances faster while the voice is loud; drives its motion layer
//
//  History: every simulation step that moves the field also writes one row of
//  (level, onset) per voice into an 8 × 256 float texture and shifts it exactly
//  as the field's rows are translated. Row r of the history is what each voice was
//  doing when row r of the ground was laid down.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { N, NB, P, SIM_HZ, BAND_EDGES } from './params.js';

const coef = halfLife => 1 - Math.pow(2, -1 / (SIM_HZ * Math.max(halfLife, 1e-4)));
const PEAK_HALF = 3.0, FLOOR_HALF = 8.0, FLUX_HALF = 1.0, ONSET_HALF = 0.1;
const MIN_RANGE = 0.04, MIN_FLUX = 0.08, REFRACTORY = 4, CURVE = 1.35;

export const bands = {
  raw: new Float32Array(NB), norm: new Float32Array(NB), prev: new Float32Array(NB),
  level: new Float32Array(NB), onset: new Float32Array(NB),
  peak: new Float32Array(NB), floor: new Float32Array(NB), flux: new Float32Array(NB),
  refractory: new Int32Array(NB), phase: new Float32Array(NB),
  started: false,
  // world-facing copies: what the render layers see (frozen while the world is held)
  world: { level: new Float32Array(NB), onset: new Float32Array(NB), phase: new Float32Array(NB) },
  hist: new Float32Array(N * NB * 4),
  tex: null,
  lowBins: new Float32Array(2048),
};
bands.tex = new THREE.DataTexture(bands.hist, NB, N, THREE.RGBAFormat, THREE.FloatType);
bands.tex.minFilter = bands.tex.magFilter = THREE.NearestFilter;
bands.tex.needsUpdate = true;

function bandMean(arr, binHz, f0, f1) {
  const i0 = Math.max(1, Math.floor(f0 / binHz));
  const i1 = Math.min(arr.length, Math.max(i0 + 1, Math.ceil(f1 / binHz)));
  let s = 0;
  for (let i = i0; i < i1; i++) s += arr[i];
  return s / (i1 - i0);
}

// One analysis step. hi: the 512-bin spectrum (binHz each); low: optional finer spectrum.
export function cookBands(hi, hiHz, low, lowHz) {
  const v = P.voices;
  const atk = coef(v.attack);
  for (let k = 0; k < NB; k++) {
    const f0 = BAND_EDGES[k], f1 = BAND_EDGES[k + 1];
    const raw = (k < 4 && low) ? bandMean(low, lowHz, f0, f1) : bandMean(hi, hiHz, f0, f1);
    bands.raw[k] = raw;
    if (!bands.started) { bands.floor[k] = raw; bands.peak[k] = raw + MIN_RANGE; }
    // adaptive range
    if (raw > bands.peak[k]) bands.peak[k] = raw; else bands.peak[k] += (raw - bands.peak[k]) * coef(PEAK_HALF);
    if (raw < bands.floor[k]) bands.floor[k] = raw; else bands.floor[k] += (raw - bands.floor[k]) * coef(FLOOR_HALF);
    const range = Math.max(bands.peak[k] - bands.floor[k], MIN_RANGE);
    const n = Math.pow(Math.min(Math.max((raw - bands.floor[k]) / range, 0), 1), CURVE);
    // envelope
    const rel = coef(v.releaseLow * Math.pow(v.releaseHigh / v.releaseLow, k / (NB - 1)));
    bands.level[k] += (n - bands.level[k]) * (n > bands.level[k] ? atk : rel);
    // onset
    const rise = Math.max(0, n - bands.prev[k]);
    if (bands.refractory[k] > 0) bands.refractory[k]--;
    if (rise > Math.max(v.onset * bands.flux[k], MIN_FLUX) && bands.refractory[k] === 0) {
      bands.onset[k] = 1; bands.refractory[k] = REFRACTORY;
    } else {
      bands.onset[k] *= 1 - coef(ONSET_HALF);
    }
    bands.flux[k] += (rise - bands.flux[k]) * coef(FLUX_HALF);
    bands.prev[k] = n; bands.norm[k] = n;
  }
  bands.started = true;
}

// Called on the steps that move the field (not while held).
export function depositBands(dt) {
  const row = NB * 4, f = Math.max(0, Math.min(N, Math.round(P.flow)));
  if (f > 0) bands.hist.copyWithin(f * row, 0, (N - f) * row);
  for (let r = 0; r < Math.max(f, 1); r++) {
    for (let k = 0; k < NB; k++) {
      const i = r * row + k * 4;
      bands.hist[i] = bands.level[k]; bands.hist[i + 1] = bands.onset[k]; bands.hist[i + 2] = bands.norm[k]; bands.hist[i + 3] = 1;
    }
  }
  for (let k = 0; k < NB; k++) bands.phase[k] += dt * (0.05 + 0.6 * bands.level[k]);
  bands.tex.needsUpdate = true;
}

export function syncWorld() {
  bands.world.level.set(bands.level); bands.world.onset.set(bands.onset); bands.world.phase.set(bands.phase);
}

export function clearBands() {
  for (const a of [bands.raw, bands.norm, bands.prev, bands.level, bands.onset, bands.flux, bands.phase,
    bands.world.level, bands.world.onset, bands.world.phase]) a.fill(0);
  bands.refractory.fill(0); bands.hist.fill(0); bands.started = false;
  bands.tex.needsUpdate = true;
}
