// A napkin sketch: draw the idea, label the sizes, and hand the picture to
// Claude as a reference. Saved as an image with the project.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Modal } from "./common";
import { Icon } from "./icons";
import { BIcon } from "./briefIcons";
import { addAsset } from "../persist/assets";
import type { AssetRecord } from "../persist/db";
import { useProject } from "../app/project";
import { toast, errorText, confirmDialog } from "../app/ui";
import "../styles/brief.css";

const W = 1200;
const H = 800;
const GRID = 40;

type Pt = [number, number];
type Tool = "pen" | "line" | "arrow" | "rect" | "circle" | "text" | "eraser";
type Shape =
  | { t: "pen"; pts: Pt[]; color: string; w: number }
  | {
      t: "line" | "arrow" | "rect" | "circle";
      a: Pt;
      b: Pt;
      color: string;
      w: number;
    }
  | { t: "text"; at: Pt; text: string; color: string; size: number };

const COLORS = ["#1b1f2a", "#2f5bea", "#d93a49"];
const ERASER_W = 26;

interface PadRequest {
  onSave: (rec: AssetRecord) => void;
}
export const useSketchPad = create<{ req: PadRequest | null }>(() => ({
  req: null,
}));
export const openSketchPad = (onSave: PadRequest["onSave"]) => useSketchPad.setState({ req: { onSave } });

function draw(ctx: CanvasRenderingContext2D, shapes: Shape[], grid: boolean) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  if (grid) {
    ctx.strokeStyle = "#e3e8f2";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = GRID; x < W; x += GRID) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
    }
    for (let y = GRID; y < H; y += GRID) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(W, y + 0.5);
    }
    ctx.stroke();
  }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of shapes) {
    if (s.t === "text") {
      ctx.fillStyle = s.color;
      ctx.font = `${s.size}px "IBM Plex Sans", system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.fillText(s.text, s.at[0], s.at[1]);
      continue;
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.w;
    ctx.beginPath();
    if (s.t === "pen") {
      ctx.moveTo(s.pts[0][0], s.pts[0][1]);
      for (const p of s.pts.slice(1)) ctx.lineTo(p[0], p[1]);
      if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] + 0.1, s.pts[0][1]);
    } else if (s.t === "line" || s.t === "arrow") {
      ctx.moveTo(s.a[0], s.a[1]);
      ctx.lineTo(s.b[0], s.b[1]);
      if (s.t === "arrow") {
        const ang = Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]);
        const L = 14 + s.w * 2;
        for (const d of [-0.45, 0.45]) {
          ctx.moveTo(s.b[0], s.b[1]);
          ctx.lineTo(s.b[0] - L * Math.cos(ang + d), s.b[1] - L * Math.sin(ang + d));
        }
      }
    } else if (s.t === "rect") {
      ctx.rect(Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]), Math.abs(s.b[0] - s.a[0]), Math.abs(s.b[1] - s.a[1]));
    } else {
      const r = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      ctx.arc(s.a[0], s.a[1], r, 0, Math.PI * 2);
    }
    ctx.stroke();
  }
}

export function SketchPad() {
  const req = useSketchPad((s) => s.req);
  return req ? <Pad req={req} /> : null;
}

function Pad({ req }: { req: PadRequest }) {
  const projectId = useProject((s) => s.current?.id);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [redo, setRedo] = useState<Shape[]>([]);
  const [live, setLive] = useState<Shape | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [grid, setGrid] = useState(true);
  const [gridMm, setGridMm] = useState("10");
  const [text, setText] = useState<{
    at: Pt;
    screen: Pt;
    value: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(true);
  const textRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (ctx) draw(ctx, live ? [...shapes, live] : shapes, grid);
  }, [shapes, live, grid]);
  useEffect(() => {
    if (text) textRef.current?.focus();
  }, [text]);

  const dismiss = useCallback(() => {
    setOpen(false);
    setTimeout(() => useSketchPad.setState({ req: null }), 200);
  }, []);
  const tryClose = async () => {
    if (text) return setText(null);
    if (
      shapes.length &&
      !(await confirmDialog({
        title: "Discard this sketch?",
        body: "It has not been attached yet.",
        confirm: "Discard",
        danger: true,
      }))
    )
      return;
    dismiss();
  };
  const push = (s: Shape) => {
    setShapes((xs) => [...xs, s]);
    setRedo([]);
  };
  const toCanvas = (e: React.PointerEvent | React.MouseEvent): { p: Pt; screen: Pt } => {
    const r = canvas.current!.getBoundingClientRect();
    return {
      p: [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H],
      screen: [e.clientX - r.left, e.clientY - r.top],
    };
  };
  const commitText = () => {
    if (text && text.value.trim())
      push({
        t: "text",
        at: text.at,
        text: text.value.trim(),
        color,
        size: 26,
      });
    setText(null);
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { p, screen } = toCanvas(e);
    if (tool === "text") {
      // no mouse-down focus change, so the label box keeps the focus it gets on mount
      e.preventDefault();
      commitText();
      setText({ at: p, screen, value: "" });
      return;
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (tool === "pen" || tool === "eraser")
      setLive({
        t: "pen",
        pts: [p],
        color: tool === "eraser" ? "#ffffff" : color,
        w: tool === "eraser" ? ERASER_W : 3,
      });
    else setLive({ t: tool, a: p, b: p, color, w: 3 });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!live) return;
    const { p } = toCanvas(e);
    if (live.t === "pen") setLive({ ...live, pts: [...live.pts, p] });
    else if (live.t !== "text") {
      let b = p;
      // hold Shift for straight lines and squares
      if (e.shiftKey && (live.t === "line" || live.t === "arrow")) {
        const dx = p[0] - live.a[0];
        const dy = p[1] - live.a[1];
        b = Math.abs(dx) > Math.abs(dy) ? [p[0], live.a[1]] : [live.a[0], p[1]];
      } else if (e.shiftKey && live.t === "rect") {
        const d = Math.max(Math.abs(p[0] - live.a[0]), Math.abs(p[1] - live.a[1]));
        b = [live.a[0] + Math.sign(p[0] - live.a[0]) * d, live.a[1] + Math.sign(p[1] - live.a[1]) * d];
      }
      setLive({ ...live, b });
    }
  };
  const onUp = () => {
    if (!live) return;
    const tiny = live.t !== "pen" && live.t !== "text" && Math.hypot(live.b[0] - live.a[0], live.b[1] - live.a[1]) < 3;
    if (!tiny) push(live);
    setLive(null);
  };

  const undo = () => {
    if (!shapes.length) return;
    setRedo((r) => [...r, shapes[shapes.length - 1]]);
    setShapes((xs) => xs.slice(0, -1));
  };
  const redoOne = () => {
    if (!redo.length) return;
    setShapes((xs) => [...xs, redo[redo.length - 1]]);
    setRedo((r) => r.slice(0, -1));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (text || (e.target instanceof HTMLElement && e.target.closest("input, textarea"))) return;
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redoOne();
        else undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const map: Record<string, Tool> = {
        p: "pen",
        l: "line",
        a: "arrow",
        r: "rect",
        c: "circle",
        t: "text",
        e: "eraser",
      };
      if (map[k]) setTool(map[k]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const save = async () => {
    commitText();
    if (!projectId || !canvas.current) return;
    setSaving(true);
    try {
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const ctx = c.getContext("2d")!;
      const final =
        text && text.value.trim()
          ? [
              ...shapes,
              {
                t: "text" as const,
                at: text.at,
                text: text.value.trim(),
                color,
                size: 26,
              },
            ]
          : shapes;
      draw(ctx, final, grid);
      if (grid && gridMm.trim()) {
        ctx.fillStyle = "#6c7791";
        ctx.font = '18px "IBM Plex Mono", monospace';
        ctx.textBaseline = "bottom";
        ctx.fillText(`grid square = ${gridMm.trim()} mm`, 12, H - 10);
      }
      const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("The sketch could not be saved"))), "image/png"));
      const n = new Date().toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
      const rec = await addAsset(projectId, blob, `Sketch ${n}.png`);
      req.onSave(rec);
      dismiss();
    } catch (e) {
      toast({
        kind: "error",
        title: "The sketch was not saved",
        detail: errorText(e),
      });
    } finally {
      setSaving(false);
    }
  };

  const tools: { id: Tool; label: string; key: string; icon: JSX.Element }[] = [
    { id: "pen", label: "Pen", key: "P", icon: <BIcon.Pen size={15} /> },
    { id: "line", label: "Line", key: "L", icon: <BIcon.Line size={15} /> },
    { id: "arrow", label: "Arrow", key: "A", icon: <BIcon.Arrow size={15} /> },
    {
      id: "rect",
      label: "Rectangle",
      key: "R",
      icon: <BIcon.Rect size={15} />,
    },
    {
      id: "circle",
      label: "Circle",
      key: "C",
      icon: <BIcon.Circle size={15} />,
    },
    { id: "text", label: "Label", key: "T", icon: <BIcon.Text size={15} /> },
    {
      id: "eraser",
      label: "Eraser",
      key: "E",
      icon: <BIcon.Eraser size={15} />,
    },
  ];

  return (
    <Modal
      open={open}
      onClose={() => void tryClose()}
      title="Sketch"
      width={1000}
      icon={<BIcon.Pen size={16} />}
      footer={
        <>
          <span className="dim" style={{ fontSize: 12 }}>
            Label the sizes you know. Claude reads the sketch and records what it reads in the brief.
          </span>
          <div className="grow" />
          <button className="btn ghost" onClick={dismiss}>
            Cancel
          </button>
          <button className="btn primary" disabled={!shapes.length || saving} onClick={() => void save()}>
            {saving ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Icon.Check size={14} />} Attach sketch
          </button>
        </>
      }
    >
      <div className="sketch-tools">
        {tools.map((t) => (
          <button key={t.id} className={`icon-btn ${tool === t.id ? "active" : ""}`} onClick={() => setTool(t.id)} aria-label={t.label} aria-pressed={tool === t.id} data-tip={`${t.label} (${t.key})`}>
            {t.icon}
          </button>
        ))}
        <span className="sketch-sep" />
        {COLORS.map((c) => (
          <button key={c} className={`sketch-swatch ${color === c ? "on" : ""}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Colour ${c}`} aria-pressed={color === c} />
        ))}
        <span className="sketch-sep" />
        <button className="icon-btn" onClick={undo} disabled={!shapes.length} aria-label="Undo" data-tip="Undo">
          <Icon.Undo size={15} />
        </button>
        <button className="icon-btn" onClick={redoOne} disabled={!redo.length} aria-label="Redo" data-tip="Redo">
          <Icon.Redo size={15} />
        </button>
        <button className="icon-btn" onClick={() => (setShapes([]), setRedo([]))} disabled={!shapes.length} aria-label="Clear" data-tip="Clear">
          <Icon.Trash size={15} />
        </button>
        <div className="grow" />
        <label className="row" style={{ fontSize: 12, color: "var(--text-2)", gap: 6 }}>
          <input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} /> Grid
        </label>
        {grid && (
          <label className="row mono" style={{ fontSize: 11.5, color: "var(--text-3)", gap: 6 }}>
            square =
            <input className="input mono" style={{ width: 54, height: 26 }} value={gridMm} onChange={(e) => setGridMm(e.target.value.replace(/[^0-9.]/g, "").slice(0, 6))} aria-label="Grid square size in mm" />
            mm
          </label>
        )}
      </div>
      <div className="sketch-stage">
        <div className="sketch-wrap">
          <canvas ref={canvas} width={W} height={H} className={`sketch-canvas tool-${tool}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} aria-label="Sketch canvas" />
          {text && (
            <input
              ref={textRef}
              className="sketch-text"
              style={{ left: text.screen[0], top: text.screen[1] - 14, color }}
              value={text.value}
              placeholder="Type a label, Enter"
              maxLength={80}
              onChange={(e) => setText({ ...text, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitText();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setText(null);
                }
              }}
              onBlur={commitText}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
