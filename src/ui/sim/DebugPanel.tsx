// Simulate → Debug: the scenario's firmware under the debugger. A debug run records each stop (a breakpoint, a
// condition coming true, a firmware mistake) with the call stack, variables and watches, and the statements after
// it; stepping walks that recording, over, into and out of calls and back, and the replay follows to that moment.
// Breakpoints are set in the code's gutter, here or in Build → Firmware.

import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { useDesign } from "../../core/engine";
import { toast } from "../../app/ui";
import { withOwnCode } from "../../app/firmwareCode";
import { removeBreakpoint, setBreakOnFault, setWatches, toggleBreakpoint, updateBreakpoint, useFirmwareDebug, type Breakpoint } from "../../app/firmwareDebug";
import { generateFirmware } from "../../machine/firmware";
import { debugKey, debugScenario, debugSpecFor, scenarioBlock, stopDebugRun, useDebugRun, type DebugRun } from "../../sim/debugRuntime";
import type { DebugResult, DebugStop, DebugVar } from "../../sim/mcu";
import type { ScenarioDef } from "../../sim/scenario";
import { useSim } from "../../sim/runtime";
import { VARIANT_LABEL } from "../../sim/worlds/common";
import { FirmwareEditor } from "../firmware/FirmwareEditor";
import { openFirmwareFile } from "../MachinePanel";
import { Toggle } from "../common";
import { Icon } from "../icons";
import { seek } from "./simUi";
import "../../styles/firmware.css";

/** Which part of the Simulate tab is on show. */
export const useSimPane = create<{ pane: "results" | "debug" | "signals" }>(() => ({ pane: "results" }));

/** Where the debugger is in its recording: a stop, a step after it (-1 is the stop itself), and a frame of the stack. */
const usePos = create<{ stop: number; step: number; frame: number; view: { file: string; line: number } | null }>(() => ({ stop: 0, step: -1, frame: 0, view: null }));

const secs = (t: number) => `${t.toFixed(t < 10 ? 4 : 3)} s`;

interface Here {
  file: string;
  line: number;
  fn: string;
  depth: number;
  t: number;
  /** the stack, innermost first: function, file and line */
  stack: { fn: string; file: string; line: number }[];
  locals: DebugVar[];
  watches: { expr: string; value?: string; error?: string }[];
  globals: (DebugVar & { changed?: boolean })[];
}

/** The state at a step of a stop's recording. */
function hereAt(d: DebugResult, s: DebugStop, step: number): Here {
  if (step < 0)
    return { file: s.file, line: s.line, fn: s.fn, depth: s.depth, t: s.t, stack: s.stack.map((f) => ({ fn: f.fn, file: f.file, line: f.line })), locals: s.stack[0]?.locals ?? [], watches: s.watches, globals: s.globals };
  // the stack as it was at the stop, then each step after it: deeper calls push, returns pop
  const frames = [...s.stack].reverse().map((f) => ({ fn: f.fn, file: f.file, line: f.line }));
  // each step records the globals changed since the statement before it, so the values before step k ran are
  // the stop's with the changes of steps 0..k
  const changed = new Map<string, string>();
  for (let k = 0; k <= step; k++) {
    const st = s.trace[k];
    const site = d.sites[st.s];
    frames.length = Math.max(0, st.d);
    for (let i = 0; i < st.d; i++) frames[i] ??= { fn: "?", file: "", line: 0 };
    frames[st.d - 1] = { fn: site.fn, file: site.file, line: site.line };
    for (const [n, v] of st.g ?? []) changed.set(n, v);
  }
  const st = s.trace[step];
  const site = d.sites[st.s];
  return {
    file: site.file,
    line: site.line,
    fn: site.fn,
    depth: st.d,
    t: st.t,
    stack: [...frames].reverse(),
    locals: site.locals.map((l, i) => ({ name: l.name, type: l.type, value: st.v[i] ?? "?" })),
    watches: s.watches.map((w, i) => (st.w ? { expr: w.expr, ...(st.w[i]?.startsWith("(") ? { error: st.w[i].slice(1, -1) } : { value: st.w[i] }) } : w)),
    globals: s.globals.map((g) => (changed.has(g.name) ? { ...g, value: changed.get(g.name)!, changed: true } : g)),
  };
}

export function DebugPanel({ def }: { def: ScenarioDef }) {
  const model = useDesign((s) => s.model);
  const variant = useSim((s) => s.variant);
  const replayT = useSim((s) => s.t);
  const run = useDebugRun((s) => s.run);
  const prefs = useFirmwareDebug();
  const pos = usePos();
  const block = useMemo(() => (model ? scenarioBlock(def.label) : null), [model, def.label]);
  // the files the run's code came from, by the names the sketch knows them by
  const files = useMemo(() => {
    if (!model?.machine || !block) return new Map<string, string>();
    const fw = generateFirmware(withOwnCode(model.machine), model.name).find((f) => f.name === block);
    return new Map((fw?.files ?? []).filter((f) => /\.(ino|h|hpp|c|cpp)$/.test(f.path)).map((f) => [f.path.split("/").pop()!, f.content]));
  }, [model, block]);
  const [from, setFrom] = useState(0);
  const mine = run && run.label === def.label ? run : null;
  const spec = block ? debugSpecFor(block, { from }) : null;
  const nowKey = spec ? debugKey(def.label, variant, spec) : null;
  const stale = !!mine && mine.status !== "running" && mine.key !== nowKey;
  const d = mine?.status === "done" ? mine.result : undefined;
  const stop = d?.stops[Math.min(pos.stop, d.stops.length - 1)];
  const here = d && stop ? hereAt(d, stop, Math.min(pos.step, stop.trace.length - 1)) : null;

  // the replay follows the debugger
  useEffect(() => {
    if (here && mine?.variant === variant) seek(here.t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here?.t]);

  if (!model) return null;
  if (!block)
    return (
      <div className="sim-body kdbg-none">
        <div className="empty-state">This scenario runs no Arduino firmware, so there is nothing to debug.</div>
      </div>
    );

  const start = () => {
    const why = debugScenario(def.label, variant, { from });
    if (why) toast({ kind: "warn", title: "Can't debug this run", detail: why });
    else usePos.setState({ stop: 0, step: -1, frame: 0 });
  };
  const bps = prefs.breakpoints.filter((b) => b.block === block);
  // the code on show: a stack frame of the stop, or the file a breakpoint was picked from
  const frame = here ? (here.stack[Math.min(pos.frame, here.stack.length - 1)] ?? here.stack[0]) : null;
  const shown = frame && frame.file ? { file: frame.file, line: frame.line } : (pos.view ?? (bps[0] ? { file: bps[0].file, line: bps[0].line } : { file: [...files.keys()].find((f) => f.endsWith(".ino")) ?? "", line: 0 }));
  const code = files.get(shown.file);

  return (
    <div className="sim-body kdbg">
      <div className="sim-col kdbg-side">
        <RunControls def={def} run={mine} stale={stale} onStart={start} from={from} setFrom={setFrom} replayT={replayT} />
        <div className="sim-h">
          Breakpoints <span className="dim">{bps.length || ""}</span>
        </div>
        {bps.length === 0 && <div className="dim kdbg-hint">Click in the gutter left of a line number to stop there. Set them here or in Build → Firmware.</div>}
        {bps.map((b) => (
          <BreakpointRow key={b.id} b={b} d={d} onShow={() => usePos.setState({ view: { file: b.file, line: d?.bound[b.id] ?? b.line }, frame: 0, step: pos.step, stop: pos.stop })} />
        ))}
        <label className="kdbg-check">
          <Toggle on={prefs.breakOnFault} onChange={setBreakOnFault} label="Stop on firmware mistakes" />
          <span>Stop on firmware mistakes</span>
        </label>
        <div className="sim-h" style={{ marginTop: 12 }}>
          Watches
        </div>
        <Watches list={prefs.watches} errors={d?.errors ?? []} />
        {d && (
          <>
            <div className="sim-h" style={{ marginTop: 12 }}>
              Stops <span className="dim">{d.stops.length}{d.more ? "+" : ""}</span>
            </div>
            {d.stops.length === 0 && <div className="dim kdbg-hint">{bps.length ? "No breakpoint was reached in this run." : "Nothing stopped the run: set a breakpoint."}</div>}
            <div className="kdbg-stops">
              {d.stops.map((s, i) => (
                <button key={i} className={`kdbg-stop ${i === pos.stop ? "active" : ""} ${s.reason}`} onClick={() => usePos.setState({ stop: i, step: -1, frame: 0, view: null })}>
                  <span className="mono t">{secs(s.t)}</span>
                  <span className="mono where">
                    {s.file}:{s.line}
                  </span>
                  <span className="why">{s.reason === "fault" ? s.fault : `in ${s.fn}()`}</span>
                </button>
              ))}
            </div>
            {d.more && <div className="dim kdbg-hint">More stops came after these. Add a condition, or debug from a later time.</div>}
            {d.logs.length > 0 && (
              <>
                <div className="sim-h" style={{ marginTop: 12 }}>
                  Logpoints <span className="dim">{d.logs.length}{d.moreLogs ? "+" : ""}</span>
                </div>
                <div className="kdbg-logs mono">
                  {d.logs.slice(0, 400).map((l, i) => (
                    <button key={i} onClick={() => seek(l.t)}>
                      <span className="t">{secs(l.t)}</span> {l.text}
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
      <div className="sim-col kdbg-main">
        <StepBar d={d} stop={stop} pos={pos} here={here} block={block} shown={shown} />
        {code !== undefined ? (
          <FirmwareEditor
            docKey={`${block}|dbg|${shown.file}`}
            value={code}
            readOnly
            current={here && frame?.file === shown.file ? shown.line : shown.line || undefined}
            breakpoints={bps.filter((b) => b.file === shown.file).map((b) => ({ line: b.line, enabled: b.enabled, kind: b.log ? "log" : b.cond ? "cond" : "break" }))}
            onToggleBreakpoint={(line) => toggleBreakpoint(block, shown.file, line)}
          />
        ) : (
          <div className="empty-state" style={{ margin: 16 }}>
            {shown.file ? `${shown.file} is part of the simulator's Arduino core, so it has no source to show.` : "No code to show."}
          </div>
        )}
      </div>
      <div className="sim-col kdbg-vars">{here ? <Variables here={here} frame={pos.frame} /> : <NoStop run={mine} />}</div>
    </div>
  );
}

function RunControls({ def, run, stale, onStart, from, setFrom, replayT }: { def: ScenarioDef; run: DebugRun | null; stale: boolean; onStart: () => void; from: number; setFrom: (n: number) => void; replayT: number }) {
  const busy = run?.status === "running";
  return (
    <div className="kdbg-run">
      <div className="row">
        {busy ? (
          <button className="btn sm" onClick={stopDebugRun}>
            <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> Stop · {Math.round((run.progress ?? 0) * 100)}%
          </button>
        ) : (
          <button className={`btn sm ${!run || stale ? "primary" : ""}`} onClick={onStart} data-tip={`Run "${def.label}" (${VARIANT_LABEL[useSim.getState().variant] ?? "expected"}) again with the firmware under the debugger`}>
            <Icon.Play size={12} /> {run ? "Debug again" : "Debug run"}
          </button>
        )}
        <span className="dim kdbg-from" data-tip="Stops before this time are counted, not recorded">
          from
          <input type="number" min={0} step={0.1} value={from} onChange={(e) => setFrom(Math.max(0, Number(e.target.value) || 0))} />s
        </span>
        {replayT > 0 && Math.abs(replayT - from) > 0.05 && (
          <button className="btn sm ghost" onClick={() => setFrom(+replayT.toFixed(2))} data-tip="Debug from where the replay is">
            {replayT.toFixed(1)} s
          </button>
        )}
      </div>
      {run?.status === "error" && <div className="kdbg-err">{run.error}</div>}
      {run?.status === "done" && (
        <div className="dim kdbg-meta">
          {run.run ? `Ran ${run.run.summary.time.toFixed(1)} s (${run.run.stop})` : "Ran"} in {((run.ms ?? 0) / 1000).toFixed(1)} s{stale ? ". The design or the breakpoints changed since: debug again to follow them." : "."}
        </div>
      )}
    </div>
  );
}

function BreakpointRow({ b, d, onShow }: { b: Breakpoint; d?: DebugResult; onShow: () => void }) {
  const [cond, setCond] = useState(b.cond ?? "");
  const [log, setLog] = useState(b.log ?? "");
  useEffect(() => setCond(b.cond ?? ""), [b.cond]);
  useEffect(() => setLog(b.log ?? ""), [b.log]);
  const bound = d?.bound[b.id];
  const hits = d?.hits[b.id];
  const errs = d?.errors.filter((e) => e.bp === b.id) ?? [];
  return (
    <div className={`kdbg-bp ${b.enabled ? "" : "off"}`}>
      <div className="row">
        <input type="checkbox" checked={b.enabled} onChange={(e) => updateBreakpoint(b.id, { enabled: e.target.checked })} aria-label="Breakpoint on" />
        <span className={`dot ${b.log ? "log" : b.cond ? "cond" : ""}`} />
        <button className="mono where" onClick={onShow}>
          {b.file}:{b.line}
          {bound !== undefined && bound !== b.line && <span className="dim">{bound === null ? " (no code there)" : ` → ${bound}`}</span>}
        </button>
        {hits !== undefined && <span className="dim mono hits" data-tip="Times the line ran with its condition true">{hits}×</span>}
        <button className="btn sm ghost icon" onClick={() => removeBreakpoint(b.id)} aria-label="Remove the breakpoint">
          <Icon.X size={11} />
        </button>
      </div>
      <input className="kdbg-in mono" value={cond} placeholder="only when… e.g. speed > 200" onChange={(e) => setCond(e.target.value)} onBlur={() => cond !== (b.cond ?? "") && updateBreakpoint(b.id, { cond })} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
      <input className="kdbg-in mono" value={log} placeholder="or log, e.g. speed {speed}" onChange={(e) => setLog(e.target.value)} onBlur={() => log !== (b.log ?? "") && updateBreakpoint(b.id, { log })} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
      {errs.map((e, i) => (
        <div key={i} className="kdbg-err">
          {e.message}
        </div>
      ))}
    </div>
  );
}

function Watches({ list, errors }: { list: string[]; errors: DebugResult["errors"] }) {
  const [text, setText] = useState("");
  const add = () => {
    if (text.trim()) setWatches([...list, text]);
    setText("");
  };
  return (
    <div className="kdbg-watches">
      {list.map((w, i) => {
        const err = errors.find((e) => e.watch === w);
        return (
          <div key={i} className="row">
            <span className="mono">{w}</span>
            {err && <span className="kdbg-err" data-tip={err.message}>can't read</span>}
            <div className="grow" />
            <button className="btn sm ghost icon" onClick={() => setWatches(list.filter((_, k) => k !== i))} aria-label={`Stop watching ${w}`}>
              <Icon.X size={11} />
            </button>
          </div>
        );
      })}
      <input className="kdbg-in mono" value={text} placeholder="add a watch, e.g. pos[2] * 2" onChange={(e) => setText(e.target.value)} onBlur={add} onKeyDown={(e) => e.key === "Enter" && add()} />
    </div>
  );
}

/** The step buttons over the code: back, over, into, out, the next stop. */
function StepBar({ d, stop, pos, here, block, shown }: { d?: DebugResult; stop?: DebugStop; pos: { stop: number; step: number }; here: Here | null; block: string; shown: { file: string; line: number } }) {
  const n = stop?.trace.length ?? 0;
  const step = Math.min(pos.step, n - 1);
  const depth = here?.depth ?? 0;
  const find = (ok: (d: number) => boolean) => {
    if (!stop) return null;
    for (let k = step + 1; k < n; k++) if (ok(stop.trace[k].d)) return k;
    return null;
  };
  const over = find((x) => x <= depth);
  const into = step + 1 < n ? step + 1 : null;
  const out = find((x) => x < depth);
  const go = (k: number | null) => k !== null && usePos.setState({ step: k, frame: 0, view: null });
  const nextStop = d && pos.stop + 1 < d.stops.length ? pos.stop + 1 : null;
  const past = !!stop && step >= n - 1 && n > 0;
  return (
    <>
    <div className="mp-toolbar kdbg-steps">
      <button className="btn sm ghost" disabled={!stop || step < 0} onClick={() => go(step - 1)} data-tip="Step back">
        <Icon.Undo size={12} />
      </button>
      <button className="btn sm" disabled={over === null} onClick={() => go(over)} data-tip="Step over: to the next line here, past any call">
        Over
      </button>
      <button className="btn sm" disabled={into === null} onClick={() => go(into)} data-tip="Step into: to the next statement that runs, into a call">
        Into
      </button>
      <button className="btn sm" disabled={out === null} onClick={() => go(out)} data-tip="Step out: back to where this function was called from">
        Out
      </button>
      <button className="btn sm" disabled={nextStop === null} onClick={() => nextStop !== null && usePos.setState({ stop: nextStop, step: -1, frame: 0, view: null })} data-tip="Continue to the next stop">
        <Icon.Play size={12} /> Continue
      </button>
      <div className="grow" />
      <button className="btn sm ghost" disabled={!shown.file} onClick={() => openFirmwareFile(block, shown.file, shown.line || undefined)} data-tip="Open this file in Build → Firmware">
        <Icon.Code size={12} /> Code
      </button>
    </div>
    <div className="kdbg-pos mono">
      <span className="dim">{stop && here ? `stop ${pos.stop + 1} of ${d!.stops.length}${step >= 0 ? ` · step ${step + 1}` : ""} · ${here.fn}() · ${secs(here.t)}` : shown.file}</span>
      {past && <span className="kdbg-past"> · as far as this stop recorded: continue to the next stop</span>}
    </div>
    </>
  );
}

function Variables({ here, frame }: { here: Here; frame: number }) {
  return (
    <>
      <div className="sim-h">Call stack</div>
      <div className="kdbg-stack">
        {here.stack.map((f, i) => (
          <button key={i} className={`mono ${i === frame ? "active" : ""}`} onClick={() => usePos.setState({ frame: i })}>
            <span>{f.fn}()</span>
            <span className="dim">
              {f.file}:{f.line}
            </span>
          </button>
        ))}
      </div>
      <div className="sim-h" style={{ marginTop: 12 }}>
        {frame === 0 ? "Variables" : "Variables (of the innermost call)"}
      </div>
      <VarList list={here.locals} empty="No local variables here." />
      {here.watches.length > 0 && (
        <>
          <div className="sim-h" style={{ marginTop: 12 }}>
            Watches
          </div>
          <div className="kdbg-varlist">
            {here.watches.map((w, i) => (
              <div key={i} className="row">
                <span className="mono name">{w.expr}</span>
                <span className={`mono val ${w.error ? "err" : ""}`} data-tip={w.error}>
                  {w.error ? "can't read here" : w.value}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="sim-h" style={{ marginTop: 12 }}>
        Globals
      </div>
      <VarList list={here.globals} empty="No global variables." />
    </>
  );
}

function VarList({ list, empty }: { list: (DebugVar & { changed?: boolean })[]; empty: string }) {
  if (!list.length) return <div className="dim kdbg-hint">{empty}</div>;
  return (
    <div className="kdbg-varlist">
      {list.map((v) => (
        <div key={v.name} className={`row ${v.changed ? "changed" : ""}`} data-tip={`${v.type} ${v.name}`}>
          <span className="mono name">{v.name}</span>
          <span className="mono val">{v.value}</span>
        </div>
      ))}
    </div>
  );
}

function NoStop({ run }: { run: DebugRun | null }) {
  return (
    <div className="dim kdbg-hint" style={{ marginTop: 4 }}>
      {run?.status === "running"
        ? "Running under the debugger…"
        : run?.status === "done"
          ? "No stop to show."
          : "Set breakpoints in the code, then Debug run. Each stop shows the call stack, the variables and your watches, and you can step through what ran next."}
    </div>
  );
}
