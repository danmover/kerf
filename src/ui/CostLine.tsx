// The line under each reply: which model answered and why, what the turn cost
// and what Kerf saved. A quick answer offers to ask the design model instead.

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { askDesignModel, modelLabel, useChat, type ChatItem } from "../ai/chat";
import type { SpendKind, TurnSpend } from "../ai/spend";
import { useSettings } from "../app/settings";
import { Icon } from "./icons";

type CostItem = Extract<ChatItem, { kind: "cost" }>;

/** Money at the scale one reply costs: 0.3¢, 31¢, $1.24. */
export function fmtCost(usd: number): string {
  const a = Math.abs(usd);
  const sign = usd < 0 ? "−" : "";
  if (a < 0.0005) return `${sign}<0.1¢`;
  if (a < 0.1) return `${sign}${(a * 100).toFixed(a < 0.01 ? 1 : 0)}¢`;
  if (a < 1) return `${sign}${Math.round(a * 100)}¢`;
  return `${sign}$${a.toFixed(2)}`;
}

/** Savings below this are noise, not worth a word. */
const NOTABLE = 0.001;

const KIND_LABEL: Record<SpendKind, string> = {
  chat: "Design work",
  quick: "Quick answer",
  router: "Choosing a model",
  escalated: "Handed over",
  review: "Self-review",
  agents: "Parallel agents",
  warm: "Kept the cache warm",
};
const KIND_ORDER: SpendKind[] = ["chat", "quick", "review", "agents", "router", "escalated", "warm"];

export function CostLine({ it }: { it: CostItem }) {
  const showCost = useSettings((s) => s.showCost);
  const designModel = useSettings((s) => s.model);
  const busy = useChat((s) => s.busy);
  // the quick answer can be asked again only while it is the latest turn
  const latest = useChat((s) => {
    const at = s.items.findIndex((i) => i.id === it.id);
    return at >= 0 && !s.items.slice(at + 1).some((i) => i.kind === "user" || i.kind === "cost" || i.kind === "choice");
  });
  const [open, setOpen] = useState(false);
  const r = it.route;
  const routed = r.quick || !!r.escalated;
  if (!showCost && !routed) return null;
  const canAsk = r.quick && !r.escalated && latest && !busy && !designModel.startsWith("claude-haiku");
  const saved = it.spend.saved;

  return (
    <motion.div className="cost-line" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <button className="cost-sum" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-tip={routeTip(it)} data-tip-pos="left">
        {r.quick && <Icon.Sparkle size={10} />}
        <span className="cost-model">
          {modelLabel(r.model)}
          {r.escalated && <> → {modelLabel(r.escalated.to)}</>}
        </span>
        {r.quick && !r.escalated && <span className="cost-why">{r.why}</span>}
        {r.escalated && <span className="cost-why">{r.escalated.why}</span>}
        {showCost && <span className="cost-usd">{fmtCost(it.spend.cost)}</span>}
        {showCost && saved >= NOTABLE && <span className="cost-saved">saved ~{fmtCost(saved)}</span>}
      </button>
      {canAsk && (
        <button className="cost-ask" onClick={() => void askDesignModel(it.id)} data-tip={`Answer this again with ${modelLabel(designModel)}, the model for design work`}>
          Ask {modelLabel(designModel)}
        </button>
      )}
      <AnimatePresence>{open && <Breakdown spend={it.spend} it={it} showCost={showCost} />}</AnimatePresence>
    </motion.div>
  );
}

function routeTip(it: CostItem) {
  const r = it.route;
  if (r.escalated) return `${modelLabel(r.model)} started this as a quick answer (${r.why}), then handed it to ${modelLabel(r.escalated.to)}: ${r.escalated.why}.`;
  if (r.quick) return `A quick answer: ${r.why}. ${modelLabel(r.model)} can only read the design; anything that changes it goes to the design model.`;
  return `${modelLabel(r.model)}: ${r.why}. Click for the breakdown.`;
}

function Breakdown({ spend, it, showCost }: { spend: TurnSpend; it: CostItem; showCost: boolean }) {
  const rows = KIND_ORDER.flatMap((k) => (spend.byKind[k] ?? []).map((l) => ({ k, ...l })));
  return (
    <motion.div className="cost-break" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
      <div className="cost-rows">
        {rows.map((row) => (
          <div key={row.k + row.model} className="cost-row">
            <span>{KIND_LABEL[row.k]}</span>
            <span className="dim">
              {modelLabel(row.model)} · {row.requests} {row.k === "warm" ? (row.requests === 1 ? "refresh" : "refreshes") : row.requests === 1 ? "request" : "requests"}
            </span>
            {showCost && <span className="mono">{fmtCost(row.cost)}</span>}
          </div>
        ))}
      </div>
      <div className="cost-note">
        {spend.cacheRead > 0 && <>{fmtTokens(spend.cacheRead)} tokens read back from the cache, </>}
        {fmtTokens(spend.output)} written.{" "}
        {showCost && Math.abs(spend.saved) >= NOTABLE && (
          <>
            {spend.saved > 0 ? `At least ${fmtCost(spend.saved)} less` : `${fmtCost(-spend.saved)} more`} than running all of it on {modelLabel(it.route.escalated?.to ?? (it.route.quick ? useSettings.getState().model : it.route.model))} with no keep-warm.
          </>
        )}
      </div>
    </motion.div>
  );
}

const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

/** What this conversation has cost so far, for the chat header. */
export function useChatSpend(): { cost: number; saved: number } {
  const items = useChat((s) => s.items);
  let cost = 0;
  let saved = 0;
  for (const i of items) {
    if (i.kind !== "cost") continue;
    cost += i.spend.cost;
    saved += i.spend.saved;
  }
  return { cost, saved };
}
