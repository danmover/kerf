// The Build tab's Board section: each circuit board drawn from its routed
// copper, with its rule check and the files a board house needs.
//
// The drawing is the board preview (boardSvg) with an overlay in the same
// millimetre frame on top: hit areas for every part, what is selected or
// hovered, and the rule check's problems. Routing runs in the board runtime's
// worker; while a change re-routes, the last routed board stays on screen.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { hoverParts, revealSpan, select, useView } from "../app/view";
import { toast } from "../app/ui";
import type { CheckItem } from "../core/checks";
import type { Model } from "../core/model";
import { fmtNum } from "../lang/values";
import { boardSpecs } from "../machine/boards";
import type { RouteState } from "../machine/boardChecks";
import { bareBoard, boardParts, boardProblems, gerberZip, partBox, type BoardPart, type BoardProblem } from "../machine/boardPack";
import { boardHash, boardSvg, type BoardSpec, type RoutedBoard } from "../machine/pcb";
import { safeName } from "../machine/pcb/gerber";
import type { BBox } from "../machine/pcb/geom";
import { routeFor, useBoards } from "../machine/pcb/runtime";
import type { BoardDef, MachineData } from "../machine/types";
import { download } from "../persist/files";
import { Segmented } from "./common";
import { Icon, StatusIcon } from "./icons";
import "../styles/board.css";

type Side = "top" | "bottom";
type View = Side | "both";
type Tab = "checks" | "parts";
/** What the drawing should bring into view: a part picked in the list, or a problem. */
type Aim = { ref?: string; problem?: string; n: number };

/** Remembered while the dock switches tabs. */
const useBoardUi = create<{ board: string; view: View; tab: Tab }>(() => ({ board: "", view: "top", tab: "checks" }));

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const mm = (v: number) => fmtNum(v, 1);

/** Part ids (instances) of a component, for selecting it in the 3D view. */
const partIds = (model: Model, comp: string) => model.parts.filter((p) => p.name === comp).map((p) => p.id);

/** The component a 3D part id belongs to: "r_pd.leads" → r_pd, "pins#2" → pins. */
const compOfId = (id: string) => id.split(".")[0].replace(/#\d+$/, "");

export function BoardView({ model, m }: { model: Model; m: MachineData; items: CheckItem[] }) {
  const specs = useMemo(() => boardSpecs(m), [m]);
  const chosen = useBoardUi((s) => s.board);
  const cur = specs.find((b) => b.def.name === chosen) ?? specs[0];
  if (!cur) {
    return (
      <div className="mp-pad">
        <div className="empty-state">No circuit boards yet. Add one with lib.circuit_board(w:, d:) and place parts on it with on: and at:.</div>
      </div>
    );
  }
  return <BoardPane key={cur.def.name} model={model} m={m} def={cur.def} spec={cur.spec} all={specs.map((b) => b.def)} />;
}

// ---------------------------------------------------------------- one board

function BoardPane({ model, m, def, spec, all }: { model: Model; m: MachineData; def: BoardDef; spec: BoardSpec; all: BoardDef[] }) {
  const view = useBoardUi((s) => s.view);
  const tab = useBoardUi((s) => s.tab);
  const hash = useMemo(() => boardHash(spec), [spec]);
  const cached = useBoards((s) => s.byHash.get(hash));
  const [asked, setAsked] = useState<RouteState | null>(null);
  const empty = spec.parts.length === 0;
  // ask the runtime for this version of the board (a cache hit, or queued for the worker)
  useEffect(() => {
    setAsked(empty ? null : routeFor(spec));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, empty]);
  const st = empty ? undefined : (cached ?? asked ?? undefined);
  // the copper hash leaves out values and texts: draw the cached route with the current spec
  const routed = useMemo(() => (st?.status === "done" ? { ...st.board, spec } : undefined), [st, spec]);
  const stale = st?.status === "routing" ? st.board : undefined;
  const bare = useMemo(() => bareBoard(spec), [spec]);
  const shown: RoutedBoard = routed ?? stale ?? bare;
  const routing = st?.status === "routing";

  const parts = useMemo(() => boardParts(m, spec, def.name), [m, spec, def.name]);
  const byRef = useMemo(() => new Map(parts.map((p) => [p.ref, p])), [parts]);
  const refOfComp = useMemo(() => new Map(parts.map((p) => [p.comp.name, p.ref])), [parts]);
  const problems = useMemo(() => boardProblems(spec, routed), [spec, routed]);

  const selected = useView((s) => s.selected);
  const selRefs = useMemo(() => new Set(selected.map((id) => refOfComp.get(compOfId(id))).filter((r): r is string => !!r)), [selected, refOfComp]);
  const [hot, setHot] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const focused = problems.find((p) => p.id === focus);
  const [aim, setAim] = useState<Aim | null>(null);

  // hovering a part here emphasises it in the 3D view too
  const hover = useCallback(
    (ref: string | null) => {
      setHot(ref);
      const bp = ref ? byRef.get(ref) : undefined;
      hoverParts(bp ? partIds(model, bp.comp.name) : []);
    },
    [byRef, model],
  );
  useEffect(() => () => hoverParts([]), []);

  const pickPart = useCallback(
    (ref: string, center = false) => {
      const bp = byRef.get(ref);
      if (!bp) return;
      select(partIds(model, bp.comp.name));
      revealSpan(bp.comp.span);
      if (center) {
        setFocus(null);
        setAim({ ref, n: Date.now() });
      }
    },
    [byRef, model],
  );
  const pickProblem = (p: BoardProblem) => {
    if (focus === p.id) {
      setFocus(null);
      return;
    }
    setFocus(p.id);
    setAim({ problem: p.id, n: Date.now() });
    const comps = p.refs.map((r) => byRef.get(r)?.comp).filter((c): c is NonNullable<typeof c> => !!c);
    if (comps.length) select(comps.flatMap((c) => partIds(model, c.name)));
    if (comps.length === 1) revealSpan(comps[0].span);
  };
  // a fixed problem leaves the list
  useEffect(() => {
    if (focus && !focused) setFocus(null);
  }, [focus, focused]);

  const downloadGerbers = () => {
    if (!routed) return;
    const name = safeName(spec.name);
    download(gerberZip(routed), `${name}-gerbers.zip`, "application/zip");
    if (problems.length) toast({ kind: "warn", title: "Gerbers downloaded, with problems", detail: `The board still has ${plural(problems.length, "problem")}. Fix them before ordering it.` }, 8000);
    else toast({ kind: "success", title: "Gerbers downloaded", detail: `${name}-gerbers.zip: upload it as it is to JLCPCB, PCBWay or another board house. The README inside lists the options to pick.` }, 7000);
  };

  const chip = empty ? null : st?.status === "error" ? (
    <span className="chip fail">routing failed</span>
  ) : routing ? (
    <span className="chip accent bv-chip">
      <span className="spinner" style={{ width: 9, height: 9, borderWidth: 1.5 }} />
      {stale ? "re-routing" : "routing"}
    </span>
  ) : problems.length ? (
    <span className="chip fail">{plural(problems.length, "problem")}</span>
  ) : routed ? (
    <span className="chip pass">routed · rules clean</span>
  ) : null;

  return (
    <div className="bv">
      <div className="mp-toolbar">
        {all.length > 1 && <Segmented id="board-pick" value={def.name} onChange={(v) => useBoardUi.setState({ board: v })} options={all.map((d) => ({ value: d.name, label: d.title }))} />}
        <Segmented
          id="board-side"
          value={view}
          onChange={(v) => useBoardUi.setState({ view: v })}
          options={[
            { value: "top", label: "Top", title: "The parts side, as you look at it" },
            { value: "bottom", label: "Bottom", title: "The solder side, mirrored as when you turn the board over" },
            { value: "both", label: "Both", title: "Top and bottom together, the bottom turned over" },
          ]}
        />
        <span className="mono dim" style={{ fontSize: 11 }}>
          {mm(spec.w)} × {mm(spec.h)} mm · {plural(spec.parts.length, "part")}
        </span>
        {chip}
        <div className="grow" />
        <ZoomControls />
        <button className="btn sm" onClick={downloadGerbers} disabled={!routed} data-tip={routed ? "Gerber and drill files in one zip, ready to upload to a board house" : "Available when the routing finishes"}>
          <Icon.Download size={13} /> Download Gerbers
        </button>
      </div>
      <div className="bv-main">
        <div className="bv-stage">
          <BoardCanvas board={shown} view={view} aim={aim} onHot={hover} onPick={pickPart}>
            {(side) => <Overlay board={shown} side={side} hot={hot} selected={selRefs} problems={problems} focus={focused} aim={aim} />}
          </BoardCanvas>
          {(routing || st?.status === "error") && (
            <div className={`bv-badge ${st?.status === "error" ? "fail" : ""}`}>
              {routing && <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} />}
              {st?.status === "error" ? "The router stopped: showing the parts without copper" : stale ? "Re-routing for the latest change: showing the last routed board" : "Routing the copper tracks…"}
            </div>
          )}
          <Hud part={hot ? byRef.get(hot) : undefined} />
        </div>
        <aside className="bv-side">
          <Summary spec={spec} st={st} routed={routed} problems={problems} parts={parts} empty={empty} />
          <div className="bv-tabs">
            <Segmented
              id="board-tab"
              value={tab}
              onChange={(v) => useBoardUi.setState({ tab: v })}
              options={[
                { value: "checks", label: <>Rule check{problems.length > 0 && <span className="bv-n bad">{problems.length}</span>}</> },
                { value: "parts", label: <>Parts<span className="bv-n">{parts.length}</span></> },
              ]}
            />
          </div>
          {tab === "checks" ? (
            <ProblemList problems={problems} st={st} routed={routed} spec={spec} focus={focused?.id} onPick={pickProblem} empty={empty} />
          ) : (
            <PartsTable parts={parts} hot={hot} selected={selRefs} onHover={hover} onPick={(ref) => pickPart(ref, true)} />
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- summary

function Summary({ spec, st, routed, problems, parts, empty }: { spec: BoardSpec; st?: RouteState; routed?: RoutedBoard; problems: BoardProblem[]; parts: BoardPart[]; empty: boolean }) {
  let level: "pass" | "fail" | "pending" = "pending";
  let head: string;
  let detail: string;
  if (empty) {
    head = "No parts on this board yet";
    detail = "Place parts on it with on: and at: (x, y), in mm from its bottom-left corner.";
  } else if (st?.status === "error") {
    level = "fail";
    head = "Routing failed";
    detail = st.error;
  } else if (!routed) {
    level = problems.length ? "fail" : "pending";
    head = "Routing the copper…";
    detail = problems.length ? `The placement already has ${plural(problems.length, "problem")}.` : "Placement is clean. The rule check runs on the routed copper in a second or two.";
  } else if (problems.length) {
    level = "fail";
    head = `${plural(problems.length, "problem")} to fix before ordering`;
    const s = routed.stats;
    detail = s.routed < s.connections ? `${s.routed} of ${s.connections} connections routed.` : `Every connection is routed, but the ${problems.some((p) => p.source === "placement") ? "placement" : "rule"} check found problems.`;
  } else {
    level = "pass";
    head = "Ready to order";
    detail = "Every connection routed on 2 layers and the design rule check is clean.";
  }
  const s = routed?.stats;
  const widths = routed?.tracks.map((t) => t.w) ?? [];
  const pour = spec.nets.find((n) => n.pour)?.name;
  const bottom = parts.filter((p) => p.placed.side === "bottom").length;
  return (
    <div className="bv-summary-wrap">
      <div className={`bv-summary ${level}`}>
        {level === "pending" ? <span className="spinner" style={{ width: 15, height: 15, margin: "2px 0 0 2px" }} /> : <StatusIcon status={level} />}
        <div style={{ minWidth: 0 }}>
          <div className="head">{head}</div>
          <div className="detail">{detail}</div>
        </div>
      </div>
      <div className="bv-stats">
        <Stat k="Parts" v={parts.length} s={bottom ? `${bottom} on bottom` : "all on top"} tip={bottom ? `${plural(bottom, "part")} on the bottom side: ${parts.filter((p) => p.placed.side === "bottom").map((p) => p.ref).join(", ")}` : undefined} />
        <Stat k="Nets" v={s ? (s.routed < s.connections ? `${s.routed}/${s.connections}` : s.connections) : "…"} s={s ? (s.routed < s.connections ? "routed" : "all routed") : "routing"} bad={!!s && s.routed < s.connections} tip="Connections between pins, routed as copper tracks" />
        <Stat k="Vias" v={s ? s.vias : "…"} s={pour ? `${pour} pour` : "2 layers"} tip={pour ? `${pour} fills the free copper on both layers; vias join the layers` : undefined} />
        <Stat k="Track" v={s ? `${fmtNum(s.trackLength / 1000, 2)} m` : "…"} s={widths.length ? `${fmtNum(Math.min(...widths))}–${fmtNum(Math.max(...widths))} mm` : "—"} tip="Total track length, and the narrowest and widest track" />
      </div>
    </div>
  );
}

function Stat({ k, v, s, bad, tip }: { k: string; v: ReactNode; s: string; bad?: boolean; tip?: string }) {
  return (
    <div className="bv-stat" data-tip={tip}>
      <span className="k">{k}</span>
      <span className={`v ${bad ? "bad" : ""}`}>{v}</span>
      <span className="s">{s}</span>
    </div>
  );
}

// ---------------------------------------------------------------- rule check

const SOURCE_WORD: Record<BoardProblem["source"], string> = { placement: "placement", routing: "not routed", rules: "rules" };
const KIND_WORD: Record<BoardProblem["kind"], string> = { unrouted: "open", clearance: "clearance", overlap: "overlap", offboard: "edge", short: "short", drill: "drill", pin: "netlist" };

function ProblemList({ problems, st, routed, spec, focus, onPick, empty }: { problems: BoardProblem[]; st?: RouteState; routed?: RoutedBoard; spec: BoardSpec; focus?: string; onPick: (p: BoardProblem) => void; empty: boolean }) {
  const passes: { title: string; detail: string; status: "pass" | "pending" }[] = [];
  if (!empty && !problems.some((p) => p.source === "placement")) passes.push({ title: "Parts placed", detail: `${plural(spec.parts.length, "part")} inside the outline, clear of each other and the mounting holes.`, status: "pass" });
  if (routed && !problems.some((p) => p.source !== "placement")) {
    const r = routed.rules;
    passes.push({ title: "Every connection routed", detail: `${routed.stats.connections} connections on 2 layers with ${plural(routed.stats.vias, "via")}.`, status: "pass" });
    passes.push({ title: "Design rule check clean", detail: `${fmtNum(r.clearance)} mm clearance, tracks ${fmtNum(r.track)} mm or wider, ${fmtNum(r.edge)} mm from the edge.`, status: "pass" });
  } else if (!routed && !empty && st?.status !== "error") passes.push({ title: "Routing", detail: "The rule check of the copper runs when the routing finishes.", status: "pending" });
  return (
    <div className="mp-list bv-list">
      {problems.map((p) => (
        <div key={p.id} className={`check-item ${focus === p.id ? "focused" : ""}`} onClick={() => onPick(p)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onPick(p)} data-tip={p.at ? "Show it on the board" : undefined}>
          <StatusIcon status="fail" />
          <div style={{ minWidth: 0 }}>
            <div className="title">{p.message}</div>
            <div className="detail">
              {SOURCE_WORD[p.source]}
              {p.at && ` · at ${mm(p.at[0])}, ${mm(p.at[1])} mm`}
              {p.refs.length > 0 && ` · ${p.refs.join(", ")}`}
            </div>
          </div>
          <div className="basis">{KIND_WORD[p.kind]}</div>
        </div>
      ))}
      {passes.map((p) => (
        <div key={p.title} className="check-item bv-pass">
          <StatusIcon status={p.status} />
          <div style={{ minWidth: 0 }}>
            <div className="title">{p.title}</div>
            <div className="detail">{p.detail}</div>
          </div>
          <div />
        </div>
      ))}
      {empty && <div className="mp-none">Nothing to check until parts are placed on the board.</div>}
    </div>
  );
}

// ---------------------------------------------------------------- parts

function PartsTable({ parts, hot, selected, onHover, onPick }: { parts: BoardPart[]; hot: string | null; selected: Set<string>; onHover: (ref: string | null) => void; onPick: (ref: string) => void }) {
  if (!parts.length) return <div className="mp-list"><div className="mp-none">No parts on this board yet.</div></div>;
  return (
    <div className="mp-list bv-list" onPointerLeave={() => onHover(null)}>
      <table className="bom bv-parts">
        <colgroup>
          <col style={{ width: 64 }} />
          <col style={{ width: 80 }} />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>Ref</th>
            <th>Value</th>
            <th>Part · footprint</th>
          </tr>
        </thead>
        <tbody>
          {parts.map((p) => (
            <tr key={p.ref} className={`${hot === p.ref ? "hot" : ""} ${selected.has(p.ref) ? "sel" : ""}`} onPointerEnter={() => onHover(p.ref)} onClick={() => onPick(p.ref)}>
              <td className="ref">
                <div className="mono">{p.ref}</div>
                <div className="mp-sub mono mp-ellipsis" data-tip={`${p.comp.name} in the design`}>
                  {p.comp.name}
                </div>
              </td>
              <td className="mono val">{p.value}</td>
              <td>
                <div className="pn">{p.part.name}</div>
                <div className="mp-sub">
                  {p.footprint}
                  {p.placed.side === "bottom" && <span className="bv-tag">bottom</span>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- the drawing

/** CSS pixels per millimetre at 100 %: the board at its real size on a 96 dpi screen. */
const BASE = 96 / 25.4;
const PAD = 14;
const GAP = 28;
const CAPTION = 22;
/** between sheets stacked one above the other: the lower one's caption sits in it */
const STACK_GAP = CAPTION + 12;
/** kept clear under the fitted board for the note in the bottom corner, when the panel is tall enough to show it */
const HUD_ROOM = 22;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

interface ZoomState {
  zoom: number;
  fit: boolean;
  request: { z: number | "fit"; n: number } | null;
}
const useZoom = create<ZoomState>(() => ({ zoom: 1, fit: true, request: null }));
let zoomNonce = 0;
const requestZoom = (z: number | "fit") => useZoom.setState({ request: { z, n: ++zoomNonce } });

function ZoomControls() {
  const zoom = useZoom((s) => s.zoom);
  const fit = useZoom((s) => s.fit);
  const actual = Math.abs(zoom - 1) < 0.01;
  return (
    <span className="mp-zoom">
      <button className="icon-btn sm" onClick={() => requestZoom(zoom / 1.25)} aria-label="Zoom out" data-tip="Zoom out (ctrl + wheel)">
        <span style={{ fontSize: 15, lineHeight: 1 }}>−</span>
      </button>
      <button className="icon-btn sm val" style={{ width: "auto" }} onClick={() => requestZoom(actual ? "fit" : 1)} data-tip={actual ? "Fit the whole board" : "Real size (100 % is the board's actual size)"}>
        {Math.round(zoom * 100)}%
      </button>
      <button className="icon-btn sm" onClick={() => requestZoom(zoom * 1.25)} aria-label="Zoom in" data-tip="Zoom in (ctrl + wheel)">
        <Icon.Plus size={13} />
      </button>
      <button className={`icon-btn sm fit ${fit ? "active" : ""}`} onClick={() => requestZoom("fit")} aria-label="Fit" data-tip="Fit the whole board">
        fit
      </button>
    </span>
  );
}

/** The viewBox boardSvg draws in: millimetres, the board's bottom-left corner at (0, h). */
function viewBoxOf(svg: string, spec: BoardSpec): [number, number, number, number] {
  const m = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : [-2, -2, spec.w + 4, spec.h + 4];
}

const refAt = (t: EventTarget | null) => (t instanceof Element ? (t.closest("[data-ref]")?.getAttribute("data-ref") ?? null) : null);

/** Pan, zoom and the sheets of one or both sides; hovering and clicking a part's hit area in the overlay reports its reference. */
function BoardCanvas({ board, view, aim, onHot, onPick, children }: { board: RoutedBoard; view: View; aim: Aim | null; onHot: (ref: string | null) => void; onPick: (ref: string) => void; children: (side: Side) => ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const zoom = useZoom((s) => s.zoom);
  const fit = useZoom((s) => s.fit);
  const request = useZoom((s) => s.request);
  const anchor = useRef<{ cx: number; cy: number; px: number; py: number } | null>(null);
  const drag = useRef<{ x: number; y: number; sl: number; st: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** both sides one above the other when that shows them larger than side by side, and the room kept for the note */
  const [room, setRoom] = useState({ stack: false, reserve: 0 });
  /** the click that ends a drag is not a pick */
  const dragged = useRef(false);
  const hotRef = useRef<string | null>(null);
  const setHot = (r: string | null) => {
    if (r !== hotRef.current) onHot((hotRef.current = r));
  };
  const sides: Side[] = view === "both" ? ["top", "bottom"] : [view];
  const svgs = useMemo(() => {
    const out = new Map<Side, { html: { __html: string }; vb: [number, number, number, number] }>();
    for (const s of ["top", "bottom"] as Side[]) {
      if (!sides.includes(s)) continue;
      const { svg } = boardSvg(board, { side: s, scale: 1 });
      out.set(s, { html: { __html: svg }, vb: viewBoxOf(svg, board.spec) });
    }
    return out;
  }, [board, view]); // eslint-disable-line react-hooks/exhaustive-deps
  const vb = svgs.get(sides[0])!.vb;
  const sheetW = vb[2] * BASE;
  const sheetH = vb[3] * BASE;
  const n = sides.length;
  const cap = n > 1 ? CAPTION : 0;

  /** the zoom that shows the whole of every sheet, and whether stacking the sheets shows them larger */
  const layout = useCallback(() => {
    const el = box.current;
    if (!el) return { zoom: 1, stack: false, reserve: 0 };
    const reserve = el.clientHeight > 300 ? HUD_ROOM : 0;
    const w = el.clientWidth - 2 * PAD;
    const h = el.clientHeight - 2 * PAD - cap - reserve;
    const row = Math.min((w - (n - 1) * GAP) / (n * sheetW), h / sheetH);
    const col = n > 1 ? Math.min(w / sheetW, (h - (n - 1) * STACK_GAP) / (n * sheetH)) : 0;
    const stack = col > row * 1.02;
    return { zoom: clamp(stack ? col : row, 0.2, 16), stack, reserve };
  }, [n, sheetW, sheetH, cap]);
  const fitZoom = useCallback(() => layout().zoom, [layout]);
  const applyFit = useCallback(() => {
    const f = layout();
    setRoom((r) => (r.stack === f.stack && r.reserve === f.reserve ? r : { stack: f.stack, reserve: f.reserve }));
    useZoom.setState({ fit: true, zoom: f.zoom });
  }, [layout]);

  const zoomTo = useCallback((z: number, at?: { x: number; y: number }) => {
    const el = box.current;
    const sh = inner.current;
    if (!el || !sh) return;
    const cur = useZoom.getState().zoom;
    const px = at?.x ?? el.clientWidth / 2;
    const py = at?.y ?? el.clientHeight / 2;
    const r = sh.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    anchor.current = { cx: (b.left + px - r.left) / cur, cy: (b.top + py - r.top) / cur, px, py };
    useZoom.setState({ zoom: clamp(z, 0.2, 16), fit: false });
  }, []);

  // fitted when the board or the view changes size
  useLayoutEffect(() => {
    applyFit();
    useZoom.setState({ request: null });
  }, [applyFit]);

  // follow the panel size while fitted
  useEffect(() => {
    const el = box.current;
    if (!el || !fit) return;
    const ro = new ResizeObserver(applyFit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, applyFit]);

  // toolbar requests
  useEffect(() => {
    if (!request) return;
    if (request.z === "fit") applyFit();
    else zoomTo(request.z);
  }, [request, applyFit, zoomTo]);

  // keep the point under the pointer (or the middle) still while zooming
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = box.current;
    const sh = inner.current;
    anchor.current = null;
    if (!a || !el || !sh) return;
    const r = sh.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    el.scrollLeft += r.left - b.left + a.cx * zoom - a.px;
    el.scrollTop += r.top - b.top + a.cy * zoom - a.py;
  }, [zoom]);

  // bring what was picked in the side panel into view when it is off screen
  useEffect(() => {
    if (!aim) return;
    const el = box.current;
    if (!el) return;
    const t = requestAnimationFrame(() => {
      const target = el.querySelector("[data-aim]");
      if (!target) return;
      const b = el.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      const cx = r.left + r.width / 2 - b.left;
      const cy = r.top + r.height / 2 - b.top;
      const margin = 40;
      if (cx < margin || cy < margin || cx > b.width - margin || cy > b.height - margin) {
        el.scrollTo({ left: el.scrollLeft + cx - b.width / 2, top: el.scrollTop + cy - b.height / 2, behavior: "smooth" });
      }
    });
    return () => cancelAnimationFrame(t);
  }, [aim]);

  // ctrl + wheel (and trackpad pinch) zooms around the pointer
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const b = el.getBoundingClientRect();
      zoomTo(useZoom.getState().zoom * Math.exp(-e.deltaY * 0.0025), { x: e.clientX - b.left, y: e.clientY - b.top });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomTo]);

  const { spec } = board;
  const r = Math.max(0, Math.min(spec.corner ?? 0, spec.w / 2, spec.h / 2));
  return (
    <div
      ref={box}
      className={`mp-canvas bv-canvas ${dragging ? "dragging" : ""}`}
      onPointerDown={(e) => {
        if (e.button !== 0 || !box.current) return;
        dragged.current = false;
        drag.current = { x: e.clientX, y: e.clientY, sl: box.current.scrollLeft, st: box.current.scrollTop, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        const el = box.current;
        if (!d || !el) {
          setHot(refAt(e.target));
          return;
        }
        if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
        if (!d.moved) {
          d.moved = true;
          dragged.current = true;
          el.setPointerCapture(e.pointerId);
          setDragging(true);
          setHot(null);
        }
        el.scrollLeft = d.sl - (e.clientX - d.x);
        el.scrollTop = d.st - (e.clientY - d.y);
      }}
      onPointerUp={() => {
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      onPointerLeave={() => setHot(null)}
      onClick={(e) => {
        if (dragged.current) return;
        const r = refAt(e.target);
        if (r) onPick(r);
      }}
      onDoubleClick={(e) => {
        const b = box.current!.getBoundingClientRect();
        const z = useZoom.getState().zoom;
        if (z >= fitZoom() * 3.5) requestZoom("fit");
        else zoomTo(z * 2.5, { x: e.clientX - b.left, y: e.clientY - b.top });
      }}
    >
      <div className="mp-canvas-inner" style={{ padding: PAD, paddingBottom: PAD + room.reserve }}>
        <div ref={inner} className="bv-sheets" style={{ flexDirection: room.stack && n > 1 ? "column" : "row", gap: room.stack && n > 1 ? STACK_GAP : GAP, paddingTop: cap }}>
          {sides.map((s) => {
            const g = svgs.get(s)!;
            const [x0, y0] = g.vb;
            return (
              <div key={s} className="bv-sheet" style={{ width: sheetW * zoom, height: sheetH * zoom }}>
                {cap > 0 && <div className="bv-caption">{s === "top" ? "Top" : "Bottom, turned over"}</div>}
                <div className="bv-shadow" style={{ left: -x0 * BASE * zoom, top: -y0 * BASE * zoom, width: spec.w * BASE * zoom, height: spec.h * BASE * zoom, borderRadius: r * BASE * zoom }} />
                <div className="bv-svg" dangerouslySetInnerHTML={g.html} />
                {children(s)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** What sits on top of the board drawing, in its own millimetre frame. */
function Overlay({ board, side, hot, selected, problems, focus, aim }: { board: RoutedBoard; side: Side; hot: string | null; selected: Set<string>; problems: BoardProblem[]; focus?: BoardProblem; aim: Aim | null }) {
  const { spec } = board;
  const { w, h } = spec;
  const X = (x: number) => (side === "bottom" ? w - x : x);
  const Y = (y: number) => h - y;
  const boxes = useMemo(() => {
    // the other side's parts underneath, so the side you look at wins; small parts above big ones
    const area = (b: BBox) => (b[2] - b[0]) * (b[3] - b[1]);
    const list = spec.parts.map((p) => ({ ref: p.ref, side: p.side, box: partBox(p) }));
    return list.sort((a, b) => Number(a.side === side) - Number(b.side === side) || area(b.box) - area(a.box));
  }, [spec, side]);
  const rect = (b: BBox, pad = 0.5) => {
    const x0 = Math.min(X(b[0]), X(b[2])) - pad;
    const x1 = Math.max(X(b[0]), X(b[2])) + pad;
    return { x: x0, y: Y(b[3]) - pad, width: x1 - x0, height: b[3] - b[1] + 2 * pad };
  };
  const boxOf = new Map(boxes.map((b) => [b.ref, b.box]));
  const marks = problems.filter((p) => p.at);
  const aimAt = aim?.problem ? problems.find((p) => p.id === aim.problem)?.at : undefined;
  const aimBox: BBox | undefined = aim?.ref ? boxOf.get(aim.ref) : aimAt ? [aimAt[0] - 3, aimAt[1] - 3, aimAt[0] + 3, aimAt[1] + 3] : undefined;
  return (
    <svg className="bv-ov" viewBox={`-2 -2 ${w + 4} ${h + 4}`} preserveAspectRatio="none">
      {boxes.map((b) => (
        <rect key={b.ref} data-ref={b.ref} className={`bv-hit ${b.side === side ? "" : "far"}`} {...rect(b.box, 0.3)} />
      ))}
      {[...selected].map((ref) => {
        const b = boxOf.get(ref);
        return b ? <rect key={`s${ref}`} className="bv-sel" rx={0.6} {...rect(b)} /> : null;
      })}
      {problems
        .filter((p) => p.line)
        .map((p) => (
          <line key={`l${p.id}`} className={`bv-rat ${focus?.id === p.id ? "on" : ""}`} x1={X(p.line![0][0])} y1={Y(p.line![0][1])} x2={X(p.line![1][0])} y2={Y(p.line![1][1])} />
        ))}
      {marks.map((p) => (
        <circle key={`m${p.id}`} className={`bv-mark ${focus?.id === p.id ? "on" : ""}`} cx={X(p.at![0])} cy={Y(p.at![1])} r={1.2} />
      ))}
      {focus?.at && (
        <g className="bv-focus">
          <circle className="ring" cx={X(focus.at[0])} cy={Y(focus.at[1])} r={2.6} />
          <circle className="pulse" cx={X(focus.at[0])} cy={Y(focus.at[1])} r={2.6} />
        </g>
      )}
      {focus &&
        focus.refs.map((ref) => {
          const b = boxOf.get(ref);
          return b ? <rect key={`f${ref}`} className="bv-focus-part" rx={0.6} {...rect(b)} /> : null;
        })}
      {hot && boxOf.get(hot) && <rect className="bv-hot" rx={0.6} {...rect(boxOf.get(hot)!)} />}
      {aimBox && <rect className="bv-aim" data-aim="" {...rect(aimBox, 2)} />}
    </svg>
  );
}

/** The part under the pointer, or how to use the drawing. */
function Hud({ part }: { part?: BoardPart }) {
  return (
    <div className={`bv-hud ${part ? "" : "hint"}`}>
      {part ? (
        <>
          <b className="mono">{part.ref}</b>
          {part.value && <span className="mono val">{part.value}</span>}
          <span className="name">{part.part.name}</span>
          <span className="dim">
            {part.footprint}
            {part.placed.side === "bottom" ? " · bottom side" : ""}
          </span>
        </>
      ) : (
        <span className="dim">Drag to pan · ctrl + wheel or double-click to zoom · click a part to select it in the model</span>
      )}
    </div>
  );
}
