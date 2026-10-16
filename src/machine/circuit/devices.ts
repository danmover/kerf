// Nonlinear device models and their Newton bookkeeping. Each device keeps the
// point it was last linearised at (v0), its currents there (f0), the
// derivatives there (J) and the derivatives that are in the factored matrix
// (Jf). Stamping uses Jf, so a stale factorisation still gives a correct
// (chord) Newton step; `update` evaluates at the new solution and says
// whether the linear model predicted the real currents well enough to stop.

import { GMIN, OA_SLOTS, REG_SLOTS, SW_SLOTS, type Compiled } from "./compile";

export interface Tol {
  /** relative tolerance on device currents */
  rel: number;
  /** absolute tolerance on currents, amps */
  absI: number;
  /** absolute tolerance on op-amp output voltages, volts */
  absV: number;
  /** refactor when a derivative moves by more than rel·|J| + abs; 0 refactors every iteration */
  jrel: number;
  jabs: number;
}

const EXP_LIM = 80;
const E_LIM = Math.exp(EXP_LIM);
/** class-AB crossover current: how sharply an op-amp's load current moves from one supply pin to the other */
const OA_SPLIT = 1e-3;
/** smoothing of the regulator's dropout and floor, volts */
const REG_SMOOTH = 0.02;

// scratch results of the inline evaluators, so the hot loops allocate nothing
let EI = 0;
let EG = 0;
let SW_GC = 0;
let RF0 = 0;
let RF1 = 0;
let RJ0 = 0;
let RJ1 = 0;
let RJ2 = 0;

function diodeEval(v: number, is: number, nvt: number, bv: number, ibv: number) {
  const z = v / nvt;
  let e: number;
  let de: number;
  if (z > EXP_LIM) {
    e = E_LIM * (1 + z - EXP_LIM);
    de = E_LIM;
  } else {
    e = Math.exp(z);
    de = e;
  }
  let i = is * (e - 1);
  let g = (is * de) / nvt;
  if (bv > 0) {
    const zb = -(v + bv) / nvt;
    if (zb > EXP_LIM) {
      i -= ibv * E_LIM * (1 + zb - EXP_LIM);
      g += (ibv * E_LIM) / nvt;
    } else if (zb > -EXP_LIM) {
      const eb = Math.exp(zb);
      i -= ibv * eb;
      g += (ibv * eb) / nvt;
    }
  }
  EI = i + GMIN * v;
  EG = g + GMIN;
}

/** SPICE's junction limiting: keep an exponential from leaping across many decades in one Newton step. */
export function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > vt + vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      return arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    }
    return vt * Math.log(vnew / vt);
  }
  if (vnew < 0) {
    const arg = vold > 0 ? -vold - 1 : 2 * vold - 1;
    if (vnew < arg) return arg;
  }
  return vnew;
}

function softplus(z: number): number {
  if (z > 40) return z;
  if (z < -40) return 0;
  return Math.log1p(Math.exp(z));
}
function sigmoid(z: number): number {
  if (z > 40) return 1;
  if (z < -40) return 0;
  return 1 / (1 + Math.exp(-z));
}

// op-amp evaluation results: currents, then derivatives
const OF = new Float64Array(3); // Io (into the out node), Fc (clamp current out of x), Iq (V+ to V−)
const OJ = new Float64Array(8); // Su, Shi, Slo, cx, cp, cn, gq, w

const near = (a: number, b: number, rel: number, abs: number) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b)) + abs;

export class Devices {
  dirty = true;
  // slot bindings (original matrix slots, or factor slots after bind)
  private dS: Int32Array;
  private oS: Int32Array;
  private sS: Int32Array;
  private rS: Int32Array;
  // diodes: junction voltage, current, conductance, conductance in the factorisation
  readonly dV: Float64Array;
  readonly dI: Float64Array;
  readonly dG: Float64Array;
  readonly dGf: Float64Array;
  // op-amps: v0 = vx, vo, V+, V− (4 per); f0 (3 per); J and Jf (8 per)
  readonly oV: Float64Array;
  readonly oF: Float64Array;
  readonly oJ: Float64Array;
  readonly oJf: Float64Array;
  // switches: v0 = vc, v01; f0 = I; J = g, gc
  readonly sV: Float64Array;
  readonly sI: Float64Array;
  readonly sJ: Float64Array;
  readonly sJf: Float64Array;
  // regulators: v0 = vin−gnd, vout−gnd; f0 = I, Iq; J = gi, go, gq
  readonly rV: Float64Array;
  readonly rF: Float64Array;
  readonly rJ: Float64Array;
  readonly rJf: Float64Array;

  constructor(
    readonly cc: Compiled,
    map?: Int32Array,
  ) {
    const nd = cc.dio.el.length;
    const no = cc.oa.el.length;
    const ns = cc.sw.el.length;
    const nr = cc.reg.el.length;
    this.dV = new Float64Array(nd);
    this.dI = new Float64Array(nd);
    this.dG = new Float64Array(nd);
    this.dGf = new Float64Array(nd);
    this.oV = new Float64Array(4 * no);
    this.oF = new Float64Array(3 * no);
    this.oJ = new Float64Array(8 * no);
    this.oJf = new Float64Array(8 * no);
    this.sV = new Float64Array(2 * ns);
    this.sI = new Float64Array(ns);
    this.sJ = new Float64Array(2 * ns);
    this.sJf = new Float64Array(2 * ns);
    this.rV = new Float64Array(2 * nr);
    this.rF = new Float64Array(2 * nr);
    this.rJ = new Float64Array(3 * nr);
    this.rJf = new Float64Array(3 * nr);
    this.dS = cc.dio.slots;
    this.oS = cc.oa.slots;
    this.sS = cc.sw.slots;
    this.rS = cc.reg.slots;
    if (map) this.bind(map);
  }

  /** Stamp into factor slots through this map from now on (or original slots when omitted). */
  bind(map?: Int32Array) {
    const { cc } = this;
    const via = (s: Int32Array) => (map ? Int32Array.from(s, (q) => map[q]) : s);
    this.dS = via(cc.dio.slots);
    this.oS = via(cc.oa.slots);
    this.sS = via(cc.sw.slots);
    this.rS = via(cc.reg.slots);
    this.dirty = true;
  }

  /** Linearise every device at x (no limiting). */
  evalAll(x: Float64Array) {
    const { dio, oa, sw, reg } = this.cc;
    for (let d = 0; d < this.dV.length; d++) {
      const v = x[dio.j[d]] - x[dio.k[d]];
      diodeEval(v, dio.is[d], dio.nvt[d], dio.bv[d], dio.ibv[d]);
      this.dV[d] = v;
      this.dI[d] = EI;
      this.dG[d] = EG;
    }
    for (let q = 0; q < oa.el.length; q++) {
      const vx = x[oa.x[q]];
      const vo = x[oa.o[q]];
      const vp = x[oa.vp[q]];
      const vn = x[oa.vn[q]];
      this.evalOA(q, vx, vo, vp, vn);
      this.oV[4 * q] = vx;
      this.oV[4 * q + 1] = vo;
      this.oV[4 * q + 2] = vp;
      this.oV[4 * q + 3] = vn;
      this.oF.set(OF, 3 * q);
      this.oJ.set(OJ, 8 * q);
    }
    for (let q = 0; q < sw.el.length; q++) {
      const vc = x[sw.cp[q]] - x[sw.cn[q]];
      const v01 = x[sw.a[q]] - x[sw.b[q]];
      this.evalSW(q, vc, v01);
      this.sV[2 * q] = vc;
      this.sV[2 * q + 1] = v01;
      this.sI[q] = EI;
      this.sJ[2 * q] = EG;
      this.sJ[2 * q + 1] = SW_GC;
    }
    for (let q = 0; q < reg.el.length; q++) {
      const vi = x[reg.i[q]] - x[reg.g[q]];
      const vo = x[reg.o[q]] - x[reg.g[q]];
      this.evalREG(q, vi, vo);
      this.rV[2 * q] = vi;
      this.rV[2 * q + 1] = vo;
      this.rF[2 * q] = RF0;
      this.rF[2 * q + 1] = RF1;
      this.rJ[3 * q] = RJ0;
      this.rJ[3 * q + 1] = RJ1;
      this.rJ[3 * q + 2] = RJ2;
    }
    this.dirty = true;
  }

  /**
   * Linearise at the new solution x. Junction voltages (and op-amp pole
   * voltages) are limited against the previous point; returns true when no
   * limit acted and every device current matches what the linear model
   * predicted. Marks the matrix dirty when a derivative moved too far.
   */
  update(x: Float64Array, tol: Tol): boolean {
    const { dio, oa, sw, reg } = this.cc;
    const { rel, absI, absV, jrel, jabs } = tol;
    let ok = true;
    let dirty = jrel === 0;
    const dV = this.dV;
    const dI = this.dI;
    const dG = this.dG;
    const dGf = this.dGf;
    for (let d = 0; d < dV.length; d++) {
      let v = x[dio.j[d]] - x[dio.k[d]];
      const v0 = dV[d];
      const nvt = dio.nvt[d];
      const bv = dio.bv[d];
      let lim: number;
      if (bv > 0 && v < Math.min(0, -bv + 10 * nvt)) lim = -(pnjlim(-(v + bv), -(v0 + bv), nvt, dio.vcrit[d]) + bv);
      else lim = pnjlim(v, v0, nvt, dio.vcrit[d]);
      diodeEval(lim, dio.is[d], nvt, bv, dio.ibv[d]);
      if (lim !== v) {
        ok = false;
        v = lim;
      } else if (ok && !near(EI, dI[d] + dGf[d] * (v - v0), rel, absI)) ok = false;
      dV[d] = v;
      dI[d] = EI;
      dG[d] = EG;
      if (!dirty && !near(EG, dGf[d], jrel, jabs)) dirty = true;
    }
    const oV = this.oV;
    const oF = this.oF;
    const oJ = this.oJ;
    const oJf = this.oJf;
    for (let q = 0; q < oa.el.length; q++) {
      const q4 = 4 * q;
      const q3 = 3 * q;
      const q8 = 8 * q;
      let vx = x[oa.x[q]];
      const vo = x[oa.o[q]];
      const vp = x[oa.vp[q]];
      const vn = x[oa.vn[q]];
      const rout = oa.rout[q];
      // a step limit on the pole node keeps Newton from flinging it far past the rails
      const vx0 = oV[q4];
      const step = Math.max(2, vp - vn);
      if (vx > vx0 + step) {
        vx = vx0 + step;
        ok = false;
      } else if (vx < vx0 - step) {
        vx = vx0 - step;
        ok = false;
      }
      this.evalOA(q, vx, vo, vp, vn);
      if (ok) {
        const dx = vx - vx0;
        const dO = vo - oV[q4 + 1];
        const dp = vp - oV[q4 + 2];
        const dn = vn - oV[q4 + 3];
        const ioPred = oF[q3] + (oJf[q8] * dx - dO + oJf[q8 + 1] * dp + oJf[q8 + 2] * dn) / rout;
        const fcPred = oF[q3 + 1] + oJf[q8 + 3] * dx + oJf[q8 + 4] * dp + oJf[q8 + 5] * dn;
        const iqPred = oF[q3 + 2] + oJf[q8 + 6] * (dp - dn);
        if (
          !near(OF[0], ioPred, rel, absV / rout) ||
          !near(OF[1], fcPred, rel, absV * oa.g1[q]) ||
          !near(OF[2], iqPred, rel, absI) ||
          // in a full-Newton solve the supply split must settle too
          (jrel === 0 && Math.abs((OJ[7] - oJf[q8 + 7]) * OF[0]) > rel * Math.abs(OF[0]) + absI)
        )
          ok = false;
      }
      oV[q4] = vx;
      oV[q4 + 1] = vo;
      oV[q4 + 2] = vp;
      oV[q4 + 3] = vn;
      oF[q3] = OF[0];
      oF[q3 + 1] = OF[1];
      oF[q3 + 2] = OF[2];
      for (let r = 0; r < 8; r++) oJ[q8 + r] = OJ[r];
      if (!dirty) {
        const gc = oa.gc[q];
        if (
          Math.abs(OJ[0] - oJf[q8]) > 1e-4 ||
          Math.abs(OJ[1] - oJf[q8 + 1]) > 1e-4 ||
          Math.abs(OJ[2] - oJf[q8 + 2]) > 1e-4 ||
          Math.abs(OJ[3] - oJf[q8 + 3]) > 1e-4 * gc ||
          Math.abs(OJ[4] - oJf[q8 + 4]) > 1e-4 * gc ||
          Math.abs(OJ[5] - oJf[q8 + 5]) > 1e-4 * gc ||
          !near(OJ[6], oJf[q8 + 6], jrel, jabs) ||
          Math.abs(OJ[7] - oJf[q8 + 7]) > 0.02
        )
          dirty = true;
      }
    }
    for (let q = 0; q < sw.el.length; q++) {
      const vc = x[sw.cp[q]] - x[sw.cn[q]];
      const v01 = x[sw.a[q]] - x[sw.b[q]];
      this.evalSW(q, vc, v01);
      const q2 = 2 * q;
      if (ok) {
        const pred = this.sI[q] + this.sJf[q2] * (v01 - this.sV[q2 + 1]) + this.sJf[q2 + 1] * (vc - this.sV[q2]);
        if (!near(EI, pred, rel, absI)) ok = false;
      }
      this.sV[q2] = vc;
      this.sV[q2 + 1] = v01;
      this.sI[q] = EI;
      this.sJ[q2] = EG;
      this.sJ[q2 + 1] = SW_GC;
      if (!dirty && (!near(EG, this.sJf[q2], jrel, jabs) || !near(SW_GC, this.sJf[q2 + 1], jrel, jabs))) dirty = true;
    }
    for (let q = 0; q < reg.el.length; q++) {
      const vi = x[reg.i[q]] - x[reg.g[q]];
      const vo = x[reg.o[q]] - x[reg.g[q]];
      this.evalREG(q, vi, vo);
      const q2 = 2 * q;
      const q3 = 3 * q;
      if (ok) {
        const dvi = vi - this.rV[q2];
        const dvo = vo - this.rV[q2 + 1];
        const iPred = this.rF[q2] + this.rJf[q3] * dvi + this.rJf[q3 + 1] * dvo;
        const qPred = this.rF[q2 + 1] + this.rJf[q3 + 2] * dvi;
        if (!near(RF0, iPred, rel, absI) || !near(RF1, qPred, rel, absI)) ok = false;
      }
      this.rV[q2] = vi;
      this.rV[q2 + 1] = vo;
      this.rF[q2] = RF0;
      this.rF[q2 + 1] = RF1;
      this.rJ[q3] = RJ0;
      this.rJ[q3 + 1] = RJ1;
      this.rJ[q3 + 2] = RJ2;
      if (!dirty && (!near(RJ0, this.rJf[q3], jrel, jabs) || !near(RJ1, this.rJf[q3 + 1], jrel, jabs) || !near(RJ2, this.rJf[q3 + 2], jrel, jabs))) dirty = true;
    }
    if (dirty) this.dirty = true;
    return ok;
  }

  /** Add the current derivatives to matrix values `a` (in the bound slots) and remember them as factored. */
  stampJ(a: Float64Array) {
    const { oa } = this.cc;
    this.dGf.set(this.dG);
    this.oJf.set(this.oJ);
    this.sJf.set(this.sJ);
    this.rJf.set(this.rJ);
    const dS = this.dS;
    const dG = this.dG;
    for (let d = 0; d < dG.length; d++) {
      const g = dG[d];
      const s = 4 * d;
      a[dS[s]] += g;
      a[dS[s + 1]] -= g;
      a[dS[s + 2]] -= g;
      a[dS[s + 3]] += g;
    }
    const oS = this.oS;
    const oJ = this.oJ;
    for (let q = 0; q < oa.el.length; q++) {
      const s = OA_SLOTS * q;
      const j = 8 * q;
      const ir = 1 / oa.rout[q];
      const su = oJ[j] * ir;
      const shi = oJ[j + 1] * ir;
      const slo = oJ[j + 2] * ir;
      const gq = oJ[j + 6];
      const w = oJ[j + 7];
      const w1 = 1 - w;
      a[oS[s]] -= su;
      a[oS[s + 1]] -= shi;
      a[oS[s + 2]] -= slo;
      a[oS[s + 3]] += oJ[j + 3];
      a[oS[s + 4]] += oJ[j + 4];
      a[oS[s + 5]] += oJ[j + 5];
      a[oS[s + 6]] += gq + w * shi;
      a[oS[s + 7]] += -gq + w * slo;
      a[oS[s + 8]] += w * su;
      a[oS[s + 9]] -= w * ir;
      a[oS[s + 10]] += -gq + w1 * shi;
      a[oS[s + 11]] += gq + w1 * slo;
      a[oS[s + 12]] += w1 * su;
      a[oS[s + 13]] -= w1 * ir;
    }
    const sS = this.sS;
    const sJ = this.sJ;
    for (let q = 0; q < this.sI.length; q++) {
      const s = SW_SLOTS * q;
      const g = sJ[2 * q];
      const gc = sJ[2 * q + 1];
      a[sS[s]] += g;
      a[sS[s + 1]] -= g;
      a[sS[s + 2]] -= g;
      a[sS[s + 3]] += g;
      a[sS[s + 4]] += gc;
      a[sS[s + 5]] -= gc;
      a[sS[s + 6]] -= gc;
      a[sS[s + 7]] += gc;
    }
    const rS = this.rS;
    const rJ = this.rJ;
    for (let q = 0; q < this.rF.length / 2; q++) {
      const s = REG_SLOTS * q;
      const gi = rJ[3 * q];
      const go = rJ[3 * q + 1];
      const gq = rJ[3 * q + 2];
      a[rS[s]] -= gi;
      a[rS[s + 1]] -= go;
      a[rS[s + 2]] += gi + go;
      a[rS[s + 3]] += gi + gq;
      a[rS[s + 4]] += go;
      a[rS[s + 5]] -= gi + go + gq;
      a[rS[s + 6]] -= gq;
      a[rS[s + 7]] += gq;
    }
    this.dirty = false;
  }

  /** Add each device's linearised (Norton) currents to the right-hand side. */
  stampRhs(rhs: Float64Array) {
    const { dio, oa, sw, reg } = this.cc;
    const dV = this.dV;
    const dI = this.dI;
    const dGf = this.dGf;
    for (let d = 0; d < dV.length; d++) {
      const ieq = dI[d] - dGf[d] * dV[d];
      rhs[dio.j[d]] -= ieq;
      rhs[dio.k[d]] += ieq;
    }
    const oV = this.oV;
    const oF = this.oF;
    const oJf = this.oJf;
    for (let q = 0; q < oa.el.length; q++) {
      const v = 4 * q;
      const f = 3 * q;
      const j = 8 * q;
      const vx = oV[v];
      const vo = oV[v + 1];
      const vp = oV[v + 2];
      const vn = oV[v + 3];
      const ioEq = oF[f] - (oJf[j] * vx - vo + oJf[j + 1] * vp + oJf[j + 2] * vn) / oa.rout[q];
      const fcEq = oF[f + 1] - (oJf[j + 3] * vx + oJf[j + 4] * vp + oJf[j + 5] * vn);
      const iqEq = oF[f + 2] - oJf[j + 6] * (vp - vn);
      const w = oJf[j + 7];
      rhs[oa.o[q]] += ioEq;
      rhs[oa.x[q]] -= fcEq;
      rhs[oa.vp[q]] -= iqEq + w * ioEq;
      rhs[oa.vn[q]] -= -iqEq + (1 - w) * ioEq;
    }
    for (let q = 0; q < sw.el.length; q++) {
      const ieq = this.sI[q] - this.sJf[2 * q] * this.sV[2 * q + 1] - this.sJf[2 * q + 1] * this.sV[2 * q];
      rhs[sw.a[q]] -= ieq;
      rhs[sw.b[q]] += ieq;
    }
    for (let q = 0; q < reg.el.length; q++) {
      const vi = this.rV[2 * q];
      const vo = this.rV[2 * q + 1];
      const ieq = this.rF[2 * q] - this.rJf[3 * q] * vi - this.rJf[3 * q + 1] * vo;
      const qeq = this.rF[2 * q + 1] - this.rJf[3 * q + 2] * vi;
      rhs[reg.o[q]] += ieq;
      rhs[reg.i[q]] -= ieq + qeq;
      rhs[reg.g[q]] += qeq;
    }
  }

  /**
   * Op-amp q at pole voltage vx, output vo and supplies vp, vn. The output is
   * a source sat(vx) behind rout, where sat follows vx and rounds off into
   * the swing limits; a soft clamp holds vx a little beyond them so the pole
   * never winds up and the amp comes out of clipping at once.
   */
  private evalOA(q: number, vx: number, vo: number, vp: number, vn: number) {
    const { oa } = this.cc;
    const hi = vp - oa.s0[q];
    const lo = vn + oa.s1[q];
    const span = hi - lo;
    let sat: number;
    let su = 1;
    let shi = 0;
    let slo = 0;
    let k: number;
    if (span < 1e-3) {
      // no supply: the output sits between the rails and ignores its input
      k = 1e-3;
      sat = (hi + lo) / 2;
      su = 0;
      shi = 0.5;
      slo = 0.5;
    } else {
      k = Math.min(oa.knee[q], span / 4);
      const ua = hi - k;
      const ub = lo + k;
      if (vx > ua) {
        const t = Math.tanh((vx - ua) / k);
        sat = ua + k * t;
        shi = t * t;
        su = 1 - shi;
      } else if (vx < ub) {
        const t = Math.tanh((vx - ub) / k);
        sat = ub + k * t;
        slo = t * t;
        su = 1 - slo;
      } else sat = vx;
    }
    const rout = oa.rout[q];
    const io = (sat - vo) / rout;
    const gc = oa.gc[q];
    const sc = Math.max(k / 4, 1e-3);
    const zh = (vx - (span < 1e-3 ? sat : hi + 3 * k)) / sc;
    const zl = ((span < 1e-3 ? sat : lo - 3 * k) - vx) / sc;
    const sh = sigmoid(zh);
    const sl = sigmoid(zl);
    OF[0] = io;
    OF[1] = gc * sc * (softplus(zh) - softplus(zl));
    OJ[0] = su;
    OJ[1] = shi;
    OJ[2] = slo;
    OJ[3] = gc * (sh + sl);
    OJ[4] = -gc * sh;
    OJ[5] = -gc * sl;
    const vs = vp - vn;
    if (vs > 0) {
      // quiescent current fades in as the supply comes up, which keeps source stepping sane
      const e = Math.exp(-vs * vs);
      OF[2] = oa.iq[q] * (1 - e);
      OJ[6] = oa.iq[q] * 2 * vs * e;
    } else {
      OF[2] = 0;
      OJ[6] = 0;
    }
    OJ[7] = 0.5 * (1 + Math.tanh(io / (2 * OA_SPLIT)));
  }

  /** Switch q: conductance moves smoothly in log between 1/roff and 1/ron as vc goes from voff to von. */
  private evalSW(q: number, vc: number, v01: number) {
    const { sw } = this.cc;
    const von = sw.von[q];
    const voff = sw.voff[q];
    const width = von - voff || 1e-6;
    const t = (vc - voff) / width;
    let lg: number;
    let dlg = 0;
    if (t <= 0) lg = sw.lnOff[q];
    else if (t >= 1) lg = sw.lnOn[q];
    else {
      const d = sw.lnOn[q] - sw.lnOff[q];
      lg = sw.lnOff[q] + d * t * t * (3 - 2 * t);
      dlg = (d * 6 * t * (1 - t)) / width;
    }
    const g = Math.exp(lg);
    EI = g * v01;
    EG = g;
    SW_GC = g * dlg * v01;
  }

  /** Regulator q: output current toward min(vout, vin − dropout) through rout, limited to ilim. */
  private evalREG(q: number, vi: number, vo: number) {
    const { reg } = this.cc;
    const w2 = REG_SMOOTH * REG_SMOOTH;
    const A = reg.vout[q];
    const Bv = vi - reg.drop[q];
    const D = A - Bv;
    const r = Math.sqrt(D * D + w2);
    const T = (A + Bv - r) / 2;
    const dT = (1 + D / r) / 2;
    const r2 = Math.sqrt(T * T + w2);
    const T2 = (T + r2) / 2;
    const dT2 = (1 + T / r2) / 2;
    const ilim = reg.ilim[q];
    const rout = reg.rout[q];
    const th = Math.tanh((T2 - vo) / rout / ilim);
    const di = 1 - th * th;
    RF0 = ilim * th;
    RJ0 = (di * dT2 * dT) / rout;
    RJ1 = -di / rout;
    if (vi > 0) {
      const e = Math.exp(-vi * vi);
      RF1 = reg.iq[q] * (1 - e);
      RJ2 = reg.iq[q] * 2 * vi * e;
    } else {
      RF1 = 0;
      RJ2 = 0;
    }
  }
}
