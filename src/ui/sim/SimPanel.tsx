// The Simulate tab: the design's scenarios, each expectation's verdict across
// the three runs, the key numbers, plots over time, what happened, the
// firmware's serial console and the model's limits. With no scenario yet it
// offers ready-made tests and a box to describe one in plain words.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { commitSource } from "../../app/project";
import { revealSpan } from "../../app/view";
import { toast } from "../../app/ui";
import { evaluateOnly, useDesign } from "../../core/engine";
import type { Model } from "../../core/model";
import { sendMessage } from "../../ai/chat";
import { outcomesFor, runScenarioNow, setAutoRun, useSim, type SimRun } from "../../sim/runtime";
import type { ExpectOutcome } from "../../sim/expect";
import type { ScenarioDef } from "../../sim/scenario";
import type { VariantRun } from "../../sim/engine/run";
import { VARIANTS, VARIANT_LABEL, type VariantName } from "../../sim/worlds/common";
import { DEFAULT_PLOTS, channelInfo } from "../../sim/channels";
import { matchSeries } from "../../sim/frames";
import { fmtResult, resultInfo } from "../../sim/results";
import { SIM_TEMPLATES, describePrompt, templateSource } from "../../sim/templates";
import { fmtNum } from "../../lang/values";
import { Icon, StatusIcon } from "../icons";
import { useChatDraft } from "../chatDraft";
import { Plot } from "./Plot";
import { mmss, seek, useSelectedScenario } from "./simUi";
import "../../styles/sim.css";

type Status = "pass" | "warn" | "fail" | "pending" | "info";

/** One status for a scenario: its worst expectation, or its run state. */
export function scenarioStatus(def: ScenarioDef, run: SimRun | undefined): { status: Status; text: string; outs: ExpectOutcome[] } {
  if (!run || run.status === "waiting" || run.status === "running") {
    const p = run ? Object.values(run.progress) : [];
    const pct = p.length ? Math.round((p.reduce((a, b) => a + (b ?? 0), 0) / p.length) * 100) : 0;
    return { status: "pending", text: run?.status === "running" ? `${pct}%` : "queued", outs: [] };
  }
  if (run.status === "idle") return { status: "pending", text: "not run", outs: [] };
  if (run.status === "error" || !run.result) return { status: "fail", text: "error", outs: [] };
  if (run.result.error) return { status: "fail", text: "can't run", outs: [] };
  const outs = outcomesFor(def, run.result) ?? [];
  const fails = outs.filter((o) => o.status === "fail").length;
  const warns = outs.filter((o) => o.status === "warn").length;
  const pass = outs.length - fails - warns;
  return { status: fails ? "fail" : warns ? "warn" : "pass", text: outs.length ? `${pass}/${outs.length}` : "ran", outs };
}

const progressOf = (run?: SimRun) => {
  const p = run ? Object.values(run.progress) : [];
  return p.length ? p.reduce((a, b) => a + (b ?? 0), 0) / p.length : 0;
};

export function SimPanel() {
  const { model, defs, def, run, vrun } = useSelectedScenario();
  const runs = useSim((s) => s.runs);
  if (!model) return <div className="an-body mono dim">Building the design…</div>;
  if (!defs.length || !def) return <EmptyState model={model} />;
  return (
    <div className="sim">
      <div className="sim-head">
        {defs.map((d) => {
          const r = runs.get(d.label);
          const st = scenarioStatus(d, r);
          const busy = r?.status === "running" || r?.status === "waiting";
          return (
            <button key={d.label} className={`sim-pick ${d.label === def.label ? "active" : ""}`} onClick={() => useSim.setState({ selected: d.label, t: 0, playing: false })} aria-pressed={d.label === def.label}>
              <span className={`sim-dot ${st.status}`} />
              {d.label}
              <span className={`val ${st.status}`}>{st.text}</span>
              {busy && <span className="prog" style={{ width: `${Math.round(progressOf(r) * 100)}%` }} />}
            </button>
          );
        })}
        <div className="grow" />
        <HeadControls def={def} run={run} />
      </div>
      <div className="sim-body">
        <div className="sim-col">
          <Verdict def={def} run={run} />
          {vrun && <Stats def={def} v={vrun} />}
          {vrun && <Assumptions v={vrun} run={run!} />}
        </div>
        <div className="sim-col">{vrun ? <Plots def={def} v={vrun} /> : <Waiting run={run} />}</div>
        <div className="sim-col">{vrun ? <Happenings v={vrun} /> : <div className="dim mono" style={{ fontSize: 11.5 }}>Events and the firmware's console show here once the run is in.</div>}</div>
      </div>
    </div>
  );
}

function HeadControls({ def, run }: { def: ScenarioDef; run?: SimRun }) {
  const auto = useSim((s) => s.auto);
  const view = useSim((s) => s.view);
  const setDraft = useChatDraft((s) => s.set);
  const busy = run?.status === "running" || run?.status === "waiting";
  const st = scenarioStatus(def, run);
  const ask =
    st.status === "fail" || st.status === "warn"
      ? `The "${def.label}" simulation has ${st.outs.filter((o) => o.status !== "pass").map((o) => `"${o.label}" ${o.status === "fail" ? "failing" : "warning"}`).join(", ") || "a problem"}. Find out why from its results and fix the design or the firmware settings, then run it again.`
      : `Explain what the "${def.label}" simulation shows, and what it does not test.`;
  return (
    <>
      <button className={`sim-toggle ${auto ? "on" : ""}`} onClick={() => setAutoRun(!auto)} aria-pressed={auto} data-tip="Run scenarios again after every change">
        <Icon.Refresh size={12} /> auto
      </button>
      <button className="btn sm" disabled={busy} onClick={() => runScenarioNow(def.label)} data-tip="Run all three variants again">
        {busy ? <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> : <Icon.Play size={12} />} {busy ? "Running" : "Run"}
      </button>
      <button className={`sim-toggle ${view ? "on" : ""}`} disabled={!run?.result} onClick={() => useSim.setState({ view: !view })} aria-pressed={view} data-tip="Play the run in the 3D view">
        <Icon.Cube size={12} /> 3D
      </button>
      <button className="btn sm ghost" onClick={() => revealSpan(def.span)}>
        <Icon.Code size={13} /> edit
      </button>
      <button className="btn sm ghost" onClick={() => setDraft(ask)}>
        <Icon.Sparkle size={13} /> Ask Claude
      </button>
    </>
  );
}

function Waiting({ run }: { run?: SimRun }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(t);
  }, []);
  if (run?.status === "error") return <div className="sim-note" style={{ color: "#ffc4ca" }}>{run.error}</div>;
  if (run?.status === "idle")
    return (
      <div className="sim-note">
        This scenario changed since it last ran, and automatic runs are off.{" "}
        <button className="btn sm" onClick={() => runScenarioNow(run.label)}>
          <Icon.Play size={12} /> Run it
        </button>
      </div>
    );
  if (run?.result?.error) return <div className="sim-note" style={{ color: "#ffc4ca" }}>{run.result.error}</div>;
  const secs = run ? Math.max(0, (now - run.startedAt) / 1000) : 0;
  return (
    <div className="an-box">
      <div className="row" style={{ gap: 10 }}>
        <span className="spinner" />
        <span style={{ fontSize: 12.5 }}>Running the firmware on the virtual controller, in the world</span>
        <span className="mono dim" style={{ fontSize: 11 }}>
          {run ? Object.entries(run.progress).map(([v, p]) => `${v.slice(0, 4)} ${Math.round((p ?? 0) * 100)}%`).join(" · ") : "queued"} · {fmtNum(secs, 0)} s
        </span>
      </div>
      <div className="sim-progress">
        <div style={{ width: `${Math.round(progressOf(run) * 100)}%` }} />
      </div>
    </div>
  );
}

// ---------- verdict ----------

function Verdict({ def, run }: { def: ScenarioDef; run?: SimRun }) {
  const variant = useSim((s) => s.variant);
  const st = scenarioStatus(def, run);
  const outs = st.outs;
  const fails = outs.filter((o) => o.status === "fail").length;
  const warns = outs.filter((o) => o.status === "warn").length;
  const big =
    st.status === "pending"
      ? run?.status === "idle"
        ? "Not run since the last change"
        : run?.stale
          ? "Re-running for your latest change…"
          : "Running…"
      : run?.status === "error" || run?.result?.error
        ? "The simulation could not run"
        : !outs.length
          ? "Ran, with nothing to check"
          : fails
            ? `${fails} of ${outs.length} expectation${outs.length > 1 ? "s" : ""} fail${fails === 1 ? "s" : ""}`
            : warns
              ? `Passes, ${warns} to look at`
              : `All ${outs.length} expectations pass`;
  const variants = run?.result?.variants ?? [];
  const varStatus = (v: VariantName): Status => {
    if (!outs.length) return "pending";
    const per = outs.map((o) => o.variants.find((x) => x.variant === v)?.ok);
    if (per.some((x) => x === null || x === undefined)) return "pending";
    const hardFail = outs.some((o, i) => per[i] === false && o.level === "hard");
    return hardFail ? "fail" : per.some((x) => x === false) ? "warn" : "pass";
  };
  return (
    <>
      <div className={`sim-verdict ${st.status}`}>
        <div className="big">{big}</div>
        <div className="sub">
          {run?.result?.error ?? (run?.status === "error" ? run.error : `${worldText(def)}${def.uses.length ? ` · for ${def.uses.join(", ")}` : ""}`)}
        </div>
        {variants.length > 0 && (
          <div className="sim-variants" role="tablist" aria-label="Which run">
            {VARIANTS.filter((v) => variants.some((x) => x.variant === v)).map((v) => (
              <button key={v} role="tab" aria-selected={variant === v} className={`sim-var ${variant === v ? "active" : ""}`} onClick={() => useSim.setState({ variant: v })} data-tip={VARIANT_TIP[v]}>
                <span className={`sim-dot ${varStatus(v)}`} />
                {VARIANT_LABEL[v].toLowerCase()}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="sim-h">Expectations</div>
      {!def.expects.length && <div className="sim-note">No expectations yet: add lines like expect "Gets across": reached to the scenario.</div>}
      <AnimatePresence initial={false}>
        {def.expects.map((e, i) => {
          const o = outs[i];
          const status: Status = o?.status ?? "pending";
          const mine = o?.variants.find((x) => x.variant === variant);
          return (
            <motion.div key={e.label} className="sim-exp" onClick={() => revealSpan(e.span)} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} layout="position">
              <StatusIcon status={status} />
              <div className="t">
                {e.label}
                {e.level === "soft" && <small>soft</small>}
              </div>
              <div className="per">
                {o?.variants.map((x) => (
                  <span key={x.variant} className={`sim-dot ${x.ok === null ? "fail" : x.ok ? "pass" : e.level === "soft" ? "warn" : "fail"}`} title={`${VARIANT_LABEL[x.variant]}: ${x.detail}`} />
                ))}
              </div>
              <div className="d">{o ? (mine && variant !== "expected" ? `${VARIANT_LABEL[variant]} run: ${mine.detail}.` : o.detail) : <span className="mono">{e.text}</span>}</div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </>
  );
}

const VARIANT_TIP: Record<VariantName, string> = {
  pessimistic: "Worst likely values: denser sand, weaker grip, heavier loads",
  expected: "The best estimate: the run the checks are judged on",
  optimistic: "Best likely values: looser sand, better grip, lighter loads",
};

function worldText(def: ScenarioDef): string {
  const w = def.spec.world;
  if (w.kind === "sand_pit") {
    const p = w.pit;
    return `Sand pit ${fmtNum(p.length / 1000, 2)} m × ${fmtNum(p.width / 1000, 2)} m, ${fmtNum(p.depth / 1000, 2)} m deep${p.exitD ? `, ${fmtNum(p.exitD, 0)} mm exit` : ""}`;
  }
  return `On the bench${w.bench.loadFactor !== 1 ? `, ${w.bench.loadFactor ? `${fmtNum(w.bench.loadFactor * 100, 0)} % load` : "motors free"}` : ""}${w.bench.ambient !== 20 ? `, ${fmtNum(w.bench.ambient, 0)} °C` : ""}`;
}

// ---------- key numbers ----------

function Stats({ def, v }: { def: ScenarioDef; v: VariantRun }) {
  const world = def.spec.world.kind;
  const r = v.results;
  const pick = world === "sand_pit" ? ["progress", "miss", "speed", "slip", "heading_max", "battery_left"] : ["time", "battery_left", "battery_peak_amps", "faults"];
  const motors = v.summary.motors;
  const hottest = motors.reduce<{ name: string; t: number } | null>((a, m) => (!a || m.maxTemp > a.t ? { name: m.name, t: m.maxTemp } : a), null);
  const peak = motors.reduce<{ name: string; a: number } | null>((a, m) => (!a || m.peakAmps > a.a ? { name: m.name, a: m.peakAmps } : a), null);
  return (
    <>
      <div className="sim-h" style={{ marginTop: 12 }}>
        {VARIANT_LABEL[v.variant]} run<span className="grow" />
        <span style={{ textTransform: "none", letterSpacing: 0 }}>
          {mmss(v.summary.time)} · {v.stop}
        </span>
      </div>
      {v.summary.state && (
        <div className="sim-note mono" style={{ color: "var(--cyan)", marginTop: -4, marginBottom: 6 }}>
          firmware: {v.summary.state}
        </div>
      )}
      <div className="sim-stats">
        {pick
          .filter((k) => r[k] !== undefined)
          .map((k) => {
            const info = resultInfo(k, world);
            const text = fmtResult(r[k], info?.unit);
            const [num, ...rest] = text.split(" ");
            return (
              <div key={k} className="sim-stat" title={info?.doc}>
                <div className="k">{k.replace(/_/g, " ")}</div>
                <div className="v">
                  {num}
                  {rest.length > 0 && <small>{rest.join(" ")}</small>}
                </div>
              </div>
            );
          })}
        {hottest && (
          <div className={`sim-stat ${hottest.t > 80 ? "fail" : hottest.t > 60 ? "warn" : ""}`} title="Hottest motor winding">
            <div className="k">hottest motor</div>
            <div className="v">
              {fmtNum(hottest.t, 0)}
              <small>°C {hottest.name}</small>
            </div>
          </div>
        )}
        {peak && (
          <div className="sim-stat" title="Highest motor current">
            <div className="k">peak current</div>
            <div className="v">
              {fmtNum(peak.a, 1)}
              <small>A {peak.name}</small>
            </div>
          </div>
        )}
        <div className={`sim-stat ${v.summary.ram.used / v.summary.ram.total > 0.85 ? "warn" : ""}`} title="Globals plus the deepest stack">
          <div className="k">ram</div>
          <div className="v">
            {v.summary.ram.used}
            <small>/ {v.summary.ram.total} B</small>
          </div>
        </div>
        <div className="sim-stat" title="Longest single pass of loop()">
          <div className="k">loop()</div>
          <div className="v">
            {fmtNum(v.summary.loopMax, 2)}
            <small>ms max</small>
          </div>
        </div>
      </div>
    </>
  );
}

function Assumptions({ v, run }: { v: VariantRun; run: SimRun }) {
  const [open, setOpen] = useState(false);
  const config = run.result?.firmware.config ?? [];
  return (
    <>
      {config.length > 0 && (
        <div className="sim-note" style={{ color: "var(--warn)" }}>
          Firmware changed for this run: {config.map((c) => `${c.name} ${c.from} → ${c.to}`).join(", ")}
        </div>
      )}
      <button className="sim-h" style={{ background: "none", border: 0, padding: 0, marginTop: 12, cursor: "pointer", width: "100%" }} onClick={() => setOpen(!open)} aria-expanded={open}>
        What this assumes and leaves out<span className="grow" />
        <span style={{ transform: open ? "rotate(180deg)" : "none", display: "inline-grid", transition: "transform .2s" }}>
          <Icon.ChevronDown size={12} />
        </span>
      </button>
      {open && (
        <ul className="sim-note" style={{ paddingLeft: 16 }}>
          {[...v.assumptions, ...v.notes].map((a, i) => (
            <li key={`a${i}`}>{a}</li>
          ))}
          {v.limits.map((a, i) => (
            <li key={`l${i}`} style={{ color: "var(--text-4)" }}>
              {a}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------- plots ----------

function Plots({ def, v }: { def: ScenarioDef; v: VariantRun }) {
  const world = def.spec.world.kind;
  const defaults = useMemo(() => (DEFAULT_PLOTS[world] ?? DEFAULT_PLOTS.bench).map((ps) => [...new Set(ps.flatMap((p) => matchSeries(v.frames, p)))]).filter((x) => x.length), [world, v.frames]);
  const [plots, setPlots] = useState<string[][] | null>(null);
  useEffect(() => setPlots(null), [def.label]);
  const shown = (plots ?? defaults).map((ps) => ps.filter((n) => v.frames.series[n])).filter((x) => x.length);
  const all = Object.keys(v.frames.series).filter((n) => !/\.(px|py|pz)$/.test(n) && !n.startsWith("nose."));
  const groups = new Map<string, string[]>();
  for (const n of all) {
    const g = channelInfo(n).group;
    groups.set(g, [...(groups.get(g) ?? []), n]);
  }
  return (
    <>
      <Timeline v={v} />
      <div className="sim-plots">
        {shown.map((names, i) => (
          <Plot key={names.join("|")} frames={v.frames} names={names} events={v.events} onRemove={() => setPlots(shown.filter((_, j) => j !== i))} />
        ))}
        <div className="sim-add">
          <select
            value=""
            aria-label="Add a plot"
            onChange={(e) => {
              if (e.target.value) setPlots([...shown, [e.target.value]]);
            }}
          >
            <option value="">+ plot another series…</option>
            {[...groups].map(([g, ns]) => (
              <optgroup key={g} label={g}>
                {ns.map((n) => (
                  <option key={n} value={n}>
                    {channelInfo(n).label}
                    {channelInfo(n).unit ? ` (${channelInfo(n).unit})` : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>
    </>
  );
}

export function Timeline({ v, compact }: { v: VariantRun; compact?: boolean }) {
  const t = useSim((s) => s.t);
  const playing = useSim((s) => s.playing);
  const speed = useSim((s) => s.speed);
  const end = v.frames.t.length ? v.frames.t[v.frames.t.length - 1] : 0;
  const ref = useRef<HTMLDivElement>(null);
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    seek(((clientX - r.left) / r.width) * end);
  };
  const frac = end ? Math.min(1, t / end) : 0;
  return (
    <div className="sim-timeline">
      <button
        className="icon-btn sm"
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => {
          if (!playing && t >= end - 0.05) useSim.setState({ t: 0 });
          useSim.setState({ playing: !playing, view: compact ? true : useSim.getState().view || !playing });
        }}
      >
        {playing ? <Icon.Pause size={14} /> : <Icon.Play size={14} />}
      </button>
      <select value={speed} onChange={(e) => useSim.setState({ speed: Number(e.target.value) })} aria-label="Playback speed" className="mono" style={{ height: 24, borderRadius: 6, border: "1px solid var(--line-2)", background: "var(--bg-2)", color: "var(--text-2)", fontSize: 11 }}>
        {[1, 5, 10, 30, 60, 120].map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
      <div
        ref={ref}
        className="sim-scrub"
        role="slider"
        aria-label="Time in the run"
        aria-valuemin={0}
        aria-valuemax={Math.round(end)}
        aria-valuenow={Math.round(t)}
        tabIndex={0}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          at(e.clientX);
        }}
        onPointerMove={(e) => e.buttons && at(e.clientX)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") seek(t + end / 100);
          if (e.key === "ArrowLeft") seek(t - end / 100);
        }}
      >
        <div className="track" />
        <div className="fill" style={{ width: `${frac * 100}%` }} />
        {v.events
          .filter((e) => e.kind !== "info")
          .map((e, i) => (
            <div key={i} className={`tick ${e.kind}`} style={{ left: `${(e.t / (end || 1)) * 100}%` }} title={`${mmss(e.t)} ${e.text}`} />
          ))}
        <div className="knob" style={{ left: `${frac * 100}%` }} />
      </div>
      <span className="sim-time">
        {mmss(t)} / {mmss(end)}
      </span>
    </div>
  );
}

// ---------- events and console ----------

function Happenings({ v }: { v: VariantRun }) {
  const [tab, setTab] = useState<"events" | "console">("events");
  const t = useSim((s) => s.t);
  return (
    <>
      <div className="sim-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "events"} className={tab === "events" ? "on" : ""} onClick={() => setTab("events")}>
          events {v.events.length}
        </button>
        <button role="tab" aria-selected={tab === "console"} className={tab === "console" ? "on" : ""} onClick={() => setTab("console")}>
          serial console
        </button>
      </div>
      {tab === "events" ? <Events v={v} t={t} /> : <Console v={v} t={t} />}
    </>
  );
}

function Events({ v, t }: { v: VariantRun; t: number }) {
  if (!v.events.length) return <div className="sim-note">Nothing happened worth noting.</div>;
  return (
    <div>
      {v.events.map((e, i) => (
        <div key={i} className={`sim-event ${e.t > t + 0.05 ? "future" : ""}`} onClick={() => seek(e.t)}>
          <span className="at">{mmss(e.t)}</span>
          <span className={`k ${e.kind}`} />
          <span>{e.text}</span>
        </div>
      ))}
    </div>
  );
}

function Console({ v, t }: { v: VariantRun; t: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => v.serial.filter((l) => l.t <= t + 0.05).slice(-400), [v.serial, t]);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <div className="sim-console" ref={ref} aria-label="Serial console" aria-live="off">
      {!lines.length && <span style={{ color: "var(--text-4)" }}>Nothing printed yet at {mmss(t)}.</span>}
      {lines.map((l, i) => (
        <div key={i} className={`ln ${l.dir === "in" ? "in" : /^state:/.test(l.text) ? "state" : ""}`}>
          <span className="at">{mmss(l.t)}</span>
          <span>
            {l.dir === "in" ? "> " : ""}
            {l.text}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------- no scenario yet ----------

function EmptyState({ model }: { model: Model }) {
  const [text, setText] = useState("");
  const add = (id: string) => {
    const t = SIM_TEMPLATES.find((x) => x.id === id)!;
    const r = templateSource(t, model);
    if (r.reason) return toast({ kind: "warn", title: t.title, detail: r.reason });
    if (r.prompt) return void sendMessage(r.prompt);
    const { source } = useDesign.getState();
    const next = `${source.replace(/\s*$/, "")}\n\n${r.source}\n`;
    const err = evaluateOnly(next).diagnostics.find((d) => d.severity === "error" && !model.diagnostics.some((x) => x.message === d.message));
    if (err) return toast({ kind: "warn", title: "The scenario could not be added", detail: err.message });
    commitSource(next, "you", `Added the scenario "${t.title}"`);
  };
  return (
    <div className="sim-empty">
      <h3>Test the machine in a virtual world</h3>
      <div className="muted" style={{ maxWidth: 680, fontSize: 12.5, lineHeight: 1.55 }}>
        A scenario runs this design's own firmware on a virtual copy of its controller, wired exactly as the design says, to simulated motors, drivers, sensors and battery, inside an environment: a sand pit, a bench, a hot room. Each runs three times, with pessimistic, expected and optimistic values, and what it has to achieve becomes checks.
      </div>
      <div className="sim-gallery">
        {SIM_TEMPLATES.map((t) => {
          const why = t.unavailable?.(model) ?? null;
          return (
            <button key={t.id} className="sim-card" disabled={!!why} onClick={() => add(t.id)}>
              <div className="t">
                {t.id === "sand_pit" ? <Icon.Sparkle size={13} /> : <Icon.Play size={13} />}
                {t.title}
                <span className="tag">{t.prompt ? "Claude sets it up" : "add"}</span>
              </div>
              <div className="b">{t.blurb}</div>
              {why && <div className="why">{why}</div>}
            </button>
          );
        })}
      </div>
      <div className="sim-h" style={{ marginTop: 16 }}>
        Or describe the test
      </div>
      <div className="sim-describe">
        <textarea
          value={text}
          placeholder="e.g. make sure it can drill through a 2 m long pit of sand, 5 m deep, starting from a hole in the wall and coming out the far side"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) {
              void sendMessage(describePrompt(text));
              setText("");
            }
          }}
        />
        <button
          className="btn primary"
          disabled={!text.trim()}
          onClick={() => {
            void sendMessage(describePrompt(text));
            setText("");
          }}
        >
          <Icon.Sparkle size={13} /> Set it up
        </button>
      </div>
    </div>
  );
}
