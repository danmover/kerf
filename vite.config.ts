/// <reference types="vitest" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { appRuntime } from "./scripts/appRuntime";

/** /api goes to a Kerf server when one is running (see server/README.md); without it Kerf runs on its own. */
const API_PROXY = process.env.KERF_API ? Object.fromEntries(["/api", "/mcp", "/oauth", "/.well-known"].map(path => [path, { target: process.env.KERF_API, changeOrigin: false }])) : undefined;

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// The page may reach only its own files and the Claude API.
// 'unsafe-inline' styles are needed by the animation library.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "connect-src 'self' https://api.anthropic.com https://api.openai.com",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

// The OpenCASCADE worker is the only code that needs eval and WebAssembly
// compilation (Emscripten's bindings generate functions at start-up). It runs
// in its own worker with no network access beyond Kerf's own files.
export const WORKER_CSP = "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'";

/** The feasibility solver worker only evaluates design source: no eval, no network. */
export const SOLVER_CSP = "default-src 'none'; script-src 'self'";

/** The stress analysis worker is plain arithmetic on meshes: no eval, no network. */
export const FEA_CSP = "default-src 'none'; script-src 'self'";

/** The circuit render and board routing workers are plain arithmetic too: no eval, no network. */
export const CIRCUIT_CSP = "default-src 'none'; script-src 'self'";
/** The simulation worker runs the firmware as compiled closures on a virtual chip: no eval, no network. */
export const SIM_CSP = "default-src 'none'; script-src 'self'";

/** The page an app's custom drawing panels run in: Kerf frames it in a sandbox; the panels' code may use eval, and reach nothing. */
export const APP_SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; frame-ancestors 'self'";

/** An app's simulated twin, like the simulation worker: no eval, no network. */
export const TWIN_CSP = "default-src 'none'; script-src 'self'";

/** The photoreal view's BVH worker sorts triangles: no eval, no network. */
export const BVH_CSP = "default-src 'none'; script-src 'self'";

/** The cable router for the 3D wiring is plain arithmetic on meshes: no eval, no network. */
export const CABLES_CSP = "default-src 'none'; script-src 'self'";

/** The airflow worker steps the flow on the GPU through WebGPU (or arithmetic on the CPU): no eval, no network. */
export const AERO_CSP = "default-src 'none'; script-src 'self'";

const COMMON_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // the microphone is for voice input and the camera for an app's camera panel, only on Kerf's own page
  "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** The CSP goes into built pages as a meta tag so it applies on any static host. The dev server skips it because hot reload injects inline scripts. */
function securityPolicy(): Plugin {
  return {
    name: "kerf-security",
    transformIndexHtml: {
      order: "post",
      handler: (html, ctx) => (ctx.server ? html : html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)),
    },
    // `vite preview` serves the build with the same headers public/_headers gives static hosts
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        for (const [k, v] of Object.entries(COMMON_HEADERS)) res.setHeader(k, v);
        const path = (req.url ?? "/").split("?")[0];
        if (/^\/assets\/worker-[\w-]+\.js$/.test(path)) res.setHeader("Content-Security-Policy", WORKER_CSP);
        else if (/^\/assets\/solver\.worker-[\w-]+\.js$/.test(path)) res.setHeader("Content-Security-Policy", SOLVER_CSP);
        else if (/^\/assets\/fea\.worker-[\w-]+\.js$/.test(path)) res.setHeader("Content-Security-Policy", FEA_CSP);
        else if (/^\/assets\/(render|route)\.worker-[\w-]+\.js$/.test(path)) res.setHeader("Content-Security-Policy", CIRCUIT_CSP);
        else if (/^\/assets\/sim\.worker-[\w-]+\.js$/.test(path)) res.setHeader("Content-Security-Policy", SIM_CSP);
        else if (/^\/assets\/bvh\.worker-[\w-]+\.js$/.test(path)) res.setHeader("Content-Security-Policy", BVH_CSP);
        else if (/^\/assets\/cables\.worker-[\w-]+\.js$/.test(path)) res.setHeader("Content-Security-Policy", CABLES_CSP);
        else if (/^\/assets\/aero\.worker-[\w-]+\.js$/.test(path)) res.setHeader("Content-Security-Policy", AERO_CSP);
        else if (/^\/assets\/twin\.worker-[\w-]+\.js$/.test(path)) res.setHeader("Content-Security-Policy", TWIN_CSP);
        else if (path === "/app-sandbox.html") res.setHeader("Content-Security-Policy", APP_SANDBOX_CSP);
        else if (path === "/" || path.endsWith(".html")) {
          res.setHeader("Content-Security-Policy", `${CSP}; frame-ancestors 'none'`);
          res.setHeader("X-Frame-Options", "DENY");
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), securityPolicy(), appRuntime(pkg.version)],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["replicad-opencascadejs"],
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
  server: {
    headers: { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" },
    // `npm run dev:full` sets KERF_API so the app talks to a local Kerf server
    proxy: API_PROXY,
  },
  preview: {
    cors: false,
    proxy: API_PROXY,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "server/tests/**/*.test.ts"],
    setupFiles: ["server/tests/setup.ts"],
  },
});
