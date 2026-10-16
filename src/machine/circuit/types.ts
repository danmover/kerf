// Circuit elements and analysis results for the analog solver. A circuit is a
// flat list of elements joined at named nodes; "0" is ground. The machine
// layer builds one from the design's parts and nets (circuit/netlist.ts), so
// the solver itself knows nothing about catalogs or the language.

/** Node names: any string, "0" is ground. */
export type Node = string;

export type Element =
  /** resistor, ohms */
  | { k: "R"; id: string; n: [Node, Node]; r: number }
  /** capacitor, farads; `ic` is the starting voltage n[0] − n[1] for a transient without an operating point */
  | { k: "C"; id: string; n: [Node, Node]; c: number; ic?: number }
  /** inductor, henries */
  | { k: "L"; id: string; n: [Node, Node]; l: number }
  /** voltage source: v(n[0]) − v(n[1]) = dc (+ the transient input named by id) */
  | { k: "V"; id: string; n: [Node, Node]; dc: number; ac?: number }
  /** current source: `dc` amps flow out of n[0], through the source, into n[1] */
  | { k: "I"; id: string; n: [Node, Node]; dc: number; ac?: number }
  /** diode, n = [anode, cathode]; Shockley with series resistance and optional reverse breakdown */
  | { k: "D"; id: string; n: [Node, Node]; is: number; nf: number; rs: number; bv?: number; ibv?: number; cj?: number }
  /**
   * Operational amplifier, n = [in+, in−, out, V+, V−]. Open-loop gain a0 with
   * one pole at gbw / a0, output resistance rout, and an output that saturates
   * smoothly `swing[0]` volts below V+ and `swing[1]` volts above V−. Draws iq
   * from V+ to V−. Inputs draw `ib` amps (default 0).
   */
  | { k: "OA"; id: string; n: [Node, Node, Node, Node, Node]; a0: number; gbw: number; rout: number; swing: [number, number]; iq: number; ib?: number }
  /** voltage-controlled voltage source: v(n0) − v(n1) = gain · (v(n2) − v(n3)) */
  | { k: "E"; id: string; n: [Node, Node, Node, Node]; gain: number }
  /**
   * Voltage-controlled switch between n0 and n1, controlled by v(n2) − v(n3):
   * roff below voff, ron above von, smooth (log-resistance) in between.
   */
  | { k: "SW"; id: string; n: [Node, Node, Node, Node]; ron: number; roff: number; von: number; voff: number }
  /**
   * Linear regulator (78xx), n = [in, gnd, out]: holds out − gnd at vout while
   * in − out stays above dropout, follows in − dropout below that, limits the
   * output current to ilim and draws iq from in to gnd.
   */
  | { k: "REG"; id: string; n: [Node, Node, Node]; vout: number; dropout: number; ilim: number; iq: number; rout: number };

export interface Circuit {
  elements: Element[];
  /** descriptive title for messages */
  title?: string;
}

export interface DcResult {
  ok: boolean;
  /** node voltages; ground is 0 */
  v: Record<Node, number>;
  /**
   * Current through each element in amps, flowing into n[0] and out of n[1]
   * (for V and REG: the current the source delivers out of its + / out terminal
   * is −i[id]). Op-amps report their output current (into the out pin, so a
   * sourcing output is negative) under id and supply current under id + ".supply".
   */
  i: Record<string, number>;
  /** power dissipated in each element, watts */
  p: Record<string, number>;
  iterations: number;
  message?: string;
}

export interface Complex {
  re: number;
  im: number;
}

export interface AcResult {
  freqs: number[];
  /** output / input */
  h: Complex[];
  /** 20·log10|h| */
  db: number[];
  /** radians */
  phase: number[];
}

/** A node, or a pair measured as v(a) − v(b). */
export type Probe = Node | [Node, Node];

export interface TranOptions {
  /** sample rate, Hz */
  fs: number;
  samples: number;
  /** per-source waveforms in volts (or amps for I sources), added to the source's dc value; keyed by element id */
  inputs?: Record<string, Float32Array | number[]>;
  probes: Probe[];
  /** start from this operating point (computed when omitted) */
  op?: DcResult;
  /** internal steps per output sample (default 1); raise it for strongly nonlinear circuits */
  oversample?: number;
  /** called now and then with progress 0..1 */
  onProgress?: (fraction: number) => void;
}

export interface TranResult {
  ok: boolean;
  /** one array per probe, `samples` long */
  out: Float32Array[];
  /** time steps where Newton did not converge (the step was accepted anyway) */
  nonConverged: number;
  message?: string;
}
