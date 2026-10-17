// The only thing the desktop app adds to the page: window.kerfDesktop, for
// Settings → Desktop. The page itself has no access to Node or Electron.

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("kerfDesktop", {
  info: () => ipcRenderer.invoke("kerf:desktop-info"),
  setGraphics: (backend: string) => ipcRenderer.invoke("kerf:set-graphics", backend),
  relaunch: () => ipcRenderer.invoke("kerf:relaunch"),
});
