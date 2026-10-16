// Draw on the 3D view to show Claude what you mean: circle a corner, point
// an arrow at a wall, scribble where a hole should go. The marks are sent as
// a picture of the view, with the parts under them named, alongside a note.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useChat, sendMessage } from "../ai/chat";
import { useDesign } from "../core/engine";
import { viewport } from "../app/viewportApi";
import { openSettings } from "../app/ui";
import { useApiKey } from "./ChatPanel";
import { Icon } from "./icons";

export const useMarkup = create<{ on: boolean }>(() => ({ on: false }));
export const toggleMarkup = (on?: boolean) => useMarkup.setState((s) => ({ on: on ?? !s.on }));

type Tool = "pen" | "arrow" | "ring";
interface Stroke {
  tool: Tool;
  pts: [number, number][];
}

const INK = "#ffb454";

export function Markup() {
  const on = useMarkup((s) => s.on);
  return <AnimatePresence>{on && <MarkupLayer key="markup" />}</AnimatePresence>;
}

function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], k: number) {
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass ? INK : "rgba(7, 9, 13, 0.6)";
    ctx.lineWidth = (pass ? 3.5 : 7) * k;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of strokes) {
      const p = s.pts.map(([x, y]) => [x * k, y * k] as const);
      if (!p.length) continue;
      ctx.beginPath();
      if (s.tool === "pen") {
        ctx.moveTo(p[0][0], p[0][1]);
        for (const q of p.slice(1)) ctx.lineTo(q[0], q[1]);
        if (p.length === 1) ctx.lineTo(p[0][0] + 0.1, p[0][1]);
      } else if (s.tool === "arrow") {
        const [a, b] = [p[0], p[p.length - 1]];
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const h = 14 * k;
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.moveTo(b[0] - h * Math.cos(ang - 0.45), b[1] - h * Math.sin(ang - 0.45));
        ctx.lineTo(b[0], b[1]);
        ctx.lineTo(b[0] - h * Math.cos(ang + 0.45), b[1] - h * Math.sin(ang + 0.45));
      } else {
        const [a, b] = [p[0], p[p.length - 1]];
        ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.max(4 * k, Math.abs(b[0] - a[0]) / 2), Math.max(4 * k, Math.abs(b[1] - a[1]) / 2), 0, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
  }
}

function MarkupLayer() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const cur = useRef<Stroke | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [text, setText] = useState("");
  const busy = useChat((s) => s.busy);
  const hasKey = !!useApiKey();
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;

  const redraw = () => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    drawStrokes(ctx, cur.current ? [...strokesRef.current, cur.current] : strokesRef.current, dpr);
  };
  useLayoutEffect(redraw, [strokes]);
  useEffect(() => {
    const ro = new ResizeObserver(redraw);
    if (canvas.current) ro.observe(canvas.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc cancels; undo takes back the last mark instead of a design change
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        toggleMarkup(false);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.stopPropagation();
        const t = e.target as HTMLElement | null;
        if (t?.tagName === "INPUT") return;
        e.preventDefault();
        setStrokes((s) => s.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const at = (e: React.PointerEvent): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const send = () => {
    const vp = viewport();
    const c = canvas.current;
    if (!vp || !c || busy) return;
    if (!hasKey) return openSettings("ai");
    const w = c.clientWidth;
    const h = c.clientHeight;
    const k = Math.min(1, 1280 / w);
    const out = document.createElement("canvas");
    out.width = Math.round(w * k);
    out.height = Math.round(h * k);
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#0d1016";
    ctx.fillRect(0, 0, out.width, out.height);
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, out.width, out.height);
      drawStrokes(ctx, strokes, k);
      const url = out.toDataURL("image/jpeg", 0.86);
      // name the parts under the marks, so Claude does not have to guess from pixels
      const r = c.getBoundingClientRect();
      const parts = useDesign.getState().model?.parts ?? [];
      const hit = new Map<string, string>();
      for (const s of strokes) {
        const step = Math.max(1, Math.floor(s.pts.length / 12));
        const pts = s.tool === "pen" ? s.pts.filter((_, i) => i % step === 0) : s.tool === "arrow" ? [s.pts[s.pts.length - 1]] : [[(s.pts[0][0] + s.pts[s.pts.length - 1][0]) / 2, (s.pts[0][1] + s.pts[s.pts.length - 1][1]) / 2] as [number, number]];
        for (const [x, y] of pts) {
          const id = vp.hitAt(r.left + x, r.top + y)?.id;
          const p = id && parts.find((q) => q.id === id);
          if (p) hit.set(p.id, p.label);
        }
      }
      const marks = strokes.length === 1 ? "one mark" : `${strokes.length} marks`;
      const on = hit.size ? ` The marks are on ${[...hit].map(([id, label]) => `${label} (\`${id}\`)`).join(", ")}.` : "";
      const note = `The user drew ${marks} in orange on their current view of the model (the attached image): arrows point at what they mean, circles enclose it, scribbles mark a place.${on}`;
      void sendMessage(text.trim() || "Look at what I marked.", { image: { url, note } });
      toggleMarkup(false);
    };
    img.src = vp.snapshot();
  };

  return (
    <motion.div className="markup" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
      <canvas
        ref={canvas}
        className="markup-canvas"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          cur.current = { tool, pts: [at(e)] };
          redraw();
        }}
        onPointerMove={(e) => {
          if (!cur.current) return;
          const p = at(e);
          if (cur.current.tool === "pen") cur.current.pts.push(p);
          else cur.current.pts = [cur.current.pts[0], p];
          redraw();
        }}
        onPointerUp={() => {
          const s = cur.current;
          cur.current = null;
          if (s) setStrokes((x) => [...x, s]);
        }}
        aria-label="Drawing area over the 3D view"
      />
      <div className="markup-bar top">
        <span className="mono markup-title">
          <Icon.Edit size={12} /> mark up the view
        </span>
        <div className="seg">
          {(
            [
              ["pen", "Pen"],
              ["arrow", "Arrow"],
              ["ring", "Circle"],
            ] as const
          ).map(([t, label]) => (
            <button key={t} className={`btn sm ${tool === t ? "primary" : "ghost"}`} onClick={() => setTool(t)} aria-pressed={tool === t}>
              {label}
            </button>
          ))}
        </div>
        <button className="btn sm ghost" disabled={!strokes.length} onClick={() => setStrokes((s) => s.slice(0, -1))} data-tip="Take back the last mark (Ctrl+Z)">
          <Icon.Undo size={12} /> Undo
        </button>
        <button className="btn sm ghost" disabled={!strokes.length} onClick={() => setStrokes([])}>
          Clear
        </button>
      </div>
      <div className="markup-bar bottom">
        <input
          autoFocus
          value={text}
          maxLength={2000}
          placeholder={strokes.length ? "What should change where you marked?" : "Draw on the model, then say what you mean"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && strokes.length) {
              e.preventDefault();
              send();
            }
          }}
          aria-label="Message to send with the marks"
        />
        <button className="btn sm primary" disabled={!strokes.length || busy} onClick={send}>
          <Icon.Send size={12} /> Send to Claude
        </button>
        <button className="btn sm ghost" onClick={() => toggleMarkup(false)} data-tip="Esc">
          Cancel
        </button>
      </div>
    </motion.div>
  );
}
