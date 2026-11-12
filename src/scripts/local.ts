// Running a script in this thread, without the sandbox: the same API code and messages, with the worker's side played
// here. For tests and tools that run in Node; the app always runs scripts in the sandbox (sandbox.ts).

import { SCRIPT_PRELUDE } from "./prelude";
import { isFromScript } from "./protocol";
import type { ScriptOutput, ScriptSession } from "./session";

export function runHere(code: string, session: ScriptSession): Promise<ScriptOutput> {
  return new Promise((resolve) => {
    const worker: { postMessage(m: unknown): void; onmessage: ((e: { data: unknown }) => void) | null; __kerfRun?: (code: string) => Promise<void> } = {
      // messages go across as structured clones, as they do between threads
      postMessage: (m) => queueMicrotask(() => handle(structuredClone(m))),
      onmessage: null,
    };
    const reply = (m: unknown) => queueMicrotask(() => worker.onmessage?.({ data: structuredClone(m) }));
    const handle = (m: unknown) => {
      if (!isFromScript(m)) return;
      switch (m.kind) {
        case "log":
          return session.log(m.level, m.text);
        case "progress":
          return session.progress(m.done, m.total, m.label);
        case "call":
          void session.call(m.method, m.args).then(
            (value) => reply({ kind: "reply", id: m.id, ok: true, value }),
            (e: unknown) => reply({ kind: "reply", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
          );
          return;
        case "done":
          return resolve(session.finish({ ok: m.ok, value: m.value, error: m.error, line: m.line }));
      }
    };
    new Function("self", SCRIPT_PRELUDE)(worker);
    void worker.__kerfRun!(code);
  });
}
