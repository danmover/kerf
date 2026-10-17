// The build tab: whether the machine is ready to build, its electronics,
// wiring, calculations, firmware and test plan, and the build pack download.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { useDesign } from "../core/engine";
import { useView, revealSpan, select } from "../app/view";
import { useProject } from "../app/project";
import { exportBuildPack } from "../app/exports";
import { toast } from "../app/ui";
import { checkItems, cutList, madeParts, readiness, testPlan, type PlanItem, type Readiness } from "../machine/pack";
import { componentPositions, wireList, wiresCsv, wiringDiagram, wireHex, type WireEnd, type WireKind, type WireRow } from "../machine/wiring";
import { generateFirmware, type FirmwareOutput } from "../machine/firmware";
import { catalogPart, shopLinks } from "../machine/catalog";
import { bomRows, bomTotal, download, safeFileName } from "../persist/files";
import type { CheckItem } from "../core/checks";
import type { Model } from "../core/model";
import type { CalcLine, CalcTrace, CatalogKind, MachineComponent, MachineData } from "../machine/types";
import { fmtNum } from "../lang/values";
import { Segmented } from "./common";
import { Icon, StatusIcon } from "./icons";
import { BoardView } from "./BoardView";
import { SoundPanel } from "./SoundPanel";
import { hasCircuit } from "../machine/circuit/netlist";

type Section = "overview" | "sound" | "board" | "wiring" | "calcs" | "firmware" | "tests";

/** Remembered while the dock switches tabs. */
const useBuildView = create<{ section: Section; wiring: "diagram" | "list"; file: string; openCalcs: string[] }>(() => ({ section: "overview", wiring: "diagram", file: "", openCalcs: [] }));
const go = (section: Section) => useBuildView.setState({ section });

const money = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const lineText = (l: CalcLine) => `${fmtNum(l.value)}${l.unit ? ` ${l.unit}` : ""}`;

/** Part ids (instances) of a component, for selecting it in the 3D view. */
function partIds(model: Model, comp: string, index?: number): string[] {
  return model.parts
    .filter((p) => p.name === comp && (index === undefined || Number(p.id.match(/#(\d+)/)?.[1] ?? 1) - 1 === index))
    .map((p) => p.id);
}

const endIds = (model: Model, e: WireEnd) => partIds(model, e.comp.replace(/\[\d+\]$/, ""), e.comp.endsWith("]") ? e.index : undefined);

export function MachinePanel() {
  const model = useDesign((s) => s.model);
  const report = useDesign((s) => s.report);
  const checking = useDesign((s) => s.kernelStatus !== "error" && (!s.report || s.reportRev < s.rev));
  const project = useProject((s) => s.current?.name);
  const section = useBuildView((s) => s.section);
  const [busy, setBusy] = useState(false);
  const m = model?.machine;
  const name = project ?? model?.name ?? "Design";

  const items = useMemo(() => (model ? checkItems(model, report) : []), [model, report]);
  const plan = useMemo(() => (m ? testPlan(m) : []), [m]);
  const ready = useMemo(() => (model ? readiness(model, items, plan) : null), [model, items, plan]);
  const rows = useMemo(() => (model && m ? wireList(m, componentPositions(model)) : []), [model, m]);
  const fw = useMemo(() => (model && m ? generateFirmware(m, model.name || name) : []), [model, m, name]);

  if (!model || !m || !ready) {
    return (
      <div className="mp-pad">
        <div className="empty-state">
          The build tab is for machines: designs with catalog parts such as motors, drivers and a controller, the wires between them and a firmware block. Ask Claude to add them, or add <span className="mono">lib.controller("arduino_nano")</span> and wire it up.
        </div>
      </div>
    );
  }

  const fwFiles = fw.reduce((n, f) => n + f.files.length, 0);
  // an audio circuit gets a Sound section, a design with circuit boards a Board section
  const sound = m.components.some((c) => catalogPart(c.catalogId)?.sim?.k === "input") && hasCircuit(m);
  const boards = m.boards.length > 0;
  const shown: Section = (section === "sound" && !sound) || (section === "board" && !boards) ? "overview" : section;
  const verdict = ready.level === "ready" ? { cls: "pass", word: "ready to build" } : ready.level === "review" ? { cls: "warn", word: "review first" } : { cls: "fail", word: "not ready" };
  const makePack = async () => {
    setBusy(true);
    try {
      await exportBuildPack();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mp">
      <div className="mp-head">
        <Segmented
          id="build-section"
          value={shown}
          onChange={go}
          options={[
            { value: "overview", label: "Overview" },
            ...(sound ? [{ value: "sound" as const, label: "Sound", title: "The circuit simulated: turn the knobs, see the response and listen" }] : []),
            ...(boards ? [{ value: "board" as const, label: <>Board{m.boards.length > 1 && <span className="seg-n">{m.boards.length}</span>}</>, title: "Circuit board layout, rule check and board house files" }] : []),
            { value: "wiring", label: <>Wiring{rows.length > 0 && <span className="seg-n">{rows.length}</span>}</>, title: "Wiring diagram and wire list" },
            { value: "calcs", label: <>Calculations{m.calcs.length > 0 && <span className="seg-n">{m.calcs.length}</span>}</>, title: "Engineering calculations with their working" },
            { value: "firmware", label: <>Firmware{fwFiles > 0 && <span className="seg-n">{fwFiles}</span>}</>, title: "Code generated to match the wiring" },
            { value: "tests", label: <>Test plan{plan.length > 0 && <span className="seg-n">{plan.length}</span>}</>, title: "What to test before relying on the machine" },
          ]}
        />
        {/* the verdict and the download stay together, so a narrow panel wraps them as one */}
        <div className="mp-actions">
          <span className={`chip mp-verdict ${verdict.cls}`} data-tip={checking ? "Geometry checks are still running, so this may change." : ready.headline}>
            {checking && <span className="spinner" style={{ width: 9, height: 9, borderWidth: 1.5 }} />}
            {verdict.word}
          </span>
          <button className="btn primary sm" onClick={() => void makePack()} disabled={busy} data-tip="Download the parts list, print files, STEP, wiring, circuit boards, firmware, calculations, checks and test plan in one zip">
            {busy ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} /> : <Icon.Download size={13} />}
            {busy ? "Preparing…" : "Build pack"}
          </button>
        </div>
      </div>
      <div className="mp-body">
        {shown === "overview" && <Overview model={model} m={m} ready={ready} rows={rows} plan={plan} fw={fw} checking={checking} />}
        {shown === "sound" && <SoundPanel m={m} />}
        {shown === "board" && <BoardView model={model} m={m} items={items} />}
        {shown === "wiring" && <Wiring model={model} m={m} rows={rows} items={items} name={name} />}
        {shown === "calcs" && <Calcs m={m} items={items} />}
        {shown === "firmware" && <Firmware fw={fw} />}
        {shown === "tests" && <Tests plan={plan} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- overview

function Stat({ k, v, s, onClick, tip }: { k: string; v: ReactNode; s?: string; onClick?: () => void; tip?: string }) {
  return (
    <button className="mp-stat" onClick={onClick} data-tip={tip}>
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      {s && <span className="s">{s}</span>}
    </button>
  );
}

/** The worst result as the value; the rest goes in the line under it. */
function Counts({ fail, warn }: { fail: number; warn: number }) {
  if (fail) return <span className="fail">{fail} fail</span>;
  if (warn) return <span className="warn">{plural(warn, "warning")}</span>;
  return <span style={{ color: "var(--pass)" }}>all pass</span>;
}
const countsSub = (fail: number, warn: number, rest: string) => (fail && warn ? `and ${plural(warn, "warning")}` : rest);

const COLUMN: Partial<Record<CatalogKind, number>> = { battery: 0, psu: 0, fuse: 1, switch: 1, connector: 1, regulator: 2, controller: 3, host: 3, motor_driver: 4, stepper_driver: 4, sensor: 5 };

function focusItem(model: Model, i: CheckItem) {
  const ids = (i.parts ?? []).flatMap((n) => {
    const own = partIds(model, n);
    return own.length ? own : [n];
  });
  const same = useView.getState().focusCheck === i.id;
  useView.setState({ focusCheck: same ? null : i.id, focusParts: same ? [] : ids });
  if (!same && i.span) revealSpan(i.span);
}

function Overview({ model, m, ready, rows, plan, fw, checking }: { model: Model; m: MachineData; ready: Readiness; rows: WireRow[]; plan: PlanItem[]; fw: FirmwareOutput[]; checking: boolean }) {
  const focusCheck = useView((s) => s.focusCheck);
  const bom = useMemo(() => bomRows(model), [model]);
  const cost = useMemo(() => bomTotal(bom), [bom]);
  const made = useMemo(() => madeParts(model), [model]);
  const cuts = useMemo(() => cutList(model), [model]);
  const electronics = useMemo(
    () =>
      m.components
        .map((c) => ({ c, p: catalogPart(c.catalogId) }))
        .filter((x) => x.p && x.p.pins.length > 0)
        .sort((a, b) => (COLUMN[a.c.kind] ?? 6) - (COLUMN[b.c.kind] ?? 6)),
    [m],
  );
  const roles = electronics.some((x) => x.c.role);
  const issues = [...ready.fails, ...ready.warns];
  const rough = m.calcs.filter((c) => c.confidence === "rough").length;
  const buyLines = bom.filter((r) => r.kind === "Buy");
  const madeQty = made.reduce((n, p) => n + p.qty, 0);
  const packFiles: [string, string][] = [
    ["README.md", "Start here: the verdict, what to order and the order of work"],
    ["bom.html  bom.csv", "Parts list with prices and where to buy each part"],
    ...(cuts.length ? ([["cut_list.csv", "Lengths to cut from stock bars and rails"]] as [string, string][]) : []),
    ...(made.length ? ([[`print/  (${made.length} STL)`, `${plural(madeQty, "part")} to print or make, laid flat on their best face`]] as [string, string][]) : []),
    ["cad/assembly.step", "Exact 3D model of the assembly for other CAD tools"],
    ...(rows.length ? ([["wiring/", "Printable wiring diagram (SVG) and wire list (CSV)"]] as [string, string][]) : []),
    ...(fw.some((f) => f.files.length) ? ([["firmware/", fw.map((f) => f.summary).join("; ")]] as [string, string][]) : []),
    ["assembly.md", "Step-by-step build: print, cut, assemble, wire, flash, power up"],
    ["calculations.md  checks.md", "The working behind every number, and every check result"],
    ["test_plan.md", "What to test before you rely on the machine"],
  ];

  return (
    <div className="mp-pad mp-grid">
      <div style={{ minWidth: 0 }}>
        <div className={`mp-hero ${ready.level}`}>
          <StatusIcon status={ready.level === "ready" ? "pass" : ready.level === "review" ? "warn" : "fail"} />
          <div className="headline">{ready.headline}</div>
          {ready.detail && <div className="detail">{ready.detail}</div>}
          {checking && <div className="detail" style={{ color: "var(--text-3)" }}>Geometry checks (fit, interference, tool access) are still running, so this may change.</div>}
        </div>
        <div className="mp-stats">
          <Stat k="Wiring" v={<Counts fail={ready.electrical.fail} warn={ready.electrical.warn} />} s={countsSub(ready.electrical.fail, ready.electrical.warn, rows.length ? plural(rows.length, "wire") : "no wires yet")} onClick={() => go("wiring")} tip="Electrical rules: voltages, currents, wire sizes and pin types" />
          <Stat k="Calculations" v={<Counts fail={ready.engineering.fail} warn={ready.engineering.warn} />} s={countsSub(ready.engineering.fail, ready.engineering.warn, `${plural(m.calcs.length, "calc")}${rough ? `, ${rough} rough` : ""}`)} onClick={() => go("calcs")} tip="Motor loads and engineering calculations" />
          <Stat k="Tests" v={ready.tests} s={ready.tests ? "before use" : plan.length ? `${plan.length} worth doing` : "none needed"} onClick={() => go("tests")} tip="Physical tests: what only the real machine can confirm" />
          <Stat k="To buy" v={cost.total > 0 ? `${money(cost.total)}${cost.unpriced ? "+" : ""}` : "—"} s={plural(buyLines.length, "line")} onClick={() => useView.setState({ dockTab: "bom" })} tip={`Open the parts list with prices and where to buy${cost.unpriced ? `. ${cost.unpriced === 1 ? "1 item has" : `${cost.unpriced} items have`} no price yet.` : ""}`} />
        </div>

        <div className="mp-h">
          Issues to look at <span className="dim">{issues.length}</span>
        </div>
        <div className="mp-list">
          {issues.length ? (
            issues.map((i) => (
              <div key={i.id} className={`check-item ${focusCheck === i.id ? "focused" : ""}`} onClick={() => focusItem(model, i)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && focusItem(model, i)}>
                <StatusIcon status={i.status} />
                <div style={{ minWidth: 0 }}>
                  <div className="title">{i.title}</div>
                  <div className="detail">{i.detail}</div>
                </div>
                <div className="basis">{i.category === "electrical" ? "wiring" : i.category === "engineering" ? "calc" : i.category}</div>
              </div>
            ))
          ) : (
            <div className="mp-none">No failing checks or warnings.</div>
          )}
        </div>
      </div>

      <div style={{ minWidth: 0 }}>
        <div className="mp-h">
          Electronics <span className="dim">{electronics.length}</span>
          <div className="grow" />
          <span className="dim" style={{ fontSize: 10.5 }}>
            click to show in the model
          </span>
        </div>
        <div className="mp-list">
          {electronics.length ? (
            <table className="bom mp-elec">
              <colgroup>
                <col style={{ width: 96 }} />
                {roles && <col style={{ width: "17%" }} />}
                <col />
                <col style={{ width: 92 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Name</th>
                  {roles && <th>Role</th>}
                  <th>Part</th>
                  <th>Buy</th>
                </tr>
              </thead>
              <tbody>
                {electronics.map(({ c, p }) => (
                  <ElectronicsRow key={c.name} model={model} c={c} part={p!} roles={roles} />
                ))}
              </tbody>
            </table>
          ) : (
            <div className="mp-none">No electronic parts yet.</div>
          )}
        </div>

        <div className="mp-h" style={{ marginTop: 14 }}>
          In the build pack
        </div>
        <div className="mp-list">
          <ul className="mp-files-list">
            {packFiles.map(([f, d]) => (
              <li key={f}>
                <span className="mono">{f}</span>
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function ElectronicsRow({ model, c, part, roles }: { model: Model; c: MachineComponent; part: NonNullable<ReturnType<typeof catalogPart>>; roles: boolean }) {
  const link = c.buyUrl ? { vendor: "Design link", url: c.buyUrl, direct: true } : shopLinks(part)[0];
  const show = () => {
    select(partIds(model, c.name));
    revealSpan(c.span);
  };
  return (
    <tr onClick={show}>
      <td className="mono" style={{ fontSize: 12, color: "var(--text)", overflowWrap: "anywhere" }}>
        {c.name}
        {c.count > 1 && <span className="dim"> ×{c.count}</span>}
      </td>
      {roles && <td>{c.role ?? <span className="dim">—</span>}</td>}
      <td>
        <div style={{ color: "var(--text)" }}>{part.name}</div>
        <div className="mp-sub mp-ellipsis" data-tip={part.summary}>
          {[part.maker, part.mpn].filter(Boolean).join(" ") || part.summary}
        </div>
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        {link && (
          <a className={link.direct ? "buy-link" : "chip buy-search"} href={link.url} target="_blank" rel="noopener noreferrer" data-tip={link.direct ? link.url : `Search ${link.vendor}`}>
            {link.vendor}
          </a>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------- wiring

const KIND_LABEL: Record<WireKind, string> = { ground: "Ground", signal: "Signal", motor: "Motor", cable: "Cables", power: "Power" };
const KIND_HINT: Record<WireKind, string> = {
  ground: "connect first",
  signal: "controller to drivers and sensors",
  motor: "drivers to motors",
  cable: "plug-in cables",
  power: "connect last, with the power off",
};

function Wiring({ model, m, rows, items, name }: { model: Model; m: MachineData; rows: WireRow[]; items: CheckItem[]; name: string }) {
  const mode = useBuildView((s) => s.wiring);
  const [big, setBig] = useState(false);
  const diagram = useMemo(() => (rows.length ? wiringDiagram(m, { title: name }) : null), [m, rows.length, name]);
  const elec = items.filter((i) => i.category === "electrical" && (i.status === "fail" || i.status === "warn"));
  if (!diagram) {
    return (
      <div className="mp-pad">
        <div className="empty-state">No wires yet. Connect pins with wire statements (wire ctrl.D9 -&gt; drv.PWM) or nets, and the diagram and wire list appear here.</div>
      </div>
    );
  }
  const file = (ext: string) => safeFileName(`${name} wiring`, ext);
  return (
    <div className="mp-wiring">
      <div className="mp-toolbar">
        <Segmented
          id="build-wiring"
          value={mode}
          onChange={(v) => useBuildView.setState({ wiring: v })}
          options={[
            { value: "diagram", label: "Diagram" },
            { value: "list", label: "Wire list" },
          ]}
        />
        <span className="mono dim" style={{ fontSize: 11 }}>
          {plural(rows.length, "wire")} · {plural(diagram.parts, "part")}
        </span>
        {elec.length > 0 && (
          <button className={`chip ${elec.some((i) => i.status === "fail") ? "fail" : "warn"}`} style={{ cursor: "pointer" }} onClick={() => go("overview")} data-tip={elec.map((i) => i.title).join(" · ")}>
            {plural(elec.length, "wiring issue")}
          </button>
        )}
        <div className="grow" />
        {mode === "diagram" && (
          <>
            <ZoomControls store={dockZoom} />
            <button className="btn sm" onClick={() => setBig(true)} data-tip="Show the diagram over the whole window">
              <Icon.Fit size={13} /> Full screen
            </button>
          </>
        )}
        <button className="btn sm" onClick={() => download(diagram.svg, file("svg"), "image/svg+xml")} data-tip="Printable diagram">
          <Icon.Download size={13} /> SVG
        </button>
        <button className="btn sm" onClick={() => download(wiresCsv(rows), file("csv"), "text/csv")} data-tip="Wire list for a spreadsheet">
          <Icon.Download size={13} /> CSV
        </button>
      </div>
      {mode === "diagram" ? <Diagram store={dockZoom} svg={diagram.svg} width={diagram.width} height={diagram.height} /> : <WireTable model={model} rows={rows} />}
      {big && <BigDiagram svg={diagram.svg} width={diagram.width} height={diagram.height} title={`Wiring: ${name}`} sub={`${plural(rows.length, "wire")} · ${plural(diagram.parts, "part")}`} onClose={() => setBig(false)} onSvg={() => download(diagram.svg, file("svg"), "image/svg+xml")} />}
    </div>
  );
}

function BigDiagram({ svg, width, height, title, sub, onClose, onSvg }: { svg: string; width: number; height: number; title: string; sub: string; onClose: () => void; onSvg: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="mp-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="mp-toolbar">
        <span style={{ fontWeight: 500 }}>{title}</span>
        <span className="mono dim" style={{ fontSize: 11 }}>
          {sub}
        </span>
        <span className="dim" style={{ fontSize: 11.5 }}>
          Drag to pan, ctrl + wheel or double-click to zoom
        </span>
        <div className="grow" />
        <ZoomControls store={bigZoom} />
        <button className="btn sm" onClick={onSvg}>
          <Icon.Download size={13} /> SVG
        </button>
        <button className="icon-btn" onClick={onClose} aria-label="Close" data-tip="Close (Esc)">
          <Icon.X size={16} />
        </button>
      </div>
      <Diagram store={bigZoom} svg={svg} width={width} height={height} />
    </div>,
    document.body,
  );
}

/** Zoom state shared by a canvas and its toolbar; the dock and the full-screen view each have one. */
interface ZoomState {
  zoom: number;
  fit: boolean;
  request: { z: number | "fit"; n: number } | null;
}
const makeZoom = () => create<ZoomState>(() => ({ zoom: 1, fit: true, request: null }));
type ZoomStore = ReturnType<typeof makeZoom>;
const dockZoom = makeZoom();
const bigZoom = makeZoom();
let zoomNonce = 0;
const requestZoom = (store: ZoomStore, z: number | "fit") => store.setState({ request: { z, n: ++zoomNonce } });

function ZoomControls({ store }: { store: ZoomStore }) {
  const zoom = store((s) => s.zoom);
  const fit = store((s) => s.fit);
  return (
    <span className="mp-zoom">
      <button className="icon-btn sm" onClick={() => requestZoom(store, zoom / 1.25)} aria-label="Zoom out" data-tip="Zoom out (ctrl + wheel)">
        <span style={{ fontSize: 15, lineHeight: 1 }}>−</span>
      </button>
      <button className="icon-btn sm val" style={{ width: "auto" }} onClick={() => requestZoom(store, Math.abs(zoom - 1) < 0.01 ? "fit" : 1)} data-tip={Math.abs(zoom - 1) < 0.01 ? "Fit the whole diagram" : "Actual size"}>
        {Math.round(zoom * 100)}%
      </button>
      <button className="icon-btn sm" onClick={() => requestZoom(store, zoom * 1.25)} aria-label="Zoom in" data-tip="Zoom in (ctrl + wheel)">
        <Icon.Plus size={13} />
      </button>
      <button className={`icon-btn sm fit ${fit ? "active" : ""}`} onClick={() => requestZoom(store, "fit")} aria-label="Fit" data-tip="Fit the whole diagram">
        fit
      </button>
    </span>
  );
}

const PAD = 14;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function Diagram({ store: useZoom, svg, width, height }: { store: ZoomStore; svg: string; width: number; height: number }) {
  const box = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const zoom = useZoom((s) => s.zoom);
  const fit = useZoom((s) => s.fit);
  const request = useZoom((s) => s.request);
  const anchor = useRef<{ cx: number; cy: number; px: number; py: number } | null>(null);
  const drag = useRef<{ x: number; y: number; sl: number; st: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  const fitZoom = useCallback(() => {
    const el = box.current;
    if (!el) return 1;
    return clamp(Math.min((el.clientWidth - 2 * PAD) / width, (el.clientHeight - 2 * PAD) / height), 0.05, 1);
  }, [width, height]);

  /** zoom to z keeping the point (px, py) of the visible area still */
  const zoomTo = useCallback(
    (z: number, at?: { x: number; y: number }) => {
      const el = box.current;
      const sh = sheet.current;
      if (!el || !sh) return;
      const cur = useZoom.getState().zoom;
      const next = clamp(z, 0.05, 4);
      const px = at?.x ?? el.clientWidth / 2;
      const py = at?.y ?? el.clientHeight / 2;
      const r = sh.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      anchor.current = { cx: (b.left + px - r.left) / cur, cy: (b.top + py - r.top) / cur, px, py };
      useZoom.setState({ zoom: next, fit: false });
    },
    [useZoom],
  );

  // start fitted whenever the diagram changes size
  useLayoutEffect(() => {
    useZoom.setState({ fit: true, zoom: fitZoom(), request: null });
  }, [fitZoom, useZoom]);

  // follow the panel size while fitted
  useEffect(() => {
    const el = box.current;
    if (!el || !fit) return;
    const ro = new ResizeObserver(() => useZoom.setState({ zoom: fitZoom() }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, fitZoom, useZoom]);

  // toolbar requests
  useEffect(() => {
    if (!request) return;
    if (request.z === "fit") useZoom.setState({ fit: true, zoom: fitZoom() });
    else zoomTo(request.z);
  }, [request, fitZoom, zoomTo, useZoom]);

  // keep the anchor point still after a zoom
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = box.current;
    const sh = sheet.current;
    anchor.current = null;
    if (!a || !el || !sh) return;
    const r = sh.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    el.scrollLeft += r.left - b.left + a.cx * zoom - a.px;
    el.scrollTop += r.top - b.top + a.cy * zoom - a.py;
  }, [zoom]);

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
  }, [zoomTo, useZoom]);

  const html = useMemo(() => ({ __html: svg }), [svg]);
  return (
    <div
      ref={box}
      className={`mp-canvas ${dragging ? "dragging" : ""}`}
      onPointerDown={(e) => {
        if (e.button !== 0 || !box.current) return;
        drag.current = { x: e.clientX, y: e.clientY, sl: box.current.scrollLeft, st: box.current.scrollTop, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        const el = box.current;
        if (!d || !el) return;
        if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) return;
        if (!d.moved) {
          d.moved = true;
          el.setPointerCapture(e.pointerId);
          setDragging(true);
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
      onDoubleClick={(e) => {
        const b = box.current!.getBoundingClientRect();
        const z = useZoom.getState().zoom;
        if (z >= 0.99) requestZoom(useZoom, "fit");
        else zoomTo(Math.min(1, z * 2.5), { x: e.clientX - b.left, y: e.clientY - b.top });
      }}
    >
      <div className="mp-canvas-inner">
        <div ref={sheet} className="mp-sheet" style={{ width: width * zoom, height: height * zoom }} dangerouslySetInnerHTML={html} />
      </div>
    </div>
  );
}

function WireEndCell({ e }: { e: WireEnd }) {
  return (
    <>
      <span className="pin">
        {e.comp}.{e.pin}
      </span>
      {e.label && e.label !== e.pin && <span className="lbl"> {e.label}</span>}
    </>
  );
}

function WireTable({ model, rows }: { model: Model; rows: WireRow[] }) {
  const out: ReactNode[] = [];
  let kind: WireKind | null = null;
  const counts = new Map<WireKind, number>();
  for (const r of rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  for (const r of rows) {
    if (r.kind !== kind) {
      kind = r.kind;
      out.push(
        <tr key={`g-${kind}`} className="group">
          <td colSpan={8}>
            {KIND_LABEL[kind]} · {plural(counts.get(kind) ?? 0, "wire")} · {KIND_HINT[kind]}
          </td>
        </tr>,
      );
    }
    const notes = [r.label ? `Label: ${r.label}` : "", r.note ?? ""].filter(Boolean).join(" ");
    out.push(
      <tr key={r.id} onClick={() => select([...new Set([...endIds(model, r.from), ...endIds(model, r.to)])])} style={{ cursor: "pointer" }}>
        <td className="mono" style={{ color: "var(--text)" }}>
          {r.id}
        </td>
        <td>
          <WireEndCell e={r.from} />
        </td>
        <td>
          <WireEndCell e={r.to} />
        </td>
        <td className="mono" style={{ fontSize: 11.5 }}>
          {r.named ? r.net : <span className="dim">{r.net}</span>}
        </td>
        <td className={`mono ${r.gaugeSuggested ? "sugg" : ""}`} data-tip={r.gaugeSuggested && r.gauge ? "Suggested by Kerf: the design does not set a gauge" : undefined}>
          {r.cable ? <span className="dim">cable</span> : (r.gauge ?? "")}
        </td>
        <td className={r.colorSuggested ? "sugg" : ""} data-tip={r.colorSuggested && !r.cable ? "Suggested by Kerf: the design does not set a colour" : undefined}>
          {!r.cable && (
            <>
              <span className="mp-swatch" style={{ background: wireHex(r.color) }} />
              {r.color}
            </>
          )}
        </td>
        <td className="mono" style={{ textAlign: "right" }}>
          {r.lengthMm !== undefined ? `${r.lengthMm} mm` : ""}
        </td>
        <td className="note">{notes}</td>
      </tr>,
    );
  }
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
      <table className="bom mp-wires">
        <thead>
          <tr>
            <th>Wire</th>
            <th>From</th>
            <th>To</th>
            <th>Net</th>
            <th data-tip="American wire gauge: smaller is thicker">AWG</th>
            <th>Colour</th>
            <th style={{ textAlign: "right" }} data-tip="Distance between the parts plus slack, rounded up to 50 mm">
              Length
            </th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>{out}</tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- calculations

const CONFIDENCE: Record<CalcTrace["confidence"], { cls: string; word: string; tip: string }> = {
  standard: { cls: "pass", word: "standard method", tip: "A textbook method. Trust it as far as its stated assumptions hold." },
  estimate: { cls: "accent", word: "estimate", tip: "A reasonable estimate from typical values. Check the assumptions against your parts." },
  rough: { cls: "warn", word: "rough: test it", tip: "A rough figure. The test plan says how to measure the real value." },
};

function KV({ lines }: { lines: CalcLine[] }) {
  return (
    <table className="mp-kv">
      <tbody>
        {lines.map((l, i) => (
          <tr key={i}>
            <td>
              {l.label}
              {l.note && <span className="note">{l.note}</span>}
            </td>
            <td className="v">{lineText(l)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Calcs({ m, items }: { m: MachineData; items: CheckItem[] }) {
  const openCalcs = useBuildView((s) => s.openCalcs);
  const checks = items.filter((i) => i.category === "engineering" && i.status !== "info");
  const toggle = (name: string) => useBuildView.setState({ openCalcs: openCalcs.includes(name) ? openCalcs.filter((n) => n !== name) : [...openCalcs, name] });
  return (
    <div className="mp-pad">
      {checks.length > 0 && (
        <>
          <div className="mp-h">
            Motor loads and limits <span className="dim">{checks.length}</span>
          </div>
          <div className="mp-list" style={{ marginBottom: 14 }}>
            {checks.map((i) => (
              <div key={i.id} className="check-item" onClick={() => i.span && revealSpan(i.span)} role="button" tabIndex={0}>
                <StatusIcon status={i.status} />
                <div style={{ minWidth: 0 }}>
                  <div className="title">{i.title}</div>
                  <div className="detail">{i.detail}</div>
                </div>
                <div className="basis">calc</div>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="mp-h">
        Calculations <span className="dim">{m.calcs.length}</span>
        <div className="grow" />
        {m.calcs.length > 1 && (
          <button className="btn ghost sm" style={{ height: 20 }} onClick={() => useBuildView.setState({ openCalcs: openCalcs.length ? [] : m.calcs.map((c) => c.name) })}>
            {openCalcs.length ? "Collapse all" : "Expand all"}
          </button>
        )}
      </div>
      {m.calcs.length === 0 && <div className="empty-state">No calculations yet. Use calc.* functions (for example calc.wheel_drive) so the working is shown here and checked against the parts.</div>}
      {m.calcs.map((c) => {
        const open = openCalcs.includes(c.name);
        const conf = CONFIDENCE[c.confidence];
        return (
          <div key={c.name} className={`mp-calc ${open ? "open" : ""}`}>
            <button className="mp-calc-head" onClick={() => toggle(c.name)} aria-expanded={open}>
              <Icon.Chevron size={12} className="chev" />
              <div style={{ minWidth: 0 }}>
                <div className="title">
                  {c.title} <span className="mono dim" style={{ fontSize: 11 }}>{c.name}</span>
                </div>
                <div className="outs">
                  {c.outputs.slice(0, 3).map((o, i) => (
                    <span key={i}>
                      {i > 0 && " · "}
                      {o.label} <b>{lineText(o)}</b>
                    </span>
                  ))}
                </div>
              </div>
              <span className={`chip ${conf.cls}`} data-tip={conf.tip}>
                {conf.word}
              </span>
            </button>
            {open && (
              <div className="mp-calc-body">
                <div>
                  <h4>Inputs</h4>
                  <KV lines={c.inputs} />
                </div>
                <div>
                  <h4>Method</h4>
                  <ul className="mp-method">
                    {c.method.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                  {c.assumptions.length > 0 && (
                    <>
                      <h4>Assumptions</h4>
                      <ul className="mp-assume">
                        {c.assumptions.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
                <div>
                  <h4>Results</h4>
                  <KV lines={c.outputs} />
                </div>
                {c.verify && (
                  <div className={`mp-verify ${c.confidence === "rough" ? "" : "calm"}`}>
                    <Icon.Target size={14} style={{ flex: "none", marginTop: 2 }} />
                    <span>
                      <b>{c.confidence === "rough" ? "Measure it:" : "Worth checking:"}</b> {c.verify}
                    </span>
                  </div>
                )}
                <div style={{ gridColumn: "1 / -1" }}>
                  <button className="btn ghost sm" style={{ marginLeft: -9 }} onClick={() => revealSpan(c.span)}>
                    <Icon.Code size={13} /> Show in code
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- firmware

const TARGET_WORD: Record<FirmwareOutput["target"], string> = { arduino: "Arduino", klipper: "Klipper", marlin: "Marlin", reprapfirmware: "RepRapFirmware", none: "not generated" };

/** Light highlighting: comments, preprocessor lines, strings and section headers. */
function highlight(line: string, ext: string): ReactNode {
  if (ext === "md") return /^#{1,6}\s/.test(line) ? <span className="h">{line}</span> : line;
  if (ext === "cfg" || ext === "ini" || ext === "conf") {
    if (/^\s*[#;]/.test(line)) return <span className="c">{line}</span>;
    if (/^\s*\[.*\]\s*$/.test(line)) return <span className="h">{line}</span>;
    const k = line.search(/\s[#;]/);
    return k >= 0 ? (
      <>
        {line.slice(0, k)}
        <span className="c">{line.slice(k)}</span>
      </>
    ) : (
      line
    );
  }
  // C and C++: find a // comment outside strings
  const out: ReactNode[] = [];
  let i = 0;
  let start = 0;
  const pre = /^\s*#/.test(line);
  const flush = (end: number, cls?: string) => {
    if (end > start) out.push(cls || pre ? <span key={out.length} className={cls ?? "d"}>{line.slice(start, end)}</span> : line.slice(start, end));
    start = end;
  };
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"' || ch === "'") {
      flush(i);
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      i = Math.min(line.length, j + 1);
      flush(i, "s");
      continue;
    }
    if (ch === "/" && (line[i + 1] === "/" || line[i + 1] === "*")) {
      flush(i);
      i = line.length;
      flush(i, "c");
      break;
    }
    if (ch === "*" && /^\s*\*/.test(line.slice(0, i + 1)) && i === line.search(/\S/)) {
      flush(i);
      i = line.length;
      flush(i, "c");
      break;
    }
    i++;
  }
  flush(line.length);
  return out;
}

function Firmware({ fw }: { fw: FirmwareOutput[] }) {
  const sel = useBuildView((s) => s.file);
  if (!fw.length) {
    return (
      <div className="mp-pad">
        <div className="empty-state">
          No firmware block yet. Add one, for example <span className="mono">firmware main {"{"} board: ctrl {"}"}</span>, and Kerf writes code that matches the wiring: pin numbers, motor directions and limits.
        </div>
      </div>
    );
  }
  // the selection is "<block>/<path>" or "<block>#pins"
  const keyOf = (f: FirmwareOutput, path: string) => `${f.name}/${path}`;
  const all = fw.flatMap((f) => f.files.map((file) => ({ f, file, key: keyOf(f, file.path) })));
  const pinsFor = fw.find((f) => sel === `${f.name}#pins`);
  const current = pinsFor ? undefined : (all.find((x) => x.key === sel) ?? all[0]);
  const block = pinsFor ?? current?.f ?? fw[0];
  const content = current?.file.content ?? "";
  const base = current?.file.path.split("/").pop() ?? "";
  const ext = base.split(".").pop()?.toLowerCase() ?? "";
  const lines = content.replace(/\n$/, "").split("\n");
  const copy = () =>
    navigator.clipboard
      .writeText(content)
      .then(() => toast({ kind: "success", title: `Copied ${base}`, detail: "Paste it into the Arduino IDE or your editor." }))
      .catch(() => toast({ kind: "warn", title: "Could not copy", detail: "The browser blocked the clipboard. Use Download instead." }));
  return (
    <div className="mp-fw">
      <div className="mp-fw-side">
        {fw.map((f) => (
          <div key={f.name} className="mp-fw-block">
            <div className="mp-fw-name">
              <Icon.Chip size={14} style={{ color: "var(--text-3)" }} />
              <span className="mono">{f.name}</span>
              <span className={`chip ${f.target === "none" ? "warn" : ""}`} style={{ height: 17, fontSize: 9.5 }}>
                {TARGET_WORD[f.target]}
              </span>
            </div>
            <div className="mp-sub" style={{ margin: "3px 0 6px" }}>
              {f.summary}
            </div>
            {f.files.map((file) => {
              const key = keyOf(f, file.path);
              const active = current?.key === key;
              return (
                <button key={key} className={`mp-file ${active ? "active" : ""}`} onClick={() => useBuildView.setState({ file: key })} data-tip={file.path}>
                  <Icon.Doc size={13} />
                  {file.path.split("/").pop()}
                  <span className="n">{file.content.replace(/\n$/, "").split("\n").length}</span>
                </button>
              );
            })}
            {f.pinTable.length > 0 && (
              <button className={`mp-file ${pinsFor === f ? "active" : ""}`} onClick={() => useBuildView.setState({ file: `${f.name}#pins` })}>
                <Icon.List size={13} />
                pin map
                <span className="n">{f.pinTable.length}</span>
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="mp-fw-main">
        {block.warnings.length > 0 && (
          <ul className="mp-fw-warn">
            {block.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
        {pinsFor ? (
          <div className="mp-pins">
            <table className="bom">
              <thead>
                <tr>
                  <th>Signal</th>
                  <th>Controller pin</th>
                  <th>Wired to</th>
                </tr>
              </thead>
              <tbody>
                {pinsFor.pinTable.map((p, i) => (
                  <tr key={i}>
                    <td>{p.signal}</td>
                    <td className="mono" style={{ color: "var(--text)" }}>
                      {p.pin}
                    </td>
                    <td className="mono">{p.wire}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : current ? (
          <>
            <div className="mp-toolbar">
              <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>
                {current.file.path}
              </span>
              <span className="mono dim" style={{ fontSize: 11 }}>
                {plural(lines.length, "line")}
              </span>
              <div className="grow" />
              <button className="btn sm" onClick={copy}>
                <Icon.Copy size={13} /> Copy
              </button>
              <button className="btn sm" onClick={() => download(content, base, "text/plain")}>
                <Icon.Download size={13} /> Download
              </button>
            </div>
            <pre className="mp-code">
              {lines.map((l, i) => (
                <div key={i}>
                  <span className="ln">{i + 1}</span>
                  {highlight(l, ext)}
                </div>
              ))}
            </pre>
          </>
        ) : (
          <div className="mp-pad">
            <div className="empty-state">{block.summary}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- test plan

const SOURCE_WORD: Record<PlanItem["source"], { word: string; tip: string }> = {
  design: { word: "your test", tip: "A test written in the design" },
  calculation: { word: "confirms a calculation", tip: "Measures what a calculation could only estimate" },
  part: { word: "part check", tip: "A check this part usually needs in a new design" },
};

function TestCard({ t }: { t: PlanItem }) {
  return (
    <li className="mp-test">
      <div className="title">
        {t.title}
        <span className="chip" data-tip={SOURCE_WORD[t.source].tip} style={{ height: 17, fontSize: 9.5 }}>
          {SOURCE_WORD[t.source].word}
        </span>
      </div>
      <div className="mp-steps">{t.steps}</div>
      {(t.pass || t.expected?.length) && (
        <div>
          {t.pass && (
            <div className="mp-pass">
              <b>Pass:</b> {t.pass}
            </div>
          )}
          {t.expected && t.expected.length > 0 && <div className="mp-expect">Expect about: {t.expected.join(" · ")}</div>}
        </div>
      )}
    </li>
  );
}

function Tests({ plan }: { plan: PlanItem[] }) {
  const req = plan.filter((t) => t.required);
  const rest = plan.filter((t) => !t.required);
  if (!plan.length) {
    return (
      <div className="mp-pad">
        <div className="empty-state">Nothing needs a physical test yet. Add test statements for what only the real machine can show, such as run time on one charge.</div>
      </div>
    );
  }
  return (
    <div className="mp-pad" style={{ maxWidth: 980 }}>
      {req.length > 0 && (
        <>
          <div className="mp-h">
            Before you rely on it <span className="dim">{req.length}</span>
          </div>
          <ol className="mp-tests">
            {req.map((t, i) => (
              <TestCard key={i} t={t} />
            ))}
          </ol>
        </>
      )}
      {rest.length > 0 && (
        <>
          <div className="mp-h">
            Worth doing <span className="dim">{rest.length}</span>
          </div>
          <ol className="mp-tests" style={{ counterReset: `test ${req.length}` }}>
            {rest.map((t, i) => (
              <TestCard key={i} t={t} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
