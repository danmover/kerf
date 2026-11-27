// Times Kerf on this computer's own graphics card: opens a design in a production build of the app, waits for its
// checks, makes edits, moves the view, and writes down how long each took and every time the page stopped.
//   node measure.cjs <url> <design.kerf> <out.json> [label]
// The build must have been hooked first (hook.cjs). On Windows it drives the installed Microsoft Edge in a window
// (Direct3D, like the desktop app); elsewhere a bundled Chromium with software graphics.
// playwright from beside this script, or from the folder the script is run in
const find = (name) => { try { return require(name); } catch { try { return require(require.resolve(name, { paths: [process.cwd()] })); } catch { return null; } } };
const pw = find('playwright-core') ?? find('playwright');
if (!pw) { console.error('playwright-core is not installed here: run this from a folder that has it (npm i playwright-core)'); process.exit(1); }
const { chromium } = pw;
const fs = require('fs');
const [url, file, outFile, label = ''] = process.argv.slice(2);
const WIN = process.platform === 'win32';
const ONE = ['cut box(42, 36, 5, at: (63, -66, -1), r: 6) as lighten_1', 'cut box(44, 36, 5, at: (63, -66, -1), r: 6) as lighten_1'];
(async () => {
  const src = fs.readFileSync(file, 'utf8');
  const launch = WIN
    ? { channel: 'msedge', headless: false, args: ['--ignore-gpu-blocklist', '--force_high_performance_gpu', '--window-size=1650,1040'] }
    : { args: process.env.NOGL ? ['--disable-gpu', '--disable-webgl', '--disable-webgl2', '--disable-3d-apis'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] };
  // PROFILE=<folder>: the browser keeps its files there between runs, so the second run has the shaders the first
  // one built (as the desktop app does after its first start). Without it every run starts from nothing.
  const kept = process.env.PROFILE;
  const browser = kept ? null : await chromium.launch(launch);
  const ctx = kept ? await chromium.launchPersistentContext(kept, { ...launch, viewport: { width: 1600, height: 900 } }) : await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx.addInitScript(() => {
    try { if (!localStorage.getItem('kerf.settings.v1')) localStorage.setItem('kerf.settings.v1', JSON.stringify({ onboarded: true, termsAccepted: '2026-10-draft-2' })); } catch {}
    // every stop of the page, and every call into the graphics card that waited, with the phase it happened in
    const M = (window.__m = { phase: 'load', longs: [], waits: [], links: 0, lost: 0 });
    try {
      for (const type of ['longtask', 'long-animation-frame'])
        new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration >= 50) M.longs.push([type === 'longtask' ? 't' : 'f', Math.round(e.startTime), Math.round(e.duration), M.phase]); }).observe({ type, buffered: true });
    } catch {}
    document.addEventListener('webglcontextlost', () => M.lost++, true);
    // when the view said it was waiting for the graphics card to build shaders, and for how long
    M.notice = [];
    let up = 0;
    setInterval(() => { const on = !!document.body && !!document.querySelector('[data-shaders-building]'); if (on && !up) up = performance.now(); if (!on && up) { M.notice.push([M.phase, Math.round(performance.now() - up)]); up = 0; } }, 100);
    if (typeof WebGL2RenderingContext === 'undefined') return;
    const P = WebGL2RenderingContext.prototype;
    const wrap = (name, note) => { const f = P[name]; P[name] = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { note(performance.now() - t, a); } }; };
    wrap('linkProgram', () => M.links++);
    for (const n of ['getProgramParameter', 'getShaderParameter', 'getProgramInfoLog', 'getUniformLocation', 'getActiveUniform', 'readPixels', 'getBufferSubData', 'clientWaitSync', 'getError', 'finish', 'checkFramebufferStatus', 'texImage2D', 'texImage3D', 'bufferData', 'drawElements', 'drawArrays'])
      wrap(n, (ms, a) => { if (ms >= 8) M.waits.push([M.phase, n === 'readPixels' ? (typeof a[6] === 'number' ? 'readPixels to a buffer' : 'readPixels to memory') : n, Math.round(ms)]); });
  });
  const page = kept ? (ctx.pages()[0] ?? (await ctx.newPage())) : await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
  page.on('crash', () => errs.push('PAGE CRASHED'));
  page.setDefaultTimeout(1_800_000);
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0 && window.__kerfDbg, null, { timeout: 180000 });
  const phase = (name) => page.evaluate((n) => { window.__m.phase = n; }, name);
  const out = { label, url, design: require('path').basename(file), when: new Date().toISOString(), cores: require('os').cpus().length, cpu: require('os').cpus()[0].model, phases: {} };
  out.gpu = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const ext = gl && gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'no webgl2'; });
  out.browser = (browser ?? ctx.browser())?.version() || (await page.evaluate(() => (/Edg\/[\d.]+|Chrome\/[\d.]+/.exec(navigator.userAgent) ?? [''])[0]));
  out.keptProfile = !!kept;
  // a kept profile opens the design it had open last: nothing may be running when the timing starts
  await page.evaluate(async () => { const { P } = window.__kerfDbg; if (P.useProject.getState().current) await P.closeProject(); });
  await page.waitForTimeout(1500);

  // waits for the checks, then for everything after them; says how long each took from `t0`
  const settle = () => page.evaluate(async () => {
    const { E, W } = window.__kerfDbg;
    const t0 = performance.now();
    const at = () => Math.round(performance.now() - t0);
    const r = {};
    await E.whenChecked(1_800_000); r.checkedAfterMs = at();
    await W.whenWiringChecked(E.useDesign.getState().model, 1_800_000);
    for (let i = 0; i < 6000; i++) { const rep = E.useDesign.getState().report; if (rep && !rep.items.some((x) => x.status === 'pending')) break; await new Promise((ok) => setTimeout(ok, 100)); }
    r.nothingPendingAfterMs = at();
    await E.whenRefined(1_800_000); r.refinedAfterMs = at();
    const s = E.useDesign.getState();
    r.timings = s.timings; r.counts = s.report && s.report.counts; r.buildErrors = Object.keys(s.buildErrors || {}).length;
    return r;
  });
  const edit = async (name, from, to) => {
    await phase(name);
    const r = await page.evaluate(async ([from, to]) => {
      const { E } = window.__kerfDbg;
      const s0 = E.useDesign.getState().source;
      if (!s0.includes(from)) return { error: 'edit text not found' };
      const t = performance.now();
      E.setSource(s0.replace(from, to));
      return { setSourceMs: Math.round(performance.now() - t) };
    }, [from, to]);
    if (r.error) return (out.phases[name] = r);
    out.phases[name] = { ...r, ...(await settle()) };
    await page.waitForTimeout(2500);
  };
  // frames while something moves: how long between one and the next
  const frames = async (name, move) => {
    await phase(name);
    await page.evaluate(() => { const F = (window.__frames = { on: true, gaps: [] }); let last = performance.now(); const f = () => { const n = performance.now(); F.gaps.push(n - last); last = n; if (F.on) requestAnimationFrame(f); }; requestAnimationFrame(f); });
    await move();
    out.phases[name] = await page.evaluate(() => { const F = window.__frames; F.on = false; const g = F.gaps.slice(1).sort((a, b) => a - b); const q = (p) => Math.round(g[Math.min(g.length - 1, Math.floor(g.length * p))] * 10) / 10; return { frames: g.length, medianMs: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), worstMs: q(1) }; });
  };

  // 1. open the design from cold
  await phase('open');
  await page.evaluate(async ([src]) => { const { P } = window.__kerfDbg; const p = await P.createProject('blank', 'measure', src); window.__project = p.id; await P.openProject(p.id); }, [src]);
  out.phases.open = await settle();
  await page.waitForTimeout(4000);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

  // 2. nothing happening
  await phase('idle');
  await page.waitForTimeout(5000);
  out.phases.idle = {};

  // 3. turning the view with the mouse
  const box = await page.evaluate(() => { const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? document.querySelector('.viewport') ?? document.body; const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; });
  await frames('orbit', async () => {
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    for (let i = 0; i < 240; i++) { await page.mouse.move(box.x + Math.sin(i / 20) * box.w * 0.25, box.y + Math.cos(i / 27) * box.h * 0.2); await page.waitForTimeout(12); }
    await page.mouse.up();
  });
  await page.waitForTimeout(2500);

  // 4. picking parts, x-ray and a section: each can need a shader the card has not built yet
  await phase('select');
  await page.evaluate(() => { const { E, View } = window.__kerfDbg; if (View) View.useView.setState({ selected: [(E.useDesign.getState().model.parts[3] ?? E.useDesign.getState().model.parts[0]).id] }); });
  await page.waitForTimeout(2500);
  out.phases.select = {};
  if (await page.evaluate(() => !!window.__kerfDbg.View)) {
    await phase('xray');
    await page.evaluate(() => window.__kerfDbg.View.useView.setState({ xray: true }));
    await page.waitForTimeout(3500);
    await page.evaluate(() => window.__kerfDbg.View.useView.setState({ xray: false, selected: [] }));
    await page.waitForTimeout(1500);
    out.phases.xray = {};
    await phase('section');
    await page.evaluate(() => window.__kerfDbg.View.useView.setState({ section: { on: true, axis: 'x', t: 0.5, flip: false } }));
    await page.waitForTimeout(4000);
    await frames('section orbit', async () => {
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      for (let i = 0; i < 120; i++) { await page.mouse.move(box.x + Math.sin(i / 20) * box.w * 0.2, box.y + Math.cos(i / 27) * box.h * 0.15); await page.waitForTimeout(12); }
      await page.mouse.up();
    });
    await page.evaluate(() => window.__kerfDbg.View.useView.setState({ section: { on: false, axis: 'x', t: 0.5, flip: false } }));
    await page.waitForTimeout(2500);
    out.phases.section = {};
  }

  // 5. edits: one part, the same edit undone (everything was worked out before), and one that rebuilds 14 parts
  if (src.includes(ONE[0])) {
    await edit('edit one part', ONE[0], ONE[1]);
    await edit('edit it back', ONE[1], ONE[0]);
  }
  const thigh = /(\n\s*param\s+thigh_l\s*=\s*)([-\d.]+)/.exec(src);
  if (thigh) await edit('edit 14 parts', thigh[0], thigh[1] + (Number(thigh[2]) + 2));

  // 6. turning the view while the checks of an edit run
  if (src.includes(ONE[0])) {
    await phase('orbit during checks');
    await page.evaluate(([from, to]) => { const { E } = window.__kerfDbg; E.setSource(E.useDesign.getState().source.replace(from, to)); }, [ONE[0], ONE[1].replace('44', '46')]);
    await frames('orbit during checks', async () => {
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      for (let i = 0; i < 300; i++) { await page.mouse.move(box.x + Math.sin(i / 20) * box.w * 0.25, box.y + Math.cos(i / 27) * box.h * 0.2); await page.waitForTimeout(12); }
      await page.mouse.up();
    });
    await settle();
    await page.waitForTimeout(2000);
  }

  await phase('end');
  const m = await page.evaluate(() => ({ m: window.__m, builds: window.__kerfDbg.Gate ? window.__kerfDbg.Gate.shaderBuilds : null, record: window.__kerfDbg.St && window.__kerfDbg.St.stallReport ? window.__kerfDbg.St.stallReport([]) : null }));
  // the page's stops, per phase: long tasks of 100 ms or more (a long frame and the task inside it count once)
  const stops = {};
  const tasks = m.m.longs.filter((l) => l[0] === 't' && l[2] >= 100);
  for (const [, , ms, ph] of tasks) { const s = (stops[ph] ??= { stops: 0, totalMs: 0, worstMs: 0 }); s.stops++; s.totalMs += ms; s.worstMs = Math.max(s.worstMs, ms); }
  const waits = {};
  for (const [ph, name, ms] of m.m.waits) { const w = ((waits[ph] ??= {})[name] ??= { times: 0, totalMs: 0, worstMs: 0 }); w.times++; w.totalMs += ms; w.worstMs = Math.max(w.worstMs, ms); }
  Object.assign(out, { stops, graphicsCardWaits: waits, notice: m.m.notice.length ? m.m.notice : undefined, shaderBuilds: m.builds, shaderLinks: m.m.links, contextLost: m.m.lost, errors: errs.slice(0, 20), freezeRecord: m.record, longs: m.m.longs });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  // a short account to read
  const p = out.phases;
  const line = (k) => p[k] && p[k].timings ? `${k}: checks ${Math.round(p[k].timings.checksMs)} ms, build ${Math.round(p[k].timings.buildMs)} ms, read ${Math.round(p[k].timings.evalMs)} ms; checked ${p[k].checkedAfterMs} ms after, all settled ${p[k].refinedAfterMs} ms after; counts ${JSON.stringify(p[k].counts)}` : `${k}: ${JSON.stringify(p[k])}`;
  console.log(`== ${label} ${out.design} on ${out.gpu} (${out.cores} threads, ${out.cpu}), ${out.browser}${kept ? ', kept profile' : ', fresh profile'}`);
  for (const k of ['open', 'edit one part', 'edit it back', 'edit 14 parts']) if (p[k]) console.log(line(k));
  for (const k of ['orbit', 'section orbit', 'orbit during checks']) if (p[k]) console.log(`${k}: ${JSON.stringify(p[k])}`);
  console.log('stops of 100 ms or more, by phase: ' + JSON.stringify(stops));
  console.log('graphics card waits of 8 ms or more, by phase: ' + JSON.stringify(waits));
  console.log(`shader links ${out.shaderLinks}${m.builds ? ` (${m.builds.ahead} handed to the card ahead, ${m.builds.late} met at a draw: ${JSON.stringify(m.builds.lateFor)})` : ''}, context lost ${out.contextLost}, errors ${JSON.stringify(out.errors)}`);
  if (m.builds && m.builds.waits) console.log(`waits for a shader build at a draw: ${Math.round(m.builds.waitedMs)} ms in all; the last of them: ${JSON.stringify(m.builds.waits)}`);
  if (out.notice) console.log(`the view said it was waiting for the graphics card: ${JSON.stringify(out.notice)} (phase, ms)`);
  if (m.record) console.log(m.record.split('\n').slice(0, 45).join('\n'));
  // leave nothing behind in a kept profile
  await page.evaluate(async () => { const { P } = window.__kerfDbg; try { await P.closeProject(); await P.deleteProject(window.__project); } catch {} }).catch(() => {});
  await ctx.close();
  if (browser) await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
