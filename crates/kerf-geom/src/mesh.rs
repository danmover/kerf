//! A part's surface as the kernel meshed it, together with what the kernel knows exactly: which face each triangle
//! belongs to, and that face's true shape (a plane, a cylinder, a cone, a sphere). A mesh alone cannot say whether two
//! parts that touch also overlap, because a round face is only approximated by flat triangles. With the true faces
//! it can.

use std::collections::HashMap;

use crate::bvh::Bvh;
use crate::tri::*;
use crate::vec::*;

/// No face.
pub const NONE: u32 = u32::MAX;

/// How far a vertex may sit from the face the kernel says it is on (mm). Mesh vertices are single precision, so
/// at a metre from the origin they are good to about 0.0001 mm.
const ON_FACE: f64 = 1e-3;
/// Vertices closer than this are the same point (mm).
const WELD: f64 = 5e-4;
/// A triangle lower than this (mm) is a sliver.
const SLIVER: f64 = 1e-3;

#[derive(Clone, Copy, Debug)]
pub enum Face {
    /// `n` points out of the solid; the face lies on `n . x = d`.
    Plane { n: V3, d: f64 },
    /// A round face about the line through `o` along unit `dir`: a cylinder (`slope` 0) or a cone, whose radius is
    /// `r` at `o` and grows by `slope` for each millimetre along `dir`. `convex` is a shaft (material inside the
    /// radius), not a hole. `sag` is how far the flat triangles stray from the true round surface at most.
    Round { o: V3, dir: V3, r: f64, slope: f64, convex: bool, sag: f64 },
    /// Part of a sphere about `c`.
    Ball { c: V3, r: f64, convex: bool, sag: f64 },
    /// Any other surface: only known to lie within `sag` of its triangles.
    Other { sag: f64 },
}

impl Face {
    /// How far the true solid may reach outside the triangles of this face.
    #[inline]
    pub fn out(&self) -> f64 {
        match *self {
            Face::Plane { .. } => 0.0,
            Face::Round { convex, sag, .. } | Face::Ball { convex, sag, .. } => {
                if convex {
                    sag
                } else {
                    0.0
                }
            }
            Face::Other { sag } => sag,
        }
    }
    /// How far the true surface may lie behind (inside) the triangles of this face.
    #[inline]
    pub fn behind(&self) -> f64 {
        match *self {
            Face::Plane { .. } => 0.0,
            Face::Round { convex, sag, .. } | Face::Ball { convex, sag, .. } => {
                if convex {
                    0.0
                } else {
                    sag
                }
            }
            Face::Other { sag } => sag,
        }
    }
    /// 0 flat, 1 cylinder, 2 other, 3 cone, 4 sphere.
    pub fn kind(&self) -> u8 {
        match *self {
            Face::Plane { .. } => 0,
            Face::Round { slope, .. } => {
                if slope == 0.0 {
                    1
                } else {
                    3
                }
            }
            Face::Ball { .. } => 4,
            Face::Other { .. } => 2,
        }
    }
}

/// A round hole in a flat face (or a round boss standing on it): the face has no material inside the circle. Also
/// a round hole cut into any other face (a cross-drilled shaft, a boss shaped to sit on a tube): beside the hole,
/// that face has no material inside the hole's radius.
#[derive(Clone, Copy, Debug)]
pub struct Hole {
    /// the circle's centre, on the face
    pub c: V3,
    /// the circle's axis, square to the face
    pub dir: V3,
    pub r: f64,
    /// the flat face it is in
    pub face: u32,
    /// the circle goes all the way round, so no triangle of the face has material inside it
    pub full: bool,
    /// in a flat face square to the axis (otherwise: any face a round hole cuts into, known only beside the hole)
    pub flat: bool,
}

pub struct Geom {
    pub tris: Vec<Tri>,
    /// each triangle's face (index into `faces`)
    pub face_of: Vec<u32>,
    pub faces: Vec<Face>,
    pub bvh: Bvh,
    /// each triangle's unit normal, pointing out of the solid (zero for a sliver)
    pub normals: Vec<V3>,
    /// +1 when the triangles are wound with their normals out of the solid, -1 when into it
    pub winding: f64,
    pub holes: Vec<Hole>,
    /// for a flat triangle that reaches into a hole's circle: which holes (into `holes`)
    pub tri_holes: HashMap<u32, Vec<u32>>,
    /// flat faces that are the end of a shaft or a cone: the round faces (into `faces`) the material under them
    /// stays inside
    pub caps: HashMap<u32, Vec<u32>>,
    /// round faces that end at such a flat face: how far along the axis (from the face's own `o`, along its `dir`)
    /// the material under them can be, at least and at most
    pub ends: HashMap<u32, (f64, f64)>,
    /// every edge is shared by an even number of triangles, wound the same way all over: the surface encloses a solid
    pub closed: bool,
    /// one triangle of each separate piece of the surface
    pub pieces: Vec<u32>,
    /// for each piece, a few points inside the solid beside it, deepest first (none found: too thin to tell)
    pub inner: Vec<Vec<V3>>,
    /// the most any face's true surface may differ from its triangles
    pub reach: f64,
    /// how many faces the kernel described that the mesh did not agree with (they are treated as unknown surfaces)
    pub mismatched: u32,
}

/// One face as the kernel describes it: 10 numbers, `[kind, p0, p1, p2, d0, d1, d2, r, slope, 0]`.
/// kind 0 is a plane (p a point on it, d its normal), 1 a cylinder (p on its axis, d along it, r its radius), 2 a
/// cone (as a cylinder, with r the radius at p and slope how much it grows per millimetre along d), 3 a sphere (p
/// its centre, r its radius), 4 a torus (p its centre, d its axis, r the radius of the ring and the slope slot the
/// radius of the tube). Anything else is a face with no exact shape.
pub const FACE_STRIDE: usize = 10;

/// The most `f` reaches over a triangle, for an `f` with one peak (concave), by searching along two directions.
fn most_on_tri(t: &Tri, f: impl Fn(V3) -> f64) -> f64 {
    const STEPS: usize = 22;
    let at = |u: f64, v: f64| -> f64 {
        // u along the first edge, v from that edge toward the far corner
        let base = lerp(t[0], t[1], u);
        f(lerp(base, t[2], v))
    };
    let best_v = |u: f64| -> f64 {
        let (mut lo, mut hi) = (0.0f64, 1.0f64);
        for _ in 0..STEPS {
            let (a, b) = (lo + (hi - lo) / 3.0, hi - (hi - lo) / 3.0);
            if at(u, a) < at(u, b) {
                lo = a;
            } else {
                hi = b;
            }
        }
        at(u, 0.5 * (lo + hi)).max(at(u, 0.0))
    };
    let (mut lo, mut hi) = (0.0f64, 1.0f64);
    for _ in 0..STEPS {
        let (a, b) = (lo + (hi - lo) / 3.0, hi - (hi - lo) / 3.0);
        if best_v(a) < best_v(b) {
            lo = a;
        } else {
            hi = b;
        }
    }
    best_v(0.5 * (lo + hi)).max(best_v(0.0)).max(best_v(1.0))
}

/// Whether a triangle of a flat face reaches inside a circle of that face only between the circle's chords and
/// their arcs. `chords` are the straight edges that stand for arcs of the circle about `c` (axis `dir`, radius `r`).
fn beyond_chords(t: &Tri, c: V3, dir: V3, r: f64, chords: &[(V3, V3)]) -> bool {
    // across the axis, with the centre at the origin
    let e1 = unit(sub(sub(chords[0].0, c), scale(dir, dot(sub(chords[0].0, c), dir))));
    let e2 = cross(dir, e1);
    let flat = |v: V3| -> [f64; 2] {
        let w = sub(v, c);
        [dot(w, e1), dot(w, e2)]
    };
    // what is left of the triangle on the centre's side of every chord
    let mut poly: Vec<[f64; 2]> = t.iter().map(|v| flat(*v)).collect();
    for &(p, q) in chords {
        let (p, q) = (flat(p), flat(q));
        let mid = [0.5 * (p[0] + q[0]), 0.5 * (p[1] + q[1])];
        let far = (mid[0] * mid[0] + mid[1] * mid[1]).sqrt();
        if far < 1e-9 {
            return false;
        }
        let n = [mid[0] / far, mid[1] / far];
        // a hair short of the chord, so a triangle lying along it is wholly beyond it
        let lim = far - 1e-6;
        let side = |v: &[f64; 2]| n[0] * v[0] + n[1] * v[1] - lim;
        let mut kept: Vec<[f64; 2]> = Vec::with_capacity(poly.len() + 1);
        for i in 0..poly.len() {
            let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
            let (sa, sb) = (side(&a), side(&b));
            if sa <= 0.0 {
                kept.push(a);
            }
            if (sa < 0.0 && sb > 0.0) || (sa > 0.0 && sb < 0.0) {
                let u = sa / (sa - sb);
                kept.push([a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])]);
            }
        }
        poly = kept;
        if poly.len() < 3 {
            return true;
        }
    }
    // what is left has to be outside the circle: nearest the centre along one of its edges, unless it holds the centre
    let mut inside = true;
    let mut near = f64::INFINITY;
    for i in 0..poly.len() {
        let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
        let e = [b[0] - a[0], b[1] - a[1]];
        let l2 = e[0] * e[0] + e[1] * e[1];
        let u = if l2 > 0.0 { (-(a[0] * e[0] + a[1] * e[1]) / l2).clamp(0.0, 1.0) } else { 0.0 };
        let (x, y) = (a[0] + u * e[0], a[1] + u * e[1]);
        near = near.min((x * x + y * y).sqrt());
        // the centre is inside when it is on the same side of every edge
        if (a[0] * e[1] - a[1] * e[0]) * (poly[0][0] * (poly[1][1] - poly[0][1]) - poly[0][1] * (poly[1][0] - poly[0][0])) < 0.0 {
            inside = false;
        }
    }
    !inside && near >= r - 1e-6
}

impl Geom {
    /// `positions` are x, y, z per vertex; `indices` three per triangle; `tri_face` each triangle's row in `faces`
    /// (or a negative number for none); `faces` is FACE_STRIDE numbers per face. `deflection` is how far the mesher
    /// was allowed to stray from surfaces the kernel gives no exact shape for.
    pub fn new(positions: &[f32], indices: &[u32], tri_face: &[i32], faces: &[f64], deflection: f64) -> Geom {
        // corners that are not there: nothing to go on
        let indices: &[u32] = if indices.iter().any(|&i| i as usize * 3 + 2 >= positions.len()) { &[] } else { indices };
        let nt = indices.len() / 3;
        let vert = |i: u32| -> V3 {
            let k = i as usize * 3;
            [positions[k] as f64, positions[k + 1] as f64, positions[k + 2] as f64]
        };
        let mut tris: Vec<Tri> = Vec::with_capacity(nt);
        for t in 0..nt {
            tris.push([vert(indices[t * 3]), vert(indices[t * 3 + 1]), vert(indices[t * 3 + 2])]);
        }
        // which way the triangles wind: outward when the enclosed volume comes out positive
        let mut vol = 0.0;
        for t in &tris {
            vol += dot(t[0], cross(t[1], t[2]));
        }
        let sign = if vol >= 0.0 { 1.0 } else { -1.0 };
        // a triangle thinner than SLIVER has no direction worth trusting: its corners are only single precision
        let normals: Vec<V3> = tris
            .iter()
            .map(|t| {
                let c = cross(sub(t[1], t[0]), sub(t[2], t[0]));
                let longest = len2(sub(t[1], t[0])).max(len2(sub(t[2], t[1]))).max(len2(sub(t[0], t[2]))).sqrt();
                if len(c) < SLIVER * longest {
                    [0.0; 3]
                } else {
                    scale(unit(c), sign)
                }
            })
            .collect();

        let nf = faces.len() / FACE_STRIDE;
        let mut face_of: Vec<u32> = (0..nt).map(|t| if t < tri_face.len() && tri_face[t] >= 0 && (tri_face[t] as usize) < nf { tri_face[t] as u32 } else { NONE }).collect();
        let mut by_face: Vec<Vec<u32>> = vec![Vec::new(); nf];
        for (t, &f) in face_of.iter().enumerate() {
            if f != NONE {
                by_face[f as usize].push(t as u32);
            }
        }
        let other = Face::Other { sag: deflection };
        let mut out_faces: Vec<Face> = Vec::with_capacity(nf + 1);
        let mut mismatched = 0;
        for f in 0..nf {
            let row = &faces[f * FACE_STRIDE..(f + 1) * FACE_STRIDE];
            let p = [row[1], row[2], row[3]];
            let d = unit([row[4], row[5], row[6]]);
            let mine = &by_face[f];
            let kind = row[0] as i32;
            // every triangle has to agree which way is out: `side` is how far along the way out its normal points
            let facing = |side: &dyn Fn(u32) -> f64| -> Option<bool> {
                let (mut outs, mut ins) = (0, 0);
                for &t in mine {
                    if len2(normals[t as usize]) < 0.5 {
                        continue;
                    }
                    let o = side(t);
                    if o > 0.5 {
                        outs += 1;
                    } else if o < -0.5 {
                        ins += 1;
                    } else {
                        return None;
                    }
                }
                if (outs == 0) != (ins == 0) {
                    Some(outs > 0)
                } else {
                    None
                }
            };
            let centre = |t: u32| -> V3 {
                let tr = &tris[t as usize];
                scale(add(add(tr[0], tr[1]), tr[2]), 1.0 / 3.0)
            };
            let face = if mine.is_empty() || !row.iter().all(|v| v.is_finite()) {
                other
            } else if kind == 0 && len2(d) > 0.5 {
                // the triangles say which way is out; the kernel's plane says exactly where
                let mut agree = 0.0;
                for &t in mine {
                    agree += dot(normals[t as usize], d);
                }
                let n = if agree >= 0.0 { d } else { scale(d, -1.0) };
                let dd = dot(n, p);
                let ok = mine.iter().all(|&t| {
                    let tr = &tris[t as usize];
                    tr.iter().all(|v| (dot(n, *v) - dd).abs() <= ON_FACE) && (len2(normals[t as usize]) < 0.5 || dot(normals[t as usize], n) > 0.999)
                });
                if ok {
                    Face::Plane { n, d: dd }
                } else {
                    mismatched += 1;
                    other
                }
            } else if (kind == 1 || kind == 2) && len2(d) > 0.5 && row[7] >= 0.0 {
                let r = row[7];
                let slope = if kind == 2 { row[8] } else { 0.0 };
                let radial = |v: V3| -> V3 {
                    let w = sub(v, p);
                    sub(w, scale(d, dot(w, d)))
                };
                // how far inside the true surface a point is, measured across the axis
                let short = |v: V3| -> f64 { r + slope * dot(sub(v, p), d) - len(radial(v)) };
                let on = mine.iter().all(|&t| tris[t as usize].iter().all(|v| short(*v).abs() <= ON_FACE && r + slope * dot(sub(*v, p), d) > -ON_FACE));
                // out of a shaft is away from the axis, and for a cone toward its narrow end as well
                let convex = facing(&|t| dot(normals[t as usize], unit(sub(unit(radial(centre(t))), scale(d, slope)))));
                match (on, convex) {
                    (true, Some(convex)) => {
                        let mut sag = 0.0f64;
                        for &t in mine {
                            let tr = &tris[t as usize];
                            sag = sag.max(if slope == 0.0 { r - line_tri_dist(p, d, tr) } else { most_on_tri(tr, short) });
                        }
                        Face::Round { o: p, dir: d, r, slope, convex, sag: sag.max(0.0) + 1e-9 }
                    }
                    _ => {
                        mismatched += 1;
                        other
                    }
                }
            } else if kind == 3 && row[7] > 1e-9 {
                let r = row[7];
                let on = mine.iter().all(|&t| tris[t as usize].iter().all(|v| (len(sub(*v, p)) - r).abs() <= ON_FACE));
                let convex = facing(&|t| dot(normals[t as usize], unit(sub(centre(t), p))));
                match (on, convex) {
                    (true, Some(convex)) => {
                        let mut sag = 0.0f64;
                        for &t in mine {
                            sag = sag.max(r - point_tri_dist2(p, &tris[t as usize]).sqrt());
                        }
                        Face::Ball { c: p, r, convex, sag: sag.max(0.0) + 1e-9 }
                    }
                    _ => {
                        mismatched += 1;
                        other
                    }
                }
            } else if kind == 4 && len2(d) > 0.5 && row[7] > 1e-9 && row[8] > 1e-9 {
                // a torus (the fillet round a screw's head): not a shape the proofs reason about, but how far its
                // triangles stray from it can be measured, which is far less than the mesher's allowance
                let (ring, tube) = (row[7], row[8]);
                let off = |v: V3| -> f64 {
                    let w = sub(v, p);
                    let z = dot(w, d);
                    let rho = len(sub(w, scale(d, z)));
                    (((rho - ring) * (rho - ring) + z * z).sqrt() - tube).abs()
                };
                if mine.iter().all(|&t| tris[t as usize].iter().all(|v| off(*v) <= ON_FACE)) {
                    // how fast the distance to the torus can bend: its tightest curve
                    let bend = 2.0 / tube.min((ring - tube).abs().max(0.25 * tube));
                    let mut sag = 0.0f64;
                    for &t in mine {
                        let tr = &tris[t as usize];
                        let longest = len(sub(tr[1], tr[0])).max(len(sub(tr[2], tr[1]))).max(len(sub(tr[0], tr[2])));
                        // sampled on a grid fine enough that what lies between samples is small and bounded
                        let n = ((longest / (0.004 * tube).sqrt()).ceil() as usize).clamp(4, 40);
                        let mut worst = 0.0f64;
                        for i in 0..=n {
                            for j in 0..=(n - i) {
                                let (u, v) = (i as f64 / n as f64, j as f64 / n as f64);
                                worst = worst.max(off(add(add(scale(tr[0], 1.0 - u - v), scale(tr[1], u)), scale(tr[2], v))));
                            }
                        }
                        let step = longest / n as f64;
                        sag = sag.max(worst + 0.25 * bend * step * step);
                    }
                    Face::Other { sag: sag.min(deflection) + 1e-9 }
                } else {
                    mismatched += 1;
                    other
                }
            } else {
                other
            };
            out_faces.push(face);
        }
        // triangles with no face are an unknown surface
        let unknown = out_faces.len() as u32;
        out_faces.push(other);
        for f in face_of.iter_mut() {
            if *f == NONE {
                *f = unknown;
            }
        }

        // weld: the same point listed by two faces gets one id
        let cell = |x: f64| -> i64 { (x / (2.0 * WELD)).floor() as i64 };
        let mut grid: HashMap<(i64, i64, i64), Vec<u32>> = HashMap::new();
        let mut pts: Vec<V3> = Vec::new();
        let mut corner: Vec<[u32; 3]> = Vec::with_capacity(nt);
        for tr in &tris {
            let mut ids = [0u32; 3];
            for (k, v) in tr.iter().enumerate() {
                let c = (cell(v[0]), cell(v[1]), cell(v[2]));
                let mut found = NONE;
                'search: for dx in -1..=1 {
                    for dy in -1..=1 {
                        for dz in -1..=1 {
                            if let Some(list) = grid.get(&(c.0 + dx, c.1 + dy, c.2 + dz)) {
                                for &i in list {
                                    if len2(sub(pts[i as usize], *v)) <= WELD * WELD {
                                        found = i;
                                        break 'search;
                                    }
                                }
                            }
                        }
                    }
                }
                if found == NONE {
                    found = pts.len() as u32;
                    pts.push(*v);
                    grid.entry(c).or_default().push(found);
                }
                ids[k] = found;
            }
            corner.push(ids);
        }
        // edges, each with the triangles on it
        let mut edges: HashMap<(u32, u32), Vec<(u32, u8, bool)>> = HashMap::new();
        for (t, ids) in corner.iter().enumerate() {
            for k in 0..3 {
                let (a, b) = (ids[k], ids[(k + 1) % 3]);
                if a == b {
                    continue;
                }
                edges.entry(if a < b { (a, b) } else { (b, a) }).or_default().push((t as u32, k as u8, a < b));
            }
        }
        // closed, and wound the same way all over: each edge is run as often one way as the other
        let closed = nt > 0 && edges.values().all(|v| v.len() % 2 == 0 && v.iter().filter(|e| e.2).count() * 2 == v.len());

        // round holes in flat faces: an edge a flat triangle shares with a round face square to it is a chord of a
        // circle, and the flat face lies outside that circle when the triangle is on the far side of the chord
        let mut holes: Vec<Hole> = Vec::new();
        let mut turned: Vec<f64> = Vec::new();
        // each hole's chords: where its circle is cut short by straight edges of the face's triangles
        let mut chords: Vec<Vec<(V3, V3)>> = Vec::new();
        // holes cut into faces that are not flat and square to them: (face, round face) and which hole that is
        let mut cut: HashMap<(u32, u32), u32> = HashMap::new();
        let mut of_face: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut tri_holes: HashMap<u32, Vec<u32>> = HashMap::new();
        // the ends of shafts: (flat face, round face) and how much of the circle between them has been seen
        let mut ends: Vec<(u32, Vec<u32>, V3, f64, f64)> = Vec::new();
        let mut edge_list: Vec<&Vec<(u32, u8, bool)>> = edges.values().filter(|on| on.len() >= 2).collect();
        // in a fixed order, so the same mesh always gives the same holes
        edge_list.sort_by_key(|on| on.iter().map(|e| (e.0, e.1)).min());
        for on in edge_list {
            for &(t, k, _) in on {
                let fp = face_of[t as usize];
                let flat = match out_faces[fp as usize] {
                    Face::Plane { n, d } => Some((n, d)),
                    _ => None,
                };
                for &(u, _, _) in on {
                    let fr = face_of[u as usize];
                    if fr == fp {
                        continue;
                    }
                    let Face::Round { o, dir, r, slope, convex, .. } = out_faces[fr as usize] else { continue };
                    let square = flat.filter(|(n, _)| dot(*n, dir).abs() >= 1.0 - 1e-9);
                    let Some((n, d)) = square else {
                        // any other face a straight round hole cuts into: this triangle has an edge on the hole
                        // and its far corner outside it, so beside the hole its face has nothing inside the hole
                        if convex || slope != 0.0 || r < 1e-6 {
                            continue;
                        }
                        let tr = &tris[t as usize];
                        let (p, q, far) = (tr[k as usize], tr[(k as usize + 1) % 3], tr[(k as usize + 2) % 3]);
                        let off = |v: V3| {
                            let w = sub(v, o);
                            sub(w, scale(dir, dot(w, dir)))
                        };
                        let (mid, away) = (off(lerp(p, q, 0.5)), off(far));
                        if len(mid) < 0.5 * r || dot(sub(away, mid), mid) <= 0.0 || len(away) < r - 1e-6 {
                            continue;
                        }
                        let id = *cut.entry((fp, fr)).or_insert_with(|| {
                            holes.push(Hole { c: o, dir, r, face: fp, full: false, flat: false });
                            turned.push(0.0);
                            chords.push(Vec::new());
                            holes.len() as u32 - 1
                        });
                        let mine = tri_holes.entry(t).or_default();
                        if !mine.contains(&id) {
                            mine.push(id);
                        }
                        break;
                    };
                    let lean = dot(n, dir);
                    // the circle the round face cuts the plane in
                    let z = (d - dot(n, o)) / lean;
                    let rad = r + slope * z;
                    let c = add(o, scale(dir, z));
                    if rad < 1e-6 {
                        continue;
                    }
                    let tr = &tris[t as usize];
                    let (p, q) = (tr[k as usize], tr[(k as usize + 1) % 3]);
                    let mid = sub(lerp(p, q, 0.5), c);
                    if len(mid) < 0.5 * rad {
                        continue;
                    }
                    let span = 2.0 * (0.5 * len(sub(q, p)) / rad).min(1.0).asin();
                    if dot(sub(sub(tr[(k as usize + 2) % 3], c), mid), mid) <= 0.0 {
                        // the flat face is inside the circle: the end of a shaft, if the round face is one
                        if convex {
                            match ends.iter_mut().find(|e| e.0 == fp && (e.3 - rad).abs() < 1e-9 && len(sub(e.2, c)) < 1e-9) {
                                Some(e) => {
                                    e.4 += span;
                                    if !e.1.contains(&fr) {
                                        e.1.push(fr);
                                    }
                                }
                                None => ends.push((fp, vec![fr], c, rad, span)),
                            }
                        }
                        break;
                    }
                    let list = of_face.entry(fp).or_default();
                    let id = match list.iter().find(|&&h| (holes[h as usize].r - rad).abs() < 1e-9 && len(sub(holes[h as usize].c, c)) < 1e-9) {
                        Some(&h) => h,
                        None => {
                            holes.push(Hole { c, dir, r: rad, face: fp, full: false, flat: true });
                            turned.push(0.0);
                            chords.push(Vec::new());
                            list.push(holes.len() as u32 - 1);
                            holes.len() as u32 - 1
                        }
                    };
                    // how much of the circle this chord spans
                    turned[id as usize] += span;
                    chords[id as usize].push((p, q));
                    let mine = tri_holes.entry(t).or_default();
                    if !mine.contains(&id) {
                        mine.push(id);
                    }
                    break;
                }
            }
        }
        let mut caps: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut limits: HashMap<u32, (f64, f64)> = HashMap::new();
        for e in &ends {
            if e.4 < std::f64::consts::TAU - 1e-3 {
                continue;
            }
            let Face::Plane { n, d } = out_faces[e.0 as usize] else { continue };
            for &fr in &e.1 {
                caps.entry(e.0).or_default().push(fr);
                // the material stops at the flat end: below it when the end faces along the axis, above when against
                let Face::Round { o, dir, .. } = out_faces[fr as usize] else { continue };
                let lean = dot(n, dir);
                let at = (d - dot(n, o)) / lean;
                let lim = limits.entry(fr).or_insert((f64::NEG_INFINITY, f64::INFINITY));
                if lean > 0.0 {
                    lim.1 = lim.1.min(at);
                } else {
                    lim.0 = lim.0.max(at);
                }
            }
        }
        let bvh = Bvh::build(&tris);
        for (id, hole) in holes.iter_mut().enumerate() {
            if !hole.flat {
                continue;
            }
            hole.full = turned[id] >= std::f64::consts::TAU - 1e-3;
            // every triangle of the face that reaches inside the circle, when the true face does not. A circle
            // that goes all the way round has all of the face outside it. One that does not (a hole breaking
            // into a wall beside it) only where the triangle reaches in no further than the chords do: between
            // a chord and its arc there is none of the true face.
            let q = Aabb { lo: sub(hole.c, [hole.r; 3]), hi: add(hole.c, [hole.r; 3]) };
            let (full, face, c, dir, r) = (hole.full, hole.face, hole.c, hole.dir, hole.r);
            bvh.in_box(&tris, &q, |t| {
                let tr = &tris[t as usize];
                if face_of[t as usize] == face && point_tri_dist2(c, tr) < (r - 1e-9) * (r - 1e-9) && (full || beyond_chords(tr, c, dir, r, &chords[id])) {
                    let mine = tri_holes.entry(t).or_default();
                    if !mine.contains(&(id as u32)) {
                        mine.push(id as u32);
                    }
                }
                true
            });
        }

        // separate pieces
        let mut root: Vec<u32> = (0..pts.len() as u32).collect();
        fn find(root: &mut [u32], mut i: u32) -> u32 {
            while root[i as usize] != i {
                root[i as usize] = root[root[i as usize] as usize];
                i = root[i as usize];
            }
            i
        }
        for ids in &corner {
            let a = find(&mut root, ids[0]);
            let b = find(&mut root, ids[1]);
            root[b as usize] = a;
            let c = find(&mut root, ids[2]);
            root[c as usize] = a;
        }
        let mut seen: HashMap<u32, usize> = HashMap::new();
        let mut pieces = Vec::new();
        // a few well-shaped triangles of each piece, to look for a point inside the solid from
        let mut tries: Vec<Vec<u32>> = Vec::new();
        for (t, ids) in corner.iter().enumerate() {
            let r = find(&mut root, ids[0]);
            let at = *seen.entry(r).or_insert_with(|| {
                pieces.push(t as u32);
                tries.push(Vec::new());
                pieces.len() - 1
            });
            if tries[at].len() < 6 && len2(normals[t]) > 0.5 {
                tries[at].push(t as u32);
            }
        }

        let reach = out_faces.iter().enumerate().filter(|(f, _)| (*f as u32) != unknown || face_of.contains(&unknown)).map(|(_, f)| f.out() + f.behind()).fold(0.0, f64::max);
        let mut g = Geom { tris, face_of, faces: out_faces, bvh, normals, winding: sign, holes, tri_holes, caps, ends: limits, closed, pieces, inner: Vec::new(), reach, mismatched };
        g.inner = tries
            .iter()
            .map(|list| {
                let mut found: Vec<(f64, V3)> = Vec::new();
                for &t in list {
                    let tr = &g.tris[t as usize];
                    let c = scale(add(add(tr[0], tr[1]), tr[2]), 1.0 / 3.0);
                    let inward = scale(g.normals[t as usize], -1.0);
                    // halfway to the wall across from this triangle, then nearer and nearer the triangle itself
                    let across = g.bvh.first_hit(&g.tris, c, inward).unwrap_or(0.0);
                    for depth in [across / 2.0, 0.01, 0.002, 0.0005] {
                        if depth <= 0.0 {
                            continue;
                        }
                        let p = add(c, scale(inward, depth));
                        if g.closed && g.contains(p) == Some(true) {
                            found.push((depth, p));
                            break;
                        }
                    }
                }
                found.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
                found.iter().map(|f| f.1).collect()
            })
            .collect();
        g
    }

    /// A triangle's outward normal by its winding alone, however thin it is (zero only when its corners are in line).
    /// The clash proofs do not trust a sliver's direction (`normals` is zero there); which way a surface faces for
    /// resting on it does, as the checks always have.
    pub fn facing(&self, tri: u32) -> V3 {
        let n = self.normals[tri as usize];
        if len2(n) > 0.5 {
            return n;
        }
        let t = &self.tris[tri as usize];
        scale(unit(cross(sub(t[1], t[0]), sub(t[2], t[0]))), self.winding)
    }

    #[inline]
    pub fn face(&self, tri: u32) -> &Face {
        &self.faces[self.face_of[tri as usize] as usize]
    }

    /// Whether `p` is so near the surface that the mesh cannot say which side of the true surface it is on.
    pub fn at_surface(&self, p: V3, slack: f64) -> bool {
        let r = self.reach + slack;
        let q = Aabb { lo: sub(p, [r; 3]), hi: add(p, [r; 3]) };
        let mut near = false;
        self.bvh.in_box(&self.tris, &q, |t| {
            let f = self.face(t);
            let lim = f.out().max(f.behind()) + slack;
            if point_tri_dist2(p, &self.tris[t as usize]) <= lim * lim {
                near = true;
            }
            !near
        });
        near
    }

    /// Whether `p` (in the part's coordinates) is inside the solid: `Some` when three skew rays agree.
    pub fn contains(&self, p: V3) -> Option<bool> {
        const RAYS: [V3; 3] = [[0.5773, 0.5774, 0.5772], [-0.6123, 0.4571, 0.6451], [0.3471, -0.8089, 0.4746]];
        let first = self.bvh.crossings(&self.tris, p, RAYS[0]) % 2 == 1;
        for d in &RAYS[1..] {
            if (self.bvh.crossings(&self.tris, p, *d) % 2 == 1) != first {
                return None;
            }
        }
        Some(first)
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;

    /// Mesh arrays and face rows for building test parts.
    #[derive(Default)]
    pub struct Builder {
        pub pos: Vec<f32>,
        pub idx: Vec<u32>,
        pub tri_face: Vec<i32>,
        pub faces: Vec<f64>,
    }

    impl Builder {
        fn face(&mut self, kind: f64, p: V3, d: V3, r: f64) -> i32 {
            self.faces.extend_from_slice(&[kind, p[0], p[1], p[2], d[0], d[1], d[2], r, 0.0, 0.0]);
            (self.faces.len() / FACE_STRIDE) as i32 - 1
        }
        /// A triangle with its own corners (as the kernel's meshes have them, face by face).
        fn tri(&mut self, f: i32, a: V3, b: V3, c: V3) {
            let base = (self.pos.len() / 3) as u32;
            for v in [a, b, c] {
                self.pos.extend_from_slice(&[v[0] as f32, v[1] as f32, v[2] as f32]);
            }
            self.idx.extend_from_slice(&[base, base + 1, base + 2]);
            self.tri_face.push(f);
        }
        fn quad(&mut self, f: i32, q: [V3; 4]) {
            self.tri(f, q[0], q[1], q[2]);
            self.tri(f, q[0], q[2], q[3]);
        }

        /// A box, each side a flat face.
        pub fn cuboid(mut self, lo: V3, hi: V3) -> Self {
            let p = |i: usize| -> V3 { [if i & 1 != 0 { hi[0] } else { lo[0] }, if i & 2 != 0 { hi[1] } else { lo[1] }, if i & 4 != 0 { hi[2] } else { lo[2] }] };
            let sides: [([usize; 4], V3); 6] = [([0, 2, 3, 1], [0.0, 0.0, -1.0]), ([4, 5, 7, 6], [0.0, 0.0, 1.0]), ([0, 1, 5, 4], [0.0, -1.0, 0.0]), ([2, 6, 7, 3], [0.0, 1.0, 0.0]), ([0, 4, 6, 2], [-1.0, 0.0, 0.0]), ([1, 3, 7, 5], [1.0, 0.0, 0.0])];
            for (q, n) in sides {
                let f = self.face(0.0, p(q[0]), n, 0.0);
                self.quad(f, [p(q[0]), p(q[1]), p(q[2]), p(q[3])]);
            }
            self
        }

        /// A shaft about the z axis through (cx, cy), from z0 to z1, its round side in `n` flats turned by `phase`.
        pub fn shaft(mut self, cx: f64, cy: f64, r: f64, z0: f64, z1: f64, n: usize, phase: f64) -> Self {
            let at = |i: usize, z: f64| -> V3 {
                let a = phase + (i % n) as f64 * std::f64::consts::TAU / n as f64;
                [cx + r * a.cos(), cy + r * a.sin(), z]
            };
            let side = self.face(1.0, [cx, cy, 0.0], [0.0, 0.0, 1.0], r);
            let bottom = self.face(0.0, [cx, cy, z0], [0.0, 0.0, -1.0], 0.0);
            let top = self.face(0.0, [cx, cy, z1], [0.0, 0.0, 1.0], 0.0);
            for i in 0..n {
                self.quad(side, [at(i, z0), at(i + 1, z0), at(i + 1, z1), at(i, z1)]);
                self.tri(bottom, [cx, cy, z0], at(i + 1, z0), at(i, z0));
                self.tri(top, [cx, cy, z1], at(i, z1), at(i + 1, z1));
            }
            self
        }

        /// A bolt about the z axis through (cx, cy): a shank of radius `r` from z0 up to z1, under a round head of
        /// radius `head` from z1 to z2.
        pub fn bolt(mut self, cx: f64, cy: f64, r: f64, head: f64, z0: f64, z1: f64, z2: f64, n: usize, phase: f64) -> Self {
            let at = |i: usize, rad: f64, z: f64| -> V3 {
                let a = phase + (i % n) as f64 * std::f64::consts::TAU / n as f64;
                [cx + rad * a.cos(), cy + rad * a.sin(), z]
            };
            let shank = self.face(1.0, [cx, cy, 0.0], [0.0, 0.0, 1.0], r);
            let tip = self.face(0.0, [cx, cy, z0], [0.0, 0.0, -1.0], 0.0);
            let under = self.face(0.0, [cx, cy, z1], [0.0, 0.0, -1.0], 0.0);
            let side = self.face(1.0, [cx, cy, 0.0], [0.0, 0.0, 1.0], head);
            let top = self.face(0.0, [cx, cy, z2], [0.0, 0.0, 1.0], 0.0);
            for i in 0..n {
                self.quad(shank, [at(i, r, z0), at(i + 1, r, z0), at(i + 1, r, z1), at(i, r, z1)]);
                self.tri(tip, [cx, cy, z0], at(i + 1, r, z0), at(i, r, z0));
                self.quad(under, [at(i, r, z1), at(i + 1, r, z1), at(i + 1, head, z1), at(i, head, z1)]);
                self.quad(side, [at(i, head, z1), at(i + 1, head, z1), at(i + 1, head, z2), at(i, head, z2)]);
                self.tri(top, [cx, cy, z2], at(i, head, z2), at(i + 1, head, z2));
            }
            self
        }

        /// A countersunk screw about the z axis through (cx, cy): a shank of radius `r` from z0 up to z1, then a
        /// cone opening out to radius `head` at z2, flat on top.
        pub fn countersunk(mut self, cx: f64, cy: f64, r: f64, head: f64, z0: f64, z1: f64, z2: f64, n: usize, phase: f64) -> Self {
            let at = |i: usize, rad: f64, z: f64| -> V3 {
                let a = phase + (i % n) as f64 * std::f64::consts::TAU / n as f64;
                [cx + rad * a.cos(), cy + rad * a.sin(), z]
            };
            let shank = self.face(1.0, [cx, cy, 0.0], [0.0, 0.0, 1.0], r);
            let tip = self.face(0.0, [cx, cy, z0], [0.0, 0.0, -1.0], 0.0);
            let cone = self.face(2.0, [cx, cy, z1], [0.0, 0.0, 1.0], r);
            let at_cone = self.faces.len() - FACE_STRIDE;
            self.faces[at_cone + 8] = (head - r) / (z2 - z1);
            let top = self.face(0.0, [cx, cy, z2], [0.0, 0.0, 1.0], 0.0);
            for i in 0..n {
                self.quad(shank, [at(i, r, z0), at(i + 1, r, z0), at(i + 1, r, z1), at(i, r, z1)]);
                self.tri(tip, [cx, cy, z0], at(i + 1, r, z0), at(i, r, z0));
                self.quad(cone, [at(i, r, z1), at(i + 1, r, z1), at(i + 1, head, z2), at(i, head, z2)]);
                self.tri(top, [cx, cy, z2], at(i, head, z2), at(i + 1, head, z2));
            }
            self
        }

        /// A plate with a countersunk hole: radius `r` from z0 up to z1, opening out to `top` at the top face z2.
        pub fn plate_with_countersink(mut self, cx: f64, cy: f64, half: f64, r: f64, top: f64, z0: f64, z1: f64, z2: f64, n: usize, phase: f64) -> Self {
            let at = |i: usize, rad: f64, z: f64| -> V3 {
                let a = phase + (i % n) as f64 * std::f64::consts::TAU / n as f64;
                [cx + rad * a.cos(), cy + rad * a.sin(), z]
            };
            let sq = |i: usize, z: f64| -> V3 {
                let a = phase + (i % n) as f64 * std::f64::consts::TAU / n as f64;
                let (c, s) = (a.cos(), a.sin());
                let k = half / c.abs().max(s.abs());
                [cx + c * k, cy + s * k, z]
            };
            let wall = self.face(1.0, [cx, cy, 0.0], [0.0, 0.0, 1.0], r);
            let sink = self.face(2.0, [cx, cy, z1], [0.0, 0.0, 1.0], r);
            let at_sink = self.faces.len() - FACE_STRIDE;
            self.faces[at_sink + 8] = (top - r) / (z2 - z1);
            let bottom = self.face(0.0, [cx, cy, z0], [0.0, 0.0, -1.0], 0.0);
            let upper = self.face(0.0, [cx, cy, z2], [0.0, 0.0, 1.0], 0.0);
            for i in 0..n {
                self.quad(wall, [at(i + 1, r, z0), at(i, r, z0), at(i, r, z1), at(i + 1, r, z1)]);
                self.quad(sink, [at(i + 1, r, z1), at(i, r, z1), at(i, top, z2), at(i + 1, top, z2)]);
                self.quad(upper, [at(i, top, z2), sq(i, z2), sq(i + 1, z2), at(i + 1, top, z2)]);
                self.quad(bottom, [at(i + 1, r, z0), sq(i + 1, z0), sq(i, z0), at(i, r, z0)]);
                let (a, b) = (sq(i, z0), sq(i + 1, z0));
                let out = unit([b[1] - a[1], a[0] - b[0], 0.0]);
                let f = self.face(0.0, a, out, 0.0);
                self.quad(f, [a, b, sq(i + 1, z2), sq(i, z2)]);
            }
            self
        }

        /// A plate (about `half` wide each way, from z0 to z1) with a round hole about the z axis through (cx, cy).
        pub fn plate_with_hole(mut self, cx: f64, cy: f64, half: f64, r: f64, z0: f64, z1: f64, n: usize, phase: f64) -> Self {
            let at = |i: usize, z: f64| -> V3 {
                let a = phase + (i % n) as f64 * std::f64::consts::TAU / n as f64;
                [cx + r * a.cos(), cy + r * a.sin(), z]
            };
            // where the ray from the centre through the hole's corner i meets the square
            let sq = |i: usize, z: f64| -> V3 {
                let a = phase + (i % n) as f64 * std::f64::consts::TAU / n as f64;
                let (c, s) = (a.cos(), a.sin());
                let k = half / c.abs().max(s.abs());
                [cx + c * k, cy + s * k, z]
            };
            let wall = self.face(1.0, [cx, cy, 0.0], [0.0, 0.0, 1.0], r);
            let bottom = self.face(0.0, [cx, cy, z0], [0.0, 0.0, -1.0], 0.0);
            let top = self.face(0.0, [cx, cy, z1], [0.0, 0.0, 1.0], 0.0);
            for i in 0..n {
                // the hole's wall faces the axis
                self.quad(wall, [at(i + 1, z0), at(i, z0), at(i, z1), at(i + 1, z1)]);
                self.quad(top, [at(i, z1), sq(i, z1), sq(i + 1, z1), at(i + 1, z1)]);
                self.quad(bottom, [at(i + 1, z0), sq(i + 1, z0), sq(i, z0), at(i, z0)]);
            }
            // the outline, one flat face per step round it (the corners of the square are cut off)
            for i in 0..n {
                let (a, b) = (sq(i, z0), sq(i + 1, z0));
                let out = unit([b[1] - a[1], a[0] - b[0], 0.0]);
                let f = self.face(0.0, a, out, 0.0);
                self.quad(f, [a, b, sq(i + 1, z1), sq(i, z1)]);
            }
            self
        }

        /// A plate with a round hole like `plate_with_hole`, but its flat faces meshed with long thin triangles:
        /// each corner of the hole is joined to a corner of the outline (a ring of radius `outer`) well round from
        /// it, so some triangles touch the hole at one corner only and still reach inside its true circle.
        pub fn plate_skewed(mut self, cx: f64, cy: f64, outer: f64, r: f64, z0: f64, z1: f64, n: usize, phase: f64) -> Self {
            let step = std::f64::consts::TAU / n as f64;
            let at = |i: usize, z: f64| -> V3 {
                let a = phase + (i % n) as f64 * step;
                [cx + r * a.cos(), cy + r * a.sin(), z]
            };
            // the outline corner for hole corner i: out along a line that leaves the hole between its tangent and
            // its next flat, so the edge to it runs through the sliver between that flat and the true circle
            let lean = std::f64::consts::FRAC_PI_2 + 0.25 * step;
            // how far along that line the ring of radius `outer` is
            let reach = -r * lean.cos() + (outer * outer - r * r * lean.sin() * lean.sin()).sqrt();
            let rim = |i: usize, z: f64| -> V3 {
                let a = phase + (i % n) as f64 * step;
                [cx + r * a.cos() + reach * (a + lean).cos(), cy + r * a.sin() + reach * (a + lean).sin(), z]
            };
            let wall = self.face(1.0, [cx, cy, 0.0], [0.0, 0.0, 1.0], r);
            let bottom = self.face(0.0, [cx, cy, z0], [0.0, 0.0, -1.0], 0.0);
            let top = self.face(0.0, [cx, cy, z1], [0.0, 0.0, 1.0], 0.0);
            for i in 0..n {
                self.quad(wall, [at(i + 1, z0), at(i, z0), at(i, z1), at(i + 1, z1)]);
                self.tri(top, at(i, z1), rim(i, z1), at(i + 1, z1));
                self.tri(top, at(i + 1, z1), rim(i, z1), rim(i + 1, z1));
                self.tri(bottom, at(i, z0), at(i + 1, z0), rim(i, z0));
                self.tri(bottom, at(i + 1, z0), rim(i + 1, z0), rim(i, z0));
                let (a, b) = (rim(i, z0), rim(i + 1, z0));
                let out = unit([b[1] - a[1], a[0] - b[0], 0.0]);
                let f = self.face(0.0, a, out, 0.0);
                self.quad(f, [a, b, rim(i + 1, z1), rim(i, z1)]);
            }
            self
        }

        pub fn geom(&self) -> Geom {
            Geom::new(&self.pos, &self.idx, &self.tri_face, &self.faces, 0.5)
        }
    }

    #[test]
    fn box_is_closed_with_six_flat_faces() {
        let g = Builder::default().cuboid([0.0; 3], [10.0, 20.0, 5.0]).geom();
        assert!(g.closed);
        assert_eq!(g.pieces.len(), 1);
        assert_eq!(g.mismatched, 0);
        assert!(g.faces.iter().take(6).all(|f| matches!(f, Face::Plane { .. })));
        assert_eq!(g.contains([5.0, 5.0, 2.0]), Some(true));
        assert_eq!(g.contains([5.0, 5.0, 7.0]), Some(false));
        assert!(!g.inner[0].is_empty());
        assert_eq!(g.reach, 0.0);
    }

    #[test]
    fn shaft_and_hole_know_their_round_faces() {
        let s = Builder::default().shaft(0.0, 0.0, 5.0, 0.0, 20.0, 24, 0.0).geom();
        assert!(s.closed);
        let Face::Round { convex, sag, r, .. } = s.faces[0] else { panic!("not a cylinder") };
        assert!(convex);
        assert_eq!(r, 5.0);
        // 24 flats on a 5 mm radius: 5 (1 - cos(pi / 24))
        assert!((sag - 5.0 * (1.0 - (std::f64::consts::PI / 24.0).cos())).abs() < 1e-5, "sag {sag}");
        // the end faces are discs, not faces round a hole
        assert!(s.holes.is_empty());

        let p = Builder::default().plate_with_hole(0.0, 0.0, 20.0, 5.0, 0.0, 8.0, 24, 0.1).geom();
        assert!(p.closed, "plate is closed");
        let Face::Round { convex, .. } = p.faces[0] else { panic!("not a cylinder") };
        assert!(!convex);
        // the hole shows in the top face and in the bottom face, all the way round in each
        assert_eq!(p.holes.len(), 2);
        assert!(p.holes.iter().all(|h| h.full && h.r == 5.0));
        assert!(p.tri_holes.len() >= 2 * 14);
        // the shaft's two ends are caps; the plate has none
        assert_eq!(s.caps.len(), 2);
        assert!(p.caps.is_empty());
        assert_eq!(p.contains([0.0, 0.0, 4.0]), Some(false));
        assert_eq!(p.contains([10.0, 0.0, 4.0]), Some(true));
    }

    #[test]
    fn a_cone_knows_how_far_its_triangles_stray() {
        let s = Builder::default().countersunk(0.0, 0.0, 1.5, 3.0, -8.0, 0.0, 1.5, 16, 0.0).geom();
        assert!(s.closed);
        assert_eq!(s.mismatched, 0);
        let Face::Round { slope, convex, sag, .. } = s.faces[2] else { panic!("not a cone") };
        assert_eq!(slope, 1.0);
        assert!(convex);
        // 16 flats: the widest ring (radius 3) is off by 3 (1 - cos(pi / 16)), and nowhere by more
        let widest = 3.0 * (1.0 - (std::f64::consts::PI / 16.0).cos());
        assert!(sag <= widest + 1e-6 && sag > 0.5 * widest, "sag {sag} against {widest}");
        let p = Builder::default().plate_with_countersink(0.0, 0.0, 20.0, 1.5, 3.0, 0.0, 6.5, 8.0, 14, 0.2).geom();
        assert!(p.closed);
        assert_eq!(p.mismatched, 0);
        let Face::Round { slope, convex, .. } = p.faces[1] else { panic!("not a cone") };
        assert!(slope == 1.0 && !convex);
        // the top face has a hole the size of the countersink's mouth, the bottom face one the size of the bore
        let mut sizes: Vec<f64> = p.holes.iter().filter(|h| h.flat).map(|h| h.r).collect();
        sizes.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(sizes, vec![1.5, 3.0]);
        // and the countersink itself stops at the bore: beside it, the cone has nothing inside the bore's radius
        let cut: Vec<&Hole> = p.holes.iter().filter(|h| !h.flat).collect();
        assert!(cut.len() == 1 && cut[0].r == 1.5 && cut[0].face == 1, "{cut:?}");
    }

    #[test]
    fn a_face_the_mesh_disagrees_with_is_unknown() {
        let mut b = Builder::default().cuboid([0.0; 3], [10.0, 10.0, 10.0]);
        // say the first face's plane is 1 mm from where its triangles are
        b.faces[3] += 1.0;
        let g = b.geom();
        assert_eq!(g.mismatched, 1);
        assert!(matches!(g.faces[0], Face::Other { .. }));
        assert_eq!(g.reach, 1.0);
    }
}
