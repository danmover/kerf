// mcp-bridge.cjs: what Claude Code runs for Kerf after "Connect Claude Code",
// as `Kerf mcp-bridge.cjs --kerf-data <Kerf's data folder>` with
// ELECTRON_RUN_AS_NODE=1. See desktop/bridge.ts.

import { spawn } from "node:child_process";
import { runBridge } from "./bridge.js";

declare const __KERF_VERSION__: string;

function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const dataDir = arg("--kerf-data");
// set when Kerf runs unpackaged (`electron .desktop/app`): the app folder Electron needs to open Kerf
const appDir = arg("--kerf-app");

if (!dataDir) {
  process.stderr.write("kerf-bridge: no --kerf-data folder. Press Connect Claude Code in Kerf's Settings → AI to set this up again.\n");
  process.exit(2);
}

void runBridge({
  dataDir,
  input: process.stdin,
  write: (line) => process.stdout.write(line + "\n"),
  log: (t) => process.stderr.write(`kerf-bridge: ${t}\n`),
  version: typeof __KERF_VERSION__ === "string" ? __KERF_VERSION__ : "0.0.0",
  launch: () => {
    // Kerf itself, not another copy of Node
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(process.execPath, appDir ? [appDir] : [], { detached: true, stdio: "ignore", env, windowsHide: false }).unref();
  },
}).then(() => {
  // let the last replies out before going
  process.stdout.write("", () => process.exit(0));
});
