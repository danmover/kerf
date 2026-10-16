// The materials for one part lined up on the model: hover a card to see the
// part in that material, read the numbers that decide it, and use one with a
// click. What the part needs can be switched on and off to re-rank them.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { useDesign } from "../../core/engine";
import { useMaterials } from "../../materials/store";
import { needsFromName, type MaterialOption, type Need } from "../../materials/advise";
import { Icon } from "../icons";
import { applyOption, blockIds, OptionCard, previewOption, useLiveAdvice } from "./parts";

/** Needs worth offering as switches; the rest Claude passes when it knows them. */
const NEED_CHIPS: Need[] = ["low friction", "wear resistant", "flexible", "tough", "light", "cheap", "stiff", "clear", "soft", "food safe", "chemical resistant", "conducts heat"];

export function MaterialCompareHost() {
  const part = useMaterials((s) => s.comparing);
  const exists = useDesign((s) => !!part && !!s.model?.parts.some((p) => p.name === part));
  return <AnimatePresence>{part && exists && <Compare key={part} part={part} />}</AnimatePresence>;
}

function Compare({ part }: { part: string }) {
  const [needs, setNeeds] = useState<Need[]>([]);
  const advice = useLiveAdvice(part, needs);
  const ids = useMemo(() => blockIds(part), [part, advice]);
  const [hover, setHover] = useState<MaterialOption | null>(null);
  const close = () => useMaterials.getState().compare(null);
  const inferred = useMemo(() => needsFromName(part), [part]);

  useEffect(() => previewOption(ids, hover), [ids, hover]);
  useEffect(() => () => previewOption(ids, null), [ids]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (!advice) return null;
  // the current material first, as the baseline the others are read against
  const cur = advice.options.find((o) => o.current);
  const usable = advice.options.filter((o) => o.verdict !== "unsuitable" && o !== cur);
  const same = usable.filter((o) => !o.otherWay).slice(0, 6);
  const other = usable.filter((o) => o.otherWay).slice(0, same.length ? 3 : 8);
  const out = advice.options.filter((o) => o.verdict === "unsuitable" && o !== cur);
  const toggle = (n: Need) => setNeeds((xs) => (xs.includes(n) ? xs.filter((x) => x !== n) : [...xs, n]));
  const use = (o: MaterialOption) => {
    setHover(null);
    applyOption(part, o);
  };
  const card = (o: MaterialOption) => <OptionCard key={o.name} o={o} onHover={(on) => setHover(on ? o : null)} onUse={() => use(o)} />;

  return (
    <motion.div className="vp-float mo-compare" role="dialog" aria-label={`Compare materials for ${advice.subject}`} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} transition={{ type: "spring", stiffness: 420, damping: 36 }} onMouseLeave={() => setHover(null)}>
      <div className="row mo-compare-head">
        <Icon.Material size={15} style={{ color: "var(--accent-2)" }} />
        <div className="grow" style={{ minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>Materials for {advice.subject}</span>
          <span className="mo-basis inline">{advice.basis.join(" · ") || "No brief yet: ranked for general use"}</span>
        </div>
        <button className="icon-btn sm" onClick={close} aria-label="Close material comparison">
          <Icon.X size={14} />
        </button>
      </div>
      <div className="mo-needs" aria-label="What this part needs">
        {NEED_CHIPS.map((n) => {
          const fromName = inferred.includes(n);
          const on = fromName || needs.includes(n);
          return (
            <button key={n} className={`mat-chip ${on ? "active" : ""}`} aria-pressed={on} onClick={() => !fromName && toggle(n)} data-tip={fromName ? "Read from the part's name" : on ? "Stop ranking for this" : "Rank for this too"}>
              {n}
            </button>
          );
        })}
      </div>
      <div className="mo-row">
        {cur && card(cur)}
        {same.map(card)}
        {other.length > 0 && (
          <div className="mo-divider" aria-hidden>
            <span>made another way</span>
          </div>
        )}
        {other.map(card)}
      </div>
      {out.length > 0 && (
        <div className="mo-out" data-tip={out.map((o) => `${o.label}: ${o.criteria.filter((k) => k.grade === "fail").map((k) => k.why).join("; ")}`).join("\n")}>
          Ruled out: {out.slice(0, 8).map((o) => o.label.replace(/ \(.*\)$/, "")).join(", ")}
          {out.length > 8 ? ` and ${out.length - 8} more` : ""}
        </div>
      )}
    </motion.div>
  );
}
