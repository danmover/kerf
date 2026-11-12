// Choosing what parts are made of. Hovering any material, finish or colour
// shows it on the model straight away; clicking writes it into the design
// as one undoable change, the same way every other edit works.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import type { EvalPart } from "../core/model";
import { meshes, useDesign } from "../core/engine";
import { setBlockProps } from "../core/sourceEdit";
import { commitSource } from "../app/project";
import { viewport, whenViewport } from "../app/viewportApi";
import { useSettings } from "../app/settings";
import { CATEGORY_LABELS, FINISHES, MATERIAL_LIST, materialDef, resolveFinish, type MaterialCategory, type MaterialDef } from "../library/materials";
import { fmtNum } from "../lang/values";
import { Icon } from "./icons";
import { useChatDraft } from "./chatDraft";
import { applyOption, useLiveAdvice } from "./materials/live";
import { useMaterials } from "../materials/store";
import { materialRecord, pricePerKg } from "../library/materialDb";
import { processLabel, type MaterialOption } from "../materials/advise";

interface Look {
  material: string;
  finish: string;
  color: string;
}

// Swatches render a few per animation frame so opening the picker stays
// smooth. Newest requests go first: what just changed is what you look at.
interface Job {
  alive: () => boolean;
  run: () => void;
}
const queue: Job[] = [];
let pumping = false;
function pump() {
  if (pumping) return;
  pumping = true;
  const step = () => {
    const t0 = performance.now();
    while (queue.length && performance.now() - t0 < 6) {
      const job = queue.pop()!;
      if (job.alive()) job.run();
    }
    if (queue.length) requestAnimationFrame(step);
    else pumping = false;
  };
  requestAnimationFrame(step);
}

/** A rendered material ball, refreshed when the lighting changes. */
export function useSwatch(material: string, finish: string | undefined, color: string, size = 96): string | null {
  const lighting = useSettings((s) => s.lighting);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const job: Job = {
      alive: () => alive,
      run: () => {
        const v = viewport();
        // the viewport mounts after the panels; try again once it exists
        if (!v) return whenViewport(() => alive && (queue.push(job), pump()));
        try {
          setUrl(v.swatch(material, finish, color, size));
        } catch {
          /* no WebGL: the swatch stays a plain colour */
        }
      },
    };
    queue.push(job);
    pump();
    return () => {
      alive = false;
    };
  }, [material, finish, color, size, lighting]);
  return url;
}

export function Swatch({ material, finish, color, size = 40, render = 96 }: { material: string; finish?: string; color: string; size?: number; render?: number }) {
  const url = useSwatch(material, finish, color, render);
  return (
    <span className="mat-ball" style={{ width: size, height: size }}>
      {url ? <img src={url} alt="" draggable={false} /> : <span className="mat-ball-flat" style={{ background: color }} />}
    </span>
  );
}

const CATEGORIES: MaterialCategory[] = ["plastic", "metal", "composite", "other"];

/** Colour a material tile is shown (and applied) in, given what the parts are now. */
function tileColor(m: MaterialDef, cur: Look): string {
  const from = materialDef(cur.material);
  if (m.name === cur.material) return cur.color;
  if (m.category === "plastic" && from?.category === "plastic" && m.finishes[0] !== "clear") return cur.color;
  return m.color;
}

/** A right-click menu asked for the material picker: the selection card's button opens it once it shows. */
const useMaterialAsk = create<{ pending: boolean }>(() => ({ pending: false }));
export const askMaterialPicker = () => useMaterialAsk.setState({ pending: true });

export function MaterialButton({ parts }: { parts: EvalPart[] }) {
  const [open, setOpen] = useState(false);
  const p = parts[0];
  const same = parts.every((q) => q.material === p.material && resolveFinish(q.material, q.finish) === resolveFinish(p.material, p.finish) && q.color === p.color);
  const finish = resolveFinish(p.material, p.finish);
  const def = materialDef(p.material);
  const key = parts.map((q) => q.id).join(",");
  // a component's extra solids (motor.shaft) keep the library's look: the block's material reaches only its main solid
  const fixed = parts.some((q) => q.id.startsWith(`${q.name}.`) && !q.imported);
  useEffect(() => setOpen(false), [key]);
  const asked = useMaterialAsk((s) => s.pending);
  useEffect(() => {
    if (!asked) return;
    useMaterialAsk.setState({ pending: false });
    if (!fixed) setOpen(true);
  }, [asked, fixed]);
  // The picker lives in the viewport layer, not inside the selection card,
  // so it can sit beside the card and use the viewport's full height.
  const btn = useRef<HTMLButtonElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(btn.current?.closest<HTMLElement>(".viewport") ?? null), []);
  const picker = <AnimatePresence>{open && <MaterialPicker key={key} parts={parts} onClose={() => setOpen(false)} />}</AnimatePresence>;
  return (
    <>
      <button
        ref={btn}
        className={`mat-button ${open ? "open" : ""}`}
        onClick={() => !fixed && setOpen((o) => !o)}
        aria-disabled={fixed}
        aria-expanded={open}
        data-tip={fixed ? "Part of a library component, so its material is fixed. Select the component's main body to change the component." : "Change material, finish and colour"}
      >
        <Swatch material={p.material} finish={finish} color={p.color} size={30} render={64} />
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="mat-name">{same ? (def?.label ?? p.material) : "Mixed materials"}</span>
          <span className="mat-sub">{same ? `${FINISHES[finish]?.label ?? finish} · ${p.color}` : `${parts.length} parts`}</span>
        </span>
        {!fixed && <Icon.Chevron size={14} style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .2s" }} />}
      </button>
      {host ? createPortal(picker, host) : picker}
    </>
  );
}

function MaterialPicker({ parts, onClose }: { parts: EvalPart[]; onClose: () => void }) {
  // keyed by content: the parts array is rebuilt on every design change
  const idKey = parts.map((p) => p.id).join(",");
  const ids = useMemo(() => idKey.split(","), [idKey]);
  const blocks = useMemo(() => [...new Set(parts.map((p) => p.name))], [parts]);
  const p = parts[0];
  const cur: Look = { material: p.material, finish: resolveFinish(p.material, p.finish), color: p.color };
  const [hover, setHover] = useState<Look | null>(null);
  const shown = hover ?? cur;
  const shownDef = materialDef(shown.material);
  const setDraft = useChatDraft((s) => s.set);

  useEffect(() => {
    viewport()?.preview(ids, hover);
  }, [ids, hover]);
  useEffect(() => () => viewport()?.preview(ids, null), [ids]);
  useEffect(() => {
    viewport()?.materialMode(true);
    return () => viewport()?.materialMode(false);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const volume = parts.reduce((s, q) => s + (meshes.get(q.hash)?.volume ?? 0), 0);
  const mass = (volume / 1000) * (shownDef?.density ?? 1.2);
  const who = blocks.length === 1 ? blocks[0] : `${blocks.length} parts`;
  // one part block: rank the materials for it, and apply them with the finish and process they need
  const advice = useLiveAdvice(blocks.length === 1 ? blocks[0] : null);
  const fit = useMemo(() => new Map((blocks.length === 1 ? advice?.options : undefined)?.map((o) => [o.name, o]) ?? []), [advice, blocks.length]);
  const suggested = (blocks.length === 1 ? advice?.options : undefined)?.filter((o) => o.verdict !== "unsuitable" && !o.otherWay).slice(0, 3) ?? [];
  const shownRec = materialRecord(shown.material);
  const shownOpt = fit.get(shown.material);
  const shownPrice = shownRec ? pricePerKg(shownRec, shownOpt?.process) : null;
  const lookOf = (o: MaterialOption): Look => ({ material: o.name, finish: o.finish, color: o.color });

  const commit = (next: Look, what: string) => {
    setHover(null);
    viewport()?.preview(ids, null);
    let src = useDesign.getState().source;
    for (const b of blocks) {
      const part = parts.find((q) => q.name === b)!;
      const props: Record<string, string | null> = {};
      if (part.material !== next.material) props.material = JSON.stringify(next.material);
      if (part.material !== next.material || resolveFinish(part.material, part.finish) !== next.finish) props.finish = JSON.stringify(next.finish);
      if (part.color.toLowerCase() !== next.color.toLowerCase()) props.color = next.color.toLowerCase();
      src = setBlockProps(src, b, props);
    }
    if (src !== useDesign.getState().source) commitSource(src, "you", `${who}: ${what}`);
  };

  const pickMaterial = (m: MaterialDef) => {
    const o = fit.get(m.name);
    if (o && m.name !== cur.material) {
      setHover(null);
      viewport()?.preview(ids, null);
      applyOption(blocks[0], o);
      return;
    }
    const finish = m.name === cur.material ? cur.finish : m.finishes[0];
    commit({ material: m.name, finish, color: tileColor(m, cur) }, `${m.label} (${FINISHES[finish]?.label.toLowerCase() ?? finish})`);
  };

  return (
    <motion.div className="vp-float mat-picker" initial={{ opacity: 0, x: 14, scale: 0.98 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 10, scale: 0.98 }} transition={{ type: "spring", stiffness: 420, damping: 34 }} onMouseLeave={() => setHover(null)} role="dialog" aria-label="Material">
      <div className="row" style={{ marginBottom: 10 }}>
        <Icon.Material size={15} style={{ color: "var(--accent-2)" }} />
        <div className="grow" style={{ fontWeight: 600 }}>
          Material <span className="muted mono" style={{ fontWeight: 400, fontSize: 11 }}>· {who}</span>
        </div>
        <button className="icon-btn sm" onClick={onClose} aria-label="Close material picker">
          <Icon.X size={14} />
        </button>
      </div>

      <div className="mat-hero">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={`${shown.material}|${shown.finish}|${shown.color}`} initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.04 }} transition={{ duration: 0.18 }}>
            <Swatch material={shown.material} finish={shown.finish} color={shown.color} size={84} render={168} />
          </motion.div>
        </AnimatePresence>
        <div className="grow" style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>{shownDef?.label ?? shown.material}</div>
          <div className="mono" style={{ fontSize: 11, color: "var(--accent-2)", marginTop: 2 }}>
            {FINISHES[shown.finish]?.label ?? shown.finish} · {shown.color}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.45 }}>
            {shownDef?.note}
          </div>
          <div className="mono" style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 6 }}>
            {fmtNum(shownDef?.density ?? 1.2, 2)} g/cm³ · {volume > 0 ? `${fmtNum(mass, mass < 10 ? 1 : 0)} g for ${parts.length > 1 ? "these" : "this part"}` : "mass after build"}
          </div>
          {shownRec && (
            <div className="mat-hero-stats">
              <span data-tip="Highest temperature for long use under light load">to {shownRec.maxC} °C</span>
              <span data-tip="Yield strength">{shownRec.mech.yield} MPa</span>
              <span data-tip="Stiffness (Young's modulus)">{fmtNum(shownRec.mech.E / 1000, shownRec.mech.E < 10000 ? 1 : 0)} GPa</span>
              {shownPrice && <span data-tip={`Typical price as ${shownPrice.form}${shownOpt?.process ? `, for ${processLabel(shownOpt.process)}` : ""}`}>${fmtNum(shownPrice.price, shownPrice.price < 10 ? 1 : 0)}/kg</span>}
            </div>
          )}
          {shownOpt && shownOpt.name !== cur.material && (
            <div className={`mat-hero-fit v-${shownOpt.verdict}`}>
              <span className={`mo-dot v-${shownOpt.verdict}`} />
              {shownOpt.summary || "No strong points either way"}
              {shownOpt.processChange ? ` · made by ${processLabel(shownOpt.processChange.to)}` : ""}
            </div>
          )}
        </div>
      </div>

      {suggested.length > 0 && (
        <div className="mat-section">
          <div className="mat-section-label row">
            <span className="grow">Suggested for {advice!.subject}</span>
            <button
              className="mat-compare-link"
              onClick={() => {
                useMaterials.getState().compare(blocks[0]);
                onClose();
              }}
              data-tip="Line up every material for this part on the model, with its numbers"
            >
              Compare all
            </button>
          </div>
          <div className="mat-suggest">
            {suggested.map((o) => (
              <button
                key={o.name}
                className={`mat-suggest-tile v-${o.verdict} ${o.current ? "active" : ""}`}
                onMouseEnter={() => setHover(lookOf(o))}
                onFocus={() => setHover(lookOf(o))}
                onClick={() => !o.current && pickMaterial(materialDef(o.name)!)}
                aria-pressed={o.current}
                data-tip={o.criteria.filter((k) => k.weight > 0).slice(0, 6).map((k) => `${k.label} ${k.value}: ${k.why}`).join("\n")}
              >
                <Swatch material={o.name} finish={o.finish} color={o.color} size={34} render={72} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="mat-suggest-name">
                    {o.label.replace(/ \(.*\)$/, "")}
                    {o.current && <span className="mo-now"> · now</span>}
                  </span>
                  <span className="mat-suggest-why">{o.summary}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {CATEGORIES.map((c) => {
        const list = MATERIAL_LIST.filter((m) => m.category === c);
        if (!list.length) return null;
        return (
          <div key={c} className="mat-section">
            <div className="mat-section-label">{CATEGORY_LABELS[c]}</div>
            <div className="mat-grid">
              {list.map((m) => {
                const o = fit.get(m.name);
                const active = m.name === cur.material;
                const color = o && !active ? o.color : tileColor(m, cur);
                const finish = active ? cur.finish : (o?.finish ?? m.finishes[0]);
                return (
                  <button key={m.name} className={`mat-tile ${active ? "active" : ""}`} onMouseEnter={() => setHover({ material: m.name, finish, color })} onFocus={() => setHover({ material: m.name, finish, color })} onClick={() => pickMaterial(m)} aria-pressed={active} aria-label={m.label} data-tip={o ? `${o.summary || o.label}${o.processChange ? ` · made by ${processLabel(o.processChange.to)}` : ""}` : undefined}>
                    {o && <span className={`mo-dot mat-tile-fit v-${o.verdict}`} aria-label={o.verdict} />}
                    <Swatch material={m.name} finish={finish} color={color} size={44} render={88} />
                    <span className="mat-tile-name">{m.label.replace(/ \(.*\)$/, "")}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="mat-section">
        <div className="mat-section-label">Finish · {materialDef(cur.material)?.label ?? cur.material}</div>
        <div className="mat-chips">
          {(materialDef(cur.material)?.finishes ?? [cur.finish]).map((f) => (
            <button key={f} className={`mat-chip ${f === cur.finish ? "active" : ""}`} onMouseEnter={() => setHover({ ...cur, finish: f })} onFocus={() => setHover({ ...cur, finish: f })} onClick={() => commit({ ...cur, finish: f }, `${FINISHES[f]?.label.toLowerCase() ?? f} finish`)} data-tip={FINISHES[f]?.note}>
              <Swatch material={cur.material} finish={f} color={cur.color} size={18} render={40} />
              {FINISHES[f]?.label ?? f}
            </button>
          ))}
        </div>
      </div>

      <div className="mat-section">
        <div className="mat-section-label">Color</div>
        <div className="mat-colors">
          {(materialDef(cur.material)?.palette ?? []).map((c) => (
            <button key={c} className={`mat-color ${c.toLowerCase() === cur.color.toLowerCase() ? "active" : ""}`} style={{ background: c }} onMouseEnter={() => setHover({ ...cur, color: c })} onFocus={() => setHover({ ...cur, color: c })} onClick={() => commit({ ...cur, color: c }, `color ${c}`)} aria-label={`Color ${c}`} />
          ))}
          <label className="mat-color custom" data-tip="Any color" style={{ background: `conic-gradient(#ff5d6c, #f5b84b, #3ddc97, #4fd1c5, #6d8bff, #c792ff, #ff5d6c)` }}>
            <CustomColor key={cur.color} initial={cur.color.length === 7 ? cur.color : "#888888"} onPreview={(c) => setHover({ ...cur, color: c })} onPick={(c) => commit({ ...cur, color: c }, `color ${c}`)} />
          </label>
        </div>
      </div>

      <button className="btn sm ghost" style={{ marginTop: 10, width: "100%", justifyContent: "center" }} onClick={() => setDraft(`What material and finish would you recommend for ${blocks.join(", ")}, and why? Think about loads, heat, wear and how it will be made.`)}>
        <Icon.Sparkle size={13} /> Ask Claude to recommend one
      </button>
    </motion.div>
  );
}

/**
 * The browser's colour picker. React's onChange fires on every movement, which
 * would record a version each time; the picked colour is committed on the
 * native change event, once the picker closes.
 */
function CustomColor({ initial, onPreview, onPick }: { initial: string; onPreview: (c: string) => void; onPick: (c: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const done = () => pick.current(el.value);
    el.addEventListener("change", done);
    return () => el.removeEventListener("change", done);
  }, []);
  return <input ref={ref} type="color" defaultValue={initial} aria-label="Custom color" onInput={(e) => onPreview((e.target as HTMLInputElement).value)} />;
}
