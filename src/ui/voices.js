// ─────────────────────────────────────────────────────────────────────────────
//  The Voices section of the shelf: an eight-lane score of the band history,
//  time-aligned with the Filter heat map (older left, now right), a live meter
//  per voice, the amount fader and the layout choice.
//
//  The score is drawn from the same 8 × 256 record the world reads, so a stripe
//  here is a stripe on the ground. Different rhythms show as different spacings.
// ─────────────────────────────────────────────────────────────────────────────
import { N, NB, P, VOICE_PALETTES, BAND_EDGES, BAND_NAMES } from '../params.js';
import { bands } from '../bands.js';
import { PRESENCE } from '../world/voices.js';

const presence = l => { const t = Math.min(Math.max((l - PRESENCE[0]) / (PRESENCE[1] - PRESENCE[0]), 0), 1); return t * t * (3 - 2 * t); };

const $ = id => document.getElementById(id);
const LANE = 8, GAP = 4, METER = 14;
const W = N + GAP + METER, H = NB * LANE;
const SHORT = ['sub', 'bass', 'low', 'mid', 'hi-mid', 'pres', 'brill', 'air'];
const fmt = f => (f >= 1000 ? `${f / 1000}k` : `${f}`);

export function createVoicesUI({ onChange, study }) {
  const cv = $('voiceScore');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  let cols = VOICE_PALETTES.strata.map(hexToRgb), bg = [0, 0, 0];

  // lane labels, high voice on top (as the Filter heat map: frequency upward)
  const lanes = $('voiceLanes');
  lanes.innerHTML = SHORT.map((s, k) => `<span title="${BAND_NAMES[k]} · ${fmt(BAND_EDGES[k])}–${fmt(BAND_EDGES[k + 1])} Hz">${s}</span>`).reverse().join('');

  const fader = $('mVoices'), out = $('oVoices'), layout = $('voiceLayout');
  function sync() {
    fader.value = P.voices.amount;
    fader.style.setProperty('--fill', `${(P.voices.amount * 100).toFixed(1)}%`);
    out.textContent = P.voices.amount.toFixed(2);
    fader.setAttribute('aria-valuetext', `${Math.round(P.voices.amount * 100)} percent`);
    layout.value = P.voices.layout[study()];
  }
  fader.addEventListener('input', () => { P.voices.amount = +fader.value; sync(); onChange('amount'); });
  layout.addEventListener('change', () => { P.voices.layout[study()] = layout.value; sync(); onChange('layout'); });

  function setStudy(name) {
    layout.value = P.voices.layout[name];
    cols = (VOICE_PALETTES[name] || VOICE_PALETTES.strata).map(hexToRgb);
    const s = getComputedStyle(document.documentElement).getPropertyValue('--heat-bg').trim();
    bg = hexToRgb(s.startsWith('#') ? s : '#0a0f12');
  }

  function draw() {
    const d = img.data, hist = bands.hist;
    for (let k = 0; k < NB; k++) {
      const [r, g, b] = cols[k];
      const y0 = (NB - 1 - k) * LANE;
      for (let x = 0; x < N; x++) {
        const row = N - 1 - x, i = (row * NB + k) * 4;
        const lv = hist[i] * P.voices.gains[k], on = hist[i + 1] * P.voices.gains[k];
        const t = 0.1 + 0.9 * presence(lv), w = Math.min(on, 1) * 0.65;   // same curve the world uses
        const pr = bg[0] + (r - bg[0]) * t, pg = bg[1] + (g - bg[1]) * t, pb = bg[2] + (b - bg[2]) * t;
        for (let yy = 0; yy < LANE; yy++) {
          const p = ((y0 + yy) * W + x) * 4;
          const edge = yy === LANE - 1 ? 0.55 : 1;                 // a hairline between lanes
          const top = yy < LANE / 2 ? w : w * 0.4;                // onsets read as bright ticks
          d[p] = (pr + (255 - pr) * top) * edge; d[p + 1] = (pg + (255 - pg) * top) * edge; d[p + 2] = (pb + (255 - pb) * top) * edge; d[p + 3] = 255;
        }
      }
      // gap + live meter (the analysis right now, even while the world is held)
      const lv = Math.min(bands.level[k] * P.voices.gains[k], 1), fill = Math.round(lv * METER), on = Math.min(bands.onset[k], 1);
      for (let x = N; x < W; x++) {
        const inMeter = x >= N + GAP, lit = inMeter && x - (N + GAP) < fill;
        for (let yy = 0; yy < LANE; yy++) {
          const p = ((y0 + yy) * W + x) * 4;
          if (!inMeter || yy >= LANE - 1) { d[p + 3] = 0; continue; }
          const t = lit ? 0.35 + 0.65 * lv : 0.08;
          d[p] = bg[0] + (r - bg[0]) * t + (255 - r) * on * 0.5 * lit; d[p + 1] = bg[1] + (g - bg[1]) * t + (255 - g) * on * 0.5 * lit; d[p + 2] = bg[2] + (b - bg[2]) * t + (255 - b) * on * 0.5 * lit; d[p + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  sync();
  return { sync, draw, setStudy };
}

function hexToRgb(h) {
  const n = parseInt(h.replace('#', '').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
