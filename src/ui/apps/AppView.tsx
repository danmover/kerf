// An app on Kerf's centre stage, over the 3D view: its toolbar (which link
// feeds it, connect, speed, record, build, export) and its panels. While it
// is being built the panels can be picked, dragged and resized, and the
// inspector beside them edits the selected one; every change is written into
// the design file, so the app stays design-as-code.

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useDesign } from "../../core/engine";
import { confirmDialog, errorText, toast } from "../../app/ui";
import { onProjectOpen } from "../../app/project";
import { revealSpan } from "../../app/view";
import { useDrawings } from "../../drawing/engine";
import { appNamed, appsOf, canSend, closeApp, connect, onLinkChange, openApp, replayable, resetApps, saveCsv, selectPanel, sendCommand, setEditing, setPaused, setSpeed, stopLink, storeFor, toggleRecording, twinOptions, useApps } from "../../apps/session";
import { mountApp, type MountedApp } from "../../apps/runtime/mount";
import type { AppHost } from "../../apps/runtime/panels";
import type { AppSpec } from "../../apps/spec";
import type { LinkKind } from "../../apps/links";
import { canEditPanels, movePanel, resizePanel } from "../../apps/source";
import { exportDesktopApp, exportStandaloneApp } from "../../apps/export";
import { Menu, MenuItem } from "../common";
import { Icon } from "../icons";
import { askClaude } from "../chatDraft";
import { kerfModelView } from "./modelView";
import { AddPanelMenu, Inspector } from "./Inspector";
import { AppGlyph, commitApp, newAppInDesign } from "./actions";
import "../../styles/apps.css";
import "../../styles/apps-ui.css";

const SPEEDS = [0.25, 0.5, 1, 2, 4];

// another project opens: its apps are not this one's
onProjectOpen(() => resetApps());

export function AppView() {
  const open = useApps((s) => s.open);
  // the workspace closes: stop whatever the app was running
  useEffect(() => () => resetApps(), []);
  useEffect(() => {
    // the drawings and an app share the centre: opening one closes the other
    return useDrawings.subscribe((s, p) => {
      if (s.open && !p.open && useApps.getState().open) closeApp();
    });
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const a = useApps.getState();
      if (a.edit && a.selected !== null) selectPanel(null);
      else if (a.edit) setEditing(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return <AnimatePresence>{open && <AppPane key={`app:${open}`} name={open} />}</AnimatePresence>;
}

function AppPane({ name }: { name: string }) {
  const model = useDesign((s) => s.model);
  const found = appNamed(model, name);
  // while the design rebuilds (or has an error) the app as it last was stays up
  const last = useRef<AppSpec | undefined>(found);
  if (found) last.current = found;
  const app = found ?? last.current;
  const gone = !found && !!model && !model.diagnostics.some((d) => d.severity === "error");
  const edit = useApps((s) => s.edit);
  const selected = useApps((s) => s.selected);
  const host = useRef<HTMLDivElement>(null);
  const mounted = useRef<MountedApp | null>(null);

  // mount once; later specs update it in place so the running link and the charts carry on
  useEffect(() => {
    if (!host.current || !app) return;
    const store = storeFor(app);
    const h: AppHost = {
      send: sendCommand,
      canSend,
      model: kerfModelView,
      sandboxUrl: "/app-sandbox.html",
      camera: true,
      confirm: (question) => confirmDialog({ title: question, body: "The command goes to the machine as soon as you confirm.", confirm: "Send" }),
    };
    const m = mountApp(host.current, app, store, h);
    mounted.current = m;
    const off = onLinkChange(() => m.linkChanged());
    return () => {
      off();
      m.destroy();
      mounted.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!app]);

  useEffect(() => {
    if (!app || !mounted.current) return;
    storeFor(app);
    mounted.current.update(app);
  }, [app]);

  useEffect(() => {
    const m = mounted.current;
    if (!m || !app) return;
    if (!edit) return m.setEdit(null);
    const editable = canEditPanels(app);
    m.setEdit({
      selected,
      onSelect: (i) => selectPanel(i),
      onMove: (from, to) => {
        if (!editable) return;
        commitApp(movePanel(useDesign.getState().source, app, from, to), `Moved a panel in ${app.name}`);
        selectPanel(to);
      },
      onResize: (i, w, h) => {
        if (!editable) return;
        commitApp(resizePanel(useDesign.getState().source, app, i, w, h), `Resized ${app.panels[i]?.title || "a panel"} in ${app.name}`);
      },
    });
  }, [edit, selected, app]);

  if (!app) return null;
  return (
    <motion.div className="kapp-pane" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
      <AppBar app={app} />
      {gone && (
        <div className="kapp-gone">
          <Icon.Alert size={14} /> “{name}” is no longer in the design file.
          <button className="btn sm" onClick={closeApp}>
            Close
          </button>
        </div>
      )}
      <div className={`kapp-main ${edit ? "editing" : ""}`}>
        <div className="kapp-host" ref={host} />
        {edit && <Inspector app={app} index={selected} />}
      </div>
    </motion.div>
  );
}

function AppBar({ app }: { app: AppSpec }) {
  const model = useDesign((s) => s.model);
  const link = useApps((s) => s.link);
  const status = useApps((s) => s.status);
  const speed = useApps((s) => s.speed);
  const paused = useApps((s) => s.paused);
  const recording = useApps((s) => s.recording);
  const edit = useApps((s) => s.edit);
  const replay = useApps((s) => s.replay);
  const [want, setWant] = useState<LinkKind>(link ?? (app.twin ? "twin" : "usb"));
  const kind = link ?? want;
  const live = status.state === "live" || status.state === "paused" || status.state === "connecting";
  const apps = appsOf(model);
  const replays = replayable(model);
  // working out the twin generates its firmware: once per design change, not per status update
  const stage = useDesign((s) => s.stage);
  const meshesReady = stage === "done" || stage === "refining";
  const twinWhy = useMemo(() => (model && app.twin ? twinOptions(app, model) : null), [app, model, meshesReady]);
  const twinError = !app.twin ? "This app has no simulated twin" : twinWhy && "error" in twinWhy ? twinWhy.error : null;

  const go = (k: LinkKind, opts: { replay?: string } = {}) => {
    setWant(k);
    connect(k, opts).catch((e) => toast({ kind: "error", title: "Could not connect", detail: errorText(e) }));
  };
  const run = (f: () => Promise<unknown>) => () => {
    f().catch((e) => toast({ kind: "error", title: "Export failed", detail: errorText(e) }));
  };
  const led = status.state === "live" ? "live" : status.state === "paused" ? "paused" : status.state === "connecting" ? "busy" : status.state === "error" ? "error" : "off";
  const rate = status.rate !== undefined && link === "twin" && status.state === "live" ? (status.behind ? `can only run at ${status.rate.toFixed(2)}×` : `${status.rate.toFixed(2)}×`) : "";

  return (
    <div className="kapp-bar" role="toolbar" aria-label="App controls">
      <Menu
        width={280}
        trigger={(o, toggle) => (
          <button className={`kapp-name ${o ? "active" : ""}`} onClick={toggle} aria-haspopup="menu" data-tip={app.about ?? "Choose an app"}>
            <AppGlyph size={15} />
            <span className="t">{app.name}</span>
            <Icon.ChevronDown size={12} />
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="menu-label">Apps in this design</div>
            {apps.map((a) => (
              <MenuItem
                key={a.name}
                icon={<AppGlyph size={14} />}
                hint={`${a.panels.length} panel${a.panels.length === 1 ? "" : "s"}`}
                onClick={() => {
                  openApp(a.name);
                  close();
                }}
              >
                {a.name}
              </MenuItem>
            ))}
            <MenuItem
              icon={<Icon.Plus size={14} />}
              onClick={() => {
                close();
                newAppInDesign();
              }}
            >
              New app
            </MenuItem>
          </>
        )}
      </Menu>

      <div className="kapp-links segmented" role="radiogroup" aria-label="Where the data comes from">
        {(["twin", "usb", "replay"] as LinkKind[]).map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={kind === k}
            className={kind === k ? "active" : ""}
            disabled={(k === "twin" && !app.twin) || (k === "replay" && !replays.length)}
            onClick={() => (link ? go(k) : setWant(k))}
            data-tip={k === "twin" ? (twinError ?? `The machine simulated: its firmware runs in the “${app.twin}” world in real time`) : k === "usb" ? "The real machine over a USB cable (Chrome, Edge or the desktop app)" : replays.length ? "Play back a finished simulation run" : "Run a simulation scenario first"}
          >
            <span>{k === "twin" ? "Twin" : k === "usb" ? "USB" : "Replay"}</span>
          </button>
        ))}
      </div>
      {kind === "replay" && replays.length > 1 && (
        <select className="kapp-select" value={replay ?? replays[0]} onChange={(e) => go("replay", { replay: e.target.value })} aria-label="Which run to play">
          {replays.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      )}
      {live ? (
        <button className="btn sm" onClick={stopLink} data-tip="Disconnect">
          <Icon.Stop size={12} /> Stop
        </button>
      ) : (
        <button className="btn sm primary" onClick={() => go(kind)} disabled={kind === "twin" && !!twinError} data-tip={kind === "twin" && twinError ? twinError : undefined}>
          <Icon.Play size={12} /> {kind === "usb" ? "Connect" : kind === "twin" ? "Start twin" : "Play"}
        </button>
      )}
      <span className={`kapp-status ${led}`} title={status.text}>
        <i />
        <span className="t">{status.text || (kind === "usb" ? "not connected" : "stopped")}</span>
        {rate && <span className={`r ${status.behind ? "behind" : ""}`}>{rate}</span>}
      </span>
      {(link === "twin" || link === "replay") && live && (
        <>
          <button className="icon-btn" onClick={() => setPaused(!paused)} aria-pressed={paused} data-tip={paused ? "Carry on" : "Pause"} aria-label={paused ? "Carry on" : "Pause"}>
            {paused ? <Icon.Play /> : <Icon.Pause />}
          </button>
          <select className="kapp-select" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed" data-tip="How fast simulated time runs">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </>
      )}
      <div className="grow" />
      <button className={`icon-btn kapp-rec ${recording ? "on" : ""}`} onClick={toggleRecording} aria-pressed={recording} data-tip={recording ? "Stop recording and save the CSV" : "Record every value to a CSV file"} aria-label="Record">
        <i />
      </button>
      <button className="icon-btn" onClick={saveCsv} data-tip="Save the last minute as a CSV file" aria-label="Save CSV">
        <Icon.Download />
      </button>
      <div className="sep" />
      {edit && <AddPanelMenu app={app} />}
      <button className={`btn sm ${edit ? "primary" : "ghost"}`} onClick={() => setEditing(!edit)} aria-pressed={edit} data-tip={edit ? "Done building (Esc)" : "Add, move, resize and change panels"}>
        <Icon.Edit size={12} /> {edit ? "Done" : "Build"}
      </button>
      <button className="icon-btn" onClick={() => revealSpan(app.span)} data-tip="Edit this app in the design file" aria-label="Edit in the source">
        <Icon.Code />
      </button>
      <button
        className="icon-btn"
        onClick={() => askClaude(`Improve the app “${app.name}”: `)}
        data-tip="Ask Claude to change this app"
        aria-label="Ask Claude"
      >
        <Icon.Sparkle />
      </button>
      <Menu
        align="right"
        width={300}
        trigger={(o, toggle) => (
          <button className={`icon-btn ${o ? "active" : ""}`} onClick={toggle} data-tip="Make it a program of its own" aria-label="Export the app">
            <Icon.Upload />
          </button>
        )}
      >
        {(close) => {
          const go2 = (f: () => Promise<unknown>) => () => {
            close();
            run(f)();
          };
          return (
            <>
              <div className="menu-label">Make it a program of its own</div>
              <MenuItem icon={<Icon.Doc size={14} />} onClick={go2(() => exportStandaloneApp(app))} hint=".html">
                One file that opens in Chrome or Edge
              </MenuItem>
              <MenuItem icon={<Icon.Box size={14} />} onClick={go2(() => exportDesktopApp(app))} hint=".zip">
                Desktop app project (Electron)
              </MenuItem>
            </>
          );
        }}
      </Menu>
      <button className="icon-btn" onClick={closeApp} data-tip="Back to the 3D view" aria-label="Close the app">
        <Icon.X />
      </button>
    </div>
  );
}
