// The make tab's whole-design view: what one design costs at a prototype, a
// small batch and production (made parts on their recommended routes, bought
// parts, hand assembly), how each part is made at each quantity, and one
// click to set every part to a tier's picks.

import { motion } from "framer-motion";
import { useMemo } from "react";
import { useDesign } from "../../core/engine";
import { useSettings } from "../../app/settings";
import { bomRows, bomTotal } from "../../persist/files";
import { PROCESSES } from "../../mfg/profiles";
import { fmtDays } from "../../mfg/cost";
import { defaultTiers, designTotals, type DesignTier, type ManufacturingPlan } from "../../mfg/advisor";
import { money } from "../../materials/advise";
import { Swatch } from "../MaterialPicker";
import { Icon } from "../icons";
import { applyTier, useDesignPlan } from "./live";
import { AssemblyCard, useAssemblySeconds } from "./AssemblyCard";

export function DesignView({ onPart }: { onPart: (block: string) => void }) {
  const model = useDesign((s) => s.model);
  const labour = useSettings((s) => s.labourRate);
  const { data, busy, error, progress } = useDesignPlan(true);
  const assembly = useAssemblySeconds();
  const bought = useMemo(() => (model ? bomTotal(bomRows(model)) : { total: 0, unpriced: 0 }), [model]);
  const plans = useMemo(() => data?.parts.map((p) => p.plan) ?? [], [data]);
  const tiers = useMemo(() => defaultTiers(model?.brief?.quantity), [model?.brief?.quantity]);
  const totals = useMemo(() => designTotals(plans, tiers, { bought: bought.total, assemblySeconds: assembly, labour }), [plans, tiers, bought.total, assembly, labour]);

  if (error) return <div className="mk-note fail">{error}</div>;
  if (!data)
    return (
      <div className="mk-note mono dim">
        <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> Working out each part
        {progress ? ` (${progress[0] + 1} of ${progress[1]})` : ""}…
      </div>
    );

  return (
    <div className="mk-design">
      <div className="mk-basis">
        <span className="mk-title">The whole design</span>
        <span className="mk-chip">
          {plans.length} made part{plans.length === 1 ? "" : "s"}
        </span>
        {bought.total > 0 && <span className="mk-chip">{money(bought.total)} bought parts per design</span>}
        {bought.unpriced > 0 && <span className="mk-chip">{bought.unpriced} bought parts without a price</span>}
        {busy && (
          <span className="mk-chip busy">
            <span className="spinner" style={{ width: 9, height: 9, borderWidth: 1.5 }} /> updating
            {progress ? ` ${progress[0] + 1}/${progress[1]}` : ""}
          </span>
        )}
      </div>
      <div className="mk-tiers" style={{ gridTemplateColumns: `repeat(${totals.length}, minmax(0, 1fr))` }}>
        {totals.map((t, i) => (
          <DesignTierCard key={t.qty} t={t} i={i} plans={plans} />
        ))}
      </div>
      <AssemblyCard />
      <PartsGrid plans={plans} totals={totals} onPart={onPart} />
      {data.skipped.length > 0 && (
        <div className="mk-fine">
          Not planned:{" "}
          {data.skipped.map((s) => (
            <span key={s.label} data-tip={s.why}>
              {s.label}{" "}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function DesignTierCard({ t, i, plans }: { t: DesignTier; i: number; plans: ManufacturingPlan[] }) {
  const changes = plans.filter((p) => {
    const ti = p.tiers.findIndex((x) => x.qty === t.qty);
    const r = ti >= 0 ? p.tiers[ti].recommended : undefined;
    return r && (!r.current || r.materialChange);
  }).length;
  const parts = [
    ["made", t.made],
    ["bought", t.bought],
    ["assembly", t.assembly],
  ] as const;
  const max = Math.max(1e-9, t.each);
  return (
    <motion.div className={`mk-tier-card ${t.brief ? "is-brief" : ""}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 420, damping: 34, delay: i * 0.04 }}>
      <div className="mk-tier-head">
        <span className="mk-tier-label">{t.label}</span>
        {t.brief && <span className="mk-tag">brief</span>}
        <span className="mk-tier-qty">
          {t.qty.toLocaleString("en-US")} design{t.qty === 1 ? "" : "s"}
        </span>
      </div>
      <div className="mk-price">
        <b>{money(t.each)}</b> <span>per design</span>
      </div>
      <div className="mk-price-sub">
        {money(t.total)} in all · {fmtDays(t.days)}
      </div>
      {t.tooling > 0 && <div className="mk-price-sub">incl. {money(t.tooling)} moulds and tooling</div>}
      <div className="mk-split" role="img" aria-label={parts.map(([k, v]) => `${k} ${money(v)}`).join(", ")}>
        {parts.map(([k, v]) =>
          v > 0 ? (
            <div key={k} className={`mk-split-seg k-${k}`} style={{ flexGrow: v / max }} data-tip={`${k}: ${money(v)} per design`} />
          ) : null,
        )}
      </div>
      <div className="mk-split-key">
        {parts.map(([k, v]) =>
          v > 0 ? (
            <span key={k}>
              <i className={`k-${k}`} />
              {k} {money(v)}
            </span>
          ) : null,
        )}
      </div>
      {t.asIs !== null && Math.abs(t.asIs - t.made) / Math.max(t.made, 0.01) > 0.02 && (
        <div className="mk-price-sub">
          Made as set now: {money(t.asIs)} instead of {money(t.made)}
        </div>
      )}
      {t.missing.length > 0 && <div className="mk-hint">No usable way to make {t.missing.join(", ")}.</div>}
      <button className="btn sm mk-use" disabled={!changes} onClick={() => applyTier(plans, t.qty, t.label)} data-tip={changes ? `Set ${changes} part${changes === 1 ? "" : "s"} to the ${t.label.toLowerCase()} picks, as one change you can undo` : "Every part is already made this way"}>
        {changes ? `Make it this way (${changes} change${changes === 1 ? "" : "s"})` : "Made this way now"}
      </button>
    </motion.div>
  );
}

/** Each part's pick at each tier; a row opens that part. */
function PartsGrid({ plans, totals, onPart }: { plans: ManufacturingPlan[]; totals: DesignTier[]; onPart: (block: string) => void }) {
  return (
    <div className="mk-routes">
      <div className="mk-h">How each part is made at each quantity</div>
      <table className="mk-table">
        <thead>
          <tr>
            <th>Part</th>
            {totals.map((t) => (
              <th key={t.qty}>{t.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr key={p.part} className="mk-row" onClick={() => onPart(p.part)}>
              <td>
                <span className="mk-proc">
                  {p.label}
                  {p.count > 1 && <span className="mk-why">×{p.count}</span>}
                </span>
              </td>
              {totals.map((t) => {
                const ti = p.tiers.findIndex((x) => x.qty === t.qty);
                const r = ti >= 0 ? p.tiers[ti].recommended : undefined;
                const c = r?.costs[ti];
                return (
                  <td key={t.qty}>
                    {r && c ? (
                      <span className="mk-cell">
                        <Swatch material={r.material} finish={r.finish} color={r.color} size={14} render={40} />
                        <span className="mk-cell-p">{PROCESSES[r.process].short}</span>
                        <span className="mk-cell-c">{money(c.unit)}</span>
                        {(!r.current || r.materialChange) && <span className="mk-change" data-tip={`${PROCESSES[r.process].label} in ${r.materialLabel}`}>change</span>}
                      </span>
                    ) : (
                      <span className="mk-why">–</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mk-fine">
        <Icon.Info size={11} /> Click a part for every way to make it. Costs are estimates for comparing; a real quote can land 0.6–2× from them.
      </div>
    </div>
  );
}
