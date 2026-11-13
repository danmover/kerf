// The only thing the desktop app adds to the page: window.kerfDesktop, for
// Settings → Desktop and Settings → Claude's Claude Code connection. The page
// itself has no access to Node or Electron.

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("kerfDesktop", {
  info: () => ipcRenderer.invoke("kerf:desktop-info"),
  setGraphics: (backend: string) => ipcRenderer.invoke("kerf:set-graphics", backend),
  relaunch: () => ipcRenderer.invoke("kerf:relaunch"),
  graphicsFailed: () => ipcRenderer.invoke("kerf:graphics-failed"),
  claudeCode: {
    info: () => ipcRenderer.invoke("kerf:claude-code-info"),
    setEnabled: (on: boolean) => ipcRenderer.invoke("kerf:set-claude-code", on),
    newToken: () => ipcRenderer.invoke("kerf:claude-code-new-token"),
    /** Claude Code's tool calls, run by the page; the main process only passes them on */
    serve: (page: { run: (id: number, method: string, params: unknown) => Promise<unknown>; cancel: (id: number) => void }) => {
      ipcRenderer.on("kerf:mcp-cancel", (_e, id: number) => page.cancel(id));
      ipcRenderer.on("kerf:mcp-request", async (_e, r: { id: number; method: string; params: unknown }) => {
        try {
          const result = await page.run(r.id, r.method, r.params);
          await ipcRenderer.invoke("kerf:mcp-response", { id: r.id, result });
        } catch (e) {
          await ipcRenderer.invoke("kerf:mcp-response", { id: r.id, error: (e as Error)?.message ?? String(e) });
        }
      });
      return ipcRenderer.invoke("kerf:mcp-ready");
    },
  },
});
