// The AI chat panel: conversation, live tool activity, choices and diffs.

import { AnimatePresence, motion } from "framer-motion";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { create } from "zustand";
import { useChat, sendMessage, stop, retryLast, clearChat, addMidRun, withdrawMidRun, sendQueuedNow, type ChatItem } from "../ai/chat";
import { usePlan, messageState, anyBranchOpen } from "../ai/plan";
import { useAgents, isLive } from "../agents/progress";
import { ChoiceCard } from "./ChoiceCard";
import { ChangeCard } from "./ChangeCard";
import { QuickCard } from "./QuickCard";
import { DiffView } from "./DiffView";
import { openSpot, spotLabel } from "../app/spot";
import { safeUrl, domainOf } from "../ai/web";
import { getApiKey, subscribeKey } from "../persist/vault";
import { getOpenAIKey, subscribeOpenAIKey } from "../persist/openaiVault";
import { useAccount } from "../cloud/account";
import { useSettings, updateSettings, MODELS, SPEEDS } from "../app/settings";
import { openSettings, confirmDialog, toast } from "../app/ui";
import { useProject } from "../app/project";
import { audienceById, templateById, TEMPLATES } from "../demos/templates";
import { desktop } from "../app/desktop";
import { diffStats } from "../core/sourceEdit";
import { useDesign } from "../core/engine";
import { describeQuick } from "../core/quickCommands";
import { quickCommandOf } from "../app/quickRun";
import { useView, select } from "../app/view";
import { Markdown } from "./Markdown";
import { Icon } from "./icons";
import { Menu, MenuItem, mod } from "./common";
import { useChatDraft, askClaude } from "./chatDraft";
import { feedRows, fmtDur, thoughtSections, type LogSummary, type StepMark } from "./chatFeed";
import { LogoMark } from "./Logo";
import { MicButton, VoiceBar, VoiceNotice, useVoiceInput } from "./voice/VoiceInput";
import { AgentRunCard } from "./agents/AgentRunCard";
import { MaterialAdviceCard } from "./materials/AdviceCard";
import { PlanPane } from "./PlanPane";
import { ReviewCard } from "./ReviewCard";
import { AsksCard } from "./AsksCard";
import { AttachButton, MessageFiles, PendingFiles, useAttachments } from "./Attachments";
import { useStickToBottom } from "./useStickToBottom";
import { CostLine, fmtCost, useChatSpend } from "./CostLine";

/** A touch screen has no right click: there, pressing and holding the model opens the spot chat. */
const touchScreen = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

/** The browser's key, or "account" when chat goes through a Kerf server that holds the key. */
export function useApiKey() {
  const key = useSyncExternalStore(subscribeKey, getApiKey);
  const openAIKey = useSyncExternalStore(subscribeOpenAIKey, getOpenAIKey);
  const openAI = useSettings(s => s.model.startsWith("gpt-"));
  const viaAccount = useAccount((s) => s.status === "signed-in" && !!s.info?.claude?.source);
  if (openAI) return openAIKey;
  return key ?? (viaAccount ? "account" : null);
}

export function ChatPanel() {
  const items = useChat((s) => s.items);
  const busy = useChat((s) => s.busy);
  const key = useApiKey();
  const feed = useRef<HTMLDivElement>(null);
  const lastUser = useMemo(() => [...items].reverse().find((i) => i.kind === "user")?.id, [items]);
  const stick = useStickToBottom(feed, lastUser);
  const rows = useMemo(() => feedRows(items, busy), [items, busy]);
  const opened = useLogs((s) => s.open);
  // the newest turn's work log is open; earlier ones fold to their summary line unless opened
  const lastTurn = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind === "log") return rows[i].turn;
    return null;
  }, [rows]);
  const isOpen = (turn: string) => opened[turn] ?? turn === lastTurn;
  const settings = useSettings();
  const model = MODELS.find((m) => m.id === settings.model)!;
  const spend = useChatSpend();
  const routes = settings.routeQuick && settings.model.startsWith("claude-") && !settings.model.startsWith("claude-haiku");

  useLayoutEffect(() => {
    const el = feed.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  return (
    <div className="panel panel-right">
      <div className="panel-head">
        <LogoMark size={18} animate={false} />
        <span className="panel-title">{settings.model.startsWith("gpt-") ? "OpenAI" : "Claude"}</span>
        <Menu
          align="left"
          width={290}
          trigger={(open, toggle) => (
            <button className={`chip ${open ? "accent" : ""}`} style={{ cursor: "pointer" }} onClick={toggle} aria-label="Choose model">
              {model.label.replace("Claude ", "")} · {settings.effort}
              {routes && <span className="dim"> · auto</span>} <Icon.ChevronDown size={11} />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="menu-label">Model</div>
              {MODELS.map((m) => (
                <MenuItem
                  key={m.id}
                  icon={settings.model === m.id ? <Icon.Check size={14} /> : undefined}
                  onClick={() => {
                    updateSettings({ model: m.id });
                    close();
                  }}
                >
                  <div>
                    <div>{m.label}</div>
                    <div className="dim" style={{ fontSize: 11 }}>
                      {m.note}
                    </div>
                  </div>
                </MenuItem>
              ))}
              <div className="menu-sep" />
              <div className="menu-label">Effort</div>
              {(["low", "medium", "high", "xhigh", "max"] as const).map((e) => (
                <MenuItem
                  key={e}
                  icon={settings.effort === e ? <Icon.Check size={14} /> : undefined}
                  onClick={() => {
                    updateSettings({ effort: e });
                    close();
                  }}
                  hint={e === "high" ? "default" : undefined}
                >
                  {e}
                </MenuItem>
              ))}
              <div className="menu-sep" />
              <MenuItem
                icon={settings.routeQuick ? <Icon.Check size={14} /> : undefined}
                onClick={() => {
                  updateSettings({ routeQuick: !settings.routeQuick });
                  close();
                }}
              >
                <div>
                  <div>Quick questions on Haiku 5.5</div>
                  <div className="dim" style={{ fontSize: 11 }}>
                    Anything that changes the design stays on {model.label.replace("Claude ", "")}.
                  </div>
                </div>
              </MenuItem>
            </>
          )}
        </Menu>
        <div className="grow" />
        {settings.showCost && spend.cost > 0 && (
          <button
            className="chip cost-total"
            onClick={() => openSettings("ai")}
            data-tip={`This conversation so far: ${fmtCost(spend.cost)}${spend.saved >= 0.001 ? `, at least ${fmtCost(spend.saved)} less than running it all on the design model with no keep-warm` : ""}. Click for cost settings.`}
          >
            {fmtCost(spend.cost)}
          </button>
        )}
        <button
          className="icon-btn sm"
          disabled={!items.length || busy}
          data-tip="Clear conversation"
          aria-label="Clear conversation"
          onClick={async () => {
            if (await confirmDialog({ title: "Clear this conversation?", body: "Claude forgets the chat history for this project. Your design and its versions are not affected.", confirm: "Clear chat" })) void clearChat();
          }}
        >
          <Icon.Trash size={14} />
        </button>
        <button className="icon-btn sm" onClick={() => openSettings("ai")} data-tip="AI settings" aria-label="AI settings">
          <Icon.Settings size={14} />
        </button>
      </div>

      <div className="chat">
        <PlanPane />
        <div className="chat-feed" ref={feed} aria-live="polite">
          {!items.length && <Welcome hasKey={!!key} />}
          {rows.map((r) =>
            r.kind === "log" ? (
              <LogHead key={`log-${r.turn}`} turn={r.turn} summary={r.summary} open={isOpen(r.turn)} />
            ) : !r.step || isOpen(r.turn) ? (
              <FeedItem key={r.it.id} it={r.it} step={r.step} last={!!r.lastStep} />
            ) : null,
          )}
          <Suggestions items={items} busy={busy} />
          <JumpToLatest feed={feed} stick={stick} items={items} />
        </div>
        <Composer busy={busy} hasKey={!!key} />
      </div>
    </div>
  );
}

function Welcome({ hasKey }: { hasKey: boolean }) {
  const project = useProject((s) => s.current);
  const audience = useSettings((s) => s.audience);
  const t = templateById(project?.template ?? "") ?? TEMPLATES[0];
  // a blank design suggests briefs for what the user said they make
  const prompts = t.id === "blank" ? (audienceById(audience)?.briefs ?? t.prompts) : t.prompts;
  if (!hasKey)
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="card" style={{ padding: 18 }}>
        <div className="row" style={{ marginBottom: 8, color: "var(--accent-2)" }}>
          <Icon.Key size={18} />
          <span style={{ fontWeight: 600, color: "var(--text)" }}>Connect an AI model to design by conversation</span>
        </div>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          Add a Claude or OpenAI API key in Settings → AI, then choose a model.{desktop() ? " On a Claude Pro or Max plan, you can let your own Claude Code design here instead, from the same page." : ""} Everything else (the modelling tools, checks, analyses and exports) works without a key.
        </div>
        <button className="btn primary" style={{ marginTop: 14 }} onClick={() => openSettings("ai")}>
          <Icon.Key size={14} /> Add API key
        </button>
      </motion.div>
    );
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>What should we build?</div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
        Describe the part or mechanism, give the dimensions that matter, and say what must stay fixed. Claude edits the design, runs every check and tells you what changed.
      </div>
      <div className="suggestions">
        {prompts.map((p, i) => (
          <motion.button key={p} className="suggestion" onClick={() => void sendMessage(p)} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.08 * i + 0.1 }}>
            <Icon.Sparkle size={12} /> {p}
          </motion.button>
        ))}
      </div>
    </motion.div>
  );
}

/** Which turns' work logs the reader opened or closed by hand (the newest is open until they close it). */
const useLogs = create<{ open: Record<string, boolean> }>(() => ({ open: {} }));
const setLogOpen = (turn: string, open: boolean) => useLogs.setState((s) => ({ open: { ...s.open, [turn]: open } }));

/**
 * One row of the feed. Items never change in place (the chat replaces an item
 * when it changes), so a row redraws only when its own item does: while
 * Claude streams, only the bubble it is writing into redraws, however long
 * the chat.
 */
const FeedItem = memo(function FeedItem({ it, step, last }: { it: ChatItem; step: boolean; last: boolean }) {
  return (
    <div className={`feed-row${step ? " step" : ""}${last ? " last" : ""}${step && it.kind === "tool" && it.status === "running" ? " live" : ""}`} data-kind={it.kind}>
      {step ? it.kind === "tool" ? <ToolStep it={it} /> : it.kind === "assistant" ? <ThoughtStep it={it} /> : <Item it={it} /> : <Item it={it} />}
    </div>
  );
});

const MARK_TIP: Record<StepMark, string> = { done: "done", error: "did not work", running: "running", thought: "thought" };

/** The line above a turn's steps: how long Claude worked and what it did, which opens and closes the steps. */
function LogHead({ turn, summary: s, open }: { turn: string; summary: LogSummary; open: boolean }) {
  const secs = useElapsed(s.from, s.running);
  const took = s.running ? secs * 1000 : s.from !== undefined && s.to !== undefined ? s.to - s.from : NaN;
  const parts = [`${s.steps} step${s.steps === 1 ? "" : "s"}`, s.edits ? `${s.edits} edit${s.edits === 1 ? "" : "s"}` : "", s.errors ? `${s.errors} failed` : ""].filter(Boolean);
  // a long log shows the newest marks
  const marks = s.marks.length > 28 ? s.marks.slice(-28) : s.marks;
  return (
    <div className={`feed-row log-row${s.running ? " live" : ""}`}>
      <button className="log-head" onClick={() => setLogOpen(turn, !open)} aria-expanded={open} data-tip={open ? "Hide the steps" : "Show every step Claude took"} data-tip-pos="top">
        <span className="log-icon">{s.running ? <span className="spinner sm" /> : <Icon.Steps size={13} />}</span>
        <span className="log-title">{s.running ? <span className="shimmer-text">Working</span> : Number.isFinite(took) && took > 0 ? `Worked for ${fmtDur(took)}` : "Worked"}</span>
        {s.running && secs >= 1 && <span className="log-time mono">{fmtDur(secs * 1000)}</span>}
        <span className="log-meta">{parts.join(" · ")}</span>
        <span className="log-marks" aria-hidden="true">
          {marks.map((m, i) => (
            <i key={i} className={`m-${m}`} title={MARK_TIP[m]} />
          ))}
        </span>
        <span className="grow" />
        <span className="log-toggle">
          {open ? "hide" : "show"}
          <Icon.ChevronDown size={11} style={{ transform: open ? "rotate(180deg)" : undefined }} />
        </span>
      </button>
      {s.running && !open && s.now && <div className="log-now shimmer-text">{s.now}</div>}
    </div>
  );
}

/** Scrolled up while Claude writes: a button back to the newest, which shows when something new arrived below. */
function JumpToLatest({ feed, stick, items }: { feed: React.RefObject<HTMLDivElement | null>; stick: React.MutableRefObject<boolean>; items: ChatItem[] }) {
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(false);
  useEffect(() => {
    const el = feed.current;
    if (!el) return;
    const on = () => {
      const a = el.scrollHeight - el.scrollTop - el.clientHeight > 160;
      setAway(a);
      if (!a) setUnseen(false);
    };
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, [feed]);
  useEffect(() => {
    if (!stick.current) setUnseen(true);
  }, [items, stick]);
  if (!away) return null;
  return (
    <div className="jump-wrap">
      <button
        className={`jump-latest${unseen ? " unseen" : ""}`}
        onClick={() => {
          const el = feed.current;
          if (!el) return;
          stick.current = true;
          el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        }}
        aria-label="Jump to the newest message"
      >
        <Icon.ArrowDown size={13} /> {unseen ? "New below" : "Latest"}
      </button>
    </div>
  );
}

function Item({ it }: { it: ChatItem }) {
  switch (it.kind) {
    case "user":
      return (
        <div className="msg-user feed-in">
          {it.optionsFirst && (
            <span className="opts-tag" data-tip="You asked Claude to show you options before it builds">
              <Icon.Fork size={10} /> options first
            </span>
          )}
          <MessageFiles files={it.files} />
          {it.spot && (
            <button
              className="spot-chip"
              onClick={() => {
                if (useDesign.getState().model?.parts.some((p) => p.id === it.spot!.partId)) {
                  select([it.spot!.partId]);
                  openSpot(it.spot!);
                }
              }}
              data-tip="The spot this is about. Click to show it."
            >
              <Icon.Pin size={11} /> {spotLabel(it.spot)}
            </button>
          )}
          {it.image && <img className="mark-img" src={it.image} alt="Your marked-up view" />}
          {it.text}
          {it.midRun && <MidRun id={it.id} />}
        </div>
      );
    case "assistant":
      return <AssistantMsg it={it} />;
    case "tool":
      if (it.name === "compare_materials" && it.status === "done") return <MaterialAdviceCard toolUseId={it.toolUseId} fallback={<ToolCard it={it} />} />;
      return it.name === "build_subassemblies" ? <AgentRunCard toolUseId={it.toolUseId} fallback={<ToolCard it={it} />} /> : <ToolCard it={it} />;
    case "choice":
      return <ChoiceCard it={it} />;
    case "notice":
      return (
        <div className={`notice ${it.level} feed-in`}>
          <div className="t">{it.title}</div>
          {it.detail && <div className="d">{it.detail}</div>}
          {it.action && (
            <div className="row" style={{ marginTop: 8 }}>
              {it.action === "settings" && (
                <button className="btn sm" onClick={() => openSettings("ai")}>
                  <Icon.Settings size={13} /> Open settings
                </button>
              )}
              {it.action === "retry" && (
                <button className="btn sm" onClick={() => void retryLast()}>
                  <Icon.Refresh size={13} /> Try again
                </button>
              )}
              {it.action === "continue" && (
                <button className="btn sm" onClick={() => void sendMessage("Continue with the plan.", { design: true })}>
                  <Icon.Play size={11} /> Continue
                </button>
              )}
            </div>
          )}
        </div>
      );
    case "turn":
      return <ChangeCard it={it} />;
    case "quick":
      return <QuickCard it={it} />;
    case "review":
      return <ReviewCard it={it} />;
    case "suggest":
      return null;
    case "asks":
      return <AsksCard it={it} />;
    case "cost":
      return <CostLine it={it} />;
  }
}

/** How hard Claude works on the next message: Quick, Normal or Thorough. */
function SpeedMenu() {
  const speed = useSettings((s) => s.speed);
  const current = SPEEDS.find((x) => x.value === speed) ?? SPEEDS[1];
  return (
    <Menu
      align="right"
      width={260}
      trigger={(open, toggle) => (
        <button className={`chip speed-chip ${speed !== "normal" ? "accent" : ""} ${open ? "open" : ""}`} onClick={toggle} aria-label={`Speed: ${current.label}`} data-tip={current.d} data-tip-pos="top">
          {speed === "quick" && <Icon.Bolt size={11} />}
          {current.label} <Icon.ChevronDown size={10} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-label">Speed</div>
          {SPEEDS.map((x) => (
            <MenuItem
              key={x.value}
              icon={speed === x.value ? <Icon.Check size={14} /> : undefined}
              onClick={() => {
                updateSettings({ speed: x.value });
                close();
              }}
            >
              <div>
                <div>{x.label}</div>
                <div className="dim" style={{ fontSize: 11 }}>
                  {x.d}
                </div>
              </div>
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
}

/** Claude's suggested follow-ups, as chips after its latest reply until the user sends something. */
function Suggestions({ items, busy }: { items: ChatItem[]; busy: boolean }) {
  let last: Extract<ChatItem, { kind: "suggest" }> | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user" || it.kind === "choice") break;
    if (it.kind === "suggest") {
      last = it;
      break;
    }
  }
  if (!last || busy) return null;
  return <SuggestionChips options={last.options} />;
}

export function SuggestionChips({ options, onSend }: { options: { label: string; prompt: string }[]; onSend?: (prompt: string) => void }) {
  return (
    <div className="suggest feed-in">
      <span className="mono dim">next</span>
      {options.map((o, i) => (
        <button
          key={o.label}
          className="suggest-chip"
          style={{ animationDelay: `${0.05 * i}s` }}
          // shift-click puts it in the message box to change before sending
          onClick={(e) => (e.shiftKey && !onSend ? askClaude(o.prompt) : onSend ? onSend(o.prompt) : void sendMessage(o.prompt))}
          data-tip={`${o.prompt}${onSend ? "" : " · Shift-click to edit it first"}`}
          data-tip-pos="top"
        >
          <Icon.Sparkle size={11} /> {o.label}
        </button>
      ))}
    </div>
  );
}

/** Beside Send: Claude shows two to four ways to do it, to pick from before it builds anything. */
function OptionsFirst() {
  const on = useSettings((s) => s.optionsFirst);
  return (
    <button
      className={`chip opts-chip ${on ? "accent" : ""}`}
      onClick={() => updateSettings({ optionsFirst: !on })}
      aria-pressed={on}
      data-tip={on ? "Options first is on: Claude lays out two to four ways to do it, you pick one (and can preview each in 3D), then it builds. Click to turn off." : "Options first: have Claude lay out two to four ways to do it for you to pick, before it builds anything"}
      data-tip-pos="top"
    >
      <Icon.Fork size={11} />
      <span className="opts-label">Options</span>
    </button>
  );
}

/** The newest part of Claude's summarised thinking, as plain text cut at a word: what it is working on right now. */
export function thinkingTail(text: string, max = 280): string {
  const plain = text
    .replace(/\*\*|__|`/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*(#+|[-*])\s+/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" · ");
  if (plain.length <= max) return plain;
  const tail = plain.slice(-max);
  const space = tail.indexOf(" ");
  return `…${space >= 0 && space < 30 ? tail.slice(space + 1) : tail}`;
}

/** Whole seconds since `from`, counting while `on`. */
function useElapsed(from: number | undefined, on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return from ? Math.max(0, Math.floor((now - from) / 1000)) : 0;
}

/** What Claude is doing in the current run, for the line under the message box. */
function currentActivity(items: ChatItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") break;
    if (it.kind === "tool" && it.status === "running") return it.title;
    if (it.kind === "review" && it.status === "running") return "Reviewing the design";
    if (it.kind === "assistant" && it.streaming) return it.text ? "Writing" : "Thinking";
  }
  return "";
}

/** The reply after a turn's last step: how long Claude thought (open it to read the thinking), then what it wrote. */
function AssistantMsg({ it }: { it: Extract<ChatItem, { kind: "assistant" }> }) {
  return (
    <div className="msg-assistant feed-in">
      {(it.thinking || (it.streaming && !it.text) || it.thoughtMs) && <ThinkingLine it={it} />}
      {it.text && (
        <div>
          <Markdown text={it.text} />
          {it.streaming && <span className="caret" />}
        </div>
      )}
      {!it.streaming && !!it.sources?.length && <Sources sources={it.sources} />}
      {it.note && (
        <div className="mono dim" style={{ fontSize: 10.5, marginTop: 4 }}>
          {it.note}
        </div>
      )}
      {!it.streaming && it.text.trim() && <CopyReply text={it.text} />}
    </div>
  );
}

/** Copy a reply as written (Markdown), shown when the pointer is over it. */
function CopyReply({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="reply-copy"
      onClick={() =>
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
          .catch(() => toast({ kind: "warn", title: "Could not copy", detail: "The browser blocked the clipboard." }))
      }
      aria-label="Copy this reply"
      data-tip={done ? "Copied" : "Copy this reply"}
      data-tip-pos="left"
    >
      {done ? <Icon.Check size={12} /> : <Icon.Copy size={12} />}
    </button>
  );
}

/**
 * Claude's thinking as one line: live, the heading it is on and its newest
 * words; done, how long it thought and the headings it went through. Opens
 * to the whole summary, section by section.
 */
function ThinkingLine({ it, step }: { it: Extract<ChatItem, { kind: "assistant" }>; step?: boolean }) {
  const [open, setOpen] = useState(false);
  const live = it.streaming && !it.text && it.thoughtMs === undefined;
  const secs = useElapsed(it.started, live);
  const sections = useMemo(() => thoughtSections(it.thinking), [it.thinking]);
  const titles = sections.map((x) => x.title).filter(Boolean);
  const current = live ? titles[titles.length - 1] : undefined;
  const can = !!it.thinking.trim();
  const took = it.thoughtMs !== undefined ? fmtDur(it.thoughtMs) : "";
  return (
    <div className={`thought${step ? " in-step" : ""}${live ? " live" : ""}`}>
      <button className="thinking-toggle" onClick={() => can && setOpen((o) => !o)} aria-expanded={can ? open : undefined} disabled={!can && !live}>
        {can && <Icon.Chevron size={10} style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform .15s" }} />}
        {live ? (
          <>
            <span className="shimmer-text">{current ?? "Thinking"}</span>
            {secs >= 2 && <span className="dim">{secs} s</span>}
          </>
        ) : (
          <>
            <span>{took ? `Thought for ${took}` : "Thought process"}</span>
            {!open && titles.length > 0 && <span className="th-titles">{titles.join(" · ")}</span>}
          </>
        )}
      </button>
      {/* while it thinks, the newest of its reasoning shows as it streams, so a long think does not look idle */}
      {live && !open && it.thinking.trim() && (
        <div className="thinking-live" aria-live="polite">
          <div>{thinkingTail(sections.length ? sections[sections.length - 1].body || it.thinking : it.thinking)}</div>
        </div>
      )}
      {open && can && (
        <div className="thinking feed-in">
          {sections.map((x, i) => (
            <div key={i} className="th-sec">
              {x.title && <div className="th-title">{x.title}</div>}
              {x.body && <Markdown text={x.body} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A turn's thinking or note between its steps, on the work log's line. */
function ThoughtStep({ it }: { it: Extract<ChatItem, { kind: "assistant" }> }) {
  const hasThought = !!it.thinking.trim() || it.thoughtMs !== undefined || (it.streaming && !it.text);
  return (
    <div className="step-body">
      <span className={`step-node ${it.text.trim() && !hasThought ? "note" : "thought"}`} aria-hidden="true">
        {it.text.trim() && !hasThought ? <Icon.Chat size={10} /> : <Icon.Bulb size={10} />}
      </span>
      {hasThought && <ThinkingLine it={it} step />}
      {it.text.trim() && (
        <div className="step-note">
          <Markdown text={it.text} />
        </div>
      )}
    </div>
  );
}

const STEP_ICON: Record<string, keyof typeof Icon> = {
  edit_design: "Edit",
  write_design: "Code",
  get_design: "Code",
  run_checks: "Shield",
  explore_fixes: "Wand",
  capture_view: "Eye",
  view_drawing: "Eye",
  view_reference: "Eye",
  inspect_part: "Target",
  update_brief: "Doc",
  run_analysis: "Stress",
  catalog_lookup: "Search",
  engineering_calc: "Sliders",
  web_search: "Search",
  web_fetch: "Doc",
  set_material: "Material",
  compare_materials: "Material",
  place_fasteners: "Screw",
  run_scenario: "Play",
  scenario_results: "Graph",
  plan_manufacturing: "Factory",
  process_guide: "Factory",
  compare_processes: "Factory",
  get_example: "Doc",
  read_reference: "Doc",
  get_sketch: "Edit",
  record_asks: "List",
  save_lesson: "Doc",
};

/** One tool call in the work log: what it did, how long it took, and the change or picture it made. */
function ToolStep({ it }: { it: Extract<ChatItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const canOpen = !!it.diff || !!it.image;
  const stats = useMemo(() => (it.diff ? diffStats(it.diff.before, it.diff.after) : null), [it.diff]);
  const link = it.link ? safeUrl(it.link.url) : null;
  // a web search or page that did not work is shown quietly: Claude carries on without it
  const quiet = it.web && it.status === "error";
  const Glyph = Icon[STEP_ICON[it.name] ?? "Wrench"] as (p: { size?: number }) => React.ReactElement;
  const state = quiet ? "quiet" : it.status;
  return (
    <div className={`step-body tool ${state}`}>
      <span className={`step-node ${state}`} aria-hidden="true">
        {it.status === "running" ? <span className="node-spin" /> : it.status === "error" && !quiet ? <Icon.Alert size={10} /> : <Glyph size={10} />}
      </span>
      <div className={`step-head${canOpen ? " can-open" : ""}`} onClick={() => canOpen && setOpen((o) => !o)} role={canOpen ? "button" : undefined} aria-expanded={canOpen ? open : undefined} data-tip={it.name} data-tip-pos="left">
        <span className="step-title">{it.status === "running" ? <span className="shimmer-text">{it.title}</span> : it.title}</span>
        {stats && (
          <span className="mono step-diff">
            <span style={{ color: "var(--pass)" }}>+{stats.added}</span> <span style={{ color: "var(--fail)" }}>−{stats.removed}</span>
          </span>
        )}
        <span className="mono step-time">{it.status === "running" ? (it.ran ? <RunningFor from={it.ran} /> : it.inputChars ? `writing · ${it.inputChars > 999 ? `${(it.inputChars / 1000).toFixed(1)}k` : it.inputChars} chars` : "") : it.ms !== undefined ? fmtDur(it.ms) : ""}</span>
        {canOpen && <Icon.ChevronDown size={11} className="step-chev" style={{ transform: open ? "rotate(180deg)" : undefined }} />}
      </div>
      {it.detail && !it.diff && <div className="step-detail">{it.detail}</div>}
      {link && (
        <div className="tc-link">
          <a href={link} target="_blank" rel="noopener noreferrer" title={link}>
            {it.link!.label || domainOf(link)}
          </a>
        </div>
      )}
      {open && it.diff && (
        <div className="step-open feed-in">
          <DiffView before={it.diff.before} after={it.diff.after} />
        </div>
      )}
      {open && it.image && <img className="step-open feed-in" src={it.image} alt="Rendered view of the model" />}
    </div>
  );
}

/** Seconds a running step has taken so far. */
function RunningFor({ from }: { from: number }) {
  const secs = useElapsed(from, true);
  return <>{secs >= 1 ? `${secs} s` : ""}</>;
}

/** Pages Claude cited from its web searches. Links open in a new tab and never get access to this page. */
function Sources({ sources }: { sources: { url: string; title: string }[] }) {
  const links = sources.map((s) => ({ ...s, url: safeUrl(s.url) })).filter((s): s is { url: string; title: string } => !!s.url);
  if (!links.length) return null;
  return (
    <div className="msg-sources">
      <div className="ms-label">Sources</div>
      <ol>
        {links.map((s) => (
          <li key={s.url}>
            <a href={s.url} target="_blank" rel="noopener noreferrer" title={s.url}>
              <span className="ms-title">{s.title}</span>
              <span className="ms-domain">{domainOf(s.url)}</span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ToolCard({ it }: { it: Extract<ChatItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const canOpen = !!it.diff || !!it.image;
  const stats = useMemo(() => (it.diff ? diffStats(it.diff.before, it.diff.after) : null), [it.diff]);
  const link = it.link ? safeUrl(it.link.url) : null;
  // a web search or page that did not work is shown quietly: Claude carries on without it
  const quiet = it.web && it.status === "error";
  return (
    <div className={`tool-card feed-in ${quiet ? "web-miss" : it.status}${it.web ? " web" : ""}`}>
      <div className="tc-head" onClick={() => canOpen && setOpen((o) => !o)} style={{ cursor: canOpen ? "pointer" : "default" }}>
        {it.status === "running" ? <div className="spinner" /> : quiet ? <span style={{ color: "var(--text-3)", display: "inline-grid" }}><Icon.Info size={14} /></span> : it.status === "error" ? <span style={{ color: "var(--fail)", display: "inline-grid" }}><Icon.Alert size={14} /></span> : <span style={{ color: "var(--pass)", display: "inline-grid" }}><Icon.Check size={14} /></span>}
        <span className="grow" style={{ minWidth: 0 }}>
          {it.status === "running" ? <span className="shimmer-text">{it.title}</span> : it.title}
        </span>
        {stats && (
          <span className="mono" style={{ fontSize: 10.5 }}>
            <span style={{ color: "var(--pass)" }}>+{stats.added}</span> <span style={{ color: "var(--fail)" }}>−{stats.removed}</span>
          </span>
        )}
        {it.status === "running" && it.inputChars ? <span className="tc-name">{it.inputChars} chars</span> : <span className="tc-name">{it.name}</span>}
        {canOpen && <Icon.ChevronDown size={12} style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .15s", color: "var(--text-3)" }} />}
      </div>
      {it.status === "running" && <div className="tc-progress" />}
      {it.detail && !it.diff && <div className="tc-detail">{it.detail}</div>}
      {link && (
        <div className="tc-link">
          <a href={link} target="_blank" rel="noopener noreferrer" title={link}>
            {it.link!.label || domainOf(link)}
          </a>
        </div>
      )}
      <AnimatePresence>
        {open && it.diff && (
          <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} style={{ overflow: "hidden" }}>
            <DiffView before={it.diff.before} after={it.diff.after} />
          </motion.div>
        )}
      </AnimatePresence>
      {it.image && open && <img src={it.image} alt="Rendered view of the model" />}
    </div>
  );
}

const andList = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0]);

/**
 * Under a message sent while Claude worked: whether it is still waiting for
 * Claude's next step or has been read (and by which subassembly agents), with
 * a way to take it back or have Claude take it at once.
 */
export function MidRun({ id, compact }: { id: string; compact?: boolean }) {
  const plan = usePlan();
  const busy = useChat((s) => s.busy);
  const asking = useChat((s) => !!s.pendingChoice);
  const building = useAgents((s) => isLive(s.run));
  const st = useMemo(() => messageState(plan, id), [plan, id]);
  if (!st) return null;
  if (st.delivered) {
    const who = st.agents.length ? `${st.main ? "Claude and " : ""}the ${andList(st.agents)} agent${st.agents.length > 1 ? "s" : ""}` : "Claude";
    return (
      <div className="midrun">
        <span className="midrun-tag seen" data-tip="Sent while Claude worked: it took this into account from its next step, without starting over">
          <Icon.Check size={9} /> added mid-run{compact ? "" : ` · ${who} ${st.agents.length + (st.main ? 1 : 0) > 1 ? "have" : "has"} it`}
        </span>
      </div>
    );
  }
  // interrupting a parallel build would stop its agents, so they take it at their next step
  const agents = building || anyBranchOpen();
  const where = busy || building ? (agents ? "waiting for the agents' next step" : "waiting for Claude's next step") : asking ? "goes with your answer" : "not sent yet";
  const canNow = (busy && !agents) || (!busy && !building && !asking);
  return (
    <div className="midrun">
      <span className="midrun-tag" data-tip="Claude takes this into account as it goes, without stopping or starting over">
        <span className="steer-dot" /> {compact ? "waiting" : where}
      </span>
      {canNow && (
        <button className="midrun-btn" onClick={() => void sendQueuedNow()} data-tip={busy ? "Stop Claude's current response and take this now. What it was writing is dropped." : "Send it to Claude now"}>
          {busy ? "now" : "send"}
        </button>
      )}
      <button className="midrun-btn" onClick={() => withdrawMidRun(id)} data-tip="Take it back before Claude reads it">
        undo
      </button>
    </div>
  );
}

function Composer({ busy, hasKey }: { busy: boolean; hasKey: boolean }) {
  const routing = useChat((s) => s.routing);
  const activity = useChat((s) => (s.busy ? currentActivity(s.items) : ""));
  const building = useAgents((s) => isLive(s.run));
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const draft = useChatDraft();
  const pending = useChat((s) => s.pendingChoice);
  const att = useAttachments();
  const selected = useView((s) => s.selected);
  const model = useDesign((s) => s.model);
  const about = useMemo(() => [...new Set(selected.map((id) => model?.parts.find((p) => p.id === id)?.name).filter((n): n is string => !!n))], [selected, model]);
  useEffect(() => {
    if (draft.nonce) {
      setText(draft.text);
      requestAnimationFrame(() => {
        ta.current?.focus();
        ta.current?.setSelectionRange(draft.text.length, draft.text.length);
      });
    }
  }, [draft.nonce, draft.text]);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(200, el.scrollHeight) + "px";
  }, [text]);
  const quickOn = useSettings((s) => s.quickCommands);
  const optionsFirst = useSettings((s) => s.optionsFirst);
  // a plain command is done at once, without Claude (see app/quickRun)
  const command = useMemo(() => (quickOn && !optionsFirst && !att.files.length && !pending && text.trim() ? quickCommandOf(text) : null), [quickOn, optionsFirst, att.files.length, pending, text, model]);
  const canSend = (!!text.trim() || att.files.length > 0) && !att.loading;
  // while Claude works, a message joins the run at its next step; files wait for the run to end
  const midRun = busy || building;
  const send = () => {
    if (!canSend) return;
    if (midRun) {
      if (addMidRun(text, { files: att.files })) setText("");
      return;
    }
    // an answer to Claude's open question is an answer, not a new request for options
    void sendMessage(text, { files: att.files, optionsFirst: optionsFirst && !pending });
    setText("");
    att.clear();
  };
  const voice = useVoiceInput({ text, setText, send, canSend, input: ta });
  return (
    <div className="composer">
      <VoiceNotice />
      <AnimatePresence initial={false}>
        {about.length > 0 && (
          <motion.div className="about-row" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <Icon.Target size={12} />
            <span className="mono">about</span>
            {about.slice(0, 4).map((n) => (
              <span key={n} className="chip accent">
                {n}
              </span>
            ))}
            {about.length > 4 && <span className="chip">+{about.length - 4}</span>}
            <button className="icon-btn sm" onClick={() => select([])} aria-label="Clear the selection" data-tip="Clear the selection">
              <Icon.X size={11} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <div className={`composer-box ${att.over ? "drop-over" : ""}`} {...att.bind}>
        <PendingFiles att={att} />
        <textarea
          ref={ta}
          value={text}
          readOnly={voice.live}
          rows={2}
          maxLength={20000}
          placeholder={
            pending
              ? "Pick an option above, or answer here…"
              : midRun && hasKey
                ? "Add to what Claude is doing. It reads this after its current step…"
                : !hasKey
                ? "Add your API key in settings to chat with Claude, or type a command: fillet 2, hole M3, wall 3…"
                : about.length
                  ? `What should change about ${about.length === 1 ? about[0] : "the selected parts"}?`
                  : optionsFirst
                    ? "Describe what you want. Claude shows you options to pick from first…"
                    : `Describe a part, a change or a question… (${touchScreen ? "press and hold" : "right-click"} the model to ask about a spot)`
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          aria-label="Message Claude"
          id="chat-input"
        />
        <div className="row">
          <AttachButton att={att} disabled={!hasKey} />
          <span className="mono dim composer-status">
            {busy ? (
              <>
                <span className="shimmer-text">{routing ? "Choosing a model" : activity ? `Claude is working · ${activity}` : "Claude is working"}</span>
                {text.trim() ? " · Enter adds this to the run" : ""}
              </>
            ) : building ? (
              "The agents are building · Enter adds a note for them"
            ) : command ? (
              <span className="quick-hint" style={{ color: "var(--accent)" }}>
                <Icon.Bolt size={10} /> {describeQuick(command)} · instant, no Claude
              </span>
            ) : (
              `Enter to send · Shift+Enter for a new line · ${mod}K finds anything`
            )}
          </span>
          <div className="grow" />
          {/* a note added mid-run is not a new request, so options first does not apply to it */}
          {!midRun && <OptionsFirst />}
          <SpeedMenu />
          <MicButton voice={voice} />
          {busy && (
            <button className="btn sm danger" onClick={stop} aria-label="Stop">
              <Icon.Stop size={12} /> Stop
            </button>
          )}
          {(!busy || !!text.trim()) && (
            <button
              className="btn sm primary"
              onClick={send}
              disabled={!canSend || (midRun && (!text.trim() || att.files.length > 0))}
              aria-label={midRun ? "Add to this run" : "Send"}
              data-tip={midRun ? (att.files.length ? "Files go once Claude finishes. Remove them to add just the text now." : "Add this to what Claude is doing: it reads it after its current step, without starting over") : undefined}
            >
              {midRun ? <Icon.Plus size={13} /> : command ? <Icon.Bolt size={13} /> : <Icon.Send size={13} />}
            </button>
          )}
        </div>
        <VoiceBar voice={voice} />
      </div>
      <div className="dim" style={{ fontSize: 10.5, marginTop: 6, textAlign: "center" }}>
        Claude can make mistakes. Strength checks are estimates from a simplified model. Test before you rely on a part.
      </div>
    </div>
  );
}
