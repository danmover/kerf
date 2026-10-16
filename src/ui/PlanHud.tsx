// A pill over the 3D view while Claude works through its plan: which step it
// is on, what it is doing there, and where that sits in the plan. Hover to
// light up the step's parts; click to open the step in the plan.

import { AnimatePresence, motion } from "framer-motion";
import { useMemo } from "react";
import { usePlan, progress, planTree } from "../ai/plan";
import { useChat } from "../ai/chat";
import { revealStep, lightParts, unlightParts } from "./planUi";
import { StatusMark } from "./PlanPane";

export function PlanHud() {
  const plan = usePlan();
  const busy = useChat((s) => s.busy);
  const asking = useChat((s) => !!s.pendingChoice);
  const pr = useMemo(() => progress(plan), [plan]);
  const top = useMemo(() => planTree(plan).map((n) => n.step), [plan]);
  const cur = pr.current;
  const act = cur?.activity[cur.activity.length - 1];
  const show = !!cur && (busy || asking);
  const shown = busy ? "live" : "waiting";
  return (
    <AnimatePresence>
      {show && cur && (
        <motion.div
          key="hud"
          className={`plan-hud ${busy ? "" : "paused"}`}
          style={{ x: "-50%" }}
          initial={{ opacity: 0, y: 10, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.97 }}
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
          role="status"
          aria-live="polite"
          onClick={() => revealStep(cur.id)}
          onMouseEnter={() => lightParts(cur.parts)}
          onMouseLeave={unlightParts}
          data-tip="Show this step in the plan"
        >
          <StatusMark shown={shown} />
          <span className="hud-step">{pr.index >= 0 ? `step ${pr.index + 1}/${pr.total}` : "plan"}</span>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={cur.id} className="hud-title" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.16 }}>
              {cur.title}
            </motion.span>
          </AnimatePresence>
          {busy && act?.status === "running" && <span className="hud-sub">· {act.title.toLowerCase()}</span>}
          {!busy && <span className="hud-sub">· waiting for your answer</span>}
          {top.length <= 24 && (
            <span className="plan-segs" aria-hidden="true">
              {top.map((s) => (
                <span key={s.id} className={`seg ${s.status === "doing" ? shown : s.status}`} />
              ))}
            </span>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
