// Runs the Kerf server and the app's dev server together, with /api proxied
// to the server. Works the same on Windows, macOS and Linux: npm run dev:full
import { spawn } from "node:child_process";

const port = process.env.PORT ?? "8787";
const env = { ...process.env, PORT: port, KERF_API: `http://127.0.0.1:${port}`, KERF_STATIC_DIR: "" };
const run = (args) => spawn("npx", args, { stdio: "inherit", env, shell: process.platform === "win32" });

const procs = [run(["tsx", "watch", "server/src/index.ts"]), run(["vite"])];
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", (code) => code && stop());
