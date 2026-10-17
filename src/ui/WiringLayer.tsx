// The 3D wiring in the viewport: owns the wiring overlay while it is shown,
// keeps its cable routes current, and draws the card for the picked cable
// with a tag at each of its plugs, so you can see what plugs into what.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SceneController } from "./viewport/scene";
import { WiringOverlay, type WireHit } from "./viewport/wiring/overlay";
import { meshes, useDesign } from "../core/engine";
import { select } from "../app/view";
import { useHarness, updateHarness } from "../machine/harness/runtime";
import { PLUG_NAME } from "../machine/harness/plugs";
import { leadLength, type HarnessWire, type PlugEnd } from "../machine/harness/harness";
import { cutLength } from "../machine/wiring";
import { useWiringView } from "./wiringView";
import { useChatDraft } from "./chatDraft";
import { Icon } from "./icons";
import "../styles/wiring.css";

export function WiringLayer({ scene }: { scene: SceneController }) {
  const on = useWiringView((s) => s.on);
  const picked = useWiringView((s) => s.picked);
  const hovered = useWiringView((s) => s.hovered);
  const model = useDesign((s) => s.model);
  const stage = useDesign((s) => s.stage);
  const meshVersion = useDesign((s) => s.meshVersion);
  const harness = useHarness((s) => s.harness);
  const routes = useHarness((s) => s.routes);
  const status = useHarness((s) => s.status);
  const ov = useRef<WiringOverlay | null>(null);
  const [drawn, setDrawn] = useState(0);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!on) return;
    const o = new WiringOverlay(scene);
    o.onPick = (hit: WireHit | null) => {
      if (hit) select([]);
      useWiringView.setState({ picked: hit?.wire ?? null, end: hit?.end ?? null });
    };
    o.onHover = (hit: WireHit | null) => useWiringView.setState({ hovered: hit?.wire ?? null });
    ov.current = o;
    scene.addOverlay(o);
    return () => {
      scene.removeOverlay(o);
      o.dispose();
      if (ov.current === o) ov.current = null;
      useWiringView.setState({ hovered: null });
    };
  }, [on, scene]);

  // route once the solids are built, and again when the design changes
  useEffect(() => {
    if (!on || !model || (stage !== "done" && stage !== "refining")) return;
    const t = setTimeout(() => updateHarness(model), 150);
    return () => clearTimeout(t);
  }, [on, model, meshVersion, stage]);

  useEffect(() => {
    const o = ov.current;
    if (!o || !harness || !model) return;
    o.set(harness, routes, model.parts, (p) => meshes.get(p.hash)?.bbox);
    scene.overlaysChanged();
    setDrawn((n) => n + 1);
    // the model is read when the harness changes, not on every model update in between
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harness, routes, on, scene]);

  useEffect(() => ov.current?.setFocus(picked, hovered), [picked, hovered, drawn]);

  // a picked cable that is gone from the design (an edit removed it) is let go
  useEffect(() => {
    if (picked && harness && !harness.wires.some((w) => w.id === picked)) useWiringView.setState({ picked: null, end: null });
  }, [picked, harness]);

  // the pointer, for the hover tag
  useEffect(() => {
    if (!on) return;
    const el = scene.renderer.domElement;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      setTip({ x: e.clientX - r.left, y: e.clientY - r.top });
    };
    const leave = () => setTip(null);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, [on, scene]);

  const wire = picked ? harness?.wires.find((w) => w.id === picked) : undefined;
  const hover = hovered && hovered !== picked ? harness?.wires.find((w) => w.id === hovered) : undefined;
  const route = wire ? routes?.get(wire.id) : undefined;
  // plug to plug: the routed run plus the lead out of each plug
  const run = wire && route && !route.straight ? route.length + 2 * leadLength(wire) : undefined;
  if (!on) return null;
  return (
    <>
      {wire && <EndTags scene={scene} overlay={ov} wire={wire} />}
      {hover && tip && (
        <div className="wr-tip" style={{ left: tip.x + 14, top: tip.y + 12 }}>
          <b>{hover.id}</b> {endText(hover.ends[0])} → {endText(hover.ends[1])}
        </div>
      )}
      <AnimatePresence>
        {wire && <WireCard key="card" wire={wire} run={run} onClose={() => useWiringView.setState({ picked: null, end: null })} />}
      </AnimatePresence>
      <AnimatePresence>
        {(status === "routing" && !routes) || status === "error" ? (
          <motion.div key="status" className="wr-status" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            {status === "error" ? (
              <>
                <Icon.Alert size={13} /> The cables could not be routed, so they are drawn straight
              </>
            ) : (
              <>
                <span className="spinner sm" aria-hidden /> Routing the cables
              </>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

const endText = (e: PlugEnd) => `${e.comp}.${e.pin}`;

/** A tag at each of the picked cable's plugs, following the camera. */
function EndTags({ scene, overlay, wire }: { scene: SceneController; overlay: React.RefObject<WiringOverlay | null>; wire: HarnessWire }) {
  const refs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  useEffect(() => {
    const place = () => {
      wire.ends.forEach((_, k) => {
        const el = refs[k].current;
        const p = overlay.current?.plugPoint(wire.id, k as 0 | 1);
        if (!el || !p) return;
        const s = scene.toScreen([p.x, p.y, p.z]);
        el.style.transform = `translate(${s.x}px, ${s.y}px)`;
        el.style.visibility = s.front ? "visible" : "hidden";
      });
    };
    place();
    return scene.onRendered(place);
    // refs are stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, overlay, wire]);
  return (
    <>
      {wire.ends.map((e, k) => (
        <div key={k} ref={refs[k]} className="wr-end" aria-hidden>
          <span className="wr-end-dot" />
          <span className="wr-end-tag">
            <b>{e.comp}</b> {e.label !== e.pin ? `${e.pin} · ${e.label}` : e.pin}
          </span>
        </div>
      ))}
    </>
  );
}

function WireCard({ wire, run, onClose }: { wire: HarnessWire; run?: number; onClose: () => void }) {
  const setDraft = useChatDraft((s) => s.set);
  const r = wire.row;
  const title = r.cable ?? (r.label || `${r.kind === "ground" ? "Ground" : r.kind === "power" ? "Power" : r.kind === "motor" ? "Motor" : "Signal"} wire`);
  const colors = useMemo(() => [...new Set(wire.wires.map((w) => w.color))], [wire]);
  const end = (e: PlugEnd, k: number) => (
    <div className="wr-row">
      <span className="wr-k">{k === 0 ? "From" : "To"}</span>
      <span className="wr-v">
        <span className="mono">
          {e.comp}.{e.pin}
        </span>
        {e.label !== e.pin && <span className="wr-lbl"> {e.label}</span>}
        <span className="wr-sub">
          {e.part} · {plugText(e, wire.wires.length)}
        </span>
      </span>
    </div>
  );
  return (
    <motion.div className="vp-float wr-card" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ type: "spring", stiffness: 420, damping: 36 }}>
      <div className="row" style={{ marginBottom: 8, gap: 8 }}>
        <span className="wr-swatches" aria-hidden>
          {colors.map((c) => (
            <span key={c} style={{ background: c }} />
          ))}
        </span>
        <div className="grow wr-title">
          <span className="mono">{wire.id}</span> {title}
        </div>
        <button className="icon-btn sm" onClick={onClose} aria-label="Close">
          <Icon.X size={14} />
        </button>
      </div>
      {end(wire.ends[0], 0)}
      {end(wire.ends[1], 1)}
      <div className="wr-facts mono">
        <div>
          net <span>{r.net}</span>
        </div>
        {!r.cable && (
          <div>
            {r.gauge ?? "?"} AWG {r.color}
            {r.gaugeSuggested || r.colorSuggested ? <span className="dim"> (suggested)</span> : null}
          </div>
        )}
        {wire.wires.length > 1 && <div>{wire.wires.map((w) => w.name).join(", ")}</div>}
        {run !== undefined ? (
          <div>
            cut {cutLength(run)} mm<span className="dim"> · runs {Math.round(run)} mm plug to plug</span>
          </div>
        ) : (
          r.lengthMm !== undefined && (
            <div>
              cut {r.lengthMm} mm<span className="dim"> · estimated</span>
            </div>
          )
        )}
      </div>
      {r.note && <div className="wr-note">{r.note}</div>}
      <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: "wrap" }}>
        <button className="btn sm" onClick={() => setDraft(`About wire ${wire.id} (${endText(wire.ends[0])} to ${endText(wire.ends[1])}): `)} data-tip="Ask Claude about this cable">
          <Icon.Sparkle size={13} /> Ask
        </button>
      </div>
    </motion.div>
  );
}

function plugText(e: PlugEnd, n: number): string {
  const ways = e.spec.ways ?? n;
  const name = PLUG_NAME[e.spec.kind];
  if (["lead", "solder", "lug", "barrel", "xt60", "usb_c", "usb_micro"].includes(e.spec.kind)) return name;
  return ways > 1 ? `${name}, ${ways}-way` : name;
}
