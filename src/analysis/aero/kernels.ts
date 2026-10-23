// WGSL for the airflow solver on the GPU. The step kernel is the CPU
// reference (cpu.ts) line for line: pull streaming, Bouzidi bounce-back with
// moving walls, the log-law wall model, regularised BGK with a Smagorinsky
// eddy viscosity, the sponge, sub-grid drag and momentum-exchange forces.
//
// Populations are stored shifted (f − w) in one of two formats:
// - half: two cells' values of one direction packed into a u32 as 16-bit
//   floats (rounded to nearest even by hand, since pack2x16float's rounding
//   is not pinned down), so each thread updates a pair of cells along x;
// - full: one f32 per cell and direction.
// Directions 0..9 live in one buffer and 10..18 in another, so no single
// binding has to hold the whole lattice.

import { CX, CY, CZ, OPP, W, FARFIELD, KAPPA, SGS_FLOOR, SGS_STRAIN, SLIP_GAIN, SLIP_RATE, SOLID, SUBGRID_CD, VAN_DRIEST, WW_A, WW_B, WW_YPLUS } from "./lattice";

/** most parts (bodies, wheels, the road) one case can hold */
export const MAX_PARTS = 255;
/** u32 words per boundary record: q (9), normal xy (1), normal z + distance (1), part + sub-grid fill (1) */
export const REC_WORDS = 12;
/** floats per record in the output: instantaneous force (3), spare (1), the REC_AVG sums (8), the wall model's slip (3), spare (1) */
export const REC_OUT = 16;
export const WORKGROUP = 128;

// mode bits in the uniform block
export const MODE_PX = 1;
export const MODE_PY = 2;
export const MODE_PZ = 4;
export const MODE_WALL = 8;
export const MODE_AVERAGE = 16;

const arr = (t: string, v: readonly number[]) => `array<${t}, ${v.length}>(${v.map((x) => (t === "f32" ? x.toPrecision(9) : String(x))).join(", ")})`;

export const PARAMS_WGSL = /* wgsl */ `
struct Params {
  nx: u32, ny: u32, nz: u32, NP: u32,
  mode: u32, nParts: u32, nRec: u32, coarse: u32,
  tau0: f32, cs18: f32, spongeX: f32, spongeTau: f32,
  u: vec4<f32>,
  cdims: vec4<u32>,
  motion: array<vec4<f32>, ${3 * MAX_PARTS + 3}>,
  partStart: array<vec4<u32>, ${Math.ceil((MAX_PARTS + 2) / 4)}>,
}
`;

/** Byte size of the uniform block (Params above). */
export const PARAMS_BYTES = 16 * 5 + 16 * (3 * MAX_PARTS + 3) + 16 * Math.ceil((MAX_PARTS + 2) / 4);

const COMMON = (half: boolean) => /* wgsl */ `
${PARAMS_WGSL}
const CX = ${arr("i32", CX)};
const CY = ${arr("i32", CY)};
const CZ = ${arr("i32", CZ)};
const WQ = ${arr("f32", W)};
const OPP = ${arr("u32", OPP)};
const SOLID = ${SOLID}u;
const FARFIELD = ${FARFIELD}u;

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> fA0: array<${half ? "u32" : "f32"}>;
@group(0) @binding(2) var<storage, read> fA1: array<${half ? "u32" : "f32"}>;

fn ld(i: u32, s: u32) -> f32 {
${
  half
    ? `  let p = s >> 1u;
  var w: u32;
  if (i < 10u) { w = fA0[i * P.NP + p]; } else { w = fA1[(i - 10u) * P.NP + p]; }
  let v = unpack2x16float(w);
  return select(v.x, v.y, (s & 1u) == 1u);`
    : `  if (i < 10u) { return fA0[i * P.NP + s]; }
  return fA1[(i - 10u) * P.NP + s];`
}
}

fn ci(i: u32) -> vec3<f32> { return vec3<f32>(f32(CX[i]), f32(CY[i]), f32(CZ[i])); }
`;

const F2H = /* wgsl */ `
// f32 to IEEE half, rounded to nearest even
fn f2h(x: f32) -> u32 {
  let b = bitcast<u32>(x);
  let s = (b >> 16u) & 0x8000u;
  let e = i32((b >> 23u) & 0xffu) - 112;
  let m = b & 0x7fffffu;
  if (e <= 0) {
    if (e < -10) { return s; }
    let mm = m | 0x800000u;
    let sh = u32(14 - e);
    var r = mm >> sh;
    let rem = mm & ((1u << sh) - 1u);
    let hlf = 1u << (sh - 1u);
    if (rem > hlf || (rem == hlf && (r & 1u) == 1u)) { r = r + 1u; }
    return s | r;
  }
  if (e >= 31) { return s | 0x7c00u; }
  var r = (u32(e) << 10u) | (m >> 13u);
  let rem = m & 0x1fffu;
  if (rem > 0x1000u || (rem == 0x1000u && (r & 1u) == 1u)) { r = r + 1u; }
  return s | r;
}
`;

/** The step kernel: lattice A (bindings 1, 2) into lattice B (3, 4). */
export function stepKernel(half: boolean): string {
  return /* wgsl */ `
${COMMON(half)}
${F2H}
@group(0) @binding(3) var<storage, read_write> fB0: array<${half ? "u32" : "f32"}>;
@group(0) @binding(4) var<storage, read_write> fB1: array<${half ? "u32" : "f32"}>;
@group(0) @binding(5) var<storage, read> flags: array<u32>;
@group(0) @binding(6) var<storage, read> recs: array<u32>;
@group(0) @binding(7) var<storage, read_write> recOut: array<f32>;
@group(0) @binding(8) var<storage, read> farTab: array<vec4<f32>>;

fn src(x: i32, y: i32, z: i32) -> u32 {
  let nx = i32(P.nx);
  let ny = i32(P.ny);
  let nz = i32(P.nz);
  var X = x;
  var Y = y;
  var Z = z;
  if ((P.mode & ${MODE_PX}u) != 0u) { X = (X + nx) % nx; } else { X = clamp(X, 0, nx - 1); }
  if ((P.mode & ${MODE_PY}u) != 0u) { Y = (Y + ny) % ny; } else { Y = clamp(Y, 0, ny - 1); }
  if ((P.mode & ${MODE_PZ}u) != 0u) { Z = (Z + nz) % nz; } else { Z = clamp(Z, 0, nz - 1); }
  return u32(X + nx * (Y + ny * Z));
}

fn motionAt(part: u32, p: vec3<f32>) -> vec3<f32> {
  let c = P.motion[3u * part].xyz;
  let w = P.motion[3u * part + 1u].xyz;
  let v = P.motion[3u * part + 2u].xyz;
  return v + cross(w, p - c);
}

fn recQ(rb: u32, i: u32) -> f32 {
  let v = unpack2x16float(recs[rb + (i - 1u) / 2u]);
  return select(v.x, v.y, ((i - 1u) & 1u) == 1u);
}

fn bounce(n: u32, i: u32, q: f32, x: i32, y: i32, z: i32, uw: vec3<f32>) -> f32 {
  let io = OPP[i];
  let a = ld(io, n);
  let du = 6.0 * WQ[i] * dot(ci(i), uw);
  if (q < 0.5) {
    let s = src(x + CX[i], y + CY[i], z + CZ[i]);
    if ((flags[s] & 15u) == SOLID) { return a + du; }
    return 2.0 * q * a + (1.0 - 2.0 * q) * ld(io, s) + du;
  }
  return (a + (2.0 * q - 1.0) * ld(i, n) + du) / (2.0 * q);
}

fn equilibrium(drho: f32, rho: f32, u: vec3<f32>, fe: ptr<function, array<f32, 19>>) {
  let base = drho - rho * 1.5 * dot(u, u);
  (*fe)[0] = WQ[0] * base;
  for (var i = 1u; i < 19u; i++) {
    let cu = dot(ci(i), u);
    (*fe)[i] = WQ[i] * (base + rho * (3.0 * cu + 4.5 * cu * cu));
  }
}

// equilibrium into fe, regularised non-equilibrium into fn, and the relaxation time with the eddy viscosity
fn relaxation(f: ptr<function, array<f32, 19>>, fe: ptr<function, array<f32, 19>>, fq: ptr<function, array<f32, 19>>, drho: f32, rho: f32, u: vec3<f32>, t0: f32, sensed: bool) -> f32 {
  let base = drho - rho * 1.5 * dot(u, u);
  let r45 = 4.5 * rho;
  let r3 = 3.0 * rho;
  (*fe)[0] = base / 3.0;
  var s: array<f32, 9>;
  var a = array<f32, 9>(u.x, u.y, u.z, u.x + u.y, u.x + u.z, u.y + u.z, u.x - u.y, u.x - u.z, u.y - u.z);
  for (var k = 0u; k < 9u; k++) {
    let i = 2u * k + 1u;
    let w = WQ[i];
    let sym = w * (base + r45 * a[k] * a[k]);
    let asym = w * r3 * a[k];
    (*fe)[i] = sym + asym;
    (*fe)[i + 1u] = sym - asym;
    s[k] = (*f)[i] - (*fe)[i] + (*f)[i + 1u] - (*fe)[i + 1u];
  }
  let pxx = s[0] + s[3] + s[4] + s[6] + s[7];
  let pyy = s[1] + s[3] + s[5] + s[6] + s[8];
  let pzz = s[2] + s[4] + s[5] + s[7] + s[8];
  let pxy = s[3] - s[6];
  let pxz = s[4] - s[7];
  let pyz = s[5] - s[8];
  let tr = (pxx + pyy + pzz) / 3.0;
  let a1 = 4.5 / 18.0;
  let a2 = 4.5 / 36.0;
  (*fq)[0] = -1.5 * tr;
  (*fq)[1] = a1 * (pxx - tr); (*fq)[2] = (*fq)[1];
  (*fq)[3] = a1 * (pyy - tr); (*fq)[4] = (*fq)[3];
  (*fq)[5] = a1 * (pzz - tr); (*fq)[6] = (*fq)[5];
  (*fq)[7] = a2 * (pxx + pyy + 2.0 * pxy - tr); (*fq)[8] = (*fq)[7];
  (*fq)[9] = a2 * (pxx + pzz + 2.0 * pxz - tr); (*fq)[10] = (*fq)[9];
  (*fq)[11] = a2 * (pyy + pzz + 2.0 * pyz - tr); (*fq)[12] = (*fq)[11];
  (*fq)[13] = a2 * (pxx + pyy - 2.0 * pxy - tr); (*fq)[14] = (*fq)[13];
  (*fq)[15] = a2 * (pxx + pzz - 2.0 * pxz - tr); (*fq)[16] = (*fq)[15];
  (*fq)[17] = a2 * (pyy + pzz - 2.0 * pyz - tr); (*fq)[18] = (*fq)[17];
  let PP = sqrt(2.0 * (pxx * pxx + pyy * pyy + pzz * pzz + 2.0 * (pxy * pxy + pxz * pxz + pyz * pyz)));
  // away from walls: how three-dimensional the strain is, none in a laminar shear
  let dx = pxx - tr;
  let dy = pyy - tr;
  let dz = pzz - tr;
  let q = 0.5 * (dx * dx + dy * dy + dz * dz + 2.0 * (pxy * pxy + pxz * pxz + pyz * pyz));
  var sgs = P.cs18;
  if (sensed && q > 1e-30) {
    let det = dx * (dy * dz - pyz * pyz) - pxy * (pxy * dz - pyz * pxz) + pxz * (pxy * pyz - dy * pxz);
    sgs *= clamp(det / (q * sqrt(q)) / ${SGS_STRAIN}, ${SGS_FLOOR}, 1.0);
  }
  return 0.5 * (t0 + sqrt(t0 * t0 + sgs * PP / rho));
}

fn frictionVelocity(ut: f32, d: f32, nu: f32) -> f32 {
  let lin = sqrt(nu * ut / d);
  if (d * lin / nu <= ${WW_YPLUS}) { return lin; }
  return pow(ut / (${WW_A} * pow(d / nu, ${WW_B.toPrecision(9)})), ${(1 / (1 + WW_B)).toPrecision(9)});
}

fn moments(f: ptr<function, array<f32, 19>>) -> vec4<f32> {
  var d = 0.0;
  var j = vec3<f32>(0.0);
  for (var i = 0u; i < 19u; i++) {
    d += (*f)[i];
    j += ci(i) * (*f)[i];
  }
  return vec4<f32>(j / (1.0 + d), d);
}

fn farfield(fl: u32) -> array<f32, 19> {
  var fe: array<f32, 19>;
  let e = fl >> 8u;
  if (e > 0u) {
    let v = farTab[e - 1u];
    equilibrium(v.w, 1.0 + v.w, v.xyz, &fe);
  } else {
    equilibrium(0.0, 1.0, P.u.xyz, &fe);
  }
  return fe;
}

fn cell(n: u32) -> array<f32, 19> {
  var out: array<f32, 19>;
  let fl = flags[n];
  let ty = fl & 15u;
  if (ty == SOLID) { return out; }
  if (ty == FARFIELD) { return farfield(fl); }
  let nx = P.nx;
  let ny = P.ny;
  let x = i32(n % nx);
  let y = i32((n / nx) % ny);
  let z = i32(n / (nx * ny));
  let r = i32(fl >> 8u) - 1;
  let inside = x > 0 && x < i32(nx) - 1 && y > 0 && y < i32(ny) - 1 && z > 0 && z < i32(P.nz) - 1;
  var f: array<f32, 19>;
  var wallMask = 0u;
  var wsolid: array<u32, 19>;
  for (var i = 0u; i < 19u; i++) {
    var s: u32;
    if (inside) { s = u32(i32(n) - (CX[i] + i32(nx) * (CY[i] + i32(ny) * CZ[i]))); }
    else { s = src(x - CX[i], y - CY[i], z - CZ[i]); }
    if (r >= 0) {
      let sf = flags[s];
      if ((sf & 15u) == SOLID) {
        wallMask |= 1u << i;
        wsolid[i] = sf >> 8u;
        continue;
      }
    }
    f[i] = ld(i, s);
  }
  let rb = u32(max(r, 0)) * ${REC_WORDS}u;
  var wq: array<f32, 19>;
  var uw: array<vec3<f32>, 19>;
  let pos = vec3<f32>(f32(x), f32(y), f32(z));
  if (wallMask != 0u) {
    for (var i = 1u; i < 19u; i++) {
      if ((wallMask & (1u << i)) == 0u) { continue; }
      var q = recQ(rb, i);
      if (!(q > 0.0)) { q = 0.5; }
      wq[i] = q;
      let u = motionAt(wsolid[i], pos - q * ci(i));
      uw[i] = u;
      f[i] = bounce(n, i, q, x, y, z, u);
    }
  }
  var m = moments(&f);
  var drho = m.w;
  var rho = 1.0 + drho;
  var u = m.xyz;
  var t0 = P.tau0;
  if ((P.mode & ${MODE_PX}u) == 0u && f32(x) > P.spongeX) {
    let sp = (f32(x) - P.spongeX) / max(1.0, f32(nx) - 1.0 - P.spongeX);
    t0 = P.tau0 + (P.spongeTau - P.tau0) * sp * sp;
  }
  var fe: array<f32, 19>;
  var fq: array<f32, 19>;
  var tau = relaxation(&f, &fe, &fq, drho, rho, u, t0, wallMask == 0u);
  var part = 0u;
  var phi = 0.0;
  if (r >= 0) {
    let pw = recs[rb + 11u];
    part = pw & 0xffffu;
    phi = unpack2x16float(pw).y;
  }
  // wall model: slip the wall so it passes on the log-law shear stress
  if (wallMask != 0u && (P.mode & ${MODE_WALL}u) != 0u) {
    let nxy = unpack2x16float(recs[rb + 9u]);
    let nzd = unpack2x16float(recs[rb + 10u]);
    let d = nzd.y;
    if (d > 0.0) {
      let nw = vec3<f32>(nxy.x, nxy.y, nzd.x);
      let b = motionAt(part, pos - d * nw);
      let v = u - b;
      let t = v - dot(v, nw) * nw;
      let ut = length(t);
      if (ut > 1e-9) {
        let nu0 = (P.tau0 - 0.5) / 3.0;
        let utau = frictionVelocity(ut, d, nu0);
        let dv = 1.0 - exp(-d * utau / nu0 / ${VAN_DRIEST.toFixed(1)});
        let tw = 0.5 + 3.0 * (nu0 + ${KAPPA} * utau * d * dv * dv);
        t0 = max(t0, tw);
        let nue = (max(tau, t0) - 0.5) / 3.0;
        let slip = max(0.0, ut - utau * utau * d / nue) / ut;
        // the slip follows its target over a few steps (see cpu.ts)
        let so = u32(r) * ${REC_OUT}u + 12u;
        var sv = vec3<f32>(recOut[so], recOut[so + 1u], recOut[so + 2u]);
        sv += ${SLIP_RATE} * (t * slip - sv);
        recOut[so] = sv.x;
        recOut[so + 1u] = sv.y;
        recOut[so + 2u] = sv.z;
        // scaled back to a flat wall's push where many wall links would let it outrun the flow (see SLIP_GAIN)
        let s2 = dot(sv, sv);
        var gain = 0.0;
        for (var i = 1u; i < 19u; i++) {
          if ((wallMask & (1u << i)) == 0u) { continue; }
          let cs = dot(ci(i), sv);
          gain += 6.0 * WQ[i] * cs * cs / select(2.0 * wq[i], 1.0, wq[i] < 0.5);
        }
        let back = select(1.0, ${SLIP_GAIN} * s2 / gain, s2 > 0.0 && gain > ${SLIP_GAIN} * s2);
        for (var i = 1u; i < 19u; i++) {
          if ((wallMask & (1u << i)) == 0u) { continue; }
          let k = select(1.0 / (2.0 * wq[i]), 1.0, wq[i] < 0.5) * back;
          f[i] += 6.0 * WQ[i] * dot(ci(i), sv) * k;
        }
        m = moments(&f);
        drho = m.w;
        rho = 1.0 + drho;
        u = m.xyz;
        tau = relaxation(&f, &fe, &fq, drho, rho, u, t0, false);
      }
    }
  }
  // force on the body: momentum exchange over the wall links
  var F = vec3<f32>(0.0);
  if (wallMask != 0u) {
    for (var i = 1u; i < 19u; i++) {
      if ((wallMask & (1u << i)) == 0u) { continue; }
      let a = ld(OPP[i], n);
      F -= ci(i) * (a + f[i]) + uw[i] * (a - f[i]);
    }
  }
  let keep = 1.0 - 1.0 / tau;
  // geometry thinner than a cell: quadratic drag, solved implicitly
  var g = u;
  if (r >= 0 && wallMask == 0u && phi > 0.0) {
    let b = motionAt(part, pos);
    let K = ${SUBGRID_CD.toPrecision(6)} * sqrt(phi / 3.14159265);
    let v = u - b;
    g = b + v / (1.0 + K * length(v));
    F += rho * (u - g);
    equilibrium(drho, rho, g, &fe);
  }
  for (var i = 0u; i < 19u; i++) { out[i] = fe[i] + keep * fq[i]; }
  if (r >= 0) {
    let o = u32(r) * ${REC_OUT}u;
    recOut[o] = F.x;
    recOut[o + 1u] = F.y;
    recOut[o + 2u] = F.z;
    if ((P.mode & ${MODE_AVERAGE}u) != 0u) {
      recOut[o + 4u] += F.x;
      recOut[o + 5u] += F.y;
      recOut[o + 6u] += F.z;
      recOut[o + 7u] += drho;
      recOut[o + 8u] += u.x;
      recOut[o + 9u] += u.y;
      recOut[o + 10u] += u.z;
    }
  }
  return out;
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let t = gid.x + gid.y * nwg.x * ${WORKGROUP}u;
  if (t >= P.NP) { return; }
${
  half
    ? `  let a = cell(2u * t);
  let b = cell(2u * t + 1u);
  for (var i = 0u; i < 19u; i++) {
    let w = f2h(a[i]) | (f2h(b[i]) << 16u);
    if (i < 10u) { fB0[i * P.NP + t] = w; } else { fB1[(i - 10u) * P.NP + t] = w; }
  }`
    : `  let a = cell(t);
  for (var i = 0u; i < 19u; i++) {
    if (i < 10u) { fB0[i * P.NP + t] = a[i]; } else { fB1[(i - 10u) * P.NP + t] = a[i]; }
  }`
}
}
`;
}

/**
 * Sets every cell to the equilibrium of the free stream, or of a start field interpolated from a coarser run (solid
 * cells to zero): lattice A only, written through bindings 3 and 4. Binding 7 says where the start field sits
 * (dims.w = 1 when there is one; off.xyz the offset, off.w the scale, as in case.ts).
 */
export function initKernel(half: boolean): string {
  return /* wgsl */ `
${PARAMS_WGSL}
${F2H}
const WQ = ${arr("f32", W)};
const CX = ${arr("i32", CX)};
const CY = ${arr("i32", CY)};
const CZ = ${arr("i32", CZ)};
struct Start { dims: vec4<u32>, off: vec4<f32> }
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read_write> fB0: array<${half ? "u32" : "f32"}>;
@group(0) @binding(4) var<storage, read_write> fB1: array<${half ? "u32" : "f32"}>;
@group(0) @binding(5) var<storage, read> flags: array<u32>;
@group(0) @binding(6) var<storage, read> startData: array<vec4<f32>>;
@group(0) @binding(7) var<uniform> S: Start;

fn startNode(x: u32, y: u32, z: u32) -> vec4<f32> {
  return startData[x + S.dims.x * (y + S.dims.y * z)];
}

// velocity and density change the cell starts at
fn state(n: u32) -> vec4<f32> {
  if (S.dims.w == 0u) { return vec4<f32>(P.u.xyz, 0.0); }
  let x = n % P.nx;
  let y = (n / P.nx) % P.ny;
  let z = n / (P.nx * P.ny);
  let hi = vec3<f32>(S.dims.xyz) - 1.0;
  let t = clamp(S.off.xyz + S.off.w * vec3<f32>(f32(x), f32(y), f32(z)), vec3<f32>(0.0), hi);
  let lo = min(floor(t), max(hi - 1.0, vec3<f32>(0.0)));
  let fr = t - lo;
  let a = vec3<u32>(lo);
  let b = min(a + 1u, S.dims.xyz - 1u);
  let c00 = mix(startNode(a.x, a.y, a.z), startNode(b.x, a.y, a.z), fr.x);
  let c10 = mix(startNode(a.x, b.y, a.z), startNode(b.x, b.y, a.z), fr.x);
  let c01 = mix(startNode(a.x, a.y, b.z), startNode(b.x, a.y, b.z), fr.x);
  let c11 = mix(startNode(a.x, b.y, b.z), startNode(b.x, b.y, b.z), fr.x);
  return mix(mix(c00, c10, fr.y), mix(c01, c11, fr.y), fr.z);
}

fn feq(i: u32, n: u32, s: vec4<f32>) -> f32 {
  if ((flags[n] & 15u) == ${SOLID}u) { return 0.0; }
  let u = s.xyz;
  let rho = 1.0 + s.w;
  let cu = f32(CX[i]) * u.x + f32(CY[i]) * u.y + f32(CZ[i]) * u.z;
  return WQ[i] * (s.w + rho * (3.0 * cu + 4.5 * cu * cu - 1.5 * dot(u, u)));
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let t = gid.x + gid.y * nwg.x * ${WORKGROUP}u;
  if (t >= P.NP) { return; }
${
  half
    ? `  let sa = state(2u * t);
  let sb = state(2u * t + 1u);
  for (var i = 0u; i < 19u; i++) {
    let w = f2h(feq(i, 2u * t, sa)) | (f2h(feq(i, 2u * t + 1u, sb)) << 16u);
    if (i < 10u) { fB0[i * P.NP + t] = w; } else { fB1[(i - 10u) * P.NP + t] = w; }`
    : `  let sa = state(t);
  for (var i = 0u; i < 19u; i++) {
    let v = feq(i, t, sa);
    if (i < 10u) { fB0[i * P.NP + t] = v; } else { fB1[(i - 10u) * P.NP + t] = v; }`
}
  }
}
`;
}

/** Zeroes the averaged sums of every record, keeping the wall model's slip. */
export const CLEAR_SUMS_KERNEL = /* wgsl */ `
${PARAMS_WGSL}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> recOut: array<f32>;
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let r = gid.x + gid.y * nwg.x * ${WORKGROUP}u;
  if (r >= P.nRec) { return; }
  for (var k = 4u; k < 12u; k++) { recOut[r * ${REC_OUT}u + k] = 0.0; }
}
`;

/** Sums each part's record forces (one workgroup per part). */
export const REDUCE_KERNEL = /* wgsl */ `
${PARAMS_WGSL}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> recOut: array<f32>;
@group(0) @binding(2) var<storage, read_write> partF: array<f32>;
var<workgroup> sx: array<f32, ${WORKGROUP}>;
var<workgroup> sy: array<f32, ${WORKGROUP}>;
var<workgroup> sz: array<f32, ${WORKGROUP}>;

fn start(k: u32) -> u32 { return P.partStart[k / 4u][k % 4u]; }

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let part = wg.x;
  let a = start(part);
  let b = start(part + 1u);
  var f = vec3<f32>(0.0);
  for (var r = a + li; r < b; r += ${WORKGROUP}u) {
    let o = r * ${REC_OUT}u;
    f += vec3<f32>(recOut[o], recOut[o + 1u], recOut[o + 2u]);
  }
  sx[li] = f.x;
  sy[li] = f.y;
  sz[li] = f.z;
  workgroupBarrier();
  for (var s = ${WORKGROUP / 2}u; s > 0u; s >>= 1u) {
    if (li < s) {
      sx[li] += sx[li + s];
      sy[li] += sy[li + s];
      sz[li] += sz[li + s];
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    partF[4u * part] = sx[0];
    partF[4u * part + 1u] = sy[0];
    partF[4u * part + 2u] = sz[0];
  }
}
`;

/**
 * Adds the current flow to the averaged field, one coarse cell (coarse³ fine cells) per thread: mean velocity,
 * density change, |u|² and a sample count (FIELD_AVG floats). With snapshot set it overwrites instead.
 */
export function fieldKernel(half: boolean): string {
  return /* wgsl */ `
${COMMON(half)}
@group(0) @binding(5) var<storage, read> flags: array<u32>;
@group(0) @binding(6) var<storage, read_write> field: array<f32>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let t = gid.x + gid.y * nwg.x * ${WORKGROUP}u;
  let cd = P.cdims;
  if (t >= cd.x * cd.y * cd.z) { return; }
  let X = t % cd.x;
  let Y = (t / cd.x) % cd.y;
  let Z = t / (cd.x * cd.y);
  let k = P.coarse;
  var cnt = 0.0;
  var su = vec3<f32>(0.0);
  var sr = 0.0;
  var sq = 0.0;
  for (var dz = 0u; dz < k; dz++) {
    for (var dy = 0u; dy < k; dy++) {
      for (var dx = 0u; dx < k; dx++) {
        let x = X * k + dx;
        let y = Y * k + dy;
        let z = Z * k + dz;
        if (x >= P.nx || y >= P.ny || z >= P.nz) { continue; }
        let n = x + P.nx * (y + P.ny * z);
        if ((flags[n] & 15u) == SOLID) { continue; }
        var d = 0.0;
        var j = vec3<f32>(0.0);
        for (var i = 0u; i < 19u; i++) {
          let v = ld(i, n);
          d += v;
          j += ci(i) * v;
        }
        let u = j / (1.0 + d);
        cnt += 1.0;
        su += u;
        sr += d;
        sq += dot(u, u);
      }
    }
  }
  if (cnt == 0.0) { return; }
  let o = t * 8u;
  if ((P.mode & ${MODE_AVERAGE}u) != 0u) {
    field[o] += su.x / cnt;
    field[o + 1u] += su.y / cnt;
    field[o + 2u] += su.z / cnt;
    field[o + 3u] += sr / cnt;
    field[o + 4u] += sq / cnt;
    field[o + 5u] += 1.0;
  } else {
    field[o] = su.x / cnt;
    field[o + 1u] = su.y / cnt;
    field[o + 2u] = su.z / cnt;
    field[o + 3u] = sr / cnt;
    field[o + 4u] = sq / cnt;
    field[o + 5u] = 1.0;
  }
}
`;
}

/** Speed as a share of the free stream on the plane y = S.y, one thread per cell of it (−1 in solids): the live view. */
export function sliceKernel(half: boolean): string {
  return /* wgsl */ `
${COMMON(half)}
struct Slice { y: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(5) var<storage, read> flags: array<u32>;
@group(0) @binding(6) var<storage, read_write> out: array<f32>;
@group(0) @binding(7) var<uniform> S: Slice;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let t = gid.x + gid.y * nwg.x * ${WORKGROUP}u;
  if (t >= P.nx * P.nz) { return; }
  let n = t % P.nx + P.nx * (S.y + P.ny * (t / P.nx));
  if ((flags[n] & 15u) == SOLID) {
    out[t] = -1.0;
    return;
  }
  var d = 0.0;
  var j = vec3<f32>(0.0);
  for (var i = 0u; i < 19u; i++) {
    let v = ld(i, n);
    d += v;
    j += ci(i) * v;
  }
  out[t] = length(j / (1.0 + d)) / max(length(P.u.xyz), 1e-6);
}
`;
}
