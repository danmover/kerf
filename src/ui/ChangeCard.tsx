// What one of Claude's replies changed: before and after pictures you can
// wipe between, the parts that changed (hover to see them in 3D), the values
// it set (drag to fine-tune), and the before/after toggle in the 3D view.

import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat, revertTurn, type ChatItem } from "../ai/chat";
import { changesBetween, type PartChange } from "../core/changes";
import { diffStats } from "../core/sourceEdit";
import { evaluateOnly } from "../core/engine";
import { paramUnit, sameValue, withValues } from "../core/decisions";
import { commitSource, endPreview, previewSource, realSource, useProject } from "../app/project";
import { hoverParts, select } from "../app/view";
import { useSettings } from "../app/settings";
import type { ChangeShots } from "../app/changeShots";
import { fmtNum } from "../lang/values";
import { useRealModel } from "./useRealModel";
import { ValueField } from "./ValueField";
import { DiffView } from "./DiffView";
import { Icon } from "./icons";

type TurnItem = Extract<ChatItem, { kind: "turn" }>;

const MARK: Record<PartChange["kind"], string> = { added: "+", removed: "−", changed: "~", moved: "→" };
const WORD: Record<PartChange["kind"], string> = { added: "added", removed: "removed", changed: "reshaped", moved: "moved" };

export function ChangeCard({ it, compact }: { it: TurnItem; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const stats = useMemo(() => diffStats(it.before, it.after), [it.before, it.after]);
  const { parts, params } = useMemo(() => changesBetween(it.before, it.after), [it.before, it.after]);
  const key = `turn:${it.id}`;
  const comparing = useProject((s) => s.preview?.key === key);
  const busy = useChat((s) => s.busy);
  const { model: real } = useRealModel();
  useEffect(() => () => endPreview(key), [key]);
  const live = useMemo(() => new Set(real?.parts.map((p) => p.id)), [real]);
  const shown = (ids: string[]) => ids.filter((id) => live.has(id));

  // fine-tune a value Claude changed, without another round trip
  const tweak = (name: string, v: number | string | boolean, commit: boolean) => {
    const src = realSource();
    const next = withValues(src, evaluateOnly(src), { [name]: v });
    if (commit) commitSource(next, "you", `Set ${name} to ${typeof v === "number" ? fmtNum(v, 3) : String(v)} after Claude's change`);
    else previewSource({ key: `tweak:${it.id}`, label: name, quiet: true }, next);
  };
  const compare = () => (comparing ? endPreview(key) : previewSource({ key, label: "Before Claude's change" }, it.before));

  return (
    <div className={`turn ${compact ? "compact" : ""}`} onMouseEnter={() => !it.reverted && hoverParts(shown(parts.map((p) => p.id)))} onMouseLeave={() => hoverParts([])}>
      <div className="turn-bar">
        <Icon.Edit size={12} />
        <span className="grow">
          {it.reverted ? "Reverted" : compact ? "Changed" : `Changed · ${it.edits} edit${it.edits > 1 ? "s" : ""}`} · <span style={{ color: "var(--pass)" }}>+{stats.added}</span> <span style={{ color: "var(--fail)" }}>−{stats.removed}</span>
        </span>
        {!it.reverted && (
          <button className={`btn sm ${comparing ? "" : "ghost"}`} disabled={busy} aria-pressed={comparing} onClick={compare} data-tip="Show the design as it was before this reply, in the 3D view">
            <Icon.Compare size={12} /> {comparing ? "After" : "Before"}
          </button>
        )}
        {!compact && (
          <button className="btn sm ghost" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Review"}
          </button>
        )}
        {!it.reverted && !compact && (
          <button className="btn sm ghost" disabled={busy} onClick={() => revertTurn(it.id)} data-tip="Put the design back as it was before this reply">
            <Icon.Undo size={12} /> Revert
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>{it.shots && !it.reverted && <Pictures key="pics" shots={it.shots} />}</AnimatePresence>
      {!it.reverted && parts.length > 0 && (
        <div className="turn-parts">
          {parts.slice(0, compact ? 4 : 8).map((p) => (
            <button
              key={p.id}
              className={`tp ${p.kind}`}
              disabled={!live.has(p.id)}
              onMouseEnter={(e) => {
                e.stopPropagation();
                hoverParts(shown([p.id]));
              }}
              onMouseLeave={() => hoverParts(shown(parts.map((q) => q.id)))}
              onClick={() => live.has(p.id) && select([p.id])}
              data-tip={`${p.label} ${WORD[p.kind]}${live.has(p.id) ? " · click to select" : ""}`}
            >
              <span className="m">{MARK[p.kind]}</span>
              {p.label}
            </button>
          ))}
          {parts.length > (compact ? 4 : 8) && <span className="chip">+{parts.length - (compact ? 4 : 8)}</span>}
        </div>
      )}
      {!it.reverted && !compact && params.length > 0 && (
        <div className="turn-chips">
          <span className="mono dim tc-label" data-tip="Drag a name or type a value to fine-tune it">
            tweak
          </span>
          {params.slice(0, 8).map((c) => {
            const cur = real?.params.find((p) => p.name === c.name);
            return (
              <ValueField
                key={c.name}
                name={c.name}
                from={c.from}
                value={cur?.value ?? c.to}
                unit={paramUnit(real, c.name)}
                accent={!!cur && !sameValue(cur.value, c.to)}
                disabled={!cur || cur.locked || busy}
                onLive={(v) => tweak(c.name, v, false)}
                onCommit={(v) => tweak(c.name, v, true)}
              />
            );
          })}
        </div>
      )}
      {open && (
        <div style={{ marginTop: 6, borderRadius: 8, overflow: "hidden", border: "1px solid var(--line-2)" }}>
          <DiffView before={it.before} after={it.after} />
        </div>
      )}
    </div>
  );
}

/** Before and after, as a wipe you can scrub with the pointer, or side by side when the framing differs. */
export function Pictures({ shots }: { shots: ChangeShots }) {
  const reduce = useSettings((s) => s.reduceMotion);
  const box = useRef<HTMLDivElement>(null);
  const p = useMotionValue(reduce ? 50 : 100);
  const clip = useTransform(p, (v) => `inset(0 ${100 - v}% 0 0)`);
  const left = useTransform(p, (v) => `${v}%`);
  const touched = useRef(false);

  useEffect(() => {
    if (reduce || shots.mode !== "wipe") return;
    // sweep once from before to after, then rest in the middle
    const c = animate(p, [100, 100, 0, 50], { duration: 2.4, times: [0, 0.15, 0.6, 1], ease: "easeInOut" });
    return () => c.stop();
  }, [reduce, shots.mode, p]);

  const scrub = (e: React.PointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    if (!touched.current) {
      touched.current = true;
      p.stop();
    }
    p.set(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
  };

  if (shots.mode === "pair")
    return (
      <motion.div className="pics pair" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}>
        <figure>
          <img src={shots.before} alt="The design before this change" />
          <figcaption>before</figcaption>
        </figure>
        <figure>
          <img src={shots.after} alt="The design after this change" />
          <figcaption>after</figcaption>
        </figure>
      </motion.div>
    );
  return (
    <motion.div
      ref={box}
      className="pics wipe"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      onPointerMove={scrub}
      onPointerDown={scrub}
      role="img"
      aria-label="Before and after this change. Move the pointer across to compare."
      data-tip="Move across to compare"
    >
      <img src={shots.after} alt="" draggable={false} />
      <motion.img src={shots.before} alt="" draggable={false} className="top" style={{ clipPath: clip }} />
      <motion.div className="divider" style={{ left }}>
        <span className="handle">
          <Icon.Compare size={10} />
        </span>
      </motion.div>
      <span className="lbl l">before</span>
      <span className="lbl r">after</span>
    </motion.div>
  );
}
