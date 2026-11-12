// The film's soundtrack, made with the Web Audio API in an offline context:
// pads, bass, an arpeggio and drums that build with the film (quiet under the
// title, fullest while it comes apart and moves, easing off under the cards),
// a whoosh into each cut, a hit as the title lands and a last chord at the end.

import type { FilmPlan } from "./timeline";
import type { FilmMusic, SectionKind } from "./spec";

/** How full the music is under each kind of shot, 0 to 1. */
const ENERGY: Record<SectionKind, number> = {
  title: 0.25,
  reveal: 0.6,
  build: 0.85,
  explode: 0.9,
  spotlight: 0.75,
  inside: 0.72,
  motion: 0.95,
  sim: 0.9,
  airflow: 0.82,
  results: 0.75,
  wiring: 0.78,
  firmware: 0.7,
  specs: 0.62,
  parts: 0.62,
  end: 0.3,
};

interface Mood {
  bpm: number;
  /** chords as MIDI notes, one per `bars` bars */
  chords: number[][];
  bars: number;
  bass: "eighths" | "halves" | "wholes";
  arp: "sixteenths" | "eighths" | null;
  drums: "four" | "half" | null;
  padCutoff: number;
}

const MOODS: Record<Exclude<FilmMusic, "off">, Mood> = {
  // A minor: Am F C G
  drive: { bpm: 112, chords: [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]], bars: 1, bass: "eighths", arp: "sixteenths", drums: "four", padCutoff: 1100 },
  // Am F Dm E, wide and slow
  epic: { bpm: 78, chords: [[57, 60, 64], [53, 57, 60], [50, 53, 57], [52, 56, 59]], bars: 2, bass: "halves", arp: "eighths", drums: "half", padCutoff: 900 },
  // Fmaj7 Am7 Cmaj7 G6, soft
  calm: { bpm: 72, chords: [[53, 57, 60, 64], [57, 60, 64, 67], [48, 52, 55, 59], [55, 59, 62, 64]], bars: 2, bass: "wholes", arp: "eighths", drums: null, padCutoff: 800 },
};

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  let s = 12345;
  for (let i = 0; i < d.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    d[i] = (s / 0x7fffffff) * 2 - 1;
  }
  return b;
}

/** A hall's echo: stereo noise dying away, darker as it goes. */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let s = 777 + c * 991;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const x = (s / 0x7fffffff) * 2 - 1;
      const t = i / n;
      // a one-pole low pass that closes as the tail goes on
      const k = 0.55 - 0.45 * t;
      lp += (x - lp) * k;
      d[i] = lp * Math.pow(1 - t, 3.2) * (i < ctx.sampleRate * 0.01 ? i / (ctx.sampleRate * 0.01) : 1);
    }
  }
  return b;
}

/** Energy at time t: the shots' levels, crossfaded like their pictures. */
function energyAt(plan: FilmPlan, t: number): number {
  let e = 0;
  let w = 0;
  for (const s of plan.shots) {
    if (t < s.start - 0.6 || t > s.end + 0.6) continue;
    const k = Math.min(1, Math.max(0, Math.min(t - s.start + 0.6, s.end + 0.6 - t) / 1.2));
    e += ENERGY[s.section.kind] * k;
    w += k;
  }
  return w ? e / w : 0.3;
}

/**
 * The soundtrack for a film, or null for a silent one. Rendered offline, so
 * it takes a second or two whatever the film's length.
 */
export async function soundtrack(plan: FilmPlan, music: FilmMusic, sampleRate = 48000): Promise<AudioBuffer | null> {
  if (music === "off" || plan.duration <= 0 || typeof OfflineAudioContext === "undefined") return null;
  const mood = MOODS[music];
  const dur = plan.duration;
  const ctx = new OfflineAudioContext(2, Math.ceil((dur + 0.05) * sampleRate), sampleRate);
  const noise = noiseBuffer(ctx, 2);

  // master: glue compression, a fade in and out
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 3;
  comp.attack.value = 0.01;
  comp.release.value = 0.25;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0, 0);
  master.gain.linearRampToValueAtTime(0.85, 0.35);
  master.gain.setValueAtTime(0.85, Math.max(0.4, dur - 1.8));
  master.gain.linearRampToValueAtTime(0, dur);
  comp.connect(master).connect(ctx.destination);
  const verb = ctx.createConvolver();
  verb.buffer = impulse(ctx, 3.2);
  const verbIn = ctx.createGain();
  verbIn.gain.value = 0.55;
  verbIn.connect(verb).connect(comp);
  const bus = (dry: number, wet: number) => {
    const g = ctx.createGain();
    const d = ctx.createGain();
    d.gain.value = dry;
    const w = ctx.createGain();
    w.gain.value = wet;
    g.connect(d).connect(comp);
    g.connect(w).connect(verbIn);
    return g;
  };
  const padBus = bus(0.5, 0.7);
  const bassBus = bus(0.9, 0.05);
  const arpBus = bus(0.35, 0.5);
  const drumBus = bus(0.9, 0.12);
  const fxBus = bus(0.45, 0.8);
  // a dotted-eighth echo for the arpeggio
  const beat = 60 / mood.bpm;
  const delay = ctx.createDelay(2);
  delay.delayTime.value = beat * 0.75;
  const fb = ctx.createGain();
  fb.gain.value = 0.32;
  const delayLp = ctx.createBiquadFilter();
  delayLp.type = "lowpass";
  delayLp.frequency.value = 2600;
  delay.connect(delayLp).connect(fb).connect(delay);
  const delayOut = ctx.createGain();
  delayOut.gain.value = 0.5;
  delayLp.connect(delayOut).connect(arpBus);

  const bar = beat * 4;
  const chordLen = bar * mood.bars;
  const chordAt = (t: number) => mood.chords[Math.floor(t / chordLen) % mood.chords.length];

  // pads: three or four detuned saws per chord, through a filter that opens with the energy
  for (let c0 = 0; c0 < dur; c0 += chordLen) {
    const chord = chordAt(c0 + 1e-6);
    const e = energyAt(plan, c0 + chordLen / 2);
    const end = Math.min(dur, c0 + chordLen);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 0.6;
    lp.frequency.setValueAtTime(mood.padCutoff * (0.6 + e), c0);
    lp.frequency.linearRampToValueAtTime(mood.padCutoff * (0.9 + 1.4 * e), end);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, c0);
    env.gain.linearRampToValueAtTime(0.06, c0 + Math.min(0.8, chordLen * 0.3));
    env.gain.setValueAtTime(0.06, Math.max(c0, end - 0.25));
    env.gain.linearRampToValueAtTime(0, end + 0.9);
    lp.connect(env).connect(padBus);
    for (const n of chord) {
      for (const det of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = hz(n);
        o.detune.value = det;
        o.connect(lp);
        o.start(c0);
        o.stop(end + 1);
      }
    }
    // a soft sub an octave under the root
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = hz(chord[0] - 12);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0, c0);
    sg.gain.linearRampToValueAtTime(0.05 * e, c0 + 0.4);
    sg.gain.linearRampToValueAtTime(0, end + 0.3);
    sub.connect(sg).connect(padBus);
    sub.start(c0);
    sub.stop(end + 0.4);
  }

  const notes = (step: number) => {
    const out: number[] = [];
    for (let t = 0; t < dur; t += step) out.push(t);
    return out;
  };

  // bass
  const bassStep = mood.bass === "eighths" ? beat / 2 : mood.bass === "halves" ? beat * 2 : bar;
  for (const t of notes(bassStep)) {
    const e = energyAt(plan, t);
    if (e < 0.5) continue;
    const root = chordAt(t)[0] - 24;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = hz(root);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 220 + 260 * e;
    const g = ctx.createGain();
    const len = mood.bass === "eighths" ? beat * 0.45 : bassStep * 0.9;
    const peak = (mood.bass === "eighths" ? 0.16 : 0.13) * e;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(Math.max(1e-4, peak * 0.25), t + len);
    g.gain.linearRampToValueAtTime(0, t + len + 0.05);
    o.connect(lp).connect(g).connect(bassBus);
    o.start(t);
    o.stop(t + len + 0.1);
  }

  // arpeggio over the chord
  if (mood.arp) {
    const step = mood.arp === "sixteenths" ? beat / 4 : beat / 2;
    let i = 0;
    for (const t of notes(step)) {
      const e = energyAt(plan, t);
      i++;
      if (e < (mood.arp === "sixteenths" ? 0.55 : 0.3)) continue;
      const ch = chordAt(t);
      const pattern = [0, 1, 2, 1, 2, 0, 1, 2];
      const n = ch[pattern[i % pattern.length] % ch.length] + 12 + (i % 16 >= 12 ? 12 : 0);
      const o = ctx.createOscillator();
      o.type = mood.arp === "sixteenths" ? "square" : "triangle";
      o.frequency.value = hz(n);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1400 + 2200 * e;
      const g = ctx.createGain();
      const peak = (mood.arp === "sixteenths" ? 0.035 : 0.05) * e;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.005);
      g.gain.exponentialRampToValueAtTime(1e-4, t + step * 1.6);
      o.connect(lp).connect(g);
      g.connect(arpBus);
      g.connect(delay);
      o.start(t);
      o.stop(t + step * 1.7);
    }
  }

  const hit = (t: number, f0: number, f1: number, len: number, peak: number, out: AudioNode) => {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + len * 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.004);
    g.gain.exponentialRampToValueAtTime(1e-4, t + len);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + len + 0.05);
  };
  const burst = (t: number, type: BiquadFilterType, f: number, len: number, peak: number, out: AudioNode, q = 0.8) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = f;
    flt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.002);
    g.gain.exponentialRampToValueAtTime(1e-4, t + len);
    src.connect(flt).connect(g).connect(out);
    src.start(t, (t * 7.31) % 1.5);
    src.stop(t + len + 0.02);
  };

  // drums
  if (mood.drums) {
    let b = 0;
    for (const t of notes(beat)) {
      const e = energyAt(plan, t);
      const inBar = b++ % 4;
      if (mood.drums === "four") {
        if (e >= 0.6) hit(t, 130, 44, 0.42, 0.55 * e, drumBus);
        if (e >= 0.8 && (inBar === 1 || inBar === 3)) {
          burst(t, "bandpass", 1900, 0.2, 0.22 * e, drumBus, 0.7);
          hit(t, 220, 170, 0.12, 0.12 * e, drumBus);
        }
        if (e >= 0.72) burst(t + beat / 2, "highpass", 7500, 0.05, 0.07 * e, drumBus);
        if (e >= 0.88) burst(t + beat * 0.75, "highpass", 8000, 0.03, 0.035 * e, drumBus);
      } else {
        // half time: a deep hit on one and three, a big clap on three
        if (e >= 0.55 && (inBar === 0 || inBar === 2)) hit(t, 110, 38, 0.8, 0.6 * e, drumBus);
        if (e >= 0.7 && inBar === 2) burst(t, "bandpass", 1500, 0.45, 0.2 * e, fxBus, 0.6);
      }
    }
  }

  // a whoosh into each cut, and a low hit on cuts into busy shots
  plan.shots.forEach((s, i) => {
    if (i === 0) return;
    const at = s.start + 0.25;
    const w0 = Math.max(0, at - 0.75);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(250, w0);
    bp.frequency.exponentialRampToValueAtTime(4200, at);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, w0);
    g.gain.linearRampToValueAtTime(0.13, at - 0.05);
    g.gain.exponentialRampToValueAtTime(1e-4, at + 0.35);
    src.connect(bp).connect(g).connect(fxBus);
    src.start(w0);
    src.stop(at + 0.4);
    const e = ENERGY[s.section.kind];
    if (e >= 0.85 && music !== "calm") hit(at, 90, 34, 1.1, 0.35, fxBus);
  });

  // the title: a rising sweep and a hit as it lands
  if (plan.shots[0]?.section.kind === "title") {
    const land = 0.9;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "bandpass";
    hp.Q.value = 2;
    hp.frequency.setValueAtTime(400, 0);
    hp.frequency.exponentialRampToValueAtTime(5000, land);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(0.08, land - 0.05);
    g.gain.exponentialRampToValueAtTime(1e-4, land + 0.2);
    src.connect(hp).connect(g).connect(fxBus);
    src.start(0);
    src.stop(land + 0.3);
    hit(land, 70, 30, 2.2, music === "calm" ? 0.25 : 0.5, fxBus);
    burst(land, "lowpass", 900, 1.4, 0.12, fxBus);
  }

  // the end card: one last chord, left to ring
  const last = plan.shots[plan.shots.length - 1];
  if (last?.section.kind === "end") {
    const at = last.start + 0.4;
    const ch = mood.chords[0];
    for (const n of [...ch, ch[0] + 12]) {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = hz(n);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.05, at + 0.02);
      g.gain.exponentialRampToValueAtTime(1e-4, Math.min(dur, at + 3.5));
      o.connect(g).connect(fxBus);
      o.start(at);
      o.stop(Math.min(dur, at + 3.6));
    }
    if (music !== "calm") hit(at, 80, 32, 2, 0.4, fxBus);
  }

  return ctx.startRendering();
}
