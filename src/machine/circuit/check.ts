// Up-front checks on a circuit. Values that can't be simulated and loops of
// voltage sources are fatal (the matrix would be singular or meaningless);
// a node with no DC path to ground still solves, held near 0 V by a tiny
// leak, but its voltage means nothing, which is nearly always a missing bias
// resistor.

import type { Circuit, Element } from "./types";

const ARITY: Record<Element["k"], number> = { R: 2, C: 2, L: 2, V: 2, I: 2, D: 2, OA: 5, E: 4, SW: 4, REG: 3 };

class Sets {
  private parent = new Map<string, string>();
  find(a: string): string {
    let r = a;
    while (this.parent.has(r) && this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(a, r);
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export interface Inspection {
  fatal: string[];
  warn: string[];
}

export function inspect(c: Circuit): Inspection {
  const fatal: string[] = [];
  const warn: string[] = [];
  const ids = new Set<string>();
  const nodes = new Set<string>();
  const dc = new Sets();
  const vloop = new Sets();
  const positive = (e: Element, what: string, v: number | undefined, allowZero = false) => {
    if (v === undefined) return;
    if (!Number.isFinite(v) || v < 0 || (!allowZero && v === 0)) fatal.push(`${e.id}: ${what} must be ${allowZero ? "zero or more" : "positive"} (got ${v})`);
  };
  const finite = (e: Element, what: string, v: number | undefined) => {
    if (v !== undefined && !Number.isFinite(v)) fatal.push(`${e.id}: ${what} must be a finite number (got ${v})`);
  };

  for (const e of c.elements) {
    if (!(e.k in ARITY)) {
      fatal.push(`${(e as { id?: string }).id ?? "?"}: unknown element kind "${(e as { k: string }).k}"`);
      continue;
    }
    if (!Array.isArray(e.n) || e.n.length !== ARITY[e.k] || e.n.some((x) => typeof x !== "string")) {
      fatal.push(`${e.id}: a ${e.k} needs ${ARITY[e.k]} node names`);
      continue;
    }
    if (ids.has(e.id)) warn.push(`two elements share the id "${e.id}"; results keep only the last`);
    ids.add(e.id);
    for (const nm of e.n) nodes.add(nm);
    switch (e.k) {
      case "R":
        positive(e, "resistance", e.r);
        dc.union(e.n[0], e.n[1]);
        break;
      case "C":
        positive(e, "capacitance", e.c);
        finite(e, "starting voltage", e.ic);
        break;
      case "L":
        positive(e, "inductance", e.l);
        dc.union(e.n[0], e.n[1]);
        break;
      case "V":
      case "I":
        finite(e, "value", e.dc);
        if (e.k === "V") dc.union(e.n[0], e.n[1]);
        break;
      case "D":
        positive(e, "saturation current", e.is);
        positive(e, "emission coefficient", e.nf);
        positive(e, "series resistance", e.rs, true);
        positive(e, "breakdown voltage", e.bv);
        positive(e, "breakdown current", e.ibv);
        positive(e, "junction capacitance", e.cj, true);
        dc.union(e.n[0], e.n[1]);
        break;
      case "OA":
        positive(e, "open-loop gain", e.a0);
        positive(e, "gain-bandwidth", e.gbw);
        positive(e, "output resistance", e.rout);
        positive(e, "swing below V+", e.swing?.[0], true);
        positive(e, "swing above V−", e.swing?.[1], true);
        positive(e, "quiescent current", e.iq, true);
        finite(e, "input bias current", e.ib);
        // the output is driven from inside the amp; the inputs and supply pins are not paths
        dc.union(e.n[2], "0");
        break;
      case "E":
        finite(e, "gain", e.gain);
        dc.union(e.n[0], e.n[1]);
        break;
      case "SW":
        positive(e, "on resistance", e.ron);
        positive(e, "off resistance", e.roff);
        finite(e, "on threshold", e.von);
        finite(e, "off threshold", e.voff);
        dc.union(e.n[0], e.n[1]);
        break;
      case "REG":
        positive(e, "output voltage", e.vout);
        positive(e, "dropout", e.dropout, true);
        positive(e, "current limit", e.ilim);
        positive(e, "quiescent current", e.iq, true);
        positive(e, "output resistance", e.rout);
        dc.union(e.n[0], e.n[1]);
        dc.union(e.n[2], e.n[1]);
        break;
    }
    if (e.k === "V" || e.k === "E" || e.k === "L") {
      const [a, b] = e.n;
      if (a === b) fatal.push(`${e.id}: both ends are on node "${a}"`);
      else if (vloop.find(a) === vloop.find(b)) fatal.push(`${e.id} closes a loop made only of voltage sources and inductors, which has no DC solution`);
      else vloop.union(a, b);
    }
  }

  if (c.elements.length && !nodes.has("0")) warn.push(`nothing connects to ground (node "0")`);
  else {
    const g = dc.find("0");
    for (const nm of nodes) if (nm !== "0" && dc.find(nm) !== g) warn.push(`node "${nm}" has no DC path to ground (only capacitors, current sources or amplifier inputs reach it)`);
  }
  return { fatal, warn };
}

/** Problems with a circuit, worst first: impossible values and source loops, then floating nodes and duplicate ids. */
export function checkCircuit(c: Circuit): string[] {
  const { fatal, warn } = inspect(c);
  return [...fatal, ...warn];
}
