// Claude's material comparison in the chat: the best few options with their
// deciding numbers, each one click from being applied, and a way to see them
// all on the model.

import { useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { useMaterials } from "../../materials/store";
import { select } from "../../app/view";
import { editBrief } from "../briefEdit";
import { Icon } from "../icons";
import { applyOption, blockIds, OptionCard, previewOption } from "./parts";
import type { MaterialOption } from "../../materials/advise";

export function MaterialAdviceCard({ toolUseId, fallback }: { toolUseId: string; fallback: ReactNode }) {
  const snap = useMaterials((s) => s.byTool[toolUseId]);
  const [used, setUsed] = useState<string | null>(null);
  if (!snap) return <>{fallback}</>;
  const { advice, part } = snap;
  const usable = advice.options.filter((o) => o.verdict !== "unsuitable");
  const top = usable.filter((o) => !o.otherWay).slice(0, 3);
  const other = usable.filter((o) => o.otherWay).slice(0, top.length ? 1 : 3);
  const cur = advice.options.find((o) => o.current);
  const shown = [...top, ...other];
  if (cur && !shown.includes(cur)) shown.push(cur);
  const out = advice.options.filter((o) => o.verdict === "unsuitable" && !shown.includes(o));
  const ids = part ? blockIds(part) : [];
  const use = (o: MaterialOption) => {
    if (part) {
      if (applyOption(part, o)) setUsed(o.name);
    } else if (editBrief((d) => void ((d.material = o.name), (d.assumed = d.assumed.filter((k) => k !== "material"))), `material ${o.name}`)) setUsed(o.name);
  };
  return (
    <motion.div className="mo-chat" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} layout="position">
      <div className="mo-chat-head">
        <Icon.Material size={14} style={{ color: "var(--accent-2)" }} />
        <span className="grow">
          Materials for <b>{advice.subject}</b>
        </span>
        {part && (
          <button
            className="btn sm ghost"
            onClick={() => {
              select(ids);
              useMaterials.getState().compare(part);
            }}
            data-tip="Line the materials up on the model and preview each one"
          >
            <Icon.Compare size={12} /> Compare on model
          </button>
        )}
      </div>
      {advice.basis.length > 0 && <div className="mo-basis">{advice.basis.join(" · ")}</div>}
      <div className="mo-list">
        {shown.map((o, i) => (
          <div key={o.name} className="mo-list-item">
            {o.otherWay && !shown[i - 1]?.otherWay && i > 0 && <div className="mo-list-label">Made another way</div>}
            <OptionCard o={{ ...o, current: used ? o.name === used : o.current }} layout="row" onHover={(on) => part && previewOption(ids, on ? o : null)} onUse={() => use(o)} />
          </div>
        ))}
      </div>
      {out.length > 0 && (
        <div className="mo-out" data-tip={out.map((o) => `${o.label}: ${o.criteria.filter((k) => k.grade === "fail").map((k) => k.why).join("; ")}`).join("\n")}>
          Ruled out: {out.slice(0, 6).map((o) => o.label.replace(/ \(.*\)$/, "")).join(", ")}
          {out.length > 6 ? ` and ${out.length - 6} more` : ""}
        </div>
      )}
    </motion.div>
  );
}
