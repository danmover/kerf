// Guitar takes to play through a simulated amp: plucked strings by the
// Karplus-Strong method with a pickup's tone, strummed into chords and riffs.
// Every take is the same each time (seeded noise), so A/B comparisons between
// knob settings hear the same performance.

export const STRINGS = [
  { name: "E2", hz: 82.41 },
  { name: "A2", hz: 110.0 },
  { name: "D3", hz: 146.83 },
  { name: "G3", hz: 196.0 },
  { name: "B3", hz: 246.94 },
  { name: "E4", hz: 329.63 },
];

export type TakeId = "chord" | "riff" | "notes";

export const TAKES: { id: TakeId; label: string; secs: number; tip: string }[] = [
  { id: "chord", label: "Chord", secs: 3, tip: "An open E major chord, strummed down then let ring" },
  { id: "riff", label: "Riff", secs: 3, tip: "Palm-muted power chords on the low strings" },
  { id: "notes", label: "Notes", secs: 3, tip: "A short lead line on the high strings" },
];

/** Small deterministic noise source. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

interface Note {
  /** start, s */
  t: number;
  hz: number;
  /** relative pick strength */
  vel: number;
  /** seconds before it is damped (palm mute or the next note) */
  len: number;
  /** palm muted: darker and shorter */
  mute?: boolean;
}

/** One plucked string added into `out` at sample rate fs. */
function pluck(out: Float32Array, fs: number, n: Note, rand: () => number) {
  // loop delay fs/hz: the buffer gives N samples less the half sample the averaging of
  // neighbours takes back, and a first-order allpass the fraction left over
  const D = fs / n.hz;
  let N = Math.max(2, Math.floor(D + 0.5));
  let frac = D + 0.5 - N;
  if (frac < 0.1 && N > 2) (N -= 1), (frac += 1);
  const C = (1 - frac) / (1 + frac);
  let apx = 0;
  let apy = 0;
  const buf = new Float32Array(N);
  // pick position about 1/7 along the string: a comb on the initial noise
  const pick = Math.max(1, Math.round(N / 7));
  for (let i = 0; i < N; i++) buf[i] = rand();
  for (let i = N - 1; i >= pick; i--) buf[i] -= buf[i - pick];
  // a softer pick has less treble: one pass of smoothing per step of softness
  const passes = n.mute ? 3 : 1;
  for (let p = 0; p < passes; p++) for (let i = 1; i < N; i++) buf[i] = 0.5 * (buf[i] + buf[i - 1]);
  const start = Math.round(n.t * fs);
  const ring = Math.round(n.len * fs);
  const fade = Math.round(0.08 * fs);
  const stop = Math.min(out.length, start + ring + fade);
  // decay per sample: a 6 s ring for open strings, about 0.3 s palm muted
  const loss = n.mute ? 0.985 : 0.9985 - (n.hz / 2000) * 0.002;
  let idx = 0;
  let prev = 0;
  for (let i = start; i < stop; i++) {
    const a = buf[idx];
    const b = buf[(idx + 1) % N];
    const v = loss * 0.5 * (a + b);
    const y = C * v + apx - C * apy;
    apx = v;
    apy = y;
    buf[idx] = y;
    idx = (idx + 1) % N;
    // after the note's length the fretting hand lifts and the string dies away
    const env = i - start > ring ? 1 - (i - start - ring) / fade : 1;
    out[i] += n.vel * env * (a - 0.2 * prev);
    prev = a;
  }
}

function notesFor(take: TakeId): Note[] {
  const s = STRINGS;
  if (take === "chord") {
    // E major: 0 2 2 1 0 0, strummed down 18 ms apart
    const hz = [s[0].hz, s[1].hz * 2 ** (2 / 12), s[2].hz * 2 ** (2 / 12), s[3].hz * 2 ** (1 / 12), s[4].hz, s[5].hz];
    return hz.map((h, i) => ({ t: 0.05 + i * 0.018, hz: h, vel: 1 - i * 0.06, len: 2.8 }));
  }
  if (take === "riff") {
    // E5 E5 G5 A5, palm muted, then a ringing E5
    const power = (root: number) => [root, root * 2 ** (7 / 12), root * 2];
    const out: Note[] = [];
    const hits: [number, number, boolean, number][] = [
      [0.05, s[0].hz, true, 0.22],
      [0.35, s[0].hz, true, 0.22],
      [0.65, s[0].hz * 2 ** (3 / 12), false, 0.5],
      [1.2, s[0].hz * 2 ** (5 / 12), false, 0.5],
      [1.75, s[0].hz, false, 1.2],
    ];
    for (const [t, root, mute, len] of hits) power(root).forEach((h, i) => out.push({ t: t + i * 0.012, hz: h, vel: 0.95 - i * 0.1, len, mute }));
    return out;
  }
  // a little E minor pentatonic line
  const line = [0, 3, 5, 7, 10, 7, 5, 3];
  return line.map((st, i) => ({ t: 0.05 + i * 0.32, hz: s[4].hz * 2 ** (st / 12), vel: 0.9, len: i === line.length - 1 ? 1 : 0.3 }));
}

/**
 * The guitar's output into the amp, volts, at sample rate fs. `peak` is the
 * loudest the pickup gets (0.3 V for single coils, about 0.8 V for hot
 * humbuckers).
 */
export function guitarTake(take: TakeId, fs: number, peak: number, seconds?: number): Float32Array {
  const secs = seconds ?? TAKES.find((t) => t.id === take)?.secs ?? 3;
  const out = new Float32Array(Math.round(fs * secs));
  const rand = rng(take === "chord" ? 7 : take === "riff" ? 11 : 13);
  for (const n of notesFor(take)) pluck(out, fs, n, rand);
  return scaleTo(out, peak);
}

/** One open string, detuned by `cents`, for the tuner. */
export function stringNote(hz: number, cents: number, fs: number, peak: number, seconds = 0.6): Float32Array {
  const out = new Float32Array(Math.round(fs * seconds));
  pluck(out, fs, { t: 0, hz: hz * 2 ** (cents / 1200), vel: 1, len: seconds }, rng(5));
  return scaleTo(out, peak);
}

function scaleTo(x: Float32Array, peak: number): Float32Array {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  return x;
}
