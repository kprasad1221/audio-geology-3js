// ─────────────────────────────────────────────────────────────────────────────
//  The instrument's own controls: macros, Memory core sample, Light dial,
//  Attention range, Inspect switch. Native inputs underneath, so keyboard,
//  touch and screen readers work the same as any range or button.
// ─────────────────────────────────────────────────────────────────────────────
import { P, N, MEMORY_MIN, MEMORY_MAX, decayFor } from '../params.js';
import { columnToHz, hzToColumn, formatHz, binWidthHz, signal, isFullAttention } from '../signal.js';

const $ = id => document.getElementById(id);
const setFill = (input) => {
  const t = (input.value - input.min) / (input.max - input.min);
  input.style.setProperty('--fill', `${(t * 100).toFixed(1)}%`);
};

// Memory slider position (0..1000) ↔ half-life seconds, logarithmic.
const memToPos = s => Math.round(1000 * Math.log(s / MEMORY_MIN) / Math.log(MEMORY_MAX / MEMORY_MIN));
const posToMem = p => MEMORY_MIN * Math.pow(MEMORY_MAX / MEMORY_MIN, p / 1000);

export function createControls({ study, onChange, onAttention, onInspect, onLight }) {
  const m = { memory: $('mMemory'), weathering: $('mWeathering'), relief: $('mRelief'), detail: $('mDetail') };
  const o = { memory: $('oMemory'), weathering: $('oWeathering'), relief: $('oRelief'), detail: $('oDetail') };
  const DETAIL_NOTE = {
    strata: 'contour contrast · fine normals',
    currents: 'ribbon count · width',
    sediment: 'grain size · dust',
  };

  function drawCore() {
    // Each layer's brightness is what remains of a feature after that many seconds:
    // 2^(−t / half-life). The core sample *is* the decay curve.
    const svg = $('coreSample'), layers = 22, H = 132, span = 12;   // viewBox units; the svg stretches
    const s = getComputedStyle(document.documentElement);
    const cols = [s.getPropertyValue('--layer-3'), s.getPropertyValue('--layer-2'), s.getPropertyValue('--layer-1')].map(c => c.trim());
    let out = '';
    for (let i = 0; i < layers; i++) {
      const t = (i / (layers - 1)) * span;
      const k = Math.pow(2, -t / P.memory);
      const y = (i / layers) * H, hh = H / layers + 0.6;
      const col = cols[i % 3];
      out += `<rect x="0" y="${(H - y - hh).toFixed(1)}" width="30" height="${hh.toFixed(1)}" fill="${col}" opacity="${(0.12 + 0.88 * k).toFixed(3)}"/>`;
    }
    out += `<line x1="0" x2="30" y1="${(H - (P.memory / span) * H).toFixed(1)}" y2="${(H - (P.memory / span) * H).toFixed(1)}" stroke="var(--accent)" stroke-width="1.5"/>`;
    svg.innerHTML = out;
  }

  function sync() {
    m.memory.value = memToPos(P.memory);
    m.weathering.value = P.weathering;
    m.relief.value = P.relief;
    m.detail.value = P.detail[study()];
    for (const k in m) setFill(m[k]);
    o.memory.textContent = `${P.memory < 1 ? P.memory.toFixed(2) : P.memory.toFixed(1)} s`;
    m.memory.setAttribute('aria-valuetext', `${P.memory.toFixed(2)} seconds half-life, decay ${decayFor(P.memory).toFixed(4)} per step`);
    o.weathering.textContent = P.weathering.toFixed(2);
    o.relief.textContent = P.relief.toFixed(2);
    o.detail.textContent = P.detail[study()].toFixed(2);
    $('detailNote').textContent = DETAIL_NOTE[study()];
    drawCore();
    syncDial();
    syncAttention();
  }

  m.memory.addEventListener('input', () => { P.memory = posToMem(+m.memory.value); sync(); onChange('memory'); });
  m.weathering.addEventListener('input', () => { P.weathering = +m.weathering.value; sync(); onChange('weathering'); });
  m.relief.addEventListener('input', () => { P.relief = +m.relief.value; sync(); onChange('relief'); });
  m.detail.addEventListener('input', () => { P.detail[study()] = +m.detail.value; sync(); onChange('detail'); });

  // ── Light dial ────────────────────────────────────────────────────────────
  const dial = $('lightDial');
  const ticks = dial.querySelector('.dial-ticks');
  ticks.innerHTML = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2, r0 = i % 6 ? 26 : 24, r1 = 30;
    return `<line x1="${32 + Math.sin(a) * r0}" y1="${32 - Math.cos(a) * r0}" x2="${32 + Math.sin(a) * r1}" y2="${32 - Math.cos(a) * r1}"/>`;
  }).join('');
  const pointer = dial.querySelector('.dial-pointer');
  function syncDial() {
    pointer.setAttribute('transform', `rotate(${P.light} 32 32)`);
    dial.setAttribute('aria-valuenow', String(Math.round(P.light)));
    dial.setAttribute('aria-valuetext', `${Math.round(P.light)} degrees`);
    $('oLight').textContent = `${Math.round(P.light)}°`;
  }
  function setLight(deg) { P.light = ((Math.round(deg) % 360) + 360) % 360; syncDial(); onLight(); }
  dial.addEventListener('keydown', e => {
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 30, PageDown: -30 }[e.key];
    if (step != null) { setLight(P.light + step); e.preventDefault(); }
    else if (e.key === 'Home') { setLight(0); e.preventDefault(); }
    else if (e.key === 'End') { setLight(359); e.preventDefault(); }
  });
  const angleFrom = e => {
    const r = dial.getBoundingClientRect();
    return (Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180) / Math.PI;
  };
  dial.addEventListener('pointerdown', e => { dial.setPointerCapture(e.pointerId); dial.focus(); setLight(angleFrom(e)); });
  dial.addEventListener('pointermove', e => { if (dial.hasPointerCapture(e.pointerId)) setLight(angleFrom(e)); });

  // ── Inspect switch ────────────────────────────────────────────────────────
  const insp = $('inspectBtn');
  insp.addEventListener('click', () => onInspect(insp.getAttribute('aria-checked') !== 'true'));
  function setInspect(on) { insp.setAttribute('aria-checked', String(on)); }

  // ── Attention (two native ranges on one track) ───────────────────────────
  const lo = $('attnLo'), hi = $('attnHi'), sel = $('attnSel'), out = $('attnOut');
  const MIN_GAP = 6;
  function syncAttention() {
    const c0 = P.attnLo == null ? 0 : Math.round(hzToColumn(P.attnLo));
    const c1 = P.attnHi == null ? N - 1 : Math.round(hzToColumn(P.attnHi));
    lo.value = c0; hi.value = c1;
    sel.style.left = `${(c0 / (N - 1)) * 100}%`; sel.style.right = `${(1 - c1 / (N - 1)) * 100}%`;
    const f0 = columnToHz(c0), f1 = columnToHz(c1);
    out.innerHTML = `<b>${isFullAttention() ? 'Full range' : 'Selected'}</b> ${formatHz(f0)} – ${formatHz(f1)}`;
    lo.setAttribute('aria-valuetext', formatHz(f0)); hi.setAttribute('aria-valuetext', formatHz(f1));
    $('attnRes').textContent = `${binWidthHz().toFixed(1)} Hz bins · ${(signal.sampleRate / 1000).toFixed(1)} kHz · ⅓-oct taper`;
  }
  function fromInputs(which) {
    let c0 = +lo.value, c1 = +hi.value;
    if (c1 - c0 < MIN_GAP) { if (which === 'lo') c0 = c1 - MIN_GAP; else c1 = c0 + MIN_GAP; }
    c0 = Math.max(0, c0); c1 = Math.min(N - 1, c1);
    P.attnLo = c0 <= 0 ? null : columnToHz(c0);
    P.attnHi = c1 >= N - 1 ? null : columnToHz(c1);
    syncAttention(); onAttention();
  }
  lo.addEventListener('input', () => fromInputs('lo'));
  hi.addEventListener('input', () => fromInputs('hi'));
  // Let whichever thumb is nearer win when they overlap.
  $('attnDual').addEventListener('pointerdown', e => {
    const r = lo.getBoundingClientRect(), c = ((e.clientX - r.left) / r.width) * (N - 1);
    const nearLo = Math.abs(c - lo.value) <= Math.abs(c - hi.value);
    lo.style.zIndex = nearLo ? 2 : 1; hi.style.zIndex = nearLo ? 1 : 2;
  }, true);

  sync();
  return { sync, setInspect, syncAttention };
}
