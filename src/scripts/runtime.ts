// Scripts in the app: one run at a time in the sandbox, each script's latest output, and the scripts set to run after
// each change, whose kerf.check results join the design's checks.

import { create } from "zustand";
import { appScriptHost } from "./host";
import { runInSandbox, type ScriptRun } from "./sandbox";
import { ScriptSession, type ScriptCheck, type ScriptMode, type ScriptOutput } from "./session";
import { nextScriptName, newScriptId } from "./records";
import { projectScripts, saveScript, useProject } from "../app/project";
import { refreshReport, useDesign } from "../core/engine";
import { registerReportPass, type ReportContext } from "../core/reportPasses";
import { useView } from "../app/view";
import type { CheckItem } from "../core/checks";
import type { ScriptRecord } from "../persist/db";

export interface ScriptsState {
  /** each script's latest output, by key: "script:<id>", "example:<id>" for an example tried as it is, "claude" */
  outputs: Record<string, ScriptOutput>;
  /** the run going on now */
  running: { key: string; name: string; mode: ScriptMode } | null;
  /** what the scripts run after each change found, and the source they read */
  checks: { source: string; byScript: Record<string, { name: string; checks: ScriptCheck[]; error?: string }> } | null;
  /** the Scripts tab was opened for this design, so it stays in the dock */
  opened: boolean;
  /** what the Scripts tab shows: an output key */
  selected: string | null;
  /** the code Claude ran last that isn't one of the design's scripts, under the key "claude" */
  claude: { name: string; code: string } | null;
}

export const useScripts = create<ScriptsState>(() => ({ outputs: {}, running: null, checks: null, opened: false, selected: null, claude: null }));

let current: ScriptRun | null = null;
let queue: Promise<unknown> = Promise.resolve();

export interface RunOptions {
  mode?: ScriptMode;
  author?: "you" | "claude";
  /** stops the run (a queued run doesn't start) */
  signal?: AbortSignal;
  /** the design it is for: a run doesn't start once another design is open (default: the one open now) */
  project?: string;
}

/** Run a script in its sandbox, after any run already going. Resolves with what it made. */
export function runScript(key: string, name: string, code: string, opts: RunOptions = {}): Promise<ScriptOutput> {
  const project = opts.project ?? useProject.getState().current?.id;
  const p = queue.then(() => start(key, name, code, opts.mode ?? "run", opts.author ?? "you", project, opts.signal));
  queue = p.catch(() => undefined);
  return p;
}

/** Run one of the open design's scripts: one set to run after each change only looks, as it does then. */
export function runSaved(id: string, opts: Omit<RunOptions, "mode"> = {}): Promise<ScriptOutput> {
  const s = projectScripts().find((x) => x.id === id);
  if (!s) return Promise.reject(new Error("That script is not in this design."));
  return runScript(`script:${s.id}`, s.name, s.code, { ...opts, mode: s.onChange ? "check" : "run" });
}

/** Stop the run going on now; what it changed so far stays as one version. */
export function stopScript() {
  current?.stop();
}

/** Open the Scripts tab, showing this key (a script, an example or Claude's run). */
export function openScripts(select?: string) {
  useScripts.setState((s) => ({ opened: true, selected: select ?? s.selected }));
  useView.setState({ dockTab: "scripts", dockOpen: true });
}

/** A new script in the open design, shown in the Scripts tab. Returns its id, or why it couldn't. */
export function addScript(from: { name?: string; code?: string; onChange?: boolean } = {}): { id: string } | { error: string } {
  const list = projectScripts();
  const s: ScriptRecord = {
    id: newScriptId(),
    name: nextScriptName(list, from.name || "Script"),
    code: from.code ?? "// The kerf API is on the right. Ctrl+Enter runs the script.\nconst d = await kerf.design();\nconsole.log(d.name + \": \" + d.parts.length + \" parts, \" + d.mass.toFixed(0) + \" g\");\n",
    updatedAt: Date.now(),
    ...(from.onChange ? { onChange: true } : {}),
  };
  const why = saveScript(s);
  if (why) return { error: why };
  openScripts(`script:${s.id}`);
  return { id: s.id };
}

const copy = (o: ScriptOutput): ScriptOutput => ({ ...o, lines: [...o.lines], tables: [...o.tables], files: [...o.files], checks: [...o.checks] });

async function start(key: string, name: string, code: string, mode: ScriptMode, author: "you" | "claude", project: string | undefined, signal?: AbortSignal): Promise<ScriptOutput> {
  // stopped while it waited, or its design was closed: it doesn't start
  if (signal?.aborted || !project || useProject.getState().current?.id !== project) return { status: "stopped", lines: [], tables: [], files: [], checks: [], calls: 0, builds: 0, startedAt: Date.now(), ms: 0 };
  let frame: ReturnType<typeof setTimeout> | null = null;
  const publish = () => useScripts.setState((s) => ({ outputs: { ...s.outputs, [key]: copy(session.out) } }));
  // output can come thousands of lines at a time: shown a few times a second
  const session: ScriptSession = new ScriptSession(appScriptHost(author, project), {
    name,
    mode,
    onUpdate: () => {
      frame ??= setTimeout(() => {
        frame = null;
        publish();
      }, 120);
    },
  });
  useScripts.setState({ running: { key, name, mode } });
  publish();
  const run = runInSandbox(code, session);
  current = run;
  const abort = () => run.stop();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await run.done;
  } finally {
    signal?.removeEventListener("abort", abort);
    current = null;
    if (frame) clearTimeout(frame);
    if (useProject.getState().current?.id === project) publish();
    useScripts.setState({ running: null });
  }
}

// ---------- after each change ----------

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastRead = "";
/** Claude is working on the design (given by the app, so scripts don't depend on the chat) */
let claudeBusy = () => false;

/**
 * Run the open design's after-each-change scripts once its checks have run, and put their checks in the report. They
 * wait while Claude works on the design.
 */
export function startScripts(busy: () => boolean = () => false) {
  if (started) return;
  started = true;
  claudeBusy = busy;
  registerReportPass("scripts", scriptCheckItems, 60);
  useDesign.subscribe((s, prev) => {
    if (s.reportRev !== prev.reportRev) later();
  });
  useProject.subscribe((s, prev) => {
    if (s.current?.id !== prev.current?.id) {
      // a run for the design being closed stops; what it changed is not kept in the next one
      stopScript();
      lastRead = "";
      useScripts.setState({ checks: null, outputs: {}, opened: false, selected: null, claude: null });
    }
    if (s.current?.scripts !== prev.current?.scripts) later();
  });
}

function later(ms = 1200) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void runAfterChange(), ms);
}

async function runAfterChange() {
  timer = null;
  const project = useProject.getState().current?.id;
  const list = projectScripts().filter((s) => s.onChange);
  if (!list.length) {
    lastRead = "";
    if (useScripts.getState().checks) {
      useScripts.setState({ checks: null });
      refreshReport();
    }
    return;
  }
  // not while another run, Claude's turn or a preview is going: once they are done
  if (useScripts.getState().running || claudeBusy() || useProject.getState().preview) return later(3000);
  const source = useDesign.getState().source;
  const read = `${source}\u0000${list.map((s) => `${s.id}:${s.code}`).join("\u0000")}`;
  if (read === lastRead) return;
  lastRead = read;
  const byScript: NonNullable<ScriptsState["checks"]>["byScript"] = {};
  for (const s of list) {
    const out = await runScript(`script:${s.id}`, s.name, s.code, { mode: "check", project });
    if (useProject.getState().current?.id !== project) return;
    byScript[s.id] = { name: s.name, checks: out.checks, ...(out.status === "error" ? { error: out.error } : {}) };
    // the design changed again: the next run reads that
    if (useDesign.getState().source !== source) break;
  }
  useScripts.setState({ checks: { source, byScript } });
  refreshReport();
}

/** The checks the user's own scripts made, in the report beside the design's requirements. */
function scriptCheckItems(items: CheckItem[], ctx: ReportContext): CheckItem[] {
  if (!ctx.live) return items;
  const st = useScripts.getState().checks;
  const list = projectScripts().filter((s) => s.onChange);
  if (!st || !list.length) return items;
  const fresh = st.source === ctx.src;
  const out = [...items];
  for (const s of list) {
    const r = st.byScript[s.id];
    if (!r) continue;
    if (r.error)
      out.push({ id: `script:${s.id}:stopped`, category: "requirement", status: "warn", title: `Script “${s.name}” stopped`, detail: r.error, basis: "calculation", fix: "Open it in the Scripts tab and run it to see where it stops." });
    for (const c of r.checks)
      out.push({
        id: `script:${s.id}:${c.name}`,
        category: "requirement",
        status: fresh ? c.status : "pending",
        title: c.name,
        detail: `${c.detail ? `${c.detail}. ` : ""}From your script “${s.name}”${fresh ? "" : ", which runs again for the latest change"}.`,
        basis: "calculation",
      });
  }
  return out;
}
