// Shaking: how the parts answer the base (or the loads) going back and forth, from their modes.
//
// Each mode j with M-normalised shape φⱼ and natural frequency ωⱼ answers a harmonic push of size Pⱼ with
// qⱼ = Pⱼ / (ωⱼ² − ω² + 2iζωⱼω). Shaking the supports at acceleration A along a direction r pushes every mode by
// Pⱼ = −Γⱼ·A, Γⱼ = φⱼᵀ M r (the parts move relative to the base); loads going up and down push it by Pⱼ = φⱼᵀ F.
//
// A sine sweep is every frequency of a band in turn: the response peaks where the band crosses a mode, at about
// 1/(2ζ) times the slow answer. Random shaking is a base acceleration spectrum (g²/Hz, straight lines on log-log
// axes between its points): the modes' response covariance R_jk = ΓⱼΓₖ ∫ Re(HⱼHₖ*) S df gives every RMS value,
// von Mises by Segalman's quadratic form (the stress components keep their phases), and the life by Steinberg's
// three bands (68.3 % of the cycles at 1σ, 27.1 % at 2σ, 4.33 % at 3σ) at the rate the stress crosses zero.

/** mm/s² in one g */
export const G_MM = 9806.65;

/** Standard base acceleration spectra (Hz, g²/Hz). */
export const PSD_PRESETS: Record<string, { label: string; points: [number, number][] }> = {
  // electronics screening (the US Navy's NAVMAT P-9492): 20–2000 Hz, 6.06 g rms
  navmat: {
    label: "NAVMAT P-9492",
    points: [
      [20, 0.01],
      [80, 0.04],
      [350, 0.04],
      [2000, 0.007],
    ],
  },
  // a parcel or a part riding in a road vehicle (ASTM D4169 truck, assurance level II): 1–200 Hz, 0.52 g rms
  truck: {
    label: "ASTM D4169 truck, level II",
    points: [
      [1, 0.00005],
      [4, 0.01],
      [16, 0.01],
      [40, 0.001],
      [80, 0.001],
      [200, 0.00001],
    ],
  },
};

/** g²/Hz at f: straight lines between the points on log-log axes, nothing outside them. */
export function psdAt(pts: [number, number][], f: number): number {
  if (!pts.length || f < pts[0][0] || f > pts[pts.length - 1][0]) return 0;
  for (let i = 1; i < pts.length; i++) {
    const [f0, s0] = pts[i - 1];
    const [f1, s1] = pts[i];
    if (f > f1) continue;
    if (f1 === f0) return s1;
    if (!(s0 > 0) || !(s1 > 0)) return s0 + ((s1 - s0) * (f - f0)) / (f1 - f0);
    const n = Math.log(s1 / s0) / Math.log(f1 / f0);
    return s0 * Math.pow(f / f0, n);
  }
  return pts[pts.length - 1][1];
}

/** The overall level, g rms: the exact area under the log-log lines. */
export function grms(pts: [number, number][]): number {
  let area = 0;
  for (let i = 1; i < pts.length; i++) {
    const [f0, s0] = pts[i - 1];
    const [f1, s1] = pts[i];
    if (!(f1 > f0)) continue;
    if (!(s0 > 0) || !(s1 > 0)) {
      area += ((s0 + s1) / 2) * (f1 - f0);
      continue;
    }
    const n = Math.log(s1 / s0) / Math.log(f1 / f0);
    area += Math.abs(n + 1) < 1e-9 ? s0 * f0 * Math.log(f1 / f0) : (s1 * f1 - s0 * f0) / (n + 1);
  }
  return Math.sqrt(Math.max(area, 0));
}

/**
 * Frequencies (Hz) to sum a response over: evenly spaced on a log scale over [lo, hi], and close together around each
 * mode inside it (a mode's peak is about 2ζ·f wide).
 */
export function responseGrid(lo: number, hi: number, modes: number[], zeta: number, base = 400): number[] {
  const out: number[] = [];
  const r = Math.log(hi / lo);
  for (let i = 0; i <= base; i++) out.push(lo * Math.exp((r * i) / base));
  const z = Math.max(zeta, 1e-3);
  for (const fm of modes) {
    if (fm < lo * 0.5 || fm > hi * 2) continue;
    for (let t = -24; t <= 24; t += 0.25) {
      const f = fm * (1 + z * t);
      if (f >= lo && f <= hi) out.push(f);
    }
  }
  out.sort((a, b) => a - b);
  const u: number[] = [];
  for (const f of out) if (!u.length || f - u[u.length - 1] > 1e-9 * f) u.push(f);
  return u;
}

/** A mode's answer to a unit push at ω: 1 / (ωⱼ² − ω² + 2iζωⱼω), as [re, im]. */
export function modeGain(wj: number, w: number, zeta: number): [number, number] {
  const a = wj * wj - w * w;
  const b = 2 * zeta * wj * w;
  const d = a * a + b * b;
  return d > 0 ? [a / d, -b / d] : [0, 0];
}

/**
 * The modes' response covariance to base random shaking with spectrum pts (g²/Hz) along the direction their Γ are
 * taken for: R (k × k, mm²·t... in modal units) and R2, the same weighted by (2πf)² (velocity), for zero crossings.
 */
export function modalCovariance(w: number[], gam: number[], zeta: number, pts: [number, number][]): { R: Float64Array; R2: Float64Array; grid: number } {
  const k = w.length;
  const R = new Float64Array(k * k);
  const R2 = new Float64Array(k * k);
  if (!pts.length || !k) return { R, R2, grid: 0 };
  const lo = pts[0][0],
    hi = pts[pts.length - 1][0];
  const fs = responseGrid(lo, hi, w.map((x) => x / (2 * Math.PI)), zeta, 600);
  const hr = new Float64Array(k),
    hi2 = new Float64Array(k);
  let prev: { f: number; v: Float64Array; v2: Float64Array } | null = null;
  const S2 = G_MM * G_MM;
  for (const f of fs) {
    const om = 2 * Math.PI * f;
    const s = psdAt(pts, f) * S2;
    for (let j = 0; j < k; j++) {
      const [a, b] = modeGain(w[j], om, zeta);
      hr[j] = a * gam[j];
      hi2[j] = b * gam[j];
    }
    const v = new Float64Array(k * k);
    const v2 = new Float64Array(k * k);
    for (let j = 0; j < k; j++)
      for (let l = j; l < k; l++) {
        const re = (hr[j] * hr[l] + hi2[j] * hi2[l]) * s;
        v[j * k + l] = v[l * k + j] = re;
        v2[j * k + l] = v2[l * k + j] = re * om * om;
      }
    if (prev) {
      const df = f - prev.f;
      for (let i = 0; i < k * k; i++) {
        R[i] += ((prev.v[i] + v[i]) / 2) * df;
        R2[i] += ((prev.v2[i] + v2[i]) / 2) * df;
      }
    }
    prev = { f, v, v2 };
  }
  return { R, R2, grid: fs.length };
}

/** aᵀAb for the von Mises quadratic form on Voigt stresses [xx yy zz, three shears]: vm² = aᵀAa. */
export function vmForm(a: ArrayLike<number>, ia: number, b: ArrayLike<number>, ib: number): number {
  const a0 = a[ia],
    a1 = a[ia + 1],
    a2 = a[ia + 2];
  const b0 = b[ib],
    b1 = b[ib + 1],
    b2 = b[ib + 2];
  return a0 * b0 + a1 * b1 + a2 * b2 - 0.5 * (a0 * b1 + a1 * b0 + a1 * b2 + a2 * b1 + a2 * b0 + a0 * b2) + 3 * (a[ia + 3] * b[ib + 3] + a[ia + 4] * b[ib + 4] + a[ia + 5] * b[ib + 5]);
}

/**
 * The largest von Mises stress over a cycle of σ(t) = a·cos θ − b·sin θ (a and b the real and imaginary parts of a
 * stress amplitude), and the θ it is reached at.
 */
export function cyclePeak(a: ArrayLike<number>, ia: number, b: ArrayLike<number>, ib: number): { vm: number; theta: number } {
  const P = vmForm(a, ia, a, ia);
  const Q = vmForm(b, ib, b, ib);
  const R = vmForm(a, ia, b, ib);
  const half = (P - Q) / 2;
  const vm2 = (P + Q) / 2 + Math.hypot(half, R);
  return { vm: Math.sqrt(Math.max(vm2, 0)), theta: 0.5 * Math.atan2(-R, half) };
}

/** Steinberg's three-band life (s) at an RMS stress s1 crossing zero nu0 times a second; cycles(s) from the S-N curve. */
export function steinbergLife(s1: number, nu0: number, cycles: (s: number) => number): number {
  if (!(s1 > 0) || !(nu0 > 0)) return Infinity;
  const d = 0.683 / cycles(s1) + 0.271 / cycles(2 * s1) + 0.0433 / cycles(3 * s1);
  return d > 0 ? 1 / (nu0 * d) : Infinity;
}

/** Eigen-decomposition of a small symmetric matrix by Jacobi rotations: values and column vectors (row-major). */
export function symEigen(A: Float64Array, n: number): { val: Float64Array; vec: Float64Array } {
  const a = Float64Array.from(A);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
    let diag = 0;
    for (let p = 0; p < n; p++) diag += a[p * n + p] ** 2;
    if (off <= 1e-28 * Math.max(diag, 1e-300)) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1),
          s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p],
            akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k],
            aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p],
            vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
  }
  const val = new Float64Array(n);
  for (let i = 0; i < n; i++) val[i] = a[i * n + i];
  return { val, vec: v };
}

// ---------- the response of a solved model ----------

type V3 = [number, number, number];

export interface ShakeModel {
  nn: number;
  /** M-normalised mode shapes (3 per node, nothing at held freedoms) and their frequencies, rad/s */
  shapes: Float64Array[];
  w: number[];
  /** φᵀ M e_d of each mode along X, Y and Z, and the free mass along each, t */
  gamma: V3[];
  massAlong: V3;
  /** node stresses (6 per node, Voigt, averaged over the elements there) of a displacement field */
  stressOf: (v: Float64Array, out: Float64Array) => void;
  nodePos: (n: number) => V3;
  /** per node: its material's fatigue strength (MPa) for choosing the worst frequency, and its S-N cycles at a stress */
  fatigueAt: (n: number) => number;
  cyclesAt: (n: number, s: number) => number;
  materialAt: (n: number) => string;
  /** the loads, for a sweep with the loads going up and down */
  force?: Float64Array;
  progress: (frac: number) => void;
}

export interface ShakeAsk {
  shake?: { lo: number; hi: number; accel?: number; dir?: V3 };
  random?: { points: [number, number][]; dir: V3 };
  damping?: number;
  duration?: number;
}

export interface ShakeAnswer {
  /** the movement shown (sine: at the worst frequency, at the moment it moves most; random: a 3σ shape) */
  u: Float64Array;
  /** per node the stress shown: sine, at the moment of its own peak at the worst frequency; random, 3σ */
  S: Float64Array;
  kind: "sine" | "random";
  dir?: V3;
  level: number;
  lo: number;
  hi: number;
  damping: number;
  modes: number;
  topFreq: number;
  massShare: number;
  curve?: { f: number[]; disp: number[]; stress: number[] };
  at?: number;
  gain?: number;
  rms?: { disp: number; stress: number; at: V3 };
  nu0?: number;
  cycles: number;
  life: number;
  lifeAt: V3;
  lifeMaterial: string;
}

/** Modal stresses are kept for every node when they fit in about this many numbers; past it fewer modes are used. */
const KEEP = 18e6;
/** a sweep's curve is drawn at this many frequencies (and at each mode) */
const CURVE_POINTS = 240;
/** a sweep's worst stress is looked for at the nodes that work hardest in each mode, this many a mode */
const CANDIDATES = 48;

const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

export function shakeResponse(m: ShakeModel, ask: ShakeAsk, warnings: string[]): ShakeAnswer {
  const nn = m.nn;
  const zeta = ask.damping ?? 0.02;
  // as many modes as their stresses fit in memory
  let k = m.shapes.length;
  const fit = Math.max(1, Math.floor(KEEP / (6 * nn)));
  if (k > fit) {
    warnings.push(`The model is too big to keep every mode's stresses, so the shaking is answered from its first ${fit} modes.`);
    k = fit;
  }
  const shapes = m.shapes.slice(0, k);
  const w = m.w.slice(0, k);
  const fHz = w.map((x) => x / (2 * Math.PI));
  const tmp = new Float64Array(6 * nn);
  const modalS: Float32Array[] = [];
  const modalVm: Float32Array[] = [];
  for (let j = 0; j < k; j++) {
    m.stressOf(shapes[j], tmp);
    modalS.push(Float32Array.from(tmp));
    const v = new Float32Array(nn);
    for (let n = 0; n < nn; n++) v[n] = Math.sqrt(Math.max(vmForm(tmp, 6 * n, tmp, 6 * n), 0));
    modalVm.push(v);
    m.progress((0.5 * (j + 1)) / k);
  }
  const dirOf = ask.shake?.dir ?? ask.random?.dir;
  const dir = dirOf ? unit(dirOf) : undefined;
  const gam = dir ? m.gamma.slice(0, k).map((g) => g[0] * dir[0] + g[1] * dir[1] + g[2] * dir[2]) : [];
  const massDir = dir ? m.massAlong[0] * dir[0] ** 2 + m.massAlong[1] * dir[1] ** 2 + m.massAlong[2] * dir[2] ** 2 : 0;
  const massShare = dir && massDir > 0 ? gam.reduce((s, g) => s + g * g, 0) / massDir : 1;
  const topFreq = fHz[k - 1] ?? 0;
  const top = (arr: Float32Array | Float64Array, count: number): number[] => {
    const idx: number[] = [];
    let floor = -Infinity;
    for (let n = 0; n < arr.length; n++) {
      const v = arr[n];
      if (idx.length < count) {
        idx.push(n);
        if (idx.length === count) floor = Math.min(...idx.map((i) => arr[i]));
      } else if (v > floor) {
        let lo = 0;
        for (let i = 1; i < idx.length; i++) if (arr[idx[i]] < arr[idx[lo]]) lo = i;
        idx[lo] = n;
        floor = Math.min(...idx.map((i) => arr[i]));
      }
    }
    return idx;
  };

  if (ask.shake) {
    const sh = ask.shake;
    const base = sh.accel !== undefined && !!dir;
    const A = base ? sh.accel! * G_MM : 1;
    // each mode's push: the base's inertia on it, or the loads' share
    const P = shapes.map((phi, j) => {
      if (base) return -gam[j] * A;
      let s = 0;
      const F = m.force!;
      for (let i = 0; i < phi.length; i++) s += phi[i] * F[i];
      return s;
    });
    if (sh.hi > topFreq * 1.05 && k === m.shapes.length) warnings.push(`The modes found reach only ${fmtHz(topFreq)}, below the top of the sweep (${fmtHz(sh.hi)}), so higher frequencies are answered without the modes above that.`);
    if (base && massShare < 0.8) warnings.push(`The modes found move ${Math.round(massShare * 100)} % of the mass along the shaking, so the answer is a little low; ask for more modes: (up to 12).`);
    // the nodes that work hardest or move most in each mode
    const candS = new Set<number>();
    const candD = new Set<number>();
    for (let j = 0; j < k; j++) {
      for (const n of top(modalVm[j], CANDIDATES)) candS.add(n);
      const d = new Float32Array(nn);
      for (let n = 0; n < nn; n++) d[n] = Math.hypot(shapes[j][3 * n], shapes[j][3 * n + 1], shapes[j][3 * n + 2]);
      for (const n of top(d, CANDIDATES / 2)) candD.add(n);
    }
    const cs = [...candS];
    const cd = [...candD];
    const qr = new Float64Array(k),
      qi = new Float64Array(k);
    const at = (f: number) => {
      for (let j = 0; j < k; j++) {
        const [a, b] = modeGain(w[j], 2 * Math.PI * f, zeta);
        qr[j] = P[j] * a;
        qi[j] = P[j] * b;
      }
    };
    const sre = new Float64Array(6),
      sim = new Float64Array(6);
    /** the largest movement and stress among the candidates, and the worst stress for its material */
    const scan = (): { disp: number; stress: number; ratio: number } => {
      let disp = 0;
      for (const n of cd) {
        let s = 0;
        for (let d = 0; d < 3; d++) {
          let re = 0,
            im = 0;
          for (let j = 0; j < k; j++) {
            re += shapes[j][3 * n + d] * qr[j];
            im += shapes[j][3 * n + d] * qi[j];
          }
          s += re * re + im * im;
        }
        disp = Math.max(disp, Math.sqrt(s));
      }
      let stress = 0,
        ratio = 0;
      for (const n of cs) {
        for (let r = 0; r < 6; r++) {
          let re = 0,
            im = 0;
          for (let j = 0; j < k; j++) {
            const x = modalS[j][6 * n + r];
            re += x * qr[j];
            im += x * qi[j];
          }
          sre[r] = re;
          sim[r] = im;
        }
        const pk = cyclePeak(sre, 0, sim, 0).vm;
        stress = Math.max(stress, pk);
        ratio = Math.max(ratio, pk / Math.max(m.fatigueAt(n), 1e-6));
      }
      return { disp, stress, ratio };
    };
    // the worst frequency, on a fine grid around the modes, then closed in on between its neighbours
    const grid = responseGrid(sh.lo, sh.hi, fHz, zeta, 300);
    let worstF = sh.lo,
      worstR = -1,
      wi = 0;
    grid.forEach((f, i) => {
      at(f);
      const s = scan();
      if (s.ratio > worstR) {
        worstR = s.ratio;
        worstF = f;
        wi = i;
      }
    });
    {
      const ratioAt = (f: number) => {
        at(f);
        return scan().ratio;
      };
      let a = grid[Math.max(0, wi - 1)],
        b = grid[Math.min(grid.length - 1, wi + 1)];
      const g = (Math.sqrt(5) - 1) / 2;
      let c = b - g * (b - a),
        d = a + g * (b - a);
      let rc = ratioAt(c),
        rd = ratioAt(d);
      for (let it = 0; it < 24 && b - a > 1e-6 * worstF; it++) {
        if (rc > rd) {
          b = d;
          d = c;
          rd = rc;
          c = b - g * (b - a);
          rc = ratioAt(c);
        } else {
          a = c;
          c = d;
          rc = rd;
          d = a + g * (b - a);
          rd = ratioAt(d);
        }
      }
      const fm = rc > rd ? c : d;
      const rm = Math.max(rc, rd);
      if (rm > worstR) {
        worstR = rm;
        worstF = fm;
      }
    }
    // the curve to draw: evenly on a log scale, and at each mode in the band
    const cf: number[] = [];
    const r = Math.log(sh.hi / sh.lo);
    for (let i = 0; i <= CURVE_POINTS; i++) cf.push(sh.lo * Math.exp((r * i) / CURVE_POINTS));
    for (const f of fHz) if (f > sh.lo && f < sh.hi) cf.push(f);
    cf.push(worstF);
    cf.sort((a, b) => a - b);
    const curve = { f: [] as number[], disp: [] as number[], stress: [] as number[] };
    for (const f of cf) {
      if (curve.f.length && f - curve.f[curve.f.length - 1] < 1e-9 * f) continue;
      at(f);
      const s = scan();
      curve.f.push(f);
      curve.disp.push(s.disp);
      curve.stress.push(s.stress);
    }
    // the fields at the worst frequency
    at(worstF);
    const ure = new Float64Array(3 * nn),
      uim = new Float64Array(3 * nn);
    for (let j = 0; j < k; j++) {
      const phi = shapes[j];
      for (let i = 0; i < 3 * nn; i++) {
        ure[i] += phi[i] * qr[j];
        uim[i] += phi[i] * qi[j];
      }
    }
    // shown at the moment the part that moves most is furthest out
    let best = 0,
      bn = 0;
    for (let n = 0; n < nn; n++) {
      const s = ure[3 * n] ** 2 + ure[3 * n + 1] ** 2 + ure[3 * n + 2] ** 2 + uim[3 * n] ** 2 + uim[3 * n + 1] ** 2 + uim[3 * n + 2] ** 2;
      if (s > best) {
        best = s;
        bn = n;
      }
    }
    const Pp = ure[3 * bn] ** 2 + ure[3 * bn + 1] ** 2 + ure[3 * bn + 2] ** 2;
    const Qq = uim[3 * bn] ** 2 + uim[3 * bn + 1] ** 2 + uim[3 * bn + 2] ** 2;
    const Rr = ure[3 * bn] * uim[3 * bn] + ure[3 * bn + 1] * uim[3 * bn + 1] + ure[3 * bn + 2] * uim[3 * bn + 2];
    const th = 0.5 * Math.atan2(-Rr, (Pp - Qq) / 2);
    const u = new Float64Array(3 * nn);
    for (let i = 0; i < 3 * nn; i++) u[i] = ure[i] * Math.cos(th) - uim[i] * Math.sin(th);
    // each node's stress at the moment of its own peak
    const S = new Float64Array(6 * nn);
    let worstS = 0,
      worstN = 0;
    for (let n = 0; n < nn; n++) {
      for (let rr = 0; rr < 6; rr++) {
        let re = 0,
          im = 0;
        for (let j = 0; j < k; j++) {
          const x = modalS[j][6 * n + rr];
          re += x * qr[j];
          im += x * qi[j];
        }
        sre[rr] = re;
        sim[rr] = im;
      }
      const pk = cyclePeak(sre, 0, sim, 0);
      const c = Math.cos(pk.theta),
        s = Math.sin(pk.theta);
      for (let rr = 0; rr < 6; rr++) S[6 * n + rr] = sre[rr] * c - sim[rr] * s;
      const ratio = pk.vm / Math.max(m.fatigueAt(n), 1e-6);
      if (ratio > worstS) {
        worstS = ratio;
        worstN = n;
      }
    }
    // how many times the slow (static) answer it shakes, at the point that moves most
    let slow = 0;
    for (let d = 0; d < 3; d++) {
      let x = 0;
      for (let j = 0; j < k; j++) x += (shapes[j][3 * bn + d] * P[j]) / (w[j] * w[j]);
      slow += x * x;
    }
    const gain = slow > 0 ? Math.sqrt(best / slow) : 1;
    const vmWorst = Math.sqrt(Math.max(vmForm(S, 6 * worstN, S, 6 * worstN), 0));
    const cycles = ask.duration ? Math.max(1, worstF * ask.duration) : 1e7;
    const n0 = m.cyclesAt(worstN, vmWorst);
    m.progress(1);
    return {
      u,
      S,
      kind: "sine",
      ...(base ? { dir } : {}),
      level: base ? sh.accel! : 1,
      lo: sh.lo,
      hi: sh.hi,
      damping: zeta,
      modes: k,
      topFreq,
      massShare,
      curve,
      at: worstF,
      gain,
      cycles,
      life: Number.isFinite(n0) ? n0 / worstF : Infinity,
      lifeAt: m.nodePos(worstN),
      lifeMaterial: m.materialAt(worstN),
    };
  }

  // ---------- random shaking ----------
  const rnd = ask.random!;
  const pts = rnd.points;
  const lo = pts[0][0],
    hi = pts[pts.length - 1][0];
  if (hi > topFreq * 1.05 && k === m.shapes.length) warnings.push(`The modes found reach only ${fmtHz(topFreq)}, below the top of the spectrum (${fmtHz(hi)}), so the shaking above that is answered without the modes up there.`);
  if (massShare < 0.8) warnings.push(`The modes found move ${Math.round(massShare * 100)} % of the mass along the shaking, so the answer is a little low; ask for more modes: (up to 12).`);
  const { R, R2 } = modalCovariance(w, gam, zeta, pts);
  // R = V Λ Vᵀ: the response is the sum of k independent shapes Σⱼ √λₘ Vⱼₘ φⱼ, so RMS values add as squares
  const { val, vec } = symEigen(R, k);
  const coef: number[][] = [];
  for (let mm = 0; mm < k; mm++) {
    const l = Math.sqrt(Math.max(val[mm], 0));
    coef.push([...Array(k).keys()].map((j) => l * vec[j * k + mm]));
  }
  const u2 = new Float64Array(3 * nn);
  const field = new Float64Array(3 * nn);
  let domM = 0,
    domMax = -1;
  for (let mm = 0; mm < k; mm++) {
    field.fill(0);
    for (let j = 0; j < k; j++) {
      const c = coef[mm][j];
      if (c === 0) continue;
      const phi = shapes[j];
      for (let i = 0; i < 3 * nn; i++) field[i] += c * phi[i];
    }
    let mx = 0;
    for (let i = 0; i < 3 * nn; i++) {
      u2[i] += field[i] * field[i];
      mx = Math.max(mx, Math.abs(field[i]));
    }
    if (mx > domMax) {
      domMax = mx;
      domM = mm;
    }
  }
  // von Mises RMS (Segalman): Σₘ of each independent shape's von Mises squared; shown as 3σ with the tensor of the
  // shape that works each node hardest
  const vm2 = new Float64Array(nn);
  const best2 = new Float64Array(nn);
  const S = new Float64Array(6 * nn);
  const sT = new Float64Array(6);
  for (let mm = 0; mm < k; mm++) {
    for (let n = 0; n < nn; n++) {
      for (let r = 0; r < 6; r++) {
        let s = 0;
        for (let j = 0; j < k; j++) s += coef[mm][j] * modalS[j][6 * n + r];
        sT[r] = s;
      }
      const q = vmForm(sT, 0, sT, 0);
      vm2[n] += q;
      if (q > best2[n]) {
        best2[n] = q;
        for (let r = 0; r < 6; r++) S[6 * n + r] = sT[r];
      }
    }
    m.progress(0.5 + (0.45 * (mm + 1)) / k);
  }
  let worstN = 0,
    worstR = -1,
    rmsS = 0;
  for (let n = 0; n < nn; n++) {
    const sc = best2[n] > 0 ? (3 * Math.sqrt(vm2[n])) / Math.sqrt(best2[n]) : 0;
    for (let r = 0; r < 6; r++) S[6 * n + r] *= sc;
    const rms = Math.sqrt(vm2[n]);
    rmsS = Math.max(rmsS, rms);
    const ratio = rms / Math.max(m.fatigueAt(n), 1e-6);
    if (ratio > worstR) {
      worstR = ratio;
      worstN = n;
    }
  }
  // the movement shown: the shape that moves most, scaled to 3σ where it moves most
  let dn = 0,
    dBest = -1;
  for (let n = 0; n < nn; n++) {
    const s = u2[3 * n] + u2[3 * n + 1] + u2[3 * n + 2];
    if (s > dBest) {
      dBest = s;
      dn = n;
    }
  }
  const u = new Float64Array(3 * nn);
  for (let j = 0; j < k; j++) {
    const c = coef[domM][j];
    const phi = shapes[j];
    for (let i = 0; i < 3 * nn; i++) u[i] += c * phi[i];
  }
  const uDom = Math.hypot(u[3 * dn], u[3 * dn + 1], u[3 * dn + 2]);
  const dRms = Math.sqrt(Math.max(dBest, 0));
  const sc = uDom > 0 ? (3 * dRms) / uDom : 0;
  for (let i = 0; i < 3 * nn; i++) u[i] *= sc;
  // how often the worst spot's stress swings: √(m₂/m₀) of its von Mises form
  let m0 = 0,
    m2 = 0;
  const ms: Float64Array[] = [];
  for (let j = 0; j < k; j++) ms.push(Float64Array.from(modalS[j].subarray(6 * worstN, 6 * worstN + 6)));
  for (let j = 0; j < k; j++)
    for (let l = 0; l < k; l++) {
      const q = vmForm(ms[j], 0, ms[l], 0);
      m0 += q * R[j * k + l];
      m2 += q * R2[j * k + l];
    }
  const nu0 = m0 > 0 && m2 > 0 ? Math.sqrt(m2 / m0) / (2 * Math.PI) : fHz[0] ?? 0;
  const s1 = Math.sqrt(vm2[worstN]);
  const life = steinbergLife(s1, nu0, (s) => m.cyclesAt(worstN, s));
  const cycles = ask.duration ? Math.max(1, nu0 * ask.duration) : 1e7;
  m.progress(1);
  return {
    u,
    S,
    kind: "random",
    dir,
    level: grms(pts),
    lo,
    hi,
    damping: zeta,
    modes: k,
    topFreq,
    massShare,
    rms: { disp: dRms, stress: rmsS, at: m.nodePos(worstN) },
    nu0,
    cycles,
    life,
    lifeAt: m.nodePos(worstN),
    lifeMaterial: m.materialAt(worstN),
  };
}

const fmtHz = (f: number) => `${f < 10 ? f.toFixed(2) : f < 100 ? f.toFixed(1) : Math.round(f)} Hz`;
