// The design's sketches: how constrained each one is, its plane, the parts
// built from it. Click one to edit it in the viewport.
//
// Shaped as a left-panel tab body (`{ filter }`) so it can be registered as
// its own tab in the panel's tab list. Until then it sits under the parts as
// a collapsible section.

import { useState } from "react";
import { useDesign } from "../../core/engine";
import { commitSource } from "../../app/project";
import { revealSpan } from "../../app/view";
import { confirmDialog } from "../../app/ui";
import { deleteSketch } from "../../sketch/edits";
import { sketchStatusText } from "../../sketch/evaluate";
import { Icon } from "../icons";
import { enterSketch, startPicking, useSketch } from "./session";
import { T } from "./glyphs";
import type { EvalSketch } from "../../sketch/types";
import "./sketch.css";

const NO_SKETCHES: EvalSketch[] = [];

export function SketchesTab({ filter = "" }: { filter?: string }) {
  // a fresh [] each time would make zustand re-render without end while there is no model
  const sketches = useDesign((s) => s.model?.sketches ?? NO_SKETCHES);
  const active = useSketch((s) => s.active);
  const q = filter.trim().toLowerCase();
  const shown = sketches.filter((s) => !q || s.name.toLowerCase().includes(q) || s.usedBy.some((u) => u.toLowerCase().includes(q)));
  return (
    <div className="sk-list">
      <button className="btn sm" onClick={startPicking} style={{ alignSelf: "flex-start" }}>
        <T.Pencil size={13} /> New sketch
      </button>
      {!sketches.length && (
        <div className="muted" style={{ fontSize: 12, padding: "6px 2px" }}>
          No sketches yet. A sketch is a 2D outline on a plane, held in shape by dimensions and relations; extrude or revolve it into a part. Ask Claude to sketch something, or start one here.
        </div>
      )}
      {shown.map((sk) => {
        const st = !sk.solved ? "conflict" : sk.dof === 0 ? "defined" : "free";
        return (
          <div key={sk.name} className={`sk-item ${active === sk.name ? "active" : ""}`} role="button" tabIndex={0} onClick={() => enterSketch(sk.name)} onKeyDown={(e) => e.key === "Enter" && enterSketch(sk.name)}>
            <div className="row" style={{ gap: 6 }}>
              <b className="mono grow">{sk.name}</b>
              <button
                className="icon-btn sm"
                aria-label="Show source"
                data-tip="Show in code"
                onClick={(e) => {
                  e.stopPropagation();
                  revealSpan(sk.span);
                }}
              >
                <Icon.Code size={13} />
              </button>
              <button
                className="icon-btn sm"
                aria-label="Delete sketch"
                data-tip="Delete sketch"
                onClick={async (e) => {
                  e.stopPropagation();
                  const ok = await confirmDialog({ title: `Delete sketch ${sk.name}?`, body: sk.usedBy.length ? `${sk.usedBy.join(", ")} ${sk.usedBy.length > 1 ? "use" : "uses"} it and will show an error until you change ${sk.usedBy.length > 1 ? "them" : "it"}. Undo brings it back.` : "Undo brings it back.", confirm: "Delete", danger: true });
                  if (ok) commitSource(deleteSketch(useDesign.getState().source, sk), "you", `Deleted sketch ${sk.name}`);
                }}
              >
                <Icon.Trash size={13} />
              </button>
            </div>
            <div className="meta">
              on {sk.planeText} · {sk.curves.filter((c) => !c.construction).length} curves · {sk.constraints.length} constraints
            </div>
            <div className={`state st-${st}`}>
              <span className="dot" />
              {sketchStatusText(sk)}
            </div>
            {sk.usedBy.length > 0 && <div className="meta">used by {sk.usedBy.join(", ")}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** The sketches as a collapsible group under the parts tree. */
export function SketchesSection() {
  const n = useDesign((s) => s.model?.sketches.length ?? 0);
  const hasModel = useDesign((s) => !!s.model);
  const [open, setOpen] = useState(true);
  if (!hasModel) return null;
  return (
    <div className="tree sk-section">
      <div className="tree-group-head" onClick={() => setOpen(!open)}>
        <span style={{ transform: open ? "rotate(90deg)" : "rotate(0)", display: "inline-grid", transition: "transform .15s" }}>
          <Icon.Chevron size={11} />
        </span>
        Sketches
        <span style={{ marginLeft: "auto" }}>{n || ""}</span>
      </div>
      {open && <SketchesTab />}
    </div>
  );
}
