// A box of dry sand with a screw-driven burrowing robot in it, as a reduced-
// order model: Janssen silo stress at the robot's depth, torque and thrust of
// each screw section from friction on its flights and shell, a thrust–slip
// curve, a quasi-static balance of thrust against face and skin drag, and
// articulated steering about a hinge. The robot moves in a plane through the
// pit and drifts in heading and pitch the way loose soil makes it; the walls
// and floor stop it. Nothing here is particles: it is fast enough to run the
// real firmware against for the whole crossing, and every number it rests on
// is listed with the results.

import type { MotorLoad, Orientation, PlantView, SceneSpec, World, WorldEvent } from "./types";
import { clamp, D2R, G, gauss, R2D, rngFrom, type VariantName } from "./common";

export interface SandPitSpec {
  /** wall to wall along the path, mm */
  length: number;
  /** across the path, mm */
  width: number;
  /** sand depth above the floor, mm */
  depth: number;
  /** the robot's axis above the floor at the start, mm */
  axis: number;
  /** bulk density, g/cm³ */
  density: number;
  /** internal friction angle, degrees */
  phi: number;
  /** sand on the pit walls, degrees */
  wallPhi: number;
  /** hinge distance in from the near wall at the start, mm (0: the rear section starts in the launch hole) */
  start: number;
  /** opening in the far wall the robot has to come out through, diameter in mm (0: a solid wall) */
  exitD: number;
  /** sand temperature, °C */
  ambient: number;
  /** the most a helper pushes the tail with to get it started, N (0: no help) */
  push?: number;
  /** how far the helper pushes it in, mm of travel (0: until every screw is in the sand) */
  pushTo?: number;
}

export interface ScrewSpec {
  motor: string;
  /** flight outside diameter, mm */
  d: number;
  /** shell diameter, mm */
  core: number;
  pitch: number;
  /** design X range of the flights, mm */
  from: number;
  to: number;
  /** the front section that cuts the face */
  face: boolean;
  /** +1 when the screw pulls the robot forward as its motor turns forward */
  advance: number;
  /** turning sense about the design X axis when its motor turns forward (+1 or -1) */
  turn: number;
}

export interface HingeSpec {
  /** design X of the vertical hinge pin */
  x: number;
  actuator: string;
  /** hinge pin to where the actuator or its cam pushes, mm */
  arm: number;
  /** sideways movement per mm of stroke (1 for a direct push) */
  slope: number;
  /** stroke when the hinge is straight, mm */
  mid: number;
  /** hinge angle where the linkage hits its stop, degrees */
  stop: number;
  /** +1 when extending the actuator turns the nose left (counter-clockwise from above) */
  dir: number;
  /** friction in the slot or joint */
  friction: number;
}

export interface TunnellerSpec {
  screws: ScrewSpec[];
  /** sand sliding on the printed shell, degrees */
  delta: number;
  /** the body that does not turn: diameter and design X range */
  body: { d: number; from: number; to: number };
  /** design X of the nose and tail tips */
  nose: number;
  tail: number;
  hinge?: HingeSpec;
  /** design X of each IMU, which puts it on the front or rear body */
  imus: Record<string, number>;
}

/** What each variant does to the uncertain numbers. */
const K: Record<VariantName, { stress: number; thrust: number; drift: number; steer: number; cooling: number }> = {
  pessimistic: { stress: 1.5, thrust: 0.6, drift: 2, steer: 0.35, cooling: 0.35 },
  expected: { stress: 1, thrust: 1, drift: 1, steer: 0.6, cooling: 0.5 },
  optimistic: { stress: 0.7, thrust: 1.3, drift: 0.5, steer: 0.85, cooling: 0.7 },
};

/** Thrust as a share of the expected thrust (which the sizing calc takes at 50 % slip). */
const SLIP0 = 0.15;
const G_NORM = 1 - Math.exp(-0.5 / SLIP0);
const thrustCurve = (s: number) => (Math.sign(s) * (1 - Math.exp(-Math.abs(s) / SLIP0))) / G_NORM;

/** Drift the soil gives a burrowing robot, per 100 mm travelled (expected values; varied per run). */
const DRIFT = {
  /** steady heading drift, degrees (clockwise): uneven side forces of the two screws */
  yaw: -0.5,
  /** steady pitch drift, degrees (nose up): the floor below is firmer than the sand above */
  pitch: 0.15,
  /** random heading and pitch wander, degrees per √(100 mm) */
  walk: 0.25,
};

interface ScrewMech {
  /** N·mm to turn the flighted length fully buried */
  tSpin: number;
  /** N·mm extra for cutting the face */
  tFace: number;
  /** N of thrust at 50 % slip, fully buried */
  fExp: number;
  /** N the face resists with */
  rFace: number;
}

function screwMech(s: ScrewSpec, sv: number, sh: number, phi: number, delta: number): ScrewMech {
  const sn = (sv + sh) / 2;
  const tphi = Math.tan(phi * D2R);
  const tdel = Math.tan(delta * D2R);
  const D = s.d;
  const Ls = s.to - s.from;
  const p = s.pitch;
  const Fskin = sn * tphi * Math.PI * D * Ls;
  const Tod = (Fskin * D) / 2;
  const rc = s.core / 2;
  const Rf = D / 2;
  const Tin = sn * tdel * (Math.PI * s.core * Ls * rc + (Ls / p) * Math.PI * (Rf * Rf - rc * rc) * ((Rf + rc) / 2));
  const tSpin = Math.min(Tod, Tin);
  const tFace = s.face ? (2 / 3) * sh * tphi * Math.PI * Rf ** 3 : 0;
  const T = tSpin + tFace;
  const tanTheta = (p * 0.5) / (Math.PI * D);
  const low = (2 * tSpin * tanTheta) / D;
  const dm = (D + s.core) / 2;
  const lam = Math.atan(p / (Math.PI * dm));
  const high = Math.min((2 * T) / (dm * Math.tan(lam + delta * D2R)), Fskin);
  const fExp = Tin <= Tod ? Math.max(low, 0.5 * high) : low;
  const rFace = s.face ? sh * Math.PI * Rf * Rf * 0.5 : 0;
  return { tSpin, tFace, fExp, rFace };
}

export class SandPit implements World {
  kind = "sand_pit";
  events: WorldEvent[] = [];
  limits: string[];
  assumptions: string[] = [];
  private k: (typeof K)[VariantName];
  private rng: () => number;

  // geometry
  private h: number;
  private front: ScrewSpec[];
  private rear: ScrewSpec[];
  private aF: number;
  private aR: number;
  private rMax: number;
  private gamma: number;
  private janssenR: number;
  private mu: number;
  private Kj: number;

  // state
  private px: number;
  private py: number;
  private pz: number;
  /** rear body heading, rad, counter-clockwise from the pit axis */
  private psi = 0;
  private theta = 0;
  private alpha = 0;
  private roll = 0;
  private v = 0;
  private vPrev = 0;
  private rates: [number, number, number] = [0, 0, 0];
  private t = 0;

  // per screw, refreshed each step
  private eng = new Map<string, number>();
  private torque = new Map<string, number>();
  private thrust = new Map<string, number>();
  private slip = new Map<string, number>();
  private omega = new Map<string, number>();
  private resistF = 0;
  private thrustNet = 0;
  private thrustSum = 0;
  /** body roll rate against the sand, rad/s */
  private rho = 0;
  private rolling = false;
  private sigmaV = 0;
  private contact = 0;
  private actSpeed = 0;
  private actPos: number;

  // what happened
  private through = false;
  private blocked = false;
  private noseStart: number;
  private noseMax: number;
  private tReach: number | undefined;
  private missAt: { y: number; z: number } | undefined;
  private wallSide = false;
  private floorTouch = false;
  private stuckFor = 0;
  private stuckTotal = 0;
  private stuckReported = false;
  private headingMax = 0;
  private rollMax = 0;
  private pitchMax = 0;
  private moveTime = 0;
  private moveDist = 0;
  private slipSum = 0;
  private slipN = 0;
  private entered = new Set<string>();
  private exitedAt: number | undefined;
  /** the helper's push on the tail now, its peak and how far they pushed, N and mm */
  private pushF = 0;
  private pushPeak = 0;
  private pushDist = 0;
  private pushing: boolean;

  constructor(
    public pit: SandPitSpec,
    public robot: TunnellerSpec,
    public variant: VariantName,
    seed: number,
  ) {
    this.k = K[variant];
    this.rng = rngFrom(seed);
    this.h = robot.hinge?.x ?? 0;
    this.front = robot.screws.filter((s) => (s.from + s.to) / 2 >= this.h);
    this.rear = robot.screws.filter((s) => (s.from + s.to) / 2 < this.h);
    const centre = (list: ScrewSpec[], fallback: number) => (list.length ? list.reduce((a, s) => a + (s.from + s.to) / 2, 0) / list.length : fallback);
    this.aF = Math.max(20, centre(this.front, robot.nose) - this.h);
    this.aR = Math.max(20, this.h - centre(this.rear, robot.tail));
    this.rMax = Math.max(robot.body.d, ...robot.screws.map((s) => s.d)) / 2;
    this.gamma = pit.density * G * 1e-6;
    this.janssenR = (pit.length * pit.width) / (2 * (pit.length + pit.width));
    this.mu = Math.tan(pit.wallPhi * D2R);
    this.Kj = 1 - Math.sin(pit.phi * D2R);
    this.px = pit.start;
    this.py = 0;
    this.pz = pit.axis;
    this.actPos = robot.hinge?.mid ?? 0;
    this.pushing = (pit.push ?? 0) > 0;
    this.noseStart = this.px + robot.nose - this.h;
    this.noseMax = this.noseStart;
    for (const s of robot.screws) {
      this.eng.set(s.motor, 0);
      this.torque.set(s.motor, 0);
      this.thrust.set(s.motor, 0);
      this.slip.set(s.motor, 0);
      this.omega.set(s.motor, 0);
    }
    this.limits = [
      "Reduced-order soil, not particles: Janssen silo stress at the robot's depth, screw torque and thrust from sand friction on the flights and shell, and a thrust–slip curve fitted to the sizing calc's 50 % slip.",
      "The sand is uniform and dry. Layers, damp patches, stones, compaction by the run and the tunnel caving in behind are left out.",
      "How well the hinge turns the robot (steering grip) and how much loose sand makes it drift are estimates. The three runs vary them, and the drift rates are guesses that only a trench test can measure.",
      "Walls and the floor are rigid stops with extra drag, not contact forces. The rear screw sees the same sand as the front, though the front has loosened it.",
      "Each motor heats as one lump of metal, and buried in sand it sheds heat about half as well as in still air.",
    ];
    const kk = this.k;
    this.assumptions.push(
      `${variant} run: soil stress ×${kk.stress}, screw thrust ×${kk.thrust}, drift ×${kk.drift}, steering grip ${Math.round(kk.steer * 100)} %`,
      `Thrust against slip: reaches ${Math.round((1 - Math.exp(-0.2 / SLIP0)) / G_NORM * 100)} % of the expected thrust at 20 % slip and levels off above 50 %`,
      `Drift: ${Math.abs(DRIFT.yaw)}° clockwise and ${DRIFT.pitch}° nose-up per 100 mm, plus ±${DRIFT.walk}° random wander per √100 mm (guesses)`,
    );
  }

  // ---------- geometry ----------

  private dirOf(yaw: number) {
    const c = Math.cos(this.theta);
    return [Math.cos(yaw) * c, Math.sin(yaw) * c, Math.sin(this.theta)] as const;
  }

  /** world point of a design X on the front or rear body */
  private at(x: number): [number, number, number] {
    const yaw = x >= this.h ? this.psi + this.alpha : this.psi;
    const [ex, ey, ez] = this.dirOf(yaw);
    const d = x - this.h;
    return [this.px + d * ex, this.py + d * ey, this.pz + d * ez];
  }

  /** where the sand is along the pit for a part reaching world x */
  private sandEnd() {
    return this.pit.length;
  }

  /** share of a design X range that sits in the sand */
  private buried(from: number, to: number): number {
    const a = this.at(from)[0];
    const b = this.at(to)[0];
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const span = hi - lo;
    if (span <= 0) return 0;
    const inside = Math.max(0, Math.min(hi, this.sandEnd()) - Math.max(lo, 0));
    return clamp(inside / span, 0, 1);
  }

  private stress(): { sv: number; sh: number } {
    const z = Math.max(0, this.pit.depth - this.pz);
    const R = this.janssenR;
    const sv = ((this.gamma * R) / (this.mu * this.Kj)) * (1 - Math.exp((-this.mu * this.Kj * z) / R)) * this.k.stress;
    return { sv, sh: this.Kj * sv };
  }

  private noseInSand() {
    const x = this.at(this.robot.nose)[0];
    return x > 0 && x < this.pit.length;
  }

  // ---------- World ----------

  motorLoad(comp: string): MotorLoad {
    const T = this.torque.get(comp);
    if (T === undefined) return { coulomb: 0, viscous: 0, external: 0, inertia: 0 };
    // a printed screw about 0.3 kg at 40 mm, plus the sand it carries round
    return { coulomb: T / 1000, viscous: 0.002, external: 0, inertia: 4e-4 };
  }

  actuatorLoad(comp: string): number {
    const hg = this.robot.hinge;
    if (!hg || hg.actuator !== comp) return 0;
    const off = this.actPos - hg.mid;
    const stopStroke = (hg.arm * Math.tan(hg.stop * D2R)) / hg.slope;
    // the slot or linkage end: it cannot go further
    if (Math.abs(off) >= stopStroke && Math.sign(this.actSpeed || off) === Math.sign(off)) return Math.sign(off) * 5000;
    if (Math.abs(this.v) < 0.05 || off === 0) return 0;
    // the soil resists the hinge turning while the robot moves: the moment the sizing calc uses
    const { sh } = this.stress();
    const Lf = this.robot.nose - hg.x;
    const d = Math.max(...this.robot.screws.map((s) => s.d));
    const rearThrust = this.rear.reduce((a, s) => a + Math.max(0, this.thrust.get(s.motor) ?? 0), 0);
    const a = Math.abs(this.alpha);
    const M = rearThrust * Math.sin(a) * (Lf / 2) + ((0.3 * sh * d * Lf * Lf) / 6) * Math.min(1, a / (hg.stop * D2R));
    const s = hg.slope;
    const mu = hg.friction;
    const outward = Math.sign(this.actSpeed) === Math.sign(off);
    // through the slanted slot (a wedge with friction): pushing out takes more, coming back the soil helps
    const f = outward ? ((M / hg.arm) * (s + mu)) / (1 - mu * s) : ((M / hg.arm) * (s - mu)) / (1 + mu * s);
    return Math.sign(off) * f;
  }

  orientation(comp: string): Orientation {
    const x = this.robot.imus[comp] ?? this.h - 1;
    const yaw = (x >= this.h ? this.psi + this.alpha : this.psi) * R2D;
    const ax = (this.v - this.vPrev) / 1000 / 0.001;
    return { yaw, pitch: this.theta * R2D, roll: this.roll, rate: this.rates, accel: [clamp(ax, -5, 5), 0, 0] };
  }

  thermal() {
    return { ambient: this.pit.ambient, cooling: this.k.cooling };
  }

  step(dt: number, t: number, plant: PlantView): void {
    this.t = t;
    const hg = this.robot.hinge;
    const L = this.pit.length;
    // the hinge follows the actuator
    if (hg) {
      const a = plant.actuator(hg.actuator);
      if (a) {
        this.actPos = a.pos;
        this.actSpeed = a.speed;
        const ang = Math.atan(((a.pos - hg.mid) * hg.slope) / hg.arm);
        this.alpha = hg.dir * clamp(ang, -hg.stop * D2R, hg.stop * D2R);
      }
    }
    const { sv, sh } = this.stress();
    this.sigmaV = sv;
    const kt = this.k.thrust;
    const noseIn = this.noseInSand() && !this.blocked;
    // each screw: how much of it is buried, and the torque the sand resists its turning with (N·mm)
    const sn = (sv + sh) / 2;
    const tdel = Math.tan(this.robot.delta * D2R);
    const mech = this.robot.screws.map((s) => {
      const m = screwMech(s, sv, sh, this.pit.phi, this.robot.delta);
      const e = this.buried(s.from, s.to);
      const w = plant.motor(s.motor)?.omega ?? 0;
      this.eng.set(s.motor, e);
      this.omega.set(s.motor, w);
      if (e > 0.05 && !this.entered.has(s.motor)) {
        this.entered.add(s.motor);
        this.events.push({ t, kind: "info", text: `${s.motor}'s screw is in the sand` });
      }
      const face = s.face && noseIn;
      let T = e * m.tSpin + (face ? m.tFace : 0);
      if (this.contact > 0 && e > 0) {
        // pushing on the far wall: the flights carry the push like a screw in a nut, and the nose grinds on the wall
        const share = Math.max(0, this.thrust.get(s.motor) ?? 0) / Math.max(1, this.thrustSum);
        const dm = (s.d + s.core) / 2;
        const lam = Math.atan(s.pitch / (Math.PI * dm));
        T += this.contact * share * (dm / 2) * Math.tan(lam + this.robot.delta * D2R);
        if (s.face) T += this.contact * 0.4 * 20;
      }
      return { s, m, e, w, T, vNut: 0, face };
    });
    // roll: each motor turns its screw against the body. Skin friction on the body holds the
    // screws' reactions; past that the body turns instead, with the screw that grips hardest.
    const bodyIn = this.buried(this.robot.body.from, this.robot.body.to) * (this.robot.body.to - this.robot.body.from);
    const tailX = this.at(this.robot.tail)[0];
    const inTube = tailX < 0 && this.rear.length > 0;
    const hold = inTube ? Infinity : sn * tdel * Math.PI * this.robot.body.d * bodyIn * (this.robot.body.d / 2) + 300;
    const W0 = 0.02;
    const sat = (x: number) => (x < -1 ? -1 : x > 1 ? 1 : x);
    const bodyTorque = (rho: number) => mech.reduce((a, x) => a + x.T * sat((x.s.turn * x.w + rho) / W0), 0) + hold * sat(rho / W0);
    let rho = 0;
    if (Number.isFinite(hold) && Math.abs(bodyTorque(0)) > hold) {
      let lo = -(Math.max(...mech.map((x) => Math.abs(x.w))) + 1);
      let hi = -lo;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (bodyTorque(mid) > 0) hi = mid;
        else lo = mid;
      }
      rho = (lo + hi) / 2;
    }
    this.rho = rho;
    for (const x of mech) {
      // the screw's turning against the sand, in its motor's sense
      const rel = x.w + x.s.turn * rho;
      x.vNut = (x.s.advance * rel * x.s.pitch) / (2 * Math.PI);
      this.torque.set(x.s.motor, rho === 0 ? x.T : Math.abs(x.T * sat(rel / W0)));
    }
    const thrustAt = (v: number) => {
      let f = 0;
      for (const x of mech) {
        if (x.e <= 0) continue;
        const slip = (x.vNut - v) / Math.max(Math.abs(x.vNut), 1);
        f += x.e * x.m.fExp * kt * thrustCurve(slip);
      }
      return f;
    };
    // what the sand resists with: the face ahead and skin drag on the body that does not turn
    let drag = sn * tdel * Math.PI * this.robot.body.d * bodyIn;
    if (this.wallSide) drag *= 1.2;
    const rFace = mech.reduce((a, x) => a + (x.face ? x.m.rFace : 0), 0);
    const tailIn = tailX > 0 && tailX < L;
    const rFwd = rFace + drag;
    const rBack = drag + (tailIn ? 0.5 * mech.reduce((a, x) => a + x.m.rFace, 0) : 0);
    // quasi-static axial balance: the speed where thrust equals resistance
    const f0 = thrustAt(0);
    let v = 0;
    this.contact = 0;
    if (f0 > rFwd) {
      if (this.blocked) {
        this.contact = f0 - rFwd;
      } else {
        let lo = 0;
        let hi = Math.max(5, ...mech.map((x) => Math.abs(x.vNut))) * 1.5 + 5;
        for (let i = 0; i < 32; i++) {
          const mid = (lo + hi) / 2;
          if (thrustAt(mid) > rFwd) lo = mid;
          else hi = mid;
        }
        v = (lo + hi) / 2;
      }
    } else if (f0 < -rBack) {
      let lo = -(Math.max(5, ...mech.map((x) => Math.abs(x.vNut))) * 1.5 + 5);
      let hi = 0;
      for (let i = 0; i < 32; i++) {
        const mid = (lo + hi) / 2;
        if (thrustAt(mid) < -rBack) hi = mid;
        else lo = mid;
      }
      v = (lo + hi) / 2;
    }
    // a helper pushing the tail from the launch hole: when the screws alone go slower than half their
    // own pace, they push (up to their most) to keep it at that pace, until the screws are in the sand
    this.pushF = 0;
    if (this.pushing && !this.blocked) {
      const pace = 0.5 * Math.max(0, ...mech.filter((x) => x.e > 0).map((x) => x.vNut));
      if (pace > 0.2 && v < pace) {
        const most = this.pit.push ?? 0;
        if (thrustAt(pace) + most >= rFwd) v = pace;
        else if (f0 + most > rFwd) {
          let lo = 0;
          let hi = pace;
          for (let i = 0; i < 32; i++) {
            const mid = (lo + hi) / 2;
            if (thrustAt(mid) + most > rFwd) lo = mid;
            else hi = mid;
          }
          v = (lo + hi) / 2;
        }
        this.pushF = clamp(rFwd - thrustAt(v), 0, most);
        this.pushPeak = Math.max(this.pushPeak, this.pushF);
      }
      this.pushDist += Math.max(0, v) * dt;
      const done = (this.pit.pushTo ?? 0) > 0 ? this.pushDist >= (this.pit.pushTo ?? 0) : this.robot.screws.every((x) => (this.eng.get(x.motor) ?? 0) > 0.5);
      if (done) {
        this.pushing = false;
        this.events.push({ t, kind: "info", text: `Pushed in by hand for ${Math.round(this.pushDist)} mm, at most ${Math.round(this.pushPeak)} N: digging on its own from here` });
      }
    }
    this.resistF = v > 0 ? rFwd : v < 0 ? rBack : Math.min(Math.abs(f0), rFwd);
    this.thrustNet = f0;
    // each screw's thrust and slip at this speed
    this.thrustSum = 0;
    for (const x of mech) {
      const slip = x.e > 0 ? (x.vNut - v) / Math.max(Math.abs(x.vNut), 1) : 0;
      const f = x.e * x.m.fExp * kt * thrustCurve(slip);
      this.slip.set(x.s.motor, slip);
      this.thrust.set(x.s.motor, f);
      this.thrustSum += Math.max(0, f);
    }
    // ---- kinematics ----
    this.vPrev = this.v;
    this.v = v;
    const ds = v * dt;
    const kd = this.k.drift;
    // a keyed launch hole holds the rear section straight until it is out in the sand
    const rearHeld = inTube;
    let psiDot = 0;
    if (!rearHeld) {
      psiDot = (this.k.steer * v * Math.sin(this.alpha)) / (this.aF + this.aR * Math.cos(this.alpha));
      psiDot += kd * DRIFT.yaw * D2R * (v / 100);
    }
    const thetaDot = kd * DRIFT.pitch * D2R * (v / 100);
    const walk = Math.sqrt(Math.abs(ds) / 100) * DRIFT.walk * D2R * kd;
    const dPsi = psiDot * dt + (rearHeld ? 0 : walk * gauss(this.rng));
    const dTheta = thetaDot * dt + walk * gauss(this.rng);
    // move the rear reference point along the rear axis, then swing the hinge round it
    const [ex, ey, ez] = this.dirOf(this.psi);
    const qx = this.px - this.aR * ex + ds * ex;
    const qy = this.py - this.aR * ey + ds * ey;
    const qz = this.pz - this.aR * ez + ds * ez;
    this.psi += dPsi;
    this.theta = clamp(this.theta + dTheta, -30 * D2R, 30 * D2R);
    const [nx, ny, nz] = this.dirOf(this.psi);
    this.px = qx + this.aR * nx;
    this.py = qy + this.aR * ny;
    this.pz = qz + this.aR * nz;
    this.roll += rho * R2D * dt;
    if (Math.abs(rho) > 0.05 && !this.rolling) {
      this.rolling = true;
      this.events.push({ t, kind: "warn", text: `The body is turning with the screws: skin friction (${(hold / 1000).toFixed(1)} N·m) cannot hold their reaction` });
    } else if (Math.abs(rho) < 0.01) this.rolling = false;
    // ---- walls and floor ----
    const half = this.pit.width / 2;
    const pts = [this.at(this.robot.nose), [this.px, this.py, this.pz], this.at(this.robot.tail)];
    let shiftY = 0;
    for (const p of pts) {
      if (p[1] + this.rMax > half) shiftY = Math.min(shiftY, half - this.rMax - p[1]);
      if (p[1] - this.rMax < -half) shiftY = Math.max(shiftY, -half + this.rMax - p[1]);
    }
    if (shiftY !== 0) {
      this.py += shiftY;
      // the wall turns the robot along itself
      this.psi *= Math.exp(-Math.abs(ds) / 200);
      if (!this.wallSide) this.events.push({ t, kind: "contact", text: `Ran into the ${shiftY < 0 ? "left" : "right"} side wall` });
      this.wallSide = true;
    }
    let lift = 0;
    for (const p of pts) if (p[2] - this.rMax < 0) lift = Math.max(lift, this.rMax - p[2]);
    if (lift > 0) {
      this.pz += lift;
      if (this.at(this.robot.nose)[2] <= this.pz) this.theta = Math.max(this.theta, 0);
      else this.theta = Math.min(this.theta, 0);
      if (!this.floorTouch) this.events.push({ t, kind: "contact", text: "Reached the pit floor and is running along it" });
      this.floorTouch = true;
    }
    // ---- the far wall ----
    const nose = this.at(this.robot.nose);
    if (!this.through && nose[0] >= L) {
      const off = Math.hypot(nose[1], nose[2] - this.pit.axis);
      if (this.tReach === undefined) {
        this.tReach = t;
        this.missAt = { y: nose[1], z: nose[2] - this.pit.axis };
        this.events.push({ t, kind: "goal", text: `Reached the far wall ${Math.round(off)} mm off the line` });
      }
      const room = this.pit.exitD / 2 - this.maxFlight() / 2;
      if (this.pit.exitD > 0 && off <= room) {
        this.through = true;
        this.events.push({ t, kind: "goal", text: "Broke through into the exit opening" });
      } else {
        if (!this.blocked)
          this.events.push({
            t,
            kind: "contact",
            text: this.pit.exitD > 0 ? `Missed the exit opening by ${Math.round(off - Math.max(0, room))} mm and is pressing on the wall` : "Pressing on the far wall",
          });
        this.blocked = true;
        // stay against the wall
        this.px -= nose[0] - L;
      }
    }
    if (this.blocked && v < 0) this.blocked = this.at(this.robot.nose)[0] >= L - 0.5;
    if (this.through && this.exitedAt === undefined) {
      const lastFlight = Math.min(...this.front.map((s) => s.from));
      if (Number.isFinite(lastFlight) && this.at(lastFlight)[0] >= L) {
        this.exitedAt = t;
        this.events.push({ t, kind: "goal", text: "The front screw is out through the far wall" });
      }
    }
    // ---- bookkeeping ----
    const noseX = this.at(this.robot.nose)[0];
    if (noseX > this.noseMax) this.noseMax = noseX;
    const turning = mech.some((x) => Math.abs(x.vNut) > 0.5 && x.e > 0.05);
    if (turning && Math.abs(v) < 0.2 && !this.through) {
      this.stuckFor += dt;
      this.stuckTotal += dt;
      if (this.stuckFor > 3 && !this.stuckReported && !this.blocked) {
        this.stuckReported = true;
        this.events.push({ t, kind: "stall", text: `Stuck ${Math.round(noseX - this.noseStart)} mm in: the screws turn but thrust (${Math.round(f0)} N) does not beat the sand (${Math.round(rFwd)} N)` });
      }
    } else {
      this.stuckFor = 0;
      if (Math.abs(v) > 0.5) this.stuckReported = false;
    }
    if (v > 0.1) {
      this.moveTime += dt;
      this.moveDist += ds;
      for (const x of mech)
        if (x.e > 0.5 && x.s.face) {
          this.slipSum += clamp(this.slip.get(x.s.motor) ?? 0, -1, 1);
          this.slipN++;
        }
    }
    this.headingMax = Math.max(this.headingMax, Math.abs(this.psi * R2D));
    this.rollMax = Math.max(this.rollMax, Math.abs(this.roll));
    this.pitchMax = Math.max(this.pitchMax, Math.abs(this.theta * R2D));
    this.rates = [rho * R2D, (dTheta / dt) * R2D, (dPsi / dt) * R2D];
  }

  private maxFlight() {
    return Math.max(...this.front.map((s) => s.d), this.robot.body.d);
  }

  channels(): Record<string, number> {
    const nose = this.at(this.robot.nose);
    const out: Record<string, number> = {
      "pit.progress": nose[0] - this.noseStart,
      "pit.remaining": Math.max(0, this.pit.length - nose[0]),
      "pit.offset": nose[1],
      "pit.height": nose[2] - this.pit.axis,
      "pit.speed": this.v,
      "pit.heading": this.psi * R2D,
      "pit.pitch": this.theta * R2D,
      "pit.roll": this.roll,
      "pit.hinge": this.alpha * R2D,
      "pit.resist": this.resistF,
      "pit.thrust": this.thrustNet,
      "pit.roll_rate": this.rho * R2D,
      "pit.wall_push": this.contact,
      "pit.stress": this.sigmaV * 1000,
      "pit.push": this.pushF,
      "nose.x": nose[0],
      "nose.y": nose[1],
      "nose.z": nose[2],
    };
    for (const s of this.robot.screws) {
      out[`${s.motor}.thrust`] = this.thrust.get(s.motor) ?? 0;
      out[`${s.motor}.slip`] = (this.slip.get(s.motor) ?? 0) * 100;
      out[`${s.motor}.buried`] = (this.eng.get(s.motor) ?? 0) * 100;
      out[`${s.motor}.sand_torque`] = (this.torque.get(s.motor) ?? 0) / 1000;
    }
    const pose = (id: string, yaw: number) => {
      out[`${id}.px`] = this.px;
      out[`${id}.py`] = this.py;
      out[`${id}.pz`] = this.pz;
      out[`${id}.yaw`] = yaw * R2D;
      out[`${id}.pitch`] = this.theta * R2D;
      out[`${id}.roll`] = this.roll;
    };
    pose("rear", this.psi);
    pose("front", this.psi + this.alpha);
    return out;
  }

  finished(): boolean {
    return this.exitedAt !== undefined && Math.abs(this.v) < 0.05 && this.t - this.exitedAt > 2;
  }

  results(): Record<string, number | boolean | string> {
    const nose = this.at(this.robot.nose);
    const r: Record<string, number | boolean | string> = {
      reached: this.tReach !== undefined,
      through: this.through,
      out: this.exitedAt !== undefined,
      progress: this.noseMax - this.noseStart,
      remaining: Math.max(0, this.pit.length - this.noseMax),
      offset: Math.hypot(nose[1], nose[2] - this.pit.axis),
      heading_max: this.headingMax,
      heading_end: this.psi * R2D,
      roll_max: this.rollMax,
      pitch_max: this.pitchMax,
      speed: this.moveTime > 0 ? this.moveDist / this.moveTime : 0,
      slip: this.slipN ? this.slipSum / this.slipN : 0,
      side_wall: this.wallSide,
      floor: this.floorTouch,
      stuck_time: this.stuckTotal,
    };
    if ((this.pit.push ?? 0) > 0) {
      r.push_peak = this.pushPeak;
      r.push_distance = this.pushDist;
    }
    // how far off the line it arrived means something only once it arrived
    if (this.missAt) {
      r.miss = Math.hypot(this.missAt.y, this.missAt.z);
      r.miss_side = this.missAt.y;
      r.miss_height = this.missAt.z;
    }
    if (this.tReach !== undefined) r.time_to_wall = this.tReach;
    if (this.exitedAt !== undefined) r.time_out = this.exitedAt;
    return r;
  }

  scene(): SceneSpec {
    const L = this.pit.length;
    const half = this.pit.width / 2;
    const spin = (list: ScrewSpec[], tip: number, isFront: boolean) =>
      list.map((s) => ({ motor: s.motor, xmin: isFront ? s.from - 30 : Math.min(tip, s.from), xmax: isFront ? Math.max(tip, s.to) : s.to + 30, sign: s.turn }));
    const frontTip = this.robot.nose;
    const rearTip = this.robot.tail;
    return {
      kind: "sand_pit",
      box: { min: [0, -half, 0], max: [L, half, this.pit.depth], fill: "sand", fillTop: this.pit.depth, label: `Sand pit ${L / 1000} m long, ${this.pit.width / 1000} m wide, ${this.pit.depth / 1000} m deep` },
      floor: 0,
      bodies: [
        { id: "front", xmin: this.h, xmax: Infinity, origin: [this.h, 0, 0], spin: spin(this.front, frontTip, true) },
        { id: "rear", xmin: -Infinity, xmax: this.h, origin: [this.h, 0, 0], spin: spin(this.rear, rearTip, false) },
      ],
      target: this.pit.exitD > 0 ? { at: [L, 0, this.pit.axis], normal: [1, 0, 0], d: this.pit.exitD, label: "Exit opening" } : undefined,
      trail: { channelX: "nose.x", channelY: "nose.y", channelZ: "nose.z", d: Math.max(...this.robot.screws.map((s) => s.d)) },
      notes: [`Starts with the hinge ${Math.round(this.pit.start)} mm in from the near wall`],
    };
  }
}
