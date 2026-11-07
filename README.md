# Audio Geology 3JS

A geological instrument for visual music.

Sound becomes a field with memory, and the field becomes geology. This is **Audio Geology**, a TouchDesigner terrain system by Pixel Rhythms Labs, rebuilt for the browser in three.js with no build step.

**Study 02** keeps the solved core from study 01 (spectrum → 256 × 1 row → feedback field) and adds a render layer around it: three studies that read the same field in different ways, and an interface that shares their material.

| Study | What you see |
|---|---|
| **Strata** · mineral daylight | A cut specimen. Height contours are fixed to the field; deposit laminations travel with the rows, one per 0.25 s; the cut faces continue the same strata. |
| **Currents** · cobalt observatory | Up to 4,096 ribbons that follow a slope direction derived from the field, over a dark supporting surface. |
| **Sediment** · spectral specimen | 16,384 GPU-displaced grains, thin history slices at real ages, survey rulers in real Hz and seconds. One register carries spectral colour. |

Switching study never touches the field, the audio position or the camera.

## Run it

ES modules and the microphone need a local server:

```
npx http-server . -c-1
```

Then open http://127.0.0.1:8080. Study 01 is still on `main`.

## Signal → Filter → World

```
SIGNAL   source → spectrum → gain → lag → resample → Attention → 256 × 1 float row
FILTER   H: canonical feedback field, 256 × 256 float, stepped at a fixed 60 Hz
         D: derived field (smoothed height, ∂h/∂u, ∂h/∂v, curvature), rebuilt once per frame
WORLD    the active study reads H and D
```

| TouchDesigner | Here |
|---|---|
| Audio File In + spectrum | Web Audio `AnalyserNode` (`src/audio.js`) |
| Math, Lag, Resample CHOPs | `cookSignal()` in `src/signal.js` |
| CHOP to TOP | a 256 × 1 float `DataTexture` |
| Feedback TOP → Translate → Convolve → Level → Composite | `src/field.js`, one fragment shader, two targets swapped every step |
| Analyse / Slope TOPs | the derived pass in `src/field.js` |
| Grid SOP + displacement, Instancing, Point sprites | `src/world/strata.js`, `currents.js`, `sediment.js` |
| Custom parameters | the instrument edge and Inspect (Tweakpane) |
| Timeline at a fixed cook rate | `src/clock.js` |

## Controls

| Control | What it does | Range · default |
|---|---|---|
| **Memory** | nominal half-life of the feedback decay: `decay = 2^(−1 / (60 · halfLife))` per step | 0.25–12 s · 2.88 s (exactly study 01's 0.996) |
| **Weathering** | kernel blend, identity → 3 × 3 gaussian | 0–1 · 0.75 |
| **Relief** | displacement height | 0–5 · 2.4 |
| **Detail** | render-only, per study: Strata contour contrast + fine normals; Currents ribbon count + width; Sediment grain size + dust | 0–1 · 0.5 |
| **Light** | key-light azimuth at a fixed elevation | 0–359° · 215° |
| **Attention** | weights a frequency range before the field, with ⅓-octave tapers; shown on both monitors | full range |
| **Play / Pause** | file and world together; the test signal pauses its own clock | |
| **Hold** | freezes the field while audio and the signal monitor continue; Release resumes with no catch-up burst | |
| **Restart** | source to the start, clears H, D and smoothing; keeps camera and settings | |
| **Clear memory** (Inspect) | clears the field and smoothing without seeking | |
| **Survey / Detail / Score** | camera bookmarks; Score lays the history axis horizontally | |
| **Perform** | hides explanatory labels; source and transport stay | |

Inspect shows the exact parameters, the live mapping of the active study, actual texture formats, a draw/triangle readout, a 60-second frame-time capture, and preset export/import.

## Timing

Study 01 cooked once per display frame, so on a 120 Hz screen the field evolved twice as fast and its history window was half as long. Study 02 steps the field at a fixed 60 Hz. At most 4 steps run per display frame; a slower frame drops the extra steps instead of bursting to catch up. The canonical field after 360 steps is bit-identical at 30, 60 and 120 Hz displays (see `tools/`).

## Performance

Budgets, not measurements: the canonical field stays 256 × 256; Strata draws about 132 k triangles, Currents about 65 k at Detail 0.5, Sediment 16,384 points. A normal frame is 5–6 draw calls including the feedback, derived and preview passes. The drawing buffer is capped by a pixel budget (Light 1 MP, Balanced 2 MP, High 3.5 MP; Inspect → Render). Measure frame times on your own device with Inspect → **Measure 60 s**.

## Tools

`tools/` holds the headless checks used for this study (Python + Playwright, a fake clock, software WebGL): timing invariance, overload policy, study-switch continuity, transport states, and fixed-excerpt captures. See `tools/README.md`.

## Built with

- [three.js](https://threejs.org) 0.186.0
- [three-custom-shader-material](https://github.com/FarazzShaikh/THREE-CustomShaderMaterial) 6.4.0 (vanilla build)
- [Tweakpane](https://tweakpane.github.io/docs/) 4.0.5

All three load from jsDelivr through the import map in `index.html`.

## License

MIT. See [LICENSE](LICENSE).

---

Part of Audio Geology, a [Pixel Rhythms Labs](https://github.com/kprasad1221) project.
