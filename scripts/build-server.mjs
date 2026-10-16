// Bundles the Kerf server into server/dist, so a deployment needs Node and
// these files, not node_modules. Type-checking is separate (npm run typecheck).
// The entry files stay separate from the rest, so their first import (quiet.ts)
// runs before node:sqlite loads.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

rmSync("server/dist", { recursive: true, force: true });
await build({
  entryPoints: ["server/src/index.ts", "server/src/admin.ts"],
  outdir: "server/dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  chunkNames: "chunks/[name]-[hash]",
  legalComments: "linked",
  define: { __KERF_VERSION__: JSON.stringify(version) },
  // CommonJS dependencies (nodemailer) call require() for Node's own modules
  banner: { js: 'import { createRequire as __kerfRequire } from "node:module"; const require = __kerfRequire(import.meta.url);' },
  logLevel: "info",
});
// so Node reads the bundle as ES modules wherever it is copied
writeFileSync("server/dist/package.json", JSON.stringify({ type: "module" }) + "\n");
