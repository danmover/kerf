// App shell: start-up, screen routing and global keyboard shortcuts.

import { MotionConfig, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useUi, go, toast } from "./app/ui";
import { useSettings, updateSettings, TERMS_VERSION, LIGHTING_IDS } from "./app/settings";
import { useProject, refreshProjects, onProjectOpen, flushPending, undo, redo } from "./app/project";
import { useView, requestCamera, type ViewPreset } from "./app/view";
import { startEngine, useDesign } from "./core/engine";
import { startAnalysisRuntime } from "./analysis/runtime";
import { startBoardRuntime } from "./machine/pcb/runtime";
import { loadRememberedKey } from "./persist/vault";
import { loadChat, useChat } from "./ai/chat";
import { Onboarding } from "./screens/Onboarding";
import { Home } from "./screens/Home";
import { Workspace } from "./screens/Workspace";
import { Legal } from "./screens/Legal";
import { SettingsModal } from "./ui/Settings";
import { ConfirmDialog, ShortcutsModal, Toasts } from "./ui/Dialogs";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { LogoMark } from "./ui/Logo";
import { toggleMarkup } from "./ui/Markup";

// each opened project brings its own conversation
onProjectOpen((p) => void loadChat(p.id));

export function App() {
  const ready = useBoot();
  const screen = useUi((s) => s.screen);
  const hasProject = useProject((s) => !!s.current);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  useShortcuts();
  useUnloadGuard();

  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reduceMotion);
  }, [reduceMotion]);

  if (!ready) return <BootSplash />;

  // legal pages opened from a project sit over it, so the open model is not torn down
  const workspaceMounted = hasProject && (screen.name === "workspace" || (screen.name === "legal" && screen.back === "workspace"));
  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      <ErrorBoundary label="Kerf" full>
        {workspaceMounted && <Workspace />}
        {!workspaceMounted && screen.name !== "legal" && (
          // fade in only: a screen never waits on the previous one's exit
          <motion.div key={screen.name} style={{ height: "100%" }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
            {screen.name === "onboarding" && <Onboarding />}
            {screen.name !== "onboarding" && <Home />}
          </motion.div>
        )}
        {screen.name === "legal" && (
          <div className="legal-layer">
            <Legal />
          </div>
        )}
        <SettingsModal />
        <ShortcutsModal />
        <ConfirmDialog />
        <Toasts />
      </ErrorBoundary>
    </MotionConfig>
  );
}

function BootSplash() {
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
      <LogoMark size={44} />
    </div>
  );
}

function useBoot() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    startEngine();
    startAnalysisRuntime();
    startBoardRuntime();
    void Promise.allSettled([loadRememberedKey(), refreshProjects()]).then(() => {
      if (!live) return;
      const s = useSettings.getState();
      go(!s.onboarded || s.termsAccepted !== TERMS_VERSION ? { name: "onboarding" } : { name: "home" });
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);
  return ready;
}

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable || !!el.closest?.(".cm-editor");
}

const CAMERA_KEYS: Record<string, ViewPreset> = { "1": "iso", "2": "front", "3": "right", "4": "top" };

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      const meta = e.metaKey || e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const inWorkspace = ui.screen.name === "workspace" && !!useProject.getState().current;

      if (meta && key === "s") {
        e.preventDefault();
        if (!inWorkspace) return;
        void flushPending().then(() => {
          const save = useProject.getState().save;
          if (save === "memory") toast({ kind: "warn", title: "This browser is not keeping data", detail: "Use Export → Project file to keep a copy." });
          else if (save !== "error") toast({ kind: "success", title: "Saved", detail: "Kerf also saves automatically after every change." }, 2500);
        });
        return;
      }
      if (ui.settingsOpen || ui.shortcutsOpen || ui.confirm || !inWorkspace) return;
      const typing = isTyping(e.target);

      if (meta && key === "k") {
        e.preventDefault();
        document.getElementById("chat-input")?.focus();
        return;
      }
      if (meta && !typing && (key === "z" || key === "y")) {
        e.preventDefault();
        if (key === "y" || e.shiftKey) redo();
        else undo();
        return;
      }
      if (meta || e.altKey || typing) return;

      const v = useView.getState();
      if (key === "Escape") {
        if (v.selected.length || v.focusCheck || v.focusParts.length) useView.setState({ selected: [], focusCheck: null, focusParts: [] });
        return;
      }
      if (key === "?") {
        e.preventDefault();
        useUi.setState({ shortcutsOpen: true });
        return;
      }
      if (key === " ") {
        if ((e.target as HTMLElement | null)?.tagName === "BUTTON") return;
        const moves = useDesign.getState().model?.parts.some((p) => p.motion && p.motion.ratio);
        if (moves) {
          e.preventDefault();
          useView.setState({ playing: !v.playing });
        }
        return;
      }
      if (CAMERA_KEYS[key]) return requestCamera(CAMERA_KEYS[key]);
      switch (key) {
        case "f":
          return requestCamera("fit");
        case "s":
          return useView.setState({ section: { ...v.section, on: !v.section.on } });
        case "e":
          return useView.setState({ explode: v.explode > 0 ? 0 : 0.5 });
        case "x":
          return useView.setState({ xray: !v.xray });
        case "m":
          return toggleMarkup();
        case "i":
          if (v.selected.length || v.isolate) useView.setState({ isolate: !v.isolate });
          return;
        case "t":
          return useView.setState({ turntable: !v.turntable });
        case "a":
          // the parts fly in from an exploded start and end assembled
          return useView.setState({ explode: 0, assemblyRequest: v.assemblyRequest + 1 });
        case "l": {
          const ids = LIGHTING_IDS;
          const cur = useSettings.getState().lighting;
          return updateSettings({ lighting: ids[(ids.indexOf(cur) + (e.shiftKey ? ids.length - 1 : 1)) % ids.length] });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Save on the way out, and warn before leaving while Claude is mid-edit. */
function useUnloadGuard() {
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flushPending();
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      void flushPending();
      if (useChat.getState().busy) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);
}
