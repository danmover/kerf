// Loads OpenCASCADE (and the text fonts) once for tests that need the geometry kernel in Node.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as R from "replicad";
import opencascade from "replicad-opencascadejs";
import { loadFontData } from "../src/kernel/profiles";

let loading: Promise<void> | null = null;

const buf = (path: string) => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

export function loadOC(): Promise<void> {
  loading ??= (async () => {
    const require = createRequire(import.meta.url);
    const oc = await (opencascade as unknown as (o: object) => Promise<unknown>)({ wasmBinary: readFileSync(require.resolve("replicad-opencascadejs/wasm")), print: () => {}, printErr: () => {} });
    R.setOC(oc as never);
    await loadFontData("sans", buf(require.resolve("@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff")));
    await loadFontData("mono", buf(require.resolve("@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff")));
  })();
  return loading;
}

export const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
