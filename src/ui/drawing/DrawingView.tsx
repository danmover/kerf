// Engineering drawings in the workspace: the sheet in place of the 3D view,
// a toolbar to pick, export and restyle drawings, and a card for whatever is
// clicked on the sheet. The card edits values and tolerances directly and
// sends anything else to Claude with the item it is about.

import "./drawing.css";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDesign } from "../../core/engine";
import { setParamValue } from "../../core/sourceEdit";
import { commitSource, endComparison } from "../../app/project";
import { revealSpan, select, useView, requestCamera, type ViewPreset } from "../../app/view";
import { toast, errorText, useUi } from "../../app/ui";
import { useSketch } from "../sketch/session";
import { sendMessage, useChat } from "../../ai/chat";
import { closeDrawings, drawingSpecs, markAsked, openDrawings, selectSheetItem, setDrawingTheme, showDrawing, useDrawings } from "../../drawing/engine";
import { exportDrawingDxf, exportDrawingPdf, exportDrawingsPdf, exportDrawingSvg } from "../../drawing/export";
import { addBlockLine, ensureBlock, setBlockProp, setDimTolerance, type TolEdit } from "../../drawing/source";
import { keyBoxes } from "../../drawing/compose";
import { fmtNum, type Sheet, type SheetDim } from "../../drawing/sheet";
import { generalClass, scaleText } from "../../drawing/spec";
import { Menu, MenuItem } from "../common";
import { Icon } from "../icons";
import { BLUEPRINT, SheetCanvas, WHITE, type CanvasApi } from "./SheetCanvas";

const SheetIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
    <path d="M13 15h8M13 15v5M7 8h4v4H7z" />
  </svg>
);

/** "3D | Drawings" switch over the centre of the workspace. */
export function DrawingSwitch() {
  const open = useDrawings((s) => s.open);
  const model = useDesign((s) => s.model);
  if (!model?.parts.length) return null;
  return (
    <div className="dwg-switch segmented" role="tablist" aria-label="Centre view">
      <button className={!open ? "active" : ""} role="tab" aria-selected={!open} onClick={closeDrawings} data-tip="3D model">
        {!open && <motion.div layoutId="seg-dwg" className="seg-bg" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
        <span>3D</span>
      </button>
      <button className={open ? "active" : ""} role="tab" aria-selected={open} onClick={() => openDrawings()} data-tip="Engineering drawings (D)">
        {open && <motion.div layoutId="seg-dwg" className="seg-bg" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
        <span>Drawings</span>
      </button>
    </div>
  );
}

export function DrawingView() {
  const open = useDrawings((s) => s.open);
  useEffect(() => {
    // D toggles the drawings when nobody is typing
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // dialogs and the sketch editor keep their own keys
      const ui = useUi.getState();
      const sk = useSketch.getState();
      if (ui.settingsOpen || ui.shortcutsOpen || ui.confirm || sk.active || sk.picking) return;
      if (e.key === "d" || e.key === "D") {
        if (useDrawings.getState().open) closeDrawings();
        else if (useDesign.getState().model?.parts.length) openDrawings();
      } else if (e.key === "Escape" && useDrawings.getState().open) {
        if (useDrawings.getState().selected) selectSheetItem(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return <AnimatePresence>{open && <DrawingPane key="dwg" />}</AnimatePresence>;
}

function DrawingPane() {
  const sheet = useDrawings((s) => s.sheet);
  const list = useDrawings((s) => s.list);
  const pending = useDrawings((s) => s.pending);
  const selected = useDrawings((s) => s.selected);
  const theme = useDrawings((s) => s.theme);
  const asked = useDrawings((s) => s.asked);
  const sel3d = useView((s) => s.selected);
  const api = useRef<CanvasApi | null>(null);
  const [, force] = useState(0);

  const highlightParts = useMemo(() => new Set((sheet?.parts ?? []).flatMap((p, i) => (sel3d.includes(p.id) ? [i] : []))), [sheet, sel3d]);
  const askedKeys = useMemo(() => asked.filter((a) => a.name === sheet?.name).map((a) => a.key), [asked, sheet]);

  const run = (f: () => Promise<unknown>) => () => {
    f().catch((e) => toast({ kind: "error", title: "Export failed", detail: errorText(e) }));
  };

  return (
    <motion.div className={`dwg ${theme}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
      {sheet ? (
        <SheetCanvas
          sheet={sheet}
          theme={theme === "paper" ? WHITE : BLUEPRINT}
          selected={selected}
          highlightParts={highlightParts}
          asked={askedKeys}
          onSelect={(k) => {
            selectSheetItem(k);
            force((n) => n + 1);
          }}
          apiRef={api}
        />
      ) : (
        <div className="vp-empty">
          <div className="muted">Nothing to draw yet. Drawings appear as soon as the design has parts.</div>
        </div>
      )}

      <div className="dwg-toolbar" role="toolbar" aria-label="Drawing controls">
        <Menu
          width={300}
          trigger={(o, toggle) => (
            <button className={`dwg-picker ${o ? "active" : ""}`} onClick={toggle} aria-haspopup="menu" data-tip="Choose a drawing">
              <SheetIcon size={15} />
              <span className="t">{sheet?.title ?? "Drawings"}</span>
              <Icon.ChevronDown size={12} />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="menu-label">Drawings in this design</div>
              {list.map((d) => (
                <MenuItem
                  key={d.name}
                  icon={<SheetIcon size={14} />}
                  hint={d.auto ? "auto" : "source"}
                  onClick={() => {
                    showDrawing(d.name);
                    close();
                  }}
                >
                  {d.title}
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
        {sheet && (
          <span className="dwg-meta" data-tip={sheet.auto ? "Sheet and scale are picked automatically" : undefined}>
            {sheet.size} · {scaleText(sheet.scale)} · {sheet.spec.projection === "third" ? "3rd" : "1st"} angle
          </span>
        )}
        {pending > 0 && <span className="dwg-busy">projecting {pending} view{pending > 1 ? "s" : ""}</span>}
        <div className="sep" />
        <button className="icon-btn" onClick={() => api.current?.zoom(1 / 1.25)} data-tip="Zoom out" aria-label="Zoom out">
          −
        </button>
        <button className="icon-btn" onClick={() => api.current?.fit()} data-tip="Fit the sheet (double-click)" aria-label="Fit the sheet">
          <Icon.Fit />
        </button>
        <button className="icon-btn" onClick={() => api.current?.zoom(1.25)} data-tip="Zoom in" aria-label="Zoom in">
          +
        </button>
        <div className="sep" />
        <button className={`icon-btn ${theme === "paper" ? "active" : ""}`} onClick={() => setDrawingTheme(theme === "paper" ? "blueprint" : "paper")} data-tip={theme === "paper" ? "Dark sheet" : "White paper"} aria-label="Sheet colours">
          <Icon.Eye />
        </button>
        <button className="icon-btn" disabled={!sheet} onClick={() => sheet && editInSource(sheet)} data-tip="Edit this drawing in the source" aria-label="Edit in the source">
          <Icon.Code />
        </button>
        <Menu
          align="right"
          width={250}
          trigger={(o, toggle) => (
            <button className={`icon-btn ${o ? "active" : ""}`} onClick={toggle} disabled={!sheet} data-tip="Export drawings" aria-label="Export drawings">
              <Icon.Download />
            </button>
          )}
        >
          {(close) => {
            const go = (f: () => Promise<unknown>) => () => {
              close();
              run(f)();
            };
            return (
              <>
                <div className="menu-label">This drawing</div>
                <MenuItem icon={<Icon.Doc size={14} />} onClick={go(exportDrawingPdf)} hint=".pdf">
                  PDF for printing
                </MenuItem>
                <MenuItem icon={<Icon.Layers size={14} />} onClick={go(exportDrawingDxf)} hint=".dxf">
                  DXF for CAD and laser cutting
                </MenuItem>
                <MenuItem icon={<Icon.Eye size={14} />} onClick={go(exportDrawingSvg)} hint=".svg">
                  SVG vector image
                </MenuItem>
                <div className="menu-sep" />
                <MenuItem icon={<Icon.Doc size={14} />} onClick={go(exportDrawingsPdf)} hint=".pdf">
                  Every drawing, one PDF
                </MenuItem>
              </>
            );
          }}
        </Menu>
      </div>

      <div className="dwg-hint">
        <b>click</b> a dimension, view or part to change it or ask Claude · <b>drag</b> pan · <b>wheel</b> zoom · <b>D</b> back to 3D
      </div>
      {sheet && sheet.warnings.length > 0 && !selected && (
        <div className="dwg-warn" data-tip={sheet.warnings.join("\n")}>
          <Icon.Alert size={12} /> {sheet.warnings[0]}
          {sheet.warnings.length > 1 ? ` (+${sheet.warnings.length - 1} more)` : ""}
        </div>
      )}

      <AnimatePresence>{sheet && selected && <ItemCard key={selected} sheet={sheet} itemKey={selected} api={api} />}</AnimatePresence>
    </motion.div>
  );
}

// ---------- writing changes ----------

/** Applies a change to the active drawing's block, writing an automatic drawing out first. */
function editDrawing(sheet: Sheet, message: string, change: (src: string, block: string) => string) {
  // a hover comparison is for looking; the edit builds on the real design
  endComparison();
  const { source, model } = useDesign.getState();
  const spec = drawingSpecs(model).find((s) => s.name === sheet.name);
  if (!model || !spec) return;
  const { src, name, created } = ensureBlock(source, model, spec);
  const next = change(src, name);
  if (next === source) return;
  commitSource(next, "you", created ? `${message} (wrote out the ${spec.title} drawing)` : message);
  // the same sheet under its block name: keep the card open on the item being edited
  if (created) showDrawing(name, { keepSelection: true });
}

function editInSource(sheet: Sheet) {
  endComparison();
  const { source, model } = useDesign.getState();
  const spec = drawingSpecs(model).find((s) => s.name === sheet.name);
  if (!model || !spec) return;
  if (spec.auto) {
    const { src, name } = ensureBlock(source, model, spec);
    commitSource(src, "you", `Wrote out the ${spec.title} drawing so it can be changed`);
    showDrawing(name);
    const block = useDesign.getState().model?.drawings.find((d) => d.name === name);
    if (block?.span) reveal(block.span);
    return;
  }
  if (spec.span) reveal(spec.span);
}

function reveal(span: { start: number; end: number }) {
  useView.setState({ dockOpen: true, dockTab: "code" });
  revealSpan(span);
}

// ---------- the item card ----------

interface Described {
  kind: string;
  title: string;
  /** how the item is named in a message to Claude */
  about: string;
  chips: string[];
}

function describe(sheet: Sheet, key: string): Described | null {
  const viewName = (i: number) => {
    const v = sheet.views[i];
    return v ? (v.label ? v.label.toLowerCase().replace(/\s*\(.*\)$/, "") : `${v.name} view`) : "view";
  };
  let m = /^d(\d+)$/.exec(key);
  if (m) {
    const d = sheet.dims[Number(m[1])];
    if (!d) return null;
    const what = d.kind === "linear" ? "dimension" : "callout";
    return { kind: d.kind === "linear" ? "Dimension" : "Callout", title: d.text, about: `the ${what} "${d.text}" (${d.label}) in the ${viewName(d.view)}`, chips: d.kind === "linear" ? ["Dimension this from the other edge", "Why is it this size?", "Tighten the tolerance"] : ["Make this a tapped thread", "Why is it this size?", "Add a counterbore"] };
  }
  m = /^v(\d+):p(\d+)$/.exec(key);
  if (m) {
    const p = sheet.parts[Number(m[2])];
    if (!p) return null;
    return { kind: "Part", title: p.label, about: `the part ${p.label} (${p.id}) as seen in the ${viewName(Number(m[1]))}`, chips: ["Explain this part", "Show its drawing", "Make it lighter"] };
  }
  m = /^v(\d+)$/.exec(key);
  if (m) {
    const v = sheet.views[Number(m[1])];
    if (!v) return null;
    return { kind: "View", title: v.label || `${v.name[0].toUpperCase()}${v.name.slice(1)} view`, about: `the ${viewName(Number(m[1]))}`, chips: ["Add a section through this view", "Add a detail of the small features", "Show hidden lines", "Move this view"] };
  }
  m = /^b(\d+)$/.exec(key);
  if (m) {
    const line = sheet.bom.find((b) => b.item === Number(m![1]));
    return { kind: "Balloon", title: line ? `${line.item}. ${line.name}` : `Item ${m[1]}`, about: `balloon ${m[1]}${line ? ` (${line.name})` : ""}`, chips: ["Show its drawing", "Explain this part"] };
  }
  if (key === "tb") return { kind: "Title block", title: sheet.title, about: "the title block", chips: ["Fill in the title block for a workshop", "Set the material and finish"] };
  if (key === "bom") return { kind: "Parts list", title: `${sheet.bom.length} items`, about: "the parts list", chips: ["Add supplier part numbers", "Group the fasteners"] };
  if (key === "n") return { kind: "Notes", title: `${sheet.notes.length} notes`, about: "the general notes", chips: ["Add a note on surface finish", "Add printing instructions"] };
  if (key.startsWith("sec:")) return { kind: "Cutting plane", title: `Section ${key.slice(4)}`, about: `the cutting plane of section ${key.slice(4)}`, chips: ["Move this section", "Cut through the bosses instead"] };
  if (key.startsWith("det:")) return { kind: "Detail", title: `Detail ${key.slice(4)}`, about: `the detail circle ${key.slice(4)}`, chips: ["Enlarge this detail more", "Move the detail circle"] };
  return null;
}

function ItemCard({ sheet, itemKey, api }: { sheet: Sheet; itemKey: string; api: React.MutableRefObject<CanvasApi | null> }) {
  const info = describe(sheet, itemKey);
  const box = useMemo(() => {
    const boxes = keyBoxes(sheet);
    const pm = /^v(\d+):p\d+$/.exec(itemKey);
    return boxes.get(itemKey) ?? (pm ? sheet.views[Number(pm[1])]?.box : undefined);
  }, [sheet, itemKey]);
  const wrap = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // stay beside the item; re-place when the sheet pans, zooms or resizes, or the card grows
  useEffect(() => {
    const place = () => {
      const el = wrap.current;
      const host = el?.parentElement;
      if (!el || !host || !box || !api.current) return;
      const s = api.current.toScreen(box);
      const W = host.clientWidth;
      const H = host.clientHeight;
      const cw = el.offsetWidth;
      const ch = el.offsetHeight;
      let x = s[2] + 14;
      if (x + cw > W - 10) x = s[0] - 14 - cw;
      x = Math.max(10, Math.min(W - cw - 10, x));
      const y = Math.max(54, Math.min(H - ch - 10, (s[1] + s[3]) / 2 - ch / 2));
      setPos((p) => (p && Math.abs(p.x - x) < 0.5 && Math.abs(p.y - y) < 0.5 ? p : { x, y }));
    };
    place();
    const off = api.current?.subscribe(place);
    const ro = new ResizeObserver(place);
    if (wrap.current) ro.observe(wrap.current);
    if (wrap.current?.parentElement) ro.observe(wrap.current.parentElement);
    return () => {
      off?.();
      ro.disconnect();
    };
  }, [box, api]);

  if (!info) return null;
  return (
    <motion.div ref={wrap} className="dwg-card" style={{ left: pos?.x ?? -9999, top: pos?.y ?? 0 }} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.14 }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="kind">{info.kind}</span>
        <button className="icon-btn sm" onClick={() => selectSheetItem(null)} aria-label="Close">
          <Icon.X size={13} />
        </button>
      </div>
      <ItemBody sheet={sheet} itemKey={itemKey} title={info.title} />
      <Ask sheet={sheet} itemKey={itemKey} info={info} />
    </motion.div>
  );
}

function ItemBody({ sheet, itemKey, title }: { sheet: Sheet; itemKey: string; title: string }) {
  const dm = /^d(\d+)$/.exec(itemKey);
  if (dm) return <DimBody sheet={sheet} dim={sheet.dims[Number(dm[1])]} />;
  const pm = /^v(\d+):p(\d+)$/.exec(itemKey);
  if (pm) return <PartBody sheet={sheet} index={Number(pm[2])} />;
  const vm = /^v(\d+)$/.exec(itemKey);
  if (vm) return <ViewBody sheet={sheet} index={Number(vm[1])} />;
  if (itemKey === "tb") return <TitleBody sheet={sheet} />;
  if (itemKey === "n") return <NotesBody sheet={sheet} />;
  const bm = /^b(\d+)$/.exec(itemKey);
  if (bm) {
    const line = sheet.bom.find((b) => b.item === Number(bm[1]));
    return (
      <>
        <div className="big">{title}</div>
        {line && <div className="label">{`${line.qty}× · ${line.description} · ${line.material}`}</div>}
        {line && <OpenDrawingFor ids={line.ids} />}
      </>
    );
  }
  return <div className="big">{title}</div>;
}

function DimBody({ sheet, dim }: { sheet: Sheet; dim: SheetDim | undefined }) {
  const model = useDesign((s) => s.model);
  if (!dim) return null;
  const param = dim.param ? model?.params.find((p) => p.name === dim.param) : undefined;
  const lines = dim.text.split("\n");
  const cls = generalClass(sheet.spec.tolerance);
  const tolNow = dim.fit ? dim.fit : dim.tol ? (Math.abs(dim.tol[0] + dim.tol[1]) < 1e-9 ? `±${fmtNum(dim.tol[0], 3)}` : `+${fmtNum(dim.tol[0], 3)} / ${fmtNum(dim.tol[1], 3)}`) : null;
  const linear = dim.kind === "linear";
  const viewName = sheet.views[dim.view]?.name ?? "front";
  const setTol = (t: TolEdit, label: string) => editDrawing(sheet, label, (src, block) => setDimTolerance(src, block, dim, viewName, t));
  const options: { label: string; t: TolEdit }[] = linear
    ? [
        { label: "±0.2", t: { kind: "pm", t: 0.2 } },
        { label: "±0.1", t: { kind: "pm", t: 0.1 } },
        { label: "±0.05", t: { kind: "pm", t: 0.05 } },
        { label: "±0.02", t: { kind: "pm", t: 0.02 } },
      ]
    : [
        { label: "H7", t: { kind: "fit", code: "H7" } },
        { label: "H8", t: { kind: "fit", code: "H8" } },
        { label: "h6", t: { kind: "fit", code: "h6" } },
        { label: "g6", t: { kind: "fit", code: "g6" } },
        { label: "±0.05", t: { kind: "pm", t: 0.05 } },
      ];
  return (
    <>
      <div className="big">{lines[0]}</div>
      {lines.length > 1 && <div className="lines">{lines.slice(1).join("\n")}</div>}
      <div className="label">{dim.label}</div>
      {param && (
        <div className="section">
          <ParamField name={param.name} locked={!!param.locked} value={typeof param.value === "number" ? param.value : NaN} />
        </div>
      )}
      <div className="section">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
          <span className="label">Tolerance</span>
          <span className="chip">{tolNow ?? (dim.general !== undefined ? `general ±${fmtNum(dim.general, 2)}${cls ? ` (${sheet.spec.tolerance})` : ""}` : "none")}</span>
        </div>
        <div className="row">
          {options.map((o) => (
            <button key={o.label} className={`tolbtn ${tolNow === o.label ? "on" : ""}`} onClick={() => setTol(o.t, `Set the tolerance of ${dim.text.split("\n")[0]} to ${o.label}`)}>
              {o.label}
            </button>
          ))}
          {tolNow && (
            <button className="tolbtn" onClick={() => setTol({ kind: "none" }, `Removed the tolerance from ${dim.text.split("\n")[0]}`)}>
              general
            </button>
          )}
        </div>
      </div>
      {(dim.span || param?.span) && (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn sm ghost" onClick={() => reveal((dim.span ?? param!.span)!)}>
            <Icon.Code size={13} /> {dim.span ? "Show in source" : `Show ${param!.name} in source`}
          </button>
        </div>
      )}
    </>
  );
}

function ParamField({ name, value, locked }: { name: string; value: number; locked: boolean }) {
  const [text, setText] = useState(fmtNum(value, 4));
  useEffect(() => setText(fmtNum(value, 4)), [value]);
  const commit = () => {
    const v = Number(text.replace(",", "."));
    endComparison();
    const { source, model } = useDesign.getState();
    const p = model?.params.find((q) => q.name === name);
    if (!p || !Number.isFinite(v) || Math.abs(v - value) < 1e-9) return setText(fmtNum(value, 4));
    commitSource(setParamValue(source, p, v), "you", `Set ${name} to ${fmtNum(v, 4)} from the drawing`);
  };
  return (
    <div className="field" style={{ marginTop: 0 }}>
      <span>
        {locked ? <Icon.Lock size={11} /> : null} {name}
      </span>
      <input
        className="input mono"
        value={text}
        disabled={locked}
        aria-label={`Value of ${name}`}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setText(fmtNum(value, 4));
        }}
        data-tip={locked ? "This parameter is locked" : "Changes the design; every view updates"}
      />
    </div>
  );
}

function PartBody({ sheet, index }: { sheet: Sheet; index: number }) {
  const p = sheet.parts[index];
  const model = useDesign((s) => s.model);
  if (!p) return null;
  const part = model?.parts.find((q) => q.id === p.id);
  return (
    <>
      <div className="big">{p.label}</div>
      <div className="label">
        {p.item !== undefined ? `Item ${p.item} · ` : ""}
        {part?.material ?? ""}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="btn sm"
          onClick={() => {
            select([p.id]);
            closeDrawings();
          }}
        >
          <Icon.Cube size={13} /> Show in 3D
        </button>
        {part && (
          <button className="btn sm ghost" onClick={() => reveal(part.span)}>
            <Icon.Code size={13} /> Source
          </button>
        )}
      </div>
      <OpenDrawingFor ids={[p.id]} />
    </>
  );
}

/** A button to the drawing of the part behind these instance ids, when it has one. */
function OpenDrawingFor({ ids }: { ids: string[] }) {
  const model = useDesign((s) => s.model);
  const list = useDrawings((s) => s.list);
  const active = useDrawings((s) => s.active);
  const part = model?.parts.find((q) => ids.includes(q.id));
  if (!part) return null;
  const root = part.id.split(/[.#]/)[0];
  const specs = drawingSpecs(model);
  const target = specs.find((s) => s.name !== active && s.of.length === 1 && (s.of[0] === part.name || s.of[0] === root));
  if (!target || !list.some((d) => d.name === target.name)) return null;
  return (
    <div className="row" style={{ marginTop: 6 }}>
      <button className="btn sm ghost" onClick={() => showDrawing(target.name)}>
        <SheetIcon size={13} /> Open the {target.title} drawing
      </button>
    </div>
  );
}

const VIEW_CAMERA: Record<string, ViewPreset> = { front: "front", back: "back", top: "top", bottom: "bottom", left: "left", right: "right", iso: "iso" };

function ViewBody({ sheet, index }: { sheet: Sheet; index: number }) {
  const v = sheet.views[index];
  if (!v) return null;
  const hidden = sheet.spec.hidden;
  return (
    <>
      <div className="big">{v.label || `${v.name[0].toUpperCase()}${v.name.slice(1)} view`}</div>
      <div className="label">
        Scale {scaleText(v.scale)}
        {v.state === "pending" ? " · projecting…" : v.state === "error" ? ` · ${v.error ?? "could not be projected"}` : ""}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={() => editDrawing(sheet, hidden === false ? "Showed hidden lines on the drawing" : "Hid hidden lines on the drawing", (src, block) => setBlockProp(src, block, "hidden_lines", hidden === false ? "true" : "false"))}>
          {hidden === false ? "Show hidden lines" : "Hide hidden lines"}
        </button>
        {VIEW_CAMERA[v.kind] && (
          <button
            className="btn sm ghost"
            onClick={() => {
              closeDrawings();
              requestCamera(VIEW_CAMERA[v.kind]);
            }}
          >
            <Icon.Cube size={13} /> Look in 3D
          </button>
        )}
      </div>
    </>
  );
}

const TITLE_FIELDS: { prop: string; label: string; value: (s: Sheet) => string }[] = [
  { prop: "title", label: "Title", value: (s) => s.title },
  { prop: "number", label: "Drawing no.", value: (s) => s.spec.number ?? "" },
  { prop: "revision", label: "Revision", value: (s) => s.spec.revision ?? "A" },
  { prop: "author", label: "Drawn by", value: (s) => s.spec.author ?? "" },
  { prop: "checked", label: "Checked by", value: (s) => s.spec.checked ?? "" },
  { prop: "material", label: "Material", value: (s) => s.spec.material ?? "" },
  { prop: "finish", label: "Finish", value: (s) => s.spec.finish ?? "" },
];

function TitleBody({ sheet }: { sheet: Sheet }) {
  return (
    <>
      <div className="big">{sheet.title}</div>
      <div className="label">These go in the drawing's block in the source.</div>
      {TITLE_FIELDS.map((f) => (
        <TextField key={f.prop} label={f.label} value={f.value(sheet)} onCommit={(v) => editDrawing(sheet, `Set the drawing ${f.label.toLowerCase()} to “${v}”`, (src, block) => setBlockProp(src, block, f.prop, JSON.stringify(v)))} />
      ))}
    </>
  );
}

function NotesBody({ sheet }: { sheet: Sheet }) {
  return (
    <>
      <div className="lines" style={{ marginTop: 4 }}>
        {sheet.notes.map((n, i) => `${i + 1}. ${n}`).join("\n")}
      </div>
      <TextField label="Add a note" value="" placeholder="e.g. Deburr all edges" onCommit={(v) => editDrawing(sheet, `Added the note “${v}” to the drawing`, (src, block) => addBlockLine(src, block, `note(${JSON.stringify(v)})`))} />
    </>
  );
}

function TextField({ label, value, placeholder, onCommit }: { label: string; value: string; placeholder?: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const v = text.trim();
    if (v === value.trim() || (!v && !value)) return;
    if (!v) return setText(value);
    onCommit(v);
    if (!value) setText("");
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input className="input" value={text} placeholder={placeholder} maxLength={120} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
    </label>
  );
}

function Ask({ sheet, itemKey, info }: { sheet: Sheet; itemKey: string; info: Described }) {
  const busy = useChat((s) => s.busy);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const send = (t: string) => {
    const msg = t.trim();
    if (!msg || busy) return;
    markAsked(sheet.name, itemKey, msg);
    void sendMessage(`On the drawing “${sheet.title}”, about ${info.about}: ${msg}`);
    setText("");
    setSent(true);
  };
  return (
    <div className="section">
      <div className="dwg-ask">
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={busy ? "Claude is working…" : "Tell Claude what to change here"}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
          aria-label="Message to Claude about this item"
        />
        <button className="btn primary sm" disabled={busy || !text.trim()} onClick={() => send(text)} aria-label="Send to Claude">
          <Icon.Send size={13} />
        </button>
      </div>
      <div className="dwg-chips">
        {info.chips.map((c) => (
          <button key={c} disabled={busy} onClick={() => send(c)}>
            {c}
          </button>
        ))}
      </div>
      {sent && <div className="dwg-sent">Sent to Claude. The reply is in the chat, and the sheet updates when the design does.</div>}
    </div>
  );
}
