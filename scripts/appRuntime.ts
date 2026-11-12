// virtual:kerf-app-runtime: the code a saved app carries (src/apps/standalone/main.ts
// and the twin's worker), bundled to plain scripts so export can write them
// into one HTML file. Built on first use, minified in production builds.

import { build } from "esbuild";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const ID = "virtual:kerf-app-runtime";
const RESOLVED = "\0" + ID;

export function appRuntime(version: string): Plugin {
  let production = false;
  return {
    name: "kerf-app-runtime",
    configResolved(c) {
      production = c.command === "build";
    },
    resolveId: (id) => (id === ID ? RESOLVED : null),
    async load(id) {
      if (id !== RESOLVED) return null;
      const one = async (entry: string) => {
        const r = await build({
          entryPoints: [resolve(entry)],
          bundle: true,
          write: false,
          format: "iife",
          platform: "browser",
          target: "es2022",
          minify: production,
          legalComments: "none",
          metafile: true,
          logLevel: "silent",
          define: { __APP_VERSION__: JSON.stringify(version), "import.meta.env.DEV": "false", "import.meta.env.PROD": "true" },
        });
        for (const f of Object.keys(r.metafile.inputs)) if (!f.includes("node_modules")) this.addWatchFile(resolve(f));
        return r.outputFiles[0].text;
      };
      const [main, worker] = await Promise.all([one("src/apps/standalone/main.ts"), one("src/apps/twin.worker.ts")]);
      return `export const main = ${JSON.stringify(main)};\nexport const worker = ${JSON.stringify(worker)};\n`;
    },
  };
}
