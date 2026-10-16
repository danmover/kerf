// The workspace on a phone: the 3D view on top and one panel below it, chat
// first, so you can talk to Claude and watch the model change on the go.

import { useEffect, useState, useSyncExternalStore } from "react";
import { TopBar } from "../ui/TopBar";
import { LeftPanel } from "../ui/LeftPanel";
import { Viewport } from "../ui/Viewport";
import { Dock } from "../ui/Dock";
import { ChatPanel } from "../ui/ChatPanel";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { Icon } from "../ui/icons";
import { useDesign } from "../core/engine";
import { useProject } from "../app/project";
import { useView } from "../app/view";
import { useChat } from "../ai/chat";
import { useVoice } from "../voice/voice";
import { PreviewBanner } from "../ui/PreviewBanner";
import { PlanHud } from "../ui/PlanHud";
import { RefViewer } from "../ui/RefViewer";
import { SketchPad } from "../ui/SketchPad";
import { OverviewGlyph } from "../ui/Overview";
import { DrawingSwitch, DrawingView } from "../ui/drawing/DrawingView";
import { useDrawings } from "../drawing/engine";
import "../styles/phone.css";

export const PHONE_QUERY = "(max-width: 760px)";

function subscribePhone(cb: () => void) {
  if (typeof matchMedia === "undefined") return () => {};
  const mq = matchMedia(PHONE_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
const isPhone = () => typeof matchMedia !== "undefined" && matchMedia(PHONE_QUERY).matches;

/** True on phone-sized screens. */
export function usePhoneLayout() {
  return useSyncExternalStore(subscribePhone, isPhone, () => false);
}

/** Follow the visible area, so the on-screen keyboard never covers the message box. */
function useVisibleViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const apply = () => {
      root.style.setProperty("--app-h", `${Math.round(vv ? vv.height : window.innerHeight)}px`);
      root.style.setProperty("--app-top", `${Math.round(vv ? vv.offsetTop : 0)}px`);
    };
    apply();
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      root.style.removeProperty("--app-h");
      root.style.removeProperty("--app-top");
    };
  }, []);
}

type Pane = "chat" | "model" | "code";

export function PhoneWorkspace({ projectKey }: { projectKey: string }) {
  const [pane, setPane] = useState<Pane>("chat");
  const save = useProject((s) => s.save);
  const busy = useChat((s) => s.busy);
  const listening = useVoice((s) => s.phase === "listening" || s.phase === "finishing");
  const fails = useDesign((s) => s.report?.counts.fail ?? 0);
  const errors = useDesign((s) => s.model?.diagnostics.some((d) => d.severity === "error") ?? false);
  // a drawing sheet needs more room than the 3D view
  const drawing = useDrawings((s) => s.open);
  useVisibleViewport();

  // the overview pane always shows its panel; the collapse control is for the desktop dock
  useEffect(() => {
    if (pane === "code") useView.setState({ dockOpen: true });
  }, [pane]);
  // talking always happens in the chat
  useEffect(() => {
    if (listening) setPane("chat");
  }, [listening]);

  const tabs: { id: Pane; label: string; icon: JSX.Element; badge?: JSX.Element }[] = [
    { id: "chat", label: "Chat", icon: <Icon.Sparkle size={14} />, badge: busy ? <span className="dot pending" /> : listening ? <span className="dot fail" /> : undefined },
    { id: "model", label: "Model", icon: <Icon.Layers size={14} /> },
    { id: "code", label: "Overview", icon: <OverviewGlyph size={14} />, badge: fails || errors ? <span className="dot fail" /> : undefined },
  ];

  return (
    <div className="app phone">
      <TopBar />
      <div className="phone-ws">
        {save === "memory" && (
          <div className="banner">
            <Icon.Alert size={14} /> This browser is not keeping data. Use Export → Project file to keep your work.
          </div>
        )}
        <div className={`phone-view ${drawing ? "drawing" : ""}`}>
          <div className="plan-hud-anchor" style={{ bottom: 0 }}>
            <PlanHud />
          </div>
          <ErrorBoundary label="3D view">
            <Viewport />
          </ErrorBoundary>
          <ErrorBoundary label="Drawings">
            <DrawingView />
            <DrawingSwitch />
          </ErrorBoundary>
          <PreviewBanner />
        </div>
        <nav className="phone-tabs" role="tablist" aria-label="Panels">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={pane === t.id} className={pane === t.id ? "active" : ""} onClick={() => setPane(t.id)}>
              {t.icon}
              {t.label}
              {t.badge}
            </button>
          ))}
        </nav>
        <div className="phone-pane">
          <div className="phone-slot" hidden={pane !== "chat"}>
            <ErrorBoundary label="Chat">
              <ChatPanel />
            </ErrorBoundary>
          </div>
          <div className="phone-slot" hidden={pane !== "model"}>
            <ErrorBoundary label="Model panel">
              <LeftPanel />
            </ErrorBoundary>
          </div>
          <div className="phone-slot" hidden={pane !== "code"}>
            <ErrorBoundary label="Editor">
              <Dock projectKey={projectKey} />
            </ErrorBoundary>
          </div>
        </div>
      </div>
      <RefViewer />
      <SketchPad />
    </div>
  );
}
