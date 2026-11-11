// New frame, by hand: a panel over the 3D view where you pick a profile and
// the outside size, watching the frame there while you choose, then add it to
// the design as a frame block (which trims the members to fit and makes the
// cut list). The same block is what Claude writes, so either can change it.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { Icon } from "./icons";
import { useDesign } from "../core/engine";
import { commitSource, endPreview, previewSource, realSource } from "../app/project";
import { evaluate } from "../lang/evaluator";
import { fmtNum } from "../lang/values";

export const useFrameDialog = create<{ open: boolean }>(() => ({ open: false }));
export const openFrameDialog = () => useFrameDialog.setState({ open: true });

const PREVIEW = "new-frame";

const PROFILES: { value: string; label: string; bought?: boolean }[] = [
  { value: "2020", label: "2020 V-slot aluminium extrusion", bought: true },
  { value: "2040", label: "2040 V-slot, standing (40 up)", bought: true },
  { value: "2040 flat", label: "2040 V-slot, lying flat (40 across)", bought: true },
  { value: "box 25x25x1.6", label: "Box section 25 × 25 × 1.6" },
  { value: "box 40x40x3", label: "Box section 40 × 40 × 3" },
  { value: "box 50x25x2.5", label: "Box section 50 × 25 × 2.5" },
  { value: "tube 26.9x2.6", label: "Round tube 26.9 × 2.6" },
  { value: "tube 33.7x3.2", label: "Round tube 33.7 × 3.2" },
  { value: "angle 30x30x3", label: "Angle 30 × 30 × 3" },
  { value: "angle 40x40x4", label: "Angle 40 × 40 × 4" },
  { value: "flat 40x5", label: "Flat bar 40 × 5" },
  { value: "bar 20x20", label: "Square bar 20 × 20" },
];
const MATERIALS = ["Steel", "Aluminum 6061", "Stainless 304"];

interface Form {
  profile: string;
  shape: "box" | "flat";
  w: number;
  d: number;
  h: number;
  /** a middle ring of rails at this height (0: none) */
  mid: number;
  ends: "butt" | "miter";
  material: string;
}

const n = (x: number) => fmtNum(x, 2);

/** The frame block for the form. */
export function frameBlock(name: string, f: Form): string {
  const p = PROFILES.find((x) => x.value === f.profile);
  const lines = [`frame ${name} {`, `  profile: "${f.profile === "2040 flat" ? "2040" : f.profile}"`];
  if (f.profile === "2040 flat") lines.push("  rotate: 90");
  lines.push(f.shape === "flat" ? `  box: (${n(f.w)}, ${n(f.d)})` : `  box: (${n(f.w)}, ${n(f.d)}, ${n(f.h)})`);
  if (f.shape === "box" && f.mid > 0) lines.push(`  levels: [${n(f.mid)}]`);
  if (!p?.bought) {
    if (f.ends === "miter") lines.push('  ends: "miter"');
    if (f.material !== "Steel") lines.push(`  material: "${f.material}"`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** The name, or the members' names (NAME_1, NAME_2...), is already in the design. */
const clash = (name: string, taken: Set<string>) => taken.has(name) || [...taken].some((t) => t.startsWith(`${name}_`) && /^\d+$/.test(t.slice(name.length + 1)));

/** A name no block uses yet: frame, frame2, frame3... */
function freeName(taken: Set<string>): string {
  if (!clash("frame", taken)) return "frame";
  let i = 2;
  while (clash(`frame${i}`, taken)) i++;
  return `frame${i}`;
}

function Num({ label, value, onChange, tip }: { label: string; value: number; onChange: (v: number) => void; tip?: string }) {
  const [text, setText] = useState(n(value));
  useEffect(() => setText(n(value)), [value]);
  return (
    <label className="mt-num" data-tip={tip}>
      <span className="mono">{label}</span>
      <input
        className="input mono"
        type="number"
        step={10}
        min={0}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v >= 0) onChange(v);
        }}
      />
      <span className="dim mono">mm</span>
    </label>
  );
}

function Pick<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <label className="mt-num">
      <span className="mono">{label}</span>
      <select className="select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FrameDialog() {
  const open = useFrameDialog((s) => s.open);
  const [f, setF] = useState<Form>({ profile: "2020", shape: "box", w: 400, d: 300, h: 300, mid: 0, ends: "butt", material: "Steel" });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  // the names in the design as the dialog opens (the preview's model has the new frame in it too)
  const [taken, setTaken] = useState<Set<string>>(() => new Set());
  const [nameText, setNameText] = useState("frame");
  useEffect(() => {
    if (!open) return;
    const m = useDesign.getState().model;
    const t = new Set([...(m?.blocks ?? []).map((b) => b.name), ...(m?.parts ?? []).map((p) => p.name)]);
    setTaken(t);
    setNameText(freeName(t));
  }, [open]);
  const name = nameText.trim();
  const nameProblem = !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? "Name it with letters, digits and _, starting with a letter" : clash(name, taken) ? `${name} is already a name in this design` : undefined;
  const bought = !!PROFILES.find((p) => p.value === f.profile)?.bought;
  const text = frameBlock(nameProblem ? "frame" : name, f);
  // the frame on its own, for the cut list and any mistake in the sizes
  const alone = useMemo(() => evaluate(`design "Frame"\n${text}\n`), [text]);
  const problem = nameProblem ?? alone.diagnostics.find((d) => d.severity === "error")?.message.replace(/^In frame "[^"]+": /, "");
  const info = alone.frames?.[0];
  const next = useMemo(() => (open ? `${realSource().trimEnd()}\n\n${text}\n` : ""), [open, text]);

  useEffect(() => {
    if (!open) return;
    if (problem) {
      endPreview(PREVIEW);
      return;
    }
    const t = setTimeout(() => previewSource({ key: PREVIEW, label: "New frame", quiet: true }, next), 120);
    return () => clearTimeout(t);
  }, [open, next, problem]);

  const close = () => {
    endPreview(PREVIEW);
    useFrameDialog.setState({ open: false });
  };
  const add = () => {
    if (problem) return;
    commitSource(next, "you", `Added frame ${name}: ${info?.section ?? f.profile}, ${info?.members.length ?? 0} members`);
    useFrameDialog.setState({ open: false });
  };

  // Esc closes it, as it does the other tool panels
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.closest(".frame-panel")) return;
      e.stopPropagation();
      endPreview(PREVIEW);
      useFrameDialog.setState({ open: false });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // a panel over the 3D view rather than a dialog, so the frame shows while you choose
  return (
    <AnimatePresence>
      {open && (
        <motion.div key="frame" className="vp-float frame-panel" role="dialog" aria-label="New frame" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={{ type: "spring", stiffness: 480, damping: 36 }} onPointerDown={(e) => e.stopPropagation()}>
          <div className="mt-head">
            <Icon.Grid size={13} />
            <span className="grow" style={{ marginLeft: 6 }}>
              New frame
            </span>
            <button className="icon-btn sm" onClick={close} aria-label="Close" data-tip="Close (Esc)">
              <Icon.X size={12} />
            </button>
          </div>
          <p className="dim frame-panel-intro">Members run along the edges of the box and are cut to fit where they meet: posts full height, rails between them. Edit the frame block later, or add members with path: lines.</p>
          <label className="mt-num" data-tip={`Its members are ${name || "NAME"}_1, ${name || "NAME"}_2…`}>
            <span className="mono">Name</span>
            <input className="input mono" value={nameText} spellCheck={false} onChange={(e) => setNameText(e.target.value)} />
          </label>
          <Pick label="Profile" value={f.profile} options={PROFILES} onChange={(v) => set("profile", v)} />
          <Pick
            label="Shape"
            value={f.shape}
            options={[
              { value: "box", label: "Box: posts and rails" },
              { value: "flat", label: "Flat rectangle" },
            ]}
            onChange={(v) => set("shape", v)}
          />
          <Num label="Width X" value={f.w} onChange={(v) => set("w", v)} />
          <Num label="Depth Y" value={f.d} onChange={(v) => set("d", v)} />
          {f.shape === "box" && <Num label="Height Z" value={f.h} onChange={(v) => set("h", v)} />}
          {f.shape === "box" && <Num label="Middle rails" tip="The height of a middle ring of rails, to their centre lines (0 for none)" value={f.mid} onChange={(v) => set("mid", v)} />}
          {!bought && (
            <>
              <Pick label="Material" value={f.material} options={MATERIALS.map((m) => ({ value: m, label: m }))} onChange={(v) => set("material", v)} />
              <Pick
                label="Corners"
                value={f.ends}
                options={[
                  { value: "butt", label: "Butt: one stops on the other" },
                  { value: "miter", label: "Mitred where two meet" },
                ]}
                onChange={(v) => set("ends", v)}
              />
            </>
          )}
          <div className={`frame-dialog-sum ${problem ? "bad" : ""}`}>
            {problem ? (
              problem
            ) : info ? (
              <>
                <b>{info.members.length} pieces</b>, {fmtNum(info.total / 1000, 2)} m of {info.section}: {info.cuts.map((c) => `${c.qty} × ${fmtNum(c.length, 1)} mm`).join(", ")}. About {fmtNum(info.mass / 1000, 2)} kg.
                {bought && " Once it is where you want it, Fasten joints under the cut list (parts list tab) puts corner brackets with screws and T-nuts on every joint."}
              </>
            ) : null}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={close}>
              Cancel
            </button>
            <button className="btn sm primary" style={{ flex: 1 }} disabled={!!problem} onClick={add}>
              <Icon.Plus size={11} /> Add frame
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
