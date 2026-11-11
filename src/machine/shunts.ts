// A current monitor's shunt channel joins the two nets it is wired between into
// one, so the netlist alone cannot say which way round it sits. The wires can:
// this follows them out from each side of the shunt to find the terminal of
// the load it is in series with. Shared by the simulator (what the channel
// reads) and firmware generators (which channel and sign to use for a coil).

import type { Netlist } from "./erc";

export interface ShuntFacing {
  /** +1 when the load's current (in at its + terminal, out at its −) runs from the channel's + to its − */
  sign: 1 | -1;
  /** the shunt sits at the load's − terminal (the side a bridge holds near ground in slow decay) */
  atMinus: boolean;
}

/** every pin reached from `comp.pin` by wires alone (not through a part) */
export function wiredSide(nl: Netlist, comp: string, pin: string): Set<string> {
  const start = `${comp}[0].${pin}`;
  const seen = new Set([start]);
  const net = nl.netOf.get(start);
  if (!net) return seen;
  const todo = [start];
  while (todo.length) {
    const k = todo.pop()!;
    for (const sg of net.segs) {
      const next = sg.a.key === k ? sg.b.key : sg.b.key === k ? sg.a.key : undefined;
      if (next && !seen.has(next)) {
        seen.add(next);
        todo.push(next);
      }
    }
  }
  return seen;
}

/** the two sides of a monitor's channel (1 to 3), as sets of pin keys */
export function shuntSides(nl: Netlist, monitor: string, ch: number): { p: Set<string>; n: Set<string> } {
  return { p: wiredSide(nl, monitor, `CH${ch}P`), n: wiredSide(nl, monitor, `CH${ch}N`) };
}

/** which way a channel faces a two-terminal load (a coil or DC motor: M_PLUS and M_MINUS), if it is in series with it */
export function shuntFacing(sides: { p: Set<string>; n: Set<string> }, load: string): ShuntFacing | undefined {
  const plus = `${load}[0].M_PLUS`;
  const minus = `${load}[0].M_MINUS`;
  if (sides.p.has(minus)) return { sign: 1, atMinus: true };
  if (sides.n.has(minus)) return { sign: -1, atMinus: true };
  if (sides.n.has(plus)) return { sign: 1, atMinus: false };
  if (sides.p.has(plus)) return { sign: -1, atMinus: false };
  return undefined;
}

/** One coil of a series string: positive when the string's current (from the driver's first output to its second) runs in at its START. */
export interface ChainMember {
  comp: string;
  sign: 1 | -1;
}

/**
 * The coils wired in series between two driver outputs, in order from the first output: one coil, or several
 * lead to lead (a lift coil with a small cancelling winding, a Helmholtz pair). A current shunt in the string
 * does not break it (it joins the nets either side of it). Undefined when no unbroken string of the given coils
 * joins the two pins.
 */
export function coilChain(nl: Netlist, outPlus: string, outMinus: string, coils: readonly string[]): ChainMember[] | undefined {
  const end = nl.netOf.get(outMinus);
  let net = nl.netOf.get(outPlus);
  if (!net || !end) return undefined;
  const chain: ChainMember[] = [];
  const used = new Set<string>();
  while (net.id !== end.id || !chain.length) {
    let next: { comp: string; sign: 1 | -1; other: string } | undefined;
    for (const p of net.pins) {
      if (used.has(p.comp) || !coils.includes(p.comp)) continue;
      if (p.pin.id === "M_PLUS") next = { comp: p.comp, sign: 1, other: "M_MINUS" };
      else if (p.pin.id === "M_MINUS") next = { comp: p.comp, sign: -1, other: "M_PLUS" };
      if (next) break;
    }
    if (!next) return undefined;
    used.add(next.comp);
    chain.push({ comp: next.comp, sign: next.sign });
    const on = nl.netOf.get(`${next.comp}[0].${next.other}`);
    if (!on) return undefined;
    net = on;
  }
  return chain;
}
