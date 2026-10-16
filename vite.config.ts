/// <reference types="vitest" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// The page may reach only its own files and the Claude API.
// 'unsafe-inline' styles are needed by the animation library.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "connect-src 'self' https://api.anthropic.com",
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

const COMMON_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // the microphone is for voice input, and only on Kerf's own page
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=(), payment=(), usb=()",
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
  plugins: [react(), securityPolicy()],
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
  },
  preview: {
    cors: false,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
