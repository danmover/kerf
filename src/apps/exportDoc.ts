// The files a saved app is made of: one HTML page that carries the app, its
// runtime, the twin and Kerf's colours, and a desktop (Electron) project
// around that page. Pure text in, text out, so tests can check them.

import type { ZipEntry } from "../machine/zip";
import { fileStemOf } from "./names";
import { wireStringify, type AppBundle } from "./wire";

/** The app's code and the twin's worker, bundled (from the build's virtual:kerf-app-runtime). */
export interface AppRuntime {
  main: string;
  worker: string;
}

/**
 * A saved app reaches nothing outside itself: no network, scripts only its
 * own (the custom panels' sandbox needs eval), workers from its own blobs.
 */
export const SAVED_APP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "worker-src blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src blob: mediastream:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'self' blob: data:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Kerf's colour tokens, dark and light, from its stylesheets. */
export function tokenCss(appCss: string, themeCss: string): string {
  const dark = /:root\s*\{([\s\S]*?)\n\}/.exec(appCss)?.[1] ?? "";
  const light = /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(themeCss)?.[1] ?? "";
  return `:root {${dark}\n}\n:root[data-theme="light"] {${light}\n}\n`;
}

/** Text that cannot end the <script> element it sits in. */
const scriptSafe = (s: string) => s.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function standaloneHtml(bundle: AppBundle, rt: AppRuntime, css: string): string {
  const name = bundle.app.name;
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="${SAVED_APP_CSP}" />
<meta name="generator" content="Kerf ${esc(bundle.design.kerf)}" />
<title>${esc(name)}</title>
<style>
${css.replace(/<\/style/gi, "<\\/style")}
</style>
</head>
<body class="sa">
<div id="root"></div>
<script type="application/json" id="kerf-app">${wireStringify(bundle)}</script>
<script type="text/plain" id="kerf-twin">${bundle.twin ? scriptSafe(rt.worker) : ""}</script>
<script>${scriptSafe(rt.main)}</script>
</body>
</html>
`;
}

/** A desktop app project around the saved page: Electron, with the serial port picker and the camera allowed. */
export function desktopProject(bundle: AppBundle, html: string): ZipEntry[] {
  const app = bundle.app;
  const stem = fileStemOf(app.name);
  const dir = `${stem}-desktop`;
  const pkg = {
    name: stem,
    productName: app.name,
    version: "1.0.0",
    description: app.about ?? `${app.name}, made in Kerf`,
    main: "main.js",
    private: true,
    scripts: { start: "electron .", dist: "electron-builder" },
    devDependencies: { electron: "^44.7.2", "electron-builder": "^26.15.3" },
    build: {
      appId: `app.kerf.${stem.replace(/[^a-z0-9]+/g, "")}`,
      productName: app.name,
      files: ["main.js", "index.html"],
      win: { target: "nsis" },
      mac: { target: "dmg" },
      linux: { target: "AppImage" },
    },
  };
  const main = `// ${app.name}: a desktop app made in Kerf. It shows index.html (the app) in a
// window, lets it use the USB serial port the person picks, and the camera.
const { app, BrowserWindow, dialog, session } = require("electron");
const path = require("node:path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    title: ${JSON.stringify(app.name)},
    backgroundColor: "#07090d",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const ses = win.webContents.session;
  // the page asks for a serial port: offer the ones plugged in
  ses.on("select-serial-port", async (event, ports, _wc, callback) => {
    event.preventDefault();
    if (!ports.length) {
      await dialog.showMessageBox(win, { type: "info", message: "No serial ports found", detail: "Plug the machine in with its USB cable, then try again." });
      return callback("");
    }
    if (ports.length === 1) return callback(ports[0].portId);
    const labels = ports.map((p) => p.displayName || p.portName || p.portId);
    const { response } = await dialog.showMessageBox(win, { type: "question", message: "Which port is the machine on?", buttons: [...labels, "Cancel"], cancelId: labels.length });
    callback(response < ports.length ? ports[response].portId : "");
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === "serial" || permission === "media");
  ses.setPermissionRequestHandler((_wc, permission, done) => done(permission === "media" || permission === "fullscreen"));
  ses.setDevicePermissionHandler((details) => details.deviceType === "serial");
  // it stays the app: no new windows, no navigating away
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
`;
  const twin = bundle.twin ? `- **Twin** runs the machine simulated (its firmware on a virtual ${bundle.twin.board.mcu} in the “${app.twin}” world), so the app works without the hardware.` : `- There is no simulated twin in this copy${bundle.twinWhy ? `: ${bundle.twinWhy}` : ""}.`;
  const readme = `# ${app.name}

${app.about ?? ""}

A program made in Kerf from the design “${bundle.design.name}” (Kerf ${bundle.design.kerf}, saved ${bundle.design.saved.slice(0, 10)}).

${twin}
- **USB** talks to the real machine over its USB cable at ${app.baud} baud.
- **Record** saves every value to a CSV file; **CSV** saves the last minute.

## Run it

\`index.html\` is the whole app: open it in Chrome or Edge (USB needs one of those).

To run it as a desktop app, install [Node.js](https://nodejs.org) 20 or newer, then in this folder:

\`\`\`
npm install
npm start
\`\`\`

## Make an installer

\`\`\`
npm run dist
\`\`\`

builds an installer for the computer you run it on in \`dist/\` (a Windows setup .exe, a Mac .dmg, or a Linux AppImage). It is not code-signed, so Windows asks you to confirm (More info, then Run anyway) and a Mac needs Open Anyway in System Settings → Privacy & Security.

## Changing it

The app is written in the design file, in the \`app ${JSON.stringify(app.name)} { … }\` block. Change it in Kerf and save it again.
`;
  return [
    { path: `${dir}/package.json`, data: JSON.stringify(pkg, null, 2) + "\n" },
    { path: `${dir}/main.js`, data: main },
    { path: `${dir}/index.html`, data: html },
    { path: `${dir}/README.md`, data: readme },
  ];
}
