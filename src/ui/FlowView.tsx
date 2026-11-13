// The analysis tab for a flow analysis: the run while it goes, how hot each part gets against what it can take, where
// the heat goes, each fan on its curve, the pressure a set flow takes and how it shares out between the openings,
// the set-up and what to keep in mind.

import { useEffect, useMemo, useState } from "react";
import { revealSpan } from "../app/view";
import { useDesign } from "../core/engine";
import { flowAmbient, rerunFlow, showFlow, startFlowNow, stopFlow, useFlow, type FlowColour, type FlowRun } from "../analysis/flowRuntime";
import { CFM, cfm, degC, flowHottest } from "../analysis/flowSummary";
import type { FlowSpec } from "../analysis/spec";
import type { FanResult, FlowResult } from "../analysis/flow/types";
import { Segmented } from "./common";
import { Icon } from "./icons";
import { fmtNum } from "../lang/values";

type FlowState = ReturnType<typeof useFlow.getState>;

/** Header controls: draw on the model, the parts by temperature (with the case see-through), streamlines, what colours the air, a cut. */
export function FlowControls({ spec, run }: { spec: FlowSpec; run?: FlowRun }) {
  const shown = useFlow((s) => s.shown);
  const surface = useFlow((s) => s.surface);
  const xray = useFlow((s) => s.xray);
  const lines = useFlow((s) => s.lines);
  const colour = useFlow((s) => s.colour);
  const slice = useFlow((s) => s.slice);
  const sliceAt = useFlow((s) => s.sliceAt);
  const on = shown === spec.label;
  const has = !!run?.result;
  const busy = run?.status === "running" || run?.status === "waiting";
  const set = (patch: Partial<FlowState>) => {
    useFlow.setState(patch);
    if (has && !on) showFlow(spec.label);
  };
  return (
    <div className="an-ctl">
      <button className={`an-toggle ${on ? "on" : ""}`} disabled={!has} onClick={() => showFlow(on ? null : spec.label)} aria-pressed={on} data-tip="Draw the flow on the model">
        {on ? <Icon.Eye size={13} /> : <Icon.EyeOff size={13} />} on model
      </button>
      <button className={`an-toggle ${surface ? "on" : ""}`} onClick={() => set({ surface: !surface })} aria-pressed={surface} data-tip="Colour the parts by temperature">
        parts
      </button>
      <button className={`an-toggle ${xray ? "on" : ""}`} disabled={!surface} onClick={() => set({ xray: !xray })} aria-pressed={xray} data-tip="Draw a case, lid or duct that wraps round the rest see-through, so what is inside shows">
        see inside
      </button>
      <button className={`an-toggle ${lines ? "on" : ""}`} onClick={() => set({ lines: !lines })} aria-pressed={lines} data-tip="Streamlines through the air from the fans and openings">
        streamlines
      </button>
      <Segmented<FlowColour>
        id="flow-colour"
        value={colour}
        onChange={(v) => set({ colour: v })}
        options={[
          { value: "temperature", label: "temp", title: "Colour the air by its temperature" },
          { value: "speed", label: "speed", title: "Colour the air by its speed" },
        ]}
      />
      <select className="input sm" value={slice} aria-label="Cut through the air" disabled={!!run?.result && !run.result.field} onChange={(e) => set({ slice: e.target.value as FlowState["slice"] })} data-tip="A cut through the air and the parts">
        <option value="off">no cut</option>
        <option value="x">cut across X</option>
        <option value="y">cut across Y</option>
        <option value="z">cut across Z</option>
      </select>
      {slice !== "off" && (
        <input
          className="slider"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={sliceAt}
          aria-label="Where the cut is"
          style={{ ["--p" as string]: `${sliceAt * 100}%` }}
          onChange={(e) => set({ sliceAt: Number(e.target.value) })}
        />
      )}
      {busy ? (
        <button className="btn sm" onClick={() => stopFlow(spec.label)} data-tip="Stop this run (the last result stays)">
          <Icon.X size={12} /> stop
        </button>
      ) : null}
      {run?.status === "waiting" && (
        <button className="btn sm" onClick={() => startFlowNow()} data-tip="Start now instead of waiting for the design to settle">
          <Icon.Play size={12} /> run now
        </button>
      )}
    </div>
  );
}

export function FlowView({ spec, run }: { spec: FlowSpec; run?: FlowRun }) {
  const r = run?.result;
  const busy = run?.status === "running" || run?.status === "waiting";
  return (
    <>
      {busy && <Live run={run!} updating={!!r} />}
      {run?.status === "error" && run.error !== "Stopped." && (
        <div className="an-box" style={{ marginBottom: 12, borderColor: "rgb(var(--fail-rgb) / 0.4)", background: "var(--fail-soft)" }}>
          <div className="an-note" style={{ color: "var(--fail-ink)" }}>
            <Icon.Alert size={15} />
            <div className="grow">
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{run.setup ? "This set-up can't run as written" : "The flow run did not finish"}</div>
              {run.error}
            </div>
            <button className="btn sm" onClick={() => revealSpan(spec.span)}>
              <Icon.Code size={13} /> Show in code
            </button>
          </div>
        </div>
      )}
      {run?.status === "error" && run.error === "Stopped." && (
        <div className="an-box" style={{ marginBottom: 12 }}>
          <div className="an-note">
            <Icon.Info size={14} style={{ color: "var(--text-3)" }} />
            <span className="grow">Stopped. {r ? "The results below are from the last run that finished." : "It runs again when the parts it covers change."}</span>
            <button className="btn sm" onClick={() => rerunFlow(spec.label)}>
              <Icon.Play size={12} /> run again
            </button>
          </div>
        </div>
      )}
      {r && <Cards spec={spec} r={r} />}
      <div className="an-cols">
        <div>
          {r && r.parts.length > 0 && r.heatIn > 0 && <PartsBox r={r} />}
          {r && r.fans.length > 0 && <FansBox r={r} />}
          {r && (r.drives.length > 0 || r.sections.length > 0) && <OpeningsBox spec={spec} r={r} />}
          <SetupBox spec={spec} r={r} />
        </div>
        <div>
          {r && r.heatIn > 0 && <HeatBox r={r} />}
          {r && <NotesBox r={r} />}
        </div>
      </div>
    </>
  );
}

/** The run's progress: the stage, how settled the flow is, the hottest air so far and each fan's flow. */
function Live({ run, updating }: { run: FlowRun; updating: boolean }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, (now - run.startedAt) / 1000);
  const p = run.progress;
  return (
    <div className="an-box" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 10 }}>
        <span className="spinner" />
        <span style={{ fontSize: 12.5 }}>{updating ? "Re-running the flow for your latest change" : "Running the flow"}</span>
        <span className="mono dim" style={{ fontSize: 11 }}>
          {run.status === "waiting" ? "waiting for the design to settle" : run.stage.toLowerCase()}
          {p?.iteration !== undefined ? ` · iteration ${p.iteration}` : ""}
          {p?.residual !== undefined ? ` · imbalance ${fmtNum(p.residual * 100, 2)} %` : ""}
          {p?.maxTemp !== undefined ? ` · hottest ${degC(p.maxTemp)}` : ""}
          {p?.fans?.length ? ` · ${p.fans.map((q) => cfm(q)).join(", ")}` : ""} · {fmtNum(secs, 0)} s
        </span>
      </div>
      <div className="an-progress">
        <div style={{ width: `${Math.round(run.frac * 100)}%` }} />
      </div>
    </div>
  );
}

function Cards({ spec, r }: { spec: FlowSpec; r: FlowResult }) {
  const hot = flowHottest(r)[0];
  const st = (s: "pass" | "warn" | "fail" | "") => s;
  const hotStatus = !hot || hot.limit === undefined ? "" : hot.max > hot.limit ? "fail" : hot.max > hot.limit - 5 ? "warn" : "pass";
  const fan = r.fans[0];
  const drive = r.drives[0];
  const limitPa = spec.maxPressure !== undefined ? spec.maxPressure * 1e6 : undefined;
  return (
    <div className="an-grid" style={{ marginBottom: 12 }}>
      {r.heatIn > 0 && hot && (
        <div className={`an-stat ${st(hotStatus)}`}>
          <div className="k">Hottest against its limit</div>
          <div className="v">
            {fmtNum(hot.max, 1)}
            <small>°C</small>
          </div>
          <div className="s">
            {hot.name}
            {hot.limit !== undefined ? ` · limit ${fmtNum(hot.limit, 0)} °C, ${hot.max > hot.limit ? `${fmtNum(hot.max - hot.limit, 1)} K over` : `${fmtNum(hot.limit - hot.max, 1)} K to spare`}` : ""}
          </div>
        </div>
      )}
      {r.heatIn > 0 && (
        <div className="an-stat">
          <div className="k">Heat made</div>
          <div className="v">
            {fmtNum(r.heatIn, r.heatIn < 10 ? 2 : 1)}
            <small>W</small>
          </div>
          <div className="s">
            {fmtNum(r.heatAir, 2)} W into the air · {fmtNum(r.heatRadiated, 2)} W radiated
          </div>
        </div>
      )}
      <div className="an-stat">
        <div className="k">{r.fluid === "water" ? "Water" : "Air"} through</div>
        <div className="v">
          {fmtNum(r.throughFlow / CFM, r.throughFlow / CFM < 10 ? 2 : 1)}
          <small>CFM</small>
        </div>
        <div className="s">
          {fmtNum(r.throughFlow * 60000, 1)} L/min{r.heatIn > 0 ? ` · leaves ${fmtNum(r.airRise, 1)} K warmer` : ""}
        </div>
      </div>
      {fan ? (
        <div className={`an-stat ${fan.reversed ? "fail" : fan.stalled ? "warn" : ""}`}>
          <div className="k">{r.fans.length > 1 ? `Fans (${r.fans.length})` : "Fan"}</div>
          <div className="v">
            {fmtNum((100 * fan.flow) / fan.freeFlow, 0)}
            <small>% of free flow</small>
          </div>
          <div className="s">
            {fan.name}: {fan.reversed ? "air going backwards" : `${cfm(fan.flow)} against ${fmtNum(fan.rise, 1)} Pa`}
          </div>
        </div>
      ) : drive ? (
        <div className={`an-stat ${limitPa === undefined ? "" : drive.rise > limitPa ? "fail" : "pass"}`}>
          <div className="k">Pressure to push it</div>
          <div className="v">
            {fmtNum(drive.rise, drive.rise < 10 ? 2 : 1)}
            <small>Pa</small>
          </div>
          <div className="s">
            {limitPa !== undefined ? `limit ${fmtNum(limitPa, 0)} Pa · ` : ""}
            {fmtNum(drive.speed, 2)} m/s in, loss {fmtNum(drive.lossCoefficient, 1)}× its dynamic pressure
          </div>
        </div>
      ) : (
        <div className="an-stat">
          <div className="k">Fastest air</div>
          <div className="v">
            {fmtNum(r.maxSpeed, r.maxSpeed < 1 ? 2 : 1)}
            <small>m/s</small>
          </div>
          <div className="s">
            warm {r.fluid} rising on its own · hottest {r.fluid} {degC(r.maxAir)}
          </div>
        </div>
      )}
    </div>
  );
}

/** Each part's hottest point against what it can take, nearest its limit first. */
function PartsBox({ r }: { r: FlowResult }) {
  const parts = useMemo(() => flowHottest(r).slice(0, 16), [r]);
  return (
    <div className="an-box">
      <h4>
        Temperatures by part
        <div className="grow" />
        <span className="mono dim" style={{ fontSize: 10.5 }}>
          hottest · limit
        </span>
      </h4>
      {parts.map((p) => {
        const lim = p.limit ?? Math.max(r.ambient + 1, p.max);
        const share = Math.max(0, Math.min(1, (p.max - r.ambient) / Math.max(1e-6, lim - r.ambient)));
        const over = p.limit !== undefined && p.max > p.limit;
        const close = p.limit !== undefined && !over && p.max > p.limit - 5;
        const tip = [
          `mean ${degC(p.mean)}`,
          p.watts > 0 ? `makes ${fmtNum(p.watts, 2)} W${p.heatWhy ? ` (${p.heatWhy})` : ""}` : "makes no heat",
          p.limit !== undefined ? `limit: ${p.limitWhy ?? degC(p.limit)}` : "",
          p.material,
          p.cells === 0 ? "smaller than a cell, so read from the cell it sits in" : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <div key={p.id} className="an-bar-row" data-tip={tip}>
            <span className="an-bar-name">{p.name}</span>
            <span className="an-bar">
              <span style={{ width: `${share * 100}%`, ...(over ? { background: "var(--fail)" } : close ? { background: "var(--warn)" } : {}) }} />
            </span>
            <span className={`mono ${over ? "fail" : close ? "warn" : "dim"}`}>
              {fmtNum(p.max, 1)}
              {p.limit !== undefined ? ` / ${fmtNum(p.limit, 0)}` : ""} °C
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Each fan on its curve: where it works, with the stalling part of an axial fan's curve marked. */
function FansBox({ r }: { r: FlowResult }) {
  return (
    <div className="an-box">
      <h4>Fans on their curves</h4>
      {r.fans.map((f) => (
        <FanCurve key={f.id} f={f} />
      ))}
    </div>
  );
}

function FanCurve({ f }: { f: FanResult }) {
  const X = (q: number) => 6 + (Math.max(0, q) / f.freeFlow) * 88;
  const Y = (p: number) => 48 - (Math.max(0, p) / f.shutoff) * 42;
  const pts = f.curve.map(([q, p]) => `${X(q).toFixed(2)},${Y(p).toFixed(2)}`).join(" ");
  const blower = f.blower;
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="row" style={{ gap: 8, fontSize: 12 }}>
        <span style={{ fontWeight: 600 }}>{f.name}</span>
        <div className="grow" />
        <span className={`mono ${f.reversed ? "fail" : f.stalled ? "warn" : "dim"}`} style={{ fontSize: 11 }}>
          {f.reversed ? "air going backwards" : `${cfm(f.flow)} · ${fmtNum(f.rise, 1)} Pa · ${fmtNum((100 * f.flow) / f.freeFlow, 0)} % of free`}
        </span>
      </div>
      <svg className="an-spark" viewBox="0 0 100 54" preserveAspectRatio="none" aria-label={`${f.name}'s pressure against flow, and where it works`}>
        {!blower && <rect x={6} y={6} width={0.3 * 88} height={42} fill="rgb(var(--warn-rgb) / 0.12)" />}
        <line x1={6} y1={48} x2={94} y2={48} stroke="var(--line-2)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <line x1={6} y1={6} x2={6} y2={48} stroke="var(--line-2)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <polyline points={pts} fill="none" stroke="var(--accent-2)" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
        {!f.reversed && <circle cx={X(f.flow)} cy={Y(f.rise)} r={2.2} fill={f.stalled ? "var(--warn)" : "var(--accent)"} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="mono dim" style={{ fontSize: 10.5 }}>
        pressure (up to {fmtNum(f.shutoff, 0)} Pa) against flow (to {cfm(f.freeFlow)} free){!blower ? "; shaded: where an axial fan stalls" : ""} · air through it at {degC(f.temp)}
      </div>
      <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>
        Curve: {f.curveWhy}
      </div>
    </div>
  );
}

/** The set flow's pressure and how the flow shares out between the openings. */
function OpeningsBox({ spec, r }: { spec: FlowSpec; r: FlowResult }) {
  const total = r.drives.reduce((s, d) => s + d.flow, 0) || r.throughFlow || 1;
  const limitPa = spec.maxPressure !== undefined ? spec.maxPressure * 1e6 : undefined;
  return (
    <div className="an-box">
      <h4>Openings</h4>
      <table className="an-table">
        <thead>
          <tr>
            <th>opening</th>
            <th>flow</th>
            <th>share</th>
            <th>air</th>
          </tr>
        </thead>
        <tbody>
          {r.drives.map((d) => (
            <tr key={d.label}>
              <td>{d.label}</td>
              <td className="mono">{cfm(d.flow)}</td>
              <td className="mono dim">in</td>
              <td className={`mono ${limitPa !== undefined ? (d.rise > limitPa ? "fail" : "pass") : ""}`}>
                {fmtNum(d.rise, 1)} Pa{limitPa !== undefined ? ` / ${fmtNum(limitPa, 0)}` : ""}
              </td>
            </tr>
          ))}
          {r.sections.map((s) => (
            <tr key={s.label}>
              <td>{s.label}</td>
              <td className="mono">{cfm(s.flow)}</td>
              <td className="mono">{fmtNum((100 * s.flow) / total, 0)} %</td>
              <td className="mono">{degC(s.temp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.drives.map((d) => (
        <div key={d.label} className="mono dim" style={{ fontSize: 10.5, marginTop: 4 }}>
          {fmtNum(d.flow * 60000, 2)} L/min in at {fmtNum(d.speed, 2)} m/s through {fmtNum(d.area * 1e6, 0)} mm²; the pressure it takes is {fmtNum(d.lossCoefficient, 1)} times its dynamic pressure
          {d.rise >= 1000 ? ` (${fmtNum(d.rise / 1000, 2)} kPa, ${fmtNum(d.rise / 6894.76, 2)} psi)` : ""}
        </div>
      ))}
    </div>
  );
}

/** Where the heat goes: into the air going through, and radiated, with the heat balance. */
function HeatBox({ r }: { r: FlowResult }) {
  const air = Math.max(0, r.heatAir);
  const rad = Math.max(0, r.heatRadiated);
  const sum = Math.max(1e-9, air + rad);
  const made = r.parts.filter((p) => p.watts > 0).sort((a, b) => b.watts - a.watts);
  return (
    <div className="an-box">
      <h4>
        Where the heat goes
        <div className="grow" />
        <span className={`chip ${Math.abs(r.balance) <= 0.05 ? "pass" : "warn"}`} style={{ height: 18, letterSpacing: 0, textTransform: "none" }}>
          balance {fmtNum(Math.abs(r.balance) * 100, 1)} %
        </span>
      </h4>
      <div className="an-bar-row" data-tip={`Carried off by the ${r.fluid} leaving to the surroundings`}>
        <span className="an-bar-name">into the {r.fluid}</span>
        <span className="an-bar">
          <span style={{ width: `${(100 * air) / sum}%` }} />
        </span>
        <span className="mono dim">{fmtNum(air, 2)} W</span>
      </div>
      <div className="an-bar-row" data-tip="Radiated from the surfaces that see the surroundings">
        <span className="an-bar-name">radiated</span>
        <span className="an-bar">
          <span style={{ width: `${(100 * rad) / sum}%` }} />
        </span>
        <span className="mono dim">{fmtNum(rad, 2)} W</span>
      </div>
      {made.length > 0 && (
        <table className="an-table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>made in</th>
              <th>W</th>
              <th>from</th>
            </tr>
          </thead>
          <tbody>
            {made.slice(0, 10).map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="mono">{fmtNum(p.watts, 2)}</td>
                <td className="dim" style={{ fontSize: 11 }}>
                  {p.heatWhy ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mono dim" style={{ fontSize: 10.5, marginTop: 4 }}>
        the {r.fluid} leaves {fmtNum(r.airRise, 1)} K over the {degC(r.ambient)} it comes in at on average; the hottest {r.fluid} is {degC(r.maxAir)}
      </div>
    </div>
  );
}

function SetupBox({ spec, r }: { spec: FlowSpec; r?: FlowResult }) {
  const model = useDesign((s) => s.model);
  const amb = model ? flowAmbient(spec, model) : null;
  const v3 = (p: number[]) => `(${p.map((v) => fmtNum(v, 2)).join(", ")})`;
  return (
    <div className="an-box">
      <h4>
        Set-up
        <div className="grow" />
        <button className="btn sm ghost" style={{ height: 20 }} onClick={() => revealSpan(spec.span)}>
          <Icon.Code size={12} /> edit
        </button>
      </h4>
      <div className="an-setup">
        <div>
          <span className="tag">flow</span>
          {spec.drive === "fans"
            ? `the design's fans${spec.fans ? ` (${spec.fans.join(", ")})` : ""}, each on its curve`
            : spec.drive === "natural"
              ? "warm air rising on its own"
              : `${cfm((spec.flow ?? 0) / 1e9)} (${fmtNum(((spec.flow ?? 0) / 1e6) * 60, 2)} L/min) pushed in at ${spec.inlet?.label}`}
        </div>
        {spec.outlets.length > 0 && (
          <div>
            <span className="tag">openings</span>
            {spec.outlets.map((o) => o.label).join(", ")}
          </div>
        )}
        <div>
          <span className="tag">heat</span>
          {[spec.auto ? "every electronic part's own loss" : "", ...spec.heat.map((h) => `${fmtNum(h.watts, 2)} W in ${h.part ?? h.label}`)].filter(Boolean).join(", ") || "none"}
        </div>
        <div>
          <span className="tag">{spec.fluid}</span>
          {amb ? `${degC(amb.c)} ${spec.fluid === "water" ? "coming in" : "round it"} (${amb.why})` : ""}
          {spec.gravity ? `, warm ${spec.fluid} rising (up ${v3(spec.up)})` : `, no rising warm ${spec.fluid}`}
        </div>
        <div>
          <span className="tag">parts</span>
          {spec.parts.length ? spec.parts.join(", ") : "every part shown"}
        </div>
        <div>
          <span className="tag">cells</span>
          {r ? `${fmtNum(r.h, 2)} mm, ${fmtNum(r.cells / 1e6, 2)} million (${r.dims.join(" × ")}), ${fmtNum(r.fluidCells / 1e6, 2)} million of air` : typeof spec.resolution === "string" ? spec.resolution : `${spec.resolution.h} mm`}
        </div>
        {(spec.maxTemp !== undefined || spec.maxPressure !== undefined) && (
          <div>
            <span className="tag">limits</span>
            {[spec.maxTemp !== undefined ? `parts below ${degC(spec.maxTemp)}` : "", spec.maxPressure !== undefined ? `push below ${fmtNum(spec.maxPressure * 1e6, 0)} Pa` : ""].filter(Boolean).join(", ")}
          </div>
        )}
      </div>
    </div>
  );
}

function NotesBox({ r }: { r: FlowResult }) {
  return (
    <div className="an-box">
      <h4>
        What to keep in mind
        <div className="grow" />
        <span className={`chip ${r.converged ? "pass" : "warn"}`} style={{ height: 18, letterSpacing: 0, textTransform: "none" }}>
          {r.converged ? "settled" : "not fully settled"}
        </span>
      </h4>
      {r.warnings.map((w, i) => (
        <div key={i} className="an-note">
          <Icon.Alert size={13} style={{ color: "var(--warn)" }} />
          <span>{w}</span>
        </div>
      ))}
      {r.assumptions.map((a, i) => (
        <div key={i} className="an-note">
          <Icon.Info size={13} style={{ color: "var(--text-3)" }} />
          <span className="dim">{a}</span>
        </div>
      ))}
      <div className="mono dim" style={{ fontSize: 10.5, marginTop: 4 }}>
        {r.iterations} iterations in {fmtNum(r.ms / 1000, 0)} s · mass imbalance {fmtNum(r.residual * 100, 2)} % · fastest air {fmtNum(r.maxSpeed, 2)} m/s
      </div>
    </div>
  );
}
