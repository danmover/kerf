// The analysis tab for an airflow analysis: the live flow while it runs,
// drag area, drag, power and side force, the yaw sweep, which parts carry
// the drag, how the drag settled, and every version of the design so far.

import { useEffect, useMemo, useRef, useState } from "react";
import { revealSpan } from "../app/view";
import { showAirflow, startAirflowNow, stopAirflow, useAirflow, yawMean, type AirflowRun, type AirflowVersion, type SurfaceShown } from "../analysis/aeroRuntime";
import { speedColor } from "./viewport/airflowOverlay";
import type { AirflowSpec } from "../analysis/spec";
import type { AirflowResult } from "../analysis/aero/types";
import { Segmented } from "./common";
import { Icon } from "./icons";
import { fmtNum } from "../lang/values";

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** Header controls: draw on the model, what to colour the surface by, flow pictures, and a cut through the flow. */
export function AirflowControls({ spec, run }: { spec: AirflowSpec; run?: AirflowRun }) {
  const shown = useAirflow((s) => s.shown);
  const surface = useAirflow((s) => s.surface);
  const lines = useAirflow((s) => s.lines);
  const wake = useAirflow((s) => s.wake);
  const vortices = useAirflow((s) => s.vortices);
  const slice = useAirflow((s) => s.slice);
  const sliceAt = useAirflow((s) => s.sliceAt);
  const on = shown === spec.label;
  const has = !!run?.result || run?.status === "running";
  const busy = run?.status === "running" || run?.status === "waiting";
  const set = (patch: Partial<ReturnType<typeof useAirflow.getState>>) => {
    useAirflow.setState(patch);
    if (has) showAirflow(spec.label);
  };
  const toggle = (k: "lines" | "wake" | "vortices", v: boolean) => {
    useAirflow.setState({ [k]: !v });
    if (has && !on) useAirflow.setState({ shown: spec.label });
  };
  return (
    <div className="an-ctl">
      <button className={`an-toggle ${on ? "on" : ""}`} disabled={!has} onClick={() => showAirflow(on ? null : spec.label)} aria-pressed={on} data-tip="Draw the airflow on the model">
        {on ? <Icon.Eye size={13} /> : <Icon.EyeOff size={13} />} on model
      </button>
      <Segmented<SurfaceShown>
        id="air-surface"
        value={surface}
        onChange={(v) => set({ surface: v })}
        options={[
          { value: "cp", label: "pressure", title: "Colour the surface by pressure: red where the air pushes, blue where it pulls" },
          { value: "cf", label: "friction", title: "Colour the surface by skin friction" },
          { value: "none", label: "plain", title: "The parts as they are" },
        ]}
      />
      <button className={`an-toggle ${lines ? "on" : ""}`} onClick={() => toggle("lines", lines)} aria-pressed={lines} data-tip="Streamlines from upstream, coloured by speed">
        streamlines
      </button>
      <button className={`an-toggle ${wake ? "on" : ""}`} onClick={() => toggle("wake", wake)} aria-pressed={wake} data-tip="The wake: where the air has lost all its total pressure">
        wake
      </button>
      <button className={`an-toggle ${vortices ? "on" : ""}`} onClick={() => toggle("vortices", vortices)} aria-pressed={vortices} data-tip="Eddies at the end of the run (Q-criterion)">
        eddies
      </button>
      <select className="input sm" value={slice} aria-label="Cut through the flow" onChange={(e) => set({ slice: e.target.value as typeof slice })} data-tip="A cut through the averaged flow, coloured by speed">
        <option value="off">no cut</option>
        <option value="side">side cut</option>
        <option value="top">top cut</option>
        <option value="front">front cut</option>
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
        <button className="btn sm" onClick={() => stopAirflow(spec.label)} data-tip="Stop this run (the last result stays)">
          <Icon.X size={12} /> stop
        </button>
      ) : null}
      {run?.status === "waiting" && (
        <button className="btn sm" onClick={() => startAirflowNow()} data-tip="Start now instead of waiting for the design to settle">
          <Icon.Play size={12} /> run now
        </button>
      )}
    </div>
  );
}

export function AirflowView({ spec, run }: { spec: AirflowSpec; run?: AirflowRun }) {
  const r = run?.result;
  const versions = useAirflow((s) => s.versions.get(spec.label));
  const busy = run?.status === "running" || run?.status === "waiting";
  return (
    <>
      {busy && <Live run={run!} updating={!!r} />}
      {run?.status === "error" && run.error !== "Stopped." && (
        <div className="an-box" style={{ marginBottom: 12, borderColor: "rgb(var(--fail-rgb) / 0.4)", background: "var(--fail-soft)" }}>
          <div className="an-note" style={{ color: "var(--fail-ink)" }}>
            <Icon.Alert size={15} />
            <div className="grow">
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{run.setup ? "This set-up can't run as written" : "The airflow run did not finish"}</div>
              {run.error}
            </div>
            <button className="btn sm" onClick={() => revealSpan(spec.span)}>
              <Icon.Code size={13} /> Show in code
            </button>
          </div>
        </div>
      )}
      {r && <Cards spec={spec} r={r} />}
      {r && r.yaws.length > 1 && <YawBox r={r} />}
      <div className="an-cols">
        <div>
          {r && <PartsBox r={r} />}
          <SetupBox spec={spec} r={r} />
        </div>
        <div>
          {versions && versions.length > 1 && <VersionsBox versions={versions} />}
          {r && <SettleBox r={r} />}
          {r && <NotesBox r={r} />}
        </div>
      </div>
    </>
  );
}

/** The run's progress, with the flow on a plane through the design as it develops. */
function Live({ run, updating }: { run: AirflowRun; updating: boolean }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(t);
  }, []);
  const ref = useRef<HTMLCanvasElement>(null);
  const s = run.progress?.slice;
  useEffect(() => {
    const c = ref.current;
    if (!c || !s) return;
    c.width = s.w;
    c.height = s.h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(s.w, s.h);
    for (let j = 0; j < s.h; j++)
      for (let i = 0; i < s.w; i++) {
        const v = s.data[i + s.w * j];
        // rows go up the tunnel; the canvas goes down
        const k = 4 * (i + s.w * (s.h - 1 - j));
        if (v < 0) {
          img.data[k + 3] = 255;
          continue;
        }
        const col = speedColor(v);
        img.data[k] = col[0] * 255;
        img.data[k + 1] = col[1] * 255;
        img.data[k + 2] = col[2] * 255;
        img.data[k + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
  }, [s]);
  const secs = Math.max(0, (now - run.startedAt) / 1000);
  const p = run.progress;
  return (
    <div className="an-box" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 10 }}>
        <span className="spinner" />
        <span style={{ fontSize: 12.5 }}>{updating ? "Re-running the airflow for your latest change" : "Running the airflow"}</span>
        <span className="mono dim" style={{ fontSize: 11 }}>
          {run.status === "waiting" ? "waiting for the design to settle" : run.stage.toLowerCase()}
          {p?.yaw !== undefined ? ` · yaw ${fmtNum(p.yaw, 1)}°` : ""}
          {p?.drag !== undefined ? ` · drag ${fmtNum(p.drag, 2)} N` : ""}
          {p?.cda !== undefined ? ` · CdA ${fmtNum(p.cda, 3)} m²` : ""}
          {p?.mlups ? ` · ${fmtNum(p.mlups, 0)} M cells/s` : ""} · {fmtNum(secs, 0)} s
        </span>
      </div>
      <div className="an-progress">
        <div style={{ width: `${Math.round(run.frac * 100)}%` }} />
      </div>
      {s && <canvas ref={ref} className="an-flow" aria-label="Air speed on a plane through the design, as the run goes" />}
    </div>
  );
}

function Cards({ spec, r }: { spec: AirflowSpec; r: AirflowResult }) {
  const cda = yawMean(r, (y) => y.cda);
  const drag = yawMean(r, (y) => y.drag);
  const watts = yawMean(r, (y) => y.watts);
  const side = yawMean(r, (y) => Math.abs(y.side));
  const lift = yawMean(r, (y) => y.lift);
  const st = (ok: boolean | undefined) => (ok === undefined ? "" : ok ? "pass" : "fail");
  const many = r.yaws.length > 1;
  return (
    <div className="an-grid" style={{ marginBottom: 12 }}>
      <div className={`an-stat ${st(spec.maxCda === undefined ? undefined : cda <= spec.maxCda)}`}>
        <div className="k">Drag area {many ? "(mean)" : ""}</div>
        <div className="v">
          {fmtNum(cda, 3)}
          <small>m² CdA</small>
        </div>
        <div className="s">{spec.maxCda !== undefined ? `target ${fmtNum(spec.maxCda, 3)} m² · ` : ""}Cd {fmtNum(yawMean(r, (y) => y.cd), 3)} on {fmtNum(yawMean(r, (y) => y.area), 3)} m² frontal</div>
      </div>
      <div className={`an-stat ${st(spec.maxDrag === undefined ? undefined : drag <= spec.maxDrag)}`}>
        <div className="k">Drag</div>
        <div className="v">
          {fmtNum(drag, 1)}
          <small>N</small>
        </div>
        <div className="s">at {fmtNum(r.speed * 3.6, 0)} km/h of air</div>
      </div>
      <div className={`an-stat ${st(spec.maxWatts === undefined ? undefined : watts <= spec.maxWatts)}`}>
        <div className="k">Power against the air</div>
        <div className="v">
          {fmtNum(watts, 0)}
          <small>W</small>
        </div>
        <div className="s">drag × road speed</div>
      </div>
      <div className="an-stat">
        <div className="k">{many ? "Side force (mean)" : "Side force"}</div>
        <div className="v">
          {fmtNum(side, 1)}
          <small>N</small>
        </div>
        <div className="s">
          {lift < 0 ? `${fmtNum(-lift, 1)} N downforce` : `${fmtNum(lift, 1)} N lift`}
        </div>
      </div>
    </div>
  );
}

/** Drag area against yaw, with the side force: how the design does in a crosswind. */
function YawBox({ r }: { r: AirflowResult }) {
  const yawIdx = useAirflow((s) => s.yaw);
  const ys = r.yaws;
  const lo = Math.min(...ys.map((y) => y.yaw));
  const hi = Math.max(...ys.map((y) => y.yaw));
  const cmax = Math.max(...ys.map((y) => y.cda)) * 1.08;
  const cmin = Math.min(...ys.map((y) => y.cda)) * 0.92;
  const X = (yaw: number) => 6 + ((yaw - lo) / Math.max(1e-9, hi - lo)) * 88;
  const Y = (c: number) => 46 - ((c - cmin) / Math.max(1e-9, cmax - cmin)) * 40;
  const pts = ys.map((y) => `${X(y.yaw).toFixed(2)},${Y(y.cda).toFixed(2)}`).join(" ");
  return (
    <div className="an-box" style={{ marginBottom: 12 }}>
      <h4>Yaw sweep</h4>
      <div className="an-cols">
        <svg className="an-spark" viewBox="0 0 100 54" preserveAspectRatio="none" aria-label="Drag area against yaw angle">
          <polyline points={pts} fill="none" stroke="var(--accent-2)" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
          {ys.map((y, i) => (
            <circle key={i} cx={X(y.yaw)} cy={Y(y.cda)} r={i === yawIdx ? 2.2 : 1.4} fill={i === yawIdx ? "var(--accent)" : "var(--accent-2)"} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        <table className="an-table">
          <thead>
            <tr>
              <th>yaw</th>
              <th>CdA m²</th>
              <th>drag N</th>
              <th>side N</th>
              <th>W</th>
            </tr>
          </thead>
          <tbody>
            {ys.map((y, i) => (
              <tr key={i} className={`an-mode ${i === yawIdx ? "active" : ""}`} style={{ cursor: "pointer" }} onClick={() => useAirflow.setState({ yaw: i })} aria-pressed={i === yawIdx}>
                <td className="mono">{fmtNum(y.yaw, 1)}°</td>
                <td className="mono">
                  {fmtNum(y.cda, 4)}
                  {!y.converged && <span className="warn"> ±{fmtNum((100 * y.stderr) / Math.max(1e-9, y.drag), 1)}%</span>}
                </td>
                <td className="mono">{fmtNum(y.drag, 2)}</td>
                <td className="mono">{fmtNum(y.side, 2)}</td>
                <td className="mono">{fmtNum(y.watts, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Which parts carry the drag at the yaw shown, as bars, with how much of it is skin friction. */
function PartsBox({ r }: { r: AirflowResult }) {
  const yawIdx = useAirflow((s) => s.yaw);
  const y = r.yaws[Math.min(yawIdx, r.yaws.length - 1)];
  const parts = useMemo(() => [...y.parts].sort((a, b) => b.drag - a.drag).slice(0, 14), [y]);
  const top = Math.max(1e-9, ...parts.map((p) => p.drag));
  const total = y.parts.reduce((a, p) => a + p.drag, 0) || 1;
  return (
    <div className="an-box">
      <h4>
        Drag by part
        <div className="grow" />
        <span className="mono dim" style={{ fontSize: 10.5 }}>
          at {fmtNum(y.yaw, 1)}°
        </span>
      </h4>
      {parts.map((p) => (
        <div key={p.id} className="an-bar-row" data-tip={`${fmtNum(p.cda, 4)} m² CdA · ${fmtNum(100 * p.friction, 0)} % skin friction`}>
          <span className="an-bar-name">{p.name}</span>
          <span className="an-bar">
            <span style={{ width: `${Math.max(0, (100 * p.drag) / top)}%` }} />
          </span>
          <span className="mono dim">{fmtNum((100 * p.drag) / total, 1)} %</span>
        </div>
      ))}
    </div>
  );
}

function VersionsBox({ versions }: { versions: AirflowVersion[] }) {
  const vals = versions.map((v) => mean(v.yaws.map((y) => y.cda)));
  const lo = Math.min(...vals) * 0.97;
  const hi = Math.max(...vals) * 1.03;
  const pts = vals.map((c, i) => `${(4 + (i / Math.max(1, vals.length - 1)) * 92).toFixed(2)},${(48 - ((c - lo) / Math.max(1e-9, hi - lo)) * 42).toFixed(2)}`).join(" ");
  return (
    <div className="an-box">
      <h4>Versions</h4>
      <svg className="an-spark" viewBox="0 0 100 54" preserveAspectRatio="none" aria-label="Drag area of each version">
        <polyline points={pts} fill="none" stroke="var(--accent-2)" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
      </svg>
      <table className="an-table">
        <tbody>
          {versions
            .map((v, i) => ({ v, i, c: vals[i] }))
            .reverse()
            .map(({ v, i, c }) => {
              const d = i ? (c - vals[i - 1]) / vals[i - 1] : 0;
              return (
                <tr key={v.at}>
                  <td className="mono">{i + 1}</td>
                  <td className="mono">{fmtNum(c, 4)} m²</td>
                  <td className={`mono ${i ? (d < 0 ? "pass" : "fail") : "dim"}`}>{i ? `${d < 0 ? "−" : "+"}${fmtNum(Math.abs(d) * 100, 1)} %` : ""}</td>
                  <td className="dim">{v.note}</td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}

/** The drag through the averaging, at the yaw shown. */
function SettleBox({ r }: { r: AirflowResult }) {
  const yawIdx = useAirflow((s) => s.yaw);
  const y = r.yaws[Math.min(yawIdx, r.yaws.length - 1)];
  const pts = useMemo(() => {
    const h = y.history;
    if (h.length < 2) return "";
    const lo = Math.min(...h);
    const hi = Math.max(...h);
    return h.map((v, i) => `${((i / (h.length - 1)) * 100).toFixed(2)},${(4 + ((hi - v) / Math.max(1e-9, hi - lo)) * 46).toFixed(2)}`).join(" ");
  }, [y]);
  return (
    <div className="an-box">
      <h4>
        Settling
        <div className="grow" />
        <span className={`chip ${y.converged ? "pass" : "warn"}`} style={{ height: 18, letterSpacing: 0, textTransform: "none" }}>
          {y.converged ? `±${fmtNum((100 * y.stderr) / Math.max(1e-9, y.drag), 1)} %` : "not settled"}
        </span>
      </h4>
      {pts && (
        <svg className="an-spark" viewBox="0 0 100 54" preserveAspectRatio="none" aria-label="Drag through the averaging">
          <polyline points={pts} fill="none" stroke="var(--accent-2)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      <div className="mono dim" style={{ fontSize: 10.5, marginTop: 4 }}>
        drag while averaging · {y.steps.toLocaleString()} steps in {fmtNum(y.seconds, 0)} s · wall y+ about {fmtNum(y.yPlus, 0)}
      </div>
    </div>
  );
}

function SetupBox({ spec, r }: { spec: AirflowSpec; r?: AirflowResult }) {
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
          <span className="tag">air</span>
          {fmtNum(spec.speed * 0.0036, 1)} km/h, {fmtNum(spec.density, 3)} kg/m³, travelling along {v3(spec.forward)}
        </div>
        <div>
          <span className="tag">yaw</span>
          {spec.yaw.map((y) => `${fmtNum(y, 1)}°`).join(", ")} (positive: wind from the right)
        </div>
        <div>
          <span className="tag">parts</span>
          {spec.parts.length ? spec.parts.join(", ") : "every part shown"}
        </div>
        <div>
          <span className="tag">road</span>
          {spec.ground ? "rolling road, wheels spinning with it" : "none: free air all round"}
        </div>
        {spec.rider && (
          <div>
            <span className="tag">rider</span>
            standard rider, {spec.rider.position}, {fmtNum(spec.rider.height / 10, 0)} cm tall
          </div>
        )}
        <div>
          <span className="tag">cells</span>
          {r ? `${fmtNum(r.h, 1)} mm, ${fmtNum(r.cells / 1e6, 1)} million close up (${r.dims.join(" × ")}) on the ${r.backend === "gpu" ? `GPU${r.adapter ? `, ${r.adapter}` : ""}` : "CPU"}` : typeof spec.resolution === "string" ? spec.resolution : `${spec.resolution.h} mm`}
        </div>
      </div>
    </div>
  );
}

function NotesBox({ r }: { r: AirflowResult }) {
  return (
    <div className="an-box">
      <h4>What to keep in mind</h4>
      {r.warnings.map((w, i) => (
        <div key={i} className="an-note">
          <Icon.Alert size={13} style={{ color: "var(--warn)" }} />
          <span>{w}</span>
        </div>
      ))}
      <div className="an-note">
        <Icon.Info size={13} style={{ color: "var(--text-3)" }} />
        <span className="dim">
          Lattice-Boltzmann large-eddy simulation at Reynolds number {fmtNum(r.reynolds / 1e6, 2)} million: the eddies bigger than about two cells are resolved, smaller ones and the thin boundary layer on the surface are modelled (Smagorinsky and a log-law wall model). Separation on smooth curved surfaces and the drag crisis of round tubes are the least certain parts. Use it to compare versions and find where the drag comes from; confirm a final design in a wind tunnel or on the road.
          {r.blockage > 0.02 ? ` The tunnel's walls block ${fmtNum(r.blockage * 100, 1)} % of the flow, which raises the drag a little.` : ""}
        </span>
      </div>
    </div>
  );
}
