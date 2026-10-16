// The Build tab's Sound section: the design's circuit simulated, with its
// knobs to turn, the frequency response they give, a guitar to listen to
// through it, how hard each stage works, and what the tuner would read.

import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { create } from "zustand";
import { designCircuit, type KnobSettings } from "../machine/circuit/netlist";
import { adcNodes, circuitKey, knobRoles, outProbe, preampFigures, responseDb, stageSwing, type KnobRole, type PreampFigures, type StageUse } from "../machine/circuit/analysis";
import { dcOperatingPoint, logFreqs } from "../machine/circuit/solver";
import { renderCircuit } from "../machine/circuit/render";
import { guitarTake, stringNote, STRINGS, TAKES, type TakeId } from "../machine/audio/guitar";
import { ADC_RATE, adcCodes, tunerReading, type Reading } from "../machine/audio/pitch";
import type { MachineData } from "../machine/types";
import { fmtNum } from "../lang/values";
import { playPosition, playSound, setCabinet, stopSound } from "./soundAudio";
import { Segmented, Toggle } from "./common";
import { Icon } from "./icons";
import "../styles/sound.css";

/** Sample rate and oversampling for listening: a guitar speaker gives nothing above 6 kHz, and 2× keeps the clipping diodes clean. */
const FS = 32000;
const OVERSAMPLE = 2;
const FREQS = logFreqs(20, 20000, 30);

interface SoundState {
  knobs: KnobSettings;
  pickup: "single" | "humbucker";
  cab: boolean;
  string: number;
  cents: number;
}
/** Remembered while the dock switches tabs. */
const useSound = create<SoundState>(() => ({ knobs: {}, pickup: "single", cab: true, string: 1, cents: 12 }));
const PICKUP_V = { single: 0.3, humbucker: 0.8 };

const ROLE_LABEL: Record<KnobRole, string> = { gain: "Gain", bass: "Bass", mid: "Middle", treble: "Treble", volume: "Volume" };
const ROLE_ORDER: KnobRole[] = ["gain", "bass", "mid", "treble", "volume"];

/** Preamp output for full power, from the design's amp_power calculation. */
function fullPowerVolts(m: MachineData): number {
  for (const c of m.calcs) {
    if (c.fn !== "amp_power") continue;
    const l = c.outputs.find((o) => /input for full power/i.test(o.label));
    if (l) return l.value;
  }
  return 1;
}

export function SoundPanel({ m }: { m: MachineData }) {
  const { knobs: saved, pickup, cab } = useSound();
  const base = useMemo(() => designCircuit(m), [m]);
  const roles = useMemo(() => knobRoles(base), [base]);
  const pots = useMemo(() => {
    const byComp = new Map(base.pots.map((p) => [p.comp, p]));
    const ordered = ROLE_ORDER.flatMap((r) => (roles[r] ? [{ ...byComp.get(roles[r]!)!, role: r as KnobRole | undefined }] : []));
    for (const p of base.pots) if (!ordered.some((o) => o.comp === p.comp)) ordered.push({ ...p, role: undefined });
    return ordered;
  }, [base, roles]);
  // every knob at noon and the volume up, unless turned
  const knobs = useMemo(() => {
    const k: KnobSettings = {};
    for (const p of pots) k[p.comp] = saved[p.comp] ?? (p.role === "volume" ? 0.7 : p.role === "gain" ? 0.3 : 0.5);
    return k;
  }, [pots, saved]);
  const op = useMemo(() => dcOperatingPoint(base.circuit), [base]);
  const key = useMemo(() => circuitKey(m), [m]);
  const pickV = PICKUP_V[pickup];
  const fullPower = fullPowerVolts(m);

  if (!base.input || !base.output) {
    return (
      <div className="mp-pad">
        <div className="empty-state">The Sound section plays a guitar through the design's circuit. It needs an input jack with a simulation model (lib.jack("jack_635_mono")) wired to the circuit, and an amplifier or speaker for it to drive.</div>
      </div>
    );
  }
  if (!op.ok) {
    return (
      <div className="mp-pad">
        <div className="empty-state">The circuit has no steady state, so it can't be played: {op.message}. The Checks tab says what to look at.</div>
      </div>
    );
  }

  const setKnob = (comp: string, v: number) => useSound.setState((s) => ({ knobs: { ...s.knobs, [comp]: Math.min(1, Math.max(0, v)) } }));

  return (
    <div className="mp-pad snd">
      <div className="snd-panel" role="group" aria-label="Amp knobs">
        {pots.map((p) => (
          <Knob key={p.comp} label={p.role ? ROLE_LABEL[p.role] : p.comp} sub={`${p.taper}${fmtNum(p.ohms >= 1e6 ? p.ohms / 1e6 : p.ohms / 1e3)}${p.ohms >= 1e6 ? "M" : "k"}`} value={knobs[p.comp]} onChange={(v) => setKnob(p.comp, v)} />
        ))}
        <div className="snd-panel-side">
          <div className="snd-side-label">Guitar</div>
          <Segmented
            id="snd-pickup"
            value={pickup}
            onChange={(v) => useSound.setState({ pickup: v })}
            options={[
              { value: "single", label: "Single coil", title: "About 0.3 V peak, like a Strat or Telecaster" },
              { value: "humbucker", label: "Humbucker", title: "About 0.8 V peak, like a Les Paul with hot pickups" },
            ]}
          />
          <button className="btn ghost sm" onClick={() => useSound.setState({ knobs: {} })} data-tip="Gain at 3, tone at noon, volume at 7">
            Reset knobs
          </button>
        </div>
      </div>
      <div className="snd-grid">
        <Response m={m} knobs={knobs} op={op} />
        <Listen m={m} knobs={knobs} op={op} pickV={pickV} cab={cab} fullPower={fullPower} circuitId={key} />
        <Stages m={m} knobs={knobs} op={op} pickV={pickV} />
        <Tuner m={m} op={op} pickV={pickV} />
      </div>
      <Figures m={m} pickV={pickV} />
    </div>
  );
}

// ---------------------------------------------------------------- knob

function Knob({ label, sub, value, onChange }: { label: string; sub: string; value: number; onChange: (v: number) => void }) {
  const drag = useRef<{ y: number; v: number } | null>(null);
  const SWEEP = 300;
  const ang = -SWEEP / 2 + value * SWEEP;
  const down = (e: RPointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, v: value };
  };
  const move = (e: RPointerEvent) => {
    if (!drag.current) return;
    onChange(drag.current.v + (drag.current.y - e.clientY) / (e.shiftKey ? 600 : 160));
  };
  const up = () => (drag.current = null);
  const ticks = Array.from({ length: 11 }, (_, i) => -SWEEP / 2 + (i / 10) * SWEEP);
  return (
    <div className="snd-knob">
      <svg
        viewBox="-40 -40 80 80"
        width={72}
        height={72}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={10}
        aria-valuenow={Math.round(value * 100) / 10}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onDoubleClick={() => onChange(0.5)}
        onWheel={(e) => onChange(value - Math.sign(e.deltaY) * 0.04)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowRight") (onChange(value + 0.05), e.preventDefault());
          if (e.key === "ArrowDown" || e.key === "ArrowLeft") (onChange(value - 0.05), e.preventDefault());
        }}
        data-tip="Drag up or down, scroll, or use the arrow keys. Double-click for noon."
      >
        {ticks.map((t, i) => (
          <line key={i} className={i % 5 === 0 ? "tick major" : "tick"} x1={0} y1={-34} x2={0} y2={i % 5 === 0 ? -29 : -31} transform={`rotate(${t})`} />
        ))}
        <path className="arc" d={arc(-SWEEP / 2, ang, 25)} />
        <circle className="skirt" r={22} />
        <circle className="cap" r={16} />
        <line className="pointer" x1={0} y1={-8} x2={0} y2={-21} transform={`rotate(${ang})`} />
      </svg>
      <div className="snd-knob-label">{label}</div>
      <div className="snd-knob-val">
        {fmtNum(value * 10, 1)} <span>{sub}</span>
      </div>
    </div>
  );
}

function arc(a0: number, a1: number, r: number): string {
  const p = (a: number) => [Math.sin((a * Math.PI) / 180) * r, -Math.cos((a * Math.PI) / 180) * r];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M${x0} ${y0} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

// ---------------------------------------------------------------- response

const W = 520;
const H = 190;
const PAD = { l: 34, r: 10, t: 10, b: 22 };

function Response({ m, knobs, op }: { m: MachineData; knobs: KnobSettings; op: ReturnType<typeof dcOperatingPoint> }) {
  const db = useMemo(() => responseDb(m, knobs, FREQS, op) ?? [], [m, knobs, op]);
  const noon = useMemo(() => {
    const k: KnobSettings = {};
    for (const c of Object.keys(knobs)) k[c] = 0.5;
    return responseDb(m, k, FREQS, op) ?? [];
  }, [m, knobs, op]);
  const [hover, setHover] = useState<number | null>(null);
  const top = Math.max(10, ...db, ...noon);
  const yMax = Math.ceil((top + 3) / 10) * 10;
  const yMin = yMax - 60;
  const x = (f: number) => PAD.l + ((Math.log10(f) - 1.30103) / 3) * (W - PAD.l - PAD.r);
  const y = (d: number) => PAD.t + ((yMax - Math.max(yMin, Math.min(yMax, d))) / (yMax - yMin)) * (H - PAD.t - PAD.b);
  const line = (v: number[]) => v.map((d, i) => `${i ? "L" : "M"}${x(FREQS[i]).toFixed(1)} ${y(d).toFixed(1)}`).join("");
  const peak = db.length ? Math.max(...db) : 0;
  const hi = hover !== null ? hover : db.indexOf(peak);
  return (
    <section className="snd-card">
      <div className="mp-h">
        Response <span className="grow" />
        <span className="snd-legend">
          <i className="now" /> these knobs <i className="noon" /> all at noon
        </span>
      </div>
      <svg
        className="snd-chart"
        viewBox={`0 0 ${W} ${H}`}
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const fx = ((e.clientX - r.left) / r.width) * W;
          let best = 0;
          FREQS.forEach((f, i) => Math.abs(x(f) - fx) < Math.abs(x(FREQS[best]) - fx) && (best = i));
          setHover(best);
        }}
        onPointerLeave={() => setHover(null)}
      >
        {[20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].map((f) => (
          <g key={f}>
            <line className="grid" x1={x(f)} x2={x(f)} y1={PAD.t} y2={H - PAD.b} />
            <text className="axis" x={x(f)} y={H - 6} textAnchor="middle">
              {f >= 1000 ? `${f / 1000}k` : f}
            </text>
          </g>
        ))}
        {Array.from({ length: 7 }, (_, i) => yMax - i * 10).map((d) => (
          <g key={d}>
            <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(d)} y2={y(d)} />
            <text className="axis" x={PAD.l - 5} y={y(d) + 3} textAnchor="end">
              {d}
            </text>
          </g>
        ))}
        <rect className="guitar-band" x={x(80)} y={PAD.t} width={x(5000) - x(80)} height={H - PAD.t - PAD.b} />
        <path className="noon" d={line(noon)} />
        <path className="area" d={`${line(db)}L${x(20000)} ${H - PAD.b}L${x(20)} ${H - PAD.b}Z`} />
        <path className="now" d={line(db)} />
        {db.length > 0 && hi >= 0 && (
          <g>
            <line className="cursor" x1={x(FREQS[hi])} x2={x(FREQS[hi])} y1={PAD.t} y2={H - PAD.b} />
            <circle className="dot" cx={x(FREQS[hi])} cy={y(db[hi])} r={3.5} />
            <text className="readout" x={Math.min(W - 90, x(FREQS[hi]) + 7)} y={Math.max(PAD.t + 10, y(db[hi]) - 8)}>
              {fmtNum(db[hi], 1)} dB at {FREQS[hi] >= 1000 ? `${fmtNum(FREQS[hi] / 1000, 2)} kHz` : `${fmtNum(FREQS[hi], 0)} Hz`}
            </text>
          </g>
        )}
      </svg>
      <div className="snd-note">Small-signal gain from the guitar to the power amp's input, clean. The shaded band is where a guitar speaker plays.</div>
    </section>
  );
}

// ---------------------------------------------------------------- listen

interface Take {
  key: string;
  out: Float32Array;
  peak: number;
}
const takeCache = new Map<string, Take>();

function Listen({ m, knobs, op, pickV, cab, fullPower, circuitId }: { m: MachineData; knobs: KnobSettings; op: ReturnType<typeof dcOperatingPoint>; pickV: number; cab: boolean; fullPower: number; circuitId: string }) {
  const [take, setTake] = useState<TakeId>("chord");
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [shown, setShown] = useState<Take | null>(null);
  const [pos, setPos] = useState<number | undefined>(undefined);
  const raf = useRef(0);
  const knobKey = Object.entries(knobs)
    .map(([k, v]) => `${k}:${v.toFixed(3)}`)
    .join(",");
  const key = `${circuitId.length}:${hash(circuitId)}|${knobKey}|${pickV}|${take}`;

  useEffect(() => () => (cancelAnimationFrame(raf.current), stopSound()), []);
  useEffect(() => setShown(takeCache.get(key) ?? null), [key]);

  const tick = () => {
    const p = playPosition();
    setPos(p);
    if (p !== undefined) raf.current = requestAnimationFrame(tick);
  };

  const play = async (id: TakeId) => {
    setTake(id);
    setErr("");
    const k = `${circuitId.length}:${hash(circuitId)}|${knobKey}|${pickV}|${id}`;
    let t = takeCache.get(k);
    if (!t) {
      const dc = designCircuit(m, knobs);
      const probe = outProbe(dc);
      if (!dc.input || !probe) return;
      setBusy(0);
      const wave = guitarTake(id, FS, pickV);
      const r = await renderCircuit({ circuit: dc.circuit, op, fs: FS, oversample: OVERSAMPLE, inputs: { [dc.input.id]: wave }, probes: [probe], onProgress: (f) => setBusy(f) });
      setBusy(null);
      if (r.cancelled) return;
      if (!r.ok || !r.out[0]) return setErr(r.message ?? "The simulation did not finish.");
      const out = r.out[0];
      let mean = 0;
      for (const v of out) mean += v;
      mean /= out.length;
      let peak = 0;
      for (const v of out) peak = Math.max(peak, Math.abs(v - mean));
      t = { key: k, out, peak };
      takeCache.set(k, t);
      if (takeCache.size > 12) takeCache.delete(takeCache.keys().next().value!);
    }
    setShown(t);
    playSound(t.out, FS, fullPower, { cab: useSound.getState().cab, onEnd: () => setPos(undefined) });
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
  };

  const power = shown ? shown.peak / fullPower : 0;
  return (
    <section className="snd-card">
      <div className="mp-h">
        Listen <span className="grow" />
        <label className="snd-toggle" data-tip="Hear the speaker in its open-back cabinet, or the amp's output straight">
          Speaker
          <Toggle
            on={cab}
            label="Speaker cabinet"
            onChange={(v) => {
              useSound.setState({ cab: v });
              setCabinet(v);
            }}
          />
        </label>
      </div>
      <div className="snd-takes">
        {TAKES.map((t) => (
          <button key={t.id} className={`btn sm ${take === t.id ? "primary" : ""}`} onClick={() => void play(t.id)} disabled={busy !== null} data-tip={t.tip}>
            <Icon.Play size={12} /> {t.label}
          </button>
        ))}
        {pos !== undefined && (
          <button className="btn ghost sm" onClick={() => (stopSound(), setPos(undefined))}>
            <Icon.Stop size={12} /> Stop
          </button>
        )}
      </div>
      <Wave take={shown} fullPower={fullPower} pos={pos} busy={busy} />
      {err ? (
        <div className="snd-note fail">{err}</div>
      ) : (
        <div className="snd-note">
          {busy !== null
            ? `Playing the guitar through ${m.components.filter((c) => c.pcb).length} parts of the circuit… ${Math.round(busy * 100)} %`
            : shown
              ? power > 1
                ? `The power amp clips: the preamp gives ${fmtNum(power * 100, 0)} % of what full power needs. Turn the volume down for a clean sound.`
                : `The loudest moment is ${fmtNum(power * power * 100, 0)} % of full power (${fmtNum(power * 100, 0)} % of full-power voltage).`
              : "Each take is a simulated guitar played through the whole circuit, then the power amp and the speaker. Change a knob and play again."}
        </div>
      )}
    </section>
  );
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function Wave({ take, fullPower, pos, busy }: { take: Take | null; fullPower: number; pos?: number; busy: number | null }) {
  const WW = 520;
  const WH = 70;
  const path = useMemo(() => {
    if (!take) return "";
    const n = take.out.length;
    let mean = 0;
    for (const v of take.out) mean += v;
    mean /= n;
    const cols = 260;
    const parts: string[] = [];
    for (let c = 0; c < cols; c++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = Math.floor((c * n) / cols); i < Math.floor(((c + 1) * n) / cols); i++) {
        const v = (take.out[i] - mean) / fullPower;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      const yy = (v: number) => WH / 2 - (Math.max(-1.4, Math.min(1.4, v)) * (WH / 2 - 4)) / 1.4;
      const xx = (c / cols) * WW;
      parts.push(`M${xx.toFixed(1)} ${yy(hi).toFixed(1)}V${yy(lo).toFixed(1)}`);
    }
    return parts.join("");
  }, [take, fullPower]);
  const full = (WH / 2 - 4) / 1.4;
  return (
    <svg className="snd-wave" viewBox={`0 0 ${WW} ${WH}`} preserveAspectRatio="none">
      <rect className="clip-zone" x={0} y={0} width={WW} height={WH / 2 - full} />
      <rect className="clip-zone" x={0} y={WH / 2 + full} width={WW} height={WH / 2 - full} />
      <line className="mid" x1={0} x2={WW} y1={WH / 2} y2={WH / 2} />
      {take && <path className="trace" d={path} />}
      {busy !== null && <rect className="progress" x={0} y={WH - 3} width={WW * busy} height={3} />}
      {pos !== undefined && <line className="head" x1={pos * WW} x2={pos * WW} y1={0} y2={WH} />}
    </svg>
  );
}

// ---------------------------------------------------------------- stages

function stageName(s: StageUse, i: number, all: StageUse[]): string {
  if (s.clips) return "Drive (clips by design)";
  if (s.sensing) return "Tuner feed";
  if (i === 0) return "Input buffer";
  const clipAt = all.findIndex((x) => x.clips);
  return clipAt >= 0 && i > clipAt ? "Recovery" : "Clean stage";
}

function Stages({ m, knobs, op, pickV }: { m: MachineData; knobs: KnobSettings; op: ReturnType<typeof dcOperatingPoint>; pickV: number }) {
  const [st, setSt] = useState<StageUse[] | null>(null);
  useEffect(() => {
    // after the knob settles: 40 ms of a G string through the non-linear circuit
    const t = setTimeout(() => setSt(stageSwing(m, knobs, pickV, 196, op)), 180);
    return () => clearTimeout(t);
  }, [m, knobs, op, pickV]);
  return (
    <section className="snd-card">
      <div className="mp-h">How hard each stage works</div>
      {!st ? (
        <div className="snd-note">Working it out…</div>
      ) : (
        <div className="snd-stages">
          {st.map((s, i) => {
            const pct = Math.min(1.2, s.use);
            const cls = s.clips ? "clips" : s.use >= 0.95 ? "fail" : s.use > 0.75 ? "warn" : "ok";
            return (
              <div key={s.label} className={`snd-stage ${cls}`} data-tip={`${s.label}: swings ${fmtNum(s.peak, 2)} V of the ${fmtNum(s.room, 2)} V it has before it clips`}>
                <span className="lbl">
                  <b>{s.label}</b> {stageName(s, i, st)}
                </span>
                <span className="bar">
                  <i style={{ width: `${(pct / 1.2) * 100}%` }} />
                  <em style={{ left: `${(1 / 1.2) * 100}%` }} />
                </span>
                <span className="pct">{s.clips ? "clips" : `${fmtNum(s.use * 100, 0)} %`}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="snd-note">Peak swing of each op-amp stage for a hard-picked G string, as a share of what it can give before it clips. Only the drive stage should clip.</div>
    </section>
  );
}

// ---------------------------------------------------------------- tuner

function Tuner({ m, op, pickV }: { m: MachineData; op: ReturnType<typeof dcOperatingPoint>; pickV: number }) {
  const { string, cents } = useSound();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ reading?: Reading; codes: Uint8Array; err?: string } | null>(null);
  const ref = Number(m.firmware.find((f) => f.settings.app === "tuner")?.settings.ref_hz ?? 440) || 440;
  const pluck = async () => {
    const dc = designCircuit(m);
    const adc = adcNodes(dc, m)[0];
    if (!dc.input || !adc) return setRes({ codes: new Uint8Array(), err: "No controller analog input is connected to the circuit." });
    setBusy(true);
    // a gentle pluck, the way you play when tuning
    const wave = stringNote(STRINGS[string].hz, cents, FS, pickV * 0.4, 0.55);
    const r = await renderCircuit({ circuit: dc.circuit, op, fs: FS, oversample: OVERSAMPLE, inputs: { [dc.input.id]: wave }, probes: [adc] });
    setBusy(false);
    if (r.cancelled) return;
    if (!r.ok || !r.out[0]) return setRes({ codes: new Uint8Array(), err: r.message ?? "The simulation did not finish." });
    const codes = adcCodes(r.out[0], FS);
    // the firmware reads 1024 samples (106 ms) once the attack has passed
    const start = Math.round(0.2 * ADC_RATE);
    const block = codes.slice(start, start + 1024);
    setRes({ reading: tunerReading(block, ref), codes: block });
  };
  const rd = res?.reading;
  const ok = rd && Math.abs(rd.cents) <= 3;
  return (
    <section className="snd-card">
      <div className="mp-h">Tuner</div>
      <div className="snd-tuner">
        <div className="snd-tuner-ctl">
          <div className="snd-strings">
            {STRINGS.map((s, i) => (
              <button key={s.name} className={`btn sm ${i === string ? "primary" : ""}`} onClick={() => useSound.setState({ string: i })}>
                {s.name.replace(/\d/, "")}
                <sub>{s.name.slice(-1)}</sub>
              </button>
            ))}
          </div>
          <label className="snd-detune">
            <span>
              String is {cents === 0 ? "in tune" : `${fmtNum(Math.abs(cents), 0)} cents ${cents > 0 ? "sharp" : "flat"}`}
            </span>
            <input type="range" min={-50} max={50} step={1} value={cents} onChange={(e) => useSound.setState({ cents: Number(e.target.value) })} />
          </label>
          <button className="btn sm primary" onClick={() => void pluck()} disabled={busy}>
            {busy ? <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> : <Icon.Play size={12} />} Pluck it
          </button>
        </div>
        <div className="snd-oled" aria-label="What the tuner screen shows">
          {!res ? (
            <div className="oled-idle">Pluck a string</div>
          ) : res.err ? (
            <div className="oled-idle">{res.err}</div>
          ) : !rd ? (
            <div className="oled-idle">-- no note --</div>
          ) : (
            <>
              <div className="oled-top">
                <span>A={fmtNum(ref)}</span>
                <span>{fmtNum(rd.hz, 1)} Hz</span>
              </div>
              <div className="oled-note">
                {rd.note.replace("#", "")}
                {rd.note.includes("#") && <sup>#</sup>}
                <sub>{rd.octave}</sub>
              </div>
              <div className="oled-bar">
                <i className="c" />
                <i className="n" style={{ left: `${50 + Math.max(-50, Math.min(50, rd.cents))}%` }} />
              </div>
              <div className="oled-cents">{ok ? "IN TUNE" : `${rd.cents > 0 ? "+" : ""}${fmtNum(rd.cents, 0)} cents`}</div>
            </>
          )}
        </div>
      </div>
      <Scope codes={res?.codes} />
      <div className="snd-note">
        The string goes through the tuner's own filter stage into the Nano's analog pin (simulated), is read {fmtNum(ADC_RATE, 0)} times a second the way the firmware reads it, and the firmware's pitch method names the note.
      </div>
    </section>
  );
}

function Scope({ codes }: { codes?: Uint8Array }) {
  const SW = 520;
  const SH = 46;
  const d = useMemo(() => {
    if (!codes?.length) return "";
    const n = Math.min(codes.length, 400);
    return Array.from({ length: n }, (_, i) => `${i ? "L" : "M"}${((i / (n - 1)) * SW).toFixed(1)} ${(SH - 2 - (codes[i] / 255) * (SH - 4)).toFixed(1)}`).join("");
  }, [codes]);
  return (
    <svg className="snd-scope" viewBox={`0 0 ${SW} ${SH}`} preserveAspectRatio="none" data-tip="The analog pin as the firmware reads it: 0 to 255 for 0 to 5 V">
      <line className="rail" x1={0} x2={SW} y1={2} y2={2} />
      <line className="rail" x1={0} x2={SW} y1={SH - 2} y2={SH - 2} />
      <line className="mid" x1={0} x2={SW} y1={SH / 2} y2={SH / 2} />
      {d && <path className="trace" d={d} />}
    </svg>
  );
}

// ---------------------------------------------------------------- figures

function Figures({ m, pickV }: { m: MachineData; pickV: number }) {
  const [f, setF] = useState<PreampFigures | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setF(preampFigures(m, pickV)), 60);
    return () => clearTimeout(t);
  }, [m, pickV]);
  if (!f?.ok) return null;
  const cells: [string, string, string][] = [
    ["Gain", `${fmtNum(f.gain_min_db, 0)} to ${fmtNum(f.gain_max_db, 0)} dB`, "At 1 kHz, gain knob at 0 and at 10"],
    ["Bass", `±${fmtNum(f.bass_db / 2, 1)} dB`, "How far the bass knob moves 100 Hz"],
    ["Middle", `±${fmtNum(f.mid_db / 2, 1)} dB`, "How far the middle knob moves 600 Hz"],
    ["Treble", `±${fmtNum(f.treble_db / 2, 1)} dB`, "How far the treble knob moves 4 kHz"],
    ["Input", `${fmtNum(f.input_kohm, 0)} kΩ`, "Input impedance: above 500 kΩ keeps the pickups' sparkle"],
    ["Headroom", `${fmtNum(f.headroom, 1)}×`, "How far the clean stages are from clipping, everything turned up"],
    ["Tuner signal", `${fmtNum(f.tuner_pp, 2)} V p-p`, `At the Nano's pin for a quietly picked note: about ${fmtNum((f.tuner_pp / 5) * 256, 0)} of the 256 steps the firmware reads`],
  ];
  return (
    <div className="snd-figs">
      {cells.map(([k, v, tip]) => (
        <div key={k} className="snd-fig" data-tip={tip}>
          <span>{k}</span>
          <b>{v}</b>
        </div>
      ))}
    </div>
  );
}
