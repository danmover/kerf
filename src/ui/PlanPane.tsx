// The live plan: Claude's to-do tree, pinned above the chat. Shows the step
// Claude is on and what it is doing there, and lets the user rename,
// annotate, skip, reorder, add and pause on steps while it works.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  usePlan,
  planTree,
  progress,
  pendingSteering,
  pendingByScope,
  anyBranchOpen,
  userRename,
  userNote,
  userRemoveNote,
  userSkip,
  userRestore,
  userDoNext,
  userTogglePause,
  userRemove,
  userAdd,
  type PlanNode,
  type PlanStep,
  type PlanActivity,
  type Steer,
} from "../ai/plan";
import { useChat, applyPlanChangesNow, sendMessage, type ChatItem } from "../ai/chat";
import { diffStats, lineDiff } from "../core/sourceEdit";
import { usePlanUi, setPlanOpen, lightParts, unlightParts } from "./planUi";
import { Icon } from "./icons";
import { useTick } from "./common";
import "../styles/plan.css";

type Shown = "todo" | "live" | "paused" | "waiting" | "done" | "skipped" | "blocked";

function shownStatus(s: PlanStep, busy: boolean, asking: boolean): Shown {
  if (s.status !== "doing") return s.status;
  if (s.owner !== "main") return "live"; // a branch's agent runs on its own
  if (busy) return "live";
  return asking ? "waiting" : "paused";
}

export function PlanPane() {
  const plan = usePlan();
  const busy = useChat((s) => s.busy);
  const asking = useChat((s) => !!s.pendingChoice);
  const open = usePlanUi((s) => s.open);
  const tree = useMemo(() => planTree(plan), [plan]);
  const pr = useMemo(() => progress(plan), [plan]);
  const waiting = pendingSteering(plan);
  const scoped = pendingByScope(plan);
  // interrupting while sub-agents run would stop them, so their changes wait for their next step
  const agentsRunning = anyBranchOpen();
  const [adding, setAdding] = useState(false);
  // durations and "Claude has it" tags change by the second only while something is happening
  const recent = plan.steering.some((w) => !w.delivered || Date.now() - w.delivered < 7000);
  useTick(busy || recent ? 1000 : 60000);

  if (!plan.steps.length) return null;
  const remaining = plan.steps.some((s) => s.owner === "main" && s.kind === "step" && (s.status === "todo" || s.status === "doing"));
  const cur = pr.current;

  return (
    <motion.section className={`plan ${busy ? "is-busy" : ""}`} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} aria-label="Claude's plan">
      <button className="plan-head" onClick={() => setPlanOpen(!open)} aria-expanded={open}>
        <span className="plan-kicker">plan</span>
        <span className="plan-goal" title={plan.goal}>
          {plan.goal || "Claude's plan"}
        </span>
        <Segments plan={tree.map((n) => n.step)} busy={busy} asking={asking} />
        <span className="plan-count mono">
          {pr.done}/{pr.total}
        </span>
        <Icon.ChevronDown size={12} style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .2s", color: "var(--text-3)" }} />
      </button>

      {!open && cur && (
        <div className="plan-now" onMouseEnter={() => lightParts(cur.parts)} onMouseLeave={unlightParts}>
          <StatusMark shown={shownStatus(cur, busy, asking)} />
          <span className="grow">{busy ? <span className="shimmer-text">{cur.title}</span> : cur.title}</span>
        </div>
      )}

      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="plan-body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}>
            <ul className="plan-tree" role="tree">
              <AnimatePresence initial={false}>
                {tree.map((n) => (
                  <StepItem key={n.step.id} node={n} busy={busy} asking={asking} steering={plan.steering} />
                ))}
              </AnimatePresence>
            </ul>
            {adding ? (
              <InlineInput
                className="plan-add-input"
                placeholder="A step for Claude to add, e.g. “Add a lanyard hole”"
                onDone={(t) => {
                  if (t) userAdd({}, t);
                  setAdding(false);
                }}
              />
            ) : (
              <button className="plan-add" onClick={() => setAdding(true)}>
                <Icon.Plus size={12} /> Add a step
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {waiting.length > 0 ? (
          <motion.div key="steer" className="plan-steer" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18 }}>
            <span className="steer-dot" />
            <span className="grow">
              {waiting.length} change{waiting.length > 1 ? "s" : ""} for Claude
              <span className="dim"> · {busy ? (scoped.main ? "picked up after the current action" : "each agent picks up its own at its next step") : asking ? "sent with your answer" : "sent with your next message"}</span>
            </span>
            {/* with a question open, the changes go along with the answer; sending them now would answer it */}
            {((!busy && !asking) || (busy && scoped.main > 0 && !agentsRunning)) && (
              <button className="btn sm" onClick={() => void applyPlanChangesNow()} data-tip={busy ? "Stop the current response and continue with your changes" : "Send your changes to Claude now"}>
                {busy ? "Apply now" : "Send now"}
              </button>
            )}
          </motion.div>
        ) : (
          !busy &&
          !asking &&
          remaining && (
            <motion.div key="resume" className="plan-steer resume" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18 }}>
              <Icon.Pause size={11} />
              <span className="grow">
                {plan.pausedAfter ? (
                  <>
                    Paused for your review after <b>{plan.pausedAfter}</b>
                  </>
                ) : cur ? (
                  <>
                    Stopped at <b>{cur.title}</b>
                  </>
                ) : (
                  "Steps left to do"
                )}
              </span>
              <button className="btn sm primary" onClick={() => void sendMessage("Continue with the plan.")}>
                <Icon.Play size={10} /> Continue
              </button>
            </motion.div>
          )
        )}
      </AnimatePresence>
    </motion.section>
  );
}

/** One bar per top-level step, coloured by status; the live one glows. */
function Segments({ plan, busy, asking }: { plan: PlanStep[]; busy: boolean; asking: boolean }) {
  if (plan.length > 24) return null;
  return (
    <span className="plan-segs" aria-hidden="true">
      {plan.map((s) => (
        <span key={s.id} className={`seg ${shownStatus(s, busy, asking)}`} />
      ))}
    </span>
  );
}

function StepItem({ node, busy, asking, steering }: { node: PlanNode; busy: boolean; asking: boolean; steering: Steer[] }) {
  const s = node.step;
  const shown = shownStatus(s, busy, asking);
  const [mode, setMode] = useState<null | "rename" | "note" | "add">(null);
  const [open, setOpen] = useState(shown === "live");
  const [showDiff, setShowDiff] = useState(false);
  const reveal = usePlanUi((u) => u.reveal);
  const row = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  const before = useRef(shown);

  // follow the work: open a step when Claude starts it, fold it shortly after it is done
  useEffect(() => {
    const was = before.current;
    before.current = shown;
    if (shown === "live" && was !== "live") {
      setOpen(true);
      row.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    if (shown === "done" && was === "live") {
      const t = setTimeout(() => setOpen(false), 1600);
      return () => clearTimeout(t);
    }
  }, [shown]);
  useEffect(() => {
    if (reveal?.id !== s.id) return;
    setOpen(true);
    row.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(t);
  }, [reveal, s.id]);

  const mine = steering.filter((w) => w.stepId === s.id && w.kind !== "note");
  const last = mine[mine.length - 1];
  const fresh = last && (!last.delivered || Date.now() - last.delivered < 6000);
  const ended = s.status === "done" || s.status === "skipped";
  const isRoot = s.kind !== "step";
  const hasMore = s.activity.length > 0 || s.notes.length > 0 || node.children.length > 0 || !!s.detail;
  const edits = useStepEdits(s.activity);

  return (
    <motion.li className={`ps ${shown} ${isRoot ? "root" : ""} ${flash ? "flash" : ""}`} role="treeitem" aria-expanded={hasMore ? open : undefined} layout="position" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18 }}>
      <div
        ref={row}
        className="ps-row"
        tabIndex={0}
        onMouseEnter={() => lightParts(s.parts)}
        onMouseLeave={unlightParts}
        onFocus={() => lightParts(s.parts)}
        onBlur={unlightParts}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button,input,textarea")) return;
          if (hasMore) setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") (e.preventDefault(), hasMore && setOpen((o) => !o));
          else if (e.key === "F2" && !ended) (e.preventDefault(), setMode("rename"));
          else if (e.key.toLowerCase() === "n") (e.preventDefault(), setMode("note"));
        }}
      >
        <StatusMark shown={shown} kind={s.kind} />
        <div className="ps-main">
          {mode === "rename" ? (
            <InlineInput
              initial={s.title}
              placeholder="What this step should do"
              onDone={(t) => {
                if (t) userRename(s.id, t);
                setMode(null);
              }}
            />
          ) : (
            <span
              className="ps-title"
              onDoubleClick={() => !ended && setMode("rename")}
              title={s.renamedFrom ? `You renamed this. Claude had: “${s.renamedFrom}”` : undefined}
            >
              {shown === "live" ? <span className="shimmer-text">{s.title}</span> : s.title}
            </span>
          )}
          <span className="ps-tags">
            {isRoot && s.agent && <span className="ps-tag agent">{s.kind === "review" ? "review" : s.agent}</span>}
            {s.by === "you" && <span className="ps-tag you">yours</span>}
            {s.renamedFrom && <span className="ps-tag you">edited</span>}
            {s.pauseAfter && !ended && (
              <span className="ps-tag pause" data-tip="Claude stops here for your review">
                <Icon.Pause size={8} /> pause after
              </span>
            )}
            {shown === "waiting" && <span className="ps-tag warn">needs your answer</span>}
            {fresh && <SteerTag steer={last} />}
            {isRoot && s.meta && <span className="ps-tag meta mono">{s.meta}</span>}
            {edits && (
              <button className="ps-tag diff mono" onClick={() => (setOpen(true), setShowDiff((d) => !d))} data-tip="What this step changed">
                <span style={{ color: "var(--pass)" }}>+{edits.added}</span> <span style={{ color: "var(--fail)" }}>−{edits.removed}</span>
              </button>
            )}
          </span>
        </div>
        <Duration s={s} />
        <div className="ps-actions" role="group" aria-label="Change this step">
          {!ended && (
            <ActBtn tip="Rename (F2)" onClick={() => setMode("rename")}>
              <Icon.Edit size={12} />
            </ActBtn>
          )}
          <ActBtn tip="Note for Claude (N)" onClick={() => (setOpen(true), setMode("note"))}>
            <NoteIcon />
          </ActBtn>
          {s.status === "todo" && (
            <ActBtn tip="Do this next" onClick={() => userDoNext(s.id)}>
              <UpIcon />
            </ActBtn>
          )}
          {s.status !== "skipped" && (
            <ActBtn tip={s.pauseAfter ? "Don't stop after this step" : "Stop after this step so I can review"} on={!!s.pauseAfter} onClick={() => userTogglePause(s.id)}>
              <Icon.Pause size={11} />
            </ActBtn>
          )}
          <ActBtn tip="Add a step after this" onClick={() => setMode("add")}>
            <Icon.Plus size={12} />
          </ActBtn>
          {s.status === "skipped" ? (
            <ActBtn tip="Do this after all" onClick={() => userRestore(s.id)}>
              <Icon.Undo size={12} />
            </ActBtn>
          ) : s.by === "you" ? (
            <ActBtn tip="Remove your step" onClick={() => userRemove(s.id)}>
              <Icon.X size={12} />
            </ActBtn>
          ) : (
            s.status !== "done" && (
              <ActBtn tip="Skip this step" onClick={() => userSkip(s.id)}>
                <SkipIcon />
              </ActBtn>
            )
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {(open || mode === "note") && (
          <motion.div className="ps-more" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.16 }}>
            {s.detail && <div className="ps-detail">{s.detail}</div>}
            {s.notes.map((n) => {
              const st = steering.find((w) => w.noteId === n.id);
              return (
                <div key={n.id} className="ps-note">
                  <NoteIcon />
                  <span className="grow">{n.text}</span>
                  <span className={`ps-note-state ${st?.delivered ? "seen" : "waiting"}`}>{st?.delivered ? "Claude has it" : "waiting"}</span>
                  {!st?.delivered && (
                    <button className="ps-x" aria-label="Withdraw note" onClick={() => userRemoveNote(s.id, n.id)}>
                      <Icon.X size={10} />
                    </button>
                  )}
                </div>
              );
            })}
            {mode === "note" && (
              <InlineInput
                multiline
                placeholder="Tell Claude something about this step…"
                onDone={(t) => {
                  if (t) userNote(s.id, t);
                  setMode(null);
                }}
              />
            )}
            {s.activity.length > 0 && (
              <ul className="ps-activity">
                {s.activity.slice(open ? -12 : -3).map((a) => (
                  <ActivityLine key={a.id} a={a} />
                ))}
              </ul>
            )}
            {showDiff && edits && <StepDiff before={edits.before} after={edits.after} />}
          </motion.div>
        )}
      </AnimatePresence>

      {node.children.length > 0 && open && (
        <ul className="ps-children" role="group">
          <AnimatePresence initial={false}>
            {node.children.map((c) => (
              <StepItem key={c.step.id} node={c} busy={busy} asking={asking} steering={steering} />
            ))}
          </AnimatePresence>
        </ul>
      )}
      {node.children.length > 0 && !open && <ChildSummary node={node} />}

      {mode === "add" && (
        <InlineInput
          className="plan-add-input"
          placeholder="New step after this one"
          onDone={(t) => {
            if (t) userAdd({ after: s.id }, t);
            setMode(null);
          }}
        />
      )}
    </motion.li>
  );
}

function ChildSummary({ node }: { node: PlanNode }) {
  const all = node.children.map((c) => c.step).filter((s) => s.status !== "skipped");
  const done = all.filter((s) => s.status === "done").length;
  return (
    <div className="ps-fold mono">
      {done}/{all.length} sub-steps
    </div>
  );
}

function SteerTag({ steer }: { steer: Steer }) {
  const label: Record<Steer["kind"], string> = { rename: "renamed", note: "note", add: "added", skip: "skip", restore: "restored", next: "do next", pause: "pause", unpause: "no pause", remove: "removed", design: "edit" };
  return (
    <motion.span className={`ps-tag steer ${steer.delivered ? "seen" : ""}`} initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} data-tip={steer.delivered ? "Claude has your change" : "Claude picks this up after its current action"}>
      {steer.delivered ? <Icon.Check size={9} /> : <span className="steer-dot" />}
      {steer.delivered ? "Claude has it" : `${label[steer.kind]} · waiting`}
    </motion.span>
  );
}

function ActivityLine({ a }: { a: PlanActivity }) {
  const item = useChat((s) => (a.itemId ? (s.items.find((i) => i.id === a.itemId) as Extract<ChatItem, { kind: "tool" }> | undefined) : undefined));
  const status = item?.status ?? a.status;
  const title = item && item.status !== "running" ? item.title : a.title;
  const stats = item?.diff ? diffStats(item.diff.before, item.diff.after) : null;
  return (
    <motion.li className={`pa ${status}`} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }}>
      <span className="pa-mark">{status === "running" ? <span className="spinner xs" /> : status === "error" ? <Icon.Alert size={10} /> : <Icon.Check size={10} />}</span>
      <span className="grow pa-title">{status === "running" ? <span className="shimmer-text">{title}</span> : title}</span>
      {stats && (
        <span className="mono pa-stats">
          <span style={{ color: "var(--pass)" }}>+{stats.added}</span> <span style={{ color: "var(--fail)" }}>−{stats.removed}</span>
        </span>
      )}
    </motion.li>
  );
}

/** Source before the step's first edit and after its last. */
function useStepEdits(activity: PlanActivity[]) {
  const items = useChat((s) => s.items);
  return useMemo(() => {
    const ids = new Set(activity.map((a) => a.itemId).filter(Boolean));
    const diffs = items.filter((i): i is Extract<ChatItem, { kind: "tool" }> => i.kind === "tool" && ids.has(i.id) && !!i.diff && i.status !== "error").map((i) => i.diff!);
    if (!diffs.length) return null;
    const before = diffs[0].before;
    const after = diffs[diffs.length - 1].after;
    if (before === after) return null;
    return { before, after, ...diffStats(before, after) };
  }, [activity, items]);
}

function StepDiff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => lineDiff(before, after, 1), [before, after]);
  return (
    <div className="ps-diff">
      {lines.slice(0, 160).map((l, i) => (
        <div key={i} className={`ln ${l.kind}`}>
          <span className="n">{l.b ?? l.a ?? ""}</span>
          <span>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
          <span>{l.text}</span>
        </div>
      ))}
    </div>
  );
}

function Duration({ s }: { s: PlanStep }) {
  if (!s.startedAt) return <span className="ps-time" />;
  const end = s.endedAt ?? (s.status === "doing" ? Date.now() : undefined);
  if (!end) return <span className="ps-time" />;
  const sec = Math.max(0, Math.round((end - s.startedAt) / 1000));
  return <span className="ps-time mono">{sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}`}</span>;
}

export function StatusMark({ shown, kind }: { shown: Shown; kind?: PlanStep["kind"] }) {
  return (
    <span className={`ps-mark ${shown}`} aria-label={shown}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={shown} className="ps-mark-in" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={{ type: "spring", stiffness: 520, damping: 26 }}>
          {shown === "done" ? (
            <Icon.Check size={11} strokeWidth={2.4} />
          ) : shown === "skipped" ? (
            <SkipIcon />
          ) : shown === "blocked" || shown === "waiting" ? (
            <Icon.Alert size={11} />
          ) : shown === "paused" ? (
            <Icon.Pause size={8} />
          ) : kind === "review" ? (
            <Icon.Eye size={11} />
          ) : kind === "agent" ? (
            <Icon.Layers size={11} />
          ) : null}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function ActBtn({ tip, onClick, children, on }: { tip: string; onClick: () => void; children: ReactNode; on?: boolean }) {
  return (
    <button className={`ps-act ${on ? "on" : ""}`} onClick={onClick} data-tip={tip} aria-label={tip} aria-pressed={on}>
      {children}
    </button>
  );
}

function InlineInput({ initial = "", placeholder, onDone, multiline, className }: { initial?: string; placeholder: string; onDone: (text: string | null) => void; multiline?: boolean; className?: string }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (t: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(t?.trim() ? t.trim() : null);
  };
  const props = {
    autoFocus: true,
    value: v,
    placeholder,
    className: `ps-input ${className ?? ""}`,
    maxLength: multiline ? 1000 : 140,
    "aria-label": placeholder,
    onChange: (e: { target: { value: string } }) => setV(e.target.value),
    onBlur: () => finish(v),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), finish(null));
      else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), finish(v));
    },
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => e.target.select(),
  };
  return multiline ? <textarea rows={2} {...props} /> : <input {...props} />;
}

const NoteIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <path d="M8 9h8M8 13h5" />
  </svg>
);
const SkipIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m5 5 9 7-9 7z" />
    <path d="M19 5v14" />
  </svg>
);
const UpIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 19V6M6 11l6-6 6 6" />
    <path d="M5 21h14" />
  </svg>
);
