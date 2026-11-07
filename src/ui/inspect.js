// ─────────────────────────────────────────────────────────────────────────────
//  Inspect: exact numbers. Tweakpane for the raw parameters, the live mapping of
//  the active study, field formats, a 60-second frame-time capture, and presets.
// ─────────────────────────────────────────────────────────────────────────────
import { Pane } from 'tweakpane';
import { P, VERSION, BUDGETS, CURRENTS_TREATMENTS, snapshot, assign, decayFor } from '../params.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const kv = (el, rows) => { el.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join(''); };

export function createInspect(app) {
  const pane = new Pane({ container: $('pane'), title: 'Parameters', expanded: true });
  const fS = pane.addFolder({ title: 'Signal' });
  fS.addBinding(P, 'gain', { min: 0, max: 3, step: 0.01 });
  fS.addBinding(P, 'lag', { min: 0, max: 0.98, step: 0.01 });
  fS.addBinding(P, 'resample', { min: 0, max: 1, step: 0.01, label: 'lin → log' });
  fS.addBinding(P, 'attnFloor', { min: 0, max: 1, step: 0.01, label: 'attn floor' });
  const fF = pane.addFolder({ title: 'Filter (canonical)' });
  fF.addBinding(P, 'flow', { min: 0, max: 4, step: 1, label: 'translate' });
  fF.addBinding(P, 'step', { min: 1, max: 4, step: 0.25, label: 'sample step' });
  fF.addBinding(P, 'gamma', { min: 0.8, max: 1.3, step: 0.01 });
  fF.addBinding(P, 'contrast', { min: 0.8, max: 1.3, step: 0.01 });
  const fSt = pane.addFolder({ title: 'Strata', expanded: false });
  fSt.addBinding(P.strata, 'radius', { min: 1, max: 8, step: 1, label: 'D radius' });
  fSt.addBinding(P.strata, 'bands', { min: 12, max: 36, step: 1 });
  fSt.addBinding(P.strata, 'broad', { min: 0, max: 1, step: 0.01, label: 'broad ↔ fine' });
  const fC = pane.addFolder({ title: 'Currents', expanded: false });
  const treat = { treatment: P.currents.treatment };
  fC.addBinding(treat, 'treatment', { options: Object.fromEntries(Object.entries(CURRENTS_TREATMENTS).map(([k, t]) => [t.label, k])) })
    .on('change', e => { app.applyTreatment(e.value); pane.refresh(); });
  fC.addBinding(P.currents, 'radius', { min: 1, max: 8, step: 1, label: 'D radius' });
  fC.addBinding(P.currents, 'flowMix', { min: 0, max: 1, step: 0.01, label: 'downslope ↔ contour' });
  fC.addBinding(P.currents, 'bias', { min: 0, max: 1, step: 0.01, label: 'bias → older' });
  fC.addBinding(P.currents, 'length', { min: 0.02, max: 0.16, step: 0.005 });
  fC.addBinding(P.currents, 'segments', { min: 6, max: 8, step: 1 });
  const fSe = pane.addFolder({ title: 'Sediment', expanded: false });
  fSe.addBinding(P.sediment, 'radius', { min: 1, max: 8, step: 1, label: 'D radius' });
  fSe.addBinding(P.sediment, 'grid', { options: { '128 × 128': '128x128', '256 × 128': '256x128' } });
  fSe.addBinding(P.sediment, 'floor', { min: 0, max: 1, step: 0.01, label: 'floor density' });
  fSe.addBinding(P.sediment, 'gap', { min: 0, max: 0.5, step: 0.01, label: 'gap threshold' });
  fSe.addBinding(P.sediment, 'slices', { min: 0, max: 6, step: 1 });
  const fR = pane.addFolder({ title: 'Render', expanded: false });
  fR.addBinding(P, 'budget', { options: Object.fromEntries(Object.entries(BUDGETS).map(([k, b]) => [b.label, k])), label: 'pixel budget' });
  pane.on('change', e => app.onParams(e));

  // ── Live readouts ─────────────────────────────────────────────────────────
  function refreshStatic() {
    const study = app.study();
    $('mapStudy').textContent = study[0].toUpperCase() + study.slice(1);
    kv($('mapList'), app.mapping());
    const mem = app.field.memoryReport();
    kv($('fieldInfo'), [
      ['H (canonical)', mem.H],
      ['D (derived)', mem.D],
      ['clock', `60 Hz fixed step · ≤ 4 steps per frame`],
      ['Memory', `${P.memory.toFixed(2)} s → decay ${decayFor(P.memory).toFixed(5)} / step`],
      ['history', P.flow > 0 ? `≈ ${(256 / (P.flow * 60)).toFixed(2)} s across the field` : 'translate 0: rows do not move'],
    ]);
    $('kernel').innerHTML = app.field.kernel.map((v, i) => `<span class="${i === 4 ? 'c' : ''}">${v.toFixed(3)}</span>`).join('');
    pane.refresh();
  }
  function refreshLive(stats) {
    kv($('perfLive'), [
      ['frame', `${stats.fps.toFixed(0)} fps · ${stats.ms.toFixed(1)} ms`],
      ['draws / frame', String(stats.calls)],
      ['triangles', stats.triangles.toLocaleString()],
      ['points', stats.points.toLocaleString()],
      ['canvas', `${stats.cw} × ${stats.ch} px · ${(stats.cw * stats.ch / 1e6).toFixed(2)} MP · ratio ${stats.pr.toFixed(2)}`],
      ['sim', `${stats.stepsPerSec.toFixed(0)} steps/s · dropped ${stats.dropped}`],
    ]);
  }

  // ── 60-second frame-time capture ─────────────────────────────────────────
  let measure = null;
  $('measureBtn').addEventListener('click', () => {
    if (measure) return;
    measure = { phase: 'warmup', t0: performance.now(), samples: [], last: null };
    $('measureBtn').textContent = 'Warming up (5 s)…';
    $('perfOut').hidden = true; $('perfCopy').hidden = true;
  });
  function onFrame(now, stats) {
    if (!measure) return;
    const el = (now - measure.t0) / 1000;
    if (measure.phase === 'warmup') {
      if (el >= 5) { measure.phase = 'run'; measure.t0 = now; measure.last = now; }
      return;
    }
    measure.samples.push(now - measure.last); measure.last = now;
    $('measureBtn').textContent = `Measuring… ${Math.ceil(60 - el)} s`;
    if (el < 60) return;
    const s = measure.samples.slice().sort((a, b) => a - b);
    const q = p => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
    const result = {
      version: VERSION, date: new Date().toISOString(), userAgent: navigator.userAgent,
      viewport: `${innerWidth} × ${innerHeight} CSS px · devicePixelRatio ${devicePixelRatio}`,
      canvas: `${stats.cw} × ${stats.ch} px (${(stats.cw * stats.ch / 1e6).toFixed(2)} MP, budget ${P.budget})`,
      study: app.study(), source: app.sourceName(), frames: s.length,
      frameMs: { median: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2), max: +s[s.length - 1].toFixed(2) },
      meanFps: +(1000 / (s.reduce((a, b) => a + b, 0) / s.length)).toFixed(1),
      drawCalls: stats.calls, triangles: stats.triangles, points: stats.points,
      field: app.field.memoryReport(), droppedSimSteps: stats.dropped,
    };
    measure = null;
    $('measureBtn').textContent = 'Measure 60 s';
    $('perfOut').textContent = JSON.stringify(result, null, 2);
    $('perfOut').hidden = false; $('perfCopy').hidden = false;
  }
  $('perfCopy').addEventListener('click', () => navigator.clipboard?.writeText($('perfOut').textContent));

  // ── Presets ──────────────────────────────────────────────────────────────
  $('exportBtn').addEventListener('click', () => {
    const data = { app: 'audio-geology-3js', version: VERSION, study: app.study(), params: snapshot(),
      palette: { strata: 'mineral daylight', currents: 'cobalt observatory', sediment: 'spectral specimen' }[app.study()],
      camera: app.cameraState() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `audio-geology-${app.study()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('importBtn').addEventListener('click', () => $('presetFile').click());
  $('presetFile').addEventListener('change', async () => {
    const f = $('presetFile').files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'audio-geology-3js' || !String(data.version).startsWith('study-02')) throw new Error('not a Study 02 preset');
      app.applyPreset(data);
      app.status(`Preset loaded: ${f.name}`);
    } catch (e) { app.status(`Couldn't load ${f.name}: ${e.message}.`); }
    $('presetFile').value = '';
  });
  $('authored').addEventListener('change', e => { if (e.target.value) app.applyAuthored(e.target.value); e.target.value = ''; });

  return { refreshStatic, refreshLive, onFrame, refreshPane: () => pane.refresh(), syncTreatment: () => { treat.treatment = P.currents.treatment; pane.refresh(); } };
}

// Three authored states, in the same schema as an exported preset.
export const AUTHORED = {
  strata: { study: 'strata', camera: 'survey',
    params: { memory: 2.8824, weathering: 0.75, relief: 2.4, light: 215, detail: { strata: 0.55 }, strata: { radius: 3, bands: 24, broad: 0.35 } } },
  currents: { study: 'currents', camera: 'survey', treatment: 'orderly',
    params: { memory: 3.6, weathering: 0.82, relief: 2.0, light: 210, detail: { currents: 0.55 } } },
  sediment: { study: 'sediment', camera: 'survey',
    params: { memory: 2.8824, weathering: 0.7, relief: 2.6, light: 140, detail: { sediment: 0.5 }, sediment: { grid: '128x128', floor: 0.3, gap: 0.01, slices: 6, radius: 2 } } },
};
export { assign };
