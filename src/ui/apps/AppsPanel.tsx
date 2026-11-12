// The apps tab: the design's own control programs (app blocks), to open,
// build, run on the simulated twin or the real machine, and export as a
// program of their own.

import { useMemo } from "react";
import { useDesign } from "../../core/engine";
import { errorText, toast } from "../../app/ui";
import { appsOf, openApp, twinOptions, useApps } from "../../apps/session";
import { exportDesktopApp, exportStandaloneApp } from "../../apps/export";
import type { AppSpec } from "../../apps/spec";
import { Icon } from "../icons";
import { askClaude } from "../chatDraft";
import { AppGlyph, newAppInDesign } from "./actions";

export const BUILD_APP_ASK =
  "Build a control app for this design (an app block in the design file): live numbers, charts and status for what its firmware reports, the controls and commands it takes, a 3D view, and anything else that would make it great to run. Make the firmware print the telemetry the app needs if it does not yet. Try it on the simulated twin and tell me what it shows.";

export function AppsPanel() {
  const model = useDesign((s) => s.model);
  const open = useApps((s) => s.open);
  const apps = appsOf(model);
  if (!model) return <div className="an-body mono dim">Building the design…</div>;
  return (
    <div className="kapps">
      <div className="kapps-intro">
        <AppGlyph size={18} />
        <div>
          <b>Apps</b> are your own programs for the machine: live numbers, charts, controls, a console and the design in 3D. Run one on the machine's simulated twin, on the real one over USB, or on a finished simulation run, and save it as a program of its own.
        </div>
      </div>
      {!model.machine && <div className="kapps-note">Apps talk to the machine's firmware: add its electronics and firmware first (the build tab), or make an app that reads any USB device's lines.</div>}
      <div className="kapps-list">
        {apps.map((a) => (
          <AppCard key={a.name} app={a} active={open === a.name} />
        ))}
        {!apps.length && <div className="kapps-empty">No apps yet.</div>}
      </div>
      <div className="kapps-actions">
        <button className="btn sm primary" onClick={newAppInDesign}>
          <Icon.Plus size={12} /> New app
        </button>
        <button className="btn sm" onClick={() => askClaude(BUILD_APP_ASK)}>
          <Icon.Sparkle size={12} /> Ask Claude to build one
        </button>
      </div>
    </div>
  );
}

function AppCard({ app, active }: { app: AppSpec; active: boolean }) {
  const model = useDesign((s) => s.model);
  const ready = useDesign((s) => s.stage === "done" || s.stage === "refining");
  const twin = useMemo(() => (model && app.twin ? twinOptions(app, model) : null), [app, model, ready]);
  const twinText = !app.twin ? "no twin" : twin && "error" in twin ? `twin: ${twin.error}` : `twin: ${app.twin}`;
  const run = (f: () => Promise<unknown>) => () => {
    f().catch((e) => toast({ kind: "error", title: "Export failed", detail: errorText(e) }));
  };
  return (
    <div className={`kapps-card ${active ? "active" : ""}`}>
      <button className="kapps-open" onClick={() => openApp(app.name, { edit: false })} data-tip="Open it in the centre">
        <span className="n">{app.name}</span>
        {app.about && <span className="a">{app.about}</span>}
        <span className="m">
          {app.panels.length} panel{app.panels.length === 1 ? "" : "s"} · {twinText}
        </span>
      </button>
      <div className="kapps-btns">
        <button className="btn sm ghost" onClick={() => openApp(app.name, { edit: true })} data-tip="Add, move and change its panels">
          <Icon.Edit size={12} /> Build
        </button>
        <button className="btn sm ghost" onClick={run(() => exportStandaloneApp(app))} data-tip="One HTML file that opens in Chrome or Edge, with the twin built in">
          <Icon.Download size={12} /> .html
        </button>
        <button className="btn sm ghost" onClick={run(() => exportDesktopApp(app))} data-tip="A desktop app project (Electron) to build an installer from">
          <Icon.Box size={12} /> .zip
        </button>
      </div>
    </div>
  );
}
