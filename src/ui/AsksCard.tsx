// What the user asked for in a message, as Kerf last measured it: a tick for
// each ask that holds, a cross for one that does not, a dot for one Kerf
// cannot measure (Claude and the reviewer check it), and the parts that
// changed though no ask names them.

import type { ChatItem } from "../ai/chat";
import type { AskStatus } from "../ai/asks";
import { Icon } from "./icons";

const LABEL: Record<AskStatus, string> = { pass: "Holds", fail: "Does not hold", open: "Not measured", error: "Could not be measured" };

export function AsksCard({ it }: { it: Extract<ChatItem, { kind: "asks" }> }) {
  const measured = it.asks.filter((a) => a.status === "pass" || a.status === "fail");
  const holding = measured.filter((a) => a.status === "pass").length;
  const summary = measured.length ? `${holding} of ${measured.length} measured hold` : "measured after each change";
  return (
    <div className={`asks-card ${it.asks.some((a) => a.status === "fail") ? "failing" : ""}`} role="group" aria-label="What you asked for">
      <div className="asks-head">
        <span>What you asked for</span>
        <span className="dim">{summary}</span>
      </div>
      <ul>
        {it.asks.map((a, i) => (
          <li key={i} className={`ask ${a.status}`}>
            <span className="ask-mark" role="img" aria-label={LABEL[a.status]} data-tip={LABEL[a.status]}>
              {a.status === "pass" ? <Icon.Check size={12} /> : a.status === "fail" ? <Icon.X size={12} /> : a.status === "error" ? <Icon.Alert size={12} /> : <span className="ask-dot" />}
            </span>
            <span className="ask-text">{a.ask}</span>
            {a.detail && <span className="ask-detail mono dim">{a.status === "error" ? "could not measure" : a.detail}</span>}
          </li>
        ))}
      </ul>
      {it.unasked.length > 0 && (
        <div className="asks-extra dim" data-tip="Parts that changed though nothing you asked for names them. Claude keeps a change like this only when an ask needs it.">
          Also changed: {it.unasked.slice(0, 8).join(", ")}
          {it.unasked.length > 8 ? ` and ${it.unasked.length - 8} more` : ""}
        </div>
      )}
    </div>
  );
}
