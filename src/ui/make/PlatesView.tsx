// The make tab's print plates: every printed part turned the way it prints, the supports it needs, and its copies
// packed onto as many plates as your printer takes (one material a plate on one nozzle, two on two), each plate
// drawn from above with its parts' footprints and support columns, its filament and time, and a 3MF to slice.

import { useEffect, useMemo, useState } from "react";
import { useDesign } from "../../core/engine";
import { useView } from "../../app/view";
import { updateSettings, useSettings } from "../../app/settings";
import { errorText } from "../../app/ui";
import { exportPlates } from "../../app/exports";
import { copyId, platePrinter, printJob, type PlatePrinter, type PrintJob } from "../../app/printPlates";
import { machinesFor } from "../../mfg/machines";
import { fmtGrams, fmtPrintTime, plateMatrix, type PartEstimate, type PrintPlan } from "../../mfg/printPlan";
import { Segmented } from "../common";
import { Swatch } from "../MaterialPicker";
import { Icon } from "../icons";

const fmtMm2 = (a: number) => (a >= 1000 ? `${(a / 100).toFixed(0)} cm²` : `${Math.round(a)} mm²`);

/** The plan, made again (debounced) as the design, its meshes or your printer change. */
function usePrintJob(nozzles: number | null) {
  const model = useDesign((s) => s.model);
  const meshVersion = useDesign((s) => s.meshVersion);
  const machines = useSettings((s) => s.machines);
  const machineFor = useSettings((s) => s.machineFor);
  const [state, setState] = useState<{ job: PrintJob | null; printer: PlatePrinter | null; busy: boolean; error: string }>({ job: null, printer: null, busy: true, error: "" });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, busy: true }));
    const t = setTimeout(() => {
      try {
        const printer = platePrinter({ machines, machineFor }, model);
        const job = printJob(model, printer, { nozzles: nozzles ?? undefined });
        if (live) setState({ job, printer, busy: false, error: "" });
      } catch (e) {
        if (live) setState({ job: null, printer: null, busy: false, error: errorText(e) });
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [model, meshVersion, machines, machineFor, nozzles]);
  return state;
}

export function PlatesView() {
  const [nozzles, setNozzles] = useState<number | null>(null);
  const { job, printer, busy, error } = usePrintJob(nozzles);
  const machines = useSettings((s) => s.machines);
  const machineFor = useSettings((s) => s.machineFor);
  const printers = useMemo(() => machinesFor("fdm", { machines, machineFor }), [machines, machineFor]);
  // a different printer starts from its own nozzle count
  useEffect(() => setNozzles(null), [machineFor.fdm]);
  // each part's outline and supports, drawn once for every plate it is on
  const paths = useMemo(() => job?.plan.estimates.map(partPaths) ?? [], [job]);

  if (error) return <div className="mk-note fail">{error}</div>;
  if (!job || !printer)
    return (
      <div className="mk-note mono dim">
        <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> Laying the parts out to print…
      </div>
    );
  const { plan } = job;
  const per = nozzles ?? printer.nozzles;
  const setPrinter = (id: string) => {
    const { fdm: _old, ...rest } = machineFor;
    updateSettings({ machineFor: id ? { ...rest, fdm: id } : rest });
  };
  const offs = plan.estimates.filter((e) => e.supportsOff);

  return (
    <div className="mk-plates">
      <div className="mk-basis">
        <span className="mk-title">Print plates</span>
        <span className="mk-chip">
          {plan.plates.length} plate{plan.plates.length === 1 ? "" : "s"}
        </span>
        <span className="mk-chip">
          {plan.copies.length} part{plan.copies.length === 1 ? "" : "s"}
        </span>
        {plan.copies.length > 0 && (
          <span className="mk-chip" data-tip="Filament for the parts and their supports, as your slicer settings print them">
            {fmtGrams(plan.grams)} g{plan.supportGrams > 0.05 ? ` (${fmtGrams(plan.supportGrams)} g supports)` : ""}
          </span>
        )}
        {plan.copies.length > 0 && <span className="mk-chip">{fmtPrintTime(plan.hours)}</span>}
        {busy && (
          <span className="mk-chip busy">
            <span className="spinner" style={{ width: 9, height: 9, borderWidth: 1.5 }} /> updating
          </span>
        )}
      </div>
      <div className="mk-plate-bar">
        <label className="mk-plate-printer" data-tip="Your printer, as in Settings → Making: the print checks use it too">
          <Icon.Grid size={12} />
          <select value={printer.machine?.id ?? ""} onChange={(e) => setPrinter(e.target.value)} aria-label="Printer">
            <option value="">{printer.machine ? "No printer chosen" : printer.name.replace(/^./, (c) => c.toUpperCase())}</option>
            {printers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <span className="dim mono">
            {printer.bed[0]} × {printer.bed[1]} mm
          </span>
        </label>
        <Segmented
          id="mk-plate-nozzles"
          value={String(per)}
          onChange={(v) => setNozzles(Number(v))}
          options={[...new Set([1, 2, printer.nozzles])].map((n) => ({
            value: String(n),
            label: `${n} material${n === 1 ? "" : "s"} a plate`,
            title: n === 1 ? "One plastic a plate: what a single nozzle prints (colours can still change)" : `Up to ${n} plastics on a plate, one a nozzle`,
          }))}
        />
        <div className="grow" />
        <button className="btn sm" disabled={!plan.copies.length} onClick={() => void exportPlates({ all: true, nozzles: per })} data-tip={plan.plates.length > 1 ? "A .zip with a .3mf for each plate" : "One .3mf for your slicer"}>
          <Icon.Download size={12} /> {plan.plates.length > 1 ? `Export ${plan.plates.length} plates` : "Export plate"}
        </button>
      </div>
      {plan.tooBig.length > 0 && (
        <div className="mk-hint warn">
          <Icon.Alert size={12} />
          <span>
            {[...new Set(plan.tooBig.map((i) => plan.parts[plan.copies[i].part].name))].join(", ")} {plan.tooBig.length === 1 ? "is" : "are"} bigger than the {printer.bed[0]} × {printer.bed[1]} mm bed even turned. Split it into pieces (split: in the part) or print on a bigger machine.
          </span>
        </div>
      )}
      {offs.length > 0 && (
        <div className="mk-hint warn">
          <Icon.Alert size={12} />
          <span>
            {plan.parts.filter((_, k) => plan.estimates[k].supportsOff).map((p) => p.name).join(", ")}: supports are turned off (supports: false), so the overhangs drawn red print in the air.
          </span>
        </div>
      )}
      {job.waiting.length > 0 && (
        <div className="mk-hint">
          <Icon.Info size={12} />
          <span>Still building: {job.waiting.join(", ")}.</span>
        </div>
      )}
      {job.other.length > 0 && (
        <div className="mk-hint">
          <Icon.Info size={12} />
          <span>{[...new Set(job.other.map((p) => p.label))].join(", ")} print on a resin or powder printer, so they are not on these plates.</span>
        </div>
      )}
      {job.allMade && (
        <div className="mk-hint">
          <Icon.Info size={12} />
          <span>No part names a printing process or a filament, so every made part is here in its own material. Give parts fdm() or a filament (PLA, PETG, ASA…) to plan them as prints.</span>
        </div>
      )}
      {!plan.copies.length && !job.waiting.length && <div className="mk-note dim">Nothing here prints on an FDM printer.</div>}
      <div className="mk-plate-grid">
        {plan.plates.map((pl, i) => (
          <PlateCard key={i} plan={plan} job={job} paths={paths} i={i} nozzles={per} />
        ))}
      </div>
      {plan.parts.length > 0 && <PartsTable plan={plan} />}
      <div className="mk-fine">
        <Icon.Info size={11} /> Estimates for comparing: each part as its slicer settings print it (Kerf's 4 walls, 5 top and bottom layers and 40 % gyroid infill unless the part sets its own) at about 8 mm³ a second, with supports at 15 % under overhangs past the printer's limit and no support under spans short enough to bridge. A slicer's own numbers can land 20 to 30 % either side.
      </div>
    </div>
  );
}

/** Each part's footprint (filled, and its outline) and supports as SVG paths in its print frame. */
function partPaths(e: PartEstimate): { foot: string; edge: string; sup: string } {
  const f = e.footprint;
  const c = f.cell;
  const on = (i: number, j: number) => i >= 0 && j >= 0 && i < f.nx && j < f.ny && f.on[j * f.nx + i] === 1;
  const X = (i: number) => (f.x0 + i * c).toFixed(2);
  const Y = (j: number) => (f.y0 + j * c).toFixed(2);
  const foot: string[] = [];
  const edge: string[] = [];
  for (let j = 0; j < f.ny; j++) {
    let i = 0;
    while (i < f.nx) {
      if (!on(i, j)) {
        i++;
        continue;
      }
      let k = i;
      while (k < f.nx && on(k, j)) k++;
      foot.push(`M${X(i)} ${Y(j)}H${X(k)}V${Y(j + 1)}H${X(i)}z`);
      i = k;
    }
    // the outline: every cell side with nothing beyond it
    for (let i2 = 0; i2 < f.nx; i2++) {
      if (!on(i2, j)) continue;
      if (!on(i2, j - 1)) edge.push(`M${X(i2)} ${Y(j)}H${X(i2 + 1)}`);
      if (!on(i2, j + 1)) edge.push(`M${X(i2)} ${Y(j + 1)}H${X(i2 + 1)}`);
      if (!on(i2 - 1, j)) edge.push(`M${X(i2)} ${Y(j)}V${Y(j + 1)}`);
      if (!on(i2 + 1, j)) edge.push(`M${X(i2 + 1)} ${Y(j)}V${Y(j + 1)}`);
    }
  }
  const s = e.supports.cell;
  // a support column is drawn a little smaller than its cell, so the columns read as a field of posts
  const d = s * 0.72;
  const sup = e.supports.cells.map((q) => `M${(q.x - d / 2).toFixed(2)} ${(q.y - d / 2).toFixed(2)}h${d.toFixed(2)}v${d.toFixed(2)}h${(-d).toFixed(2)}z`).join("");
  return { foot: foot.join(""), edge: edge.join(""), sup };
}

function PlateCard({ plan, job, paths, i, nozzles }: { plan: PrintPlan; job: PrintJob; paths: ReturnType<typeof partPaths>[]; i: number; nozzles: number }) {
  const pl = plan.plates[i];
  const [W, H] = plan.printer.bed;
  const hovered = useView((s) => s.hovered);
  // the parts on this plate, by part, with how many of each
  const counts = new Map<number, number>();
  for (const q of pl.places) counts.set(plan.copies[q.item].part, (counts.get(plan.copies[q.item].part) ?? 0) + 1);
  const big = pl.places.some((q) => plan.tooBig.includes(q.item));
  return (
    <div className={`mk-plate ${big ? "is-big" : ""}`}>
      <div className="mk-plate-head">
        <b>Plate {i + 1}</b>
        <span className="mk-plate-mat">{pl.materials.join(" + ")}</span>
        <span className="grow" />
        <button className="btn sm ghost mk-plate-dl" onClick={() => void exportPlates({ all: true, nozzles, plate: i })} data-tip={`Plate ${i + 1} as a .3mf`}>
          <Icon.Download size={11} /> .3mf
        </button>
      </div>
      <svg className="mk-plate-svg" viewBox={`-3 -3 ${W + 6} ${H + 6}`} role="img" aria-label={`Plate ${i + 1}: ${pl.places.length} parts on a ${W} by ${H} millimetre bed`}>
        <rect className="mk-bed" x={0} y={0} width={W} height={H} rx={4} />
        {Array.from({ length: Math.floor(W / 50) }, (_, k) => (
          <line key={`x${k}`} className="mk-bed-grid" x1={(k + 1) * 50} y1={0} x2={(k + 1) * 50} y2={H} />
        ))}
        {Array.from({ length: Math.floor(H / 50) }, (_, k) => (
          <line key={`y${k}`} className="mk-bed-grid" x1={0} y1={H - (k + 1) * 50} x2={W} y2={H - (k + 1) * 50} />
        ))}
        {/* the bed's y runs up, the drawing's down */}
        <g transform={`translate(0 ${H}) scale(1 -1)`}>
          {pl.places.map((q) => {
            const c = plan.copies[q.item];
            const m = plateMatrix(c, q);
            const id = copyId(job, q.item);
            const p = paths[c.part];
            const off = plan.estimates[c.part].supportsOff;
            return (
              <g
                key={q.item}
                className={`mk-copy ${id && hovered === id ? "is-hover" : ""}`}
                transform={`matrix(${m[0]} ${m[1]} ${m[4]} ${m[5]} ${m[12].toFixed(2)} ${m[13].toFixed(2)})`}
                onMouseEnter={() => id && useView.setState({ hovered: id })}
                onMouseLeave={() => useView.setState({ hovered: null })}
              >
                <title>{`${c.name}: ${c.material}, ${Math.round(c.size[0])} × ${Math.round(c.size[1])} × ${Math.round(c.size[2])} mm, lying on ${c.face}`}</title>
                <path className="mk-foot" d={p.foot} style={{ fill: c.color }} />
                <path className="mk-edge" d={p.edge} />
                {p.sup && <path className={`mk-sup ${off ? "off" : ""}`} d={p.sup} />}
              </g>
            );
          })}
        </g>
        {pl.places.map((q) => {
          const c = plan.copies[q.item];
          const m = plateMatrix(c, q);
          const r = Math.max(3.5, Math.min(7, Math.min(c.size[0], c.size[1]) / 4));
          return (
            <g key={`n${q.item}`} className="mk-copy-n" transform={`translate(${m[12].toFixed(2)} ${(H - m[13]).toFixed(2)})`} pointerEvents="none">
              <circle r={r} />
              <text dy="0.35em" style={{ fontSize: r * 1.25 }}>
                {c.part + 1}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mk-plate-sum mono">
        {fmtGrams(pl.grams)} g{pl.supportGrams > 0.05 ? ` (${fmtGrams(pl.supportGrams)} g supports)` : ""} · {fmtPrintTime(pl.hours)} · {Math.round(pl.fill * 100)} % of the bed
      </div>
      <div className="mk-plate-parts">
        {[...counts].map(([k, n]) => (
          <span key={k} className="mk-plate-part">
            <i>{k + 1}</i>
            {plan.parts[k].name}
            {n > 1 && <span className="dim"> ×{n}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

/** One row a part: how it lies, what it weighs and takes, and its supports. */
function PartsTable({ plan }: { plan: PrintPlan }) {
  return (
    <div className="mk-routes">
      <div className="mk-h">Each part as it prints</div>
      <table className="mk-table mk-plate-table">
        <thead>
          <tr>
            <th>Part</th>
            <th>Lies on</th>
            <th className="num">Each</th>
            <th className="num">Time</th>
            <th>Supports</th>
          </tr>
        </thead>
        <tbody>
          {plan.parts.map((p, k) => {
            const e = plan.estimates[k];
            const c = plan.copies.find((x) => x.part === k);
            const s = e.supports;
            const sup = e.supportsOff
              ? `off: ${fmtMm2(s.area)} of overhang in the air`
              : s.area > 0
                ? `${fmtMm2(s.area)} held up, ${fmtGrams(e.supportGrams)} g, up to ${Math.round(s.tallest)} mm tall${s.bridged > 0 ? `; bridges ${fmtMm2(s.bridged)}` : ""}`
                : s.bridged > 0
                  ? `none: bridges ${fmtMm2(s.bridged)}`
                  : "none";
            return (
              <tr key={k}>
                <td>
                  <span className="mk-proc">
                    <i className="mk-plate-k">{k + 1}</i>
                    <Swatch material={p.material} color={p.color} size={14} render={40} />
                    {p.name}
                    {p.qty > 1 && <span className="mk-why">×{p.qty}</span>}
                  </span>
                </td>
                <td className="mk-why">{c?.face ?? ""}</td>
                <td className="num">
                  {fmtGrams(e.grams + e.supportGrams)} g
                </td>
                <td className="num">{fmtPrintTime(e.hours)}</td>
                <td className={e.supportsOff ? "mk-plate-off" : "mk-why"}>{sup}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
