# Headless checks

Python + Playwright scripts that drive the app with a fake clock and software WebGL (SwiftShader). They are evidence for the study's behaviour, not performance measurements: SwiftShader frame times say nothing about a real GPU. Use Inspect → **Measure 60 s** in a normal browser for that.

```
cd tools
npm install                       # local three / CSM / tweakpane for the import map
pip install playwright numpy pillow && playwright install chromium
python verify.py                  # timing invariance, overload, continuity, transport, counts → captures/verify.json
python capture.py strata currents:survey:orderly currents:survey:eddies currents:survey:sparse sediment
python capture.py views           # Inspect overlay, Score bookmark, 1280×720, 820×1180, 390×844
```

Every capture uses the same excerpt: Restart, then 360 simulation steps (6 s) of the built-in test signal, then one rendered frame with the field paused. Shot names are `study:camera:treatment`.

Set `AG_CHROME=/path/to/chrome` to use a system Chrome, `AG_OUT` to change the output folder.

`verify.py` checks:

1. **Timing.** The canonical field and the voice record after 360 steps at 30, 60 and 120 Hz display schedules, compared with direct stepping (expected: identical).
2. **Overload.** 30 frames at 10 Hz: each wants 6 steps, 4 run, 2 are dropped.
3. **Continuity.** Switching Strata → Currents → Sediment → Strata leaves the field, the source position and the camera unchanged.
4. **Transport.** Pause, Hold/Release, Restart, Clear memory, a denied microphone, a local WAV file, and back to the test signal.
5. **Counts.** Draw calls, triangles and points per frame for each study.
