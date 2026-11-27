// Gives a Kerf checkout a handle for measuring a production build: appends a few lines to src/main.tsx that put the
// app's own modules on window.__kerfDbg. For a throwaway checkout only (git checkout src/main.tsx undoes it).
//   node hook.cjs <kerf checkout>
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const main = path.join(dir, 'src', 'main.tsx');
let src = fs.readFileSync(main, 'utf8');
if (src.includes('__kerfDbg')) { console.log('already hooked'); process.exit(0); }
const mods = { E: 'core/engine', P: 'app/project', K: 'kernel/client', W: 'machine/harness/runtime', St: 'app/stalls', Sim: 'sim/runtime', Ui: 'app/ui', Vp: 'app/viewportApi', View: 'app/view', Gate: 'ui/viewport/render/shaderGate', Set: 'app/settings' };
const have = Object.entries(mods).filter(([, m]) => ['.ts', '.tsx'].some((x) => fs.existsSync(path.join(dir, 'src', m + x))));
src += '\n' + have.map(([k, m]) => `import * as __${k} from "./${m}";`).join('\n');
src += `\n(window as unknown as { __kerfDbg: unknown }).__kerfDbg = { ${have.map(([k]) => `${k}: __${k}`).join(', ')} };\n`;
fs.writeFileSync(main, src);
console.log('hooked: ' + have.map(([k]) => k).join(' '));
