// What the sign-in window's page may ask of the main process. Everything it
// gets back is for showing; the decisions are made in desktop/access/gate.ts.

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("kerfGate", {
  screen: () => ipcRenderer.invoke("kerf-gate:screen"),
  signIn: (user: string, password: string, stay: boolean) => ipcRenderer.invoke("kerf-gate:sign-in", { user, password, stay }),
  setUpOwner: (user: string, password: string, stay: boolean) => ipcRenderer.invoke("kerf-gate:owner-setup", { user, password, stay }),
  copyCode: () => ipcRenderer.invoke("kerf-gate:copy-code"),
  quit: () => ipcRenderer.invoke("kerf-gate:quit"),
});
