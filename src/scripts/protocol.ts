// What passes between Kerf and a running script. The script runs in a worker inside a sandboxed frame
// (public/script-sandbox.html): it has no origin of its own, no storage and no network, and reaches Kerf only through
// these messages, which Kerf checks one by one.

/** From the script: a call on the kerf API, a line of output, its progress, or the end of the run. */
export type FromScript =
  | { kind: "ready" }
  | { kind: "call"; id: number; method: string; args: unknown[] }
  | { kind: "log"; level: "log" | "warn" | "error"; text: string }
  | { kind: "progress"; done: number; total: number; label?: string }
  | { kind: "done"; ok: boolean; value?: string; error?: string; line?: number };

/** To the script: the code to run (with the API's own code before it), and each call's answer. */
export type ToScript = { kind: "run"; prelude: string; code: string } | { kind: "reply"; id: number; ok: boolean; value?: unknown; error?: string };

/** The kerf API's methods, as the prelude calls them and the session answers them. */
export const SCRIPT_METHODS = ["design", "params", "variant", "set", "source", "setSource", "checks", "analyse", "export", "file", "table", "check", "projects"] as const;
export type ScriptMethod = (typeof SCRIPT_METHODS)[number];

/** Is this a message a script could have sent? Anything else is ignored. */
export function isFromScript(m: unknown): m is FromScript {
  if (!m || typeof m !== "object") return false;
  const x = m as Record<string, unknown>;
  switch (x.kind) {
    case "ready":
      return true;
    case "call":
      return Number.isInteger(x.id) && typeof x.method === "string" && Array.isArray(x.args);
    case "log":
      return (x.level === "log" || x.level === "warn" || x.level === "error") && typeof x.text === "string";
    case "progress":
      return typeof x.done === "number" && typeof x.total === "number";
    case "done":
      return typeof x.ok === "boolean";
    default:
      return false;
  }
}
