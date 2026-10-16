// Turns a circuit into numbered unknowns and a fixed matrix pattern for
// modified nodal analysis. Unknowns are the user's nodes, then internal nodes
// (a diode's junction behind its series resistance, an op-amp's dominant-pole
// node), then branch currents (voltage sources, VCVS outputs, inductors).
// Index n stands for ground everywhere: stamps that land on it go to a trash
// slot, so the hot loops never test for ground.

import { makePlan, matchRows, structuralOrder, type Plan } from "./sparse";
import type { Circuit, Element } from "./types";

/** Conductance from every node to ground: keeps nodes reached only through capacitors solvable. */
export const GMIN = 1e-12;
/** kT/q at 300 K */
export const VT = (1.380649e-23 * 300) / 1.602176634e-19;

/** An op-amp's output swing rounds off over this many volts before its limit. */
const OA_KNEE = 0.5;

export interface Caps {
  /** element index, or −1 for a model's internal capacitance */
  el: Int32Array;
  a: Int32Array;
  b: Int32Array;
  c: Float64Array;
  /** starting voltage, NaN when unset */
  ic: Float64Array;
  /** slots aa, bb, ab, ba */
  slots: Int32Array;
}

export interface Compiled {
  circuit: Circuit;
  /** unknowns; index n is ground */
  n: number;
  /** voltage unknowns are 0..nv−1 (user nodes first), branch currents nv..n−1 */
  nv: number;
  nodes: Map<string, number>;
  /** a label for every unknown, for messages */
  names: string[];
  nnz: number;
  rows: Int32Array;
  cols: Int32Array;
  /** linear conductances and incidences, and capacitances (inductors as −L on their branch), by slot */
  G: Float64Array;
  B: Float64Array;
  /** diagonal slot of each voltage unknown */
  diag: Int32Array;
  plan: Plan;
  res: { el: Int32Array; a: Int32Array; b: Int32Array; g: Float64Array };
  cap: Caps;
  ind: { el: Int32Array; a: Int32Array; b: Int32Array; k: Int32Array; l: Float64Array };
  vs: { el: Int32Array; a: Int32Array; b: Int32Array; k: Int32Array; dc: Float64Array };
  isrc: { el: Int32Array; a: Int32Array; b: Int32Array; dc: Float64Array };
  vcvs: { el: Int32Array; a: Int32Array; b: Int32Array; k: Int32Array };
  dio: { el: Int32Array; a: Int32Array; j: Int32Array; k: Int32Array; is: Float64Array; nvt: Float64Array; vcrit: Float64Array; bv: Float64Array; ibv: Float64Array; slots: Int32Array };
  oa: {
    el: Int32Array;
    p: Int32Array;
    m: Int32Array;
    o: Int32Array;
    vp: Int32Array;
    vn: Int32Array;
    x: Int32Array;
    g1: Float64Array;
    gc: Float64Array;
    rout: Float64Array;
    s0: Float64Array;
    s1: Float64Array;
    iq: Float64Array;
    ib: Float64Array;
    knee: Float64Array;
    slots: Int32Array;
  };
  sw: { el: Int32Array; a: Int32Array; b: Int32Array; cp: Int32Array; cn: Int32Array; lnOn: Float64Array; lnOff: Float64Array; von: Float64Array; voff: Float64Array; slots: Int32Array };
  reg: { el: Int32Array; i: Int32Array; g: Int32Array; o: Int32Array; vout: Float64Array; drop: Float64Array; ilim: Float64Array; iq: Float64Array; rout: Float64Array; slots: Int32Array };
}

/** Slots per device, in the order devices.ts stamps them. */
export const OA_SLOTS = 14;
export const SW_SLOTS = 8;
export const REG_SLOTS = 8;

const ints = (a: number[]) => Int32Array.from(a);
const reals = (a: number[]) => Float64Array.from(a);

export function compile(c: Circuit): Compiled {
  const els = c.elements;
  const nodes = new Map<string, number>();
  const names: string[] = [];
  for (const e of els) {
    for (const nm of e.n) {
      if (nm !== "0" && !nodes.has(nm)) {
        nodes.set(nm, names.length);
        names.push(nm);
      }
    }
  }
  let nInt = 0;
  let nBr = 0;
  for (const e of els) {
    if ((e.k === "D" && e.rs > 0) || e.k === "OA") nInt++;
    if (e.k === "V" || e.k === "L" || e.k === "E") nBr++;
  }
  const nv = names.length + nInt;
  const n = nv + nBr;
  const gnd = n;
  nodes.set("0", gnd);
  const at = (nm: string) => nodes.get(nm)!;
  let nextBr = nv;
  const internal = (label: string) => {
    names.push(label);
    return names.length - 1;
  };
  const branchLabels: string[] = [];
  const branch = (label: string) => {
    branchLabels.push(label);
    return nextBr++;
  };

  const key = new Map<number, number>();
  const rowsL: number[] = [];
  const colsL: number[] = [];
  const slot = (r: number, col: number): number => {
    if (r === gnd || col === gnd) return -1;
    const k = r * n + col;
    let s = key.get(k);
    if (s === undefined) {
      s = rowsL.length;
      key.set(k, s);
      rowsL.push(r);
      colsL.push(col);
    }
    return s;
  };
  const gSt: number[] = [];
  const bSt: number[] = [];
  const stampG = (r: number, col: number, v: number) => {
    const s = slot(r, col);
    if (s >= 0) gSt.push(s, v);
  };
  const stampB = (r: number, col: number, v: number) => {
    const s = slot(r, col);
    if (s >= 0) bSt.push(s, v);
  };
  const conduct = (a: number, b: number, g: number) => {
    stampG(a, a, g);
    stampG(b, b, g);
    stampG(a, b, -g);
    stampG(b, a, -g);
  };
  // candidate pivot rows per column, for the structural matching
  const cands: number[][] = [];
  for (let i = 0; i < n; i++) cands.push(i < nv ? [i] : []);
  const incidence = (a: number, b: number, k: number) => {
    stampG(a, k, 1);
    stampG(b, k, -1);
    stampG(k, a, 1);
    stampG(k, b, -1);
    for (const v of [a, b]) {
      if (v === gnd) continue;
      cands[v].push(k);
      cands[k].push(v);
    }
  };

  const res = { el: [] as number[], a: [] as number[], b: [] as number[], g: [] as number[] };
  const cap = { el: [] as number[], a: [] as number[], b: [] as number[], c: [] as number[], ic: [] as number[], slots: [] as number[] };
  const ind = { el: [] as number[], a: [] as number[], b: [] as number[], k: [] as number[], l: [] as number[] };
  const vs = { el: [] as number[], a: [] as number[], b: [] as number[], k: [] as number[], dc: [] as number[] };
  const isrc = { el: [] as number[], a: [] as number[], b: [] as number[], dc: [] as number[] };
  const vcvs = { el: [] as number[], a: [] as number[], b: [] as number[], k: [] as number[] };
  const dio = { el: [] as number[], a: [] as number[], j: [] as number[], k: [] as number[], is: [] as number[], nvt: [] as number[], vcrit: [] as number[], bv: [] as number[], ibv: [] as number[], slots: [] as number[] };
  const oa = {
    el: [] as number[],
    p: [] as number[],
    m: [] as number[],
    o: [] as number[],
    vp: [] as number[],
    vn: [] as number[],
    x: [] as number[],
    g1: [] as number[],
    gc: [] as number[],
    rout: [] as number[],
    s0: [] as number[],
    s1: [] as number[],
    iq: [] as number[],
    ib: [] as number[],
    knee: [] as number[],
    slots: [] as number[],
  };
  const sw = { el: [] as number[], a: [] as number[], b: [] as number[], cp: [] as number[], cn: [] as number[], lnOn: [] as number[], lnOff: [] as number[], von: [] as number[], voff: [] as number[], slots: [] as number[] };
  const reg = { el: [] as number[], i: [] as number[], g: [] as number[], o: [] as number[], vout: [] as number[], drop: [] as number[], ilim: [] as number[], iq: [] as number[], rout: [] as number[], slots: [] as number[] };

  const addCap = (el: number, a: number, b: number, value: number, ic: number) => {
    stampB(a, a, value);
    stampB(b, b, value);
    stampB(a, b, -value);
    stampB(b, a, -value);
    cap.el.push(el);
    cap.a.push(a);
    cap.b.push(b);
    cap.c.push(value);
    cap.ic.push(ic);
    cap.slots.push(slot(a, a), slot(b, b), slot(a, b), slot(b, a));
  };

  els.forEach((e: Element, idx) => {
    switch (e.k) {
      case "R": {
        const a = at(e.n[0]);
        const b = at(e.n[1]);
        conduct(a, b, 1 / e.r);
        res.el.push(idx);
        res.a.push(a);
        res.b.push(b);
        res.g.push(1 / e.r);
        break;
      }
      case "C":
        addCap(idx, at(e.n[0]), at(e.n[1]), e.c, e.ic ?? NaN);
        break;
      case "L": {
        const a = at(e.n[0]);
        const b = at(e.n[1]);
        const k = branch(`${e.id}:i`);
        incidence(a, b, k);
        stampB(k, k, -e.l);
        ind.el.push(idx);
        ind.a.push(a);
        ind.b.push(b);
        ind.k.push(k);
        ind.l.push(e.l);
        break;
      }
      case "V": {
        const a = at(e.n[0]);
        const b = at(e.n[1]);
        const k = branch(`${e.id}:i`);
        incidence(a, b, k);
        vs.el.push(idx);
        vs.a.push(a);
        vs.b.push(b);
        vs.k.push(k);
        vs.dc.push(e.dc);
        break;
      }
      case "I":
        isrc.el.push(idx);
        isrc.a.push(at(e.n[0]));
        isrc.b.push(at(e.n[1]));
        isrc.dc.push(e.dc);
        break;
      case "E": {
        const [a, b, cp, cn] = e.n.map(at);
        const k = branch(`${e.id}:i`);
        incidence(a, b, k);
        stampG(k, cp, -e.gain);
        stampG(k, cn, e.gain);
        vcvs.el.push(idx);
        vcvs.a.push(a);
        vcvs.b.push(b);
        vcvs.k.push(k);
        break;
      }
      case "D": {
        const a = at(e.n[0]);
        const k = at(e.n[1]);
        const j = e.rs > 0 ? internal(`${e.id}:j`) : a;
        if (e.rs > 0) conduct(a, j, 1 / e.rs);
        const nvt = e.nf * VT;
        dio.el.push(idx);
        dio.a.push(a);
        dio.j.push(j);
        dio.k.push(k);
        dio.is.push(e.is);
        dio.nvt.push(nvt);
        dio.vcrit.push(nvt * Math.log(nvt / (Math.SQRT2 * e.is)));
        dio.bv.push(e.bv ?? 0);
        dio.ibv.push(e.ibv ?? 1e-3);
        dio.slots.push(slot(j, j), slot(j, k), slot(k, j), slot(k, k));
        if (e.cj && e.cj > 0) addCap(-1, j, k, e.cj, NaN);
        break;
      }
      case "OA": {
        const [p, m, o, vp, vn] = e.n.map(at);
        const x = internal(`${e.id}:x`);
        // the pole node's conductance is ten times the output's so pivoting on it stays safe
        const g1 = 10 / e.rout;
        const tau = e.a0 / (2 * Math.PI * e.gbw);
        stampG(o, o, 1 / e.rout);
        stampG(x, x, g1);
        stampG(x, p, -e.a0 * g1);
        stampG(x, m, e.a0 * g1);
        // referenced to mid-supply, so a single-supply part biased at half rail has no offset
        stampG(x, vp, -g1 / 2);
        stampG(x, vn, -g1 / 2);
        addCap(-1, x, gnd, g1 * tau, NaN);
        oa.el.push(idx);
        oa.p.push(p);
        oa.m.push(m);
        oa.o.push(o);
        oa.vp.push(vp);
        oa.vn.push(vn);
        oa.x.push(x);
        oa.g1.push(g1);
        oa.gc.push(e.a0 * g1);
        oa.rout.push(e.rout);
        oa.s0.push(e.swing[0]);
        oa.s1.push(e.swing[1]);
        oa.iq.push(e.iq);
        oa.ib.push(e.ib ?? 0);
        oa.knee.push(OA_KNEE);
        oa.slots.push(
          slot(o, x),
          slot(o, vp),
          slot(o, vn),
          slot(x, x),
          slot(x, vp),
          slot(x, vn),
          slot(vp, vp),
          slot(vp, vn),
          slot(vp, x),
          slot(vp, o),
          slot(vn, vp),
          slot(vn, vn),
          slot(vn, x),
          slot(vn, o),
        );
        break;
      }
      case "SW": {
        const [a, b, cp, cn] = e.n.map(at);
        sw.el.push(idx);
        sw.a.push(a);
        sw.b.push(b);
        sw.cp.push(cp);
        sw.cn.push(cn);
        sw.lnOn.push(-Math.log(e.ron));
        sw.lnOff.push(-Math.log(e.roff));
        sw.von.push(e.von);
        sw.voff.push(e.voff);
        sw.slots.push(slot(a, a), slot(a, b), slot(b, a), slot(b, b), slot(a, cp), slot(a, cn), slot(b, cp), slot(b, cn));
        break;
      }
      case "REG": {
        const [i, g, o] = e.n.map(at);
        reg.el.push(idx);
        reg.i.push(i);
        reg.g.push(g);
        reg.o.push(o);
        reg.vout.push(e.vout);
        reg.drop.push(e.dropout);
        reg.ilim.push(e.ilim);
        reg.iq.push(e.iq);
        reg.rout.push(e.rout);
        reg.slots.push(slot(o, i), slot(o, o), slot(o, g), slot(i, i), slot(i, o), slot(i, g), slot(g, i), slot(g, g));
        break;
      }
    }
  });

  const diag: number[] = [];
  for (let i = 0; i < nv; i++) {
    stampG(i, i, GMIN);
    diag.push(slot(i, i));
  }

  const nnz = rowsL.length;
  const G = new Float64Array(nnz + 1);
  const B = new Float64Array(nnz + 1);
  for (let q = 0; q < gSt.length; q += 2) G[gSt[q]] += gSt[q + 1];
  for (let q = 0; q < bSt.length; q += 2) B[bSt[q]] += bSt[q + 1];
  const fix = (a: number[]) => Int32Array.from(a, (s) => (s < 0 ? nnz : s));
  const rows = ints(rowsL);
  const cols = ints(colsL);
  const rowFor = matchRows(n, cands);
  const { pr, pc } = structuralOrder(n, rows, cols, rowFor);

  return {
    circuit: c,
    n,
    nv,
    nodes,
    names: [...names, ...branchLabels],
    nnz,
    rows,
    cols,
    G,
    B,
    diag: ints(diag),
    plan: makePlan(n, rows, cols, pr, pc),
    res: { el: ints(res.el), a: ints(res.a), b: ints(res.b), g: reals(res.g) },
    cap: { el: ints(cap.el), a: ints(cap.a), b: ints(cap.b), c: reals(cap.c), ic: reals(cap.ic), slots: fix(cap.slots) },
    ind: { el: ints(ind.el), a: ints(ind.a), b: ints(ind.b), k: ints(ind.k), l: reals(ind.l) },
    vs: { el: ints(vs.el), a: ints(vs.a), b: ints(vs.b), k: ints(vs.k), dc: reals(vs.dc) },
    isrc: { el: ints(isrc.el), a: ints(isrc.a), b: ints(isrc.b), dc: reals(isrc.dc) },
    vcvs: { el: ints(vcvs.el), a: ints(vcvs.a), b: ints(vcvs.b), k: ints(vcvs.k) },
    dio: {
      el: ints(dio.el),
      a: ints(dio.a),
      j: ints(dio.j),
      k: ints(dio.k),
      is: reals(dio.is),
      nvt: reals(dio.nvt),
      vcrit: reals(dio.vcrit),
      bv: reals(dio.bv),
      ibv: reals(dio.ibv),
      slots: fix(dio.slots),
    },
    oa: {
      el: ints(oa.el),
      p: ints(oa.p),
      m: ints(oa.m),
      o: ints(oa.o),
      vp: ints(oa.vp),
      vn: ints(oa.vn),
      x: ints(oa.x),
      g1: reals(oa.g1),
      gc: reals(oa.gc),
      rout: reals(oa.rout),
      s0: reals(oa.s0),
      s1: reals(oa.s1),
      iq: reals(oa.iq),
      ib: reals(oa.ib),
      knee: reals(oa.knee),
      slots: fix(oa.slots),
    },
    sw: {
      el: ints(sw.el),
      a: ints(sw.a),
      b: ints(sw.b),
      cp: ints(sw.cp),
      cn: ints(sw.cn),
      lnOn: reals(sw.lnOn),
      lnOff: reals(sw.lnOff),
      von: reals(sw.von),
      voff: reals(sw.voff),
      slots: fix(sw.slots),
    },
    reg: {
      el: ints(reg.el),
      i: ints(reg.i),
      g: ints(reg.g),
      o: ints(reg.o),
      vout: reals(reg.vout),
      drop: reals(reg.drop),
      ilim: reals(reg.ilim),
      iq: reals(reg.iq),
      rout: reals(reg.rout),
      slots: fix(reg.slots),
    },
  };
}

/** Constant source vector: dc values of V and I sources (and op-amp bias currents), scaled. */
export function sourceRhs(cc: Compiled, scale: number, rhs: Float64Array) {
  rhs.fill(0);
  const { vs, isrc, oa } = cc;
  for (let q = 0; q < vs.k.length; q++) rhs[vs.k[q]] += scale * vs.dc[q];
  for (let q = 0; q < isrc.a.length; q++) {
    rhs[isrc.a[q]] -= scale * isrc.dc[q];
    rhs[isrc.b[q]] += scale * isrc.dc[q];
  }
  for (let q = 0; q < oa.ib.length; q++) {
    const ib = scale * oa.ib[q];
    if (ib === 0) continue;
    rhs[oa.p[q]] -= ib;
    rhs[oa.m[q]] -= ib;
    rhs[oa.vn[q]] += 2 * ib;
  }
}
