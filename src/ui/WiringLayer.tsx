// The 3D wiring in the viewport: owns the wiring overlay while it is shown,
// keeps its cable routes current, and draws the card for the picked cable
// with a tag at each of its plugs, so you can see what plugs into what. On a
// machine whose parts move, it can run the axes through their travel so the
// cables can be watched flexing in their drag chains and loops. Parts either
// stay solid with the hidden cables showing faintly through them, or covers
// over the wiring fade (the setting is kept).

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SceneController } from "./viewport/scene";
import { WiringOverlay, type WireHit } from "./viewport/wiring/overlay";
import { meshes, useDesign } from "../core/engine";
import { select } from "../app/view";
import { useHarness, updateHarness, wireRun } from "../machine/harness/runtime";
import { PLUG_NAME } from "../machine/harness/plugs";
import type { HarnessWire, PlugEnd } from "../machine/harness/harness";
import type { WiringFindings } from "../machine/harness/clash";
import { travelOffsets, type TravelPlan } from "../machine/harness/travel";
import { cutLength } from "../machine/wiring";
import { useWiringView } from "./wiringView";
import { useChatDraft } from "./chatDraft";
import { useSettings, updateSettings } from "../app/settings";
import { Segmented } from "./common";
import { Icon } from "./icons";
import "../styles/wiring.css";

export function WiringLayer({ scene }: { scene: SceneController }) {
  const on = useWiringView((s) => s.on);
  const picked = useWiringView((s) => s.picked);
  const hovered = useWiringView((s) => s.hovered);
  const link = useWiringView((s) => s.link);
  const travel = useWiringView((s) => s.travel);
  const model = useDesign((s) => s.model);
  const stage = useDesign((s) => s.stage);
  const meshVersion = useDesign((s) => s.meshVersion);
  const harness = useHarness((s) => s.harness);
  const routes = useHarness((s) => s.routes);
  const status = useHarness((s) => s.status);
  const plan = useHarness((s) => s.plan);
  const findings = useHarness((s) => s.findings);
  const solid = useSettings((s) => s.wiringSolid);
  const ov = useRef<WiringOverlay | null>(null);
  const [drawn, setDrawn] = useState(0);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!on) return;
    const o = new WiringOverlay(scene);
    o.onPick = (hit: WireHit | null) => {
      if (hit) select([]);
      useWiringView.setState({ picked: hit?.wire || null, end: hit?.end ?? null, link: hit?.link ?? null });
    };
    o.onHover = (hit: WireHit | null) => useWiringView.setState({ hovered: hit?.wire || null });
    o.setSolid(useSettings.getState().wiringSolid);
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
    o.set(harness, routes, model.parts, (p) => meshes.get(p.hash)?.bbox, plan, findings);
    scene.overlaysChanged();
    setDrawn((n) => n + 1);
    // the model is read when the harness changes, not on every model update in between
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harness, routes, plan, findings, on, scene]);

  useEffect(() => ov.current?.setFocus(picked, hovered, link), [picked, hovered, link, drawn]);

  // solid parts with the cables showing through, or covers faded
  useEffect(() => {
    const o = ov.current;
    if (!o) return;
    o.setSolid(solid);
    scene.overlaysChanged();
  }, [solid, scene, on]);

  // a picked chain or loop that is gone is let go, and so is the travel run without one
  useEffect(() => {
    if (link && !plan?.links.some((l) => l.id === link)) useWiringView.setState({ link: null });
    if (!plan?.links.length && travel) useWiringView.setState({ travel: false });
  }, [link, plan, travel]);

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
  // plug to plug: the routed runs, the lead out of each end, and any run inside a chain or loop
  const run = wire && routes ? wireRun(wire.id) : undefined;
  const flexOf = wire && plan ? plan.links.filter((l) => l.wires.includes(wire.id)) : [];
  if (!on) return null;
  return (
    <>
      {travel && plan && <TravelRun scene={scene} plan={plan} />}
      <div className="wr-travel">
        <Segmented
          id="wiring-look"
          value={solid ? "solid" : "see"}
          onChange={(v) => updateSettings({ wiringSolid: v === "solid" })}
          options={[
            { value: "solid", label: "Solid parts", title: "Every part stays solid; cables behind parts show faintly through them, so you see the whole thing and all its wiring" },
            { value: "see", label: "See-through", title: "Covers and boxes over the wiring fade so the plugs under them show" },
          ]}
        />
        {plan && plan.links.length > 0 && (status === "done" || routes) && (
          <>
            <button className={`btn sm${travel ? " on" : ""}`} onClick={() => useWiringView.setState({ travel: !travel })} data-tip="Move the axes end to end and watch the cables flex">
              {travel ? <Icon.Pause size={13} /> : <Icon.Play size={13} />} {travel ? "Stop" : "Move through travel"}
            </button>
            <span className="wr-axes mono" id="wr-axes" />
          </>
        )}
      </div>
      {wire && <EndTags scene={scene} overlay={ov} wire={wire} />}
      {hover && tip && (
        <div className="wr-tip" style={{ left: tip.x + 14, top: tip.y + 12 }}>
          <b>{hover.id}</b> {endText(hover.ends[0])} → {endText(hover.ends[1])}
        </div>
      )}
      <AnimatePresence>
        {wire && <WireCard key="card" wire={wire} run={run} flex={flexOf.map((l) => l.label)} issues={wireIssues(wire, findings, (id) => model?.parts.find((p) => p.id === id)?.name ?? id)} onClose={() => useWiringView.setState({ picked: null, end: null })} />}
        {!wire && link && plan && <LinkCard key="link" plan={plan} id={link} onClose={() => useWiringView.setState({ link: null })} />}
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

/** Runs the axes back and forth through their whole travel, each at its own pace, while it is mounted. */
function TravelRun({ scene, plan }: { scene: SceneController; plan: TravelPlan }) {
  useEffect(() => {
    const t0 = performance.now();
    // different periods, so the axes reach every combination of their ends in turn
    const period = [3.6, 4.7, 6.1];
    let raf = 0;
    let shown = "";
    const step = () => {
      const t = (performance.now() - t0) / 1000;
      const at = [0, 1, 2].map((k) => {
        const [a, b] = plan.axes.range[k];
        if (!plan.axes.on[k] || b <= a) return plan.axes.s0[k];
        // start where the design shows it and swing end to end
        const mid = (a + b) / 2;
        const half = (b - a) / 2;
        const ph = Math.asin(Math.max(-1, Math.min(1, (plan.axes.s0[k] - mid) / half)));
        return mid + half * Math.sin(ph + (t * Math.PI * 2) / period[k]);
      }) as [number, number, number];
      scene.setPose(travelOffsets(plan, at));
      const text = ["X", "Y", "Z"].filter((_, k) => plan.axes.on[k]).map((n) => `${n} ${Math.round(at["XYZ".indexOf(n)])}`).join("  ");
      if (text !== shown) {
        shown = text;
        const el = document.getElementById("wr-axes");
        if (el) el.textContent = text + " mm";
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      scene.setPose(null);
      const el = document.getElementById("wr-axes");
      if (el) el.textContent = "";
    };
  }, [scene, plan]);
  return null;
}

/** A drag chain or loop: what it is, what it carries, and how it fares through travel. */
function LinkCard({ plan, id, onClose }: { plan: TravelPlan; id: string; onClose: () => void }) {
  const l = plan.links.find((x) => x.id === id);
  const check = plan.checks.find((c) => c.link === id);
  if (!l) return null;
  const carrier = plan.carriers.find((c) => c.id === l.child);
  return (
    <motion.div className="vp-float wr-card" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ type: "spring", stiffness: 420, damping: 36 }}>
      <div className="row" style={{ marginBottom: 8, gap: 8 }}>
        <div className="grow wr-title">
          {l.label} <span className="dim">· {carrier?.label}</span>
        </div>
        <button className="icon-btn sm" onClick={onClose} aria-label="Close">
          <Icon.X size={14} />
        </button>
      </div>
      <div className="wr-facts mono">
        <div>{l.chain ? `${l.chain.inner[0]} × ${l.chain.inner[1]} mm chain, ${Math.round(l.L)} mm, ${Math.round(l.L / l.chain.pitch)} links, R${Math.round(l.R)}` : `spiral-wrapped loop, ${Math.round(l.L)} mm`}</div>
        <div>carries {l.wires.join(", ")}</div>
      </div>
      {check && (
        <div className={`wr-note wr-check ${check.status}`}>
          {check.status === "pass" ? <Icon.Check size={12} /> : <Icon.Alert size={12} />} {check.detail}
        </div>
      )}
    </motion.div>
  );
}

/** What the wiring checks found on one cable, in a line each. */
function wireIssues(w: HarnessWire, f: WiringFindings | null, name: (id: string) => string): string[] {
  if (!f) return [];
  const out: string[] = [];
  for (const c of f.cableHits) if (c.wire === w.id) out.push(c.through ? `runs through ${name(c.part)}` : `squashed against ${name(c.part)}`);
  const crossed = f.crossings.filter((c) => c.a === w.id || c.b === w.id).map((c) => (c.a === w.id ? c.b : c.a));
  if (crossed.length) out.push(`crowded through ${crossed.length > 3 ? `${crossed.length} other cables` : crossed.join(", ")}`);
  for (const p of f.plugHits) if (p.wire === w.id) out.push(`plug on ${w.ends[p.end].comp} ${w.ends[p.end].label} runs into ${name(p.part)}`);
  for (const p of f.pullBlocked) if (p.wire === w.id) out.push(`no room to unplug it from ${w.ends[p.end].comp}`);
  if (f.outside.some((o) => o.wire === w.id)) out.push("leaves the enclosure on the way");
  for (const e of w.ends) if (e.splice) out.push(`joined with ${e.splice.wires.length - 1} other wire${e.splice.wires.length > 2 ? "s" : ""} in a splice at ${e.comp} ${e.label}`);
  return out;
}

function WireCard({ wire, run, flex, issues, onClose }: { wire: HarnessWire; run?: number; flex: string[]; issues: string[]; onClose: () => void }) {
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
            {r.gauge ?? "?"} AWG {r.insulation === "silicone" ? "silicone " : ""}
            {r.color}
            {r.gaugeSuggested || r.colorSuggested ? <span className="dim"> (suggested)</span> : null}
          </div>
        )}
        {wire.wires.length > 1 && <div>{wire.wires.map((w) => w.name).join(", ")}</div>}
        {flex.length > 0 && <div>moves through the {flex.join(" and ")}</div>}
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
      {issues.length > 0 && (
        <div className="wr-note">
          {issues.map((t) => (
            <div key={t}>{t}</div>
          ))}
        </div>
      )}
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
  if (["lead", "solder", "lug", "barrel", "xt60", "usb_c", "usb_micro", "usb_a"].includes(e.spec.kind)) return name;
  return ways > 1 ? `${name}, ${ways}-way` : name;
}
