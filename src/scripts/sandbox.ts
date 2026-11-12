// Running a script in the app: a hidden frame (public/script-sandbox.html) with no origin of its own starts a worker
// for the script, so the script has no storage, no network and no way into Kerf's page, and a script that never ends
// stops when the frame is taken away. Kerf answers the frame's messages through the run's session.

import { SCRIPT_PRELUDE } from "./prelude";
import { isFromScript, type ToScript } from "./protocol";
import { LIMITS, type ScriptOutput, type ScriptSession } from "./session";

export interface ScriptRun {
  stop(): void;
  done: Promise<ScriptOutput>;
}

/** How long the sandbox may take to start before the run is given up. */
const START_MS = 15_000;

export function runInSandbox(code: string, session: ScriptSession, page = "/script-sandbox.html"): ScriptRun {
  const frame = document.createElement("iframe");
  // scripts only: no same-origin, so the frame and its worker cannot read Kerf's storage; the page allows no network
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.title = "Script sandbox";
  frame.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
  frame.src = page;

  let settle!: (o: ScriptOutput) => void;
  const done = new Promise<ScriptOutput>((r) => (settle = r));
  let ended = false;
  let started = false;
  const send = (m: ToScript) => frame.contentWindow?.postMessage(m, "*");

  const end = (e: Parameters<ScriptSession["finish"]>[0]) => {
    if (ended) return;
    ended = true;
    window.removeEventListener("message", onMessage);
    clearTimeout(limit);
    clearTimeout(starting);
    frame.remove();
    settle(session.finish(e));
  };

  const onMessage = (ev: MessageEvent) => {
    if (ended || ev.source !== frame.contentWindow) return;
    const m: unknown = ev.data;
    if (!isFromScript(m)) return;
    switch (m.kind) {
      case "ready":
        if (started) return;
        started = true;
        clearTimeout(starting);
        send({ kind: "run", prelude: SCRIPT_PRELUDE, code });
        return;
      case "log":
        return session.log(m.level, m.text);
      case "progress":
        return session.progress(m.done, m.total, m.label);
      case "call":
        void session.call(m.method, m.args).then(
          (value) => {
            if (!ended) send({ kind: "reply", id: m.id, ok: true, value });
          },
          (e: unknown) => {
            if (!ended) send({ kind: "reply", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
          },
        );
        return;
      case "done":
        return end({ ok: m.ok, value: m.value, error: m.error, line: m.line });
    }
  };

  window.addEventListener("message", onMessage);
  const starting = setTimeout(() => end({ ok: false, error: "The script's sandbox did not start. Reload Kerf and run it again." }), START_MS);
  const limit = setTimeout(() => {
    session.log("error", `Stopped after ${LIMITS.ms / 60_000} minutes, the longest a run may take.`);
    end("stopped");
  }, LIMITS.ms);
  document.body.appendChild(frame);
  return { stop: () => end("stopped"), done };
}
