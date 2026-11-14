import * as THREE from 'three';
import { Score, SCORE_DEFAULTS } from '../shared/score.js';
import { RAMP_SIZE, bakeRows, sanitizePalette, toSRGB8 } from '../shared/palette.js';
import court from '../../palettes/stellar-tide-court.take-a.json' with { type: 'json' };

export const CURRENT_LOOKS = ['original', 'palette', 'counterpoint'];
export const scoreTempo = value => Number.isFinite(value) ? Math.max(40, Math.min(240, value)) : 120;

export function currentRamps() {
  const { ramps } = sanitizePalette(court).palette;
  const rows = [ramps.water.stops, ramps.filament.stops, ramps.inlay.stops];
  const tex = new THREE.DataTexture(toSRGB8(bakeRows(rows)), RAMP_SIZE, rows.length);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// The two gestures use the same envelope in beats. Each ends before its next call.
const travel = 1.6, rise = 0.22, crest = 0.22, release = 0.70;
export const currentEnvelope = /* glsl */`
  float packet(float ageBeats, float distanceAlongRoute) {
    float t = ageBeats - ${travel.toFixed(2)} * distanceAlongRoute;
    return smoothstep(0.0, ${rise.toFixed(2)}, t)
      * (1.0 - smoothstep(${(rise + crest).toFixed(2)}, ${(rise + crest + release).toFixed(2)}, t));
  }`;

export function createCurrentScore() {
  const settings = structuredClone(SCORE_DEFAULTS);
  Object.assign(settings, { on: true, routes: 1 });
  Object.assign(settings.call, { audio: 1 });
  settings.reply.gain = 0.85;
  const score = new Score(settings);
  const gesture = new THREE.Vector4(-10, 0, -10, 0);
  let tempo = null, micTime = 0;

  function reset() {
    score.reset();
    gesture.set(-10, 0, -10, 0);
    micTime = 0;
  }

  function advance(sourceTime, dt, bpm, bands, gains) {
    if (tempo !== bpm) {
      tempo = bpm;
      settings.bpm = bpm;
      const beat = 60 / bpm;
      for (const g of [settings.call, settings.reply]) {
        Object.assign(g, { travel: travel * beat, rise: rise * beat, crest: crest * beat, release: release * beat });
      }
      settings.reply.delay = beat;
      score.reset();
    }
    micTime += dt;
    const t = sourceTime ?? micTime;
    // The existing low voices set the call's strength at its start. The reply inherits it.
    let energy = 0;
    for (let i = 0; i < 3; i++) {
      energy = Math.max(energy, gains[i] * (0.65 * bands.level[i] + 0.35 * bands.raw[i]));
    }
    score.advance(t, Math.sqrt(Math.min(1, energy)));
    gesture.set(-10, 0, -10, 0);
    for (const g of score.instances) {
      if (g.n < 0 || t < g.start) continue;
      const offset = g.kind === 'call' ? 0 : 2;
      gesture.setComponent(offset, (t - g.start) * bpm / 60);
      gesture.setComponent(offset + 1, g.strength);
    }
  }
  return { gesture, advance, reset };
}
