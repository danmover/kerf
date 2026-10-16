// Sketch editor chrome: the header with the sketch's state, the tool
// palette, the selection panel with relations and dimensions to add, the
// panel that turns a sketch into a solid, and the plane picker for new
// sketches.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SceneController } from "../viewport/scene";
import { useDesign } from "../../core/engine";
import { commitSource } from "../../app/project";
import { select } from "../../app/view";
import { toast } from "../../app/ui";
import { addFeature, addStatements, deleteSelection, entitiesOf, suggestionsFor, toggleConstruction, fmt, type FeatureSpec } from "../../sketch/edits";
import { sketchStatusText } from "../../sketch/evaluate";
import type { EvalSketch } from "../../sketch/types";
import { useChatDraft } from "../chatDraft";
import { Icon } from "../icons";
import { Segmented } from "../common";
import { editSketch, exitSketch, createSketch, setSelection, setTool, useSketch, type SketchTool } from "./session";
import { SketchOverlay, faceSketch } from "./SketchOverlay";
import { T } from "./glyphs";
import "./sketch.css";

/** Everything sketch-related in the viewport. Mounted by the viewport once its scene exists. */
export function SketchLayer({ ctl }: { ctl: SceneController }) {
  const active = useSketch((s) => s.active);
  const picking = useSketch((s) => s.picking);
  const model = useDesign((d) => d.model);
  const sk = active ? (model?.sketches.find((x) => x.name === active) ?? null) : null;
  useEffect(() => {
    if (active || picking) select([]);
  }, [active, picking]);
  return (
    <>
      {active && <SketchOverlay ctl={ctl} />}
      {picking && <PlanePicker ctl={ctl} />}
      <AnimatePresence>
        {sk && <SketchHeader key="hdr" sk={sk} ctl={ctl} />}
        {sk && <ToolPalette key="tools" />}
        {sk && <SidePanel key="side" sk={sk} />}
        {sk && <HintBar key="hint" />}
      </AnimatePresence>
    </>
  );
}

// ---------------- header ----------------

function SketchHeader({ sk, ctl }: { sk: EvalSketch; ctl: SceneController }) {
  const feature = useSketch((s) => s.feature);
  const empty = !sk.curves.some((c) => !c.external) && !sk.points.some((p) => !p.implicit);
  const state = empty ? "free" : !sk.solved ? "conflict" : sk.dof === 0 ? "defined" : "free";
  const usedBy = sk.usedBy;
  const regions = sk.profile.regions.length;
  const short = empty ? "empty" : sk.tooBig ? "too big to solve" : !sk.solved ? "conflict" : sk.dof === 0 ? "fully defined" : `${sk.dof} free`;
  const shape = empty ? "pick a tool on the left" : sk.profile.error ? "profile problem" : regions ? `${regions > 1 ? `${regions} regions · ` : ""}${fmt(Math.round(sk.profile.area * 10) / 10)} mm²` : "open outline";
  return (
    <motion.div className="sk-ui sk-header vp-float" style={{ x: "-50%" }} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
      <div className="row sk-header-row">
        <span className="sk-badge">
          <T.Pencil size={13} /> sketch
        </span>
        <b className="mono">{sk.name}</b>
        <span className="mono muted">{sk.planeText}</span>
        <span className={`sk-state st-${state}`} data-tip={`${sketchStatusText(sk)}${state === "free" ? ". Blue points can still move: drag them, or add dimensions and relations." : ""}`}>
          <span className="dot" />
          {short} · {shape}
        </span>
        {usedBy.length > 0 && (
          <span className="sk-usedby mono" data-tip={`Edits rebuild ${usedBy.join(", ")} live`}>
            → {usedBy.join(", ")}
          </span>
        )}
        <div className="grow" />
        <button className="icon-btn sm" onClick={() => faceSketch(ctl, sk)} data-tip="Look straight at the sketch (N)" aria-label="Look at the sketch">
          <T.Normal size={14} />
        </button>
        <button className={`btn sm ${feature ? "primary" : ""}`} onClick={() => useSketch.setState({ feature: !feature })} disabled={!regions} data-tip={regions ? "Extrude or revolve this sketch" : "Close the outline first"}>
          <Icon.Box size={13} /> Make solid
        </button>
        <button className="btn sm primary" onClick={exitSketch} data-tip="Finish editing (Enter)">
          <Icon.Check size={13} /> Done
        </button>
      </div>
      {sk.message && (
        <div className="sk-problem">
          <span>{sk.message}</span>
          {sk.constraints.some((c) => c.status === "conflict") && (
            <button
              className="btn sm danger"
              onClick={() => {
                const c = sk.constraints.find((q) => q.status === "conflict")!;
                editSketch((src, cur) => deleteSelection(src, cur, [`#${c.index}`]), "removed the conflicting constraint");
              }}
            >
              Remove it
            </button>
          )}
        </div>
      )}
      {!sk.message && sk.profile.error && <div className="sk-problem warn">{sk.profile.error.message}</div>}
      {!sk.message && !sk.profile.error && sk.profile.open && <div className="sk-problem note">{sk.profile.open.message}</div>}
    </motion.div>
  );
}

// ---------------- tools ----------------

const TOOLS: { id: SketchTool; label: string; key: string; icon: ReactNode; help: string }[] = [
  { id: "select", label: "Select", key: "V", icon: <T.Pointer />, help: "Click or box-select geometry. Drag points and curves; the constraints keep holding." },
  { id: "line", label: "Line", key: "L", icon: <T.Line />, help: "Click points to draw connected lines. Type a length and press Enter. Double-click or Esc to stop." },
  { id: "rect", label: "Rectangle", key: "R", icon: <T.Rect />, help: "Click two corners. Type width, height (40,25) and press Enter for an exact size." },
  { id: "circle", label: "Circle", key: "C", icon: <T.Circle />, help: "Click the centre, then the radius. Type a diameter and press Enter for an exact size." },
  { id: "arc", label: "Arc", key: "A", icon: <T.Arc />, help: "Click the start, the end, then a point the arc passes through. Starting on a line end makes it tangent." },
  { id: "slot", label: "Slot", key: "O", icon: <T.Slot />, help: "Click the two centres, then the width." },
  { id: "point", label: "Point", key: "P", icon: <T.Point />, help: "Click to place a reference point." },
  { id: "dimension", label: "Dimension", key: "D", icon: <T.Dim />, help: "Click one item to size it, or two to measure between them. Type the value, or a formula like w / 2." },
];

function ToolPalette() {
  const tool = useSketch((s) => s.tool);
  const construction = useSketch((s) => s.construction);
  return (
    <motion.div className="sk-ui sk-tools vp-float" style={{ y: "-50%" }} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} role="toolbar" aria-label="Sketch tools">
      {TOOLS.map((t) => (
        <button key={t.id} className={`icon-btn ${tool === t.id ? "active" : ""}`} onClick={() => setTool(t.id)} data-tip={`${t.label} (${t.key})`} aria-label={t.label} aria-pressed={tool === t.id}>
          {t.icon}
        </button>
      ))}
      <div className="sep" />
      <button className={`icon-btn ${construction ? "active warnish" : ""}`} onClick={() => useSketch.setState({ construction: !construction })} data-tip="Draw construction geometry (G)" aria-label="Construction geometry" aria-pressed={construction}>
        <T.Construction />
      </button>
    </motion.div>
  );
}

function HintBar() {
  const tool = useSketch((s) => s.tool);
  const hint = useSketch((s) => s.hint);
  const help = hint || TOOLS.find((t) => t.id === tool)?.help || "";
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => useSketch.setState({ hint: "" }), 6000);
    return () => clearTimeout(t);
  }, [hint]);
  return (
    <motion.div className={`sk-ui sk-hint ${hint ? "flash" : ""}`} style={{ x: "-50%" }} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}>
      <AnimatePresence mode="wait">
        <motion.span key={help} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          {help}
        </motion.span>
      </AnimatePresence>
    </motion.div>
  );
}

// ---------------- selection / feature panel ----------------

function SidePanel({ sk }: { sk: EvalSketch }) {
  const feature = useSketch((s) => s.feature);
  const selection = useSketch((s) => s.selection);
  if (feature) return <FeaturePanel sk={sk} />;
  if (selection.length) return <SelectionPanel sk={sk} selection={selection} />;
  return null;
}

function describe(sk: EvalSketch, id: string): string {
  if (id.startsWith("#")) {
    const c = sk.constraints.find((q) => `#${q.index}` === id);
    return c ? `${c.kind} ${c.args.join(", ")}${c.valueText ? ` = ${c.valueText}` : ""}` : id;
  }
  const c = sk.curves.find((q) => q.id === id);
  const P = (pid: string) => sk.points.find((p) => p.id === pid)!;
  if (c?.kind === "line") {
    const a = P(c.pts[0]);
    const b = P(c.pts[1]);
    return `line · ${fmt(Math.hypot(b.x - a.x, b.y - a.y))} mm`;
  }
  if (c?.kind === "circle") return `circle · ⌀${fmt(2 * c.r!)}`;
  if (c?.kind === "arc") {
    const a = P(c.pts[0]);
    const m = P(c.pts[2]);
    return `arc · R${fmt(Math.hypot(a.x - m.x, a.y - m.y))}`;
  }
  const p = sk.points.find((q) => q.id === id);
  return p ? `point · (${fmt(p.x)}, ${fmt(p.y)})` : id;
}

const STATUS_WORD: Record<string, string> = { free: "can still move", defined: "fully defined", fixed: "fixed", conflict: "in conflict" };

function SelectionPanel({ sk, selection }: { sk: EvalSketch; selection: string[] }) {
  const setDraft = useChatDraft((s) => s.set);
  const sugs = useMemo(() => suggestionsFor(sk, selection), [sk, selection]);
  const ents = entitiesOf(sk, selection);
  const cons = selection.filter((id) => id.startsWith("#"));
  const relations = sugs.filter((s) => !s.dimension);
  const dims = sugs.filter((s) => s.dimension && s.kind !== "fillet" && s.kind !== "chamfer");
  const corners = sugs.filter((s) => s.kind === "fillet" || s.kind === "chamfer");
  const add = (stmt: string, dimension: boolean) => {
    const before = sk.constraints.length;
    const next = editSketch((src, cur) => addStatements(src, cur, { constraints: [stmt] }), `added ${stmt}`);
    if (dimension && next) {
      const c = next.constraints.filter((q) => q.index >= before).pop();
      if (c) useSketch.setState({ editDim: c.index, selection: [`#${c.index}`] });
    }
  };
  const curves = ents.filter((e) => e.c);
  const status = ents.length === 1 ? (ents[0].c?.status ?? ents[0].p?.status) : undefined;
  return (
    <motion.div className="sk-ui sk-side vp-float" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <b className="mono grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selection.length === 1 ? selection[0].replace(/^#\d+$/, "constraint") : `${selection.length} selected`}
        </b>
        <button className="icon-btn sm" onClick={() => setSelection([])} aria-label="Clear selection">
          <Icon.X size={14} />
        </button>
      </div>
      <div className="mono muted sk-desc">
        {selection.slice(0, 4).map((id) => (
          <div key={id}>{describe(sk, id)}</div>
        ))}
        {status && <div className={`sk-st st-${status}`}>{STATUS_WORD[status]}</div>}
      </div>
      {relations.length > 0 && (
        <Group title="Relations">
          {relations.map((s) => (
            <button key={s.stmt} className="btn sm" onClick={() => add(s.stmt, false)} data-tip={s.stmt}>
              {s.label}
              {s.key && <span className="kbd">{s.key.toUpperCase()}</span>}
            </button>
          ))}
        </Group>
      )}
      {dims.length > 0 && (
        <Group title="Dimensions">
          {dims.map((s) => (
            <button key={s.stmt} className="btn sm" onClick={() => add(s.stmt, true)} data-tip={s.stmt}>
              {s.label} <span className="mono muted">{s.stmt.split("= ")[1]}</span>
            </button>
          ))}
        </Group>
      )}
      {corners.length > 0 && (
        <Group title="Corner">
          {corners.map((s) => (
            <button key={s.stmt} className="btn sm" onClick={() => add(s.stmt, true)} data-tip={`${s.stmt} — dimensions keep measuring to the sharp corner`}>
              {s.label} <span className="mono muted">{s.stmt.split("= ")[1]}</span>
            </button>
          ))}
        </Group>
      )}
      <div className="row sk-actions">
        {curves.length > 0 && (
          <button className="btn sm" onClick={() => editSketch((src, cur) => toggleConstruction(src, cur, curves.map((c) => c.id)), "toggled construction")} data-tip="Construction geometry guides the sketch but is not part of the profile (G)">
            <T.Construction size={13} /> {curves.every((c) => c.c!.construction) ? "Make solid" : "Construction"}
          </button>
        )}
        <button
          className="btn sm"
          onClick={() => {
            setSelection([]);
            editSketch((src, cur) => deleteSelection(src, cur, selection), `deleted ${selection.length > 1 ? `${selection.length} items` : describe(sk, selection[0])}`);
          }}
          data-tip="Delete (⌫). Lines that started at deleted geometry keep their position."
        >
          <Icon.Trash size={13} /> Delete
        </button>
        <button className="btn sm" onClick={() => setDraft(`In sketch ${sk.name}, about ${selection.map((id) => (id.startsWith("#") ? describe(sk, id) : id)).join(", ")}: `)} data-tip="Ask Claude about the selection">
          <Icon.Sparkle size={13} /> Ask
        </button>
      </div>
      {cons.length === 0 && relations.length === 0 && dims.length === 0 && <div className="muted" style={{ fontSize: 12 }}>Select a second item to relate it to this one.</div>}
    </motion.div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="sk-group">
      <div className="field-label">{title}</div>
      <div className="sk-chips">{children}</div>
    </div>
  );
}

function FeaturePanel({ sk }: { sk: EvalSketch }) {
  const model = useDesign((d) => d.model);
  const parts = useMemo(() => [...new Set(model?.parts.filter((p) => p.kind === "part").map((p) => p.name) ?? [])], [model]);
  const lines = sk.curves.filter((c) => c.kind === "line").sort((a, b) => Number(b.construction) - Number(a.construction));
  const [kind, setKind] = useState<"extrude" | "revolve">("extrude");
  const [op, setOp] = useState<"new" | "add" | "cut">(sk.usedBy.length ? "add" : "new");
  const [part, setPart] = useState(sk.usedBy[0] ?? parts[0] ?? "");
  const [depth, setDepth] = useState("10");
  const [dir, setDir] = useState<"normal" | "reverse" | "both">("normal");
  const [through, setThrough] = useState(false);
  const [asParam, setAsParam] = useState(true);
  const [axis, setAxis] = useState(lines.find((l) => l.construction)?.id ?? "y_axis");
  const [angle, setAngle] = useState("360");
  const depthRef = useRef<HTMLInputElement>(null);
  useEffect(() => depthRef.current?.focus(), []);
  useEffect(() => {
    if (op === "cut") setThrough(true);
  }, [op]);
  const d = Number(depth);
  const a = Number(angle);
  const bad = !sk.profile.regions.length ? sk.profile.error?.message ?? "The sketch has no closed profile yet." : op !== "new" && !part ? "Pick a part." : kind === "extrude" && !through && !(d > 0) ? "Depth must be a positive number." : kind === "revolve" && !(a > 0 && a <= 360) ? "Angle must be between 0 and 360." : "";
  const create = () => {
    if (bad) return;
    const spec: FeatureSpec = { kind, op, part: op === "new" ? undefined : part, depth: d, reverse: dir === "reverse", symmetric: dir === "both", through: kind === "extrude" && through, axis, angle: a, param: asParam };
    try {
      const src = useDesign.getState().source;
      const r = addFeature(src, sk, spec);
      const what = kind === "extrude" ? (through ? "through all" : `${fmt(d)} mm`) : `${fmt(a)}°`;
      const m = commitSource(r.src, "you", `${kind === "extrude" ? "Extruded" : "Revolved"} ${sk.name} ${what} ${op === "new" ? `into new part ${r.part}` : op === "add" ? `onto ${r.part}` : `out of ${r.part}`}`);
      exitSketch();
      const err = m.diagnostics.find((x) => x.severity === "error");
      if (err) toast({ kind: "warn", title: "The new feature has a problem", detail: err.message }, 8000);
      else toast({ kind: "success", title: `${op === "new" ? "Created" : "Updated"} ${r.part}`, detail: r.param ? `The depth is parameter ${r.param}; drag its slider in the params tab to adjust it.` : undefined });
      select(m.parts.filter((p) => p.name === r.part).map((p) => p.id));
    } catch (e) {
      toast({ kind: "error", title: "Could not add the feature", detail: (e as Error).message });
    }
  };
  return (
    <motion.div className="sk-ui sk-side vp-float sk-feature" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} onKeyDown={(e) => e.key === "Enter" && create()}>
      <div className="row" style={{ marginBottom: 8 }}>
        <b className="grow">Make a solid from {sk.name}</b>
        <button className="icon-btn sm" onClick={() => useSketch.setState({ feature: false })} aria-label="Close">
          <Icon.X size={14} />
        </button>
      </div>
      <Segmented
        id="sk-kind"
        value={kind}
        onChange={setKind}
        options={[
          { value: "extrude", label: "Extrude" },
          { value: "revolve", label: "Revolve" },
        ]}
      />
      <div className="sk-field">
        <span className="field-label">Result</span>
        <Segmented
          id="sk-op"
          value={op}
          onChange={setOp}
          options={[
            { value: "new", label: "New part" },
            { value: "add", label: "Add to", title: parts.length ? undefined : "No parts yet" },
            { value: "cut", label: "Cut from", title: parts.length ? undefined : "No parts yet" },
          ]}
        />
        {op !== "new" && (
          <select className="input" value={part} onChange={(e) => setPart(e.target.value)} aria-label="Part">
            {parts.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
      </div>
      {kind === "extrude" ? (
        <>
          <div className="sk-field">
            <span className="field-label">Depth</span>
            <div className="row" style={{ gap: 6 }}>
              <input ref={depthRef} className="input mono" style={{ width: 90 }} value={through ? "" : depth} placeholder={through ? "through all" : ""} disabled={through} onChange={(e) => setDepth(e.target.value)} aria-label="Depth in mm" />
              <span className="muted">mm</span>
              <label className="sk-check">
                <input type="checkbox" checked={through} onChange={(e) => setThrough(e.target.checked)} /> through all
              </label>
            </div>
          </div>
          {!through && (
            <div className="sk-field">
              <span className="field-label">Direction</span>
              <Segmented
                id="sk-dir"
                value={dir}
                onChange={setDir}
                options={[
                  { value: "normal", label: "Out", title: "Along the plane's normal" },
                  { value: "reverse", label: "In", title: "Against the plane's normal" },
                  { value: "both", label: "Both sides", title: "Half each way" },
                ]}
              />
            </div>
          )}
          {!through && (
            <label className="sk-check">
              <input type="checkbox" checked={asParam} onChange={(e) => setAsParam(e.target.checked)} /> keep the depth as a parameter (slider)
            </label>
          )}
        </>
      ) : (
        <>
          <div className="sk-field">
            <span className="field-label">Axis</span>
            <select className="input mono" value={axis} onChange={(e) => setAxis(e.target.value)} aria-label="Axis">
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.id}
                  {l.construction ? " (construction)" : ""}
                </option>
              ))}
              <option value="y_axis">y_axis</option>
              <option value="x_axis">x_axis</option>
            </select>
          </div>
          <div className="sk-field">
            <span className="field-label">Angle</span>
            <div className="row" style={{ gap: 6 }}>
              <input className="input mono" style={{ width: 90 }} value={angle} onChange={(e) => setAngle(e.target.value)} aria-label="Angle in degrees" />
              <span className="muted">degrees</span>
            </div>
          </div>
        </>
      )}
      <div className="sk-preview mono">{previewCode(sk, { kind, op, part, depth: d, dir, through, axis, angle: a, asParam })}</div>
      {bad && <div className="sk-problem warn">{bad}</div>}
      <button className="btn primary" style={{ width: "100%", marginTop: 8 }} disabled={!!bad} onClick={create}>
        <Icon.Check size={14} /> {op === "new" ? "Create part" : op === "add" ? `Add to ${part}` : `Cut from ${part}`}
      </button>
    </motion.div>
  );
}

function previewCode(sk: EvalSketch, o: { kind: string; op: string; part: string; depth: number; dir: string; through: boolean; axis: string; angle: number; asParam: boolean }) {
  const depth = o.asParam ? `${sk.name}_depth` : fmt(o.depth || 0);
  const expr =
    o.kind === "extrude"
      ? o.through
        ? `extrude(${sk.name}, through: true)`
        : `extrude(${sk.name}, ${depth}${o.dir === "reverse" ? ", reverse: true" : o.dir === "both" ? ", symmetric: true" : ""})`
      : `revolve(${sk.name}, axis: ${sk.name}.${o.axis}${o.angle !== 360 ? `, angle: ${fmt(o.angle)}` : ""})`;
  return o.op === "new" ? `body ${expr}` : `${o.op} ${expr}   // in ${o.part}`;
}

// ---------------- plane picker ----------------

type PlanePick = { plane: string; offset?: number; label: string; poly: { x: number; y: number }[] };

const NAMED: { n: [number, number, number]; plane: string }[] = [
  { n: [0, 0, 1], plane: "XY" },
  { n: [0, 0, -1], plane: "-XY" },
  { n: [0, -1, 0], plane: "XZ" },
  { n: [0, 1, 0], plane: "-XZ" },
  { n: [1, 0, 0], plane: "YZ" },
  { n: [-1, 0, 0], plane: "-YZ" },
];

/** A face under the cursor as a sketch plane: a named plane with an offset when it is axis-aligned. */
function planeForFace(point: [number, number, number], normal: [number, number, number]): { plane: string; offset?: number; label: string } {
  for (const k of NAMED) {
    const dot = k.n[0] * normal[0] + k.n[1] * normal[1] + k.n[2] * normal[2];
    if (dot > 0.9999) {
      const off = Math.round((k.n[0] * point[0] + k.n[1] * point[1] + k.n[2] * point[2]) * 1000) / 1000;
      return { plane: k.plane, offset: off || undefined, label: `face · ${k.plane}${off ? ` + ${fmt(off)}` : ""}` };
    }
  }
  const r = (v: number) => fmt(Math.round(v * 1000) / 1000);
  const plane = `plane(origin: (${point.map(r).join(", ")}), normal: (${normal.map((v) => fmt(Math.round(v * 10000) / 10000)).join(", ")}))`;
  return { plane, label: "face (angled)" };
}

function PlanePicker({ ctl }: { ctl: SceneController }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<PlanePick | null>(null);
  const [, setTick] = useState(0);
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  useEffect(() => {
    let last = "";
    ctl.onRendered = () => {
      const k = ctl.camera.matrixWorld.elements.join(",");
      if (k !== last) {
        last = k;
        setTick((t) => t + 1);
      }
    };
    ctl.setSketchMode(true);
    return () => {
      ctl.onRendered = () => undefined;
      ctl.setSketchMode(false);
    };
  }, [ctl]);

  const planes = (): PlanePick[] => {
    const o = ctl.toScreen([0, 0, 0]);
    const ux = ctl.toScreen([1, 0, 0]);
    const scale = Math.max(1e-6, Math.hypot(ux.x - o.x, ux.y - o.y));
    const s = 150 / scale;
    const q = (pts: [number, number, number][]) => pts.map((p) => ctl.toScreen(p));
    const g = s * 0.08;
    return [
      { plane: "XY", label: "Top · XY", poly: q([[g, g, 0], [s, g, 0], [s, s, 0], [g, s, 0]]) },
      { plane: "XZ", label: "Front · XZ", poly: q([[g, 0, g], [s, 0, g], [s, 0, s], [g, 0, s]]) },
      { plane: "YZ", label: "Right · YZ", poly: q([[0, g, g], [0, s, g], [0, s, s], [0, g, s]]) },
    ];
  };

  useEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    const pos = (e: MouseEvent) => {
      const r = ref.current!.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const find = (e: MouseEvent): PlanePick | null => {
      const p = pos(e);
      const face = ctl.surfaceAt(p.x, p.y);
      if (face) {
        const f = planeForFace(face.point, face.normal);
        // a small square on the face, to show where the sketch goes
        const n = face.normal;
        const t: [number, number, number] = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        const u = norm3(cross3(t, n));
        const v = cross3(n, u);
        const k = 12 / Math.max(1e-6, Math.hypot(ctl.toScreen(add3(face.point, u)).x - p.x, ctl.toScreen(add3(face.point, u)).y - p.y));
        const poly = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ].map(([a, b]) => ctl.toScreen(add3(face.point, add3(scale3(u, a * k), scale3(v, b * k)))));
        return { ...f, poly };
      }
      for (const pl of planes()) if (inPoly(p, pl.poly)) return pl;
      return null;
    };
    const onMove = (e: PointerEvent) => setHover(find(e));
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest(".sk-ui, .vp-toolbar, .vp-float")) return;
      e.stopPropagation();
      const h = find(e);
      if (h) createSketch(h.plane, h.offset);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useSketch.setState({ picking: false });
      }
    };
    host.addEventListener("pointermove", onMove, true);
    host.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      host.removeEventListener("pointermove", onMove, true);
      host.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [ctl]);

  const pl = planes();
  const path = (poly: { x: number; y: number }[]) => poly.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("") + "Z";
  return (
    <div ref={ref} className="sk-layer picking">
      <svg className="sk-svg" width="100%" height="100%">
        {pl.map((p) => (
          <g key={p.plane} className={`sk-plane ${hover?.plane === p.plane && hover.offset === undefined && hover.poly === p.poly ? "hover" : ""} ${hover?.label === p.label ? "hover" : ""}`}>
            <path d={path(p.poly)} />
            <text x={(p.poly[0].x + p.poly[2].x) / 2} y={(p.poly[0].y + p.poly[2].y) / 2}>
              {p.label}
            </text>
          </g>
        ))}
        {hover && !pl.some((p) => p.label === hover.label) && (
          <g className="sk-plane hover face">
            <path d={path(hover.poly)} />
          </g>
        )}
      </svg>
      <motion.div className="sk-ui sk-pick-card vp-float" style={{ x: "-50%" }} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="sk-badge">
            <T.Pencil size={13} /> new sketch
          </span>
          <span className="grow">{hover ? <span className="mono">{hover.label}</span> : "Click a plane, or a flat face of a part"}</span>
          <button className="btn sm ghost" onClick={() => useSketch.setState({ picking: false })}>
            Cancel
          </button>
        </div>
        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          {[
            ["XY", "Top"],
            ["XZ", "Front"],
            ["YZ", "Right"],
          ].map(([p, l]) => (
            <button key={p} className="btn sm" onClick={() => createSketch(p)}>
              {l} <span className="mono muted">{p}</span>
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

const add3 = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: [number, number, number], k: number): [number, number, number] => [a[0] * k, a[1] * k, a[2] * k];
const cross3 = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
function inPoly(p: { x: number; y: number }, poly: { x: number; y: number }[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
