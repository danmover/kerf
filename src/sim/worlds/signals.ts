// Test signals a world puts on a net: a plucked string, a steady sine or a
// square wave, in volts over time. A bench scenario feeds them to the
// controller's analog inputs, so firmware that listens to a signal (a tuner,
// a level meter) runs against something like the real thing.

export type SignalShape = "pluck" | "sine" | "square" | "path";

export interface SignalSpec {
  /** the net it drives, by name ("TUNER_IN") or as "component.PIN" */
  on: string;
  shape: SignalShape;
  /** Hz */
  f: number;
  /** the note it was asked for, when one was ("E2") */
  note?: string;
  /** peak volts either side of the offset */
  amplitude: number;
  /** volts it sits at (the bias the input is centred on) */
  offset: number;
  /** seconds from power-up to the first pluck, or before the signal starts */
  start: number;
  /** seconds between plucks (0: once) */
  every: number;
  /** seconds for a pluck to fall to 37 % */
  decay: number;
  /** shape "path": (seconds, volts) points with straight lines between them, held flat past the ends */
  points?: [number, number][];
}

const NOTE = /^([A-Ga-g])([#b]?)(-?\d)$/;
const SEMIS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** A note name ("E2", "A4", "C#3", "Bb1") as its frequency, equal temperament from A4 = 440 Hz; NaN if it is not one. */
export function noteHz(name: string): number {
  const m = NOTE.exec(name.trim());
  if (!m) return NaN;
  const semis = SEMIS[m[1].toUpperCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  const midi = (Number(m[3]) + 1) * 12 + semis;
  return 440 * 2 ** ((midi - 69) / 12);
}

/** a plucked string's harmonics: strong low ones, falling away */
const HARMONICS = [1, 0.62, 0.42, 0.3, 0.21, 0.14, 0.09, 0.05];
const PLUCK_PEAK = (() => {
  let peak = 0;
  for (let i = 0; i < 512; i++) {
    const x = (2 * Math.PI * i) / 512;
    peak = Math.max(peak, Math.abs(HARMONICS.reduce((a, h, k) => a + h * Math.sin((k + 1) * x), 0)));
  }
  return peak;
})();

/** The signal as volts at a time in seconds. */
export function signalFn(s: SignalSpec): (t: number) => number {
  if (s.shape === "path") {
    const pts = s.points?.length ? s.points : [[0, s.offset] as [number, number]];
    return (t) => {
      if (t <= pts[0][0]) return pts[0][1];
      for (let i = 1; i < pts.length; i++) {
        const [t1, v1] = pts[i];
        if (t <= t1) {
          const [t0, v0] = pts[i - 1];
          return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v1;
        }
      }
      return pts[pts.length - 1][1];
    };
  }
  const w = 2 * Math.PI * s.f;
  if (s.shape === "sine") return (t) => (t < s.start ? s.offset : s.offset + s.amplitude * Math.sin(w * (t - s.start)));
  if (s.shape === "square") return (t) => (t < s.start ? s.offset : s.offset + s.amplitude * (Math.sin(w * (t - s.start)) >= 0 ? 1 : -1));
  return (t) => {
    let tau = t - s.start;
    if (tau < 0) return s.offset;
    if (s.every > 0) tau %= s.every;
    // the higher harmonics die away faster than the fundamental, as on a string
    let x = 0;
    for (let k = 0; k < HARMONICS.length; k++) x += HARMONICS[k] * Math.exp((-tau * k) / s.decay) * Math.sin((k + 1) * w * tau);
    return s.offset + (s.amplitude / PLUCK_PEAK) * Math.exp(-tau / s.decay) * x;
  };
}

/** How a signal reads in a run's assumptions. */
export function describeSignal(s: SignalSpec): string {
  if (s.shape === "path") {
    const pts = s.points ?? [];
    const vs = pts.map((p) => p[1]);
    return `${s.on}: moved by hand between ${+Math.min(...vs).toFixed(2)} and ${+Math.max(...vs).toFixed(2)} V over ${+(pts.length ? pts[pts.length - 1][0] : 0).toFixed(1)} s (${pts.length} points)`;
  }
  // "an A2", "an E2", "an F3", but "a C4"
  const what = s.shape === "pluck" ? `${s.note ? `${/^[AEF]/i.test(s.note) ? "an" : "a"} ${s.note} ` : "a "}string plucked${s.every > 0 ? ` every ${+s.every.toFixed(2)} s` : " once"}` : `a ${s.shape} wave`;
  return `${s.on}: ${what} at ${+s.f.toFixed(2)} Hz, ±${+s.amplitude.toFixed(3)} V about ${+s.offset.toFixed(3)} V from ${+s.start.toFixed(2)} s`;
}
