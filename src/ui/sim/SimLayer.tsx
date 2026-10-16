// A simulation run in the viewport: owns the sim overlay while the run is
// shown, plays it back, and draws the playback bar, the readouts and a note
// for each event as playback passes it.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { SceneController } from "../viewport/scene";
import { SimOverlay } from "../viewport/simOverlay";
import { meshes, useDesign } from "../../core/engine";
import { useSettings } from "../../app/settings";
import { useSim } from "../../sim/runtime";
import { duration, valueAt } from "../../sim/frames";
import type { VariantRun } from "../../sim/engine/run";
import type { WorldEvent } from "../../sim/worlds/types";
import { VARIANTS } from "../../sim/worlds/common";
import { fmtNum } from "../../lang/values";
import { Icon } from "../icons";
import { Timeline } from "./SimPanel";
import { EVENT_KIND_LABEL, mmss, useSelectedScenario } from "./simUi";
import "../../styles/sim.css";

type CameraMode = "near" | "whole" | "follow";

const CAMERA_LABEL: Record<CameraMode, string> = { near: "pit bottom", whole: "whole pit", follow: "follow" };

export function SimLayer({ scene }: { scene: SceneController }) {
  const view = useSim((s) => s.view);
  const playing = useSim((s) => s.playing);
  const t = useSim((s) => s.t);
  const { model, def, run, vrun, variant } = useSelectedScenario();
  const meshVersion = useDesign((s) => s.meshVersion);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const ov = useRef<SimOverlay | null>(null);
  const saved = useRef<ReturnType<SceneController["cameraState"]> | null>(null);
  const [camera, setCamera] = useState<CameraMode>("near");
  const lastNose = useRef<THREE.Vector3 | null>(null);
  const shown = view && !!vrun && !!model;
  const end = vrun ? duration(vrun.frames) : 0;
  const screws = useMemo(() => {
    const w = def?.spec.world;
    return w?.kind === "sand_pit" ? w.robot.screws.map((s) => ({ motor: s.motor, from: s.from, to: s.to, d: s.d, turn: s.turn })) : [];
  }, [def]);

  // the overlay: rebuilt when the run, the variant or the design's parts change
  useEffect(() => {
    if (!shown || !vrun || !model) return;
    const o = new SimOverlay(vrun.scene, model.parts, meshes, screws);
    o.setFrames(vrun.frames);
    o.setTime(useSim.getState().t);
    o.setPlaying(useSim.getState().playing && !reduceMotion);
    ov.current = o;
    scene.addOverlay(o);
    scene.invalidate();
    return () => {
      scene.removeOverlay(o);
      o.dispose();
      if (ov.current === o) ov.current = null;
    };
  }, [shown, vrun, model, meshVersion, screws, scene]);

  // entering the simulation frames it; leaving puts the camera back
  const hasBox = !!vrun?.scene.box;
  useEffect(() => {
    if (!shown) return;
    saved.current = scene.cameraState();
    setCamera("near");
    return () => {
      if (saved.current) scene.restoreCamera(saved.current);
      saved.current = null;
    };
  }, [shown, scene]);

  useEffect(() => {
    const o = ov.current;
    if (!shown || !o) return;
    lastNose.current = null;
    if (camera === "near") scene.fit("iso", true, o.frameBox());
    else if (camera === "whole") scene.fit("iso", true, o.frameBox(true));
    else {
      const n = o.nose();
      if (n) scene.fit("current", true, new THREE.Box3(n.clone().addScalar(-450), n.clone().addScalar(450)));
      lastNose.current = n;
    }
  }, [camera, shown, scene]);

  // time and playing go straight to the overlay
  useEffect(() => {
    const o = ov.current;
    if (!o) return;
    o.setTime(t);
    if (camera === "follow") {
      const n = o.nose();
      if (n && lastNose.current) scene.panBy(n.clone().sub(lastNose.current).toArray() as [number, number, number]);
      lastNose.current = n;
    }
    scene.invalidate();
  }, [t, camera, scene, vrun, model, meshVersion]);

  useEffect(() => {
    ov.current?.setPlaying(playing && !reduceMotion);
    scene.invalidate();
  }, [playing, reduceMotion, scene, vrun]);

  // playback: simulated time runs at `speed` times real time and stops at the end
  useEffect(() => {
    if (!playing) return;
    if (!vrun) {
      useSim.setState({ playing: false });
      return;
    }
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const st = useSim.getState();
      const next = st.t + dt * st.speed;
      if (next >= end) {
        useSim.setState({ t: end, playing: false });
        return;
      }
      useSim.setState({ t: next });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, vrun, end]);

  const toast = useEventToast(vrun, t, playing);
  const busy = run?.status === "running" || run?.status === "waiting";

  if (!view) return null;
  if (!vrun || !def) {
    return (
      <div className="simv-bar">
        <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
        <span style={{ fontSize: 12, color: "var(--text-2)", flex: 1 }}>{def ? `Running “${def.label}”…` : "No scenario to show"}</span>
        <button className="icon-btn sm" aria-label="Close the simulation view" onClick={() => useSim.setState({ view: false, playing: false })}>
          <Icon.X size={14} />
        </button>
      </div>
    );
  }

  return (
    <>
      <Readouts v={vrun} t={t} label={def.label} stale={busy} />
      <AnimatePresence>
        {toast && (
          <motion.div key={toast.key} className={`simv-event ${toast.e.kind}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}>
            <span className="mono" style={{ color: "var(--text-3)", marginRight: 8 }}>
              {mmss(toast.e.t)}
            </span>
            {EVENT_KIND_LABEL[toast.e.kind] ? <b style={{ marginRight: 6 }}>{EVENT_KIND_LABEL[toast.e.kind]}</b> : null}
            {toast.e.text}
          </motion.div>
        )}
      </AnimatePresence>
      <motion.div className="simv-bar" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Timeline v={vrun} compact />
        </div>
        <select value={variant} onChange={(e) => useSim.setState({ variant: e.target.value as typeof variant })} aria-label="Which run to show">
          {VARIANTS.filter((n) => run?.result?.variants.some((x) => x.variant === n)).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        {hasBox && (
          <select value={camera} onChange={(e) => setCamera(e.target.value as CameraMode)} aria-label="Camera">
            {(Object.keys(CAMERA_LABEL) as CameraMode[]).map((c) => (
              <option key={c} value={c}>
                {CAMERA_LABEL[c]}
              </option>
            ))}
          </select>
        )}
        <button className="icon-btn sm" aria-label="Close the simulation view" data-tip="Back to the design" onClick={() => useSim.setState({ view: false, playing: false })}>
          <Icon.X size={14} />
        </button>
      </motion.div>
    </>
  );
}

/** The latest event playback passed in the last few seconds of real time. */
function useEventToast(v: VariantRun | undefined, t: number, playing: boolean) {
  const prev = useRef(t);
  const [toast, setToast] = useState<{ e: WorldEvent; key: number } | null>(null);
  useEffect(() => {
    const from = prev.current;
    prev.current = t;
    if (!v || !playing || t <= from) return;
    const passed = v.events.filter((e) => e.t > from && e.t <= t && (e.kind !== "info" || e.text.startsWith("Firmware:")));
    if (!passed.length) return;
    setToast({ e: passed[passed.length - 1], key: performance.now() });
  }, [t, v, playing]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => setToast(null), [v]);
  return toast;
}

function Readouts({ v, t, label, stale }: { v: VariantRun; t: number; label: string; stale: boolean }) {
  const f = v.frames;
  const at = (name: string) => valueAt(f, name, t);
  const state = useMemo(() => {
    let s = "";
    for (const e of v.events) {
      if (e.t > t) break;
      if (e.text.startsWith("Firmware: ")) s = e.text.slice(10);
    }
    return s;
  }, [v, t]);
  const motors = v.summary.motors.map((m) => m.name);
  const battery = Object.keys(f.series).find((n) => n.endsWith(".soc"))?.slice(0, -4);
  const pit = v.scene.box;
  const progress = at("pit.progress");
  const remaining = at("pit.remaining");
  const share = Number.isFinite(progress) && Number.isFinite(remaining) && progress + remaining > 0 ? Math.max(0, progress) / (Math.max(0, progress) + remaining) : NaN;
  const n = (x: number, d = 0) => (Number.isFinite(x) ? fmtNum(x, d) : "–");
  return (
    <motion.div className="simv-hud" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}>
      <div className="title">
        <Icon.Play size={12} /> {label}
        <span className="mono" style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-3)", fontWeight: 400 }}>
          {v.variant}
          {stale ? " · updating" : ""}
        </span>
      </div>
      <div className="state">
        {mmss(t)} {state ? `· ${state}` : ""}
      </div>
      {pit && (
        <>
          <div className="simv-row">
            <span>across the pit</span>
            <b>
              {n(progress)} mm{Number.isFinite(share) ? ` · ${n(share * 100)} %` : ""}
            </b>
          </div>
          <div className="simv-meter">
            <div style={{ width: `${Number.isFinite(share) ? share * 100 : 0}%` }} />
          </div>
          <Row k="off the line" v={`${n(at("pit.offset"))} mm`} />
          <Row k="heading · hinge" v={`${n(at("pit.heading"), 1)}° · ${n(at("pit.hinge"), 1)}°`} />
          <Row k="speed" v={`${n(at("pit.speed"), 2)} mm/s`} />
        </>
      )}
      {motors.map((m) => (
        <Row key={m} k={m} v={`${n(at(`${m}.rpm`))} rpm · ${n(at(`${m}.amps`), 1)} A · ${n(at(`${m}.temp`))} °C`} />
      ))}
      {battery && <Row k={battery} v={`${n(at(`${battery}.soc`))} % · ${n(at(`${battery}.volts`), 1)} V`} />}
    </motion.div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="simv-row">
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}
