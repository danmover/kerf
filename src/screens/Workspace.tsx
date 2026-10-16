// The main design workspace.

import { useEffect, useRef, useState } from "react";
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
import { DrawingSwitch, DrawingView } from "../ui/drawing/DrawingView";
import { PhoneWorkspace } from "./PhoneWorkspace";
import { gridFor, useWindowSize, useWorkspaceLayout, type WorkspaceLayout } from "../app/layout";
import { LeftRail } from "../ui/LeftRail";
import { PlanHud } from "../ui/PlanHud";
import { RefViewer } from "../ui/RefViewer";
import { SketchPad } from "../ui/SketchPad";
import { PreviewBanner } from "../ui/PreviewBanner";
import { StepDropOverlay, useStepDrop } from "../ui/ImportsPanel";
import "../styles/layout.css";

export function Workspace() {
  const project = useProject((s) => s.current);
  const save = useProject((s) => s.save);
  const layout = useWorkspaceLayout();
  const win = useWindowSize();
  const [left, setLeft, saveLeft] = usePersistentNumber("kerf.layout.left", 300, 220, 460);
  const [right, setRight, saveRight] = usePersistentNumber("kerf.layout.right", 384, 320, 620);
  const [dockPref, setDock, saveDock] = usePersistentNumber("kerf.layout.dock", 300, 140, 900);
  const [below, setBelow, saveBelow] = usePersistentNumber("kerf.layout.below", 440, 220, 1400);
  const [panelOpen, setPanelOpen, folding] = usePanelOpen(layout);
  const dockOpen = useView((s) => s.dockOpen);
  const center = useRef<HTMLDivElement>(null);
  const drop = useStepDrop();
  useThumbnails();
  // upright on a tablet the code panel starts folded, so the model gets the height
  const projectId = project?.id;
  useEffect(() => {
    if (projectId && layout === "portrait") useView.setState({ dockOpen: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (!project) return null;
  if (layout === "phone") return <PhoneWorkspace projectKey={project.id} />;
  const g = gridFor(layout, win, { left, right, below, dock: dockPref, panelOpen });
  const dock = g.dock;
  const rail = layout !== "wide";
  return (
    <div className="app">
      <TopBar />
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        {save === "memory" && (
          <div className="banner">
            <Icon.Alert size={14} /> This browser is blocking local storage, so projects will not be kept after you close the tab. Use Export → Project file to keep your work.
          </div>
        )}
        <div className={`workspace ${layout} ${rail ? "has-rail" : ""} ${panelOpen ? "" : "panel-folded"} ${folding ? "folding" : ""}`} style={{ ...g.grid, flex: 1 }} {...drop.handlers}>
          <StepDropOverlay show={drop.over} />
          <div className="ws-left" style={{ ["--panel-w" as string]: `${g.panel}px` }}>
            {rail && <LeftRail open={panelOpen} onOpen={setPanelOpen} />}
            <div className="ws-panel" hidden={!panelOpen}>
              <ErrorBoundary label="Model panel">
                <LeftPanel />
              </ErrorBoundary>
            </div>
          </div>
          <div className="center ws-center" ref={center} style={{ gridTemplateRows: dockOpen ? `1fr ${dock}px` : `1fr 37px`, position: "relative" }}>
            <div className="plan-hud-anchor" style={{ bottom: dockOpen ? dock : 37 }}>
              <PlanHud />
            </div>
            <div className="center-stage">
              <ErrorBoundary label="3D view">
                <Viewport />
              </ErrorBoundary>
              <ErrorBoundary label="Drawings">
                <DrawingView />
                <DrawingSwitch />
              </ErrorBoundary>
            </div>
            <PreviewBanner />
            {dockOpen && <Splitter dir="h" style={{ bottom: dock }} onDrag={(d) => setDock(dock - d)} onEnd={saveDock} />}
            <ErrorBoundary label="Editor">
              <Dock projectKey={project.id} />
            </ErrorBoundary>
          </div>
          <div className="ws-chat">
            <ErrorBoundary label="Chat">
              <ChatPanel />
            </ErrorBoundary>
          </div>
          {layout === "portrait" ? (
            <>
              <Splitter dir="h" style={{ bottom: g.below }} onDrag={(d) => setBelow(g.below - d)} onEnd={saveBelow} />
              {panelOpen && <Splitter dir="v" style={{ left: g.leftCol, top: "auto", height: g.below }} onDrag={(d) => setLeft(g.panel + d)} onEnd={saveLeft} />}
            </>
          ) : (
            <>
              {panelOpen && <Splitter dir="v" style={{ left: g.leftCol }} onDrag={(d) => setLeft(g.panel + d)} onEnd={saveLeft} />}
              <Splitter dir="v" style={{ left: `calc(100% - ${g.chat}px)` }} onDrag={(d) => setRight(g.chat - d)} onEnd={saveRight} />
            </>
          )}
        </div>
      </div>
      <StatusBar />
      <RefViewer />
      <SketchPad />
    </div>
  );
}

/**
 * Whether the model panel is open beside its rail. Each layout remembers its
 * own choice: a tablet held sideways starts folded so the 3D view has room,
 * upright it starts open. Opening a tab from elsewhere (a decision card, a
 * sketch) opens the panel.
 */
function usePanelOpen(layout: WorkspaceLayout) {
  const key = `kerf.layout.panel.${layout}`;
  const read = () => {
    if (layout === "wide" || layout === "phone") return true;
    try {
      const v = localStorage.getItem(key);
      if (v === "open" || v === "folded") return v === "open";
    } catch {
      /* storage blocked */
    }
    return layout === "portrait";
  };
  const [open, setOpen] = useState(read);
  const [forLayout, setForLayout] = useState(layout);
  if (forLayout !== layout) {
    setForLayout(layout);
    setOpen(read());
  }
  // the columns animate only while folding, not while a splitter or the window is dragged
  const [folding, setFolding] = useState(false);
  const timer = useRef(0);
  const fold = (v: boolean) => {
    if (v === open) return;
    setFolding(true);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFolding(false), 360);
    setOpen(v);
  };
  const set = (v: boolean) => {
    fold(v);
    try {
      localStorage.setItem(key, v ? "open" : "folded");
    } catch {
      /* storage blocked */
    }
  };
  const leftTab = useView((s) => s.leftTab);
  const decision = useView((s) => s.decisionFocus);
  const seen = useRef({ leftTab, decision });
  useEffect(() => {
    if (seen.current.leftTab === leftTab && seen.current.decision === decision) return;
    seen.current = { leftTab, decision };
    fold(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftTab, decision]);
  return [open || layout === "wide", set, folding] as const;
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
      // a preview is not the design: keep the thumbnail of the real one
      if (!vp || useDesign.getState().rev !== rev || useProject.getState().preview) return;
      if (!useDesign.getState().model?.parts.length) return;
      try {
        const url = await vp.capture({ view: "iso", width: 480, height: 300, mime: "image/webp", quality: 0.82, samples: 12, overlays: false });
        last.current = rev;
        await saveThumbnail(url);
      } catch {
        /* thumbnails are best-effort */
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [stage, rev]);
}
