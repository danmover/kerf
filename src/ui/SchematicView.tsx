// The schematic sheet to edit. Every electronic part is a symbol: drag one to move it, press R to turn it, click a pin
// and then another to wire them, select a wire or a pin's symbol and press Delete to take that connection out. Each
// change is written into the design (its schematic block, wire lines and net lines), so undo and the code agree.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDesign } from "../core/engine";
import { commitSource, endComparison } from "../app/project";
import { revealSpan } from "../app/view";
import { toast } from "../app/ui";
import type { Model, SchematicLayout } from "../core/model";
import type { MachineData } from "../machine/types";
import { GRID, labelSvg, schematicSheet, symbolSvg, type P2, type SchematicSheet, type SchPin, type SchSymbol } from "../machine/schematic";
import { placesOf, withConnection, withoutPin, withoutStatements, withSchematic, type Place } from "../machine/schematicEdit";
import { Icon } from "./icons";

const INK = "#1b1f24";
/** selection and the wire being drawn, on white paper */
const HI = "#2f5be8";
const OK = "#0f8f62";

type Sel = { k: "symbol"; key: string } | { k: "wire"; i: number } | { k: "pin"; ref: string } | null;
type View = { x: number; y: number; k: number };
type Drag = { k: "pan"; sx: number; sy: number; vx: number; vy: number; moved: boolean } | { k: "move"; key: string; sx: number; sy: number; ox: number; oy: number; moved: boolean };

const layoutOf = (places: Record<string, Place>): SchematicLayout => ({
  places: Object.fromEntries(Object.entries(places).map(([k, p]) => [k, { x: p.x, y: p.y, rot: (((p.rot % 360) + 360) % 360) as 0 | 90 | 180 | 270 }])),
  entries: [],
  span: { start: 0, end: 0 },
  bodyStart: 0,
});

/** One change to the design from the sheet, built on the real source and model. */
function edit(message: string, change: (src: string, model: Model, m: MachineData) => string | null) {
  endComparison();
  const { source, model } = useDesign.getState();
  if (!model?.machine) return;
  const next = change(source, model, model.machine);
  if (next === null || next === source) return;
  commitSource(next, "you", message);
}

export function SchematicView({ model, m }: { model: Model; m: MachineData }) {
  const base = useMemo(() => schematicSheet(m, model.schematic), [m, model.schematic]);
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 600, h: 400 });
  const [view, setView] = useState<View | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [pending, setPending] = useState<SchPin | null>(null);
  const [cursor, setCursor] = useState<P2 | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ key: string; at: P2 } | null>(null);
  const drag = useRef<Drag | null>(null);

  // while a symbol is dragged, the sheet is drawn with it there (and every other symbol where it is seen)
  const sheet: SchematicSheet = useMemo(() => (moving ? schematicSheet(m, layoutOf(placesOf(base, { [moving.key]: { x: moving.at[0], y: moving.at[1] } })), { route: "plain" }) : base), [moving, base, m]);
  const symbolOf = useMemo(() => new Map(sheet.symbols.map((s) => [s.key, s])), [sheet]);
  const pinOf = useMemo(() => new Map(sheet.symbols.flatMap((s) => s.pins.map((p) => [p.ref, p] as const))), [sheet]);

  // the drawing area's own size (the bar under it takes the rest), so a sheet millimetre is k pixels both ways
  useLayoutEffect(() => {
    const el = svg.current;
    if (!el) return;
    const read = () => setSize((o) => {
      const w = el.clientWidth || 600;
      const h = el.clientHeight || 400;
      return o.w === w && o.h === h ? o : { w, h };
    });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    const k = Math.min(size.w / base.width, size.h / base.height) * 0.94;
    setView({ k, x: base.origin[0] - (size.w / k - base.width) / 2, y: base.origin[1] - (size.h / k - base.height) / 2 });
  }, [size, base]);
  // fitted to the panel as it opens and resizes, until the sheet is panned, zoomed or edited
  const auto = useRef(true);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    if (auto.current) fitRef.current();
  }, [size]);

  const toSheet = useCallback(
    (cx: number, cy: number): P2 => {
      const r = svg.current!.getBoundingClientRect();
      const v = view ?? { x: 0, y: 0, k: 1 };
      return [v.x + (cx - r.left) / v.k, v.y + (cy - r.top) / v.k];
    },
    [view],
  );

  // the wheel zooms about the pointer (a native listener, so the page does not scroll)
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      auto.current = false;
      setView((v) => {
        if (!v) return v;
        const r = el.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        const k = Math.min(40, Math.max(0.4, v.k * Math.exp(-e.deltaY * 0.0015)));
        const sx = v.x + px / v.k;
        const sy = v.y + py / v.k;
        return { k, x: sx - px / k, y: sy - py / k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const connect = useCallback((a: SchPin, b: SchPin) => {
    let said = "";
    edit(`Wired ${a.ref} to ${b.ref}`, (src, _model, md) => {
      const r = withConnection(src, md, a.ref, b.ref);
      if (r.src === null) {
        said = r.why;
        return null;
      }
      if (r.how === "net") said = `Added to the ${r.net} net`;
      return r.src;
    });
    if (said) toast({ kind: "info", title: said }, 3500);
  }, []);

  const commitMove = useCallback(
    (key: string, at: P2) => {
      const places = placesOf(base, { [key]: { x: at[0], y: at[1] } });
      edit(`Moved ${key} on the schematic`, (src, mo) => withSchematic(src, mo.schematic, places));
    },
    [base],
  );

  const turn = useCallback(
    (key: string) => {
      const s = base.symbols.find((x) => x.key === key);
      if (!s) return;
      const places = placesOf(base, { [key]: { rot: (s.rot + 90) % 360 } });
      auto.current = false;
      edit(`Turned ${key} on the schematic`, (src, mo) => withSchematic(src, mo.schematic, places));
    },
    [base],
  );

  const remove = useCallback(() => {
    if (sel?.k === "wire") {
      const w = sheet.wires[sel.i];
      if (!w) return;
      const spans = [...w.spans, ...(w.netSpan ? [w.netSpan] : [])];
      edit(`Took out the wire from ${w.a} to ${w.b}`, (src) => withoutStatements(src, spans));
      setSel(null);
    } else if (sel?.k === "pin") {
      const ref = sel.ref;
      edit(`Disconnected ${ref}`, (src, _model, md) => withoutPin(src, md, ref));
      setSel(null);
    }
  }, [sel, sheet]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setPending(null);
      setSel(null);
    } else if ((e.key === "r" || e.key === "R") && sel?.k === "symbol" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      turn(sel.key);
    } else if ((e.key === "Delete" || e.key === "Backspace") && (sel?.k === "wire" || sel?.k === "pin")) {
      e.preventDefault();
      remove();
    }
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    box.current?.focus();
    const target = e.target as Element;
    const symbol = target.closest("[data-sym]")?.getAttribute("data-sym");
    if (symbol && e.button === 0) {
      const s = symbolOf.get(symbol);
      if (!s) return;
      setSel({ k: "symbol", key: symbol });
      drag.current = { k: "move", key: symbol, sx: e.clientX, sy: e.clientY, ox: s.at[0], oy: s.at[1], moved: false };
    } else if (!target.closest("[data-hit]")) {
      drag.current = { k: "pan", sx: e.clientX, sy: e.clientY, vx: view?.x ?? 0, vy: view?.y ?? 0, moved: false };
    } else return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    if (pending) setCursor(toSheet(e.clientX, e.clientY));
    const d = drag.current;
    if (!d || !view) return;
    const dx = (e.clientX - d.sx) / view.k;
    const dy = (e.clientY - d.sy) / view.k;
    if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true;
    if (!d.moved) return;
    auto.current = false;
    if (d.k === "pan") setView({ ...view, x: d.vx - dx, y: d.vy - dy });
    else {
      const at: P2 = [Math.round((d.ox + dx) / GRID) * GRID, Math.round((d.oy + dy) / GRID) * GRID];
      if (!moving || moving.at[0] !== at[0] || moving.at[1] !== at[1]) setMoving({ key: d.key, at });
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.k === "move" && d.moved && moving) {
      const s = base.symbols.find((x) => x.key === d.key);
      if (s && (s.at[0] !== moving.at[0] || s.at[1] !== moving.at[1])) commitMove(d.key, moving.at);
    }
    if (d.k === "pan" && !d.moved) {
      setSel(null);
      setPending(null);
    }
    setMoving(null);
  };

  const clickPin = (p: SchPin) => {
    if (!pending) {
      setPending(p);
      setSel({ k: "pin", ref: p.ref });
      return;
    }
    if (pending.ref !== p.ref) connect(pending, p);
    setPending(null);
    setSel(null);
  };

  const v = view ?? { x: sheet.origin[0], y: sheet.origin[1], k: 1 };
  const selSym = sel?.k === "symbol" ? symbolOf.get(sel.key) : undefined;
  const selWire = sel?.k === "wire" ? sheet.wires[sel.i] : undefined;
  const selPin = sel?.k === "pin" ? pinOf.get(sel.ref) : undefined;
  const hovered = hover ? pinOf.get(hover) : undefined;
  const netOf = (p?: SchPin) => (p?.net !== undefined ? sheet.nets.find((n) => n.id === p.net) : undefined);
  const info = hovered ?? selPin;
  const infoNet = netOf(info);
  const [ox, oy] = sheet.origin;

  return (
    <div className="sch" ref={box} tabIndex={0} onKeyDown={onKey}>
      <svg
        ref={svg}
        className={`sch-svg ${drag.current?.k === "pan" && drag.current.moved ? "panning" : ""}`}
        viewBox={`${v.x} ${v.y} ${size.w / v.k} ${size.h / v.k}`}
        preserveAspectRatio="xMinYMin meet"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setCursor(null)}
      >
        <defs>
          <pattern id="sch-grid" width={GRID} height={GRID} patternUnits="userSpaceOnUse" x={0} y={0}>
            <circle cx={0} cy={0} r={0.18} fill="#9aa3b5" />
          </pattern>
        </defs>
        <rect className="sch-paper" x={ox} y={oy} width={sheet.width} height={sheet.height} rx={1.2} />
        {v.k > 2.2 && <rect x={ox} y={oy} width={sheet.width} height={sheet.height} fill="url(#sch-grid)" pointerEvents="none" />}
        <rect x={ox + 4} y={oy + 4} width={sheet.width - 8} height={sheet.height - 8} fill="none" stroke={INK} strokeWidth={0.5} pointerEvents="none" />
        {sheet.wires.map((w, i) => {
          const on = selWire === w;
          const lit = hovered && hovered.net === w.net && w.net >= 0;
          const pts = w.points.map((p) => p.join(",")).join(" ");
          return (
            <g key={`w${i}`} data-hit="wire" onClick={() => setSel({ k: "wire", i })} style={{ cursor: "pointer" }}>
              <polyline points={pts} fill="none" stroke="transparent" strokeWidth={2.6} />
              <polyline points={pts} fill="none" stroke={on ? HI : lit ? OK : INK} strokeWidth={on || lit ? 0.6 : 0.3} strokeLinejoin="round" pointerEvents="none" />
            </g>
          );
        })}
        {sheet.symbols.map((s) => (
          <SymbolG key={s.key} s={s} selected={selSym === s} moving={moving?.key === s.key} />
        ))}
        {sheet.labels.map((l, i) => {
          const on = selPin?.ref === l.pin;
          return (
            <g key={`l${i}`} data-hit="label" onClick={() => setSel({ k: "pin", ref: l.pin })} style={{ cursor: "pointer" }}>
              <g dangerouslySetInnerHTML={{ __html: labelSvg(l, on ? HI : INK) }} pointerEvents="none" />
              <circle cx={l.at[0] + l.out[0] * 4} cy={l.at[1] + l.out[1] * 4} r={3.2} fill="transparent" />
            </g>
          );
        })}
        {pending && cursor && <line x1={pending.at[0]} y1={pending.at[1]} x2={cursor[0]} y2={cursor[1]} stroke={HI} strokeWidth={0.4} strokeDasharray="1.2 0.8" pointerEvents="none" />}
        {sheet.symbols.flatMap((s) =>
          s.pins.map((p) => {
            const isPending = pending?.ref === p.ref;
            const isHover = hover === p.ref;
            const sameNet = hovered && hovered.net !== undefined && hovered.net === p.net;
            return (
              <circle
                key={`${s.key}.${p.id}`}
                data-hit="pin"
                className="sch-pin"
                cx={p.at[0]}
                cy={p.at[1]}
                r={isPending || isHover ? 1.1 : 0.75}
                fill={isPending ? HI : isHover ? (pending ? OK : HI) : sameNet ? OK : p.net === undefined ? "#ffffff" : INK}
                stroke={isPending || isHover ? "#ffffff" : INK}
                strokeWidth={0.25}
                onPointerEnter={() => setHover(p.ref)}
                onPointerLeave={() => setHover((h) => (h === p.ref ? null : h))}
                onClick={(e) => {
                  e.stopPropagation();
                  clickPin(p);
                }}
              >
                <title>{`${p.ref} (${p.label})`}</title>
              </circle>
            );
          }),
        )}
      </svg>
      <div className="sch-bar">
        {selSym ? (
          <>
            <span className="sch-what">
              <b>{selSym.title}</b> <span className="dim">{selSym.sub}</span>
            </span>
            <button className="btn sm" onClick={() => turn(selSym.key)} data-tip="Turn it a quarter turn (R)">
              <Icon.Refresh size={12} /> Turn
            </button>
            <button className="btn sm" onClick={() => revealSpan(selSym.span)} data-tip="Show the part in the code">
              <Icon.Code size={12} /> Code
            </button>
          </>
        ) : selWire ? (
          <>
            <span className="sch-what mono">
              {selWire.a} → {selWire.b}
            </span>
            <button className="btn sm danger" onClick={remove} data-tip="Take the wire out (Delete)">
              <Icon.Trash size={12} /> Delete
            </button>
            {(selWire.spans[0] ?? selWire.netSpan) && (
              <button className="btn sm" onClick={() => revealSpan((selWire.spans[0] ?? selWire.netSpan)!)} data-tip="Show the wire line in the code">
                <Icon.Code size={12} /> Code
              </button>
            )}
          </>
        ) : info ? (
          <>
            <span className="sch-what mono">
              {info.ref} <span className="dim">({info.type})</span>
              {infoNet ? <span className="dim"> · {infoNet.pins.length > 1 ? `${infoNet.name}: ${infoNet.pins.slice(0, 6).join(", ")}${infoNet.pins.length > 6 ? ", …" : ""}` : "not connected"}</span> : <span className="dim"> · not connected</span>}
            </span>
            {selPin && pending && <span className="dim">Click another pin to wire it, or Esc</span>}
            {selPin && infoNet && infoNet.pins.length > 1 && (
              <button className="btn sm danger" onClick={remove} data-tip="Take this pin off what it is wired to (Delete)">
                <Icon.Trash size={12} /> Disconnect
              </button>
            )}
          </>
        ) : (
          <span className="dim">Drag a symbol to move it · click a pin, then another, to wire them · R turns the selected symbol · Delete takes out the selected wire</span>
        )}
        <div className="grow" />
        <button className="btn sm" onClick={fit} data-tip="Fit the sheet in the panel">
          <Icon.Fit size={12} /> Fit
        </button>
      </div>
    </div>
  );
}

function SymbolG({ s, selected, moving }: { s: SchSymbol; selected: boolean; moving: boolean }) {
  const html = useMemo(() => symbolSvg(s, INK), [s]);
  const [l, t, r, b] = s.box;
  return (
    <g data-sym={s.key} data-hit="symbol" style={{ cursor: moving ? "grabbing" : "grab" }} opacity={moving ? 0.85 : 1}>
      <rect x={l - 1.5} y={t - 5.5} width={r - l + 3} height={b - t + 11} fill={selected ? "rgba(47, 91, 232, 0.07)" : "transparent"} stroke={selected ? HI : "none"} strokeWidth={0.35} strokeDasharray="1.2 0.8" rx={1} />
      <g dangerouslySetInnerHTML={{ __html: html }} pointerEvents="none" />
    </g>
  );
}
