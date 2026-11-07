// ─────────────────────────────────────────────────────────────────────────────
//  FILTER — the canonical field H, and the derived field D.
//
//  H  Feedback TOP: two float render targets swapped every simulation step.
//     Translate → Convolve (Weathering kernel) → Level (Memory, gamma, contrast)
//     → Composite the new signal row at the front edge. Same order and maths as
//     web study 01; only the decay now comes from a half-life at 60 Hz.
//
//  D  Derived field (render layer, never fed back): one pass over H that writes
//     r = smoothed height, g = ∂h/∂u, b = ∂h/∂v, a = curvature (neighbour mean − centre),
//     sampled at a spatial radius chosen by the active study.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { N, P, decayFor } from './params.js';

const QUAD_VS = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// ── Format probe ────────────────────────────────────────────────────────────
// Check, in order, which float targets this GPU can render into AND read back as
// float (a value of 3.25 must survive; a unorm fallback would clamp it to 1).
const H_CANDIDATES = [
  { label: 'R32F',    format: THREE.RedFormat,  type: THREE.FloatType,     bytes: 4 },
  { label: 'RGBA32F', format: THREE.RGBAFormat, type: THREE.FloatType,     bytes: 16 },
  { label: 'R16F',    format: THREE.RedFormat,  type: THREE.HalfFloatType, bytes: 2 },
  { label: 'RGBA16F', format: THREE.RGBAFormat, type: THREE.HalfFloatType, bytes: 8 },
];
const D_CANDIDATES = [
  { label: 'RGBA16F', format: THREE.RGBAFormat, type: THREE.HalfFloatType, bytes: 8,  filter: THREE.LinearFilter },
  { label: 'RGBA32F', format: THREE.RGBAFormat, type: THREE.FloatType,     bytes: 16, filter: THREE.NearestFilter },
];

function makeQuad(material) {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  return scene;
}

function probeFormat(renderer, quadCam, cand) {
  const gl = renderer.getContext();
  const rt = new THREE.WebGLRenderTarget(4, 4, {
    format: cand.format, type: cand.type, depthBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  const rt8 = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false });
  const write = new THREE.ShaderMaterial({ vertexShader: QUAD_VS, fragmentShader: `void main(){ gl_FragColor = vec4(3.25); }` });
  const copy = new THREE.ShaderMaterial({
    uniforms: { uT: { value: rt.texture } }, vertexShader: QUAD_VS,
    fragmentShader: `uniform sampler2D uT; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(uT, vUv).r / 4.0); }`,
  });
  let ok = false;
  try {
    renderer.setRenderTarget(rt);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    if (complete) {
      renderer.render(makeQuad(write), quadCam);
      renderer.setRenderTarget(rt8);
      renderer.render(makeQuad(copy), quadCam);
      const px = new Uint8Array(4);
      renderer.readRenderTargetPixels(rt8, 0, 0, 1, 1, px);
      ok = Math.abs(px[0] - 207) <= 2;          // 3.25 / 4 = 0.8125 → 207
    }
  } catch (e) { ok = false; }
  renderer.setRenderTarget(null);
  rt.dispose(); rt8.dispose(); write.dispose(); copy.dispose();
  return ok;
}

export function createField(renderer, signalTex) {
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const hFmt = H_CANDIDATES.find(c => probeFormat(renderer, quadCam, c));
  const dFmt = D_CANDIDATES.find(c => probeFormat(renderer, quadCam, c));
  if (!hFmt || !dFmt) throw new Error('This GPU cannot render into float textures (needs WebGL2 + EXT_color_buffer_float).');

  const hOpts = { format: hFmt.format, type: hFmt.type, depthBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping };
  let hA = new THREE.WebGLRenderTarget(N, N, hOpts);
  let hB = new THREE.WebGLRenderTarget(N, N, hOpts);
  const d = new THREE.WebGLRenderTarget(N, N, { format: dFmt.format, type: dFmt.type, depthBuffer: false,
    minFilter: dFmt.filter, magFilter: dFmt.filter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });

  const kernel = new Array(9).fill(0);
  const texel = new THREE.Vector2(1 / N, 1 / N);

  // ── Feedback pass (H) ─────────────────────────────────────────────────────
  const simMat = new THREE.ShaderMaterial({
    uniforms: {
      uPrev: { value: null }, uSignal: { value: signalTex }, uTexel: { value: texel },
      uFlow: { value: 1 }, uStep: { value: 1 }, uK: { value: kernel },
      uDecay: { value: 0.996 }, uGamma: { value: 1 }, uContrast: { value: 1 },
    },
    vertexShader: QUAD_VS,
    fragmentShader: /* glsl */`
      uniform sampler2D uPrev;     // last step's field   (Feedback TOP input)
      uniform sampler2D uSignal;   // this step's row     (CHOP to TOP)
      uniform vec2  uTexel;
      uniform float uFlow;         // Translate: rows of history pushed back per step
      uniform float uStep;         // kernel sample step
      uniform float uK[9];         // 3×3 kernel (Weathering)
      uniform float uDecay;        // Memory: 2^(-1 / (60 · half-life))
      uniform float uGamma;
      uniform float uContrast;
      varying vec2 vUv;
      void main() {
        // 1 · Translate
        vec2 src = vUv - vec2(0.0, uTexel.y * uFlow);
        // 2 · Convolve
        float h = 0.0;
        int k = 0;
        for (int y = -1; y <= 1; y++) {
          for (int x = -1; x <= 1; x++) {
            h += uK[k] * texture2D(uPrev, src + vec2(float(x), float(y)) * uTexel * uStep).r;
            k++;
          }
        }
        // 3 · Level (part of the loop: compounds with the age of each row)
        h *= uDecay;
        h = (h - 0.5) * uContrast + 0.5;
        h = pow(max(h, 0.0), 1.0 / uGamma);
        h = min(h, 4.0);                     // safety ceiling
        // 4 · Composite the newest row at the front edge
        float sig = texture2D(uSignal, vec2(vUv.x, 0.5)).r;
        float front = step(vUv.y, uTexel.y * max(uFlow, 1.0));
        h = mix(h, sig, front);
        gl_FragColor = vec4(h, h, h, 1.0);
      }`,
  });
  const simScene = makeQuad(simMat);

  // ── Derived pass (D) ──────────────────────────────────────────────────────
  const derivMat = new THREE.ShaderMaterial({
    uniforms: { uH: { value: hA.texture }, uTexel: { value: texel }, uR: { value: 3 } },
    vertexShader: QUAD_VS,
    fragmentShader: /* glsl */`
      uniform sampler2D uH;
      uniform vec2 uTexel;
      uniform float uR;            // sampling radius in texels
      varying vec2 vUv;
      float s(float x, float y) { return texture2D(uH, vUv + vec2(x, y) * uTexel * uR).r; }
      void main() {
        float a = s(-1.,-1.), b = s(0.,-1.), c = s(1.,-1.);
        float d = s(-1., 0.), e = s(0., 0.), f = s(1., 0.);
        float g = s(-1., 1.), h = s(0., 1.), i = s(1., 1.);
        float smoothH = (a + c + g + i + 2.0 * (b + d + f + h) + 4.0 * e) / 16.0;
        // Sobel at radius R, scaled to field-height per uv unit
        float gx = ((c + 2.0 * f + i) - (a + 2.0 * d + g)) / (8.0 * uR * uTexel.x);
        float gy = ((g + 2.0 * h + i) - (a + 2.0 * b + c)) / (8.0 * uR * uTexel.y);
        float curv = (a + b + c + d + f + g + h + i) / 8.0 - e;   // < 0 on crests, > 0 in hollows
        gl_FragColor = vec4(smoothH, gx, gy, curv);
      }`,
  });
  const derivScene = makeQuad(derivMat);

  function buildKernel() {
    const gauss = [1, 2, 1, 2, 4, 2, 1, 2, 1].map(v => v / 16);
    for (let i = 0; i < 9; i++) kernel[i] = (i === 4 ? 1 : 0) * (1 - P.weathering) + gauss[i] * P.weathering;
    return kernel;
  }

  function applyParams() {
    const u = simMat.uniforms;
    u.uFlow.value = P.flow; u.uStep.value = P.step;
    u.uDecay.value = decayFor(P.memory);
    u.uGamma.value = P.gamma; u.uContrast.value = P.contrast;
    buildKernel();
  }

  const prevClear = new THREE.Color(); let prevAlpha = 0;
  function clearTargets(targets) {
    renderer.getClearColor(prevClear); prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const rt of targets) { renderer.setRenderTarget(rt); renderer.clear(true, false, false); }
    renderer.setRenderTarget(null);
    renderer.setClearColor(prevClear, prevAlpha);
  }

  const field = {
    hFormat: hFmt, dFormat: dFmt, kernel,
    get H() { return hA.texture; },          // newest canonical field
    get Hprev() { return hB.texture; },
    get D() { return d.texture; },
    applyParams,

    // One simulation step of the feedback loop.
    step() {
      simMat.uniforms.uPrev.value = hA.texture;
      renderer.setRenderTarget(hB);
      renderer.render(simScene, quadCam);
      renderer.setRenderTarget(null);
      [hA, hB] = [hB, hA];
    },

    // Once per display frame, after the steps: rebuild D from the newest H.
    derive(radius) {
      derivMat.uniforms.uH.value = hA.texture;
      derivMat.uniforms.uR.value = radius;
      renderer.setRenderTarget(d);
      renderer.render(derivScene, quadCam);
      renderer.setRenderTarget(null);
    },

    clear() { clearTargets([hA, hB, d]); },

    memoryReport() {
      const kib = b => (b / 1024).toFixed(0);
      return {
        H: `${hFmt.label} · 2 × ${N}×${N} · ${kib(2 * N * N * hFmt.bytes)} KiB`,
        D: `${dFmt.label} · ${N}×${N} · ${kib(N * N * dFmt.bytes)} KiB`,
      };
    },

    // Test hook: copy H into a float RGBA target and read it back (synchronous; never in the live loop).
    readSync() {
      const rt = new THREE.WebGLRenderTarget(N, N, { format: THREE.RGBAFormat, type: THREE.FloatType, depthBuffer: false });
      const m = new THREE.ShaderMaterial({ uniforms: { uT: { value: hA.texture } }, vertexShader: QUAD_VS,
        fragmentShader: `uniform sampler2D uT; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(uT, vUv).r); }` });
      renderer.setRenderTarget(rt); renderer.render(makeQuad(m), quadCam); renderer.setRenderTarget(null);
      const px = new Float32Array(N * N * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, N, N, px);
      rt.dispose(); m.dispose();
      const out = new Float32Array(N * N);
      for (let i = 0; i < N * N; i++) out[i] = px[i * 4];
      return out;
    },
  };
  applyParams();
  field.clear();
  return field;
}
