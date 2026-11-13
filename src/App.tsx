// App shell: start-up, screen routing and global keyboard shortcuts.

import { MotionConfig, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useUi, go, toast } from "./app/ui";
import { useSettings, updateSettings, TERMS_VERSION, LIGHTING_IDS } from "./app/settings";
import { bindingOf, commandFor } from "./app/keymap";
import { useProject, refreshProjects, onProjectOpen, flushPending, undo, redo } from "./app/project";
import { useView, requestCamera, toggleCode, type ViewPreset } from "./app/view";
import { startEngine, useDesign } from "./core/engine";
import { turns } from "./core/model";
import { startAnalysisRuntime } from "./analysis/runtime";
import { startAirflowRuntime } from "./analysis/aeroRuntime";
import { startFlowRuntime } from "./analysis/flowRuntime";
import { startBoardRuntime } from "./machine/pcb/runtime";
import { startCableRuntime } from "./machine/harness/runtime";
import "./core/sweepRuntime";
import { startSimRuntime } from "./sim/runtime";
import { startScripts } from "./scripts/runtime";
import { startLearn } from "./learn/runtime";
import { startFirmwareDebug } from "./app/firmwareDebug";
import { loadRememberedKey } from "./persist/vault";
import { loadOpenAIKey } from "./persist/openaiVault";
import { loadChat, useChat } from "./ai/chat";
import { Onboarding } from "./screens/Onboarding";
import { Home } from "./screens/Home";
import { Workspace } from "./screens/Workspace";
import { Legal } from "./screens/Legal";
import { SettingsModal } from "./ui/Settings";
import { ConfirmDialog, ShortcutsModal, Toasts } from "./ui/Dialogs";
import { FilmMaker } from "./ui/film/FilmMaker";
import { FindPalette } from "./ui/FindPalette";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { LogoMark } from "./ui/Logo";
import { AuthDialog } from "./ui/Account";
import { initAccount } from "./cloud/account";
import { startSync } from "./cloud/sync";
import { toggleMarkup } from "./ui/Markup";
import { toggleWiring } from "./ui/wiringView";
import { startMaterialChecks } from "./materials/runtime";
import { startAssemblyChecks } from "./mfg/dfaRuntime";
import { startHeatAndWearChecks } from "./machine/runtime";
import { useThemeSync } from "./app/theme";
import { ContextMenuHost } from "./ui/ContextMenu";

// each opened project brings its own conversation
onProjectOpen((p) => void loadChat(p.id));

export function App() {
  const ready = useBoot();
  const screen = useUi((s) => s.screen);
  const hasProject = useProject((s) => !!s.current);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  useThemeSync();
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
        <AuthDialog />
        <ShortcutsModal />
        <FindPalette />
        <FilmMaker />
        <ConfirmDialog />
        <ContextMenuHost />
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
    startMaterialChecks();
    startAssemblyChecks();
    startHeatAndWearChecks();
    startAnalysisRuntime();
    startAirflowRuntime();
    startFlowRuntime();
    startBoardRuntime();
    startCableRuntime();
    startSimRuntime();
    startFirmwareDebug();
    startScripts(() => useChat.getState().busy);
    startLearn();
    void Promise.allSettled([loadRememberedKey(), loadOpenAIKey(), refreshProjects(), initAccount()]).then(() => {
      startSync();
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

/** the standard views' commands (see app/keymap) */
const VIEW_COMMANDS: Record<string, ViewPreset> = { "view.iso": "iso", "view.front": "front", "view.right": "right", "view.top": "top", "view.back": "back", "view.left": "left", "view.bottom": "bottom" };

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
      // the find palette opens from anywhere, even mid-sentence in the chat
      if (meta && key === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!ui.settingsOpen && !ui.confirm) useUi.setState({ findOpen: !ui.findOpen, shortcutsOpen: false });
        return;
      }
      if (ui.findOpen) return;
      const typing = isTyping(e.target);
      if (key === "/" && !meta && !e.altKey && !typing && !ui.settingsOpen && !ui.shortcutsOpen && !ui.confirm) {
        e.preventDefault();
        useUi.setState({ findOpen: true });
        return;
      }
      if (ui.settingsOpen || ui.shortcutsOpen || ui.confirm || !inWorkspace) return;
      if (meta && !typing && (key === "z" || key === "y")) {
        e.preventDefault();
        if (key === "y" || e.shiftKey) redo();
        else undo();
        return;
      }
      if (typing) return;

      const v = useView.getState();
      if (key === "Escape") {
        if (meta || e.altKey) return;
        if (v.selected.length || v.focusCheck || v.focusParts.length) useView.setState({ selected: [], focusCheck: null, focusParts: [] });
        return;
      }
      // the keys the user may have moved (Settings, or the shortcut sheet); the tools with their own
      // listeners (voice, measure, the selection filter, box select, handles, drawings) look theirs up there
      const binding = bindingOf(e);
      const cmd = commandFor(binding, useSettings.getState().keys);
      if (!cmd) return;
      if (binding !== null && /^(mod|alt)\+/.test(binding)) e.preventDefault();
      if (VIEW_COMMANDS[cmd]) return requestCamera(VIEW_COMMANDS[cmd]);
      switch (cmd) {
        case "shortcuts":
          e.preventDefault();
          return useUi.setState({ shortcutsOpen: true });
        case "play": {
          if ((e.target as HTMLElement | null)?.tagName === "BUTTON") return;
          const moves = useDesign.getState().model?.parts.some((p) => turns(p.motion));
          if (moves) {
            e.preventDefault();
            useView.setState({ playing: !v.playing });
          }
          return;
        }
        case "fit":
          return requestCamera("fit");
        case "section":
          return useView.setState({ section: { ...v.section, on: !v.section.on } });
        case "explode":
          return useView.setState({ explode: v.explode > 0 ? 0 : 1 });
        case "xray":
          return useView.setState({ xray: !v.xray });
        case "wiring":
          return toggleWiring();
        case "markup":
          return toggleMarkup();
        case "code":
          return toggleCode();
        case "isolate":
          if (v.selected.length || v.isolate) useView.setState({ isolate: !v.isolate });
          return;
        case "group.solo": {
          // the selected part's group on its own; again shows every group
          const part = useDesign.getState().model?.parts.find((p) => p.id === v.selected[0]);
          if (!part || (v.soloGroups.length === 1 && v.soloGroups[0] === part.group)) return useView.setState({ soloGroups: [] });
          return useView.setState({ soloGroups: [part.group] });
        }
        case "group.all":
          return useView.setState({ soloGroups: [] });
        case "turntable":
          return useView.setState({ turntable: !v.turntable });
        case "photoreal":
          return updateSettings({ photoreal: !useSettings.getState().photoreal });
        case "assembly":
          // the parts fly in from an exploded start and end assembled
          return useView.setState({ explode: 0, assemblyRequest: v.assemblyRequest + 1 });
        case "lighting.next":
        case "lighting.prev": {
          const ids = LIGHTING_IDS;
          const cur = useSettings.getState().lighting;
          return updateSettings({ lighting: ids[(ids.indexOf(cur) + (cmd === "lighting.prev" ? ids.length - 1 : 1)) % ids.length] });
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
