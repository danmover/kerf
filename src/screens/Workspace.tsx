// The main design workspace.

import { useEffect, useRef } from "react";
import { TopBar } from "../ui/TopBar";
import { LeftPanel } from "../ui/LeftPanel";
import { Viewport } from "../ui/Viewport";
import { Dock } from "../ui/Dock";
import { ChatPanel } from "../ui/ChatPanel";
import { Splitter, usePersistentNumber } from "../ui/common";
import { useDesign } from "../core/engine";
import { useProject, saveThumbnail } from "../app/project";
import { useView } from "../app/view";
import { viewport } from "../app/viewportApi";
import { Icon } from "../ui/icons";
import { fmtNum } from "../lang/values";
import { ErrorBoundary } from "../ui/ErrorBoundary";

export function Workspace() {
  const project = useProject((s) => s.current);
  const save = useProject((s) => s.save);
  const [left, setLeft, saveLeft] = usePersistentNumber("kerf.layout.left", 300, 220, 460);
  const [right, setRight, saveRight] = usePersistentNumber("kerf.layout.right", 384, 320, 620);
  const [dock, setDock, saveDock] = usePersistentNumber("kerf.layout.dock", 300, 140, 900);
  const dockOpen = useView((s) => s.dockOpen);
  const center = useRef<HTMLDivElement>(null);
  useThumbnails();

  if (!project) return null;
  return (
    <div className="app">
      <TopBar />
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        {save === "memory" && (
          <div className="banner">
            <Icon.Alert size={14} /> This browser is blocking local storage, so projects will not be kept after you close the tab. Use Export → Project file to keep your work.
          </div>
        )}
        <div className="workspace" style={{ gridTemplateColumns: `${left}px 1fr ${right}px`, flex: 1 }}>
          <ErrorBoundary label="Model panel">
            <LeftPanel />
          </ErrorBoundary>
          <div className="center" ref={center} style={{ gridTemplateRows: dockOpen ? `1fr ${dock}px` : `1fr 37px`, position: "relative" }}>
            <ErrorBoundary label="3D view">
              <Viewport />
            </ErrorBoundary>
            {dockOpen && <Splitter dir="h" style={{ bottom: dock }} onDrag={(d) => setDock(dock - d)} onEnd={saveDock} />}
            <ErrorBoundary label="Editor">
              <Dock projectKey={project.id} />
            </ErrorBoundary>
          </div>
          <ErrorBoundary label="Chat">
            <ChatPanel />
          </ErrorBoundary>
          <Splitter dir="v" style={{ left }} onDrag={(d) => setLeft(left + d)} onEnd={saveLeft} />
          <Splitter dir="v" style={{ right, left: "auto", marginLeft: 0, marginRight: -3 }} onDrag={(d) => setRight(right - d)} onEnd={saveRight} />
        </div>
      </div>
      <StatusBar />
    </div>
  );
}

function StatusBar() {
  const model = useDesign((s) => s.model);
  const kernelStatus = useDesign((s) => s.kernelStatus);
  const kernelInitMs = useDesign((s) => s.kernelInitMs);
  const timings = useDesign((s) => s.timings);
  const selected = useView((s) => s.selected);
  const unique = model ? new Set(model.parts.map((p) => p.hash)).size : 0;
  return (
    <footer className="statusbar">
      <span className="seg">
        <span className={`dot ${kernelStatus === "ready" ? "pass" : kernelStatus === "error" ? "fail" : "pending"}`} style={{ width: 6, height: 6 }} />
        OpenCASCADE {kernelStatus === "ready" ? `ready in ${fmtNum(kernelInitMs / 1000, 1)}s` : kernelStatus}
      </span>
      <span className="seg">
        <b>{model?.parts.length ?? 0}</b> solids · <b>{unique}</b> unique
      </span>
      <span className="seg">
        <b>{model?.params.length ?? 0}</b> params · <b>{model?.requirements.length ?? 0}</b> requirements
      </span>
      <span className="seg narrow-hide">
        eval <b>{fmtNum(timings.evalMs, 1)}</b> ms · build <b>{fmtNum(timings.buildMs, 0)}</b> ms · checks <b>{fmtNum(timings.checksMs, 0)}</b> ms
      </span>
      <div className="grow" />
      {selected.length > 0 && <span className="seg">{selected.length} selected</span>}
      <span className="seg">units mm · Z up</span>
      <span className="seg">kerf {__APP_VERSION__}</span>
    </footer>
  );
}

/** Capture a small thumbnail for the projects screen after each settled rebuild. */
function useThumbnails() {
  const stage = useDesign((s) => s.stage);
  const rev = useDesign((s) => s.rev);
  const last = useRef(-1);
  useEffect(() => {
    if (stage !== "done" || rev === last.current) return;
    const t = setTimeout(async () => {
      const vp = viewport();
      if (!vp || useDesign.getState().rev !== rev) return;
      if (!useDesign.getState().model?.parts.length) return;
      try {
        const url = await vp.capture({ view: "iso", width: 480, height: 300, mime: "image/webp", quality: 0.82 });
        last.current = rev;
        await saveThumbnail(url);
      } catch {
        /* thumbnails are best-effort */
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [stage, rev]);
}
