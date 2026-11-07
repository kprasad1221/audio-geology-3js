"""Behaviour checks for Study 02, run headless with a fake clock.
1. Timing invariance: the canonical field after 360 simulation steps is compared across
   30 / 60 / 120 Hz display schedules and against direct stepping.
2. Overload policy at a 10 Hz display.
3. Continuity: switching study mid-run leaves H, source position and camera untouched.
4. Transport: Pause, Hold/Release, Restart, Clear memory, denied microphone, local file.
5. Counts: draws, triangles, points per study."""
import asyncio, sys, json, wave, struct, math
import numpy as np
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import *
from capture import open_app, settle

RESULTS = {}

async def field(page):
    return np.array(await page.evaluate("() => Array.from(window.__ag.readField())"), dtype=np.float64)

async def voices(page):
    return np.array(await page.evaluate("() => Array.from(window.__ag.bands.hist)"), dtype=np.float64)

async def run_schedule(page, hz, steps=360):
    await page.evaluate("""() => { const a = window.__ag; a.hooks.renderWorld = false; a.state.running = true; a.state.held = false; a.restart(); }""")
    s0 = await page.evaluate("window.__ag.simSteps()")
    frames = 0
    while True:
        s = await page.evaluate("window.__ag.simSteps()")
        if s - s0 >= steps: break
        await page.evaluate(f"window.__fake.step({1000.0 / hz})")
        frames += 1
    s = await page.evaluate("window.__ag.simSteps()")
    return s - s0, frames

def make_wav(path, seconds=3.0, sr=44100):
    with wave.open(path, 'w') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        frames = b''.join(struct.pack('<h', int(9000 * (math.sin(2 * math.pi * 220 * t / sr) + 0.5 * math.sin(2 * math.pi * 1760 * t / sr))))
                          for t in range(int(seconds * sr)))
        w.writeframes(frames)

async def main():
    async with async_playwright() as p:
        b = await launch(p)
        page, logs, ok = await open_app(b, 1280, 800)
        assert ok, logs

        # ── 1 · timing invariance ────────────────────────────────────────────
        await page.evaluate("() => { const a = window.__ag; a.state.running = false; a.restart(); a.stepSim(360); }")
        ref = await field(page); vref = await voices(page)
        out = {}
        for hz in (30, 60, 120):
            steps, frames = await run_schedule(page, hz)
            f = await field(page); v = await voices(page)
            out[f'{hz} Hz'] = {'frames': frames, 'steps': steps, 'max_abs_diff_vs_direct': float(np.abs(f - ref).max()),
                               'voice_record_max_abs_diff': float(np.abs(v - vref).max()), 'field_max': float(f.max())}
        RESULTS['timing'] = out

        # ── 2 · overload: 10 Hz display (100 ms frames want 6 steps; cap is 4) ─
        await page.evaluate("() => { const a = window.__ag; a.state.running = true; a.restart(); }")
        s0 = await page.evaluate("window.__ag.simSteps()"); d0 = await page.evaluate("window.__ag.dropped()")
        for _ in range(30): await page.evaluate("window.__fake.step(100)")
        s1 = await page.evaluate("window.__ag.simSteps()"); d1 = await page.evaluate("window.__ag.dropped()")
        RESULTS['overload_10Hz_30frames'] = {'steps': s1 - s0, 'dropped': d1 - d0, 'wanted': 30 * 6}

        # ── 3 · continuity across study switches ─────────────────────────────
        await page.evaluate("() => { const a = window.__ag; a.hooks.renderWorld = true; a.state.running = false; a.setStudy('strata'); a.restart(); a.stepSim(240); a.goTo('detail'); }")
        await settle(page, 1)
        before = await field(page); vbefore = await voices(page)
        cam0 = await page.evaluate("() => window.__ag.stage.camera.position.toArray()")
        t0 = await page.evaluate("window.__ag.sources.position()")
        for st in ('currents', 'sediment', 'strata'):
            await page.evaluate(f"window.__ag.setStudy('{st}')"); await settle(page, 1)
        after = await field(page)
        cam1 = await page.evaluate("() => window.__ag.stage.camera.position.toArray()")
        t1 = await page.evaluate("window.__ag.sources.position()")
        RESULTS['continuity'] = {'field_max_abs_diff': float(np.abs(after - before).max()),
                                 'voice_record_max_abs_diff': float(np.abs(await voices(page) - vbefore).max()),
                                 'camera_moved': float(np.abs(np.array(cam1) - np.array(cam0)).max()),
                                 'source_time_before_after': [t0, t1]}

        # ── 4 · transport ───────────────────────────────────────────────────
        tr = {}
        await page.evaluate("() => { const a = window.__ag; a.state.running = true; a.restart(); }")
        for _ in range(60): await page.evaluate("window.__fake.step(1000/60)")
        await page.click('#playBtn')                                    # pause
        st = await page.evaluate("window.__ag.simSteps()")
        f_paused = await field(page)
        for _ in range(30): await page.evaluate("window.__fake.step(1000/60)")
        tr['pause'] = {'steps_while_paused': await page.evaluate("window.__ag.simSteps()") - st,
                       'field_changed': float(np.abs(await field(page) - f_paused).max()),
                       'button': await page.text_content('#playTxt')}
        await page.click('#playBtn')                                    # play
        await page.click('#holdBtn')                                    # hold
        f_hold = await field(page); v_hold = await voices(page); t_hold = await page.evaluate("window.__ag.sources.position()")
        for _ in range(30): await page.evaluate("window.__fake.step(1000/60)")
        tr['hold'] = {'field_changed': float(np.abs(await field(page) - f_hold).max()),
                      'voice_record_changed': float(np.abs(await voices(page) - v_hold).max()),
                      'live_meter_moving': await page.evaluate("() => Array.from(window.__ag.bands.level).some(x => x > 0)"),
                      'source_advanced_s': round(await page.evaluate("window.__ag.sources.position()") - t_hold, 4),
                      'button': await page.text_content('#holdTxt'), 'pressed': await page.get_attribute('#holdBtn', 'aria-pressed')}
        s_rel = await page.evaluate("window.__ag.simSteps()")
        await page.click('#holdBtn')                                    # release
        await page.evaluate("window.__fake.step(1000/60)")
        tr['release'] = {'steps_on_first_frame': await page.evaluate("window.__ag.simSteps()") - s_rel}
        await page.click('#restartBtn')
        tr['restart'] = {'field_max_after': float((await field(page)).max()), 'voice_record_max_after': float((await voices(page)).max()),
                         'source_time': await page.evaluate("window.__ag.sources.position()"),
                         'status': await page.text_content('#status')}
        for _ in range(30): await page.evaluate("window.__fake.step(1000/60)")
        t_c = await page.evaluate("window.__ag.sources.position()")
        await page.evaluate("window.__ag.setInspect(true)")
        await page.click('#clearBtn')
        tr['clear_memory'] = {'field_max_after': float((await field(page)).max()),
                              'source_kept_position': await page.evaluate("window.__ag.sources.position()") == t_c}
        await page.evaluate("window.__ag.setInspect(false)")
        # microphone: headless has no permission → denied path
        await page.click('#srcMic'); await page.wait_for_timeout(800)
        tr['mic_denied'] = {'mode': await page.evaluate("window.__ag.sources.mode"),
                            'test_pressed': await page.get_attribute('#srcTest', 'aria-pressed'),
                            'status': await page.text_content('#status')}
        # local audio file
        wav = os.path.join(OUT, 'tone.wav'); make_wav(wav)
        await page.set_input_files('#fileInput', wav); await page.wait_for_timeout(1500)
        for _ in range(5): await page.evaluate("window.__fake.step(1000/60)")
        tr['file'] = {'mode': await page.evaluate("window.__ag.sources.mode"),
                      'file_pressed': await page.get_attribute('#srcFile', 'aria-pressed'),
                      'playing': await page.evaluate("window.__ag.sources.filePlaying"),
                      'status': await page.text_content('#status')}
        await page.click('#playBtn')
        tr['file_pause'] = {'playing': await page.evaluate("window.__ag.sources.filePlaying"), 'button': await page.text_content('#playTxt')}
        await page.click('#srcTest')
        tr['back_to_test'] = {'mode': await page.evaluate("window.__ag.sources.mode"), 'playing_file': await page.evaluate("window.__ag.sources.filePlaying")}
        RESULTS['transport'] = tr

        # ── 5 · counts per study (one rendered frame each) ───────────────────
        counts = {}
        await page.evaluate("() => { const a = window.__ag; a.state.running = false; a.restart(); a.stepSim(360); a.goTo('survey'); }")
        for st in ('strata', 'currents', 'sediment'):
            await page.evaluate(f"window.__ag.setStudy('{st}')")
            await page.evaluate("window.__fake.step(1000/60)")
            await page.evaluate("() => { window.__ag.state.running = false; }")
            await page.evaluate("window.__fake.step(1000/60)")
            counts[st] = await page.evaluate("() => { const s = window.__ag.stats; return { draws: s.calls, triangles: s.triangles, points: s.points, canvas: s.cw + 'x' + s.ch }; }")
        RESULTS['counts_per_frame_paused'] = counts
        running = {}
        for st in ('strata', 'currents', 'sediment'):
            await page.evaluate(f"() => {{ const a = window.__ag; a.setStudy('{st}'); a.state.running = true; }}")
            await page.evaluate("window.__fake.step(1000/60)")
            await page.wait_for_timeout(100)
            await page.evaluate("window.__fake.step(1000/60)")
            running[st] = await page.evaluate("() => { const s = window.__ag.stats; return { draws: s.calls, triangles: s.triangles, points: s.points }; }")
        RESULTS['counts_per_frame_running'] = running
        errs = [l for l in logs if ('error' in l.lower() and 'GPU stall' not in l)]
        RESULTS['console_errors'] = errs[:10]
        print(json.dumps(RESULTS, indent=1)); json.dump(RESULTS, open(os.path.join(OUT, 'verify.json'), 'w'), indent=1)
        await b.close()

asyncio.run(main())
