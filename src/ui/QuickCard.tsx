// A plain command done at once, without Claude ("fillet 2", "hole M3 here"):
// what it did, an Undo, and a way to ask Claude instead. If the part no
// longer builds afterwards, it says why and offers Claude's help.

import { motion } from "framer-motion";
import { useChat, askClaudeInstead, undoQuick, type ChatItem } from "../ai/chat";
import { useDesign } from "../core/engine";
import { hoverParts } from "../app/view";
import { useApiKey } from "./ChatPanel";
import { Icon } from "./icons";

type QuickItem = Extract<ChatItem, { kind: "quick" }>;

export function QuickCard({ it, compact }: { it: QuickItem; compact?: boolean }) {
  const busy = useChat((s) => s.busy);
  const hasKey = !!useApiKey();
  const current = useDesign((s) => s.source === it.after);
  const canUndo = !it.undone && !it.plain && current;
  return (
    <motion.div className={`quick-card ${it.failed && !it.undone ? "failed" : ""} ${compact ? "compact" : ""}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} onMouseLeave={() => hoverParts([])}>
      <div className="quick-bar">
        <Icon.Bolt size={12} className="bolt" />
        <span className="grow" style={{ minWidth: 0 }}>
          <span className={it.undone ? "undone" : ""}>{it.title}</span>
          {it.undone && <span className="dim"> · undone</span>}
        </span>
        {canUndo && (
          <button className="btn sm ghost" disabled={busy} onClick={() => undoQuick(it.id)} data-tip="Undo this change">
            <Icon.Undo size={12} /> Undo
          </button>
        )}
      </div>
      {it.failed && !it.undone ? (
        <div className="quick-detail fail">
          It no longer builds: {it.failed}
          {hasKey && (
            <button className="btn sm" disabled={busy} onClick={() => askClaudeInstead(it.id, true)} style={{ marginLeft: 8 }}>
              <Icon.Sparkle size={11} /> Ask Claude to fix it
            </button>
          )}
        </div>
      ) : (
        !compact && (it.detail || (!it.plain && hasKey)) && (
          <div className="quick-detail">
            {it.detail && <span>{it.detail} </span>}
            {!it.plain && hasKey && !it.undone && (
              <button className="link-btn" disabled={busy} onClick={() => askClaudeInstead(it.id)} data-tip="Undo this and send the same words to Claude, who can read the design and do something smarter">
                Ask Claude instead
              </button>
            )}
          </div>
        )
      )}
    </motion.div>
  );
}
