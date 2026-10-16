// Loads OpenCASCADE in Node for tests that need the geometry kernel.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as R from "replicad";
import opencascade from "replicad-opencascadejs";

let loading: Promise<void> | null = null;

export function loadOC() {
  loading ??= (async () => {
    const wasm = createRequire(import.meta.url).resolve("replicad-opencascadejs/wasm");
    const oc = await (opencascade as unknown as (o: object) => Promise<unknown>)({ wasmBinary: readFileSync(wasm), print: () => {}, printErr: () => {} });
    R.setOC(oc as never);
  })();
  return loading;
}

export const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
