// ─────────────────────────────────────────────────────────────────────────────
//  Sources: the built-in test signal, a local audio file, or the microphone.
//
//  Only one source is live at a time. Changing source stops and disconnects the
//  previous node or stream. The microphone is requested only when its button is
//  pressed. Audio files are decoded locally and never leave the page.
// ─────────────────────────────────────────────────────────────────────────────
import { BINS, FFT_SIZE } from './params.js';

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

export class Sources {
  constructor() {
    this.ctx = null; this.analyser = null;
    this.mode = 'test';              // 'test' | 'file' | 'mic'
    this.node = null; this.stream = null;
    this.buffer = null; this.fileName = '';
    this.filePlaying = false; this.offset = 0; this.startAt = 0;
    this.testTime = 0;               // source clock of the test signal (advances with the simulation)
    this.db = new Float32Array(BINS);
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

  ensureContext() {
    if (this.ctx) return this.ctx;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;    // the Lag stage does the smoothing, where you can see it
    analyser.minDecibels = -100; analyser.maxDecibels = -20;
    this.ctx = ctx; this.analyser = analyser;
    return ctx;
  }

  // Fill `bins` with the current spectrum, normalised 0..1.
  read(bins) {
    if (this.mode === 'test' || !this.analyser) { testSpectrum(this.testTime, bins); return; }
    this.analyser.getFloatFrequencyData(this.db);
    const lo = this.analyser.minDecibels, hi = this.analyser.maxDecibels;
    for (let i = 0; i < BINS; i++) bins[i] = Math.max(0, (this.db[i] - lo) / (hi - lo));
  }

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
