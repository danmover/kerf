// A small chat pinned to a spot on the model. Right-click a part (or "Ask"
// on a selection) to open it: ask about that place or tell Claude what to
// change there, scrub the values that drive the part, and watch the reply,
// its questions and its change card without leaving the 3D view. Everything
// said here is also in the main chat.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChat, sendMessage, type ChatItem } from "../ai/chat";
import { useDesign, evaluateOnly } from "../core/engine";
import { decisionsFor, paramUnit, paramsDriving, withValues } from "../core/decisions";
import { commitSource, endPreview, previewSource, realSource, useProject } from "../app/project";
import { useSpot, closeSpot, noteSpotMessage, type Spot } from "../app/spot";
import { useView, revealSpan, select, showDecision } from "../app/view";
import { viewport } from "../app/viewportApi";
import { openSettings } from "../app/ui";
import { fmtNum } from "../lang/values";
import { useApiKey } from "./ChatPanel";
import { SuggestionChips } from "./ChatPanel";
import { ChoiceCard } from "./ChoiceCard";
import { ChangeCard } from "./ChangeCard";
import { Markdown } from "./Markdown";
import { ValueField } from "./ValueField";
import { useRealModel } from "./useRealModel";
import { useStickToBottom } from "./useStickToBottom";
import { Icon } from "./icons";
import { enterSketch } from "./sketch/session";
import { T } from "./sketch/glyphs";

const QUICK: { label: string; prompt: string }[] = [
  { label: "Why is it like this?", prompt: "Why is this the way it is? Tell me what drives it." },
  { label: "Make it thicker", prompt: "Make this thicker." },
  { label: "Round the edges", prompt: "Round the edges here." },
  { label: "Add a hole here", prompt: "Add a hole here." },
  { label: "What could fail here?", prompt: "What could fail here, and how would we check it?" },
];

export function SpotChat() {
  const spot = useSpot((s) => s.spot);
  return <AnimatePresence>{spot && <SpotPopover key={spot.nonce} spot={spot} />}</AnimatePresence>;
}

function faceWord(n?: [number, number, number]) {
  if (!n) return "";
  const i = [0, 1, 2].reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a), 0);
  return Math.abs(n[i]) > 0.92 ? `${n[i] > 0 ? "+" : "−"}${"XYZ"[i]} face` : "angled face";
}

function SpotPopover({ spot }: { spot: Spot }) {
  const model = useDesign((s) => s.model);
  const { model: real } = useRealModel();
  const items = useChat((s) => s.items);
  const busy = useChat((s) => s.busy);
  const hasKey = !!useApiKey();
  const report = useDesign((s) => s.report);
  const part = real?.parts.find((p) => p.id === spot.partId) ?? model?.parts.find((p) => p.id === spot.partId);
  const [text, setText] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const pin = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [gone, setGone] = useState(false);
  const previewKey = `spot:${spot.nonce}`;

  // follow the spot as the camera, explode and motion move it
  useLayoutEffect(() => {
    let raf = 0;
    let wasGone = false;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = wrap.current;
      const host = el?.parentElement;
      if (!el || !host) return;
      const a = viewport()?.anchor(spot.partId, spot.local);
      const isGone = !a;
      if (isGone !== wasGone) setGone((wasGone = isGone));
      if (!a) {
        if (pin.current) pin.current.style.opacity = "0";
        return;
      }
      const W = host.clientWidth;
      const H = host.clientHeight;
      const cw = el.offsetWidth;
      const ch = el.offsetHeight;
      let x = a.x + 22;
      if (x + cw > W - 12) x = a.x - 22 - cw;
      x = Math.max(12, Math.min(W - cw - 12, x));
      // stay clear of the toolbar and the preview banner
      const banner = document.querySelector(".preview-banner")?.getBoundingClientRect();
      const top = banner ? Math.max(52, banner.bottom - host.getBoundingClientRect().top + 8) : 52;
      const y = Math.max(top, Math.min(H - ch - 12, a.y - 34));
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      if (pin.current) {
        const on = a.front && a.x > 0 && a.y > 0 && a.x < W && a.y < H;
        pin.current.style.opacity = on ? "1" : "0";
        pin.current.style.transform = `translate3d(${a.x}px, ${a.y}px, 0)`;
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [spot.partId, spot.local]);

  useEffect(() => {
    requestAnimationFrame(() => input.current?.focus());
  }, []);
  useEffect(() => () => endPreview(previewKey), [previewKey]);

  // Esc closes it, unless a preview is showing (Esc ends that first)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || useProject.getState().preview) return;
      const t = e.target as HTMLElement | null;
      const typingElsewhere = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) && !wrap.current?.contains(t);
      if (!typingElsewhere) closeSpot();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // this spot's part of the conversation
  const thread = useMemo(() => {
    const first = items.findIndex((i) => i.id === spot.sent[0]);
    if (first < 0) return [] as ChatItem[];
    return items.slice(first);
  }, [items, spot.sent]);
  const mine = spot.sent.length > 0;
  const working = busy && mine && thread.length > 0;
  useStickToBottom(feed, [...thread].reverse().find((i) => i.kind === "user")?.id);

  const drivers = useMemo(() => (real && part ? paramsDriving(real, part.name, 5).map((n) => real.params.find((p) => p.name === n)!).filter(Boolean) : []), [real, part]);
  const decisions = useMemo(() => (real && part ? decisionsFor(real, part.id) : []), [real, part]);
  const issues = useMemo(() => (report?.items ?? []).filter((i) => (i.status === "fail" || i.status === "warn") && i.parts?.includes(spot.partId)).slice(0, 3), [report, spot.partId]);

  const send = (t: string) => {
    const msg = t.trim();
    if (!msg || busy || !hasKey) return;
    const id = `spot${Date.now().toString(36)}`;
    noteSpotMessage(id);
    select([spot.partId]);
    endPreview(previewKey);
    void sendMessage(msg, { spot: { partId: spot.partId, label: part?.label ?? spot.label, local: spot.local, point: spot.point, normal: spot.normal }, id });
    setText("");
  };

  const setParam = (name: string, v: number | string | boolean, commit: boolean) => {
    const src = realSource();
    const next = withValues(src, evaluateOnly(src), { [name]: v });
    if (commit) commitSource(next, "you", `Set ${name} to ${typeof v === "number" ? fmtNum(v, 3) : String(v)}`);
    else previewSource({ key: previewKey, label: name, quiet: true }, next);
  };

  const label = part?.label ?? spot.label;

  return (
    <>
      <div className="spot-pin" ref={pin} aria-hidden="true">
        <span className="ring" />
        <span className="dot" />
      </div>
      <div className="spot-wrap" ref={wrap}>
        <motion.div
          className="spot-card"
          role="dialog"
          aria-label={`Chat about ${label}`}
          initial={{ opacity: 0, scale: 0.92, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.12 } }}
          transition={{ type: "spring", stiffness: 520, damping: 34 }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="spot-head">
            <Icon.Pin size={13} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="spot-title">{label}</div>
              <div className="spot-sub mono">
                {spot.partId}
                {spot.point ? ` · ${spot.point.map((v) => fmtNum(v, 1)).join(", ")} mm · ${faceWord(spot.normal)}` : " · whole part"}
              </div>
            </div>
            <button className="icon-btn sm" onClick={closeSpot} aria-label="Close" data-tip="Close (Esc)">
              <Icon.X size={13} />
            </button>
          </div>

          {gone && <div className="spot-note">This part is not in the design right now.</div>}

          {thread.length > 0 && (
            <div className="spot-feed" ref={feed}>
              {thread.map((it) => (
                <SpotItem key={it.id} it={it} last={it === thread[thread.length - 1]} onSend={send} />
              ))}
              {working && <Working thread={thread} />}
            </div>
          )}

          {!mine && hasKey && (
            <div className="spot-quick">
              {QUICK.map((q) => (
                <button key={q.label} className="suggest-chip" disabled={busy} onClick={() => send(q.prompt)} data-tip={`Send “${q.prompt}”`}>
                  {q.label}
                </button>
              ))}
            </div>
          )}

          {hasKey ? (
            <div className="spot-input">
              <textarea
                ref={input}
                rows={1}
                value={text}
                maxLength={4000}
                disabled={busy && !working}
                placeholder={busy ? (working ? "Claude is on it. You can type your next message." : "Claude is busy with another message") : mine ? "Reply about this spot…" : "Ask about this spot, or say what to change here…"}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send(text);
                  }
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    if (!useProject.getState().preview) closeSpot();
                  }
                }}
                aria-label={`Message Claude about ${label}`}
              />
              <button className="btn sm primary" disabled={!text.trim() || busy} onClick={() => send(text)} aria-label="Send">
                <Icon.Send size={12} />
              </button>
            </div>
          ) : (
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => openSettings("ai")}>
              <Icon.Settings size={12} /> Add your API key to ask Claude
            </button>
          )}

          {drivers.length > 0 && (
            <div className="spot-sec">
              <div className="spot-label mono" data-tip="The parameters this part is built from. Drag a name to scrub it live.">
                shaped by
              </div>
              <div className="spot-fields">
                {drivers.map((p) => (
                  <ValueField key={p.name} name={p.name} value={p.value} unit={paramUnit(real, p.name)} disabled={p.locked || busy} onLive={(v) => setParam(p.name, v, false)} onCommit={(v) => setParam(p.name, v, true)} />
                ))}
              </div>
            </div>
          )}

          {(decisions.length > 0 || issues.length > 0) && (
            <div className="spot-sec">
              {decisions.map((d) => (
                <button key={d.name} className="spot-link" onClick={() => showDecision(d.name)} data-tip="Open this decision">
                  <Icon.Fork size={11} /> {d.title}
                  {d.chose && <span className="dim"> · {d.chose}</span>}
                </button>
              ))}
              {issues.map((i) => (
                <div key={i.id} className={`spot-issue ${i.status}`}>
                  <span className={`dot ${i.status}`} />
                  <span className="grow">{i.title}</span>
                  {hasKey && (
                    <button className="btn sm ghost" disabled={busy} onClick={() => send(`Fix this check: ${i.title}${i.detail ? ` (${i.detail})` : ""}.`)}>
                      Fix
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="spot-actions">
            <button
              className="btn sm ghost"
              onClick={() => {
                select([spot.partId]);
                useView.setState((s) => ({ isolate: !s.isolate }));
              }}
            >
              <Icon.Target size={12} /> Isolate
            </button>
            <button
              className="btn sm ghost"
              onClick={() => {
                useView.setState((s) => ({ hiddenIds: [...new Set([...s.hiddenIds, spot.partId])], selected: s.selected.filter((x) => x !== spot.partId) }));
                closeSpot();
              }}
            >
              <Icon.EyeOff size={12} /> Hide
            </button>
            {part && (
              <button
                className="btn sm ghost"
                onClick={() => {
                  useView.setState({ dockOpen: true, dockTab: "code" });
                  revealSpan(part.span);
                }}
              >
                <Icon.Code size={12} /> Code
              </button>
            )}
            {/* the selection card is hidden while the spot card is open, so the part's sketches are offered here */}
            {part &&
              (real ?? model)?.sketches
                .filter((sk) => sk.usedBy.includes(part.name))
                .map((sk) => (
                  <button key={sk.name} className="btn sm ghost" onClick={() => enterSketch(sk.name)} data-tip={`Edit the sketch ${part.name} is built from`}>
                    <T.Sketch size={12} /> {sk.name}
                  </button>
                ))}
            <div className="grow" />
            {mine && (
              <button className="btn sm ghost" onClick={() => document.getElementById("chat-input")?.focus()} data-tip="This conversation is also in the chat panel">
                <Icon.Chat size={12} /> In chat
              </button>
            )}
          </div>
        </motion.div>
      </div>
    </>
  );
}

function SpotItem({ it, last, onSend }: { it: ChatItem; last: boolean; onSend: (t: string) => void }) {
  const busy = useChat((s) => s.busy);
  switch (it.kind) {
    case "user":
      return <div className="spot-user">{it.text}</div>;
    case "assistant":
      return it.text ? (
        <div className="spot-assistant">
          <Markdown text={it.text} />
          {it.streaming && <span className="caret" />}
        </div>
      ) : null;
    case "choice":
      return <ChoiceCard it={it} />;
    case "turn":
      return <ChangeCard it={it} compact />;
    case "suggest":
      return last && !busy ? <SuggestionChips options={it.options} onSend={onSend} /> : null;
    case "notice":
      return <div className={`spot-note ${it.level}`}>{it.title}</div>;
    case "tool":
      return null;
  }
}

/** What Claude is doing right now, in a line. */
function Working({ thread }: { thread: ChatItem[] }) {
  const tool = [...thread].reverse().find((i): i is Extract<ChatItem, { kind: "tool" }> => i.kind === "tool" && i.status === "running");
  const streaming = thread.some((i) => i.kind === "assistant" && i.streaming && i.text);
  if (streaming && !tool) return null;
  return (
    <div className="spot-working">
      <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
      <span className="shimmer-text">{tool?.title ?? "Thinking"}</span>
    </div>
  );
}
