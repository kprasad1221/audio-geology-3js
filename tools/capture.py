"""Capture Study 02 at a fixed excerpt: Restart, step the 60 Hz simulation N times
with the built-in test signal, then render one frame without advancing the field."""
import asyncio, sys, json, time
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import *

async def settle(page, frames=2):
    for _ in range(frames):
        await page.evaluate('window.__fake.step(16.6667)')
    await page.wait_for_timeout(250)

async def prepare(page, steps=360, study='strata', cam='survey', setup=None):
    await page.evaluate(f"""() => {{ const a = window.__ag; a.state.running = false; a.setStudy('{study}');
      {setup or ''}
      a.restart(); a.stepSim({steps}); a.goTo('{cam}'); }}""")
    await settle(page)

async def open_app(browser, w, h, dpr=1, url='/index.html'):
    page, logs = await new_page(browser, w, h, dpr=dpr)
    base = serve()
    await page.goto(base + url)
    await page.wait_for_timeout(1200)
    await page.evaluate('window.__fake.step(16.6667)')
    await page.wait_for_timeout(300)
    ok = await page.evaluate('!!window.__ag')
    return page, logs, ok

async def main():
    shots = sys.argv[1:] or ['strata']
    async with async_playwright() as p:
        b = await launch(p)
        page, logs, ok = await open_app(b, 1440, 900)
        print('app ok:', ok)
        if not ok:
            print('\n'.join(logs)); await b.close(); return
        for name in shots:
            parts = name.split(':'); study = parts[0]; cam = parts[1] if len(parts) > 1 else 'survey'; treat = parts[2] if len(parts) > 2 else ''
            t0 = time.time()
            setup = f"a.applyTreatment('{treat}'); a.onParams();" if treat else ("a.applyTreatment('orderly'); a.onParams();" if study == 'currents' else '')
            await prepare(page, 360, study, cam, setup)
            out = os.path.join(OUT, f'{study}_{cam}{"_" + treat if treat else ""}_1440x900.png')
            await page.screenshot(path=out)
            print('saved', out, round(time.time() - t0, 1), 's')
        print('\n'.join(l for l in logs if 'GPU stall' not in l)[-3000:])
        await b.close()

async def views():
    """Inspect overlay, Score bookmark, other viewports."""
    async with async_playwright() as p:
        b = await launch(p)
        page, logs, ok = await open_app(b, 1440, 900)
        await prepare(page, 360, 'currents', 'survey')
        await page.evaluate("window.__ag.setInspect(true)"); await settle(page)
        await page.screenshot(path=os.path.join(OUT, 'currents_inspect_1440x900.png'))
        await page.evaluate("window.__ag.setInspect(false)")
        await prepare(page, 360, 'strata', 'score')
        await page.screenshot(path=os.path.join(OUT, 'strata_score_1440x900.png'))
        await page.close()
        for (w, h, name) in [(1280, 720, 'strata'), (820, 1180, 'sediment'), (390, 844, 'strata')]:
            page, logs, ok = await open_app(b, w, h)
            await prepare(page, 360, name, 'survey')
            await page.screenshot(path=os.path.join(OUT, f'{name}_survey_{w}x{h}.png'), full_page=(w < 600))
            await page.close()
        print('\n'.join(l for l in logs if 'GPU stall' not in l)[-2000:])
        await b.close()

if __name__ == "__main__":
    asyncio.run(views() if sys.argv[1:] == ['views'] else main())
