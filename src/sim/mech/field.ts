// Magnetic fields for the mechanism world: wound air-core coils and permanent
// magnets, the force and torque a coil's field puts on a magnet, and what a
// field sensor reads. Everything is closed-form magnetostatics in SI units
// (tesla, amps, metres): a coil is a grid of circular current loops whose field
// comes from the complete elliptic integrals, a magnet is a dipole for the
// force on it and a stack of loops for its own field (so a sensor close to it
// reads right). No iron: air-core coils and a magnet in free space superpose
// exactly, which is what makes the result trustworthy without a field solver.

export type Vec3 = [number, number, number];

export const MU0 = 4e-7 * Math.PI;

/** Complete elliptic integrals K(m) and E(m), parameter m = k², by the arithmetic-geometric mean. */
export function ellipKE(m: number): [number, number] {
  if (m >= 1) return [Infinity, 1];
  let a = 1;
  let b = Math.sqrt(1 - m);
  let c = Math.sqrt(m);
  let sum = 0.5 * c * c;
  let p = 0.5;
  for (let i = 0; i < 12 && Math.abs(c) > 1e-15; i++) {
    const an = (a + b) / 2;
    c = (a - b) / 2;
    b = Math.sqrt(a * b);
    a = an;
    p *= 2;
    sum += p * c * c;
  }
  const K = Math.PI / (2 * a);
  return [K, K * (1 - sum)];
}

/**
 * The field of one circular loop of radius R carrying 1 A, at radial distance rho and height z from its
 * centre (its axis along z, current counter-clockwise seen from +z): [B_rho, B_z] in tesla.
 */
export function loopField(R: number, rho: number, z: number): [number, number] {
  if (rho < 1e-9 * R) {
    const d = R * R + z * z;
    return [0, (MU0 * R * R) / (2 * d * Math.sqrt(d))];
  }
  const s = R * R + rho * rho + z * z;
  const a2 = s - 2 * R * rho;
  const b2 = s + 2 * R * rho;
  const b = Math.sqrt(b2);
  const [K, E] = ellipKE(1 - a2 / b2);
  const C = MU0 / Math.PI;
  // on the wire itself the field is singular: hold it at a wire's width away
  const a2s = Math.max(a2, 1e-12);
  const Brho = ((C * z) / (2 * a2s * b * rho)) * (s * E - a2s * K);
  const Bz = (C / (2 * a2s * b)) * ((R * R - rho * rho - z * z) * E + a2s * K);
  return [Brho, Bz];
}

export interface CoilShape {
  /** centre of the winding and the unit axis its field points along for positive current, m */
  c: Vec3;
  axis: Vec3;
  /** winding inner and outer radius and length along the axis, m */
  ri: number;
  ro: number;
  h: number;
  turns: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** two unit vectors square to a unit axis and to each other */
export function perpendiculars(axis: Vec3): [Vec3, Vec3] {
  const t: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = dot(t, axis);
  const u: Vec3 = [t[0] - d * axis[0], t[1] - d * axis[1], t[2] - d * axis[2]];
  const l = Math.hypot(u[0], u[1], u[2]);
  u[0] /= l;
  u[1] /= l;
  u[2] /= l;
  return [u, [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]]];
}

/** A wound coil as nr × nz circular filaments sharing its turns evenly. */
export class CoilField {
  private rs: number[] = [];
  private zs: number[] = [];
  private w: number;
  constructor(
    public shape: CoilShape,
    nr = 4,
    nz = 4,
  ) {
    const { ri, ro, h, turns } = shape;
    for (let i = 0; i < nr; i++) this.rs.push(ri + ((i + 0.5) * (ro - ri)) / nr);
    for (let j = 0; j < nz; j++) this.zs.push(-h / 2 + ((j + 0.5) * h) / nz);
    this.w = turns / (nr * nz);
  }

  /** flux density at p for 1 A in the winding, tesla */
  at(p: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
    const { c, axis } = this.shape;
    const d: Vec3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    const z = dot(d, axis);
    const rx = d[0] - z * axis[0];
    const ry = d[1] - z * axis[1];
    const rz = d[2] - z * axis[2];
    const rho = Math.hypot(rx, ry, rz);
    let br = 0;
    let bz = 0;
    for (const R of this.rs)
      for (const z0 of this.zs) {
        const [a, b] = loopField(R, rho, z - z0);
        br += a;
        bz += b;
      }
    br *= this.w;
    bz *= this.w;
    const k = rho > 1e-12 ? br / rho : 0;
    out[0] = bz * axis[0] + k * rx;
    out[1] = bz * axis[1] + k * ry;
    out[2] = bz * axis[2] + k * rz;
    return out;
  }

  /**
   * The flux 1 A in another coil puts through this winding's turns, Wb: their mutual inductance, H. Each
   * filament's disc is sampled on rings of equal area.
   */
  linkage(from: CoilField, rings = 3, spokes = 8): number {
    const { c, axis } = this.shape;
    const [u, v] = perpendiculars(axis);
    const p: Vec3 = [0, 0, 0];
    const b: Vec3 = [0, 0, 0];
    let sum = 0;
    for (const R of this.rs)
      for (const z0 of this.zs) {
        let flux = 0;
        for (let j = 0; j < rings; j++) {
          const r = R * Math.sqrt((j + 0.5) / rings);
          for (let k = 0; k < spokes; k++) {
            const a = (2 * Math.PI * (k + 0.5 * (j % 2))) / spokes;
            const cu = r * Math.cos(a);
            const cv = r * Math.sin(a);
            for (let i = 0; i < 3; i++) p[i] = c[i] + z0 * axis[i] + cu * u[i] + cv * v[i];
            from.at(p, b);
            flux += dot(b, axis);
          }
        }
        sum += (flux * Math.PI * R * R) / (rings * spokes);
      }
    return sum * this.w;
  }

  /** copper length of the winding, m */
  wireLength(): number {
    return this.shape.turns * Math.PI * (this.shape.ri + this.shape.ro);
  }
}

/** How many turns of round enamelled wire fit a winding window (hand wound: about 88 % of square packing). */
export function turnsThatFit(ri: number, ro: number, h: number, wireD: number, enamel = 0.05e-3, pack = 0.88): number {
  return Math.floor((pack * (ro - ri) * h) / (wireD + enamel) ** 2);
}

/** Resistance of a copper winding at a temperature, Ω (1.72e-8 Ω·m at 20 °C, +0.393 % per K). */
export function windingResistance(lengthM: number, wireD: number, tempC = 20): number {
  return ((1.72e-8 * lengthM) / (Math.PI * (wireD / 2) ** 2)) * (1 + 0.00393 * (tempC - 20));
}

/** Inductance of a multilayer air-core coil, H (Wheeler's formula, within a few per cent for ordinary shapes). */
export function wheelerInductance(ri: number, ro: number, h: number, turns: number): number {
  const a = (ri + ro) / 2 / 0.0254;
  const b = h / 0.0254;
  const c = (ro - ri) / 0.0254;
  return ((0.8 * a * a * turns * turns) / (6 * a + 9 * b + 10 * c)) * 1e-6;
}

/** Magnetic moment of a uniformly magnetised magnet from its remanence and volume, A·m². */
export function magnetMoment(brT: number, volumeM3: number): number {
  return (brT * volumeM3) / MU0;
}

/** Typical remanence of a sintered neodymium grade, tesla (the middle of the grade's band). */
export function remanenceOf(grade: string): number {
  const n = Number(/N?(\d+)/i.exec(grade)?.[1] ?? 35);
  // N35 1.17-1.22, N42 1.28-1.32, N45 1.32-1.38, N52 1.43-1.48
  return 0.0159 * n + 0.635;
}

/** The field of a point dipole m (A·m²) at offset r from it, tesla. */
export function dipoleField(m: Vec3, r: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const d2 = dot(r, r);
  const d = Math.sqrt(d2);
  if (d < 1e-6) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const k = MU0 / (4 * Math.PI * d2 * d);
  const mr = (3 * dot(m, r)) / d2;
  out[0] = k * (mr * r[0] - m[0]);
  out[1] = k * (mr * r[1] - m[1]);
  out[2] = k * (mr * r[2] - m[2]);
  return out;
}

/**
 * A cylinder magnet's own field: the same as a thin solenoid of its size carrying its magnetisation as a
 * surface current, here a stack of loops. Right close to the magnet, where a point dipole is not.
 */
export class MagnetField {
  private coil: CoilField;
  private ampTurns: number;
  constructor(
    /** radius and length, m; moment, A·m² */
    public radius: number,
    public length: number,
    public moment: number,
  ) {
    const n = Math.max(3, Math.min(12, Math.round((length / radius) * 4)));
    this.coil = new CoilField({ c: [0, 0, 0], axis: [0, 0, 1], ri: radius, ro: radius, h: length, turns: 1 }, 1, n);
    // m = (amp-turns) × π r²
    this.ampTurns = moment / (Math.PI * radius * radius);
  }
  /** field at p for a magnet centred at c with its north along unit axis n */
  at(c: Vec3, n: Vec3, p: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
    this.coil.shape.c = c;
    this.coil.shape.axis = n;
    this.coil.at(p, out);
    out[0] *= this.ampTurns;
    out[1] *= this.ampTurns;
    out[2] *= this.ampTurns;
    return out;
  }
}

export interface Wrench {
  force: Vec3;
  torque: Vec3;
  /** the field at the magnet, tesla */
  b: Vec3;
}

const H = 1e-4;
const tmpA: Vec3 = [0, 0, 0];
const tmpB: Vec3 = [0, 0, 0];

/**
 * The force and torque on a dipole m (A·m², world axes) at p from a set of coils and their currents:
 * F = ∇(m·B), by central differences of the exact coil fields 0.1 mm apart, and τ = m × B.
 */
export function dipoleWrench(coils: readonly CoilField[], amps: readonly number[], p: Vec3, m: Vec3): Wrench {
  const B: Vec3 = [0, 0, 0];
  const F: Vec3 = [0, 0, 0];
  const q: Vec3 = [p[0], p[1], p[2]];
  for (let k = 0; k < coils.length; k++) {
    const i = amps[k];
    if (!i) continue;
    const c = coils[k];
    c.at(p, tmpA);
    B[0] += i * tmpA[0];
    B[1] += i * tmpA[1];
    B[2] += i * tmpA[2];
    for (let ax = 0; ax < 3; ax++) {
      q[ax] = p[ax] + H;
      c.at(q, tmpA);
      q[ax] = p[ax] - H;
      c.at(q, tmpB);
      q[ax] = p[ax];
      F[ax] += (i * (dot(m, tmpA) - dot(m, tmpB))) / (2 * H);
    }
  }
  return { force: F, torque: [m[1] * B[2] - m[2] * B[1], m[2] * B[0] - m[0] * B[2], m[0] * B[1] - m[1] * B[0]], b: B };
}

/** The total coil field at a point, tesla. */
export function coilsField(coils: readonly CoilField[], amps: readonly number[], p: Vec3): Vec3 {
  const B: Vec3 = [0, 0, 0];
  for (let k = 0; k < coils.length; k++) {
    const i = amps[k];
    if (!i) continue;
    coils[k].at(p, tmpA);
    B[0] += i * tmpA[0];
    B[1] += i * tmpA[1];
    B[2] += i * tmpA[2];
  }
  return B;
}

// ---------- the air in a small wind tunnel ----------

export interface TunnelFan {
  /** free-air flow, m³/s, and shut-off pressure, Pa, at full speed */
  flowMax: number;
  pressureMax: number;
}

/**
 * Air speed in the test section of an open-circuit tunnel: where the fan's curve (shut-off pressure falling
 * with flow squared, both scaled by fan speed) meets the circuit's losses, K dynamic heads of the test section.
 * speed: the fan's speed as a share of full; area: test section, m². Returns m/s.
 */
export function tunnelSpeed(fan: TunnelFan, speed: number, area: number, lossK: number, rho = 1.2): number {
  if (speed <= 0) return 0;
  const q = speed * Math.sqrt(fan.pressureMax / (fan.pressureMax / (fan.flowMax * fan.flowMax) + (lossK * rho) / (2 * area * area)));
  return q / area;
}

/** Solid blockage: how much faster the air passes a body filling part of a closed test section (Pope's ¼ rule). */
export function blockageFactor(frontal: number, section: number): number {
  return 1 + 0.25 * (frontal / section);
}
