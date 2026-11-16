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

// The sign-in server and the key it signs with are built in (desktop/access/config.ts). A local test
// build can point at a test server (access-server/src/dev.ts) and trust its throwaway key instead.
const accessServer = process.env.KERF_ACCESS_SERVER ?? "";
const accessTestKey = process.env.KERF_ACCESS_TEST_PUBLIC_KEY ?? "";
if (accessServer || accessTestKey) console.warn(`\nTEST BUILD: sign-in server ${accessServer || "(built-in)"}${accessTestKey ? ", trusting a test key" : ""}. Don't give this build to anyone.\n`);

const define = { __KERF_TERMS__: JSON.stringify(terms), __KERF_ACCESS_SERVER__: JSON.stringify(accessServer), __KERF_ACCESS_TEST_KEY__: JSON.stringify(accessTestKey) };
const common = { bundle: true, platform: "node", target: "node22", format: "cjs", external: ["electron"], legalComments: "linked", logLevel: "info", define };
await build({ ...common, entryPoints: ["desktop/main.ts"], outfile: `${out}/main.cjs` });
await build({ ...common, entryPoints: ["desktop/preload.ts"], outfile: `${out}/preload.cjs` });
await build({ ...common, entryPoints: ["desktop/access/gate-preload.ts"], outfile: `${out}/gate-preload.cjs` });

// the sign-in window's page, with Kerf's fonts
cpSync("desktop/access/gate", `${out}/gate`, { recursive: true });
mkdirSync(`${out}/gate/fonts`, { recursive: true });
for (const f of ["ibm-plex-sans/files/ibm-plex-sans-latin-400-normal", "ibm-plex-sans/files/ibm-plex-sans-latin-500-normal", "ibm-plex-sans/files/ibm-plex-sans-latin-600-normal", "ibm-plex-mono/files/ibm-plex-mono-latin-500-normal"])
  cpSync(`node_modules/@fontsource/${f}.woff2`, `${out}/gate/fonts/${f.split("/").pop()}.woff2`);

cpSync("dist", `${out}/web`, { recursive: true });
cpSync("desktop/resources/icon.png", `${out}/icon.png`);
writeFileSync(
  `${out}/package.json`,
  JSON.stringify({ name: "kerf", productName: "Kerf", version: pkg.version, description: pkg.description, author: "Kerf", license: pkg.license, main: "main.cjs" }, null, 2) + "\n",
);
