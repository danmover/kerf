// The option card the material views share: a material's swatch, verdict,
// process and the numbers that decide it.

import { motion } from "framer-motion";
import { processLabel, type Criterion, type Grade, type MaterialOption } from "../../materials/advise";
import { Swatch } from "../MaterialPicker";

export { applyOption, blockIds, previewOption, useLiveAdvice } from "./live";

export const gradeClass = (g: Grade) => `g-${g}`;

const VERDICT: Record<MaterialOption["verdict"], string> = { recommended: "Best fit", good: "Good", possible: "Possible", poor: "Weak fit", unsuitable: "Unsuitable" };
export const verdictLabel = (o: MaterialOption) => VERDICT[o.verdict];

/** The numbers worth comparing side by side: what the ranking leaned on most, strength and cost first. */
export function keyStats(o: MaterialOption, n = 4): Criterion[] {
  const order = ["strength", "stiffness", "heat", "mass", "cost", "sun", "wet", "food"];
  const by = new Map(o.criteria.map((k) => [k.key, k]));
  const picked = order.map((k) => by.get(k)).filter((k): k is Criterion => !!k && (k.weight > 0 || k.key === "heat" || k.key === "strength"));
  return picked.slice(0, n);
}

export function OptionCard({ o, onUse, onHover, layout = "tile", busy }: { o: MaterialOption; onUse?: () => void; onHover?: (on: boolean) => void; layout?: "tile" | "row"; busy?: boolean }) {
  const stats = keyStats(o);
  const sub = (
    <div className="mo-sub">
      <span className={`mo-verdict v-${o.verdict}`}>{o.current ? `${verdictLabel(o)} · now` : verdictLabel(o)}</span>
      {o.process && <span className="mo-proc">{o.processChange ? `→ ${processLabel(o.process)}` : processLabel(o.process)}</span>}
    </div>
  );
  return (
    <motion.div
      layout="position"
      className={`mo-card ${layout} v-${o.verdict} ${o.current ? "current" : ""}`}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      onFocus={() => onHover?.(true)}
      onBlur={() => onHover?.(false)}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
    >
      <div className="mo-head">
        <Swatch material={o.name} finish={o.finish} color={o.color} size={layout === "row" ? 34 : 28} render={88} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="mo-name" title={o.label}>
            {o.label}
          </div>
          {layout === "row" && sub}
        </div>
        {onUse && (
          <button className="btn sm mo-use" onClick={onUse} disabled={o.current || busy} aria-label={`Use ${o.label}`}>
            {o.current ? "In use" : o.verdict === "unsuitable" ? "Use anyway" : "Use"}
          </button>
        )}
      </div>
      {layout === "tile" && sub}
      {stats.length > 0 && (
        <div className="mo-stats">
          {stats.map((k) => (
            <div key={k.key} className={`mo-stat ${gradeClass(k.grade)}`} data-tip={k.why}>
              <span className="mo-stat-l">{k.label}</span>
              <span className="mo-stat-v">{k.value}</span>
            </div>
          ))}
        </div>
      )}
      {o.summary && <div className="mo-summary">{o.summary}</div>}
    </motion.div>
  );
}
