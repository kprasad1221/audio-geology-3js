# Audio Geology 3JS

A ferrofluid terrain that grows from sound.

This is the Ferrofluid terrain law from **Audio Geology**, a TouchDesigner terrain system, rebuilt in three.js as one HTML file with no build step.

An audio spectrum is written into a 32-bit float texture one row at a time. A feedback loop pushes the field back by a row each frame, blurs it with a 3×3 kernel and runs it through a level stage. A 256 × 256 grid is displaced by that field, takes its normals from it, and is lit with a PBR material.

Depth on the terrain is age. The front row is this frame's signal. Each row further back has been through the kernel one more time, so older terrain is smoother and lower.

## Run it

ES modules and the microphone need a local server, not a double-clicked file:

```
npx http-server . -c-1
```

Then open http://127.0.0.1:8080.

There are three signal sources:

- **Test signal**: a silent built-in spectrum (a kick at 120 BPM, a drifting tone, off-beat hats). It is on by default.
- **Audio file**: any MP3, WAV or M4A. It loops.
- **Microphone**: works when the page is served from localhost.

Drag to orbit. Scroll or pinch to zoom.

## Signal → Filter → World

Each stage of the TouchDesigner network maps to a part of `index.html`:

| TouchDesigner | In `index.html` |
|---|---|
| Audio File In + spectrum | Web Audio `AnalyserNode`, which also sums stereo to mono |
| Math, Lag, Resample CHOPs | `cookSignal()`, plain JS over a `Float32Array` |
| CHOP to TOP | a 256 × 1 float `DataTexture`, re-uploaded every frame |
| Feedback TOP | two float render targets, swapped every frame (`cookFeedback()`) |
| Translate → Blur/Convolve → Level → Composite | one fragment shader, four commented steps |
| Grid SOP + displacement | a 256 × 256 `PlaneGeometry` moved in the vertex shader |
| GLSL in a PBR MAT | `three-custom-shader-material` on `MeshStandardMaterial` |
| Environment Light | `RoomEnvironment` through `PMREMGenerator` |
| Custom parameters | Tweakpane |
| The network cooking each frame | `animate()`, which calls Signal, then Filter, then World |

The two readouts at the bottom left show the signal row and the live feedback field, next to the terrain they produce.

## Parameters

| Group | Parameter | What it does |
|---|---|---|
| Signal | gain | scales the spectrum before it enters the field |
| | lag | one-pole smoothing per bin; higher is slower and calmer |
| | lin → log | how 512 bins are spread across 256 columns; log gives each octave equal width |
| Filter | translate | rows of history pushed back per frame; 0 holds the field in place |
| | blur | mixes the kernel from identity to a 3×3 gaussian |
| | sample step | spacing between kernel taps; larger steps give banding |
| | brightness | how much of the field survives each frame |
| | gamma, contrast | the rest of the level stage, applied every frame, so their effect compounds with age |
| World | height | displacement scale |
| | metal | metalness and gloss together; high values read as ferrofluid |
| | wireframe | shows the grid; one vertex per field pixel |

## Built with

- [three.js](https://threejs.org) 0.186.0
- [three-custom-shader-material](https://github.com/FarazzShaikh/THREE-CustomShaderMaterial) 6.4.0 (vanilla build)
- [Tweakpane](https://tweakpane.github.io/docs/) 4.0.5

All three load from jsDelivr through an import map in `index.html`.

## License

MIT. See [LICENSE](LICENSE).

---

Part of Audio Geology, a [Pixel Rhythms Labs](https://github.com/kprasad1221) project.
