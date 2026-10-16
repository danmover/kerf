// A parallel build in the chat: the plan to review (editable, with its cost),
// then each subassembly agent working live, then the merged result.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAgents, isLive, type AgentBranch, type AgentRunTree, type BranchStatus, type CrossIssue } from "../../agents/progress";
import { approveRun, cancelReview, editBranch, reviseSubassembly, setRunBudget, setRunModel, steerAgent, stopAgent, stopRun } from "../../agents/orchestrator";
import { waves } from "../../agents/plan";
import { fmtUsd } from "../../agents/pricing";
import { LAYOUT, INTEGRATION } from "../../agents/sections";
import { MODELS } from "../../app/settings";
import { useView, select } from "../../app/view";
import { useChat } from "../../ai/chat";
import { useChatDraft } from "../chatDraft";
import { usePlan } from "../../ai/plan";
import { branchRootId } from "../../agents/planBranches";
import { revealStep } from "../planUi";
import { Icon } from "../icons";
import { useTick } from "../common";
import "./agents.css";

export function AgentRunCard({ toolUseId, fallback }: { toolUseId: string; fallback: ReactNode }) {
  const run = useAgents((s) => (s.run?.toolUseId === toolUseId ? s.run : (s.history.find((r) => r.toolUseId === toolUseId) ?? null)));
  if (!run) return <>{fallback}</>;
  return <RunView run={run} />;
}

/** The same view for a run that did not come from the chat (a revision from the card). */
export function RunView({ run }: { run: AgentRunTree }) {
  const review = run.status === "review";
  return (
    <motion.div className={`agent-run ${run.status}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} layout="position">
      <RunHead run={run} />
      {run.goal && review && <div className="ar-goal">{run.goal}</div>}
      <WaveStrip run={run} />
      <div className="ar-branches">
        {run.branches.map((b, i) => (review ? <ReviewBranch key={b.id} b={b} i={i} /> : <BranchRow key={b.id} b={b} run={run} i={i} />))}
      </div>
      {review && <ReviewFoot run={run} />}
      {!review && <Results run={run} />}
    </motion.div>
  );
}

// ---------- header ----------

const STATUS_LABEL: Record<AgentRunTree["status"], string> = {
  review: "review",
  running: "running",
  integrating: "merging",
  done: "done",
  stopped: "stopped",
  failed: "failed",
  cancelled: "cancelled",
};

function RunHead({ run }: { run: AgentRunTree }) {
  const live = run.status === "running" || run.status === "integrating";
  useTick(live ? 1000 : 60_000);
  const secs = ((run.endedAt ?? Date.now()) - (run.startedAt ?? run.createdAt)) / 1000;
  const frac = Math.min(1, run.cost / Math.max(run.budget, 0.01));
  const done = run.branches.filter((b) => b.status === "done").length;
  const included = run.branches.filter((b) => b.include).length;
  return (
    <div className="ar-head">
      <div className="ar-kicker">
        <ForkIcon />
        <span>{run.mode === "revise" ? "REVISION" : "PARALLEL BUILD"}</span>
        <span className={`ar-state ${run.status}`}>{STATUS_LABEL[run.status]}</span>
        <div className="grow" />
        {run.status === "review" ? (
          <span className="mono ar-cost" data-tip="Estimated cost of this run at your API rates">
            ≈ {fmtUsd(run.estimate.low)}–{fmtUsd(run.estimate.high)}
          </span>
        ) : (
          <span className="mono ar-cost" data-tip={`Spent so far · estimate ${fmtUsd(run.estimate.low)}–${fmtUsd(run.estimate.high)} · cap ${fmtUsd(run.budget)}`}>
            {fmtUsd(run.cost)}
            <span className="dim"> / {fmtUsd(run.budget)}</span>
          </span>
        )}
      </div>
      <div className="ar-title">
        <span>{run.title}</span>
        {run.status !== "review" && (
          <span className="mono dim ar-meta">
            {done}/{included} · {fmtDuration(secs)}
          </span>
        )}
        {live && (
          <button className="btn sm ghost ar-stop" onClick={stopRun} data-tip="Stop every agent. Work so far is kept.">
            <Icon.Stop size={11} /> Stop
          </button>
        )}
      </div>
      {run.status !== "review" && (
        <div className="ar-budget" aria-hidden>
          <motion.div className={`ar-budget-fill ${frac > 0.85 ? "hot" : ""}`} animate={{ width: `${frac * 100}%` }} transition={{ type: "spring", stiffness: 120, damping: 20 }} />
          <div className="ar-budget-est" style={{ left: `${Math.min(1, run.estimate.high / Math.max(run.budget, 0.01)) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

// ---------- the dependency strip: waves of agents that run together ----------

function WaveStrip({ run }: { run: AgentRunTree }) {
  const cols = useMemo(() => {
    const subs = run.branches.filter((b) => b.include).map((b) => ({ id: b.id, name: b.title, brief: b.brief, after: b.after, uses: b.uses }));
    try {
      return waves(subs);
    } catch {
      return [subs.map((s) => s.id)];
    }
  }, [run.branches]);
  if (run.branches.length < 2) return null;
  const byId = new Map(run.branches.map((b) => [b.id, b]));
  return (
    <div className="ar-waves" role="img" aria-label="Which subassemblies run together">
      <div className="ar-wave layout">
        <span className="ar-node layout">
          <span className="ar-glyph">◇</span> layout
        </span>
      </div>
      {cols.map((col, i) => (
        <div className="ar-wave-wrap" key={i}>
          <svg className="ar-link" width="18" height="10" viewBox="0 0 18 10" aria-hidden>
            <path d="M1 5h14m-4-3 4 3-4 3" />
          </svg>
          <div className="ar-wave">
            {col.map((id) => {
              const b = byId.get(id)!;
              return (
                <HoverParts key={id} ids={b.partIds}>
                  <span className={`ar-node ${b.status}`} data-tip={b.after.length ? `After ${b.after.join(", ")}` : "Starts right away"}>
                    <StatusDot s={b.status} /> {b.title}
                  </span>
                </HoverParts>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- review ----------

function ReviewBranch({ b, i }: { b: AgentBranch; i: number }) {
  const [open, setOpen] = useState(false);
  return (
    <motion.div className={`ar-branch review ${b.include ? "" : "off"}`} initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.04 * i }}>
      <div className="ar-row">
        <button className={`ar-check ${b.include ? "on" : ""}`} role="checkbox" aria-checked={b.include} aria-label={`Build ${b.title}`} onClick={() => editBranch(b.id, { include: !b.include })}>
          {b.include && <Icon.Check size={11} />}
        </button>
        <input className="ar-name" value={b.title} maxLength={80} onChange={(e) => editBranch(b.id, { title: e.target.value })} aria-label="Subassembly name" />
        <span className="mono dim ar-id">{b.id}</span>
        {b.revising && <span className="chip">revise</span>}
        <button className="icon-btn sm" onClick={() => setOpen((o) => !o)} aria-label={open ? "Hide brief" : "Edit brief"} data-tip={open ? "Hide brief" : "Edit the brief"}>
          <Icon.Edit size={12} />
        </button>
      </div>
      {open ? (
        <AutoText value={b.brief} onChange={(v) => editBranch(b.id, { brief: v })} label={`Brief for ${b.title}`} />
      ) : (
        <div className="ar-brief" onClick={() => setOpen(true)}>
          {b.brief}
        </div>
      )}
      {(b.after.length > 0 || b.uses.length > 0) && (
        <div className="ar-tags">
          {b.after.map((a) => (
            <span key={a} className="chip">
              after {a}
            </span>
          ))}
          {b.uses.slice(0, 6).map((u) => (
            <span key={u} className="chip accent">
              {u}
            </span>
          ))}
        </div>
      )}
    </motion.div>
  );
}

function ReviewFoot({ run }: { run: AgentRunTree }) {
  const n = run.branches.filter((b) => b.include).length;
  const [budget, setBudget] = useState(String(run.budget));
  useEffect(() => setBudget(String(run.budget)), [run.budget]);
  return (
    <div className="ar-foot">
      {run.warnings.length > 0 && (
        <div className="ar-warn">
          {run.warnings.map((w) => (
            <div key={w}>
              <Icon.Alert size={11} /> {w}
            </div>
          ))}
        </div>
      )}
      <div className="ar-opts">
        <label className="ar-opt">
          <span>Agents use</span>
          <select value={run.model} onChange={(e) => setRunModel(e.target.value)} aria-label="Model for the agents">
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label.replace("Claude ", "")}
              </option>
            ))}
          </select>
        </label>
        <label className="ar-opt">
          <span>Cap</span>
          <span className="ar-money">
            $
            <input
              value={budget}
              inputMode="decimal"
              aria-label="Spending cap for this run in dollars"
              onChange={(e) => setBudget(e.target.value)}
              onBlur={() => {
                const v = Number(budget);
                if (Number.isFinite(v) && v > 0) setRunBudget(v);
                else setBudget(String(run.budget));
              }}
            />
          </span>
        </label>
      </div>
      <div className="ar-actions">
        <button className="btn sm primary" disabled={!n} onClick={approveRun}>
          <ForkIcon /> Start {n} agent{n === 1 ? "" : "s"}
        </button>
        <button className="btn sm ghost" onClick={cancelReview}>
          Cancel
        </button>
        <div className="grow" />
        <span className="dim ar-fine">Agents stop at the cap. Edit names and briefs before you start.</span>
      </div>
    </div>
  );
}

// ---------- running and done ----------

function BranchRow({ b, run, i }: { b: AgentBranch; run: AgentRunTree; i: number }) {
  const [open, setOpen] = useState(false);
  const live = isLive(run);
  // the agent's steps and tool calls live in the plan tree; older runs kept them here
  const inPlan = usePlan((p) => p.steps.some((s) => s.id === branchRootId(b.id)));
  const working = b.status === "running" || b.status === "queued" || b.status === "waiting";
  if (!b.include) return null;
  return (
    <motion.div className={`ar-branch ${b.status} ${open ? "open" : ""}`} initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.03 * i }} layout="position">
      <HoverParts ids={b.partIds}>
        <div className="ar-row clickable" onClick={() => setOpen((o) => !o)} role="button" aria-expanded={open}>
          <StatusDot s={b.status} />
          <span className="ar-bname">{b.title}</span>
          <span className="grow ar-activity">{b.status === "running" ? <span className="shimmer-text">{b.activity ?? "Working"}</span> : b.status === "waiting" ? b.activity : null}</span>
          {b.checks && <CheckChip c={b.checks} />}
          <span className="mono dim ar-bcost">{b.cost > 0 ? fmtUsd(b.cost) : ""}</span>
          <Icon.ChevronDown size={12} style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .15s", color: "var(--text-3)" }} />
        </div>
      </HoverParts>
      {b.status === "running" && <div className="ar-progress" />}
      {!open && b.summary && !working && <div className="ar-summary clamp">{b.summary}</div>}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="ar-detail" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <div className="ar-brief small">{b.brief}</div>
            {!inPlan && b.steps.length > 0 && (
              <ol className="ar-steps">
                {b.steps.map((s) => (
                  <li key={s.id} className={s.status}>
                    {s.status === "running" ? <div className="spinner" /> : s.status === "error" ? <Icon.Alert size={11} /> : <Icon.Check size={11} />}
                    <span className="grow">
                      {s.title}
                      {s.detail && <span className="ar-step-detail">{s.detail}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {b.requests.map((q) => (
              <div key={q.id} className="ar-request">
                <span className="mono">asks {q.target}:</span> {q.change}
                <div className="dim">{q.reason}</div>
              </div>
            ))}
            {b.notes.map((n) => (
              <div key={n.ts} className="ar-note">
                <span className="mono">{n.delivered ? "you said" : "queued"}</span> {n.text}
              </div>
            ))}
            {b.summary && !working && <div className="ar-summary">{b.summary}</div>}
            <div className="ar-row ar-tools">
              {b.partIds.length > 0 && (
                <button className="btn sm ghost" onClick={() => select(b.partIds)} data-tip="Select this subassembly's parts in the 3D view">
                  <Icon.Target size={12} /> {b.partIds.length} part{b.partIds.length === 1 ? "" : "s"}
                </button>
              )}
              {inPlan && (
                <button className="btn sm ghost" onClick={() => revealStep(branchRootId(b.id))} data-tip="This agent's steps and what it is doing, in the plan above the chat">
                  <PlanIcon /> Steps in the plan
                </button>
              )}
              <div className="grow" />
              {working && live && (
                <button className="btn sm ghost" onClick={() => stopAgent(b.id)}>
                  <Icon.Stop size={11} /> Stop agent
                </button>
              )}
            </div>
            {working && live ? <NoteBox id={b.id} /> : !live && <ReviseBox b={b} parent={run.parentRunId ?? run.runId} />}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function NoteBox({ id }: { id: string }) {
  const [text, setText] = useState("");
  const send = () => {
    if (!text.trim()) return;
    steerAgent(id, text);
    setText("");
  };
  return (
    <div className="ar-input">
      <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Add a note for this agent…" maxLength={2000} aria-label="Note for this agent" />
      <button className="btn sm" onClick={send} disabled={!text.trim()} aria-label="Send note">
        <Icon.Send size={12} />
      </button>
    </div>
  );
}

function ReviseBox({ b, parent }: { b: AgentBranch; parent: string }) {
  const [text, setText] = useState("");
  const chatBusy = useChat((s) => s.busy);
  const anyLive = useAgents((s) => isLive(s.run));
  const blocked = chatBusy || anyLive;
  const send = () => {
    if (!text.trim() || blocked) return;
    void reviseSubassembly(b.id, text, parent);
    setText("");
  };
  return (
    <div className="ar-input">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && send()}
        placeholder={blocked ? "Wait for Claude to finish…" : `Ask the ${b.title} agent for a change…`}
        maxLength={2000}
        disabled={blocked}
        aria-label={`Change request for ${b.title}`}
      />
      <button className="btn sm" onClick={send} disabled={!text.trim() || blocked} data-tip="Runs this subassembly's agent alone, then re-checks the whole design">
        <Icon.Sparkle size={12} />
      </button>
    </div>
  );
}

function Results({ run }: { run: AgentRunTree }) {
  const draft = useChatDraft((s) => s.set);
  const cross = run.issues.filter((i) => i.owners.length > 1);
  const other = run.issues.filter((i) => i.owners.length <= 1);
  const requests = run.branches.flatMap((b) => b.requests);
  const current = useAgents((s) => s.run);
  const history = useAgents((s) => s.history);
  const revisionRuns = useMemo(() => (run.mode === "build" ? [current, ...history].filter((r): r is AgentRunTree => !!r && r.parentRunId === run.runId).sort((a, b) => a.createdAt - b.createdAt) : []), [current, history, run.mode, run.runId]);
  return (
    <>
      {run.status === "integrating" && (
        <div className="ar-merge">
          <div className="spinner" /> <span className="shimmer-text">Merging the sections and checking the whole design</span>
        </div>
      )}
      {run.note && <div className="ar-notice">{run.note}</div>}
      {run.integratedChecks && (
        <div className="ar-integrated">
          <span className="ar-label">Whole design</span>
          <CheckChip c={run.integratedChecks} />
        </div>
      )}
      {(cross.length > 0 || requests.length > 0 || other.length > 0) && (
        <div className="ar-issues">
          {cross.map((i) => (
            <Issue key={i.id} i={i} run={run} onAsk={() => draft(`Resolve "${i.title}" between ${i.owners.map(ownerName(run)).join(" and ")}.`)} />
          ))}
          {requests.map((q) => (
            <div key={q.id} className="ar-issue request">
              <div className="ar-issue-head">
                <span className="chip accent">request</span>
                <span className="grow">
                  {ownerName(run)(q.from)} → {ownerName(run)(q.target)}
                </span>
                <button className="btn sm ghost" onClick={() => draft(`About ${ownerName(run)(q.from)}'s request to change ${ownerName(run)(q.target)} (${q.change}): `)}>
                  Discuss
                </button>
              </div>
              <div>{q.change}</div>
              <div className="dim">{q.reason}</div>
            </div>
          ))}
          {other.slice(0, 6).map((i) => (
            <Issue key={i.id} i={i} run={run} onAsk={() => draft(`Fix "${i.title}" in ${ownerName(run)(i.owners[0] ?? LAYOUT)}.`)} />
          ))}
        </div>
      )}
      {revisionRuns.map((r) => (
        <Revision key={r.runId} run={r} />
      ))}
    </>
  );
}

function Revision({ run }: { run: AgentRunTree }) {
  const ref = useRef<HTMLDivElement>(null);
  const startedLive = useRef(isLive(run));
  // a revision asked for from a row opens below it, often out of view
  useEffect(() => {
    if (startedLive.current) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  return (
    <div ref={ref} className="ar-revision">
      <RunView run={run} />
    </div>
  );
}

function Issue({ i, run, onAsk }: { i: CrossIssue; run: AgentRunTree; onAsk: () => void }) {
  return (
    <HoverParts ids={i.parts}>
      <div className={`ar-issue ${i.status}`}>
        <div className="ar-issue-head">
          <span className={`chip ${i.status}`}>{i.owners.length > 1 ? "between" : i.status}</span>
          <span className="grow">{i.title}</span>
          <button className="btn sm ghost" onClick={onAsk} data-tip="Start a message to Claude about this">
            Ask Claude
          </button>
        </div>
        <div className="dim">
          {i.detail}
          {i.owners.length > 0 && <> · {i.owners.map(ownerName(run)).join(" ↔ ")}</>}
        </div>
      </div>
    </HoverParts>
  );
}

const ownerName = (run: AgentRunTree) => (o: string) => (o === LAYOUT || o === "layout" ? "the layout" : o === INTEGRATION || o === "integration" ? "integration" : (run.branches.find((b) => b.id === o)?.title ?? o));

// ---------- small pieces ----------

/** Hovering highlights a subassembly's parts in the 3D view. */
function HoverParts({ ids, children }: { ids: string[]; children: ReactNode }) {
  const set = useRef(false);
  useEffect(
    () => () => {
      if (set.current) useView.setState({ focusParts: [] });
    },
    [],
  );
  return (
    <div
      className="ar-hover"
      onMouseEnter={() => {
        if (!ids.length) return;
        set.current = true;
        useView.setState({ focusParts: ids });
      }}
      onMouseLeave={() => {
        if (!set.current) return;
        set.current = false;
        useView.setState({ focusParts: [] });
      }}
    >
      {children}
    </div>
  );
}

function StatusDot({ s }: { s: BranchStatus }) {
  return <span className={`ar-dot ${s}`} aria-label={s} />;
}

function CheckChip({ c }: { c: { pass: number; fail: number; warn: number } }) {
  return (
    <span className={`chip ${c.fail ? "fail" : c.warn ? "warn" : "pass"}`}>
      {c.fail ? `${c.fail} fail` : c.warn ? `${c.warn} warn` : `${c.pass} pass`}
    </span>
  );
}

function AutoText({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(220, el.scrollHeight + 2) + "px";
  }, [value]);
  return <textarea ref={ref} className="ar-brief-edit" value={value} maxLength={4000} onChange={(e) => onChange(e.target.value)} aria-label={label} autoFocus />;
}

function PlanIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M3 3.5h10M5.5 8H13M8 12.5h5" />
      <circle cx="3" cy="8" r=".6" fill="currentColor" />
      <circle cx="5.5" cy="12.5" r=".6" fill="currentColor" />
    </svg>
  );
}

function ForkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="12" r="2.2" />
      <path d="M6 7.2v9.6M6 12h4a4 4 0 0 0 4-4V9.5M10 12a4 4 0 0 1 4 4v-1" />
    </svg>
  );
}

function fmtDuration(s: number) {
  if (s < 60) return `${Math.max(0, Math.round(s))}s`;
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}
