// Pitch detection the way the tuner firmware does it: a coarse YIN search for
// the period on a block of 8-bit ADC readings, then the period measured again
// across several cycles for a fine reading. The Sound section runs it on the
// simulated analog input to show what the tuner's screen would read.

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Sample rate of the Nano's free-running ADC at its /128 prescaler: 16 MHz / 128 / 13. */
export const ADC_RATE = 16e6 / 128 / 13;

export interface Reading {
  hz: number;
  /** how sure: 1 − the YIN dip, 0..1 */
  clarity: number;
  note: string;
  octave: number;
  /** cents sharp (+) or flat (−) of the nearest note */
  cents: number;
}

/** The nearest note to a frequency, against reference pitch A4 = ref. */
export function noteOf(hz: number, ref = 440): Omit<Reading, "clarity"> {
  const n = Math.round(12 * Math.log2(hz / ref));
  const cents = 1200 * Math.log2(hz / (ref * 2 ** (n / 12)));
  const midi = 69 + n;
  return { hz, note: NOTE_NAMES[((midi % 12) + 12) % 12], octave: Math.floor(midi / 12) - 1, cents };
}

/**
 * YIN pitch estimate of x (any scale or offset), or undefined when
 * no period stands out. Searches periods for 60 Hz .. 1.2 kHz.
 */
export function yin(x: ArrayLike<number>, fs: number, threshold = 0.15): { hz: number; clarity: number } | undefined {
  const N = x.length;
  const W = Math.floor(N / 2);
  const tauMin = Math.max(2, Math.floor(fs / 1200));
  const tauMax = Math.min(W - 1, Math.ceil(fs / 60));
  const d = new Float64Array(tauMax + 2);
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const v = x[i] - x[i + tau];
      s += v * v;
    }
    d[tau] = s;
  }
  // cumulative mean normalised difference
  const cm = new Float64Array(tauMax + 2);
  cm[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    run += d[tau];
    cm[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cm[t] < threshold) {
      while (t + 1 <= tauMax && cm[t + 1] < cm[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return undefined;
  // parabolic interpolation between neighbouring lags
  const a = cm[tau - 1];
  const b = cm[tau];
  const c = cm[tau + 1];
  const den = a - 2 * b + c;
  const shift = Math.abs(den) > 1e-12 ? (0.5 * (a - c)) / den : 0;
  return { hz: fs / (tau + Math.max(-0.5, Math.min(0.5, shift))), clarity: Math.max(0, 1 - b) };
}

/** Voltages sampled at fs as the firmware reads them: the ADC's top 8 bits (0..255 for 0..5 V) at ADC_RATE. */
export function adcCodes(v: ArrayLike<number>, fs: number, vref = 5): Uint8Array {
  const n = Math.floor(((v.length - 1) / fs) * ADC_RATE);
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const t = (k * fs) / ADC_RATE;
    const i = Math.floor(t);
    const f = t - i;
    const x = v[i] + (v[Math.min(v.length - 1, i + 1)] - v[i]) * f;
    out[k] = Math.max(0, Math.min(255, Math.floor((x / vref) * 256)));
  }
  return out;
}

/** Squared difference of x against itself `lag` samples later, over the samples that fit. */
function diff(x: ArrayLike<number>, lag: number): number {
  let s = 0;
  const n = x.length - lag;
  for (let i = 0; i < n; i++) {
    const v = x[i] - x[i + lag];
    s += v * v;
  }
  return s / Math.max(1, n);
}

/**
 * The period refined across k cycles: the difference minimum near k·period,
 * with k as large as leaves a third of the block to compare, found by a
 * parabola through the three lags around it.
 */
export function finePeriod(x: ArrayLike<number>, period: number): number {
  const k = Math.max(1, Math.floor((x.length * 2) / 3 / period));
  const T = Math.round(k * period);
  const a = diff(x, T - 1);
  const b = diff(x, T);
  const c = diff(x, T + 1);
  const den = a - 2 * b + c;
  const shift = den > 1e-12 ? (0.5 * (a - c)) / den : 0;
  return (T + Math.max(-1, Math.min(1, shift))) / k;
}

/** What the tuner reads from a block of ADC readings (1024 of them, 106 ms, like the firmware). */
export function tunerReading(codes: ArrayLike<number>, ref = 440): Reading | undefined {
  const r = yin(codes, ADC_RATE);
  if (!r) return undefined;
  const hz = ADC_RATE / finePeriod(codes, ADC_RATE / r.hz);
  return { ...noteOf(hz, ref), clarity: r.clarity };
}
