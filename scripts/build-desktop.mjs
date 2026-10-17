// Stages the desktop app in .desktop/app: the Electron main process and
// preload bundled by esbuild, the web build from dist/ under web/, and a
// package.json with no dependencies, so the installer carries only these
// files and not node_modules. Run `npm run build` first.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const out = ".desktop/app";

if (!existsSync("dist/index.html")) throw new Error("No web build in dist/: run `npm run build` first.");
rmSync(".desktop", { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// the smoke test (desktop/smoke.ts) skips first-run setup with the current terms version
const terms = /export const TERMS_VERSION = "([^"]+)"/.exec(readFileSync("src/app/settings.ts", "utf8"))?.[1];
if (!terms) throw new Error("TERMS_VERSION not found in src/app/settings.ts");

const common = { bundle: true, platform: "node", target: "node22", format: "cjs", external: ["electron"], legalComments: "linked", logLevel: "info", define: { __KERF_TERMS__: JSON.stringify(terms) } };
await build({ ...common, entryPoints: ["desktop/main.ts"], outfile: `${out}/main.cjs` });
await build({ ...common, entryPoints: ["desktop/preload.ts"], outfile: `${out}/preload.cjs` });

cpSync("dist", `${out}/web`, { recursive: true });
cpSync("desktop/resources/icon.png", `${out}/icon.png`);
writeFileSync(
  `${out}/package.json`,
  JSON.stringify({ name: "kerf", productName: "Kerf", version: pkg.version, description: pkg.description, author: "Kerf", license: pkg.license, main: "main.cjs" }, null, 2) + "\n",
);
