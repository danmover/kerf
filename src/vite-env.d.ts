/// <reference types="vite/client" />
declare module "*.kerf?raw" {
  const src: string;
  export default src;
}
declare const __APP_VERSION__: string;
declare module "virtual:kerf-app-runtime" {
  /** a saved app's page script and its twin's worker, bundled (see scripts/appRuntime.ts) */
  export const main: string;
  export const worker: string;
}
