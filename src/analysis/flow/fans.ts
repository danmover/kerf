// Fan curves: the pressure a fan gives against the flow through it. A fan whose datasheet values are known (its
// free flow and its shut-off pressure) gets a typical curve through them; one known only by its size gets the values
// of real fans that size, from their datasheets. The shapes are typical of small DC fans: an axial fan's pressure
// falls steadily from shut-off, with a flat stretch at about a third of its free flow where it stalls; a blower's
// stays high longer and drops off towards free flow.

/** P/P_shut-off against Q/Q_free */
const AXIAL: [number, number][] = [
  [0, 1],
  [0.15, 0.86],
  [0.3, 0.7],
  [0.45, 0.6],
  [0.6, 0.47],
  [0.75, 0.31],
  [0.9, 0.13],
  [1, 0],
];
const BLOWER: [number, number][] = [
  [0, 1],
  [0.2, 0.96],
  [0.4, 0.86],
  [0.6, 0.68],
  [0.8, 0.42],
  [1, 0],
];

const CFM = 0.000471947443;
const MMH2O = 9.80665;

/**
 * Fans of each size at a usual speed, from their makers' datasheets: free flow (CFM) and shut-off pressure (Pa).
 * 80 mm: Sunon gives no pressure; the value between its 60 and 120 mm neighbours is used.
 */
const AXIAL_SIZES: { size: number; cfm: number; pa: number; source: string }[] = [
  { size: 30, cfm: 3.38, pa: 41.6, source: "a 30 × 30 × 10 mm fan at 10,000 rpm (Sofasco SD3010…H)" },
  { size: 40, cfm: 4.95, pa: 2.78 * MMH2O, source: "a 40 × 40 × 10 mm fan at 6,000 rpm (Mechatronics MA4010H)" },
  { size: 60, cfm: 23.5, pa: 5.3 * MMH2O, source: "a 60 × 60 × 25 mm fan at 4,500 rpm (Sunon MF60252V1)" },
  { size: 80, cfm: 41, pa: 40, source: "an 80 × 80 × 25 mm fan at 3,200 rpm (Sunon MF80252V1; its pressure between the 60 and 120 mm fans')" },
  { size: 120, cfm: 70, pa: 2.97 * MMH2O, source: "a 120 × 120 × 25 mm fan at 2,000 rpm (Mechatronics MS1225M-H)" },
];
const BLOWER_5015 = { size: 50, cfm: 4, pa: 0.56 * 249.089, source: "a 50 × 50 × 15 mm blower at 5,500 rpm (Mechatronics B5015H24)" };

export interface FanCurve {
  /** [flow m³/s, pressure Pa], from shut-off to free flow */
  curve: [number, number][];
  /** where the numbers came from */
  why: string;
  /** made from the fan's size alone */
  estimated: boolean;
}

/** A fan's curve from what is known of it: its free flow (m³/s) and shut-off pressure (Pa) when the datasheet gives them. */
export function fanCurve(o: { size: number; blower?: boolean; flow?: number; pressure?: number; name?: string }): FanCurve {
  const shape = o.blower ? BLOWER : AXIAL;
  let q = o.flow;
  let p = o.pressure;
  const known = q !== undefined && q > 0 && p !== undefined && p > 0;
  let why: string;
  if (known) why = `its datasheet: ${fmt(q! / CFM, 1)} CFM free flow, ${fmt(p!, 0)} Pa shut-off, on a typical ${o.blower ? "blower" : "axial fan"} curve`;
  else {
    const typ = o.blower ? blowerOfSize(o.size) : axialOfSize(o.size);
    q = q && q > 0 ? q : typ.cfm * CFM;
    p = p && p > 0 ? p : typ.pa;
    why = `a typical ${fmt(o.size, 0)} mm ${o.blower ? "blower" : "fan"}: ${fmt(q / CFM, 1)} CFM free, ${fmt(p, 0)} Pa shut-off, from ${typ.source}; give its datasheet's flow and pressure for its own curve`;
  }
  return { curve: shape.map(([a, b]) => [a * q!, b * p!]), why, estimated: !known };
}

/** Between the sizes with datasheets; past the ends, flow scales with the fan's area at the same pressure. */
function axialOfSize(size: number): { cfm: number; pa: number; source: string } {
  const T = AXIAL_SIZES;
  if (size <= T[0].size) return { cfm: T[0].cfm * (size / T[0].size) ** 2, pa: T[0].pa, source: `${T[0].source}, scaled to its size` };
  const last = T[T.length - 1];
  if (size >= last.size) return { cfm: last.cfm * (size / last.size) ** 2, pa: last.pa, source: size === last.size ? last.source : `${last.source}, scaled to its size` };
  for (let i = 1; i < T.length; i++)
    if (size <= T[i].size) {
      const a = T[i - 1];
      const b = T[i];
      if (size === b.size) return b;
      const f = (size - a.size) / (b.size - a.size);
      return { cfm: a.cfm + f * (b.cfm - a.cfm), pa: a.pa + f * (b.pa - a.pa), source: `fans either side of its size (${a.size} and ${b.size} mm)` };
    }
  return last;
}

function blowerOfSize(size: number): { cfm: number; pa: number; source: string } {
  const b = BLOWER_5015;
  return size === b.size ? b : { cfm: b.cfm * (size / b.size) ** 2, pa: b.pa, source: `${b.source}, scaled to its size` };
}

const fmt = (x: number, d: number) => (Math.round(x * 10 ** d) / 10 ** d).toLocaleString("en-US");
