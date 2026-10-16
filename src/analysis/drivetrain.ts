// Hand-calculation checks for a gear train under a stated duty: tooth
// bending (Lewis with a velocity factor), bearing rating life (L10) from the
// tooth forces split over each shaft's bearings, and shaft torsion. These are
// the textbook first-pass sizing methods, not a full AGMA/ISO rating: they
// leave out contact (pitting) stress, wear, heat build-up in plastic gears
// and misalignment.

import type { CheckItem } from "../core/checks";
import type { EvalPart, Model } from "../core/model";
import type { V3 } from "../kernel/recipe";
import { fmtNum } from "../lang/values";
import { allowableStress, mechMaterial } from "./materials";
import type { DrivetrainSpec } from "./spec";

export interface ToothResult {
  gear: string;
  label: string;
  z: number;
  material: string;
  /** Lewis form factor */
  Y: number;
  /** velocity factor */
  Kv: number;
  /** bending stress, MPa */
  stress: number;
  allowable: number;
  basis: "yield" | "fatigue";
  cycles: number;
  safety: number;
}

export interface MeshResult {
  driver: string;
  driven: string;
  /** tangential tooth force, N */
  force: number;
  /** pitch-line speed, m/s */
  speed: number;
  teeth: [ToothResult, ToothResult];
}

export interface BearingResult {
  id: string;
  label: string;
  code: string;
  /** radial load, N */
  load: number;
  rpm: number;
  /** basic rating life, hours (Infinity when unloaded or still) */
  life: number;
  rating: number;
}

export interface ShaftResult {
  gears: string[];
  d: number;
  /** N·mm */
  torque: number;
  /** MPa */
  shear: number;
  material: string;
  assumed: boolean;
  safety: number;
}

export interface DrivetrainResult {
  label: string;
  power: number;
  outputs: { name: string; rpm: number; torque: number }[];
  meshes: MeshResult[];
  bearings: BearingResult[];
  shafts: ShaftResult[];
  items: CheckItem[];
  warnings: string[];
  error?: string;
}

// Lewis form factor for 20° full-depth teeth (Shigley, table 14-2)
const LEWIS: [number, number][] = [
  [12, 0.245], [13, 0.261], [14, 0.277], [15, 0.29], [16, 0.296], [17, 0.303], [18, 0.309], [19, 0.314], [20, 0.322], [21, 0.328], [22, 0.331], [24, 0.337],
  [26, 0.346], [28, 0.353], [30, 0.359], [34, 0.371], [38, 0.384], [43, 0.397], [50, 0.409], [60, 0.422], [75, 0.435], [100, 0.447], [150, 0.46], [300, 0.472], [400, 0.48],
];

export function lewisY(z: number): number {
  if (z <= LEWIS[0][0]) return LEWIS[0][1] * (z / LEWIS[0][0]); // undercut pinions: below the table, scale down
  for (let i = 1; i < LEWIS.length; i++) {
    const [z1, y1] = LEWIS[i - 1];
    const [z2, y2] = LEWIS[i];
    if (z <= z2) return y1 + ((y2 - y1) * (z - z1)) / (z2 - z1);
  }
  return 0.485;
}

/** Barth velocity factor: rough printed or cast teeth vs. cut teeth. */
export function velocityFactor(v: number, printed: boolean): number {
  return printed ? (3.05 + v) / 3.05 : (6.1 + v) / 6.1;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const lineDist = (p: V3, o: V3, ax: V3) => {
  const d = sub(p, o);
  const s = dot(d, ax);
  return Math.hypot(d[0] - s * ax[0], d[1] - s * ax[1], d[2] - s * ax[2]);
};

export function runDrivetrain(model: Model, spec: DrivetrainSpec): DrivetrainResult {
  const out: DrivetrainResult = { label: spec.label, power: 0, outputs: [], meshes: [], bearings: [], shafts: [], items: [], warnings: [] };
  const id = (s: string) => `drive:${spec.label}:${s}`;
  const base = { category: "analysis" as const, basis: "calculation" as const, span: spec.span };
  const fail = (msg: string) => {
    out.error = msg;
    out.items.push({ ...base, id: id("setup"), status: "fail", title: `Drivetrain analysis: ${spec.label}`, detail: msg });
    return out;
  };
  const driver = model.parts.find((p) => p.name === spec.drive && p.motion) ?? model.parts.find((p) => p.name === spec.drive);
  if (!driver) return fail(`drive: "${spec.drive}" has no geometry in this design.`);
  if (!driver.motion || Math.abs(driver.motion.ratio) < 1e-12) return fail(`drive: "${spec.drive}" does not turn. Give it spin: 1 (or mesh:/turns_with:) so the train has a driver.`);
  const rd = Math.abs(driver.motion.ratio);
  const wIn = (spec.speed * 2 * Math.PI) / 60; // rad/s
  const P = spec.torque * wIn; // N·mm/s
  out.power = P / 1000; // W
  const rpmOf = (p: EvalPart) => (spec.speed * Math.abs(p.motion?.ratio ?? 0)) / rd;
  const torqueOf = (p: EvalPart) => {
    const r = Math.abs(p.motion?.ratio ?? 0);
    return r > 1e-12 ? (spec.torque * rd) / r : 0;
  };
  const hours = spec.life ?? 1000;
  if (spec.life === undefined) out.warnings.push("No life: given, so tooth fatigue assumes 1000 hours of running and bearing life is shown for information.");

  const gears = model.parts.filter((p) => p.gear && !p.id.includes("#"));
  const byName = new Map(gears.map((g) => [g.name, g]));
  const toothLoads = new Map<string, number[]>(); // gear id -> tooth force magnitudes (N)

  // ---------- tooth bending, mesh by mesh ----------
  for (const g of gears) {
    const gi = g.gear!;
    if (!gi.meshWith) continue;
    const other = byName.get(gi.meshWith);
    if (!other || !other.motion || !g.motion) continue;
    const go = other.gear!;
    const rOther = (go.m * go.z) / 2;
    const w = (rpmOf(other) * 2 * Math.PI) / 60;
    if (w < 1e-12) continue;
    const vPitch = w * rOther; // mm/s
    const Ft = P / vPitch; // N
    const V = vPitch / 1000;
    const width = Math.min(gi.width, go.width);
    const tooth = (p: EvalPart): ToothResult => {
      const gp = p.gear!;
      const mat = mechMaterial(p.material);
      const printed = mat.printedByDefault;
      const Kv = velocityFactor(V, printed);
      const Y = lewisY(gp.z);
      const stress = (Ft * Kv) / (width * gp.m * Y);
      const cycles = rpmOf(p) * 60 * hours;
      const al = allowableStress(mat, cycles);
      const allowable = printed ? al.value * mat.layerFactor : al.value;
      return { gear: p.name, label: p.label, z: gp.z, material: mat.name, Y, Kv, stress, allowable, basis: al.basis, cycles, safety: allowable / stress };
    };
    const mesh: MeshResult = { driver: other.name, driven: g.name, force: Ft, speed: V, teeth: [tooth(other), tooth(g)] };
    out.meshes.push(mesh);
    const Fn = Ft / Math.cos((gi.pa * Math.PI) / 180);
    for (const p of [g, other]) toothLoads.set(p.id, [...(toothLoads.get(p.id) ?? []), Fn]);
    for (const t of mesh.teeth) {
      const p = t.gear === g.name ? g : other;
      const status = t.safety >= spec.safety ? "pass" : t.safety >= 1 ? "warn" : "fail";
      out.items.push({
        ...base,
        id: id(`tooth:${t.gear}:${mesh.driver}-${mesh.driven}`),
        status,
        margin: t.safety - spec.safety,
        parts: [p.id],
        title: `Tooth bending: ${t.gear} (z${t.z}, ${t.material})`,
        detail:
          `${fmtNum(t.stress, 1)} MPa at the tooth root (Lewis, ${fmtNum(Ft, 1)} N tooth force at ${fmtNum(V, 2)} m/s, Kv ${fmtNum(t.Kv, 2)}). ` +
          `Allowable ${fmtNum(t.allowable, 1)} MPa (${t.basis === "fatigue" ? `fatigue at ${t.cycles.toExponential(1)} cycles` : "yield"}${mechMaterial(p.material).printedByDefault ? ", printed" : ""}): safety ${fmtNum(t.safety, 2)}, target ${fmtNum(spec.safety, 2)}.`,
      });
    }
  }
  if (!out.meshes.length) out.warnings.push("No meshing gear pairs are driven by this input, so no tooth loads were computed.");

  // ---------- shafts: gears and bearings sharing an axis line ----------
  const bearings = model.parts.filter((p) => p.bearing);
  type Shaft = { o: V3; ax: V3; gears: EvalPart[]; bearings: EvalPart[] };
  const shafts: Shaft[] = [];
  for (const g of gears) {
    if (!g.motion) continue;
    const gi = g.gear!;
    let s = shafts.find((sh) => Math.abs(Math.abs(dot(sh.ax, gi.axis)) - 1) < 1e-3 && lineDist(gi.center, sh.o, sh.ax) < 0.5);
    if (!s) {
      s = { o: gi.center, ax: gi.axis, gears: [], bearings: [] };
      shafts.push(s);
    }
    s.gears.push(g);
  }
  for (const b of bearings) {
    const bi = b.bearing!;
    const s = shafts.find((sh) => Math.abs(Math.abs(dot(sh.ax, bi.axis)) - 1) < 1e-3 && lineDist(bi.center, sh.o, sh.ax) < 0.5 + 0.1 * bi.bore);
    if (s) s.bearings.push(b);
  }
  shafts.forEach((s, si) => {
    const rpm = Math.max(...s.gears.map(rpmOf));
    const torque = Math.max(...s.gears.map(torqueOf));
    const names = s.gears.map((g) => g.name);
    // bearing loads by the lever rule between the outermost two bearings on the shaft
    const loads = s.gears.map((g) => ({ at: dot(g.gear!.center, s.ax) + (g.gear!.width / 2) * Math.sign(dot(g.gear!.axis, s.ax)), f: (toothLoads.get(g.id) ?? []).reduce((a, b) => a + b, 0) })).filter((l) => l.f > 0);
    if (loads.length && !s.bearings.length) {
      const dm = driver.motion!;
      const onInputShaft = s.gears.includes(driver) || (Math.abs(Math.abs(dot(dm.axis, s.ax)) - 1) < 1e-3 && lineDist(dm.origin, s.o, s.ax) < 0.5);
      // the input shaft is usually the motor's own, with bearings inside the motor
      if (!onInputShaft) out.warnings.push(`No bearings sit on the shaft of ${names.join(" and ")}, so its bearing loads were not checked.`);
    }
    if (loads.length && s.bearings.length) {
      const bs = s.bearings.map((b) => ({ b, at: dot(b.bearing!.center, s.ax) })).sort((a, b) => a.at - b.at);
      const lo = bs[0];
      const hi = bs[bs.length - 1];
      const share = new Map<string, number>();
      for (const l of loads) {
        if (bs.length === 1 || Math.abs(hi.at - lo.at) < 1e-6) share.set(lo.b.id, (share.get(lo.b.id) ?? 0) + l.f);
        else {
          const r2 = (l.f * (l.at - lo.at)) / (hi.at - lo.at);
          const r1 = l.f - r2;
          share.set(lo.b.id, (share.get(lo.b.id) ?? 0) + Math.abs(r1));
          share.set(hi.b.id, (share.get(hi.b.id) ?? 0) + Math.abs(r2));
        }
      }
      for (const { b } of bs) {
        const load = share.get(b.id) ?? 0;
        const C = b.bearing!.dynamicLoadN;
        const life = load > 1e-9 && rpm > 1e-9 ? (Math.pow(C / load, 3) * 1e6) / (60 * rpm) : Infinity;
        out.bearings.push({ id: b.id, label: b.label, code: b.bearing!.code, load, rpm, life, rating: C });
        const need = spec.life;
        const status = need === undefined ? "info" : life >= need ? "pass" : life >= 0.5 * need ? "warn" : "fail";
        out.items.push({
          ...base,
          id: id(`bearing:${b.id}`),
          status,
          margin: need !== undefined && Number.isFinite(life) ? life / need - 1 : undefined,
          parts: [b.id],
          title: `Bearing life: ${b.label}`,
          detail:
            load > 1e-9
              ? `${fmtNum(load, 1)} N radial at ${fmtNum(rpm, 0)} rpm against a ${C} N rating: L10 life ${fmtLife(life)}${need !== undefined ? `, target ${fmtLife(need)}` : ""}.`
              : "Carries no gear load in this train.",
        });
      }
    }
    // shaft torsion through the smallest gear bore on it
    const bores = s.gears.map((g) => g.gear!.bore ?? 0).filter((d) => d > 0);
    if (torque > 0 && bores.length) {
      const d = Math.min(...bores);
      const shaftPart = model.parts.find((p) => p.kind === "part" && p.motion && Math.abs(Math.abs(dot(p.motion.axis, s.ax)) - 1) < 1e-3 && lineDist(p.motion.origin, s.o, s.ax) < 0.5);
      const assumed = !shaftPart;
      const mat = mechMaterial(shaftPart?.material ?? "Steel");
      const shear = (16 * torque) / (Math.PI * d ** 3);
      const allowShear = 0.577 * allowableStress(mat, rpm * 60 * hours).value;
      const safety = allowShear / shear;
      out.shafts.push({ gears: names, d, torque, shear, material: mat.name, assumed, safety });
      out.items.push({
        ...base,
        id: id(`shaft:${si}`),
        status: safety >= spec.safety ? "pass" : safety >= 1 ? "warn" : "fail",
        margin: safety - spec.safety,
        parts: shaftPart ? [shaftPart.id, ...s.gears.map((g) => g.id)] : s.gears.map((g) => g.id),
        title: `Shaft torsion: ⌀${fmtNum(d)} mm through ${names.join(", ")}`,
        detail: `${fmtNum(torque / 1000, 3)} N·m gives ${fmtNum(shear, 1)} MPa shear in a ${mat.name}${assumed ? " (assumed)" : ""} shaft: safety ${fmtNum(safety, 2)}, target ${fmtNum(spec.safety, 2)}.`,
      });
    }
  });

  // output speeds and torques: the slowest gears
  const moving = gears.filter((g) => g.motion && Math.abs(g.motion.ratio) > 1e-12);
  const slowest = Math.min(...moving.map((g) => Math.abs(g.motion!.ratio)));
  for (const g of moving) if (Math.abs(Math.abs(g.motion!.ratio) - slowest) < 1e-9) out.outputs.push({ name: g.name, rpm: rpmOf(g), torque: torqueOf(g) });
  out.items.push({
    ...base,
    id: id("duty"),
    status: "info",
    title: `Duty: ${spec.label}`,
    detail:
      `${fmtNum(spec.torque / 1000, 3)} N·m at ${fmtNum(spec.speed, 0)} rpm in (${fmtNum(out.power, 1)} W)` +
      (out.outputs.length ? `; ${out.outputs.map((o) => `${o.name} turns at ${fmtNum(o.rpm, 1)} rpm with ${fmtNum(o.torque / 1000, 2)} N·m`).join(", ")} (no friction losses counted)` : "") +
      ". Lewis bending and L10 life are first-pass sizing methods: they do not cover tooth wear, pitting or heat in plastic gears, so run a prototype at full load.",
  });
  out.warnings.forEach((w, i) => out.items.push({ ...base, id: id(`note:${i}`), status: "info", title: `Note: ${spec.label}`, detail: w }));
  return out;
}

function fmtLife(h: number): string {
  if (!Number.isFinite(h)) return "unlimited";
  if (h >= 1e6) return `${(h / 1e6).toFixed(1)} million h`;
  if (h >= 1e4) return `${fmtNum(h / 1000, 0)}k h`;
  return `${fmtNum(h, 0)} h`;
}
