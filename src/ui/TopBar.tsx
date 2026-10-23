// Top bar: the Kerf mark (home), the project path and version, the live
// rebuild pipeline, history and export. A light beam along the bottom edge
// shows the pipeline at a glance: it sweeps while the design rebuilds,
// flashes green when every check passes and stays red while one fails.

import { useEffect, useState } from "react";
import { useDesign } from "../core/engine";
import { useProject, undo, redo, renameProject, closeProject } from "../app/project";
import { openSettings, useUi } from "../app/ui";
import { useView } from "../app/view";
import { LogoMark } from "./Logo";
import { Icon } from "./icons";
import { mod } from "./common";
import { ExportMenu } from "./ExportMenu";
import { ThemeSwitch } from "./ThemeSwitch";
import { SyncBadge } from "./Account";
import { FindButton } from "./FindPalette";

export function TopBar() {
  const project = useProject((s) => s.current);
  const save = useProject((s) => s.save);
  const undoN = useProject((s) => s.undo.length);
  const redoN = useProject((s) => s.redo.length);
  const versions = useProject((s) => s.versions.length);
  const stage = useDesign((s) => s.stage);
  const [name, setName] = useState(project?.name ?? "");
  useEffect(() => setName(project?.name ?? ""), [project?.name]);
  const busy = stage !== "done" && stage !== "idle" && stage !== "refining";

  return (
    <header className="topbar">
      <button className="brand-btn" onClick={() => void closeProject()} aria-label="All projects" data-tip="All projects">
        <span className="brand-tile">
          <LogoMark size={24} busy={busy} />
        </span>
        <span className="logo-word intro narrow-hide">
          kerf<span className="slash">/</span>
        </span>
      </button>
      <nav className="tb-path" aria-label="Project">
        <button className="tb-crumb" onClick={() => void closeProject()}>
          projects
        </button>
        <span className="tb-slash" aria-hidden="true">
          /
        </span>
        <span className="tb-file">
          <input
            className="project-name"
            value={name}
            aria-label="Project name"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => project && name.trim() && name !== project.name && void renameProject(project.id, name)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setName(project?.name ?? "");
                (e.target as HTMLInputElement).blur();
              }
            }}
            size={Math.max(8, Math.min(40, name.length + 1))}
          />
          {versions > 0 && (
            <button className="tb-ver narrow-hide" onClick={() => useView.setState({ leftTab: "history" })} data-tip={`${versions} version${versions === 1 ? "" : "s"}: open history`} aria-label={`${versions} version${versions === 1 ? "" : "s"}, open history`}>
              <span key={versions} className="tb-ver-n">
                v{versions}
              </span>
            </button>
          )}
        </span>
      </nav>
      <SaveState state={save} />
      <SyncBadge />
      <div className="grow" />
      <Pipeline />
      <div className="grow" />
      <FindButton />
      <div className="tb-group">
        <button className="icon-btn" disabled={!undoN} onClick={undo} data-tip={`Undo (${mod}Z)`} aria-label="Undo">
          <Icon.Undo />
        </button>
        <button className="icon-btn" disabled={!redoN} onClick={redo} data-tip={`Redo (${mod}⇧Z)`} aria-label="Redo">
          <Icon.Redo />
        </button>
      </div>
      <ExportMenu />
      <button className="icon-btn" onClick={() => useUi.setState({ shortcutsOpen: true })} data-tip="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
        <Icon.Keyboard />
      </button>
      <ThemeSwitch />
      <button className="icon-btn" onClick={() => openSettings("ai")} data-tip="Settings" aria-label="Settings">
        <Icon.Settings />
      </button>
      <Beam />
    </header>
  );
}

/** The line of light along the bottom edge. */
function Beam() {
  const stage = useDesign((s) => s.stage);
  const fails = useDesign((s) => s.report?.counts.fail ?? 0);
  const errors = useDesign((s) => s.model?.diagnostics.some((d) => d.severity === "error") ?? false);
  const reportRev = useDesign((s) => s.reportRev);
  const working = stage === "evaluating" || stage === "building" || stage === "checking";
  const state = working ? "working" : errors || fails ? "fail" : stage === "done" || stage === "refining" ? "pass" : "idle";
  // a new key restarts the CSS animation, so each settled rebuild flashes once
  return <div key={state === "pass" ? `pass-${reportRev}` : state} className={`tb-beam ${state}`} aria-hidden="true" />;
}

function SaveState({ state }: { state: string }) {
  const label = { saved: "saved", saving: "saving…", unsaved: "editing", error: "not saved", memory: "not persisted" }[state] ?? state;
  return (
    <div className={`save-state ${state} narrow-hide`} data-tip={state === "memory" ? "This browser is not allowing storage, so work is lost when the tab closes. Export to keep it." : "Saved in this browser automatically"}>
      <span className="save-ico" aria-hidden="true">
        {state === "saved" ? (
          <svg key="ok" width="12" height="12" viewBox="0 0 12 12">
            <circle cx="6" cy="6" r="5.2" className="ring" />
            <path d="M3.6 6.2 5.3 7.8 8.5 4.4" className="tick" pathLength={1} />
          </svg>
        ) : state === "saving" || state === "unsaved" ? (
          <span className="save-spin" />
        ) : (
          <span className="dot" style={{ background: state === "error" ? "var(--fail)" : "var(--warn)" }} />
        )}
      </span>
      {label}
    </div>
  );
}

const STAGES = [
  { id: "evaluate", label: "eval" },
  { id: "building", label: "build" },
  { id: "checking", label: "check" },
  { id: "refining", label: "refine" },
] as const;

function Pipeline() {
  const stage = useDesign((s) => s.stage);
  const progress = useDesign((s) => s.progress);
  const report = useDesign((s) => s.report);
  const timings = useDesign((s) => s.timings);
  const kernelStatus = useDesign((s) => s.kernelStatus);
  const model = useDesign((s) => s.model);
  const errors = model?.diagnostics.filter((d) => d.severity === "error").length ?? 0;
  const idx = stage === "building" ? 1 : stage === "checking" ? 2 : stage === "refining" ? 3 : stage === "done" ? 4 : 0;
  const fails = report?.counts.fail ?? 0;
  const settled = stage === "done" || stage === "refining";
  const empty = settled && !errors && !model?.parts.length;
  const verdict = kernelStatus === "loading" ? "starting kernel" : errors ? `${errors} source error${errors > 1 ? "s" : ""}` : empty ? "empty design" : settled ? (fails ? `${fails} check${fails > 1 ? "s" : ""} failing` : "all checks pass") : "working";
  const tone = kernelStatus === "loading" || empty ? "" : errors || fails ? "fail" : settled ? "pass" : "work";
  const secs = (timings.evalMs + timings.buildMs + timings.checksMs) / 1000;
  return (
    <button className={`rail narrow-hide ${tone}`} onClick={() => useView.setState({ dockTab: "checks", dockOpen: true })} data-tip="Open checks" aria-label={`Pipeline: ${verdict}`}>
      <span className="rail-stages">
        {STAGES.map((s, i) => {
          const done = idx > i || (i === 0 && kernelStatus === "ready");
          const active = idx === i && stage !== "done";
          return (
            <span key={s.id} className="rail-step">
              <span className={`rail-stage ${done ? "done" : active ? "active" : ""}`}>
                <span className="rail-node" />
                <span className="rail-label">{s.label}</span>
                {s.id === "building" && active && progress.total > 0 && (
                  <span className="rail-count">
                    {progress.done}/{progress.total}
                  </span>
                )}
              </span>
              {i < STAGES.length - 1 && <span className={`rail-link ${idx > i ? "filled" : ""} ${idx === i + 1 && stage !== "done" ? "flow" : ""}`} />}
            </span>
          );
        })}
      </span>
      <span key={verdict} className={`rail-verdict ${tone}`}>
        {tone === "pass" ? <Icon.Check size={12} /> : tone === "fail" ? <Icon.Alert size={12} /> : tone === "work" ? <span className="rail-spin" /> : null}
        {verdict}
        {settled && timings.buildMs + timings.checksMs > 0 && <span className="rail-time"> · {secs.toFixed(1)}s</span>}
      </span>
    </button>
  );
}
