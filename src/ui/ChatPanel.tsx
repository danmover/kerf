// The AI chat panel: conversation, live tool activity, choices and diffs.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useChat, sendMessage, stop, retryLast, revertTurn, clearChat, type ChatItem } from "../ai/chat";
import { ChoiceCard } from "./ChoiceCard";
import { getApiKey, subscribeKey } from "../persist/vault";
import { useSettings, updateSettings, MODELS } from "../app/settings";
import { openSettings, confirmDialog } from "../app/ui";
import { useProject } from "../app/project";
import { templateById, TEMPLATES } from "../demos/templates";
import { lineDiff, diffStats } from "../core/sourceEdit";
import { evaluateOnly, useDesign } from "../core/engine";
import { paramUnit, sameValue, withValues } from "../core/decisions";
import { commitSource, endPreview, previewSource, realSource } from "../app/project";
import { useView, select } from "../app/view";
import { fmtNum } from "../lang/values";
import { useRealModel } from "./useRealModel";
import { ValueField } from "./ValueField";
import { Markdown } from "./Markdown";
import { Icon } from "./icons";
import { Menu, MenuItem, mod } from "./common";
import { useChatDraft } from "./chatDraft";
import { LogoMark } from "./Logo";

export function useApiKey() {
  return useSyncExternalStore(subscribeKey, getApiKey);
}

export function ChatPanel() {
  const items = useChat((s) => s.items);
  const busy = useChat((s) => s.busy);
  const key = useApiKey();
  const feed = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const settings = useSettings();
  const model = MODELS.find((m) => m.id === settings.model)!;

  useLayoutEffect(() => {
    const el = feed.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  return (
    <div className="panel panel-right">
      <div className="panel-head">
        <LogoMark size={18} animate={false} />
        <span className="panel-title">Claude</span>
        <Menu
          align="left"
          width={290}
          trigger={(open, toggle) => (
            <button className={`chip ${open ? "accent" : ""}`} style={{ cursor: "pointer" }} onClick={toggle} aria-label="Choose model">
              {model.label.replace("Claude ", "")} · {settings.effort} <Icon.ChevronDown size={11} />
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
            </>
          )}
        </Menu>
        <div className="grow" />
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
        <div
          className="chat-feed"
          ref={feed}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
          aria-live="polite"
        >
          {!items.length && <Welcome hasKey={!!key} />}
          {items.map((it) => (
            <Item key={it.id} it={it} />
          ))}
        </div>
        <Composer busy={busy} hasKey={!!key} />
      </div>
    </div>
  );
}

function Welcome({ hasKey }: { hasKey: boolean }) {
  const project = useProject((s) => s.current);
  const t = templateById(project?.template ?? "") ?? TEMPLATES[0];
  if (!hasKey)
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="card" style={{ padding: 18 }}>
        <div className="row" style={{ marginBottom: 8, color: "var(--accent-2)" }}>
          <Icon.Key size={18} />
          <span style={{ fontWeight: 600, color: "var(--text)" }}>Connect Claude to design by conversation</span>
        </div>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          Kerf sends your messages and the design straight from this browser to the Claude API with your own key. There is no Kerf server in between. Everything else (editing, checks, export) works without a key.
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
        {t.prompts.map((p, i) => (
          <motion.button key={p} className="suggestion" onClick={() => void sendMessage(p)} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.08 * i + 0.1 }}>
            <Icon.Sparkle size={12} /> {p}
          </motion.button>
        ))}
      </div>
    </motion.div>
  );
}

function Item({ it }: { it: ChatItem }) {
  switch (it.kind) {
    case "user":
      return (
        <motion.div className="msg-user" initial={{ opacity: 0, y: 6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}>
          {it.text}
        </motion.div>
      );
    case "assistant":
      return <AssistantMsg it={it} />;
    case "tool":
      return <ToolCard it={it} />;
    case "choice":
      return <ChoiceCard it={it} />;
    case "notice":
      return (
        <motion.div className={`notice ${it.level}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
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
            </div>
          )}
        </motion.div>
      );
    case "turn":
      return <TurnBar it={it} />;
  }
}

function AssistantMsg({ it }: { it: Extract<ChatItem, { kind: "assistant" }> }) {
  const [showThinking, setShowThinking] = useState(false);
  const thinkingLive = it.streaming && !it.text;
  return (
    <motion.div className="msg-assistant" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      {(it.thinking || thinkingLive) && (
        <div>
          <button className="thinking-toggle" onClick={() => setShowThinking((s) => !s)} aria-expanded={showThinking}>
            <Icon.Chevron size={11} style={{ transform: showThinking ? "rotate(90deg)" : undefined, transition: "transform .15s" }} />
            {thinkingLive ? <span className="shimmer-text">Thinking</span> : "Thought process"}
          </button>
          <AnimatePresence>
            {showThinking && it.thinking && (
              <motion.div className="thinking" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
                {it.thinking}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
      {it.text && (
        <div>
          <Markdown text={it.text} />
          {it.streaming && <span className="caret" />}
        </div>
      )}
      {it.note && (
        <div className="mono dim" style={{ fontSize: 10.5, marginTop: 4 }}>
          {it.note}
        </div>
      )}
    </motion.div>
  );
}

function ToolCard({ it }: { it: Extract<ChatItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const canOpen = !!it.diff || !!it.image;
  const stats = useMemo(() => (it.diff ? diffStats(it.diff.before, it.diff.after) : null), [it.diff]);
  return (
    <motion.div className={`tool-card ${it.status}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} layout="position">
      <div className="tc-head" onClick={() => canOpen && setOpen((o) => !o)} style={{ cursor: canOpen ? "pointer" : "default" }}>
        {it.status === "running" ? <div className="spinner" /> : it.status === "error" ? <span style={{ color: "var(--fail)", display: "inline-grid" }}><Icon.Alert size={14} /></span> : <span style={{ color: "var(--pass)", display: "inline-grid" }}><Icon.Check size={14} /></span>}
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
      <AnimatePresence>
        {open && it.diff && (
          <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} style={{ overflow: "hidden" }}>
            <DiffView before={it.diff.before} after={it.diff.after} />
          </motion.div>
        )}
      </AnimatePresence>
      {it.image && open && <img src={it.image} alt="Rendered view of the model" />}
    </motion.div>
  );
}

function DiffView({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => lineDiff(before, after, 2), [before, after]);
  return (
    <div className="diff">
      {lines.map((l, i) => (
        <div key={i} className={`ln ${l.kind}`}>
          <span className="n">{l.b ?? l.a ?? ""}</span>
          <span>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
          <span>{l.text}</span>
        </div>
      ))}
    </div>
  );
}

function TurnBar({ it }: { it: Extract<ChatItem, { kind: "turn" }> }) {
  const [open, setOpen] = useState(false);
  const stats = useMemo(() => diffStats(it.before, it.after), [it.before, it.after]);
  const changes = useMemo(() => paramChanges(it.before, it.after), [it.before, it.after]);
  const key = `turn:${it.id}`;
  const comparing = useProject((s) => s.preview?.key === key);
  const busy = useChat((s) => s.busy);
  const { model: real } = useRealModel();
  useEffect(() => () => endPreview(key), [key]);

  // fine-tune a value Claude changed, without another round trip
  const tweak = (name: string, v: number | string | boolean, commit: boolean) => {
    const src = realSource();
    const next = withValues(src, evaluateOnly(src), { [name]: v });
    if (commit) commitSource(next, "you", `Set ${name} to ${typeof v === "number" ? fmtNum(v, 3) : String(v)} after Claude's change`);
    else previewSource({ key: `tweak:${it.id}`, label: name, quiet: true }, next);
  };

  return (
    <div className="turn">
      <div className="turn-bar">
        <Icon.Edit size={12} />
        <span className="grow">
          {it.reverted ? "Reverted" : `Changed the design in ${it.edits} edit${it.edits > 1 ? "s" : ""}`} · <span style={{ color: "var(--pass)" }}>+{stats.added}</span> <span style={{ color: "var(--fail)" }}>−{stats.removed}</span>
        </span>
        {!it.reverted && (
          <button
            className={`btn sm ${comparing ? "" : "ghost"}`}
            disabled={busy}
            aria-pressed={comparing}
            onClick={() => (comparing ? endPreview(key) : previewSource({ key, label: "Before Claude's change" }, it.before))}
            data-tip="Show the design as it was before this reply"
          >
            <Icon.Compare size={12} /> {comparing ? "After" : "Before"}
          </button>
        )}
        <button className="btn sm ghost" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Review"}
        </button>
        {!it.reverted && (
          <button className="btn sm ghost" onClick={() => revertTurn(it.id)} data-tip="Put the design back as it was before this reply">
            <Icon.Undo size={12} /> Revert
          </button>
        )}
      </div>
      {!it.reverted && changes.length > 0 && (
        <div className="turn-chips">
          <span className="mono dim tc-label" data-tip="Drag a name or type a value to fine-tune it">
            tweak
          </span>
          {changes.map((c) => {
            const cur = real?.params.find((p) => p.name === c.name);
            return (
              <ValueField
                key={c.name}
                name={c.name}
                from={c.from}
                value={cur?.value ?? c.to}
                unit={paramUnit(real, c.name)}
                accent={!!cur && !sameValue(cur.value, c.to)}
                disabled={!cur || cur.locked || busy}
                onLive={(v) => tweak(c.name, v, false)}
                onCommit={(v) => tweak(c.name, v, true)}
              />
            );
          })}
        </div>
      )}
      {open && (
        <div style={{ marginTop: 6, borderRadius: 8, overflow: "hidden", border: "1px solid var(--line-2)" }}>
          <DiffView before={it.before} after={it.after} />
        </div>
      )}
    </div>
  );
}

/** Parameters whose values differ between two versions of the source. */
function paramChanges(before: string, after: string) {
  const a = evaluateOnly(before);
  const b = evaluateOnly(after);
  const out: { name: string; from?: number | string | boolean; to: number | string | boolean }[] = [];
  for (const p of b.params) {
    const q = a.params.find((x) => x.name === p.name);
    if (!q) out.push({ name: p.name, to: p.value });
    else if (!sameValue(q.value, p.value)) out.push({ name: p.name, from: q.value, to: p.value });
  }
  return out.slice(0, 8);
}

function Composer({ busy, hasKey }: { busy: boolean; hasKey: boolean }) {
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const draft = useChatDraft();
  const pending = useChat((s) => s.pendingChoice);
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
  const send = () => {
    if (!text.trim() || busy) return;
    void sendMessage(text);
    setText("");
  };
  return (
    <div className="composer">
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
      <div className="composer-box">
        <textarea
          ref={ta}
          value={text}
          rows={2}
          maxLength={20000}
          placeholder={
            pending
              ? "Pick an option above, or answer here…"
              : !hasKey
                ? "Add your API key in settings to chat with Claude"
                : about.length
                  ? `What should change about ${about.length === 1 ? about[0] : "the selected parts"}?`
                  : "Describe a part, a change or a question… (select parts in 3D to point at them)"
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
          <span className="mono dim" style={{ fontSize: 10.5 }}>
            {busy ? <span className="shimmer-text">Claude is working</span> : `Enter to send · Shift+Enter for a new line · ${mod}K to focus`}
          </span>
          <div className="grow" />
          {busy ? (
            <button className="btn sm danger" onClick={stop} aria-label="Stop">
              <Icon.Stop size={12} /> Stop
            </button>
          ) : (
            <button className="btn sm primary" onClick={send} disabled={!text.trim()} aria-label="Send">
              <Icon.Send size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="dim" style={{ fontSize: 10.5, marginTop: 6, textAlign: "center" }}>
        Claude can make mistakes. Checks verify geometry, not strength. Test before you rely on a part.
      </div>
    </div>
  );
}
