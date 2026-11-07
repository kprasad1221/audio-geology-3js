// ─────────────────────────────────────────────────────────────────────────────
//  The causal shelf: SIGNAL (the row going in) and FILTER (the field it builds).
//
//  Study 01 drew the field preview into the WebGL canvas *underneath* an
//  86%-opaque card, which is why its history thumbnail looked almost blank.
//  Here the field is colour-mapped into a small 256 × 128 render target and read
//  back asynchronously (PBO + fence, no stall) into its own 2D canvas.
//  The alpha channel carries the raw height (h / 2, 8-bit), which gives the page a
//  coarse CPU copy of the field for annotations, at no extra GPU pass.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { N } from '../params.js';
import { signal, columnToHz, hzToColumn, attentionColumns, isFullAttention } from '../signal.js';

export const PW = 256, PH = 128;     // preview: time across, frequency up
const HZ_TICKS = [50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000];
const tickLabel = f => (f >= 1000 ? `${f / 1000}k` : `${f}`);

const HEAT = {   // colour ramps per study (low → high)
  strata:   ['#1d4245', '#4d8a84', '#a9c7bc', '#e8e9dc', '#c37b42'],
  currents: ['#040b16', '#0f2c6e', '#2a63d4', '#78b4f4', '#dcefff'],
  sediment: ['#040507', '#16244f', '#2f5ee0', '#3fd3e6', '#f2a24c'],
};

export function createMonitors(renderer, field, els) {
  // ── FILTER preview ──────────────────────────────────────────────────────
  const rt = new THREE.WebGLRenderTarget(PW, PH, { depthBuffer: false });
  const ramp = Array.from({ length: 5 }, () => new THREE.Color());
  const mat = new THREE.ShaderMaterial({
    uniforms: { uH: { value: null }, uRamp: { value: ramp } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uH;
      uniform vec3 uRamp[5];
      varying vec2 vUv;
      void main() {
        // x: older (left) → now (right) · readback row 0 is the top of the image: high frequency
        vec2 fuv = vec2(1.0 - vUv.y, 1.0 - vUv.x);
        float h = texture2D(uH, fuv).r;
        float t = sqrt(clamp(h * 1.25, 0.0, 1.0));            // display curve only
        vec3 c = mix(uRamp[0], uRamp[1], smoothstep(0.0, 0.25, t));
        c = mix(c, uRamp[2], smoothstep(0.25, 0.5, t));
        c = mix(c, uRamp[3], smoothstep(0.5, 0.78, t));
        c = mix(c, uRamp[4], smoothstep(0.78, 1.0, t));
        gl_FragColor = vec4(c, clamp(h * 0.5, 0.0, 1.0));     // alpha = raw height / 2
      }`,
    toneMapped: false,
  });
  mat.blending = THREE.NoBlending;
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const fc = els.filterPlot;
  fc.width = PW; fc.height = PH;
  const fctx = fc.getContext('2d');
  const img = fctx.createImageData(PW, PH);
  const buf = new Uint8Array(PW * PH * 4);
  const mirror = new Float32Array(PW * PH);   // height, [row = freq from top][col = time]
  let pending = false, asyncOK = typeof renderer.readRenderTargetPixelsAsync === 'function';
  let frames = 0;

  function setStudy(name) { (HEAT[name] || HEAT.strata).forEach((h, i) => ramp[i].set(h)); }

  function drawAttentionOnHeat() {
    if (isFullAttention()) return;
    const [c0, c1] = attentionColumns();
    fctx.save();
    fctx.strokeStyle = 'rgba(255,255,255,0.7)'; fctx.setLineDash([3, 3]); fctx.lineWidth = 1;
    for (const c of [c0, c1]) { const y = (1 - c / (N - 1)) * PH; fctx.beginPath(); fctx.moveTo(0, y); fctx.lineTo(PW, y); fctx.stroke(); }
    fctx.restore();
  }

  function updateFilter() {
    frames++;
    if (pending) return;
    mat.uniforms.uH.value = field.H;
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.setRenderTarget(null);
    if (!asyncOK) {
      if (frames % 6) return;                    // fallback: a synchronous read at 10 Hz
      renderer.readRenderTargetPixels(rt, 0, 0, PW, PH, buf); land(); return;
    }
    pending = true;
    renderer.readRenderTargetPixelsAsync(rt, 0, 0, PW, PH, buf).then(land).catch(() => { asyncOK = false; pending = false; });
  }
  function land() {
    for (let i = 0; i < PW * PH; i++) { mirror[i] = buf[i * 4 + 3] / 255 * 2; buf[i * 4 + 3] = 255; }
    img.data.set(buf);
    fctx.putImageData(img, 0, 0);
    drawAttentionOnHeat();
    pending = false;
  }

  // CPU field lookup from the mirror: u (freq 0..1), v (age 0..1, 0 = now).
  function heightAt(u, v) {
    const col = Math.min(PW - 1, Math.max(0, Math.round((1 - v) * (PW - 1))));
    const row = Math.min(PH - 1, Math.max(0, Math.round((1 - u) * (PH - 1))));
    return mirror[row * PW + col];
  }
  function maxIn(v0, v1) {
    let best = { u: 0.5, v: (v0 + v1) / 2, h: 0 };
    for (let col = Math.round((1 - v1) * (PW - 1)); col <= Math.round((1 - v0) * (PW - 1)); col += 2)
      for (let row = 0; row < PH; row += 2) {
        const h = mirror[row * PW + col];
        if (h > best.h) best = { u: 1 - row / (PH - 1), v: 1 - col / (PW - 1), h };
      }
    return best;
  }

  // ── Hz ticks for the filter's vertical axis ───────────────────────────────
  function layoutHzTicks() {
    const host = els.heatHz; host.innerHTML = '';
    let lastC = -Infinity;
    for (const f of [100, 1000, 4000, 16000]) {
      const c = hzToColumn(f);
      if (c <= 2 || c >= N - 3 || c - lastC < 22) continue;
      lastC = c;
      const s = document.createElement('span'); s.textContent = tickLabel(f);
      s.style.top = `${(1 - c / (N - 1)) * 100}%`;
      host.appendChild(s);
    }
  }

  // ── SIGNAL plot ───────────────────────────────────────────────────────────
  const sc = els.signalPlot, sctx = sc.getContext('2d');
  let css = {};
  function readTokens() {
    const s = getComputedStyle(document.documentElement);
    css = { plot: s.getPropertyValue('--plot').trim(), fill: s.getPropertyValue('--plot-fill').trim(),
      grid: s.getPropertyValue('--plot-grid').trim(), dim: s.getPropertyValue('--plot-dim').trim(),
      ink: s.getPropertyValue('--plot-ink').trim(), accent: s.getPropertyValue('--accent').trim() };
  }
  function sizeCanvas() {
    const r = sc.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (sc.width !== w || sc.height !== h) { sc.width = w; sc.height = h; }
    return dpr;
  }
  function drawSignal() {
    const dpr = sizeCanvas();
    const w = sc.width, h = sc.height, axis = 14 * dpr, ph = h - axis;
    sctx.clearRect(0, 0, w, h);
    sctx.strokeStyle = css.grid; sctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { const y = Math.round((ph * i) / 4) + 0.5; sctx.beginPath(); sctx.moveTo(0, y); sctx.lineTo(w, y); sctx.stroke(); }
    const X = c => (c / (N - 1)) * w, Y = v => ph - Math.min(v, 1.05) * (ph - 4 * dpr);
    sctx.beginPath(); sctx.moveTo(0, ph);
    for (let x = 0; x < N; x++) sctx.lineTo(X(x), Y(signal.row[x]));
    sctx.lineTo(w, ph); sctx.closePath(); sctx.fillStyle = css.fill; sctx.fill();
    sctx.beginPath();
    for (let x = 0; x < N; x++) x ? sctx.lineTo(X(x), Y(signal.row[x])) : sctx.moveTo(X(x), Y(signal.row[x]));
    sctx.strokeStyle = css.plot; sctx.lineWidth = 1.5 * dpr; sctx.stroke();
    // Attention: dim what is outside the selection
    if (!isFullAttention()) {
      const [c0, c1] = attentionColumns();
      sctx.fillStyle = css.dim;
      sctx.fillRect(0, 0, X(c0), ph); sctx.fillRect(X(c1), 0, w - X(c1), ph);
      sctx.strokeStyle = css.accent; sctx.lineWidth = dpr;
      for (const c of [c0, c1]) { sctx.beginPath(); sctx.moveTo(X(c), 0); sctx.lineTo(X(c), ph); sctx.stroke(); }
    }
    // frequency axis, real positions
    sctx.fillStyle = css.ink; sctx.globalAlpha = 0.7;
    sctx.font = `${9.5 * dpr}px "IBM Plex Mono", ui-monospace, monospace`; sctx.textBaseline = 'bottom';
    let lastRight = -Infinity;
    for (const f of HZ_TICKS) {
      const c = hzToColumn(f); if (c <= 0 || c >= N - 1) continue;
      const x = X(c); const label = tickLabel(f);
      const tw = sctx.measureText(label).width;
      sctx.fillRect(Math.round(x), ph, dpr, 3 * dpr);
      const lx = Math.min(Math.max(x - tw / 2, 0), w - tw);
      if (lx < lastRight + 6 * dpr) continue;          // no overlapping labels
      sctx.fillText(label, lx, h); lastRight = lx + tw;
    }
    sctx.globalAlpha = 1;
  }

  return { setStudy, updateFilter, drawSignal, readTokens, layoutHzTicks, heightAt, maxIn, mirror };
}
