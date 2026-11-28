// What the parts' shader costs this computer's graphics card to build, and which of its pieces the time goes on.
//   node shadercost.cjs <url> <design.kerf> <out.json>
// Opens the design in a hooked production build (see README.md) and keeps the text of every large shader the view
// asks the card for. Then, in a page of its own with nothing else going on, it has the card build the parts' shader
// again and again, one at a time: as it is, and with one piece of Kerf's additions taken out each time. The time a
// build loses when a piece is gone is what that piece costs. Every text has a value of its own name in it, so no
// build is answered from the browser's store of built shaders (a comment would not do: the store goes by the text
// once its comments are gone).
const find = (name) => { try { return require(name); } catch { try { return require(require.resolve(name, { paths: [process.cwd()] })); } catch { return null; } } };
const pw = find('playwright-core') ?? find('playwright');
if (!pw) { console.error('playwright-core is not installed here: run this from a folder that has it (npm i playwright-core)'); process.exit(1); }
const { chromium } = pw;
const fs = require('fs');
const [url, file, outFile] = process.argv.slice(2);
const WIN = process.platform === 'win32';

/** Where the function `name` starts and ends in a shader's text: [start of its first line, end of its closing brace]. */
function span(src, name) {
  const m = new RegExp(`(^|\\n)[ \\t]*(float|vec2|vec3|vec4|mat3|void|bool)\\s+${name}\\s*\\([^)]*\\)\\s*\\{`).exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return { start: m.index + m[1].length, open, end: i + 1, type: m[2] };
  }
  return null;
}
/** The function's body replaced by one line that returns `value`. */
function stub(src, name, value) {
  const s = span(src, name);
  if (!s) throw new Error(`no function ${name} in the shader`);
  return src.slice(0, s.open) + `{ return ${value}; }` + src.slice(s.end);
}
/** The same where the shader has the function, and the shader as it is where it has not. */
const stubIf = (src, name, value) => (span(src, name) ? stub(src, name, value) : src);
/** `edit` applied inside the function only. */
function inside(src, name, edit) {
  const s = span(src, name);
  if (!s) throw new Error(`no function ${name} in the shader`);
  return src.slice(0, s.open) + edit(src.slice(s.open, s.end)) + src.slice(s.end);
}
const swap = (src, from, to) => { if (!src.includes(from)) throw new Error(`the shader has no "${from}"`); return src.split(from).join(to); };
// a width that is no derivative: what a piece costs with its fwidth calls gone but all else the same
const FW = 'float kNoWidth(float x) { return 0.01 + 0.0 * x; }\nvec2 kNoWidth(vec2 x) { return vec2(0.01) + 0.0 * x; }\nvec3 kNoWidth(vec3 x) { return vec3(0.01) + 0.0 * x; }\n';
const noWidths = (src, names) => {
  let out = src;
  for (const n of names) out = inside(out, n, (body) => body.split('fwidth(').join('kNoWidth('));
  const at = span(out, 'kNoise');
  return out.slice(0, at.start) + FW + out.slice(at.start);
};

/** The function's body replaced by `text`, where the shader has the function. */
const rebody = (src, name, text) => { const s = span(src, name); return s ? src.slice(0, s.open) + text + src.slice(s.end) : src; };
// The noise as it was before its values were read from a block of them (tNoise): each of a point's eight corners
// worked out with a hash. For what the block saves, on the same shader in the same run.
const HASH_NOISE = `{
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(kHash(i), kHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(kHash(i + vec3(0.0, 1.0, 0.0)), kHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(kHash(i + vec3(0.0, 0.0, 1.0)), kHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(kHash(i + vec3(0.0, 1.0, 1.0)), kHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}`;
const HASH_NOISE_G = `{
  vec3 i = floor(x); vec3 f = fract(x); vec3 u = f * f * (3.0 - 2.0 * f); vec3 du = 6.0 * f * (1.0 - f);
  float a = kHash(i); float b = kHash(i + vec3(1.0, 0.0, 0.0)); float c = kHash(i + vec3(0.0, 1.0, 0.0)); float d = kHash(i + vec3(1.0, 1.0, 0.0));
  float e = kHash(i + vec3(0.0, 0.0, 1.0)); float g = kHash(i + vec3(1.0, 0.0, 1.0)); float h = kHash(i + vec3(0.0, 1.0, 1.0)); float k = kHash(i + vec3(1.0, 1.0, 1.0));
  float lo = mix(mix(a, b, u.x), mix(c, d, u.x), u.y); float hi = mix(mix(e, g, u.x), mix(h, k, u.x), u.y);
  float sx = mix(mix(b - a, d - c, u.y), mix(g - e, k - h, u.y), u.z);
  float sy = mix(mix(c, d, u.x) - mix(a, b, u.x), mix(h, k, u.x) - mix(e, g, u.x), u.z);
  return vec3(mix(lo, hi, u.z), sx * du.x, sy * du.y);
}`;

/** The parts' shader with a piece of Kerf's additions taken out, by name. */
const VARIANTS = [
  ['as it is', (s) => s],
  ['no finish detail (kDetail)', (s) => stub(s, 'kDetail', 'vec3(0.0)')],
  ['no making marks (kMake)', (s) => stub(s, 'kMake', 'vec3(0.0)')],
  ['no finish detail or making marks', (s) => stub(stub(s, 'kDetail', 'vec3(0.0)'), 'kMake', 'vec3(0.0)')],
  ['noise a constant (kNoise)', (s) => stubIf(stub(s, 'kNoise', '0.5'), 'kNoiseG', 'vec3(0.5, 0.0, 0.0)')],
  ['noise worked out with a hash, as it was before its values were read from a block', (s) => rebody(rebody(s, 'kNoise', HASH_NOISE), 'kNoiseG', HASH_NOISE_G)],
  ['no widths taken in finish detail and making marks (fwidth)', (s) => noWidths(s, ['kDetail', 'kMake'])],
  ['finish detail of one kind only (grain), no making marks', (s) => swap(stub(s, 'kMake', 'vec3(0.0)'), 'int kind = int(uDetail.x + 0.5);', 'int kind = 3;')],
  ['finish detail of no kind, no making marks', (s) => swap(swap(s, 'int kind = int(uDetail.x + 0.5);', 'int kind = 0;'), 'int mk = int(uMake.x + 0.5);', 'int mk = 0;')],
  ['no threads (kThread)', (s) => stub(s, 'kThread', 'vec2(0.0)')],
  ['no change test (kChangedHere, kSweepAt)', (s) => stub(stub(s, 'kChangedHere', '1.0'), 'kSweepAt', '0.0')],
  ['no bump (kPerturb)', (s) => stub(s, 'kPerturb', 'n')],
  ['fill light from the full map only (kFillIrradiance)', (s) => stub(s, 'kFillIrradiance', 'getIBLIrradiance(normal)')],
  ['none of the above', (s) => {
    let o = s;
    for (const [n, v] of [['kDetail', 'vec3(0.0)'], ['kMake', 'vec3(0.0)'], ['kNoise', '0.5'], ['kThread', 'vec2(0.0)'], ['kChangedHere', '1.0'], ['kSweepAt', '0.0'], ['kPerturb', 'n'], ['kFillIrradiance', 'getIBLIrradiance(normal)']]) o = stub(o, n, v);
    return stubIf(o, 'kNoiseG', 'vec3(0.5, 0.0, 0.0)');
  }],
  ['as it is, again', (s) => s],
];
const PLAIN_FRAGMENT = '#version 300 es\nprecision highp float;\nlayout(location = 0) out highp vec4 pc_fragColor;\nvoid main() { pc_fragColor = vec4(1.0); }\n';
/** What a shader's text says it was built for: the layers of its finish, its lights and its cutting planes. */
const madeFor = (f) => {
  const has = (d) => new RegExp(`\\n#define ${d}\\b`).test(f);
  // (the renderer writes the counts into the text where they are used, as the lengths of these lists)
  const num = (decl) => (new RegExp(`uniform ${decl}\\[ (\\d+) \\]`).exec(f) ?? [0, '0'])[1];
  const layers = [has('USE_CLEARCOAT') && 'clearcoat', has('USE_SHEEN') && 'sheen', has('USE_ANISOTROPY') && 'anisotropy'].filter(Boolean).join('+') || 'plain';
  return `${layers}, ${num('DirectionalLight directionalLights')} lights, ${num('sampler2D directionalShadowMap')} shadows, cut by ${num('vec4 clippingPlanes')}${has('OPAQUE') ? ', solid' : ''}`;
};
/** A shader's text with a value of its own in it, added to what `to` names at the end of main (it is 0 when drawn). */
let salts = 0;
const salted = (src, to) => {
  const name = `kSalt${Date.now() % 100000}n${++salts}`;
  const end = src.lastIndexOf('}');
  const first = src.indexOf('\n', src.indexOf('precision highp float;'));
  return src.slice(0, first + 1) + `uniform float ${name};\n` + src.slice(first + 1, end) + `  ${to} += ${name};\n` + src.slice(end);
};

(async () => {
  const design = fs.readFileSync(file, 'utf8');
  const launch = WIN
    ? { channel: 'msedge', headless: false, args: ['--ignore-gpu-blocklist', '--force_high_performance_gpu', '--window-size=1650,1040'] }
    : { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] };
  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx.addInitScript(([oneShader]) => {
    // ONESHADER=0 or 1: a shader for each mix of finishes, or one for all, as in measure.cjs
    try { if (oneShader) localStorage.setItem('kerf.debug.oneShader', oneShader); else localStorage.removeItem('kerf.debug.oneShader'); } catch {}
    try { if (!localStorage.getItem('kerf.settings.v1')) localStorage.setItem('kerf.settings.v1', JSON.stringify({ onboarded: true, termsAccepted: '2026-10-draft-2' })); } catch {}
    // the text of every shader of the parts the view hands the card, with the vertex shader that came before it
    const P = WebGL2RenderingContext.prototype;
    const real = P.shaderSource;
    const kept = (window.__shaders = []);
    let vertex = '';
    P.shaderSource = function (shader, src) {
      try {
        if (this.getShaderParameter(shader, this.SHADER_TYPE) === this.VERTEX_SHADER) vertex = src;
        else if (src.length > 60000 && src.includes('kDetail') && !kept.some((k) => k.fs === src)) kept.push({ vs: vertex, fs: src });
      } catch {}
      return real.call(this, shader, src);
    };
  }, [/^[01]$/.test(process.env.ONESHADER || '') ? process.env.ONESHADER : '']);
  const page = await ctx.newPage();
  page.setDefaultTimeout(1_800_000);
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0 && window.__kerfDbg, null, { timeout: 180000 });
  await page.evaluate(async ([src]) => { const { P } = window.__kerfDbg; const p = await P.createProject('blank', 'shadercost', src); window.__project = p.id; await P.openProject(p.id); }, [design]);
  // until the design is built and no new shader has been asked for in 6 s
  await page.evaluate(() => window.__kerfDbg.E.whenChecked(1_800_000));
  for (let n = -1, same = 0; same < 3; ) { await page.waitForTimeout(2000); const now = await page.evaluate(() => window.__shaders.length); same = now === n && now > 0 ? same + 1 : 0; n = now; }
  const shaders = await page.evaluate(() => window.__shaders);
  await page.evaluate(async () => { const { P } = window.__kerfDbg; try { await P.closeProject(); await P.deleteProject(window.__project); } catch {} });
  await page.close();
  if (!shaders.length) { console.error('the view asked for no shader of the parts'); await browser.close(); process.exit(1); }

  // a page with nothing in it but a canvas: one build at a time, timed from the text to the card's answer
  const bench = await ctx.newPage();
  bench.setDefaultTimeout(1_800_000);
  // (a page of the app's own address that the browser is handed here, so nothing of the app loads into it)
  const blank = url.replace(/\/?$/, '/') + 'shadercost-blank';
  await ctx.route(blank, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>shader cost</title><canvas id="c" width="64" height="64"></canvas>' }));
  await bench.goto(blank);
  const gpu = await bench.evaluate(() => { const gl = (window.__gl = document.getElementById('c').getContext('webgl2')); const ext = gl && gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'no webgl2'; });
  const build = (vs, fsText) => bench.evaluate(([vs, fsText]) => {
    const gl = window.__gl;
    const t = performance.now();
    const p = gl.createProgram();
    const made = [];
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fsText]]) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); gl.attachShader(p, s); made.push(s); }
    gl.linkProgram(p);
    const ok = gl.getProgramParameter(p, gl.LINK_STATUS);
    const ms = Math.round(performance.now() - t);
    const log = ok ? '' : ((gl.getProgramInfoLog(p) || '') + ' | ' + made.map((s) => gl.getShaderInfoLog(s) || '').join(' | ')).slice(0, 600);
    for (const s of made) gl.deleteShader(s);
    gl.deleteProgram(p);
    return { ms, ok, log };
  }, [salted(vs, 'gl_Position.w'), salted(fsText, 'pc_fragColor.a')]);

  const out = { url, design: require('path').basename(file), when: new Date().toISOString(), gpu, browser: browser.version(), cpu: require('os').cpus()[0].model, shaders: [], pieces: [] };
  console.log(`${out.gpu}\n${out.browser}, ${out.cpu}\n`);
  await build(shaders[0].vs, PLAIN_FRAGMENT); // (the first build of a page also starts the card's compiler)
  // every shader of the parts the view asked for, as it is
  console.log(`The parts' shaders the view asked for opening ${out.design} (${shaders.length}), each built on its own:`);
  for (const s of shaders) {
    const r = await build(s.vs, s.fs);
    out.shaders.push({ for: madeFor(s.fs), characters: s.fs.length, ...r });
    console.log(`  ${String(r.ms).padStart(6)} ms  ${madeFor(s.fs)} (${Math.round(s.fs.length / 1000)}k characters)${r.ok ? '' : '  FAILED: ' + r.log}`);
  }
  // the first of them, with a piece gone each time
  const base = shaders[0];
  const vsOnly = await build(base.vs, PLAIN_FRAGMENT);
  console.log(`\nThe first of them (${madeFor(base.fs)}) with a piece of Kerf's additions taken out:`);
  console.log(`  ${String(vsOnly.ms).padStart(6)} ms  its vertex shader with a fragment shader of one line`);
  out.vertexOnly = vsOnly;
  let whole = 0;
  for (const [name, edit] of VARIANTS) {
    let text;
    try { text = edit(base.fs); } catch (e) { console.log(`  ${'-'.padStart(6)}     ${name}: ${e.message}`); out.pieces.push({ name, error: e.message }); continue; }
    const r = await build(base.vs, text);
    if (name === 'as it is') whole = r.ms;
    out.pieces.push({ name, characters: text.length, ...r });
    console.log(`  ${String(r.ms).padStart(6)} ms  ${name}${whole && name !== 'as it is' ? ` (${r.ms - whole >= 0 ? '+' : ''}${r.ms - whole} ms)` : ''}${r.ok ? '' : '  FAILED: ' + r.log}`);
  }
  if (outFile) { fs.writeFileSync(outFile, JSON.stringify(out, null, 1)); fs.writeFileSync(outFile.replace(/\.json$/, '') + '.frag', base.fs); fs.writeFileSync(outFile.replace(/\.json$/, '') + '.vert', base.vs); }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
