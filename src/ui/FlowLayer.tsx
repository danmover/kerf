// Flow and cooling results in the viewport: owns the flow overlay while a flow analysis is shown, and draws its
// legend (temperature, and air speed when the air is coloured by it) and the value under the cursor. Showing a flow
// hides any airflow or structural result drawn on the same parts, and the other way round.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { SceneController } from "./viewport/scene";
import { FlowOverlay, flowScales, type FlowScales } from "./viewport/flowOverlay";
import { showFlow, useFlow } from "../analysis/flowRuntime";
import { flowHottest } from "../analysis/flowSummary";
import { showAirflow, useAirflow } from "../analysis/aeroRuntime";
import { showResults, useAnalysis } from "../analysis/runtime";
import { gradientCss } from "../analysis/colormap";
import { useSettings } from "../app/settings";
import { fmtNum } from "../lang/values";
import { Icon } from "./icons";
import "../styles/analysis.css";

export function FlowLayer({ scene }: { scene: SceneController }) {
  const shown = useFlow((s) => s.shown);
  const run = useFlow((s) => (s.shown ? s.runs.get(s.shown) : undefined));
  const surface = useFlow((s) => s.surface);
  const xray = useFlow((s) => s.xray);
  const lines = useFlow((s) => s.lines);
  const colour = useFlow((s) => s.colour);
  const slice = useFlow((s) => s.slice);
  const sliceAt = useFlow((s) => s.sliceAt);
  const airShown = useAirflow((s) => s.shown);
  const resShown = useAnalysis((s) => s.shown);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const result = run?.result;
  const ov = useRef<FlowOverlay | null>(null);
  const [probe, setProbe] = useState<{ x: number; y: number; text: string; part: string } | null>(null);
  const look = { surface, xray, lines, colour, slice, sliceAt, animate: !reduceMotion };

  // one result drawn on the parts at a time: the one shown last wins
  const prev = useRef({ shown, airShown, resShown });
  useEffect(() => {
    const p = prev.current;
    prev.current = { shown, airShown, resShown };
    if (shown && shown !== p.shown) {
      if (airShown) showAirflow(null);
      if (resShown) showResults(null);
    } else if (shown && ((airShown && airShown !== p.airShown) || (resShown && resShown !== p.resShown))) showFlow(null);
  }, [shown, airShown, resShown]);

  const drawn = shown ? result : undefined;
  useEffect(() => {
    if (!drawn) return;
    const o = new FlowOverlay(drawn, { ...look });
    ov.current = o;
    scene.addOverlay(o);
    return () => {
      scene.removeOverlay(o);
      o.dispose();
      if (ov.current === o) ov.current = null;
    };
    // the overlay is rebuilt when the coloured parts come or go (it then draws them instead of the solids)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawn, scene, surface]);

  useEffect(() => {
    ov.current?.configure(look);
    scene.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xray, lines, colour, slice, sliceAt, reduceMotion, scene, drawn]);

  useEffect(() => {
    if (!drawn) return;
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
  }, [drawn, scene]);

  const sc = drawn ? flowScales(drawn) : null;
  const hot = drawn ? flowHottest(drawn)[0] : undefined;
  const bySpeed = colour === "speed" && (lines || slice !== "off");
  const byTemp = surface || (colour === "temperature" && (lines || slice !== "off"));
  return (
    <>
      <AnimatePresence>
        {drawn && sc && (
          <motion.div key="flow-legend" className="vp-float res-legend" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}>
            <div className="row" style={{ gap: 8, marginBottom: 6 }}>
              <span className="res-legend-title">{byTemp ? "Temperature" : `${drawn.fluid === "water" ? "Water" : "Air"} speed`}</span>
              <div className="grow" />
              {run?.status === "running" && <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} aria-label="Running" />}
              <button className="icon-btn sm" onClick={() => showFlow(null)} aria-label="Hide the flow" data-tip="Hide the flow">
                <Icon.X size={13} />
              </button>
            </div>
            {byTemp && <TempScale sc={sc} />}
            {byTemp && bySpeed && (
              <div className="res-legend-title" style={{ fontSize: 11, margin: "4px 0 4px" }}>
                {drawn.fluid === "water" ? "Water" : "Air"} speed
              </div>
            )}
            {bySpeed && <SpeedScale sc={sc} />}
            <div className="res-meta mono">
              {shown}
              {hot ? ` · hottest ${hot.name} ${fmtNum(hot.max, 1)} °C` : ""}
              {run?.stale || run?.status === "running" || run?.status === "waiting" ? " · re-running for the latest change" : ""}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {probe && drawn && (
        <div className="res-probe" style={{ left: probe.x + 14, top: probe.y + 12 }}>
          <b>{probe.text}</b> <span>{probe.part}</span>
        </div>
      )}
    </>
  );
}

function TempScale({ sc }: { sc: FlowScales }) {
  return (
    <>
      <div className="res-bar" style={{ background: gradientCss("sequential", 12) }} />
      <div className="res-ticks">
        <span style={{ left: "0%" }}>{fmtNum(sc.tLo, 0)} °C</span>
        <span style={{ left: "50%" }}>{fmtNum((sc.tLo + sc.tHi) / 2, 0)}</span>
        <span style={{ left: "100%" }}>{fmtNum(sc.tHi, 0)} °C</span>
      </div>
    </>
  );
}

function SpeedScale({ sc }: { sc: FlowScales }) {
  return (
    <>
      <div className="res-bar" style={{ background: gradientCss("sequential", 12) }} />
      <div className="res-ticks">
        <span style={{ left: "0%" }}>still</span>
        <span style={{ left: "50%" }}>{fmtNum(sc.vHi / 2, 2)}</span>
        <span style={{ left: "100%" }}>{fmtNum(sc.vHi, 2)} m/s</span>
      </div>
    </>
  );
}
