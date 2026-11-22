// The wiring tab: the harness as its own workspace. While it is open the 3D
// view shows the wiring with the design ghosted back. Beside the list it
// filters the harness by what the cables carry, their voltage, the part they
// go to or words; colours it by the wires' own colours, by what they carry or
// by load against rating; and steps through the build order a cable at a
// time, each one's plugs going home in 3D. The cable list is linked both ways
// with the 3D view: pick a row and the camera flies to its cable, pick a
// cable and its row lights and scrolls into view. A cut list exports for
// making the harness on the bench.

import { useEffect, useMemo, useRef } from "react";
import { motion } from "framer-motion";
import { useDesign } from "../../core/engine";
import { useHarness, routedRuns, wireRun } from "../../machine/harness/runtime";
import type { Harness, HarnessWire } from "../../machine/harness/harness";
import { cableDetails, cableLoads, carriesOf, cutListCsv } from "../../machine/harness/details";
import { cutLength, type WireKind } from "../../machine/wiring";
import { download, safeFileName } from "../../persist/files";
import { Segmented } from "../common";
import { Icon } from "../icons";
import { NO_FILTER, pickWire, useWiringView, type WiringFilter } from "../wiringView";
import { kindColor, KIND_NAME, loadColor } from "./colours";
import { filtering, matches, roundV } from "./filter";
import { wireIssues } from "../WiringLayer";
import "../../styles/wiring-tab.css";

const KINDS: WireKind[] = ["power", "ground", "signal", "motor", "cable"];
/** seconds per cable when the build order plays */
const STEP_S = 2.6;

export function WiringTab() {
  const model = useDesign((s) => s.model);
  const harness = useHarness((s) => s.harness);
  const status = useHarness((s) => s.status);
  const findings = useHarness((s) => s.findings);
  const routes = useHarness((s) => s.routes);
  const picked = useWiringView((s) => s.picked);
  const hovered = useWiringView((s) => s.hovered);
  const filter = useWiringView((s) => s.filter);
  const colours = useWiringView((s) => s.colours);
  const step = useWiringView((s) => s.step);
  const playing = useWiringView((s) => s.playing);
  const trace = useWiringView((s) => s.trace);
  const m = model?.machine;

  const loads = useMemo(() => (m && harness ? cableLoads(m, harness) : new Map<string, { volts?: number; amps?: number; rating?: number }>()), [m, harness]);
  const volts = useMemo(() => new Map([...loads].map(([id, l]) => [id, l.volts])), [loads]);
  const issues = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const w of harness?.wires ?? []) {
      const list = wireIssues(w, findings, (id) => model?.parts.find((p) => p.id === id)?.name ?? id);
      if (list.length) out.set(w.id, list);
    }
    return out;
  }, [harness, findings, model]);
  const wires = harness?.wires ?? [];
  const rows = useMemo(() => wires.filter((w) => matches(w, filter, volts)), [wires, filter, volts]);
  const runs = useMemo(() => (routes && model ? routedRuns(model) : undefined), [routes, model]);

  // the build order plays a cable at a time
  useEffect(() => {
    if (!playing || step === null) return;
    const t = setTimeout(() => {
      if (step + 1 >= wires.length) useWiringView.setState({ playing: false });
      else stepTo(step + 1);
    }, STEP_S * 1000);
    return () => clearTimeout(t);
  }, [playing, step, wires.length]);

  if (!m || !harness) {
    return <div className="empty-state">{status === "routing" || status === "idle" ? "Routing the cables…" : "This design has no wiring yet."}</div>;
  }
  if (!wires.length) return <div className="empty-state">No wires yet. Connect pins with wire statements (wire ctrl.D9 -&gt; drv.PWM) or nets, and the harness appears here in 3D.</div>;

  const total = wires.reduce((s, w) => s + (w.row.lead ? 0 : (runs?.get(w.id) !== undefined ? cutLength(runs.get(w.id)!) : (w.row.lengthMm ?? 0)) * w.wires.length), 0);
  const counts = new Map<WireKind, number>(KINDS.map((k) => [k, wires.filter((w) => carriesOf(w.row) === k).length]));
  const vset = [...new Set([...volts.values()].filter((v): v is number => v !== undefined && v > 0).map(roundV))].sort((a, b) => b - a);
  const comps = [...new Set(wires.flatMap((w) => w.ends.map((e) => e.comp.replace(/\[\d+\]$/, ""))))].sort();
  const setFilter = (f: Partial<WiringFilter>) => useWiringView.setState({ filter: { ...filter, ...f }, step: null, playing: false });
  const toggleIn = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  const problems = issues.size;
  const file = safeFileName(`${model?.name || "design"} cut list`, "csv");

  return (
    <div className="wt">
      <aside className="wt-side">
        <div className="wt-sum">
          <div>
            <b>{wires.length}</b> cables
          </div>
          <div>
            <b>{total >= 1000 ? `${(total / 1000).toFixed(1)} m` : `${total} mm`}</b> of wire
          </div>
          <div className={problems ? "warn" : "pass"}>
            {problems ? <Icon.Alert size={12} /> : <Icon.Check size={12} />} <b>{problems || "no"}</b> {problems === 1 ? "problem" : "problems"}
          </div>
        </div>

        {step !== null && <BuildOrder harness={harness} step={step} playing={playing} />}
        <div className="wt-group wt-row">
          {step === null && <BuildOrder harness={harness} step={step} playing={playing} />}
          <button
            className="btn sm"
            onClick={() => download(cutListCsv(m, harness, runs), file, "text/csv")}
            data-tip="Every cable: what to cut, and the housing, contacts and strip length at each end"
          >
            <Icon.Download size={13} /> Cut list
          </button>
          {trace && (
            <button className="btn sm on" onClick={() => useWiringView.setState({ trace: null })} data-tip="Stop lighting the circuit">
              <Icon.Bolt size={13} /> Circuit of {trace.from} <Icon.X size={11} />
            </button>
          )}
        </div>
        <div className="wt-group">
          <div className="wt-label">Carries</div>
          <div className="wt-chips">
            {KINDS.filter((k) => counts.get(k)).map((k) => (
              <button key={k} className={`wt-chip${filter.kinds.includes(k) ? " on" : ""}`} onClick={() => setFilter({ kinds: toggleIn(filter.kinds, k) })} aria-pressed={filter.kinds.includes(k)}>
                <i style={{ background: kindColor(k) }} /> {KIND_NAME[k]} <span>{counts.get(k)}</span>
              </button>
            ))}
          </div>
        </div>
        {vset.length > 0 && (
          <div className="wt-group">
            <div className="wt-label">Voltage</div>
            <div className="wt-chips">
              {vset.map((v) => (
                <button key={v} className={`wt-chip${filter.volts.includes(v) ? " on" : ""}`} onClick={() => setFilter({ volts: toggleIn(filter.volts, v) })} aria-pressed={filter.volts.includes(v)}>
                  {v} V
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="wt-group wt-row">
          <select className="select sm" value={filter.comp ?? ""} onChange={(e) => setFilter({ comp: e.target.value || null })} aria-label="Only cables to a part">
            <option value="">Every part</option>
            {comps.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input className="input sm" placeholder="Find a cable, pin or net" value={filter.text} onChange={(e) => setFilter({ text: e.target.value })} aria-label="Find a cable" />
          {filtering(filter) && (
            <button className="icon-btn sm" onClick={() => setFilter(NO_FILTER)} data-tip="Show every cable" aria-label="Clear the filters">
              <Icon.X size={13} />
            </button>
          )}
        </div>
        <div className="wt-group">
          <div className="wt-label">Colour by</div>
          <Segmented
            id="wiring-colours"
            value={colours}
            onChange={(v) => useWiringView.setState({ colours: v })}
            options={[
              { value: "wire", label: "Wire", title: "Each wire in its own insulation colour" },
              { value: "kind", label: "Carries", title: "Power red, ground grey, signal blue, motor amber, cables violet" },
              { value: "load", label: "Load", title: "Current against what the wire is rated for: blue light, green fine, amber near its limit, red over" },
            ]}
          />
          {colours === "load" && <div className="wt-ramp" aria-hidden />}
        </div>
      </aside>
      <CableList
        rows={rows}
        all={wires.length}
        picked={step !== null ? (wires[step]?.id ?? null) : picked}
        hovered={hovered}
        issues={issues}
        loads={loads}
        step={step}
        order={wires}
        colours={colours}
      />
    </div>
  );
}

const stepTo = (i: number) => useWiringView.setState({ step: i, picked: null, trace: null });

function BuildOrder({ harness, step, playing }: { harness: Harness; step: number | null; playing: boolean }) {
  const m = useDesign((s) => s.model?.machine);
  const n = harness.wires.length;
  const w = step !== null ? harness.wires[step] : undefined;
  const d = useMemo(() => (w && m ? cableDetails(m, harness, w, wireRun(w.id)) : null), [w, m, harness]);
  if (step === null)
    return (
      <button
        className="btn sm wt-build"
        onClick={() => useWiringView.setState({ step: 0, playing: true, picked: null, trace: null, filter: NO_FILTER })}
        data-tip="Fit the harness a cable at a time, in the order it goes in on the bench: ground first, power last"
      >
        <Icon.Play size={13} /> Build order
      </button>
    );
  return (
    <motion.div className="wt-group wt-step" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
      <div className="wt-step-head">
        <span className="wt-label">
          Step {step + 1} of {n}
        </span>
        <div className="grow" />
        <button className="icon-btn sm" disabled={step === 0} onClick={() => stepTo(step - 1)} aria-label="Previous cable">
          <span style={{ transform: "rotate(180deg)", display: "inline-grid" }}>
            <Icon.Chevron size={13} />
          </span>
        </button>
        <button className="icon-btn sm" onClick={() => useWiringView.setState({ playing: !playing })} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Icon.Pause size={13} /> : <Icon.Play size={13} />}
        </button>
        <button className="icon-btn sm" disabled={step >= n - 1} onClick={() => stepTo(step + 1)} aria-label="Next cable">
          <Icon.Chevron size={13} />
        </button>
        <button className="icon-btn sm" onClick={() => useWiringView.setState({ step: null, playing: false })} aria-label="Stop the build order">
          <Icon.X size={13} />
        </button>
      </div>
      <div className="wt-progress">
        <motion.span animate={{ width: `${((step + 1) / n) * 100}%` }} transition={{ type: "spring", stiffness: 160, damping: 26 }} />
      </div>
      {d && (
        <div className="wt-step-text" key={d.id}>
          <b className="mono">{d.id}</b> {d.title}: {d.ends[0].comp} {d.ends[0].label} → {d.ends[1].comp} {d.ends[1].label}
          <div className="dim">{d.steps.join(" ")}</div>
          {w?.row.kind === "power" && <div className="wt-power">Power last, with the supply off.</div>}
        </div>
      )}
    </motion.div>
  );
}

function CableList({
  rows,
  all,
  picked,
  hovered,
  issues,
  loads,
  step,
  order,
  colours,
}: {
  rows: HarnessWire[];
  all: number;
  picked: string | null;
  hovered: string | null;
  issues: Map<string, string[]>;
  loads: Map<string, { volts?: number; amps?: number; rating?: number }>;
  step: number | null;
  order: HarnessWire[];
  colours: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  // a cable picked in 3D: its row scrolls into view
  useEffect(() => {
    if (!picked) return;
    box.current?.querySelector(`[data-wire="${picked}"]`)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [picked]);
  const at = step !== null ? new Map(order.map((w, i) => [w.id, i])) : null;
  return (
    <div className="wt-list" ref={box}>
      <table className="wt-table">
        <thead>
          <tr>
            <th aria-label="Wire" />
            <th>From</th>
            <th>To</th>
            <th>Carries</th>
            <th className="num">AWG</th>
            <th className="num">Cut</th>
            <th>Load</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => {
            const l = loads.get(w.id);
            const f = l?.amps !== undefined && l.rating ? l.amps / l.rating : undefined;
            const bad = issues.get(w.id);
            const later = at && (at.get(w.id) ?? 0) > (step ?? 0);
            const run = wireRun(w.id);
            const cut = w.row.lead ? undefined : run !== undefined ? cutLength(run) : w.row.lengthMm;
            return (
              <tr
                key={w.id}
                data-wire={w.id}
                className={`${picked === w.id ? "on" : ""}${hovered === w.id ? " hover" : ""}${later ? " later" : ""}`}
                onClick={() => (step !== null ? stepTo(at!.get(w.id) ?? 0) : pickWire(picked === w.id ? null : w.id, { fly: true }))}
                onPointerEnter={() => useWiringView.setState({ hovered: w.id })}
                onPointerLeave={() => useWiringView.getState().hovered === w.id && useWiringView.setState({ hovered: null })}
              >
                <td className="wt-id">
                  <span className="wt-sw">
                    {[...new Set(w.wires.map((x) => x.color))].slice(0, 4).map((c) => (
                      <i key={c} style={{ background: colours === "kind" ? kindColor(carriesOf(w.row)) : colours === "load" ? loadColor(f) : c }} />
                    ))}
                  </span>
                  <span className="mono">{w.id}</span>
                  {bad && (
                    <span className="wt-bad" data-tip={bad.join("; ")}>
                      <Icon.Alert size={11} />
                    </span>
                  )}
                </td>
                <td>
                  <End e={w.ends[0]} />
                </td>
                <td>
                  <End e={w.ends[1]} />
                </td>
                <td>
                  <span className="wt-kind" style={{ ["--k" as string]: kindColor(carriesOf(w.row)) }}>
                    {w.row.cable ?? (w.row.label || w.row.net)}
                  </span>
                </td>
                <td className="num mono">{w.row.gauge ?? "–"}</td>
                <td className="num mono">{cut !== undefined ? cut : w.row.lead ? "lead" : "–"}</td>
                <td>
                  {f !== undefined && (l?.amps ?? 0) >= 0.05 ? (
                    <span className="wt-load" data-tip={`${l!.amps!.toFixed(2)} A of ${l!.rating} A`}>
                      <span style={{ width: `${Math.min(100, f * 100)}%`, background: loadColor(f) }} />
                    </span>
                  ) : (
                    <span className="dim">{carriesOf(w.row) === "signal" ? "signal" : ""}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length < all && (
        <div className="wt-more dim">
          {rows.length} of {all} cables match.{" "}
          <button className="link" onClick={() => useWiringView.setState({ filter: NO_FILTER })}>
            Show them all
          </button>
        </div>
      )}
    </div>
  );
}

function End({ e }: { e: HarnessWire["ends"][number] }) {
  return (
    <span className="wt-end">
      <span className="mono">
        {e.comp}.{e.pin}
      </span>
      {e.label !== e.pin && <span className="dim"> {e.label}</span>}
    </span>
  );
}
