// ─────────────────────────────────────────────────────────────────────────────
//  Audio Geology · Study 02 — a geological instrument
//
//    SIGNAL   source → spectrum → gain → lag → resample → Attention → 256 × 1 row
//    FILTER   canonical field H (feedback, 60 Hz fixed step)  →  derived field D
//    WORLD    the active study reads H and D: Strata · Currents · Sediment
//
//  One simulation, three ways of looking at it. Switching study changes which
//  render passes are visible; it never touches H, the audio position or the camera.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { P, N, SIZE, SIM_HZ, BINS, FFT_SIZE, BUDGETS, CURRENTS_TREATMENTS, assign } from './params.js';
import { FixedClock, SIM_DT } from './clock.js';
import { signal, cookSignal, clearSignalState, rebuildWeights, hzToColumn, columnToHz, attentionColumns, isFullAttention } from './signal.js';
import { Sources } from './audio.js';
import { bands, cookBands, depositBands, syncWorld, clearBands } from './bands.js';
import { createVoiceUniforms, setVoicePalette, setVoiceEdges, updateVoiceUniforms } from './world/voices.js';
import { createVoicesUI } from './ui/voices.js';
import { createField } from './field.js';
import { createStage, createSurvey } from './world/stage.js';
import { createStrata } from './world/strata.js';
import { createCurrents } from './world/currents.js';
import { createSediment } from './world/sediment.js';
import { erode, engrave } from './ui/geology.js';
import { createControls } from './ui/controls.js';
import { createMonitors } from './ui/monitors.js';
import { createOverlay } from './ui/overlay.js';
import { createInspect, AUTHORED } from './ui/inspect.js';

const $ = id => document.getElementById(id);
const root = document.documentElement;

// ── Renderer ────────────────────────────────────────────────────────────────
const canvas = $('stage');
let renderer, field;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  field = createField(renderer, signal.tex);
} catch (e) {
  $('glError').hidden = false;
  $('glError').textContent = `WebGL2 with float render targets is needed here. ${e.message || e}`;
  throw e;
}
renderer.setClearColor(0x000000, 0);              // transparent: the page's stone shows behind the world
renderer.toneMapping = THREE.NeutralToneMapping;   // keeps chalk, sea-green and ochre close to their authored values
renderer.info.autoReset = false;                   // we count draws for the whole frame, all passes

const sources = new Sources();
const stage = createStage(renderer);
const survey = createSurvey(stage.scene);

// Uniforms every study shares (same objects, so one assignment updates all).
const U = {
  uH: { value: field.H }, uD: { value: field.D },
  uTexel: { value: new THREE.Vector2(1 / N, 1 / N) },
  uRelief: { value: P.relief }, uSize: { value: SIZE },
  uSimSteps: { value: 0 }, uFlow: { value: P.flow },     // field steps taken; rows moved per step
};
const VU = createVoiceUniforms();     // the eight voices (render layers only)
Object.assign(U, VU);
const studies = {
  strata: createStrata(U),
  currents: createCurrents(U, stage.keyDir),
  sediment: createSediment(U, stage.keyDir),
};
for (const s of Object.values(studies)) { s.group.visible = false; stage.scene.add(s.group); }

// Per-study light and exposure. One warm key, one cool fill, environment kept low.
const LOOKS = {
  strata:   { env: 0.62, key: 2.9, keyColor: 0xffe1bf, fill: 0.6,  sky: 0xd3e5ec, ground: 0x6d5a44, exposure: 1.0,  survey: [0x1f3537, 0.45] },
  currents: { env: 0.22, key: 2.3, keyColor: 0xe2ecff, fill: 0.22, sky: 0x4a6a9a, ground: 0x050a10, exposure: 1.08, survey: [0xcfe0f0, 0.38] },
  sediment: { env: 0.18, key: 2.0, keyColor: 0xfff0dc, fill: 0.2,  sky: 0x8090a0, ground: 0x0a0a0a, exposure: 1.0,  survey: [0xe9e4da, 0.42] },
};

let study = 'strata';
const state = { running: true, held: false, inspect: false, perform: false, hidden: false };
const cur = () => studies[study];

// ── Interface geology (static SVG) ──────────────────────────────────────────
engrave($('engravings'));
erode(document.querySelector('.edge-face'), {
  side: 'left', seed: 3,
  layers: [
    { inset: 4, amp: 7, freq: 1.3, fill: 'var(--layer-1)' },
    { inset: 10, amp: 8, freq: 1.0, fill: 'var(--layer-2)' },
    { inset: 15, amp: 7, freq: 1.5, fill: 'var(--layer-3)' },
    { inset: 21, amp: 6, freq: 0.9, fill: 'var(--face)' },
  ],
  lines: [{ inset: 28, amp: 4, freq: 0.8, stroke: 'var(--layer-line)' }, { inset: 33, amp: 3, freq: 0.7, stroke: 'var(--layer-line)', opacity: 0.6 }],
});
erode($('shelf'), {
  side: 'top', seed: 7,
  layers: [
    { inset: 3, amp: 6, freq: 0.9, fill: 'var(--layer-1)' },
    { inset: 8, amp: 7, freq: 0.7, fill: 'var(--layer-2)' },
    { inset: 12, amp: 6, freq: 1.1, fill: 'var(--layer-3)' },
    { inset: 17, amp: 5, freq: 0.8, fill: 'var(--face)' },
  ],
  lines: [{ inset: 19, amp: 3, freq: 0.6, stroke: 'var(--layer-line)', opacity: 0.7 }],
});

// ── UI modules ──────────────────────────────────────────────────────────────
const monitors = createMonitors(renderer, field, { filterPlot: $('filterPlot'), signalPlot: $('signalPlot'), heatHz: $('heatHz') });
const overlay = createOverlay({ overlay: $('overlay'), labels: $('labels'), leaders: $('leaders') }, stage.camera);
let needDerive = true, signalDirty = true, previewDirty = true;

const controls = createControls({
  study: () => study,
  onChange: key => {
    if (key === 'memory' || key === 'weathering') field.applyParams();
    inspect?.refreshStatic();
  },
  onAttention: () => { rebuildWeights(); signalDirty = true; previewDirty = true; inspect?.refreshStatic(); },
  onInspect: on => setInspect(on),
  onLight: () => stage.setLight(P.light),
});

const voicesUI = createVoicesUI({ study: () => study, onChange: () => { voicesDirty = true; inspect?.refreshStatic(); } });
let voicesDirty = true;

const app = {
  field,
  study: () => study,
  mapping: () => cur().mapping(),
  sourceName: () => sources.mode === 'file' ? `file: ${sources.fileName}` : sources.mode,
  cameraState: () => ({ position: stage.camera.position.toArray().map(v => +v.toFixed(3)),
    target: stage.controls.target.toArray().map(v => +v.toFixed(3)), fov: stage.camera.fov }),
  status: msg => { $('status').textContent = msg; },
  applyTreatment: name => { studies.currents.applyTreatment(name); needDerive = true; inspect.refreshStatic(); },
  onParams: () => {
    field.applyParams(); rebuildWeights(); controls.sync(); voicesUI.sync(); buildSurvey(); monitors.layoutHzTicks();
    setVoiceEdges(VU, hzToColumn); voicesDirty = true;
    needDerive = true; signalDirty = true; previewDirty = true; resize(); inspect.refreshStatic();
  },
  applyPreset: data => applyPreset(data),
  applyAuthored: name => applyAuthored(name),
};
const inspect = createInspect(app);

// ── Study switching ─────────────────────────────────────────────────────────
function setStudy(name) {
  if (!studies[name]) return;
  study = name;
  root.dataset.study = name;
  for (const [k, s] of Object.entries(studies)) s.group.visible = k === name;
  document.querySelectorAll('.rail button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.study === name)));
  const L = LOOKS[name];
  stage.scene.environmentIntensity = L.env;
  stage.key.intensity = L.key; stage.key.color.setHex(L.keyColor);
  stage.fill.intensity = L.fill; stage.fill.color.setHex(L.sky); stage.fill.groundColor.setHex(L.ground);
  renderer.toneMappingExposure = L.exposure;
  stage.shadow.visible = cur().shadow.opacity > 0;
  stage.shadow.position.y = cur().shadow.y; stage.shadow.material.opacity = cur().shadow.opacity;
  survey.mat.color.setHex(L.survey[0]); survey.mat.opacity = L.survey[1];
  monitors.setStudy(name); monitors.readTokens();
  setVoicePalette(VU, name); voicesUI.setStudy(name); voicesDirty = true;
  controls.sync(); inspect.refreshStatic();
  needDerive = true; signalDirty = true; previewDirty = true;
}
document.querySelectorAll('.rail button').forEach(b => b.addEventListener('click', () => setStudy(b.dataset.study)));

// ── Camera bookmarks ────────────────────────────────────────────────────────
const camButtons = document.querySelectorAll('.bookmarks button');
camButtons.forEach(b => b.addEventListener('click', () => {
  stage.goTo(b.dataset.cam);
  camButtons.forEach(x => x.setAttribute('aria-pressed', String(x === b)));
}));
stage.controls.addEventListener('start', () => camButtons.forEach(x => x.setAttribute('aria-pressed', 'false')));

// ── Survey frame (real Hz and seconds) ──────────────────────────────────────
function buildSurvey() {
  const hzTicks = [50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000]
    .map(f => ({ f, c: hzToColumn(f) }))
    .filter(t => t.c > 0.5 && t.c < N - 1.5)
    .map(t => ({ u: t.c / (N - 1), major: true, label: t.f >= 1000 ? `${t.f / 1000}k` : `${t.f}` }));
  const secondTicks = [];
  if (P.flow > 0) {
    const windowS = N / (P.flow * SIM_HZ);
    for (let s = 0; s <= windowS + 1e-6; s += windowS > 3 ? 1 : 0.5) secondTicks.push({ v: (s * P.flow * SIM_HZ) / N, label: s === 0 ? 'now' : `−${s} s` });
  }
  survey.build({ hzTicks, secondTicks });
}

// ── Sources and transport ───────────────────────────────────────────────────
const srcBtn = { test: $('srcTest'), file: $('srcFile'), mic: $('srcMic') };
function markSource() { for (const k in srcBtn) srcBtn[k].setAttribute('aria-pressed', String(k === sources.mode)); }
function syncRate() { signal.sampleRate = sources.sampleRate; rebuildWeights(); controls.syncAttention(); buildSurvey(); monitors.layoutHzTicks(); setVoiceEdges(VU, hzToColumn); signalDirty = true; }
function syncTransport() {
  $('playTxt').textContent = state.running ? 'Pause' : 'Play';
  $('playIco').setAttribute('d', state.running ? 'M4 3h3v10H4zM9 3h3v10H9z' : 'M4 2.5v11l9-5.5z');
  $('holdBtn').setAttribute('aria-pressed', String(state.held));
  $('holdTxt').textContent = state.held ? 'Release' : 'Hold';
}
function run() { state.running = true; sources.play(); clock.reset(); syncTransport(); }
function pause() { state.running = false; sources.pause(); syncTransport(); }

srcBtn.test.addEventListener('click', () => {
  sources.useTest(); markSource(); syncRate(); run();
  app.status('Test signal: a kick at 120 BPM, a drifting tone and off-beat hats, generated in the page.');
});
srcBtn.file.addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async () => {
  const f = $('fileInput').files[0]; if (!f) return;
  app.status(`Decoding ${f.name}…`);
  try {
    const buf = await sources.useFile(f);
    markSource(); syncRate(); run();
    app.status(`${f.name} · ${buf.numberOfChannels === 2 ? 'stereo summed to mono' : 'mono'} · ${(buf.sampleRate / 1000).toFixed(1)} kHz · ${buf.duration.toFixed(1)} s, looping · decoded locally`);
  } catch (e) {
    app.status(`Couldn't decode ${f.name}. Try MP3, WAV or M4A. Still using the ${sources.mode === 'file' ? 'previous file' : sources.mode === 'mic' ? 'microphone' : 'test signal'}.`);
  }
  $('fileInput').value = '';
});
srcBtn.mic.addEventListener('click', async () => {
  const before = sources.mode;
  app.status('Asking for microphone access…');
  try {
    await sources.useMic();
    markSource(); syncRate(); run();
    app.status('Microphone live (not sent to the speakers). Hum, clap or play near it.');
  } catch (e) {
    markSource();
    app.status(`Microphone unavailable (${e.name || 'blocked'}). It needs permission and a localhost or https page. Still using the ${before === 'file' ? 'audio file' : before === 'mic' ? 'microphone' : 'test signal'}.`);
  }
});
$('playBtn').addEventListener('click', () => (state.running ? pause() : run()));
$('holdBtn').addEventListener('click', () => {
  state.held = !state.held;
  clock.reset();
  syncTransport();
  app.status(state.held ? 'World held: the signal keeps playing, the field is frozen.' : 'Released: the field resumes from the current source position.');
});
function clearMemory() {
  field.clear(); clearSignalState(); clearBands(); clock.reset();
  needDerive = true; signalDirty = true; previewDirty = true; voicesDirty = true;
}
$('restartBtn').addEventListener('click', () => {
  sources.seekStart(); clearMemory();
  app.status(sources.mode === 'mic' ? 'Restarted: memory cleared, a fresh observation.' : 'Restarted from the beginning; memory cleared. Camera and settings kept.');
});
$('clearBtn').addEventListener('click', () => {
  clearMemory();
  app.status(sources.mode === 'mic' ? 'Memory cleared: a fresh observation.' : 'Memory cleared; the source keeps its position.');
});

// ── Inspect, Perform, drawer ────────────────────────────────────────────────
function setInspect(on) {
  state.inspect = on;
  $('inspect').hidden = !on;
  controls.setInspect(on);
  if (on) inspect.refreshStatic(); else overlay.clear();
}
$('inspectClose').addEventListener('click', () => { setInspect(false); $('inspectBtn').focus(); });
$('performBtn').addEventListener('click', () => {
  state.perform = !state.perform;
  if (state.perform) { root.dataset.perform = ''; setInspect(false); } else delete root.dataset.perform;
  $('performBtn').setAttribute('aria-pressed', String(state.perform));
  $('performBtn').textContent = state.perform ? 'Exit perform' : 'Perform';
});
const edge = $('edge');
function setDrawer(open) {
  edge.classList.toggle('open', open);
  $('controlsBtn').setAttribute('aria-expanded', String(open));
  if (open) edge.querySelector('input, button, [tabindex]')?.focus(); else $('controlsBtn').focus();
}
$('controlsBtn').addEventListener('click', () => setDrawer(!edge.classList.contains('open')));
$('edgeClose').addEventListener('click', () => setDrawer(false));
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (edge.classList.contains('open')) setDrawer(false);
  else if (state.inspect) { setInspect(false); $('inspectBtn').focus(); }
});

// ── Presets ─────────────────────────────────────────────────────────────────
function applyPreset(data) {
  if (data.params) assign(P, data.params);
  if (data.study) setStudy(data.study);
  if (data.camera) stage.goTo(typeof data.camera === 'string' ? data.camera : data.camera);
  inspect.syncTreatment();
  app.onParams();
}
function applyAuthored(name) {
  const a = AUTHORED[name]; if (!a) return;
  if (a.treatment) studies.currents.applyTreatment(a.treatment);
  applyPreset(a);
  app.status(`Authored state: ${name}${a.treatment ? ` · ${CURRENTS_TREATMENTS[a.treatment].label}` : ''}.`);
}

// ── Sizing under a pixel budget ─────────────────────────────────────────────
const world = $('world');
let pixelRatio = 1;
function resize() {
  const r = world.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  const budget = (BUDGETS[P.budget] || BUDGETS.balanced).pixels;
  pixelRatio = Math.max(0.5, Math.min(devicePixelRatio || 1, Math.sqrt(budget / (w * h))));
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h, false);
  stage.camera.aspect = w / h; stage.camera.updateProjectionMatrix();
  stage.refit();
  studies.currents.setViewport(canvas.width, canvas.height, pixelRatio);
  studies.sediment.setPixelRatio(pixelRatio);
  monitors.readTokens(); signalDirty = true;
}
new ResizeObserver(resize).observe(world);
addEventListener('resize', resize);

document.addEventListener('visibilitychange', () => {
  state.hidden = document.hidden;
  if (!document.hidden) { clock.reset(); last = performance.now(); }
});

// ── Annotations (Inspect) and survey labels (Sediment, Inspect) ─────────────
const tmp = { a: new THREE.Vector3(), b: new THREE.Vector3() };
const toWorld = (u, v, h) => new THREE.Vector3((u - 0.5) * SIZE, h * P.relief, (0.5 - v) * SIZE);
function drawOverlay() {
  const showSurvey = !state.perform && (study === 'sediment' || state.inspect);
  survey.lines.visible = showSurvey;
  if (!showSurvey) { overlay.clear(); return; }
  const leaders = [];
  if (state.inspect) {
    let px = 0; for (let x = 1; x < N; x++) if (signal.row[x] > signal.row[px]) px = x;
    leaders.push({ text: 'recent signal', world: toWorld(px / (N - 1), 0, signal.row[px]), dx: 40, dy: -46 });
    const keep = monitors.maxIn(0.35, 0.85);
    if (keep.h > 0.02) {
      const L = { text: 'retained field', world: toWorld(keep.u, keep.v, keep.h), dx: -150, dy: -54 };
      leaders.push(L);
      if (study === 'currents') {
        // the local flow direction from the CPU mirror, same rule as the shader (coarse)
        const e = 0.02, hu = monitors.heightAt(keep.u + e, keep.v) - monitors.heightAt(keep.u - e, keep.v);
        const hv = monitors.heightAt(keep.u, keep.v + e) - monitors.heightAt(keep.u, keep.v - e);
        const m = Math.hypot(hu, hv) || 1, k = P.currents.flowMix;
        let du = (1 - k) * -hu / m + k * -hv / m, dv = (1 - k) * -hv / m + k * hu / m + P.currents.bias;
        const dm = Math.hypot(du, dv) || 1; du /= dm; dv /= dm;
        leaders.push({ text: 'flow direction', world: L.world, arrow: toWorld(keep.u + du * 0.08, keep.v + dv * 0.08, keep.h), dx: 60, dy: 40 });
      }
    }
  }
  overlay.draw(survey.labels, leaders);
}

// ── Sediment's spectral register ────────────────────────────────────────────
function updateAccent() {
  let c0, c1;
  if (!isFullAttention()) [c0, c1] = attentionColumns();
  else { const f = columnToHz(signal.peakCol); c0 = hzToColumn(f / 2 ** (1 / 6)); c1 = hzToColumn(f * 2 ** (1 / 6)); }
  studies.sediment.setAccent((c0 + c1) / 2 / (N - 1), Math.max((c1 - c0) / 2, 3) / (N - 1));
}

// ── The cook ────────────────────────────────────────────────────────────────
const clock = new FixedClock();
let last = performance.now();
const stats = { fps: 60, ms: 16.7, calls: 0, triangles: 0, points: 0, cw: 0, ch: 0, pr: 1, stepsPerSec: 60, dropped: 0 };
let fpsFrames = 0, fpsT = 0, stepCount = 0, liveT = 0;
const hooks = { renderWorld: true };

function simulate(n) {
  for (let i = 0; i < n; i++) {
    cookSignal(bins => sources.read(bins));   // SIGNAL
    const low = sources.readLow(bands.lowBins);  // VOICES: the long FFT for the low bands (real audio only)
    cookBands(signal.bins, signal.sampleRate / FFT_SIZE, low ? bands.lowBins : null, sources.lowBinHz);
    sources.advance(SIM_DT);
    if (!state.held) { field.step(); depositBands(SIM_DT); U.uSimSteps.value++; }   // FILTER (frozen while held)
  }
  if (n > 0) {
    signalDirty = true; voicesDirty = true;
    if (!state.held) { needDerive = true; previewDirty = true; syncWorld(); }
  }
  stepCount += n;
}

function frame(now = performance.now()) {
  const dt = Math.max(0, (now - last) / 1000); last = now;
  renderer.info.reset();

  const n = state.running && !state.hidden ? clock.advance(dt) : (clock.reset(), 0);
  simulate(n);

  if (needDerive) { field.derive(cur().radius()); needDerive = false; }   // D, once per frame
  U.uH.value = field.H; U.uD.value = field.D; U.uRelief.value = P.relief; U.uFlow.value = P.flow;
  updateVoiceUniforms(VU, study);
  cur().update();
  if (study === 'sediment') updateAccent();
  stage.update(dt);

  if (hooks.renderWorld) { renderer.setRenderTarget(null); renderer.render(stage.scene, stage.camera); }   // WORLD
  if (previewDirty) { monitors.updateFilter(); previewDirty = false; }
  if (signalDirty) { monitors.drawSignal(); signalDirty = false; }
  if (voicesDirty) { voicesUI.draw(); voicesDirty = false; }
  drawOverlay();

  // stats
  fpsFrames++; fpsT += dt; liveT += dt;
  const info = renderer.info.render;
  Object.assign(stats, { calls: info.calls, triangles: info.triangles, points: info.points, cw: canvas.width, ch: canvas.height, pr: pixelRatio, dropped: clock.dropped });
  if (fpsT >= 0.5) {
    stats.fps = fpsFrames / fpsT; stats.ms = (fpsT / fpsFrames) * 1000; stats.stepsPerSec = stepCount / fpsT;
    fpsFrames = 0; fpsT = 0; stepCount = 0;
    $('ageLabel').textContent = P.flow > 0 ? `−${(N / (P.flow * SIM_HZ)).toFixed(1)} s` : 'held';
  }
  if (state.inspect && liveT > 0.5) { inspect.refreshLive(stats); liveT = 0; }
  inspect.onFrame(now, stats);
  requestAnimationFrame(frame);
}

// ── Boot ────────────────────────────────────────────────────────────────────
signal.sampleRate = sources.sampleRate;
rebuildWeights(); buildSurvey(); monitors.layoutHzTicks(); setVoiceEdges(VU, hzToColumn);
setStudy('strata'); stage.setLight(P.light); syncTransport(); markSource();
resize();
requestAnimationFrame(frame);

// Test and capture hooks (used by the repo's headless checks; harmless otherwise).
window.__ag = {
  P, state, field, stage, studies, signal, sources, hooks, stats, bands,
  setStudy, goTo: (name, instant = true) => stage.goTo(name, instant),
  restart: () => { sources.seekStart(); clearMemory(); },
  stepSim: n => { simulate(n); needDerive = true; },
  readField: () => field.readSync(),
  simSteps: () => clock.steps, dropped: () => clock.dropped,
  setInspect, applyAuthored, applyTreatment: app.applyTreatment, onParams: app.onParams,
};
