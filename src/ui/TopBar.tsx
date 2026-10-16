// Top bar: navigation, project name, the live rebuild pipeline, history and export.

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import { useDesign } from "../core/engine";
import { useProject, undo, redo, renameProject, closeProject } from "../app/project";
import { openSettings, useUi } from "../app/ui";
import { useView } from "../app/view";
import { exportStep, exportStl, exportSource, exportBom, exportPng, exportProjectFile } from "../app/exports";
import { Logo } from "./Logo";
import { Icon } from "./icons";
import { Menu, MenuItem, mod } from "./common";
import { ThemeSwitch } from "./ThemeSwitch";
import { exportAllDrawings } from "../drawing/export";

export function TopBar() {
  const project = useProject((s) => s.current);
  const save = useProject((s) => s.save);
  const undoN = useProject((s) => s.undo.length);
  const redoN = useProject((s) => s.redo.length);
  const selected = useView((s) => s.selected);
  const [name, setName] = useState(project?.name ?? "");
  useEffect(() => setName(project?.name ?? ""), [project?.name]);

  return (
    <header className="topbar">
      <button className="btn ghost" style={{ padding: "0 6px" }} onClick={() => void closeProject()} aria-label="All projects" data-tip="All projects">
        <Logo size={22} />
      </button>
      <div className="sep" />
      <div className="crumbs">
        <button className="link" onClick={() => void closeProject()}>
          projects
        </button>
        <span>/</span>
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
      </div>
      <SaveState state={save} />
      <div className="grow" />
      <Pipeline />
      <div className="grow" />
      <button className="icon-btn" disabled={!undoN} onClick={undo} data-tip={`Undo (${mod}Z)`} aria-label="Undo">
        <Icon.Undo />
      </button>
      <button className="icon-btn" disabled={!redoN} onClick={redo} data-tip={`Redo (${mod}⇧Z)`} aria-label="Redo">
        <Icon.Redo />
      </button>
      <div className="sep" />
      <Menu
        align="right"
        width={270}
        trigger={(open, toggle) => (
          <button className={`btn ${open ? "primary" : ""}`} onClick={toggle} aria-haspopup="menu">
            <Icon.Download size={14} /> Export
          </button>
        )}
      >
        {(close) => {
          const run = (f: () => unknown) => () => {
            close();
            void f();
          };
          return (
            <>
              <div className="menu-label">Geometry</div>
              <MenuItem icon={<Icon.Cube size={14} />} onClick={run(() => exportStep(false))} hint=".step">
                STEP assembly (exact)
              </MenuItem>
              <MenuItem icon={<Icon.Layers size={14} />} onClick={run(() => exportStl(false))} hint=".stl">
                STL mesh for printing
              </MenuItem>
              <MenuItem icon={<Icon.Target size={14} />} onClick={run(() => exportStl(true))} disabled={!selected.length} hint=".stl">
                STL of selected parts
              </MenuItem>
              <MenuItem icon={<Icon.Target size={14} />} onClick={run(() => exportStep(true))} disabled={!selected.length} hint=".step">
                STEP of selected parts
              </MenuItem>
              <MenuItem icon={<Icon.Doc size={14} />} onClick={run(exportAllDrawings)} hint=".pdf">
                Engineering drawings
              </MenuItem>
              <div className="menu-sep" />
              <div className="menu-label">Project</div>
              <MenuItem icon={<Icon.Doc size={14} />} onClick={run(exportProjectFile)} hint=".kerfproj">
                Project file with history
              </MenuItem>
              <MenuItem icon={<Icon.Code size={14} />} onClick={run(exportSource)} hint=".kerf">
                Design source
              </MenuItem>
              <MenuItem icon={<Icon.List size={14} />} onClick={run(exportBom)} hint=".csv">
                Bill of materials
              </MenuItem>
              <MenuItem icon={<Icon.Eye size={14} />} onClick={run(exportPng)} hint=".png">
                Image of the current view
              </MenuItem>
            </>
          );
        }}
      </Menu>
      <button className="icon-btn" onClick={() => useUi.setState({ shortcutsOpen: true })} data-tip="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
        <Icon.Keyboard />
      </button>
      <ThemeSwitch />
      <button className="icon-btn" onClick={() => openSettings("ai")} data-tip="Settings" aria-label="Settings">
        <Icon.Settings />
      </button>
    </header>
  );
}

function SaveState({ state }: { state: string }) {
  const label = { saved: "saved", saving: "saving…", unsaved: "editing", error: "not saved", memory: "not persisted" }[state] ?? state;
  const color = state === "error" ? "var(--fail)" : state === "memory" ? "var(--warn)" : state === "saved" ? "var(--pass)" : "var(--accent-2)";
  return (
    <div className="save-state narrow-hide" data-tip={state === "memory" ? "This browser is not allowing storage, so work is lost when the tab closes. Export to keep it." : "Saved in this browser automatically"}>
      <span className="dot" style={{ background: color, boxShadow: state === "saved" ? "0 0 6px rgb(var(--pass-rgb) / 0.5)" : undefined }} />
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
  const tone = kernelStatus === "loading" || empty ? "" : errors || fails ? "fail" : settled ? "pass" : "";
  return (
    <button className="row narrow-hide" style={{ gap: 0, padding: "4px 6px 4px 10px", borderRadius: 20, border: "1px solid var(--line-2)", background: "var(--bg-1)", height: 30 }} onClick={() => useView.setState({ dockTab: "checks", dockOpen: true })} data-tip="Open checks" aria-label={`Pipeline: ${verdict}`}>
      {STAGES.map((s, i) => {
        const done = idx > i || (i === 0 && kernelStatus === "ready");
        const active = idx === i && stage !== "done";
        return (
          <div key={s.id} className="row" style={{ gap: 0 }}>
            <div className="row mono" style={{ gap: 5, fontSize: 10.5, color: done ? "var(--text-2)" : active ? "var(--accent-2)" : "var(--text-4)", padding: "0 4px" }}>
              <span style={{ position: "relative", width: 8, height: 8, display: "inline-grid", placeItems: "center" }}>
                <span className={`dot ${done ? "pass" : active ? "pending" : ""}`} style={{ width: 6, height: 6, boxShadow: "none" }} />
              </span>
              {s.label}
              {s.id === "building" && active && progress.total > 0 && (
                <span style={{ color: "var(--text-3)" }}>
                  {progress.done}/{progress.total}
                </span>
              )}
            </div>
            {i < STAGES.length - 1 && (
              <svg width="18" height="8" style={{ overflow: "visible" }}>
                <line x1="0" y1="4" x2="18" y2="4" stroke={idx > i ? "var(--line-3)" : "var(--line-2)"} strokeWidth="1" />
                {idx === i + 1 && stage !== "done" && <line x1="0" y1="4" x2="18" y2="4" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="4 4" style={{ animation: "dash .5s linear infinite" }} />}
              </svg>
            )}
          </div>
        );
      })}
      <AnimatePresence mode="wait">
        <motion.span key={verdict} className={`chip ${tone}`} style={{ marginLeft: 8 }} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}>
          {verdict}
          {(stage === "done" || stage === "refining") && timings.buildMs + timings.checksMs > 0 && <span className="dim"> · {((timings.evalMs + timings.buildMs + timings.checksMs) / 1000).toFixed(1)}s</span>}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
