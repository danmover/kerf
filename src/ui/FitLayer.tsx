// "How it goes on" in the viewport: plays the design being put together by
// hand (bands hooked on and stretched over their pins, a part clicked in) and
// then what keeps it there under each analysis's loads, with a card that
// says what each step does and the real stretch, force and grip as it goes.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { create } from "zustand";
import type { SceneController } from "./viewport/scene";
import { FitOverlay, type FitProgress } from "./viewport/fitOverlay";
import { meshes, useDesign } from "../core/engine";
import { xformMatrix } from "../kernel/recipe";
import { useAnalysis } from "../analysis/runtime";
import { fittingSteps } from "../analysis/fitting";
import { useSettings } from "../app/settings";
import { Icon } from "./icons";

/** on: playing or showing its last step; n: bumped to play again from the start */
export const useFitView = create<{ on: boolean; n: number }>(() => ({ on: false, n: 0 }));

export function playFitting() {
  useFitView.setState((s) => ({ on: true, n: s.n + 1 }));
}

export function FitLayer({ scene }: { scene: SceneController }) {
  const on = useFitView((s) => s.on);
  const n = useFitView((s) => s.n);
  const [prog, setProg] = useState<FitProgress | null>(null);
  const ov = useRef<FitOverlay | null>(null);

  // the steps are read when it starts: a replay picks up analyses that have finished since
  useEffect(() => {
    const model = useDesign.getState().model;
    if (!on || !model) return;
    const steps = fittingSteps(model, (p) => meshes.get(p.hash)?.bbox);
    if (!steps.length) {
      useFitView.setState({ on: false });
      return;
    }
    const o = new FitOverlay(scene, steps, useSettings.getState().reduceMotion, (label) => useAnalysis.getState().runs.get(label)?.result);
    // close in on the part going on, from the side the first band starts on and a little above
    const seat = steps.find((s) => s.kind === "seat");
    const band = steps.find((s) => s.kind === "band");
    const held = seat && model.parts.find((p) => p.id === seat.part);
    const box = held && meshes.get(held.hash)?.bbox;
    if (box && held) {
      const b = new THREE.Box3(new THREE.Vector3(...box[0]), new THREE.Vector3(...box[1])).applyMatrix4(new THREE.Matrix4().fromArray(xformMatrix(held.xf))).expandByScalar(45);
      let dir: THREE.Vector3 | undefined;
      if (band?.kind === "band" && band.layout.hooks.length === 2) {
        const [a, c] = band.layout.hooks.map((h) => new THREE.Vector3(...h.at));
        const side = a.clone().sub(c).normalize();
        dir = side.multiplyScalar(0.8).addScaledVector(new THREE.Vector3(...band.layout.u), -0.45).add(new THREE.Vector3(0, 0, 0.5)).normalize();
      }
      scene.fit("current", true, b, dir);
    }
    o.onProgress = setProg;
    ov.current = o;
    scene.addOverlay(o);
    scene.requestRender();
    return () => {
      scene.removeOverlay(o);
      o.dispose();
      if (ov.current === o) ov.current = null;
      setProg(null);
    };
  }, [on, n, scene]);

  // a new design stops it
  const model = useDesign((s) => s.model);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    useFitView.setState({ on: false });
  }, [model]);

  return (
    <AnimatePresence>
      {on && prog && (
        <motion.div
          key="fit"
          className="vp-float"
          style={{ left: "50%", bottom: 20, x: "-50%", width: 440, maxWidth: "calc(100% - 32px)" }}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          role="status"
          aria-live="polite"
        >
          <div className="row" style={{ gap: 8, marginBottom: 6 }}>
            <span className="field-label" style={{ margin: 0 }}>
              How it goes on · {prog.index + 1} of {prog.count}
            </span>
            <div className="grow" />
            <button className="btn sm ghost" onClick={playFitting} data-tip="Play it again from the start">
              <Icon.Refresh size={13} /> Replay
            </button>
            <button className="icon-btn sm" onClick={() => useFitView.setState({ on: false })} aria-label="Close">
              <Icon.X size={14} />
            </button>
          </div>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{prog.title}</div>
          <div className="dim" style={{ lineHeight: 1.45 }}>
            {prog.caption}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
