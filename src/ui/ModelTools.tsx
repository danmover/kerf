// Advanced mode: modelling tools beside the 3D view, for doing the plain work
// yourself. Each tool is a small form that runs the same commands as typing
// "fillet 2" in the chat (see core/quickCommands), so every change is one
// ordinary, undoable edit to the design's text. Click the model to pick the
// spot a tool works on. When the shape is roughly right, "Fix it up" and
// "Make it buildable" hand it to Claude to finish properly.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { create } from "zustand";
import { sendMessage, useChat } from "../ai/chat";
import { useAgents, isLive } from "../agents/progress";
import { useDesign } from "../core/engine";
import { describeQuick, type EdgePreset, type QuickCommand } from "../core/quickCommands";
import { runQuick, runQuickCommand, type QuickOutcome } from "../app/quickRun";
import { realSource, undo } from "../app/project";
import type { SpotRef } from "../app/spot";
import { useView } from "../app/view";
import { updateSettings } from "../app/settings";
import { viewport } from "../app/viewportApi";
import { fmtNum } from "../lang/values";
import { useApiKey } from "./ChatPanel";
import { Icon } from "./icons";

export type ToolId = "box" | "cylinder" | "hole" | "fillet" | "chamfer" | "shell" | "move" | "rotate" | "copy" | "pattern" | "mirror" | "subtract" | "delete";

/** The open modelling tool, so other places (the find palette) can open one. */
export const useModelTool = create<{ tool: ToolId | null }>(() => ({ tool: null }));
/** Show the modelling tools with one of them open. */
export function openModelTool(tool: ToolId) {
  updateSettings({ advanced: true });
  useModelTool.setState({ tool });
}

const TOOLS: { id: ToolId; label: string; icon: (p: { size?: number }) => ReactNode; hint: string }[] = [
  { id: "box", label: "Box", icon: (p) => <Icon.Box {...p} />, hint: "Add a box: on the face you click, or as a new part" },
  { id: "cylinder", label: "Cylinder", icon: (p) => <Icon.Cylinder {...p} />, hint: "Add a cylinder: on the face you click, or as a new part" },
  { id: "hole", label: "Hole", icon: (p) => <Icon.Hole {...p} />, hint: "Drill a hole where you click" },
  { id: "fillet", label: "Fillet", icon: (p) => <Icon.Fillet {...p} />, hint: "Round edges: the one you click, or a set" },
  { id: "chamfer", label: "Chamfer", icon: (p) => <Icon.Chamfer {...p} />, hint: "Bevel edges: the one you click, or a set" },
  { id: "shell", label: "Shell", icon: (p) => <Icon.Shell {...p} />, hint: "Hollow a part out, leaving a face open" },
  { id: "move", label: "Move", icon: (p) => <Icon.Move {...p} />, hint: "Move the selected parts" },
  { id: "rotate", label: "Turn", icon: (p) => <Icon.Refresh {...p} />, hint: "Turn the selected parts where they are" },
  { id: "copy", label: "Copy", icon: (p) => <Icon.Copy {...p} />, hint: "Copy the selected parts" },
  { id: "pattern", label: "Pattern", icon: (p) => <Icon.Pattern {...p} />, hint: "Pattern: copies of the selected parts in a row or round an axis (to pattern a hole or boss inside a part, use the features tab)" },
  { id: "mirror", label: "Mirror", icon: (p) => <Icon.Mirror {...p} />, hint: "Mirror: the other hand of the selected part, linked so it follows every change" },
  { id: "subtract", label: "Cut out", icon: (p) => <Icon.Subtract {...p} />, hint: "Cut out: cut another part out of the selected one, where it sits (a pocket for a magnet, a hole for a connector)" },
  { id: "delete", label: "Delete", icon: (p) => <Icon.Trash {...p} />, hint: "Delete the selected parts" },
];

/** Tools that work on a spot you click (the others work on the selection). */
const PICKS: Partial<Record<ToolId, "needs" | "may">> = { hole: "needs", box: "may", cylinder: "may", fillet: "may", chamfer: "may", shell: "may" };

export const FIX_IT_UP =
  "I modelled this by hand with the modelling tools. Fix it up so it works: keep the shapes, sizes and positions I chose and what the design is for, but make the parts fit and hold together, fix anything that no longer builds or passes the checks, and tidy the code (parameters and named features instead of loose numbers). Tell me what you changed.";
export const MAKE_BUILDABLE =
  "Make this an actual buildable product: real fasteners and fits, parts that can be made with the processes I have, wiring and electronics if it needs them, an assembly order, and a parts list with where to buy each part. Keep the design's shape and purpose, and fix every failing check.";

interface Form {
  w: number;
  d: number;
  h: number;
  cd: number;
  ch: number;
  size: string;
  holeD: number;
  through: boolean;
  depth: number;
  fit: "clearance" | "tap" | "insert" | "thread";
  r: number;
  edges: "picked" | EdgePreset;
  t: number;
  open: "picked" | "Z" | "-Z" | "-Y" | "Y" | "-X" | "X" | "closed";
  dx: number;
  dy: number;
  dz: number;
  angle: number;
  axis: 0 | 1 | 2;
  newPart: boolean;
  patKind: "line" | "round";
  count: number;
  gap: number;
  patAxis: 0 | 1 | 2;
  spread: number;
  cx: number;
  cy: number;
  cz: number;
  mAxis: 0 | 1 | 2;
  mAt: number;
  cutTool: string;
}

const START: Form = { w: 40, d: 30, h: 10, cd: 20, ch: 20, size: "M3", holeD: 5, through: true, depth: 8, fit: "clearance", r: 1, edges: "picked", t: 2, open: "picked", dx: 0, dy: 0, dz: 10, angle: 90, axis: 2, newPart: false, patKind: "line", count: 3, gap: 30, patAxis: 0, spread: 360, cx: 0, cy: 0, cz: 0, mAxis: 0, mAt: 0, cutTool: "" };

type Done = Extract<QuickOutcome, { ok: true }> & { failed?: string };

export function ModelTools({ host }: { host: RefObject<HTMLDivElement | null> }) {
  const tool = useModelTool((s) => s.tool);
  const setTool = (t: ToolId | null) => useModelTool.setState({ tool: t });
  const [pick, setPick] = useState<SpotRef | null>(null);
  const [form, setForm] = useState<Form>(START);
  const [done, setDone] = useState<Done | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const [cmd, setCmd] = useState("");
  const busy = useChat((s) => s.busy);
  const building = useAgents((s) => isLive(s.run));
  const hasKey = !!useApiKey();
  const model = useDesign((s) => s.model);
  const selected = useView((s) => s.selected);
  const source = useDesign((s) => s.source);
  const working = busy || building;
  const pin = useRef<HTMLDivElement>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const picking = tool ? PICKS[tool] : undefined;

  // clicking the model picks the spot the tool works on (the click still selects the part as usual)
  useEffect(() => {
    const el = host.current;
    if (!el || !picking) return;
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    };
    const onUp = (e: PointerEvent) => {
      if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      down = null;
      const hit = viewport()?.hitAt(e.clientX, e.clientY);
      const part = hit && useDesign.getState().model?.parts.find((p) => p.id === hit.id);
      setPick(hit && part ? { partId: hit.id, label: part.label, local: hit.local, point: hit.point, normal: hit.normal, localNormal: hit.localNormal } : null);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [host, picking]);

  // the picked spot follows the camera
  useLayoutEffect(() => {
    if (!pick?.local) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const a = viewport()?.anchor(pick.partId, pick.local);
      if (!pin.current) return;
      pin.current.style.opacity = a && a.front ? "1" : "0";
      if (a) pin.current.style.transform = `translate3d(${a.x}px, ${a.y}px, 0)`;
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [pick]);

  // a picked spot on a part that is gone, or a different tool, starts afresh
  useEffect(() => {
    if (pick && !model?.parts.some((p) => p.id === pick.partId)) setPick(null);
  }, [model, pick]);
  useEffect(() => {
    if (!tool) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") && !t.closest(".mt-panel")) return;
      setTool(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool]);

  const report = (r: QuickOutcome | null, text?: string) => {
    if (!r) {
      // not a plain command: Claude does it, quickly when it is a small change
      if (text && hasKey) {
        void sendMessage(text, { spot: pick ?? undefined });
        setWhy(null);
        setDone(null);
        setCmd("");
      } else setWhy(hasKey ? "Type a command such as “fillet 2” or “move 10 up”." : "That isn't a command Kerf knows. Add a Claude key in Settings to ask for anything else.");
      return;
    }
    if (!r.ok) {
      setWhy(r.why);
      setDone(null);
      return;
    }
    setWhy(null);
    setDone(r);
    setCmd("");
    void r.built.then((err) => err && setDone((d) => (d === r || d?.after === r.after ? { ...r, failed: err } : d)));
  };

  // cut out: the part to cut is the first one selected, the one cut out of it the second (or picked in the form)
  const blocks = useMemo(() => [...new Set(selected.map((id) => model?.parts.find((p) => p.id === id)?.name).filter((n): n is string => !!n))], [selected, model]);
  const others = useMemo(() => [...new Map((model?.parts ?? []).filter((p) => p.name !== blocks[0]).map((p) => [p.name, p.label])).entries()], [model, blocks]);
  const cutTool = form.cutTool && others.some(([n]) => n === form.cutTool) ? form.cutTool : (blocks[1] ?? others[0]?.[0] ?? "");
  const command = (t: ToolId) => (t === "subtract" ? (cutTool && blocks[0] ? ({ k: "subtract", tool: cutTool, target: blocks[0] } as QuickCommand) : null) : commandFor(t, form, pick));

  const apply = () => {
    const c = command(tool!);
    if (!c) return;
    report(runQuickCommand(c, pick));
  };

  const targetText = pick ? `${pick.label}${pick.normal ? ` · ${faceWord(pick.normal)}` : ""}` : selected.length ? `${selected.length === 1 ? (model?.parts.find((p) => p.id === selected[0])?.label ?? selected[0]) : `${selected.length} selected parts`}` : null;
  const cutFrom = tool === "subtract" && blocks[0] ? `Cut from ${model?.parts.find((p) => p.name === blocks[0])?.label ?? blocks[0]}` : null;
  const needsPick = picking === "needs" && !pick;
  // with nothing selected, a design of one part means that part
  const onlyPart = new Set(model?.parts.filter((p) => p.kind === "part").map((p) => p.name)).size === 1;
  const needsTarget = tool && !PICKS[tool] && !selected.length && !pick && (!onlyPart || tool === "subtract");
  const preview = tool ? command(tool) : null;

  return (
    <>
      {pick?.local && tool && (
        <div className="spot-pin" ref={pin} aria-hidden="true">
          <span className="ring" />
          <span className="dot" />
        </div>
      )}
      <div className="mt-bar" role="toolbar" aria-label="Modelling tools" onPointerDown={(e) => e.stopPropagation()}>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`icon-btn ${tool === t.id ? "active" : ""}`}
            aria-pressed={tool === t.id}
            aria-label={t.label}
            data-tip={t.hint}
            data-tip-pos="right"
            onClick={() => {
              setTool(tool === t.id ? null : t.id);
              setWhy(null);
              setDone(null);
              // a copy goes beside the original unless an offset is given; a move needs one
              if (t.id === "copy") setForm((f) => ({ ...f, dx: 0, dy: 0, dz: 0 }));
              if (t.id === "move") setForm((f) => (f.dx || f.dy || f.dz ? f : { ...f, dz: 10 }));
            }}
          >
            {t.icon({ size: 16 })}
          </button>
        ))}
        <div className="mt-sep" />
        <button className="icon-btn" disabled={!hasKey || working || !model?.parts.length} aria-label="Fix it up" data-tip={hasKey ? "Fix it up: Claude makes what you modelled fit, hold together and pass the checks, keeping your shapes" : "Add a Claude key in Settings to use this"} data-tip-pos="right" onClick={() => void sendMessage(FIX_IT_UP, { design: true })}>
          <Icon.Wand size={16} />
        </button>
        <button className="icon-btn" disabled={!hasKey || working || !model?.parts.length} aria-label="Make it buildable" data-tip={hasKey ? "Make it buildable: real fasteners and fits, processes you have, wiring, assembly order and a parts list" : "Add a Claude key in Settings to use this"} data-tip-pos="right" onClick={() => void sendMessage(MAKE_BUILDABLE, { design: true })}>
          <Icon.Wrench size={16} />
        </button>
      </div>

      <AnimatePresence>
        {tool && (
          <motion.div key="panel" className="vp-float mt-panel" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ type: "spring", stiffness: 480, damping: 36 }} onPointerDown={(e) => e.stopPropagation()}>
            <div className="mt-head">
              <span className="grow">{TOOLS.find((t) => t.id === tool)!.label}</span>
              <button className="icon-btn sm" onClick={() => setTool(null)} aria-label="Close" data-tip="Close (Esc)">
                <Icon.X size={12} />
              </button>
            </div>

            <div className={`mt-target ${needsPick || needsTarget ? "wait" : ""}`}>
              <Icon.Target size={11} />
              <span className="grow">
                {cutFrom ?? (picking ? (pick ? targetText : picking === "needs" ? "Click the model where it goes" : tool === "box" || tool === "cylinder" ? "Click a face to put it there, or it goes beside the model" : `Click an edge or face, or it works on ${targetText ?? "the selected part"}`) : (targetText ?? (tool === "subtract" ? "Select the part to cut from" : "Select the parts first")))}
              </span>
              {pick && (
                <button className="link-btn" onClick={() => setPick(null)}>
                  clear
                </button>
              )}
            </div>

            <ToolForm tool={tool} form={form} set={set} pick={pick} others={others} cutTool={cutTool} />

            <div className="row" style={{ gap: 6, marginTop: 10 }}>
              <button className={`btn sm ${tool === "delete" ? "danger" : "primary"}`} disabled={!preview || needsPick || !!needsTarget || working} onClick={apply} style={{ flex: 1 }}>
                <Icon.Bolt size={11} /> {preview ? describeQuick(preview) : "Apply"}
              </button>
            </div>

            {why && <div className="mt-msg warn">{why}</div>}
            {done && done.after === source && (
              <div className={`mt-msg ${done.failed ? "fail" : "ok"}`}>
                <div className="row" style={{ gap: 6 }}>
                  <span className="grow">{done.failed ? `It no longer builds: ${done.failed}` : done.title}</span>
                  <button
                    className="btn sm ghost"
                    onClick={() => {
                      if (realSource() === done.after) undo();
                      setDone(null);
                    }}
                  >
                    <Icon.Undo size={11} /> Undo
                  </button>
                </div>
                {done.failed && hasKey && (
                  <button className="btn sm" style={{ marginTop: 6 }} disabled={working} onClick={() => void sendMessage(`I used the modelling tools (${done.title}) and the part no longer builds: ${done.failed}. Fix it, keeping what I did as far as it can work.`, { design: true })}>
                    <Icon.Sparkle size={11} /> Ask Claude to fix it
                  </button>
                )}
              </div>
            )}

            <div className="mt-cmd">
              <input
                className="input mono"
                value={cmd}
                placeholder={hasKey ? "Or type a command, or ask Claude…" : "Or type: fillet 2, hole M4, wall 3…"}
                onChange={(e) => setCmd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && cmd.trim() && !working) report(runQuick(cmd, pick), cmd);
                  if (e.key === "Escape") setTool(null);
                }}
                aria-label="Type a command"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function faceWord(n: [number, number, number]) {
  const i = [0, 1, 2].reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a), 0);
  if (Math.abs(n[i]) < 0.92) return "angled face";
  const words: Record<string, string> = { "0+": "right", "0-": "left", "1+": "back", "1-": "front", "2+": "top", "2-": "bottom" };
  return `${words[`${i}${n[i] > 0 ? "+" : "-"}`]} face`;
}

/** The command a tool's form describes, or null when it is not complete. */
function commandFor(tool: ToolId, f: Form, pick: SpotRef | null): QuickCommand | null {
  const pos = (v: number) => Number.isFinite(v) && v > 0;
  switch (tool) {
    case "box":
      return [f.w, f.d, f.h].every(pos) ? { k: "new", shape: "box", size: [f.w, f.d, f.h], join: pick ? !f.newPart : undefined } : null;
    case "cylinder":
      return [f.cd, f.ch].every(pos) ? { k: "new", shape: "cylinder", size: [f.cd, f.ch], join: pick ? !f.newPart : undefined } : null;
    case "hole": {
      const custom = f.size === "custom";
      if (custom ? !pos(f.holeD) : false) return null;
      const depth = f.through || !pos(f.depth) ? undefined : f.depth;
      return { k: "hole", size: custom ? undefined : f.size, d: custom ? f.holeD : undefined, through: depth === undefined, depth, fit: custom ? undefined : f.fit === "clearance" ? undefined : f.fit };
    }
    case "fillet":
    case "chamfer":
      return pos(f.r) ? { k: tool, r: f.r, edges: f.edges === "picked" ? (pick ? undefined : "all") : f.edges } : null;
    case "shell":
      return pos(f.t) ? { k: "shell", t: f.t, open: f.open === "picked" ? (pick ? "here" : "Z") : f.open === "closed" ? null : f.open } : null;
    case "move":
      return [f.dx, f.dy, f.dz].some((v) => Number.isFinite(v) && v !== 0) ? { k: "move", by: [f.dx || 0, f.dy || 0, f.dz || 0] } : null;
    case "rotate":
      return Number.isFinite(f.angle) && f.angle !== 0 ? { k: "rotate", angle: f.angle, axis: f.axis } : null;
    case "copy":
      return { k: "copy", by: [f.dx, f.dy, f.dz].some((v) => Number.isFinite(v) && v !== 0) ? [f.dx || 0, f.dy || 0, f.dz || 0] : undefined };
    case "pattern": {
      const count = Math.round(f.count);
      if (!(count >= 2)) return null;
      if (f.patKind === "line") {
        if (!Number.isFinite(f.gap) || f.gap === 0) return null;
        const step: [number, number, number] = [0, 0, 0];
        step[f.patAxis] = f.gap;
        return { k: "pattern", count, step };
      }
      return Number.isFinite(f.spread) && f.spread !== 0 ? { k: "pattern", count, angle: f.spread, axis: f.patAxis, center: [f.cx || 0, f.cy || 0, f.cz || 0] } : null;
    }
    case "mirror":
      return { k: "mirror", axis: f.mAxis, at: Number.isFinite(f.mAt) ? f.mAt : 0 };
    case "subtract":
      return null;
    case "delete":
      return { k: "delete" };
  }
}

function Num({ label, value, onChange, unit = "mm", step = 0.5 }: { label: string; value: number; onChange: (v: number) => void; unit?: string; step?: number }) {
  const [text, setText] = useState(fmtNum(value, 3));
  useEffect(() => setText(fmtNum(value, 3)), [value]);
  return (
    <label className="mt-num">
      <span className="mono">{label}</span>
      <input
        className="input mono"
        type="number"
        step={step}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
      <span className="dim mono">{unit}</span>
    </label>
  );
}

function Pick<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <label className="mt-num">
      <span className="mono">{label}</span>
      <select className="select" value={String(value)} onChange={(e) => onChange(options.find((o) => String(o.value) === e.target.value)!.value)}>
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const SIZES = ["M2", "M2.5", "M3", "M4", "M5", "M6", "M8", "M10"];
const EDGE_OPTIONS: { value: Form["edges"]; label: string }[] = [
  { value: "picked", label: "The edge or face I click" },
  { value: "all", label: "All edges" },
  { value: "top", label: "Top edges" },
  { value: "bottom", label: "Bottom edges" },
  { value: "vertical", label: "Vertical edges (corners)" },
  { value: "convex", label: "Outside edges" },
  { value: "concave", label: "Inside corners" },
];
const OPEN_OPTIONS: { value: Form["open"]; label: string }[] = [
  { value: "picked", label: "The face I click (else the top)" },
  { value: "Z", label: "Top" },
  { value: "-Z", label: "Bottom" },
  { value: "-Y", label: "Front" },
  { value: "Y", label: "Back" },
  { value: "-X", label: "Left" },
  { value: "X", label: "Right" },
  { value: "closed", label: "Closed all round" },
];

const AXIS_OPTIONS: { value: 0 | 1 | 2; label: string }[] = [
  { value: 0, label: "X" },
  { value: 1, label: "Y" },
  { value: 2, label: "Z (up)" },
];

function ToolForm({ tool, form: f, set, pick, others, cutTool }: { tool: ToolId; form: Form; set: <K extends keyof Form>(k: K, v: Form[K]) => void; pick: SpotRef | null; others: [string, string][]; cutTool: string }) {
  switch (tool) {
    case "pattern":
      return (
        <div className="mt-form">
          <Pick
            label="Kind"
            value={f.patKind}
            options={[
              { value: "line", label: "In a row" },
              { value: "round", label: "Round an axis" },
            ]}
            onChange={(v) => {
              set("patKind", v);
              if (v === "round") set("patAxis", 2);
            }}
          />
          <Num label="Copies" value={f.count} onChange={(v) => set("count", v)} unit="" step={1} />
          {f.patKind === "line" ? (
            <>
              <Num label="Apart" value={f.gap} onChange={(v) => set("gap", v)} step={1} />
              <Pick label="Along" value={f.patAxis} options={AXIS_OPTIONS} onChange={(v) => set("patAxis", v)} />
            </>
          ) : (
            <>
              <Num label="Over" value={f.spread} onChange={(v) => set("spread", v)} unit="°" step={15} />
              <Pick label="Round" value={f.patAxis} options={AXIS_OPTIONS} onChange={(v) => set("patAxis", v)} />
              <Num label="At X" value={f.cx} onChange={(v) => set("cx", v)} step={1} />
              <Num label="At Y" value={f.cy} onChange={(v) => set("cy", v)} step={1} />
              <Num label="At Z" value={f.cz} onChange={(v) => set("cz", v)} step={1} />
            </>
          )}
          <div className="dim" style={{ fontSize: 11 }}>The original counts as the first copy. Each copy is a part of its own.</div>
        </div>
      );
    case "mirror":
      return (
        <div className="mt-form">
          <Pick
            label="Across"
            value={f.mAxis}
            options={[
              { value: 0, label: "YZ plane (flip left and right)" },
              { value: 1, label: "XZ plane (flip front and back)" },
              { value: 2, label: "XY plane (flip up and down)" },
            ]}
            onChange={(v) => set("mAxis", v)}
          />
          <Num label={`At ${"XYZ"[f.mAxis]}`} value={f.mAt} onChange={(v) => set("mAt", v)} step={1} />
          <div className="dim" style={{ fontSize: 11 }}>A new part that is the mirror image, linked: change the original and it follows.</div>
        </div>
      );
    case "subtract":
      return (
        <div className="mt-form">
          {others.length ? (
            <Pick label="Cut out" value={cutTool} options={others.map(([value, label]) => ({ value, label }))} onChange={(v) => set("cutTool", v)} />
          ) : (
            <div className="dim" style={{ fontSize: 11.5 }}>Add the part to cut out first.</div>
          )}
          <div className="dim" style={{ fontSize: 11 }}>Cuts it out of the selected part where it sits, and stays linked. The other part is kept.</div>
        </div>
      );
    case "box":
    case "cylinder":
      return (
        <div className="mt-form">
          {tool === "box" ? (
            <>
              <Num label="W" value={f.w} onChange={(v) => set("w", v)} />
              <Num label="D" value={f.d} onChange={(v) => set("d", v)} />
              <Num label="H" value={f.h} onChange={(v) => set("h", v)} />
            </>
          ) : (
            <>
              <Num label="⌀" value={f.cd} onChange={(v) => set("cd", v)} />
              <Num label="H" value={f.ch} onChange={(v) => set("ch", v)} />
            </>
          )}
          {pick && (
            <label className="mt-check">
              <input type="checkbox" checked={f.newPart} onChange={(e) => set("newPart", e.target.checked)} /> A separate part (not joined to {pick.label})
            </label>
          )}
        </div>
      );
    case "hole":
      return (
        <div className="mt-form">
          <Pick label="Size" value={f.size} options={[...SIZES.map((s) => ({ value: s, label: `${s} screw` })), { value: "custom", label: "Diameter…" }]} onChange={(v) => set("size", v)} />
          {f.size === "custom" ? (
            <Num label="⌀" value={f.holeD} onChange={(v) => set("holeD", v)} />
          ) : (
            <Pick
              label="Fit"
              value={f.fit}
              options={[
                { value: "clearance", label: "Clearance (screw passes)" },
                { value: "tap", label: "Tapping (screw cuts its thread)" },
                { value: "insert", label: "Heat-set insert" },
                { value: "thread", label: "Threaded" },
              ]}
              onChange={(v) => set("fit", v)}
            />
          )}
          <label className="mt-check">
            <input type="checkbox" checked={f.through} onChange={(e) => set("through", e.target.checked)} /> Right through
          </label>
          {!f.through && <Num label="Depth" value={f.depth} onChange={(v) => set("depth", v)} />}
        </div>
      );
    case "fillet":
    case "chamfer":
      return (
        <div className="mt-form">
          <Num label={tool === "fillet" ? "R" : "Size"} value={f.r} onChange={(v) => set("r", v)} step={0.25} />
          <Pick label="Edges" value={f.edges} options={EDGE_OPTIONS} onChange={(v) => set("edges", v)} />
        </div>
      );
    case "shell":
      return (
        <div className="mt-form">
          <Num label="Wall" value={f.t} onChange={(v) => set("t", v)} step={0.2} />
          <Pick label="Open" value={f.open} options={OPEN_OPTIONS} onChange={(v) => set("open", v)} />
        </div>
      );
    case "move":
    case "copy":
      return (
        <div className="mt-form">
          <Num label="X" value={f.dx} onChange={(v) => set("dx", v)} step={1} />
          <Num label="Y" value={f.dy} onChange={(v) => set("dy", v)} step={1} />
          <Num label="Z" value={f.dz} onChange={(v) => set("dz", v)} step={1} />
          {tool === "copy" && <div className="dim" style={{ fontSize: 11 }}>All zero puts the copy beside the original.</div>}
        </div>
      );
    case "rotate":
      return (
        <div className="mt-form">
          <Num label="Angle" value={f.angle} onChange={(v) => set("angle", v)} unit="°" step={15} />
          <Pick
            label="About"
            value={f.axis}
            options={[
              { value: 0, label: "X" },
              { value: 1, label: "Y" },
              { value: 2, label: "Z (up)" },
            ]}
            onChange={(v) => set("axis", v)}
          />
        </div>
      );
    case "delete":
      return <div className="mt-form dim" style={{ fontSize: 11.5 }}>Removes the selected parts. Undo brings them back.</div>;
  }
}
