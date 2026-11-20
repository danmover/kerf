// "Let go" in the 3D view: the design under gravity with hands off. The run
// is the mechanism solver's (sim/mech/letGo), stepped as the view draws, and
// the parts are moved by the poses it gives. What falls here is what the
// gravity and hold checks fail; what stays is what they pass.

import { useEffect } from "react";
import * as THREE from "three";
import { AnimatePresence, motion } from "framer-motion";
import { useProject } from "../app/project";
import { useView } from "../app/view";
import { kernelResult, meshOf, meshes, useDesign } from "../core/engine";
import { massVolume } from "../core/model";
import { materialDensity } from "../library/standards";
import { LetGoRun, letGoLine, planLetGo } from "../sim/mech/letGo";
import { Icon } from "./icons";
import { letGoAgain, toggleLetGo, useLetGo } from "./letGoView";

interface LetGoScene {
  setLetGo(poses: Map<string, THREE.Matrix4> | null): void;
  setMotionAngle(deg: number): void;
}

/** Real time a frame may spend stepping the run, ms: a heavy design runs slower than life instead of dropping frames. */
const FRAME_BUDGET = 9;

export function LetGoLayer({ scene }: { scene: LetGoScene }) {
  const on = useLetGo((s) => s.on);
  const n = useLetGo((s) => s.n);
  const model = useDesign((s) => s.model);
  // the checks' contacts and boxes are what say which parts are held: start once they are in for this design
  const ready = useDesign((s) => s.reportRev === s.rev && (s.stage === "done" || s.stage === "refining"));
  const playing = useView((s) => s.playing);

  // running the mechanism takes the parts back
  useEffect(() => {
    if (playing && useLetGo.getState().on) toggleLetGo(false);
  }, [playing]);
  // and so does another project, or leaving the 3D view
  const project = useProject((s) => s.current?.id);
  useEffect(
    () => () => {
      if (useLetGo.getState().on) toggleLetGo(false);
    },
    [project],
  );

  useEffect(() => {
    if (!on || !model) return;
    const kernel = kernelResult();
    if (!ready || !kernel) {
      useLetGo.setState({ state: "waiting", line: "Waiting for the design to finish building…" });
      return;
    }
    let plan: ReturnType<typeof planLetGo>;
    try {
      plan = planLetGo(model, (h) => meshes.get(h), kernel, meshOf, (p) => massVolume(p, meshes.get(p.hash)?.volume, materialDensity(p.material)));
    } catch (e) {
      plan = { error: e instanceof Error ? e.message : String(e) };
    }
    if (!plan) {
      useLetGo.setState({ state: "none", line: "Nothing here can move or fall: every part is fastened, and nothing turns or slides." });
      return;
    }
    if ("error" in plan) {
      useLetGo.setState({ state: "error", line: `Could not let go: ${plan.error}` });
      return;
    }
    const run = new LetGoRun(plan);
    scene.setMotionAngle(0);
    useLetGo.setState({ state: "running", line: "" });
    const show = () => scene.setLetGo(new Map([...run.poses()].map(([id, m]) => [id, new THREE.Matrix4().fromArray(m)])));
    let raf = 0;
    let last = performance.now();
    let said = "";
    const frame = () => {
      const now = performance.now();
      // a tab that was in the background picks up where it was, not seconds on
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      run.advance(dt, FRAME_BUDGET);
      show();
      const line = letGoLine(run);
      if (run.settled) {
        useLetGo.setState({ state: "settled", line });
        return;
      }
      if (line !== said) {
        said = line;
        useLetGo.setState({ line });
      }
      raf = requestAnimationFrame(frame);
    };
    // the first step poses a raised lift: show that before anything falls
    run.advance(0.001);
    show();
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      scene.setLetGo(null);
    };
  }, [on, n, model, ready, scene]);

  return null;
}

/** The readout under the toolbar while the design is let go. */
export function LetGoCard() {
  const s = useLetGo();
  return (
    <AnimatePresence>
      {s.on && (
        <motion.div className="vp-float vp-letgo" style={{ left: "50%", bottom: 46, x: "-50%" }} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} role="status">
          <div className="row" style={{ gap: 10, alignItems: "center" }}>
            <span className={`vp-letgo-dot ${s.state}`} aria-hidden />
            <div className="col" style={{ gap: 2, minWidth: 0 }}>
              <span className="field-label" style={{ margin: 0 }}>
                Let go · gravity on, hands off
              </span>
              <span className="vp-letgo-line">{s.line || (s.state === "running" ? "Falling…" : "")}</span>
            </div>
            <button className="icon-btn" onClick={() => letGoAgain()} disabled={s.state === "waiting" || s.state === "none"} data-tip="Let go again" aria-label="Let go again">
              <Icon.Refresh size={14} />
            </button>
            <button className="icon-btn" onClick={() => toggleLetGo(false)} data-tip="Put everything back" aria-label="Put everything back">
              <Icon.X size={14} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
