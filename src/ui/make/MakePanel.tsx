// The make tab: how to make each part, and what the design costs, at a
// prototype, a small batch and production. For a part it shows the pick at
// each quantity (and the cheapest and best-quality ones beside it), the cost
// curve of the main ways to make it, and every process with its checks and
// costs; hovering one shows its material and its issues on the model. For
// the whole design it adds up the parts, the bought parts and assembly.
// Which processes count is set here, in Settings, or in the brief.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDesign } from "../../core/engine";
import { useView } from "../../app/view";
import { useSettings, updateSettings } from "../../app/settings";
import { PROCESSES } from "../../mfg/profiles";
import { fmtDays, fmtHours, type CostEstimate } from "../../mfg/cost";
import { madeBlocks, type PlannedPart } from "../../mfg/plan";
import type { ManufacturingPlan, Route, TierPlan } from "../../mfg/advisor";
import type { ProcessId } from "../../mfg/types";
import { money } from "../../materials/advise";
import { Swatch } from "../MaterialPicker";
import { Icon, StatusIcon } from "../icons";
import { blockIds } from "../materials/live";
import { applyRoute, previewRoute, usePartPlan } from "./live";
import { CostChart, chartRoutes } from "./CostChart";
import { AccessEditor, accessSummary, useAccess } from "./AccessEditor";
import { DesignView } from "./DesignView";
import "../../styles/make.css";

export function MakePanel() {
  const model = useDesign((s) => s.model);
  const selected = useView((s) => s.selected);
  const blocks = useMemo(() => madeBlocks(model), [model]);
  const [scope, setScope] = useState<string>("design");
  const [editing, setEditing] = useState(false);
  const { access, fromBrief } = useAccess();
  const body = useRef<HTMLDivElement>(null);

  // a made part picked on the model opens its plan
  useEffect(() => {
    const p = model?.parts.find((x) => x.id === selected[0]);
    if (p && blocks.some((b) => b.name === p.name)) setScope(p.name);
  }, [selected]);
  // a part that went away falls back to the design
  const shown = scope !== "design" && !blocks.some((b) => b.name === scope) ? "design" : scope;

  if (!model) return <div className="mk-body mono dim">Building the design…</div>;
  if (!blocks.length)
    return (
      <div className="mk-body mk-empty">
        <Icon.Factory size={22} />
        <div>
          <b>Nothing to make yet.</b> Parts you model (not ones you buy) show here with the best way to make them at each quantity, and what they cost.
        </div>
      </div>
    );

  return (
    <div className="mk">
      <div className="mk-head">
        <div className="mk-scope" role="tablist" aria-label="Part">
          <button role="tab" aria-selected={shown === "design"} className={`an-pick ${shown === "design" ? "active" : ""}`} onClick={() => setScope("design")}>
            <Icon.Layers size={12} /> Whole design
          </button>
          {blocks.map((b) => (
            <button key={b.name} role="tab" aria-selected={shown === b.name} className={`an-pick ${shown === b.name ? "active" : ""}`} onClick={() => setScope(b.name)} onMouseEnter={() => useView.setState({ hovered: blockIds(b.name)[0] ?? null })} onMouseLeave={() => useView.setState({ hovered: null })}>
              {b.label}
              {b.count > 1 && <span className="val">×{b.count}</span>}
            </button>
          ))}
        </div>
        <div className="grow" />
        <button className={`btn sm ghost mk-access-btn ${editing ? "active" : ""}`} onClick={() => {
            setEditing(!editing);
            body.current?.scrollTo({ top: 0, behavior: "smooth" });
          }}
          aria-expanded={editing} data-tip={fromBrief ? "This design's brief sets which processes it can use" : "Your usual processes, from Settings"}>
          <Icon.Factory size={13} />
          Processes: {accessSummary(access)}
          {fromBrief && <span className="mk-tag">brief</span>}
        </button>
      </div>
      <div className="mk-body" ref={body}>
        <AnimatePresence initial={false}>
          {editing && (
            <motion.div className="mk-access" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }}>
              <div className="mk-access-in">
                <AccessEditor compact />
                <LabourField />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {shown === "design" ? <DesignView onPart={setScope} /> : <PartView key={shown} block={shown} />}
      </div>
    </div>
  );
}

function LabourField() {
  const labour = useSettings((s) => s.labourRate);
  return (
    <label className="mk-labour" data-tip="Used for your own machines and for assembling the design. Shops' rates are already in their prices.">
      <span>Your time is worth</span>
      <span className="mk-num">
        $
        <input type="number" min={0} max={500} step={1} value={labour} onChange={(e) => updateSettings({ labourRate: Math.min(500, Math.max(0, Number(e.target.value) || 0)) })} aria-label="Your hourly rate in dollars" />
        /h
      </span>
    </label>
  );
}

// ---------- one part ----------

function PartView({ block }: { block: string }) {
  const { data, busy, error } = usePartPlan(block);
  // hover by process, so a replanned part keeps showing the same route
  const [hoverId, setHoverId] = useState<ProcessId | null>(null);
  const hovered = data?.plan.routes.find((r) => r.process === hoverId) ?? null;
  const setHovered = (r: Route | null) => setHoverId(r?.process ?? null);
  const [tier, setTier] = useState<number | null>(null);

  // the model shows the hovered route's material and issues; leaving clears it
  useEffect(() => {
    if (data) previewRoute(block, hovered, data.fits);
  }, [hovered, data, block]);
  useEffect(() => () => previewRoute(block, null, {}), [block]);

  if (error) return <div className="mk-note fail">{error}</div>;
  if (!data) return <div className="mk-note mono dim">{busy ? "Working out how to make it…" : ""}</div>;
  const { plan } = data;
  const ti = tier ?? defaultTier(plan);
  const checking = busy || plan.routes.every((r) => !r.fit);

  return (
    <div className="mk-part">
      <div className="mk-basis">
        <span className="mk-title">{plan.label}</span>
        {plan.basis.map((b) => (
          <span key={b} className="mk-chip">
            {b}
          </span>
        ))}
        {checking && (
          <span className="mk-chip busy">
            <span className="spinner" style={{ width: 9, height: 9, borderWidth: 1.5 }} /> checking the shape against each process
          </span>
        )}
      </div>
      <div className="mk-tiers" style={{ gridTemplateColumns: `repeat(${plan.tiers.length}, minmax(0, 1fr))` }}>
        {plan.tiers.map((t, i) => (
          <TierCard key={t.qty} plan={plan} t={t} ti={i} block={block} active={i === ti} onPick={() => setTier(i)} onHover={setHovered} />
        ))}
      </div>
      <div className="mk-mid">
        <CostChart planned={data} hovered={hovered} onHoverRoute={setHovered} />
        <Bands plan={plan} />
      </div>
      <RoutesTable planned={data} block={block} ti={ti} onTier={setTier} hovered={hovered} onHover={setHovered} />
    </div>
  );
}

/** The brief's quantity when it has one, else the middle tier. */
const defaultTier = (plan: ManufacturingPlan) => {
  const b = plan.tiers.findIndex((t) => t.brief);
  return b >= 0 ? b : Math.floor((plan.tiers.length - 1) / 2);
};

const qtyText = (t: TierPlan, count: number) => `${t.qty.toLocaleString("en-US")} ${t.qty === 1 ? "design" : "designs"}${count > 1 ? ` · ${t.parts.toLocaleString("en-US")} parts` : ""}`;

function TierCard({ plan, t, ti, block, active, onPick, onHover }: { plan: ManufacturingPlan; t: TierPlan; ti: number; block: string; active: boolean; onPick: () => void; onHover: (r: Route | null) => void }) {
  const r = t.recommended;
  const c = r?.costs[ti];
  const alts: [string, Route][] = [];
  if (t.cheapest && t.cheapest !== r) alts.push(["Cheapest", t.cheapest]);
  if (t.best && t.best !== r && t.best !== t.cheapest) alts.push(["Best quality", t.best]);
  return (
    <motion.div layout="position" className={`mk-tier-card ${active ? "active" : ""} ${t.brief ? "is-brief" : ""}`} onClick={onPick} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 420, damping: 34, delay: ti * 0.04 }}>
      <div className="mk-tier-head">
        <span className="mk-tier-label">{t.label}</span>
        {t.brief && <span className="mk-tag">brief</span>}
        <span className="mk-tier-qty">{qtyText(t, plan.count)}</span>
      </div>
      {r && c ? (
        <div className="mk-pick" onMouseEnter={() => onHover(r)} onMouseLeave={() => onHover(null)}>
          <div className="mk-pick-row">
            <Swatch material={r.material} finish={r.finish} color={r.color} size={30} render={80} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="mk-pick-proc">{PROCESSES[r.process].label}</div>
              <div className="mk-pick-mat">
                {r.materialLabel}
                {c.access === "own" ? <span className="mk-tag own">yours</span> : r.access === "own" ? <span className="mk-tag" data-tip="Too many for your own machine in good time, so a shop makes them">ordered</span> : null}
              </div>
            </div>
          </div>
          <div className="mk-price">
            <b>{money(c.unit)}</b> <span>each</span>
          </div>
          <div className="mk-price-sub">
            {money(c.total)} for {t.parts.toLocaleString("en-US")} · {fmtDays(c.days)}
          </div>
          {c.tooling > 0 && <div className="mk-price-sub">incl. {money(c.tooling)} {c.toolingNote ?? "tooling"}</div>}
          {r.pros.length > 0 && (
            <div className="mk-pros">
              {r.pros.slice(0, 3).map((p) => (
                <span key={p}>{p}</span>
              ))}
            </div>
          )}
          <UseButton block={block} r={r} />
        </div>
      ) : (
        <div className="mk-none">No usable way to make it at this quantity.</div>
      )}
      {alts.map(([label, a]) => (
        <div key={label} className="mk-alt" onMouseEnter={() => onHover(a)} onMouseLeave={() => onHover(null)}>
          <span className="mk-alt-l">{label}</span>
          <b>{money(a.costs[ti]!.unit)}</b>
          <UseButton block={block} r={a} small />
          <span className="mk-alt-r" title={`${PROCESSES[a.process].label} in ${a.materialLabel}`}>
            {PROCESSES[a.process].short} · {a.materialLabel}
          </span>
        </div>
      ))}
      {t.hints.map((h) => (
        <div key={h} className="mk-hint">
          <Icon.Info size={11} /> {h}
        </div>
      ))}
    </motion.div>
  );
}

function UseButton({ block, r, small }: { block: string; r: Route; small?: boolean }) {
  const inUse = r.current && !r.materialChange;
  return (
    <button
      className={`btn sm ${small ? "ghost mk-use-sm" : "mk-use"}`}
      disabled={inUse}
      onClick={(e) => {
        e.stopPropagation();
        applyRoute(block, r);
      }}
      aria-label={`Make it by ${PROCESSES[r.process].label} in ${r.materialLabel}`}
    >
      {inUse ? "In use" : "Use"}
    </button>
  );
}

/** The cheapest usable way as the number of parts grows. */
function Bands({ plan }: { plan: ManufacturingPlan }) {
  if (!plan.bands.length) return null;
  const n = (q: number) => q.toLocaleString("en-US");
  return (
    <div className="mk-bands">
      <div className="mk-h">Cheapest way as the quantity grows</div>
      {plan.bands.map((b, i) => (
        <motion.div key={`${b.process}-${b.from}`} className="mk-band" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}>
          <span className="mk-band-q">{b.to !== undefined ? (b.to === b.from ? n(b.from) : `${n(b.from)}–${n(b.to)}`) : `${n(b.from)}+`}</span>
          <span className="mk-band-p">{PROCESSES[b.process].short}</span>
        </motion.div>
      ))}
      <div className="mk-fine">Parts, not designs. Estimates for comparing ways to make it; a real quote can land 0.6–2× from them.</div>
    </div>
  );
}

// ---------- every route ----------

const STATUS: Record<Route["status"], string> = { ok: "", "needs-changes": "needs design changes", unavailable: "not in your processes", "no-material": "no suitable material" };

function RoutesTable({ planned, block, ti, onTier, hovered, onHover }: { planned: PlannedPart; block: string; ti: number; onTier: (i: number) => void; hovered: Route | null; onHover: (r: Route | null) => void }) {
  const { plan } = planned;
  const [open, setOpen] = useState<string | null>(null);
  const drawn = useMemo(() => new Set(chartRoutes(plan)), [plan]);
  return (
    <div className="mk-routes">
      <div className="mk-h">Every way to make it</div>
      <table className="mk-table">
        <thead>
          <tr>
            <th>Process</th>
            <th>Material</th>
            <th>Shape</th>
            {plan.tiers.map((t, i) => (
              <th key={t.qty} className={`num ${i === ti ? "on" : ""}`}>
                <button className="mk-th" onClick={() => onTier(i)} data-tip={`Cost per part for ${qtyText(t, plan.count)}; click to show its breakdown`}>
                  {t.parts.toLocaleString("en-US")}
                </button>
              </th>
            ))}
            <th>Lead</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {plan.routes.map((r) => {
            const c = r.costs[ti];
            const key = r.process;
            const isOpen = open === key;
            return (
              <RouteRow key={key} r={r} c={c} ti={ti} plan={plan} block={block} open={isOpen} drawn={drawn.has(r)} hovered={hovered === r} onToggle={() => setOpen(isOpen ? null : key)} onHover={onHover} />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RouteRow({ r, c, ti, plan, block, open, drawn, hovered, onToggle, onHover }: { r: Route; c: CostEstimate | null; ti: number; plan: ManufacturingPlan; block: string; open: boolean; drawn: boolean; hovered: boolean; onToggle: () => void; onHover: (r: Route | null) => void }) {
  const fit = r.fit;
  const fitStatus = !fit ? "pending" : fit.fail ? "fail" : fit.warn ? "warn" : "pass";
  return (
    <>
      <tr className={`mk-row s-${r.status} ${r.current ? "current" : ""} ${hovered ? "hover" : ""} ${open ? "open" : ""}`} onMouseEnter={() => onHover(r)} onMouseLeave={() => onHover(null)} onClick={onToggle} aria-expanded={open}>
        <td>
          <span className="mk-proc">
            <Icon.Chevron size={10} className="mk-caret" />
            {PROCESSES[r.process].label}
            {r.current && <span className="mk-tag">now</span>}
            {r.access === "own" && <span className="mk-tag own">yours</span>}
            {drawn && <span className="mk-drawn" aria-label="drawn in the chart" />}
          </span>
          {STATUS[r.status] && <span className="mk-why">{STATUS[r.status]}</span>}
        </td>
        <td>
          <span className="mk-mat">
            <Swatch material={r.material} finish={r.finish} color={r.color} size={14} render={40} />
            {r.materialLabel}
            {r.materialChange && <span className="mk-change">change</span>}
          </span>
        </td>
        <td>
          <span className="mk-fit" data-tip={fit?.issues.slice(0, 4).join("\n") || (fit ? "Every check passes" : "Not checked yet")}>
            <StatusIcon status={fitStatus} />
            {fit ? (fit.fail ? `${fit.fail} fail` : fit.warn ? `${fit.warn} warn` : "fits") : ""}
          </span>
        </td>
        {r.costs.map((x, i) => (
          <td key={i} className={`num ${i === ti ? "on" : ""}`}>
            {x ? money(x.unit) : "–"}
          </td>
        ))}
        <td className="mk-lead">{c ? fmtDays(c.days) : ""}</td>
        <td onClick={(e) => e.stopPropagation()}>{r.status !== "no-material" && <UseButton block={block} r={r} small />}</td>
      </tr>
      {open && (
        <tr className="mk-detail">
          <td colSpan={5 + plan.tiers.length}>
            <RouteDetail r={r} c={c} t={plan.tiers[ti]} />
          </td>
        </tr>
      )}
    </>
  );
}

function RouteDetail({ r, c, t }: { r: Route; c: CostEstimate | null; t: TierPlan }) {
  return (
    <motion.div className="mk-detail-in" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}>
      <div className="mk-detail-col">
        <div className="mk-h">
          {t.parts.toLocaleString("en-US")} parts, {t.label.toLowerCase()}
        </div>
        {c ? (
          <>
            <table className="mk-lines">
              <tbody>
                {c.lines.map((l) => (
                  <tr key={l.label} data-tip={l.note}>
                    <td>{l.label}</td>
                    <td className="num">{money(l.amount)}</td>
                    <td className="mk-per">{l.oneTime ? "once" : "each"}</td>
                  </tr>
                ))}
                <tr className="sum">
                  <td>Each, with its share of setup{c.tooling ? " and tooling" : ""}</td>
                  <td className="num">{money(c.unit)}</td>
                  <td className="mk-per">
                    {money(c.range[0])}–{money(c.range[1])}
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="mk-fine">
              {c.hours > 0 && `${fmtHours(c.hours)} on the machine per part. `}
              {c.handsOn > 0 && r.access === "own" && `${fmtHours(c.handsOn / 60)} of your time per part. `}
              {fmtDays(c.days)} to parts in hand.
            </div>
            {c.notes.map((n) => (
              <div key={n} className="mk-fine">
                {n}
              </div>
            ))}
          </>
        ) : (
          <div className="mk-fine">No price: no material suits this part made this way.</div>
        )}
      </div>
      <div className="mk-detail-col">
        <div className="mk-h">
          {PROCESSES[r.process].label}: ±{r.tolerance} mm, {r.surface}
        </div>
        <ul className="mk-pc">
          {r.pros.map((p) => (
            <li key={p} className="pro">
              {p}
            </li>
          ))}
          {r.cons.map((p) => (
            <li key={p} className="con">
              {p}
            </li>
          ))}
        </ul>
        {r.fit && r.fit.issues.length > 0 && (
          <>
            <div className="mk-h">What the checks found (shown on the model while you hover)</div>
            <ul className="mk-issues">
              {r.fit.issues.slice(0, 6).map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </>
        )}
        <div className="mk-fine">{PROCESSES[r.process].bestFor ? `Best for ${PROCESSES[r.process].bestFor}.` : ""}</div>
      </div>
    </motion.div>
  );
}

