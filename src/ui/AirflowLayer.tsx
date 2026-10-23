// Airflow results in the viewport: owns the airflow overlay while an airflow
// analysis is shown (and the live flow while it runs), and draws its legend,
// the yaw picker and the value under the cursor.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { SceneController } from "./viewport/scene";
import { AirflowOverlay, LiveFlowOverlay } from "./viewport/airflowOverlay";
import { showAirflow, useAirflow } from "../analysis/aeroRuntime";
import { gradientCss } from "../analysis/colormap";
import { useSettings } from "../app/settings";
import { fmtNum } from "../lang/values";
import { Icon } from "./icons";
import "../styles/analysis.css";

export function AirflowLayer({ scene }: { scene: SceneController }) {
  const shown = useAirflow((s) => s.shown);
  const run = useAirflow((s) => (s.shown ? s.runs.get(s.shown) : undefined));
  const yawIdx = useAirflow((s) => s.yaw);
  const surface = useAirflow((s) => s.surface);
  const lines = useAirflow((s) => s.lines);
  const wake = useAirflow((s) => s.wake);
  const vortices = useAirflow((s) => s.vortices);
  const slice = useAirflow((s) => s.slice);
  const sliceAt = useAirflow((s) => s.sliceAt);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const result = run?.result;
  const y = result?.yaws[Math.min(yawIdx, (result?.yaws.length ?? 1) - 1)];
  const ov = useRef<AirflowOverlay | null>(null);
  const live = useRef<LiveFlowOverlay | null>(null);
  const [probe, setProbe] = useState<{ x: number; y: number; text: string; part: string } | null>(null);
  const running = run?.status === "running";
  const look = { surface, lines, wake, vortices, slice, sliceAt, animate: !reduceMotion };
  // the overlay is rebuilt when the coloured surface comes or goes (it then draws the parts instead of the solids)
  const coloured = surface !== "none";

  useEffect(() => {
    if (!y) return;
    const o = new AirflowOverlay(y, { ...look });
    ov.current = o;
    scene.addOverlay(o);
    return () => {
      scene.removeOverlay(o);
      o.dispose();
      if (ov.current === o) ov.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [y, scene, coloured]);

  useEffect(() => {
    ov.current?.configure(look);
    scene.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, lines, wake, vortices, slice, sliceAt, reduceMotion, scene, y]);

  // the live flow while a run goes, until its first result arrives
  const slicePic = running ? run?.progress?.slice : undefined;
  useEffect(() => {
    if (!slicePic || !shown) return;
    if (!live.current) {
      live.current = new LiveFlowOverlay();
      scene.addOverlay(live.current);
    }
    live.current.update(slicePic);
    scene.invalidate();
  }, [slicePic, shown, scene]);
  useEffect(() => {
    if (running && shown) return;
    if (live.current) {
      scene.removeOverlay(live.current);
      live.current.dispose();
      live.current = null;
      scene.invalidate();
    }
  }, [running, shown, scene]);

  useEffect(() => {
    if (!y) return;
    const el = scene.renderer.domElement;
    let pending: PointerEvent | null = null;
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return setProbe(null);
      if (!pending)
        requestAnimationFrame(() => {
          const ev = pending;
          pending = null;
          if (!ev || !ov.current) return;
          const hit = ov.current.probe(scene.raycasterAt(ev.clientX, ev.clientY));
          const rect = el.getBoundingClientRect();
          setProbe(hit ? { x: ev.clientX - rect.left, y: ev.clientY - rect.top, ...hit } : null);
        });
      pending = e;
    };
    const onLeave = () => setProbe(null);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      setProbe(null);
    };
  }, [y, scene]);

  const showLegend = !!shown && (!!y || !!slicePic);
  return (
    <>
      <AnimatePresence>
        {showLegend && (
          <motion.div key="air-legend" className="vp-float res-legend" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}>
            <div className="row" style={{ gap: 8, marginBottom: 6 }}>
              <span className="res-legend-title">{y && surface !== "none" ? (surface === "cp" ? "Pressure (Cp)" : "Skin friction") : "Air speed"}</span>
              {y && result && result.yaws.length > 1 && (
                <select className="input sm mono" value={yawIdx} aria-label="Yaw angle" onChange={(e) => useAirflow.setState({ yaw: Number(e.target.value) })}>
                  {result.yaws.map((r, i) => (
                    <option key={i} value={i}>
                      {fmtNum(r.yaw, 1)}°
                    </option>
                  ))}
                </select>
              )}
              <div className="grow" />
              {running && <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} aria-label="Running" />}
              <button className="icon-btn sm" onClick={() => showAirflow(null)} aria-label="Hide airflow" data-tip="Hide the airflow">
                <Icon.X size={13} />
              </button>
            </div>
            {y && surface === "cp" ? (
              <>
                <div className="res-bar" style={{ background: gradientCss("diverging", 12) }} />
                <div className="res-ticks">
                  <span style={{ left: "0%" }}>−1 suction</span>
                  <span style={{ left: "50%" }}>0</span>
                  <span style={{ left: "100%" }}>+1 stopped</span>
                </div>
              </>
            ) : (
              <>
                <div className="res-bar" style={{ background: gradientCss("sequential", 12) }} />
                <div className="res-ticks">
                  <span style={{ left: "0%" }}>{y && surface === "cf" ? "none" : "still"}</span>
                  <span style={{ left: "66.7%" }}>{y && surface === "cf" ? "" : "1×"}</span>
                  <span style={{ left: "100%" }}>{y && surface === "cf" ? "most" : "1.5× wind"}</span>
                </div>
              </>
            )}
            <div className="res-meta mono">
              {shown}
              {y ? ` · CdA ${fmtNum(y.cda, 3)} m² · ${fmtNum(y.drag, 1)} N at ${fmtNum(y.yaw, 1)}°` : run?.progress?.drag !== undefined ? ` · ${run.stage.toLowerCase()} · ${fmtNum(run.progress.drag, 1)} N so far` : ""}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {probe && y && (
        <div className="res-probe" style={{ left: probe.x + 14, top: probe.y + 12 }}>
          <b>{probe.text}</b> <span>{probe.part}</span>
        </div>
      )}
    </>
  );
}
