// Talking to Claude: the mic button, the live listening bar and the privacy
// choice, for any text box that sends a message. The chat composer plugs in
// with useVoiceInput and three small components; nothing else in the chat
// knows about voice.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useDesign } from "../../core/engine";
import { useSettings } from "../../app/settings";
import { go, openSettings, useUi } from "../../app/ui";
import { joinText, serviceName, providerName, clock, desktopDictationHint } from "../../voice/text";
import { desktop } from "../../app/desktop";
import { allowOnlineSpeech, cancelVoice, dismissVoice, downloadSpeechModel, holdSend, sendNow, stopVoice, toggleVoice, useVoice, type VoiceClient, type VoicePhase } from "../../voice/voice";
import { Icon } from "../icons";
import { useSketch } from "../sketch/session";
import "../../styles/voice.css";

export interface VoiceHandle {
  phase: VoicePhase;
  /** words are arriving in the box: keep it read-only */
  live: boolean;
  toggle: () => void;
}

interface Options {
  text: string;
  setText: (t: string) => void;
  /** send the box's current text */
  send: () => void;
  /** whether sending is possible now */
  canSend: boolean;
  input: RefObject<HTMLTextAreaElement | null>;
}

const coarsePointer = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable || !!el.closest?.(".cm-editor");
}

/** Connect a message box to voice input. */
export function useVoiceInput(o: Options): VoiceHandle {
  const phase = useVoice((s) => s.phase);
  const latest = useRef(o);
  latest.current = o;
  const base = useRef("");
  const lastSet = useRef<string | null>(null);

  const client = useMemo<VoiceClient>(() => {
    const put = (t: string) => {
      lastSet.current = t;
      latest.current.setText(t);
    };
    return {
      begin: () => {
        base.current = latest.current.text;
      },
      text: (spoken) => put(joinText(base.current, spoken)),
      done: (spoken) => {
        put(joinText(base.current, spoken));
        // ready to review; on touch screens, don't pop the keyboard over the result
        if (spoken && !coarsePointer()) {
          requestAnimationFrame(() => {
            const el = latest.current.input.current;
            if (!el) return;
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          });
        }
      },
      cancel: () => put(base.current),
      send: () => latest.current.send(),
      canSend: () => latest.current.canSend,
      vocabulary: () => {
        const m = useDesign.getState().model;
        return m ? [...m.parts.map((p) => p.name), ...m.params.map((p) => p.name)] : [];
      },
    };
  }, []);

  // typing during the send countdown means the user wants to edit first
  useEffect(() => {
    if (phase === "sending" && lastSet.current !== null && o.text !== lastSet.current) holdSend();
  }, [o.text, phase]);

  // keys: V to talk, Enter to finish, Escape to cancel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const p = useVoice.getState().phase;
      const live = p === "listening" || p === "finishing";
      if (live && (e.key === "Enter" || e.key === "Escape")) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Enter") stopVoice();
        else cancelVoice();
        return;
      }
      if (p === "sending" && (e.key === "Enter" || e.key === "Escape")) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Enter") sendNow();
        else holdSend();
        return;
      }
      if ((p === "offer" || p === "error" || p === "unsupported") && e.key === "Escape") {
        dismissVoice();
        return;
      }
      const ui = useUi.getState();
      if (e.key.toLowerCase() !== "v" || e.metaKey || e.ctrlKey || e.altKey || e.repeat || isTyping(e.target)) return;
      if (ui.settingsOpen || ui.shortcutsOpen || ui.findOpen || ui.confirm || ui.screen.name !== "workspace") return;
      // in the sketch editor V is the select tool
      const sketch = useSketch.getState();
      if (sketch.active || sketch.picking) return;
      e.preventDefault();
      toggleVoice(client);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [client]);

  // leaving the workspace turns the mic off
  useEffect(() => () => cancelVoice(), []);

  return { phase, live: phase === "listening" || phase === "finishing", toggle: () => toggleVoice(client) };
}

/** The mic button that sits beside Send. */
export function MicButton({ voice }: { voice: VoiceHandle }) {
  const where = useVoice((s) => s.where);
  const { phase, live } = voice;
  const waiting = phase === "checking" || phase === "downloading";
  return (
    <button
      type="button"
      className={`mic-btn ${live ? "live" : ""} ${where === "online" ? "online" : ""}`}
      onClick={voice.toggle}
      aria-pressed={live}
      aria-label={live ? "Stop listening" : "Talk to Claude"}
      data-tip={live ? "Stop listening (Enter)" : "Talk to Claude (V)"}
      data-tip-pos="top"
      disabled={phase === "finishing"}
    >
      {live && <span className="mic-ring" aria-hidden="true" />}
      {waiting ? <div className="spinner" /> : <Icon.Mic size={16} />}
    </button>
  );
}

/** The listening bar over the bottom of the message box. */
export function VoiceBar({ voice }: { voice: VoiceHandle }) {
  const s = useVoice();
  const show = voice.live || s.phase === "sending";
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className={`voice-bar ${s.phase === "sending" ? "sending" : "live"}`}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.16, ease: "easeOut" }}
          role="status"
          aria-live="polite"
        >
          {s.phase === "sending" ? (
            <SendCountdown sendAt={s.sendAt} />
          ) : (
            <>
              <VoiceLevel pulse={s.pulse} calm={s.phase === "finishing"} />
              <div className="grow vb-text">
                <span className="vb-state">{s.phase === "finishing" ? "Finishing" : !s.ready ? "Starting the mic" : s.final || s.interim ? "Listening" : "Talk now"}</span>
                <span className={`vb-where ${s.where ?? ""}`} data-tip={s.where === "device" ? "Speech is turned into text on this device. Audio never leaves it." : `Your browser sends audio to ${providerName(s.provider)} while the mic is on.`} data-tip-pos="top">
                  {s.where === "device" ? (
                    <>
                      <Icon.Lock size={10} /> on device
                    </>
                  ) : (
                    <>via {providerName(s.provider)}</>
                  )}
                </span>
                {s.ready && <Elapsed since={s.startedAt} />}
              </div>
              <button type="button" className="btn sm ghost vb-cancel" onClick={cancelVoice} aria-label="Cancel and discard what was heard">
                <Icon.X size={13} />
              </button>
              <button type="button" className="btn sm primary vb-done" onClick={stopVoice} disabled={s.phase === "finishing"}>
                <Icon.Check size={13} /> Done
              </button>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SendCountdown({ sendAt }: { sendAt: number }) {
  const [total] = useState(() => Math.max(300, sendAt - Date.now()));
  return (
    <>
      <div className="vb-countdown" aria-hidden="true">
        <motion.div initial={{ scaleX: 1 }} animate={{ scaleX: 0 }} transition={{ duration: total / 1000, ease: "linear" }} />
      </div>
      <div className="grow vb-text">
        <span className="vb-state">Sending to Claude</span>
      </div>
      <button type="button" className="btn sm ghost" onClick={holdSend}>
        Edit first
      </button>
      <button type="button" className="btn sm primary" onClick={sendNow}>
        <Icon.Send size={13} /> Send
      </button>
    </>
  );
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  return <span className="vb-time mono">{clock(Date.now() - since)}</span>;
}

/** Level bars that jump as sound and words arrive and settle when it goes quiet. */
function VoiceLevel({ pulse, calm }: { pulse: number; calm: boolean }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const energy = useRef(0.6);
  const reduce = useSettings((s) => s.reduceMotion);
  useEffect(() => {
    energy.current = Math.min(1, energy.current + 0.75);
  }, [pulse]);
  useEffect(() => {
    if (reduce) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      energy.current = Math.max(calm ? 0 : 0.08, energy.current - dt * 1.6);
      const e = energy.current;
      bars.current.forEach((el, i) => {
        if (!el) return;
        const wobble = 0.5 + 0.5 * Math.sin(now / (140 + i * 37) + i * 1.7);
        el.style.transform = `scaleY(${(0.18 + e * (0.35 + 0.65 * wobble)).toFixed(3)})`;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [reduce, calm]);
  return (
    <div className={`voice-level ${calm ? "calm" : ""}`} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} ref={(el) => void (bars.current[i] = el)} />
      ))}
    </div>
  );
}

function languageName(tag: string) {
  try {
    return new Intl.DisplayNames([navigator.language || "en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

const openPrivacy = () => go({ name: "legal", doc: "privacy", back: "workspace" });

/** Cards above the message box: where speech goes, downloads and problems. */
export function VoiceNotice() {
  const s = useVoice();
  const service = serviceName(s.provider);
  const company = providerName(s.provider);
  const lang = languageName(s.lang);
  let body: React.ReactNode = null;

  if (s.phase === "offer") {
    const canDownload = s.onDevice === "downloadable" || s.onDevice === "downloading";
    body = (
      <>
        <div className="vn-head">
          <Icon.Mic size={15} />
          <span className="grow">Talk to Claude</span>
          <button type="button" className="icon-btn sm" onClick={dismissVoice} aria-label="Close">
            <Icon.X size={13} />
          </button>
        </div>
        {canDownload ? (
          <>
            <p>
              Kerf can turn your speech into text <b>on this device</b>, so your voice never leaves it. Your browser needs to download its {lang} speech model once (around 60 MB).
            </p>
            <div className="vn-actions">
              <button type="button" className="btn primary" onClick={() => void downloadSpeechModel()}>
                <Icon.Download size={14} /> Download and keep voice on this device
              </button>
            </div>
            <p className="vn-alt">
              {s.provider === "other" ? "Or use your browser's online speech service now, which hears your audio while the mic is on." : `Or use ${service} now, which hears your audio while the mic is on.`}{" "}
              <button type="button" className="link-btn" onClick={allowOnlineSpeech}>
                {s.provider === "other" ? "Use the online service" : `Use ${company} instead`}
              </button>
            </p>
          </>
        ) : (
          <>
            <p>
              This browser can't turn speech into text on this device. It can send your voice to <b>{service}</b> while the mic is on, and {s.provider === "other" ? "the service" : company} sends back the words. Kerf and Anthropic never receive your audio, only the text you send.
            </p>
            <div className="vn-actions">
              <button type="button" className="btn primary" onClick={allowOnlineSpeech}>
                <Icon.Mic size={14} /> Allow and start talking
              </button>
              <button type="button" className="btn ghost" onClick={dismissVoice}>
                Not now
              </button>
            </div>
            <p className="vn-alt">On a phone you can also use the dictation key on your keyboard.</p>
          </>
        )}
        <div className="vn-foot">
          <button type="button" className="link-btn" onClick={openPrivacy}>
            Privacy notice
          </button>
          <span>·</span>
          <button type="button" className="link-btn" onClick={() => openSettings("voice")}>
            Voice settings
          </button>
        </div>
      </>
    );
  } else if (s.phase === "checking" || s.phase === "downloading") {
    body = (
      <div className="vn-head">
        <div className="spinner" />
        <span className="grow">{s.phase === "checking" ? "Getting voice input ready…" : `Downloading the ${lang} speech model. You can keep working.`}</span>
        <button type="button" className="icon-btn sm" onClick={dismissVoice} aria-label="Hide">
          <Icon.X size={13} />
        </button>
      </div>
    );
  } else if (s.phase === "unsupported") {
    body = (
      <>
        <div className="vn-head">
          <Icon.MicOff size={15} />
          <span className="grow">{desktop() ? "No voice input in the desktop app yet" : "This browser can't do voice input"}</span>
          <button type="button" className="icon-btn sm" onClick={dismissVoice} aria-label="Close">
            <Icon.X size={13} />
          </button>
        </div>
        <p>{desktop() ? desktopDictationHint(/Windows/.test(navigator.userAgent)) : "On a phone, use the dictation key on your keyboard to talk into the message box. Chrome, Edge and Safari have voice input built in."}</p>
      </>
    );
  } else if (s.phase === "error" && s.error) {
    body = (
      <>
        <div className="vn-head">
          <Icon.Alert size={15} />
          <span className="grow">{s.error.title}</span>
          <button type="button" className="icon-btn sm" onClick={dismissVoice} aria-label="Close">
            <Icon.X size={13} />
          </button>
        </div>
        {s.error.detail && <p>{s.error.detail}</p>}
        {s.error.settings && (
          <div className="vn-actions">
            <button type="button" className="btn sm" onClick={() => openSettings("voice")}>
              <Icon.Settings size={13} /> Voice settings
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <AnimatePresence initial={false}>
      {body && (
        <motion.div key={s.phase} className={`voice-notice ${s.phase} ${s.error?.soft ? "soft" : ""}`} initial={{ opacity: 0, y: 6, height: 0 }} animate={{ opacity: 1, y: 0, height: "auto" }} exit={{ opacity: 0, height: 0 }} role={s.phase === "error" ? "alert" : "dialog"} aria-label="Voice input">
          <div className="vn-inner">{body}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
