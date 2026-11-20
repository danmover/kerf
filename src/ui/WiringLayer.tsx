// The 3D wiring in the viewport. The cables are drawn in the normal model
// view as part of the machine (a setting), and in the wiring view (W, or the
// wiring tab) with the design ghosted back, solid, or with covers faded.
// Any cable can be clicked in either: its card says where each end goes,
// which pin and contact, how the plug goes in and latches, with a close-up of
// each plug in its socket, what the cable carries against its rating, how to
// make it and what the checks found. This layer keeps the routes current,
// applies the wiring tab's filters, lit circuit, colours and build-order step
// to the 3D harness, and flies the camera to a cable when asked. On a machine
// whose parts move, it can run the axes through their travel so the cables
// can be watched flexing in their drag chains and loops.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SceneController } from "./viewport/scene";
import { WiringOverlay, type WireHit, type WiringMode } from "./viewport/wiring/overlay";
import { meshes, useDesign } from "../core/engine";
import { revealSpan, select, useView } from "../app/view";
import { useHarness, updateHarness, wireRun } from "../machine/harness/runtime";
import type { Harness, HarnessWire, PlugEnd } from "../machine/harness/harness";
import type { RoutedWire } from "../machine/harness/route";
import type { WiringFindings } from "../machine/harness/clash";
import { cableDetails, carriesOf, circuitOf } from "../machine/harness/details";
import { travelOffsets, type TravelPlan } from "../machine/harness/travel";
import { flyToWire, openWiringTab, pickWire, setWiringLook, toggleWiring, traceCircuit, useWiringView } from "./wiringView";
import { useChatDraft } from "./chatDraft";
import { useSettings } from "../app/settings";
import { Segmented } from "./common";
import { Icon } from "./icons";
import { CableCard } from "./wiring/CableCard";
import { kindColor, loadColor } from "./wiring/colours";
import { harnessShown, useCableLoads } from "./wiring/filter";
import "../styles/wiring.css";

export function WiringLayer({ scene }: { scene: SceneController }) {
  const on = useWiringView((s) => s.on);
  const picked = useWiringView((s) => s.picked);
  const hovered = useWiringView((s) => s.hovered);
  const end = useWiringView((s) => s.end);
  const link = useWiringView((s) => s.link);
  const travel = useWiringView((s) => s.travel);
  const trace = useWiringView((s) => s.trace);
  const filter = useWiringView((s) => s.filter);
  const colours = useWiringView((s) => s.colours);
  const step = useWiringView((s) => s.step);
  const fly = useWiringView((s) => s.fly);
  const tabOpen = useView((s) => s.dockTab === "wiring");
  const model = useDesign((s) => s.model);
  const stage = useDesign((s) => s.stage);
  const meshVersion = useDesign((s) => s.meshVersion);
  const harness = useHarness((s) => s.harness);
  const routes = useHarness((s) => s.routes);
  const status = useHarness((s) => s.status);
  const plan = useHarness((s) => s.plan);
  const findings = useHarness((s) => s.findings);
  const look = useSettings((s) => s.wiringLook ?? "ghost");
  const inModel = useSettings((s) => s.cablesInModel !== false);
  const ov = useRef<WiringOverlay | null>(null);
  const [drawn, setDrawn] = useState(0);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  // the cables are drawn in the model view once they are routed (never drawn straight there)
  const modelView = !on && inModel;
  const active = on || (modelView && !!routes?.size && status !== "error");
  const mode: WiringMode = on ? look : "model";

  // the wiring tab turns the wiring view on while it is open, and off when it closes if it turned it on
  useEffect(() => {
    const st = useWiringView.getState();
    if (tabOpen && !st.on) useWiringView.setState({ on: true, byTab: true });
    else if (!tabOpen && st.byTab) toggleWiring(false);
  }, [tabOpen]);

  useEffect(() => {
    if (!active) return;
    const o = new WiringOverlay(scene);
    o.onPick = (hit: WireHit | null) => {
      if (hit) select([]);
      if (hit?.link) useWiringView.setState({ picked: null, end: null, link: hit.link, trace: null });
      else if (hit?.wire) pickWire(hit.wire, { end: hit.end });
      // a click elsewhere lets go of the cable, unless the build order is showing it
      else if (useWiringView.getState().step === null) useWiringView.setState({ picked: null, end: null, link: null });
    };
    o.onHover = (hit: WireHit | null) => useWiringView.setState({ hovered: hit?.wire || null });
    ov.current = o;
    scene.addOverlay(o);
    setDrawn((n) => n + 1);
    return () => {
      scene.removeOverlay(o);
      o.dispose();
      if (ov.current === o) ov.current = null;
      useWiringView.setState({ hovered: null });
    };
  }, [active, scene]);

  // route once the solids are built, and again when the design changes
  useEffect(() => {
    if ((!on && !inModel) || !model || (stage !== "done" && stage !== "refining")) return;
    const t = setTimeout(() => updateHarness(model), 150);
    return () => clearTimeout(t);
  }, [on, inModel, model, meshVersion, stage]);

  useEffect(() => {
    const o = ov.current;
    if (!o || !harness || !model) return;
    // the model view only draws the cables that have a real route
    const h = on ? harness : routedOnly(harness, routes, plan);
    o.set(h, routes, model.parts, (p) => meshes.get(p.hash)?.bbox, plan, findings);
    scene.overlaysChanged();
    setDrawn((n) => n + 1);
    // the model is read when the harness changes, not on every model update in between
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harness, routes, plan, findings, on, active, scene]);

  // the circuit lit, or the build so far: the cables fitted before this one stay lit with it
  const order = harness?.wires ?? [];
  const stepWire = step !== null ? order[Math.min(step, order.length - 1)]?.id : undefined;
  const lit = useMemo(() => (trace ? new Set(trace.wires) : null), [trace]);
  useEffect(() => ov.current?.setFocus(stepWire ?? picked, hovered, link), [picked, hovered, link, stepWire, drawn]);
  useEffect(() => ov.current?.setLit(lit), [lit, drawn]);

  // filters and the build order apply in the wiring view
  const shown = useMemo(() => {
    if (!on || !harness) return null;
    if (step !== null) return new Set(order.slice(0, step + 1).map((w) => w.id));
    return harnessShown(harness, filter, model?.machine);
  }, [on, harness, filter, step, order, model]);
  useEffect(() => ov.current?.setShown(shown), [shown, drawn]);

  // a cable fitted in the build order goes in with its plugs
  useEffect(() => {
    if (stepWire) ov.current?.seatIn(stepWire);
  }, [stepWire, drawn]);
  // and the camera goes to it
  useEffect(() => {
    if (stepWire) flyToWire(stepWire);
  }, [stepWire]);

  // colours: the wires' own, by what they carry, or by how loaded they are
  const loads = useCableLoads(on && colours === "load" ? harness : null);
  useEffect(() => {
    const o = ov.current;
    if (!o || !harness) return;
    if (!on || colours === "wire") o.setTint(null);
    else {
      const kind = new Map(harness.wires.map((w) => [w.id, carriesOf(w.row)]));
      o.setTint(colours === "kind" ? (id) => (kind.has(id) ? kindColor(kind.get(id)!) : null) : (id) => loadColor(loads.get(id)));
    }
  }, [colours, on, harness, loads, drawn]);

  useEffect(() => {
    const o = ov.current;
    if (!o) return;
    o.setMode(mode);
    scene.overlaysChanged();
  }, [mode, scene, drawn]);

  // fly the camera to a cable
  useEffect(() => {
    if (!fly) return;
    const go = () => {
      const box = ov.current?.wireBox(fly.wire);
      if (!box) return false;
      scene.fit("current", true, box.expandByScalar(Math.max(10, box.getSize(box.min.clone()).length() * 0.12)));
      // whatever was under the pointer moves away with the camera
      const hv = useWiringView.getState().hovered;
      if (hv && hv !== fly.wire) useWiringView.setState({ hovered: null });
      return true;
    };
    if (go()) return;
    // the cable may still be drawing (the tab just turned the view on)
    const t = setTimeout(go, 220);
    return () => clearTimeout(t);
  }, [fly, scene]);

  // a picked chain or loop that is gone is let go, and so is the travel run without one
  useEffect(() => {
    if (link && !plan?.links.some((l) => l.id === link)) useWiringView.setState({ link: null });
    if (!plan?.links.length && travel) useWiringView.setState({ travel: false });
  }, [link, plan, travel]);

  // a picked cable that is gone from the design (an edit removed it) is let go
  useEffect(() => {
    if (picked && harness && !harness.wires.some((w) => w.id === picked)) useWiringView.setState({ picked: null, end: null, trace: null });
  }, [picked, harness]);

  // Escape lets go of the cable
  useEffect(() => {
    if (!picked) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement)?.closest?.("input, textarea, .cm-editor")) return;
      useWiringView.setState({ picked: null, end: null, trace: null, step: null, playing: false });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [picked]);

  // the pointer, for the hover tag
  useEffect(() => {
    if (!active) return;
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
  }, [active, scene]);

  const shownWire = stepWire ?? picked;
  const wire = shownWire && active ? harness?.wires.find((w) => w.id === shownWire) : undefined;
  const hover = hovered && hovered !== shownWire && active ? harness?.wires.find((w) => w.id === hovered) : undefined;
  // plug to plug: the routed runs, the lead out of each end, and any run inside a chain or loop
  const run = wire && routes ? wireRun(wire.id) : undefined;
  const flexOf = wire && plan ? plan.links.filter((l) => l.wires.includes(wire.id)) : [];
  const details = useMemo(() => (wire && model?.machine && harness ? cableDetails(model.machine, harness, wire, run) : null), [wire, model, harness, run]);
  const shots = usePlugShots(scene, ov, wire?.id ?? null, drawn, meshVersion);
  if (!active) return null;
  return (
    <>
      {travel && plan && <TravelRun scene={scene} plan={plan} />}
      {on && (
        <div className="wr-travel">
          <Segmented
            id="wiring-look"
            value={look}
            onChange={(v) => setWiringLook(v as typeof look)}
            options={[
              { value: "ghost", label: "Ghosted", title: "The made parts fade back so the whole harness stands out, in full colour" },
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
      )}
      {wire && <EndTags scene={scene} overlay={ov} wire={wire} />}
      {hover && tip && (
        <div className="wr-tip" style={{ left: tip.x + 14, top: tip.y + 12 }}>
          <b>{hover.id}</b> {endText(hover.ends[0])} → {endText(hover.ends[1])}
          <span className="wr-tip-sub">{hover.row.cable ?? hover.row.label ?? hover.row.net} · click for details</span>
        </div>
      )}
      <AnimatePresence>
        {wire && details && (
          <CableCard
            key={`card-${wire.id}`}
            d={details}
            issues={wireIssues(wire, findings, (id) => model?.parts.find((p) => p.id === id)?.name ?? id)}
            flex={flexOf.map((l) => l.label)}
            note={wireNote(wire)}
            shots={shots}
            end={end}
            traced={!!trace && trace.from === wire.id}
            inTab={tabOpen}
            onClose={() => useWiringView.setState({ picked: null, end: null, trace: null, step: null, playing: false })}
            onTrace={() => (trace?.from === wire.id ? useWiringView.setState({ trace: null }) : harness && traceCircuit(wire.id, circuitOf(harness, wire.id)))}
            onFly={() => flyToWire(wire.id)}
            onTab={() => {
              openWiringTab();
              flyToWire(wire.id);
            }}
            onAsk={() => useChatDraft.getState().set(`About cable ${wire.id} (${endText(wire.ends[0])} to ${endText(wire.ends[1])}): `)}
            onCode={details.span ? () => revealSpan(details.span!) : undefined}
          />
        )}
        {!wire && link && plan && <LinkCard key="link" plan={plan} id={link} onClose={() => useWiringView.setState({ link: null })} />}
      </AnimatePresence>
      <AnimatePresence>
        {on && ((status === "routing" && !routes) || status === "error") ? (
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

/** The harness with only the cables whose every run has a real route (for the model view). */
function routedOnly(h: Harness, routes: Map<string, RoutedWire> | null, plan: TravelPlan | null): Harness {
  if (!routes) return { ...h, wires: [] };
  const ok = (w: HarnessWire) =>
    (plan?.pieces[w.id] ?? [{ id: w.id }]).every((p) => {
      const r = routes.get(p.id);
      return !!r && !r.straight;
    });
  return { ...h, wires: h.wires.filter(ok) };
}

/** Close-ups of a cable's two plugs in their sockets, drawn one after the other once its card opens, and kept. */
function usePlugShots(scene: SceneController, overlay: React.RefObject<WiringOverlay | null>, wire: string | null, drawn: number, meshVersion: number): [string | null, string | null] {
  const cache = useRef(new Map<string, string | null>());
  const [, bump] = useState(0);
  const key = (k: number) => `${wire}:${k}:${meshVersion}:${drawn}`;
  useEffect(() => {
    if (!wire) return;
    let stop = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const shoot = (k: 0 | 1) => {
      if (stop || cache.current.has(key(k))) return;
      const v = overlay.current?.plugView(wire, k);
      const st = useHarness.getState();
      const w = st.harness?.wires.find((x) => x.id === wire);
      if (!v || !w) {
        cache.current.set(key(k), null);
        bump((n) => n + 1);
        return;
      }
      // from behind the plug, a little to its latch side, so the way it goes in and its latch both show
      const dir = v.out.clone().multiplyScalar(0.85).addScaledVector(v.latch, 0.5).addScaledVector(v.across, 0.28).normalize();
      scene
        .capture({
          view: "current",
          width: 264,
          height: 184,
          box: [v.box.min.toArray(), v.box.max.toArray()],
          dir: dir.toArray(),
          samples: 6,
          overlays: true,
          only: [w.ends[k].partId],
          mime: "image/jpeg",
          quality: 0.86,
        })
        .then((url) => cache.current.set(key(k), url))
        .catch(() => cache.current.set(key(k), null))
        .finally(() => !stop && bump((n) => n + 1));
    };
    // after the card has opened, and one at a time, so the view stays smooth
    timers.push(setTimeout(() => shoot(0), 260));
    timers.push(setTimeout(() => shoot(1), 520));
    return () => {
      stop = true;
      timers.forEach(clearTimeout);
    };
    // the key covers the rest
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wire, drawn, meshVersion, scene]);
  if (!wire) return [null, null];
  const get = (k: number) => (cache.current.has(key(k)) ? cache.current.get(key(k))! : "wait");
  return [get(0), get(1)];
}

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
export function wireIssues(w: HarnessWire, f: WiringFindings | null, name: (id: string) => string): string[] {
  if (!f) return [];
  const out: string[] = [];
  for (const c of f.cableHits) if (c.wire === w.id) out.push(c.through ? `runs through ${name(c.part)}` : `squashed against ${name(c.part)}`);
  const crossed = f.crossings.filter((c) => c.a === w.id || c.b === w.id).map((c) => (c.a === w.id ? c.b : c.a));
  if (crossed.length) out.push(`crowded through ${crossed.length > 3 ? `${crossed.length} other cables` : crossed.join(", ")}`);
  for (const p of f.plugHits) if (p.wire === w.id) out.push(`plug on ${w.ends[p.end].comp} ${w.ends[p.end].label} runs into ${name(p.part)}`);
  for (const p of f.pullBlocked) if (p.wire === w.id) out.push(`no room to unplug it from ${w.ends[p.end].comp}`);
  if (f.outside.some((o) => o.wire === w.id)) out.push("leaves the enclosure on the way");
  return out;
}

/** The cable's own note, and any splice it is joined into. */
function wireNote(w: HarnessWire): string | undefined {
  const out = w.row.note ? [w.row.note] : [];
  for (const e of w.ends)
    if (e.splice) out.push(`Joined with ${e.splice.wires.length - 1} other wire${e.splice.wires.length > 2 ? "s" : ""} in a crimp splice under heat-shrink at ${e.comp} ${e.label}.`);
  return out.join(" ") || undefined;
}
