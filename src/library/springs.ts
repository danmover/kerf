// Coil springs, snap hooks and flexures by the book: spring wire grades and
// the formulas for rate, stress, buckling and fatigue (Shigley, Mechanical
// Engineering Design, ch. 10), and Bayer's cantilever snap-fit equations.
// Elastic constants come from the one material table; spring wire is drawn
// far harder than bar stock, so its strength by diameter lives here.

import type { FlexInfo, SpringInfo } from "../core/model";
import { materialRecord } from "./materialDb";

export interface WireGrade {
  label: string;
  /** material table entry for its density and elastic constants */
  material: string;
  /** ultimate tensile strength Sut = A / d^m, MPa with d in mm */
  A: number;
  m: number;
}

export const SPRING_WIRE: Record<string, WireGrade> = {
  music: { label: "music wire (ASTM A228)", material: "Steel", A: 2211, m: 0.145 },
  stainless: { label: "stainless spring wire (302, ASTM A313)", material: "Stainless 304", A: 1867, m: 0.146 },
  bronze: { label: "phosphor bronze wire (ASTM B159)", material: "Bronze", A: 1000, m: 0 },
};

/** The wire grade of a spring made of this material. */
export function wireGradeOf(material: string): WireGrade {
  if (/stainless/i.test(material)) return SPRING_WIRE.stainless;
  if (/bronze|brass|copper/i.test(material)) return SPRING_WIRE.bronze;
  return SPRING_WIRE.music;
}

/** Shear modulus, MPa. */
export function shearModulus(material: string): number {
  const m = materialRecord(material);
  const E = m?.mech.E ?? 200000;
  const nu = m?.mech.nu ?? 0.29;
  return E / (2 * (1 + nu));
}

/** Rate of a compression spring, N/mm: k = G d⁴ / (8 D³ n). */
export function springRate(s: { d: number; od: number; coils: number; material: string }): { k: number; D: number; C: number } {
  const D = s.od - s.d;
  return { k: (shearModulus(s.material) * s.d ** 4) / (8 * D ** 3 * s.coils), D, C: D / s.d };
}

export interface SpringResult {
  k: number;
  D: number;
  C: number;
  /** Bergsträsser curvature factor */
  Kb: number;
  Sut: number;
  /** torsional yield, about 0.45 Sut for cold-drawn wire not set-removed */
  Ssy: number;
  solid: number;
  preload: number;
  force: number;
  forceSolid: number;
  tauInstalled: number;
  tauWorking: number;
  tauSolid: number;
  /** free length over mean diameter, and the most it can be before it buckles between flat ends */
  slenderness: number;
  buckleAt: number;
  /** Goodman safety factor for cycling between installed and working length (Zimmerli, unpeened) */
  fatigue: number;
  /** first surge (wave) frequency with both ends fixed, Hz */
  surgeHz: number;
}

export function springCalc(s: SpringInfo, material: string): SpringResult {
  const grade = wireGradeOf(material);
  const { k, D, C } = springRate({ d: s.d, od: s.od, coils: s.coils, material });
  const Kb = (4 * C + 2) / (4 * C - 3);
  const Sut = grade.A / s.d ** grade.m;
  const Ssy = 0.45 * Sut;
  const total = s.coils + (s.ends === "plain" ? 0 : 2);
  const solid = s.d * (s.ends === "closed-ground" ? total : total + 1);
  const tau = (F: number) => (Kb * 8 * F * D) / (Math.PI * s.d ** 3);
  const preload = k * (s.free - s.installed);
  const force = k * (s.free - s.working);
  const forceSolid = k * Math.max(0, s.free - solid);
  // Goodman with Zimmerli's endurance data for unpeened spring wire: Ssa = 241, Ssm = 379 MPa
  const Ssu = 0.67 * Sut;
  const Sse = 241 / (1 - 379 / Ssu);
  const ta = tau((force - preload) / 2);
  const tm = tau((force + preload) / 2);
  const fatigue = ta + tm > 0 ? 1 / (ta / Sse + tm / Ssu) : Infinity;
  // f = d / (2π n D²) · √(G / 2ρ), in SI units
  const rho = (materialRecord(material)?.density ?? 7.85) * 1000;
  const surgeHz = ((s.d / 1000) / (2 * Math.PI * s.coils * (D / 1000) ** 2)) * Math.sqrt((shearModulus(material) * 1e6) / (2 * rho));
  return {
    k,
    D,
    C,
    Kb,
    Sut,
    Ssy,
    solid,
    preload,
    force,
    forceSolid,
    tauInstalled: tau(preload),
    tauWorking: tau(force),
    tauSolid: tau(forceSolid),
    slenderness: s.free / D,
    // ends pressed on parallel flat plates (α = 0.5): stable while L0 < 2.63 D / α
    buckleAt: 2.63 / 0.5,
    fatigue,
    surgeHz,
  };
}

/** Friction between plastics at a snap catch. */
export function snapFriction(material: string): number {
  return /POM|Nylon|PTFE/i.test(material) ? 0.2 : 0.3;
}

/**
 * Strain a plastic takes in a bending arm over its life: the table's value for a snap used a few times,
 * less for many cycles; rubbery plastics that make living hinges (PP, TPU, elongation over 100 %) keep it.
 */
export function strainLimit(material: string, cycles: number): number {
  const m = materialRecord(material);
  const base = m?.snapStrain ?? 0.02;
  if ((m?.mech.elongation ?? 0) >= 100) return cycles > 1e6 ? 0.8 * base : base;
  if (cycles <= 10) return base;
  if (cycles <= 1000) return 0.7 * base;
  if (cycles <= 1e5) return 0.5 * base;
  return 0.35 * base;
}

export interface FlexResult {
  E: number;
  /** strain at full travel (snap: passing the catch) */
  strain: number;
  limit: number;
  /** snap: force to bend it past the catch, to push it in, and to pull it apart (Infinity: it does not let go), N */
  bend?: number;
  push?: number;
  pull?: number;
  /** flexure: stiffness (N/mm for a blade, N·mm/rad for a hinge) and the force (N) or torque (N·mm) at full travel */
  stiffness?: number;
  load?: number;
  /** strain the arm holds once latched (from preload) */
  holdStrain: number;
}

export function flexCalc(f: FlexInfo, material: string, layersAcross: number): FlexResult {
  const E = materialRecord(material)?.mech.E ?? 2000;
  const limit = strainLimit(material, f.cycles ?? 10) * layersAcross;
  const I = (f.w * f.t ** 3) / 12;
  if (f.kind === "snap") {
    const strain = (1.5 * f.deflection * f.t) / f.length ** 2;
    // Bayer: deflection force P = (w t² / 6) E ε / L, mating force W = P (μ + tan α) / (1 − μ tan α)
    const bend = ((f.w * f.t ** 2) / 6) * ((E * strain) / f.length);
    const mu = snapFriction(material);
    const through = (deg: number) => {
      const t = Math.tan((deg * Math.PI) / 180);
      return mu * t >= 1 || deg >= 89.9 ? Infinity : (bend * (mu + t)) / (1 - mu * t);
    };
    return { E, strain, limit, bend, push: through(f.leadIn ?? 30), pull: through(f.retain ?? 90), holdStrain: (1.5 * (f.preload ?? 0) * f.t) / f.length ** 2 };
  }
  if (f.angle !== undefined) {
    const th = (f.angle * Math.PI) / 180;
    const stiffness = (E * I) / f.length;
    // PP and TPU hinges yield and orient on the first fold, then flex for millions of cycles far past any snap strain
    const hingeLimit = (materialRecord(material)?.mech.elongation ?? 0) >= 100 ? 0.5 * layersAcross : limit;
    return { E, strain: (f.t * th) / (2 * f.length), limit: hingeLimit, stiffness, load: stiffness * th, holdStrain: 0 };
  }
  const stiffness = (3 * E * I) / f.length ** 3;
  return { E, strain: (1.5 * f.t * f.deflection) / f.length ** 2, limit, stiffness, load: stiffness * f.deflection, holdStrain: (1.5 * f.t * (f.preload ?? 0)) / f.length ** 2 };
}
