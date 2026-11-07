// ─────────────────────────────────────────────────────────────────────────────
//  Sources: the built-in test signal, a local audio file, or the microphone.
//
//  Only one source is live at a time. Changing source stops and disconnects the
//  previous node or stream. The microphone is requested only when its button is
//  pressed. Audio files are decoded locally and never leave the page.
// ─────────────────────────────────────────────────────────────────────────────
import { BINS, FFT_SIZE, P } from './params.js';

export const LOW_FFT_SIZE = 4096;   // second analyser for the four lowest voices: 11.7 Hz bins at 48 kHz

// Built-in test signal (unchanged from study 01): a kick at 120 BPM, a drifting
// tone and off-beat hats, as a function of source time t in seconds.
export function testSpectrum(t, bins) {
  const beat = (t * 2) % 1;
  const kick = Math.exp(-beat * 7);
  const hat = Math.exp(-((t * 2 + 0.5) % 1) * 18);
  const tone = 60 + 40 * Math.sin(t * 0.35) + 18 * Math.sin(t * 1.3);
  for (let i = 0; i < BINS; i++) {
    const kickBand = kick * 0.95 * Math.exp(-((i - 3) ** 2) / 10);
    const toneBand = 0.55 * Math.exp(-((i - tone) ** 2) / 30) + 0.3 * Math.exp(-((i - tone * 2) ** 2) / 60);
    const hatBand = hat * 0.35 * Math.exp(-((i - 300) ** 2) / 4000);
    const floor = 0.06 * (0.5 + 0.5 * Math.sin(i * 0.7 + t * 3.1)) * Math.exp(-i / 200);
    bins[i] = kickBand + toneBand + hatBand + floor;
  }
}

// Polyrhythm test signal: eight voices, one per band, each on its own cycle at
// 120 BPM (beat = 0.5 s). Bin numbers assume 46.875 Hz bins (48 kHz, fftSize 1024).
//   sub        45 Hz   a slow swell, 8 s
//   bass      117 Hz   kick on every beat              (period 0.5 s)
//   low mid   280 Hz   dotted-eighth pluck             (0.375 s → 4 against 3)
//   mid       650 Hz   three across two beats          (0.333 s → 3 against 2)
//   upper mid 1.7 kHz  clap on beats 2 and 4           (1 s, offset 0.5 s)
//   presence  3.8 kHz  five across four beats          (0.4 s → 5 against 4)
//   brilliance 7.5 kHz sixteenths, accent every fourth (0.125 s)
//   air        13 kHz  seven across four beats         (0.286 s → 7 against 4)
const POLY = [
  { c: 1,   w: 0.7, amp: 0.6,  period: 8,     offset: 0,    decay: 0,  swell: true },
  { c: 2.5, w: 0.7, amp: 0.95, period: 0.5,   offset: 0,    decay: 9 },
  { c: 6,   w: 1.2, amp: 0.65, period: 0.375, offset: 0,    decay: 10 },
  { c: 14,  w: 3,   amp: 0.55, period: 1 / 3, offset: 0.02, decay: 8 },
  { c: 36,  w: 10,  amp: 0.7,  period: 1,     offset: 0.5,  decay: 14 },
  { c: 80,  w: 12,  amp: 0.5,  period: 0.4,   offset: 0.05, decay: 12 },
  { c: 160, w: 30,  amp: 0.3,  period: 0.125, offset: 0,    decay: 30, accent: 4 },
  { c: 280, w: 40,  amp: 0.38, period: 2 / 7, offset: 0.1,  decay: 22 },
];
const env = (t, v) => {
  if (v.swell) return 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / v.period);
  const x = t - v.offset;
  if (x < 0) return 0;
  const n = Math.floor(x / v.period), ph = x - n * v.period;
  return Math.exp(-ph * v.decay) * (v.accent && n % v.accent === 0 ? 1.6 : 1);
};
export function polySpectrum(t, bins) {
  const drift = 2 * Math.sin(t * 0.4);     // the mid voice wanders a little in pitch
  const e = POLY.map(v => env(t, v) * v.amp);
  for (let i = 0; i < BINS; i++) {
    let s = 0.04 * (0.5 + 0.5 * Math.sin(i * 0.7 + t * 3.1)) * Math.exp(-i / 200);
    for (let k = 0; k < POLY.length; k++) {
      const v = POLY[k], c = k === 3 ? v.c + drift : v.c;
      const d = i - c;
      if (Math.abs(d) > v.w * 4) continue;
      s += e[k] * Math.exp(-(d * d) / (2 * v.w * v.w));
    }
    bins[i] = s;
  }
}

export class Sources {
  constructor() {
    this.ctx = null; this.analyser = null;
    this.mode = 'test';              // 'test' | 'file' | 'mic'
    this.node = null; this.stream = null;
    this.buffer = null; this.fileName = '';
    this.filePlaying = false; this.offset = 0; this.startAt = 0;
    this.testTime = 0;               // source clock of the test signal (advances with the simulation)
    this.db = new Float32Array(BINS);
    this.lowAnalyser = null; this.dbLow = new Float32Array(LOW_FFT_SIZE / 2);
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

  ensureContext() {
    if (this.ctx) return this.ctx;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;    // the Lag stage does the smoothing, where you can see it
    analyser.minDecibels = -100; analyser.maxDecibels = -20;
    // A second, longer analysis for the low voices (finer pitch, slower timing).
    // AnalyserNodes pass audio through, so it simply listens to the first one.
    const low = ctx.createAnalyser();
    low.fftSize = LOW_FFT_SIZE; low.smoothingTimeConstant = 0;
    low.minDecibels = analyser.minDecibels; low.maxDecibels = analyser.maxDecibels;
    analyser.connect(low);
    this.ctx = ctx; this.analyser = analyser; this.lowAnalyser = low;
    return ctx;
  }

  // Fill `bins` with the current spectrum, normalised 0..1.
  read(bins) {
    if (this.mode === 'test' || !this.analyser) { (P.testSignal === 'pulse' ? testSpectrum : polySpectrum)(this.testTime, bins); return; }
    this.analyser.getFloatFrequencyData(this.db);
    const lo = this.analyser.minDecibels, hi = this.analyser.maxDecibels;
    for (let i = 0; i < BINS; i++) bins[i] = Math.max(0, (this.db[i] - lo) / (hi - lo));
  }

  // The long analysis, normalised 0..1. Returns false for the test signal (no real audio).
  readLow(out) {
    if (this.mode === 'test' || !this.lowAnalyser) return false;
    this.lowAnalyser.getFloatFrequencyData(this.dbLow);
    const lo = this.lowAnalyser.minDecibels, hi = this.lowAnalyser.maxDecibels;
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, (this.dbLow[i] - lo) / (hi - lo));
    return true;
  }
  get lowBinHz() { return this.sampleRate / LOW_FFT_SIZE; }

  // Called once per simulation step while the source is running.
  advance(dt) { if (this.mode === 'test') this.testTime += dt; }

  position() {
    if (this.mode === 'test') return this.testTime;
    if (this.mode === 'file' && this.buffer) {
      const p = this.filePlaying ? this.ctx.currentTime - this.startAt : this.offset;
      return p % this.buffer.duration;
    }
    return null;
  }

  stopNode() {
    if (this.node) { try { this.node.stop?.(); } catch (e) {} this.node.disconnect(); this.node = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.filePlaying = false;
  }

  useTest() { this.stopNode(); this.mode = 'test'; }

  async useFile(file) {
    const ctx = this.ensureContext(); await ctx.resume();
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    this.stopNode();
    this.buffer = buffer; this.fileName = file.name; this.offset = 0;
    this.mode = 'file';
    return buffer;
  }

  async useMic() {
    const ctx = this.ensureContext(); await ctx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.stopNode();
    this.stream = stream;
    this.node = ctx.createMediaStreamSource(stream);
    this.node.connect(this.analyser);      // not to the speakers: no feedback howl
    this.mode = 'mic';
  }

  // Transport hooks. The test signal and microphone have no audio to start or stop;
  // the world's run/pause state lives in main.js.
  play() {
    if (this.mode !== 'file' || !this.buffer || this.filePlaying) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer; src.loop = true;
    src.connect(this.analyser); this.analyser.connect(ctx.destination);
    src.start(0, this.offset % this.buffer.duration);
    this.startAt = ctx.currentTime - this.offset; this.node = src; this.filePlaying = true;
  }
  pause() {
    if (this.mode !== 'file' || !this.filePlaying) return;
    this.offset = this.ctx.currentTime - this.startAt;
    this.stopNode();
  }
  seekStart() {
    this.testTime = 0;
    if (this.mode === 'file') {
      const wasPlaying = this.filePlaying;
      this.stopNode(); this.offset = 0;
      if (wasPlaying) this.play();
    }
  }
}
