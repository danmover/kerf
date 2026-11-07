// PMI in the viewport: each made part's drawing dimensions, fits, datums
// and geometric tolerances shown on the 3D model (model-based definition),
// for the selected parts or, with nothing selected, every part. A card
// switches dimensions and GD&T on and off and exports STEP with the same
// PMI. The annotations come from each part's drawing, so editing the
// drawing (or its block's tol() and gdt()) changes them.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { SceneController } from "./viewport/scene";
import { PmiOverlay } from "./viewport/pmiOverlay";
import { useDesign } from "../core/engine";
import { useView } from "../app/view";
import { useTheme } from "../app/theme";
import { modelPmi } from "../drawing/engine";
import { pmiSummary } from "../drawing/pmi";
import { exportStepWithPmi } from "../app/exports";
import { Icon } from "./icons";

export const usePmiView = create<{ on: boolean; dims: boolean; gdt: boolean }>(() => ({ on: false, dims: true, gdt: true }));

export function togglePmi(on = !usePmiView.getState().on) {
  usePmiView.setState({ on });
}

export function PmiButton() {
  const on = usePmiView((s) => s.on);
  return (
    <button className={`icon-btn ${on ? "active" : ""}`} onClick={() => togglePmi()} data-tip="PMI: drawing dimensions, fits and tolerances on the 3D model" aria-label="PMI on the model" aria-pressed={on}>
      <Icon.Dimension />
    </button>
  );
}

export function PmiLayer({ scene }: { scene: SceneController }) {
  const { on, dims, gdt } = usePmiView();
  const model = useDesign((s) => s.model);
  const meshVersion = useDesign((s) => s.meshVersion);
  const selected = useView((s) => s.selected);
  const theme = useTheme();
  const pmi = useMemo(() => {
    if (!on || !model) return [];
    try {
      return modelPmi(model, selected.length ? selected : undefined);
    } catch {
      return [];
    }
    // meshVersion: parts' solids coming in
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, model, meshVersion, selected]);

  useEffect(() => {
    if (!on || !pmi.length) return;
    const o = new PmiOverlay(pmi, theme, { dims, gdt });
    scene.addOverlay(o);
    scene.requestRender();
    return () => {
      scene.removeOverlay(o);
      o.dispose();
      scene.requestRender();
    };
  }, [on, pmi, theme, dims, gdt, scene]);

  // a new design leaves it on; a design with nothing to show says so on the card
  const one = pmi.length === 1 ? pmi[0] : null;
  return (
    <AnimatePresence>
      {on && (
        <motion.div
          key="pmi"
          className="vp-float"
          style={{ left: 14, top: 100, maxWidth: "calc(100% - 28px)", padding: "6px 8px" }}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          role="status"
        >
          <div className="row" style={{ gap: 6 }}>
            <span
              className="field-label"
              style={{ margin: "0 4px 0 0", whiteSpace: "nowrap" }}
              data-tip={
                one
                  ? `${one.name}: ${pmiSummary(one)}. From its drawing: change it there.`
                  : pmi.length
                    ? `From each part's drawing${selected.length ? ", for the selected parts" : ""}. Select a part to see just its own.`
                    : "Made parts get PMI from their drawings once they are built. Bought parts and drawings with pmi: false have none."
              }
            >
              PMI · {pmi.length ? (one ? one.name : `${pmi.length} parts`) : "none here"}
            </span>
            <button className={`btn sm ${dims ? "active" : "ghost"}`} aria-pressed={dims} onClick={() => usePmiView.setState({ dims: !dims })}>
              Dimensions
            </button>
            <button className={`btn sm ${gdt ? "active" : "ghost"}`} aria-pressed={gdt} onClick={() => usePmiView.setState({ gdt: !gdt })}>
              GD&amp;T
            </button>
            <button className="btn sm ghost" disabled={!pmi.length} onClick={() => void exportStepWithPmi(selected.length > 0)} data-tip="Export STEP AP242 with this PMI tied to the faces">
              <Icon.Download size={13} /> STEP
            </button>
            <button className="icon-btn sm" onClick={() => togglePmi(false)} aria-label="Close PMI">
              <Icon.X size={14} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
