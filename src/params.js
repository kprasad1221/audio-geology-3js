// ─────────────────────────────────────────────────────────────────────────────
//  Parameters: the custom parameters of the whole network, in one place.
//
//  Everything that a preset can save lives in P. The canonical field (Signal and
//  Filter groups) is shared by every study; World values are render-only and
//  never write back into the field.
// ─────────────────────────────────────────────────────────────────────────────

export const VERSION = 'study-02/0.2';

export const N = 256;          // canonical field: 256 × 256 texels (= Strata grid verts per side)
export const SIZE = 10;        // world size of the field, scene units
export const BINS = 512;       // analyser bins
export const FFT_SIZE = 1024;  // AnalyserNode.fftSize
export const SIM_HZ = 60;      // simulation clock; every parameter keeps its meaning at this rate

export const STUDIES = ['strata', 'currents', 'sediment'];

export const P = {
  // Signal · CHOPs
  gain: 1.15,
  lag: 0.55,
  resample: 0.65,          // lin → log
  attnLo: null,            // Hz, or null = lowest column (full range)
  attnHi: null,            // Hz, or null = highest column
  attnFloor: 0.2,          // weight outside the Attention range

  // Filter · feedback TOPs (the canonical field)
  flow: 1,                 // Translate: rows pushed back per simulation step
  weathering: 0.75,        // kernel blend, identity → 3×3 gaussian (was "blur")
  step: 1,                 // kernel sample step
  memory: -1 / (60 * Math.log2(0.996)),   // nominal half-life, s: ≈ 2.88 s, exactly study 01's 0.996 per step
  gamma: 1.0,
  contrast: 1.0,

  // World (render only)
  relief: 2.4,             // displacement height, scene units
  light: 215,              // key-light azimuth, degrees
  detail: { strata: 0.5, currents: 0.5, sediment: 0.5 },

  strata:   { radius: 3, bands: 24, broad: 0.35 },
  currents: { treatment: 'orderly', radius: 5, flowMix: 1.0, bias: 0.22, length: 0.2, segments: 8 },
  sediment: { radius: 2, grid: '128x128', floor: 0.3, gap: 0.01, slices: 6 },

  budget: 'balanced',      // drawing-buffer pixel budget
};

// Memory is a nominal half-life. The decay multiplier applied once per 60 Hz step:
//   decay = 2^(-1 / (60 · halfLife))
export const decayFor = halfLife => Math.pow(2, -1 / (SIM_HZ * halfLife));
export const MEMORY_MIN = 0.25, MEMORY_MAX = 12;

// Currents treatments: three named parameter sets for side-by-side comparison.
export const CURRENTS_TREATMENTS = {
  orderly: { label: 'Orderly channels', radius: 5, flowMix: 1.0,  bias: 0.22, length: 0.20, segments: 8, density: 1.0,  width: 1.0 },
  eddies:  { label: 'Clustered eddies', radius: 2, flowMix: 0.55, bias: 0.0,  length: 0.16, segments: 8, density: 1.0,  width: 0.85 },
  sparse:  { label: 'Sparse reset',     radius: 4, flowMix: 0.85, bias: 0.4,  length: 0.11, segments: 6, density: 0.45, width: 1.3 },
};

export const BUDGETS = {
  light:    { label: 'Light · 1 MP',    pixels: 1.0e6 },
  balanced: { label: 'Balanced · 2 MP', pixels: 2.0e6 },
  high:     { label: 'High · 3.5 MP',   pixels: 3.5e6 },
};

// Camera bookmarks. "baseline" is web study 01's camera, kept for before/after captures.
export const BOOKMARKS = {
  survey:   { position: [-11.2, 6.8, 11.6], target: [0.7, 0.0, 0.2], fov: 34 },
  detail:   { position: [-2.4, 3.6, 10.2], target: [0.9, 0.4, 2.6], fov: 34 },
  score:    { position: [-15.5, 6.4, 0.0], target: [0.0, 0.3, 0.0],  fov: 34 },
  baseline: { position: [0, 8.2, 15.5],    target: [0, -0.4, -1.4],  fov: 38 },
};

// Deep-copy helpers for presets.
export function snapshot() { return JSON.parse(JSON.stringify(P)); }
export function assign(target, src) {
  for (const k of Object.keys(src)) {
    if (!(k in target)) continue;
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') assign(target[k], v);
    else if (typeof v === typeof target[k] || target[k] === null || v === null) target[k] = v;
  }
}
