//! Proves that two parts do not overlap, from their meshes and exact faces, without the CAD kernel.
//!
//! Most pairs of parts that an assembly check has to look at touch: a screw in its hole, a cover on its case. Their
//! meshes cannot tell touching from overlapping, because a round face is drawn with flat triangles, so until now
//! each of those pairs went to the kernel for an exact boolean (about 25 ms each, 954 of them in the robot dog).
//! This does it from what is known exactly: the plane a flat face lies on, the axis and radius of a round one.
//!
//! How the proof goes. Two solids overlap only if the surface of one crosses into the other, or a whole piece of
//! one lies inside the other. A crossing shows up just under the surface of both: in a thin skin (SKIN deep) under
//! some triangle of each. So for every pair of triangles whose skins could meet, one of these has to hold:
//!
//! - both are flat: the two skins, as exact wedges under their planes, do not meet;
//! - a shaft in a hole on the same line: its radius fits all the way along (cylinders and cones; and likewise two
//!   shafts side by side, a shaft lying on a plane, a flat face round a hole against whatever stays inside the
//!   hole's radius);
//! - anything else: the skins, grown by how far the triangles can be from the true surface, do not meet.
//!
//! Then one point inside each piece is tested against the other part. Anything not proved is left to the kernel:
//! `Clear` is a proof, `Shallow` is a proof that the parts overlap by no more than a film (how deep and over what
//! area is given, so the caller can bound its volume), and every other answer only means "ask the kernel".

use std::collections::HashMap;

use crate::mesh::{Face, Geom};
use crate::tri::*;
use crate::vec::*;

/// How deep under each triangle a crossing is looked for (mm).
pub const SKIN: f64 = 0.03;
/// Slack on what is known exactly (planes, axes, radii): a shaft exactly the size of its hole is clear (mm).
pub const EXACT: f64 = 1e-6;
/// Slack on what is read from mesh corners, which are single precision (mm).
pub const CORNER: f64 = 2e-4;
/// How deep an overlap may be and still count as a film (mm), tried in turn: a screw a few ten-thousandths of a
/// millimetre off the axis of a hole its own size overlaps it, by a sliver far below anything that matters. The
/// deepest stays well under SKIN, so that anything deeper still shows as skins that meet.
pub const FILM: [f64; 4] = [3e-4, 1e-3, 3.5e-3, 1.2e-2];
/// Two unit directions whose cross product is shorter than this are parallel.
const PARALLEL: f64 = 1e-9;
/// More pairs of close triangles than this and the kernel is asked instead.
const MAX_CANDIDATES: u32 = 300_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Why {
    /// proved: the parts do not overlap
    Clear = 0,
    /// a mesh is not a closed surface wound one way, so nothing can be proved from it
    Open = 1,
    /// too many close triangles
    TooMany = 2,
    /// two triangles that could not be shown clear of each other
    Close = 3,
    /// a piece of one part may lie inside the other
    Inside = 4,
    /// proved: the parts overlap by no more than a film, at most `depth` deep and `volume` in all
    Shallow = 5,
}

#[derive(Clone, Copy, Debug)]
pub struct Outcome {
    pub why: Why,
    /// pairs of triangles looked at
    pub candidates: u32,
    /// for `Close`: the kinds of the two faces (`Face::kind`), the triangles, and how far apart they are
    pub kinds: [u8; 2],
    pub tris: [u32; 2],
    pub gap: f64,
    /// for `Shallow`: the deepest the overlap can be, and the most there can be of it (mm, mm³)
    pub depth: f64,
    pub volume: f64,
}

impl Outcome {
    fn of(why: Why) -> Outcome {
        Outcome { why, candidates: 0, kinds: [0; 2], tris: [0; 2], gap: 0.0, depth: 0.0, volume: 0.0 }
    }
    pub fn clear(&self) -> bool {
        self.why == Why::Clear
    }
    /// The most the two parts can overlap by (mm³), where that is proved.
    pub fn volume_bound(&self) -> Option<f64> {
        match self.why {
            Why::Clear => Some(0.0),
            Why::Shallow => Some(self.volume),
            _ => None,
        }
    }
}

/// A hole in a flat face, in the first part's coordinates: a point on its axis, the axis, the radius.
type Bore = (V3, V3, f64);

/// One triangle of a part with what is known about it, in the first part's coordinates.
struct Side<'a> {
    tri: &'a Tri,
    /// the triangle's own unit normal, out of the solid (zero for a sliver)
    n: V3,
    face: Face,
    /// for a flat triangle: the holes it reaches into, where its face has no material
    holes: Vec<Bore>,
    /// for a flat triangle on the end of a shaft or cone: the round faces the material under it stays inside
    caps: Vec<Round>,
    /// for a round triangle whose face ends at a flat face: how far along its axis its material can be
    ends: (f64, f64),
}

fn place(f: &Face, x: &Xf) -> Face {
    match *f {
        Face::Plane { n, d } => {
            let n2 = x.dir(n);
            Face::Plane { n: n2, d: d + dot(n2, x.t) }
        }
        Face::Round { o, dir, r, slope, convex, sag } => Face::Round { o: x.point(o), dir: x.dir(dir), r, slope, convex, sag },
        Face::Ball { c, r, convex, sag } => Face::Ball { c: x.point(c), r, convex, sag },
        Face::Other { sag } => Face::Other { sag },
    }
}

/// How far from its triangle a face's skin can reach.
#[inline]
fn reach(f: &Face) -> f64 {
    f.out().max(SKIN + f.behind()) + CORNER
}

/// The part of `v - o` across the line along unit `dir`.
#[inline]
fn across(o: V3, dir: V3, v: V3) -> V3 {
    let w = sub(v, o);
    sub(w, scale(dir, dot(w, dir)))
}

fn holes_of(g: &Geom, t: u32, x: Option<&Xf>) -> Vec<Bore> {
    match g.tri_holes.get(&t) {
        None => Vec::new(),
        Some(ids) => ids
            .iter()
            .map(|&h| {
                let h = &g.holes[h as usize];
                match x {
                    Some(x) => (x.point(h.c), x.dir(h.dir), h.r),
                    None => (h.c, h.dir, h.r),
                }
            })
            .collect(),
    }
}

fn caps_of(g: &Geom, t: u32, x: Option<&Xf>) -> Vec<Round> {
    match g.caps.get(&g.face_of[t as usize]) {
        None => Vec::new(),
        Some(ids) => ids
            .iter()
            .filter_map(|&f| {
                round(&match x {
                    Some(x) => place(&g.faces[f as usize], x),
                    None => g.faces[f as usize],
                })
            })
            .collect(),
    }
}

/// The most of a triangle's skin that can be seen from any side: its area and half its rim's.
#[inline]
fn seen(t: &Tri, f: &Face) -> f64 {
    let edges = len(sub(t[1], t[0])) + len(sub(t[2], t[1])) + len(sub(t[0], t[2]));
    0.5 * len(cross(sub(t[1], t[0]), sub(t[2], t[0]))) + 0.5 * (f.out() + SKIN + f.behind()) * edges
}

/// How much film there can be under one triangle: no more than its skin holds at the deepest film it met, and no
/// more than its pairs add up to.
#[derive(Default, Clone, Copy)]
struct Film {
    sum: f64,
    deepest: f64,
}

/// Whether the two parts are proved not to overlap. `x` places `b` in `a`'s coordinates.
pub fn classify(a: &Geom, b: &Geom, x: &Xf) -> Outcome {
    if !a.closed || !b.closed {
        return Outcome::of(Why::Open);
    }
    let mut out = Outcome::of(Why::Clear);
    let gap = 2.0 * (SKIN + CORNER) + a.reach + b.reach;
    let mut placed: Vec<Option<Face>> = vec![None; b.faces.len()];
    // triangles that are clear only allowing a film, with how much film there can be under each
    let mut film_a: HashMap<u32, Film> = HashMap::new();
    let mut film_b: HashMap<u32, Film> = HashMap::new();
    a.bvh.pairs_within(&a.tris, &b.bvh, &b.tris, x, gap, |ta, tb, tri_b, d2| {
        let fa = *a.face(ta);
        let fi = b.face_of[tb as usize] as usize;
        let fb = *placed[fi].get_or_insert_with(|| place(&b.faces[fi], x));
        let r = reach(&fa) + reach(&fb);
        if d2 > r * r {
            return true;
        }
        out.candidates += 1;
        if out.candidates > MAX_CANDIDATES {
            out.why = Why::TooMany;
            return false;
        }
        let free = (f64::NEG_INFINITY, f64::INFINITY);
        let sa = Side { tri: &a.tris[ta as usize], n: a.normals[ta as usize], face: fa, holes: holes_of(a, ta, None), caps: caps_of(a, ta, None), ends: *a.ends.get(&a.face_of[ta as usize]).unwrap_or(&free) };
        let sb = Side { tri: tri_b, n: x.dir(b.normals[tb as usize]), face: fb, holes: holes_of(b, tb, Some(x)), caps: caps_of(b, tb, Some(x)), ends: *b.ends.get(&(fi as u32)).unwrap_or(&free) };
        if pair_clear(&sa, &sb, 0.0).is_some() {
            return true;
        }
        for film in FILM {
            if let Some((across, thick)) = pair_clear(&sa, &sb, film) {
                out.depth = out.depth.max(thick);
                for (map, t) in [(&mut film_a, ta), (&mut film_b, tb)] {
                    let f = map.entry(t).or_default();
                    f.sum += across * thick;
                    f.deepest = f.deepest.max(thick);
                }
                return true;
            }
        }
        out.why = Why::Close;
        out.kinds = [fa.kind(), fb.kind()];
        out.tris = [ta, tb];
        out.gap = d2.sqrt();
        false
    });
    if out.why != Why::Clear {
        return out;
    }
    // no surface crosses the other: each piece is wholly outside the other part or wholly inside it
    let back = x.inverse();
    match (holds(a, b, x), holds(b, a, &back)) {
        (Some(false), Some(false)) => {}
        _ => {
            out.why = Why::Inside;
            return out;
        }
    }
    if out.depth > 0.0 {
        // the film lies under a's surface and under b's: whichever has less room for it bounds it
        out.why = Why::Shallow;
        let under_a: f64 = film_a.iter().map(|(&t, f)| f.sum.min(f.deepest * seen(&a.tris[t as usize], a.face(t)))).sum();
        let under_b: f64 = film_b.iter().map(|(&t, f)| f.sum.min(f.deepest * seen(&b.tris[t as usize], b.face(t)))).sum();
        out.volume = under_a.min(under_b);
    }
    out
}

/// A face of the second part as the first sees it.
pub fn placed(f: &Face, x: &Xf) -> Face {
    place(f, x)
}

/// For working on the classifier: the pairs of faces it cannot show clear of each other (not even allowing a
/// film), one line each with the first pair of triangles that failed and how many did, up to `limit` lines.
pub fn explain(a: &Geom, b: &Geom, x: &Xf, limit: usize) -> Vec<String> {
    let gap = 2.0 * (SKIN + CORNER) + a.reach + b.reach;
    let mut failed: Vec<((u32, u32), (u32, u32, f64, u32))> = Vec::new();
    // pairs of faces with a film between them: how many pairs of triangles, the volume they add up to, the deepest
    let mut films: Vec<((u32, u32), (u32, f64, f64))> = Vec::new();
    a.bvh.pairs_within(&a.tris, &b.bvh, &b.tris, x, gap, |ta, tb, tri_b, d2| {
        let fa = *a.face(ta);
        let fi = b.face_of[tb as usize];
        let fb = place(&b.faces[fi as usize], x);
        let r = reach(&fa) + reach(&fb);
        if d2 > r * r {
            return true;
        }
        let free = (f64::NEG_INFINITY, f64::INFINITY);
        let sa = Side { tri: &a.tris[ta as usize], n: a.normals[ta as usize], face: fa, holes: holes_of(a, ta, None), caps: caps_of(a, ta, None), ends: *a.ends.get(&a.face_of[ta as usize]).unwrap_or(&free) };
        let sb = Side { tri: tri_b, n: x.dir(b.normals[tb as usize]), face: fb, holes: holes_of(b, tb, Some(x)), caps: caps_of(b, tb, Some(x)), ends: *b.ends.get(&fi).unwrap_or(&free) };
        if pair_clear(&sa, &sb, 0.0).is_some() {
            return true;
        }
        let key = (a.face_of[ta as usize], fi);
        if let Some((across, thick)) = FILM.iter().find_map(|&film| pair_clear(&sa, &sb, film)) {
            match films.iter_mut().find(|(k, _)| *k == key) {
                Some((_, v)) => {
                    v.0 += 1;
                    v.1 += across * thick;
                    v.2 = v.2.max(thick);
                }
                None => films.push((key, (1, across * thick, thick))),
            }
            return true;
        }
        match failed.iter_mut().find(|(k, _)| *k == key) {
            Some((_, v)) => v.3 += 1,
            None => failed.push((key, (ta, tb, d2.sqrt(), 1))),
        }
        true
    });
    failed
        .iter()
        .take(limit)
        .map(|&((fa, fb), (ta, tb, gap, n))| {
            let sa = &a.tris[ta as usize];
            let sb = b.tris[tb as usize].map(|v| x.point(v));
            format!(
                "faces {fa} x {fb}: {n} triangle pairs, first {ta} x {tb} {gap:.5} apart\n  a: {:?} ends {:?} holes {} caps {}\n     {:?}\n  b: {:?} ends {:?} holes {} caps {}\n     {:?}",
                a.faces[fa as usize],
                a.ends.get(&fa),
                holes_of(a, ta, None).len(),
                caps_of(a, ta, None).len(),
                sa,
                place(&b.faces[fb as usize], x),
                b.ends.get(&fb),
                holes_of(b, tb, Some(x)).len(),
                caps_of(b, tb, Some(x)).len(),
                sb
            )
        })
        .chain(std::iter::once(format!("{} pairs of faces not cleared", failed.len())))
        .chain(films.iter().take(limit).map(|&((fa, fb), (n, vol, thick))| {
            format!("film between faces {fa} x {fb}: {n} triangle pairs adding up to {vol:.4} mm3, at most {thick:.6} thick\n  a: {:?}\n  b: {:?}", a.faces[fa as usize], place(&b.faces[fb as usize], x))
        }))
        .collect()
}

/// Whether a piece of `inner` lies inside `outer`. `x` places `inner` in `outer`'s coordinates. None: cannot tell.
fn holds(outer: &Geom, inner: &Geom, x: &Xf) -> Option<bool> {
    let bounds = outer.bvh.bounds();
    'pieces: for points in &inner.inner {
        for p in points {
            let p = x.point(*p);
            if (0..3).any(|k| p[k] < bounds.lo[k] - outer.reach || p[k] > bounds.hi[k] + outer.reach) {
                continue 'pieces;
            }
            // right at the other part's surface the mesh cannot say which side of the true surface this is
            if outer.at_surface(p, FILM[FILM.len() - 1] + CORNER) {
                continue;
            }
            if outer.contains(p)? {
                return Some(true);
            }
            continue 'pieces;
        }
        return None;
    }
    Some(false)
}

/// Whether the skins under two triangles are clear of each other, allowing an overlap `film` deep. When they are:
/// the most area the overlap can have and how thick it can be (which matter only for a film).
fn pair_clear(a: &Side, b: &Side, film: f64) -> Option<(f64, f64)> {
    let quick = match (&a.face, &b.face) {
        (Face::Round { .. }, Face::Round { .. }) => round_round(a, b, film),
        (Face::Round { .. }, Face::Plane { .. }) => round_flat(a, b, film),
        (Face::Plane { .. }, Face::Round { .. }) => round_flat(b, a, film),
        (Face::Ball { .. }, Face::Round { .. }) => ball_round(a, b, film),
        (Face::Round { .. }, Face::Ball { .. }) => ball_round(b, a, film),
        (Face::Ball { .. }, _) | (_, Face::Ball { .. }) => ball(a, b, film),
        _ => None,
    };
    quick
        .or_else(|| in_hole(a, b, film))
        .or_else(|| in_hole(b, a, film))
        .or_else(|| beside_round(a, b, film))
        .or_else(|| beside_round(b, a, film))
        .or_else(|| in_socket(a, b, film))
        .or_else(|| in_socket(b, a, film))
        .or_else(|| skins_clear(a, b, film))
}

/// How far the line through `o` along unit `dir` is from the six corners of a skin and everything between them
/// (0 when it passes through).
fn line_to_skin(o: V3, dir: V3, v: &[V3; 6]) -> f64 {
    // seen along the line the skin is the hull of six points, and the line is the origin
    let p = v.map(|q| across(o, dir, q));
    // a frame across the line
    let far = p.iter().copied().fold([0.0; 3], |m, q| if len2(q) > len2(m) { q } else { m });
    if len2(far) < 1e-24 {
        return 0.0;
    }
    let e1 = unit(far);
    let e2 = cross(dir, e1);
    // the origin is inside the hull unless the six points all lie within half a turn of each other
    let mut turns = [0.0f64; 6];
    for (k, q) in p.iter().enumerate() {
        if len2(*q) < 1e-24 {
            return 0.0;
        }
        turns[k] = dot(*q, e2).atan2(dot(*q, e1));
    }
    turns.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut gap = turns[0] + std::f64::consts::TAU - turns[5];
    for k in 0..5 {
        gap = gap.max(turns[k + 1] - turns[k]);
    }
    if gap < std::f64::consts::PI - 1e-9 {
        return 0.0;
    }
    // outside it: the nearest of the hull's edges, which are among the lines between its corners
    let mut best = f64::INFINITY;
    for i in 0..6 {
        for j in i + 1..6 {
            let e = sub(p[j], p[i]);
            let l2 = len2(e);
            let t = if l2 > 0.0 { (-dot(p[i], e) / l2).clamp(0.0, 1.0) } else { 0.0 };
            best = best.min(len(add(p[i], scale(e, t))));
        }
    }
    best
}

/// A round face against anything at all. The material under a triangle of a shaft stays inside the shaft's radius
/// there, so it is clear of a skin that stays outside that radius; the material under a triangle of a hole stays
/// outside the hole's radius, so it is clear of a skin that stays inside it. When clear: the most area a film
/// between them can have, and how thick.
fn beside_round(c: &Side, q: &Side, film: f64) -> Option<(f64, f64)> {
    let rc = round(&c.face)?;
    let (least, most) = rc.ends(c.tri);
    let pq = prism(q);
    let clear = if rc.convex {
        most > 0.0 && line_to_skin(rc.o, rc.dir, &pq.v) - pq.pad >= most - CORNER - film
    } else {
        // inside a circle is all of a piece: the corners decide
        least > 0.0 && pq.v.iter().all(|v| len(across(rc.o, rc.dir, *v)) + pq.pad <= least + CORNER + film)
    };
    clear.then(|| (seen(c.tri, &c.face).min(seen(q.tri, &q.face)), CORNER + film))
}

/// How wide a triangle is seen along a line.
fn width(o: V3, dir: V3, t: &Tri) -> f64 {
    let v = [across(o, dir, t[0]), across(o, dir, t[1]), across(o, dir, t[2])];
    len(sub(v[1], v[0])).max(len(sub(v[2], v[1]))).max(len(sub(v[0], v[2])))
}

/// Where a triangle's corners lie along a line.
fn along(o: V3, dir: V3, t: &Tri) -> (f64, f64) {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for v in t {
        let z = dot(sub(*v, o), dir);
        lo = lo.min(z);
        hi = hi.max(z);
    }
    (lo, hi)
}

/// A cylinder or a cone.
#[derive(Clone, Copy)]
struct Round {
    o: V3,
    dir: V3,
    r: f64,
    slope: f64,
    convex: bool,
    sag: f64,
}

fn round(f: &Face) -> Option<Round> {
    match *f {
        Face::Round { o, dir, r, slope, convex, sag } => Some(Round { o, dir, r, slope, convex, sag }),
        _ => None,
    }
}

impl Round {
    /// Where along the axis (measured from `o` along `dir` of the line given) the material under a triangle of this
    /// face can be. Under a cylinder it is straight in from the triangle; under a cone it leans along the axis.
    /// `ends` is where the face's own flat ends stop its material (along its own axis from its own `o`).
    fn range(&self, o: V3, dir: V3, t: &Tri, ends: (f64, f64)) -> (f64, f64) {
        let (lo, hi) = along(self.o, self.dir, t);
        // into the material is toward the axis for a shaft and away from it for a hole, and for a cone also along
        // the axis: toward the wide end of a shaft, the narrow end of a hole. It stops at a flat end.
        let lean = (if self.convex { self.slope } else { -self.slope }) / (1.0 + self.slope * self.slope).sqrt() * SKIN;
        let (lo, hi) = ((lo + lean.min(0.0)).max(lo.min(ends.0)), (hi + lean.max(0.0)).min(hi.max(ends.1)));
        // on the line asked for
        let start = dot(sub(self.o, o), dir);
        if dot(self.dir, dir) > 0.0 {
            (start + lo, start + hi)
        } else {
            (start - hi, start - lo)
        }
    }
    /// The radii at the two ends of a triangle of this face. The material under the triangle of a shaft stays
    /// inside the larger; that of a hole stays outside the smaller.
    fn ends(&self, t: &Tri) -> (f64, f64) {
        let (lo, hi) = along(self.o, self.dir, t);
        let (a, b) = (self.r + self.slope * lo, self.r + self.slope * hi);
        (a.min(b), a.max(b))
    }
}

/// Whether a shaft stays inside a hole about a parallel line, all along the stretch `z0..z1` of the hole's axis.
/// `most` is a radius the shaft's material is known to stay inside, `least` one the hole's stays outside (apart
/// from what their slopes say). Radii are straight lines along the axis, so the ends of the stretch decide.
fn shaft_in_hole(shaft: &Round, most: Option<f64>, hole: &Round, least: Option<f64>, z0: f64, z1: f64, film: f64) -> bool {
    let apart = len(across(hole.o, hole.dir, shaft.o));
    let turn = if dot(hole.dir, shaft.dir) > 0.0 { 1.0 } else { -1.0 };
    let start = dot(sub(shaft.o, hole.o), hole.dir);
    let rs = |z: f64| shaft.r + shaft.slope * turn * (z - start);
    let rh = |z: f64| hole.r + hole.slope * z;
    let room = EXACT + film;
    let (s0, s1, h0, h1) = (rs(z0), rs(z1), rh(z0), rh(z1));
    let real = s0 > 0.0 && s1 > 0.0 && h0 > 0.0 && h1 > 0.0;
    if real && apart + s0 <= h0 + room && apart + s1 <= h1 + room {
        return true;
    }
    match (most, least) {
        (Some(m), Some(l)) if apart + m <= l + room => return true,
        _ => {}
    }
    if let Some(m) = most {
        if h0 > 0.0 && h1 > 0.0 && apart + m <= h0.min(h1) + room {
            return true;
        }
    }
    if let Some(l) = least {
        if s0 > 0.0 && s1 > 0.0 && apart + s0.max(s1) <= l + room {
            return true;
        }
    }
    false
}

/// Two round faces about parallel lines. When clear: the most area a film between them can have, and how thick.
fn round_round(a: &Side, b: &Side, film: f64) -> Option<(f64, f64)> {
    let (ra, rb) = (round(&a.face)?, round(&b.face)?);
    if len(cross(ra.dir, rb.dir)) > PARALLEL {
        return None;
    }
    // one further along than the other
    let (a0, a1) = ra.range(ra.o, ra.dir, a.tri, a.ends);
    let (b0, b1) = rb.range(ra.o, ra.dir, b.tri, b.ends);
    let narrow = width(ra.o, ra.dir, a.tri).min(width(ra.o, ra.dir, b.tri));
    if a1 <= b0 + 2.0 * CORNER + film || b1 <= a0 + 2.0 * CORNER + film {
        return Some((narrow * (SKIN + ra.sag).min(SKIN + rb.sag), 2.0 * CORNER + film));
    }
    let fits = match (ra.convex, rb.convex) {
        (true, false) => {
            let (z0, z1) = rb.range(rb.o, rb.dir, b.tri, b.ends);
            let (w0, w1) = ra.range(rb.o, rb.dir, a.tri, a.ends);
            shaft_in_hole(&ra, Some(ra.ends(a.tri).1), &rb, Some(rb.ends(b.tri).0), z0.max(w0), z1.min(w1), film)
        }
        (false, true) => shaft_in_hole(&rb, Some(rb.ends(b.tri).1), &ra, Some(ra.ends(a.tri).0), a0.max(b0), a1.min(b1), film),
        (true, true) => {
            // two shafts side by side: no nearer than their radii, at both ends of the stretch they share
            let apart = len(across(ra.o, ra.dir, rb.o));
            let turn = if dot(ra.dir, rb.dir) > 0.0 { 1.0 } else { -1.0 };
            let start = dot(sub(rb.o, ra.o), ra.dir);
            let wide = |z: f64| (ra.r + ra.slope * z).max(0.0) + (rb.r + rb.slope * turn * (z - start)).max(0.0);
            let room = EXACT + film;
            apart >= ra.ends(a.tri).1 + rb.ends(b.tri).1 - room || (apart >= wide(a0.max(b0)) - room && apart >= wide(a1.min(b1)) - room)
        }
        (false, false) => false,
    };
    // a film between them lies along the stretch they share, no wider than the narrower triangle
    let slant = (1.0 + ra.slope * ra.slope).sqrt().max((1.0 + rb.slope * rb.slope).sqrt());
    fits.then(|| (narrow * (a1.min(b1) - a0.max(b0)).max(0.0) * slant, EXACT + film))
}

/// A round face `c` against a flat face `p` square to its axis, or along it. When clear: the most area a film
/// between them can have, and how thick.
fn round_flat(c: &Side, p: &Side, film: f64) -> Option<(f64, f64)> {
    let (rc, Face::Plane { n, d }) = (round(&c.face)?, p.face) else { return None };
    let k = dot(rc.dir, n);
    if len(cross(rc.dir, n)) <= PARALLEL {
        // the flat face is square to the axis: its skin is a slab along the axis
        let top = (if k > 0.0 { d } else { -d }) - dot(rc.dir, rc.o);
        let (lo, hi) = if k > 0.0 { (top - SKIN, top) } else { (top, top + SKIN) };
        let (c0, c1) = rc.range(rc.o, rc.dir, c.tri, c.ends);
        let wide = width(rc.o, rc.dir, c.tri);
        if c1 <= lo + CORNER + EXACT + film || hi <= c0 + CORNER + EXACT + film {
            return Some((seen(c.tri, &c.face).min(seen(p.tri, &p.face)), CORNER + EXACT + film));
        }
        // the round face's radius over the stretch of axis they share
        let (z0, z1) = (lo.max(c0), hi.min(c1));
        let (r0, r1) = (rc.r + rc.slope * z0, rc.r + rc.slope * z1);
        let (least, most) = rc.ends(c.tri);
        // a film between them is a strip along the round face, as deep as the flat face's skin
        let strip = (wide + 2.0 * SKIN) * (SKIN * (1.0 + rc.slope.abs()));
        // seen along the axis: how near the axis and how far from it the flat triangle's material is
        let flat = [across(rc.o, rc.dir, p.tri[0]), across(rc.o, rc.dir, p.tri[1]), across(rc.o, rc.dir, p.tri[2])];
        if rc.convex {
            // a shaft: clear of whatever stays outside its radius, as the face round a hole it passes through does
            let widest = if r0 > 0.0 && r1 > 0.0 { r0.max(r1).min(most) } else { most };
            for &(ho, hd, hr) in &p.holes {
                if len(cross(hd, rc.dir)) <= PARALLEL && hr - len(across(rc.o, rc.dir, ho)) >= widest - EXACT - film {
                    return Some((strip, EXACT + film));
                }
            }
            (point_tri_dist2([0.0; 3], &flat).sqrt() >= widest - CORNER - film).then_some((strip, CORNER + film))
        } else {
            // a hole: clear of whatever stays inside its radius, as the end of a shaft or a cone sitting in it does
            for own in &p.caps {
                if len(cross(own.dir, rc.dir)) <= PARALLEL && shaft_in_hole(own, None, &rc, Some(least), z0, z1, film) {
                    return Some((strip, EXACT + film));
                }
            }
            let narrowest = if r0 > 0.0 && r1 > 0.0 { r0.min(r1).max(least) } else { least };
            flat.iter().all(|v| len(*v) <= narrowest + CORNER + film).then_some((strip, CORNER + film))
        }
    } else if k.abs() <= PARALLEL && rc.slope == 0.0 {
        // a shaft lying along a flat face: its axis is at least its radius above the face
        (rc.convex && dot(n, rc.o) - d >= rc.r - EXACT - film).then(|| (seen(c.tri, &c.face).min(seen(p.tri, &p.face)), EXACT + film))
    } else {
        None
    }
}

/// A ball in a socket, two balls side by side, a ball resting on a flat face.
fn ball(a: &Side, b: &Side, film: f64) -> Option<(f64, f64)> {
    let room = EXACT + film;
    let clear = match (a.face, b.face) {
        (Face::Ball { c: ca, r: ra, convex: xa, .. }, Face::Ball { c: cb, r: rb, convex: xb, .. }) => {
            let apart = len(sub(ca, cb));
            match (xa, xb) {
                (true, false) => apart + ra <= rb + room,
                (false, true) => apart + rb <= ra + room,
                (true, true) => apart >= ra + rb - room,
                (false, false) => false,
            }
        }
        (Face::Ball { c, r, convex: true, .. }, Face::Plane { n, d }) | (Face::Plane { n, d }, Face::Ball { c, r, convex: true, .. }) => dot(n, c) - d >= r - room,
        _ => false,
    };
    clear.then(|| (seen(a.tri, &a.face).min(seen(b.tri, &b.face)), room))
}

/// A ball against a straight round face whose axis passes it: a ball end sitting in a bore, a shaft reaching into
/// a socket. Seen along the axis the ball is a circle that changes with the height, so over the stretch of axis
/// the two triangles share it is the ball at its widest that has to fit a hole, and a socket at its narrowest
/// that has to take a shaft.
fn ball_round(s: &Side, c: &Side, film: f64) -> Option<(f64, f64)> {
    let Face::Ball { c: centre, r, convex, sag } = s.face else { return None };
    let rc = round(&c.face)?;
    if rc.slope != 0.0 || convex == rc.convex {
        return None;
    }
    let off = len(across(rc.o, rc.dir, centre));
    let at = dot(sub(centre, rc.o), rc.dir);
    // where along the axis the material under each triangle can be
    let (c0, c1) = rc.range(rc.o, rc.dir, c.tri, c.ends);
    let (b0, b1) = along(rc.o, rc.dir, s.tri);
    let grow = SKIN + sag + CORNER;
    let (z0, z1) = (c0.max(b0 - grow), c1.min(b1 + grow));
    if z1 < z0 {
        return None;
    }
    let room = EXACT + film;
    let fits = if convex {
        // a ball in a hole: the ball is widest nearest its centre
        let h = if z0 <= at && at <= z1 { 0.0 } else { (z0 - at).abs().min((z1 - at).abs()) };
        off + (r * r - h * h).max(0.0).sqrt() <= rc.r + room
    } else {
        // a shaft in a socket: the socket is narrowest furthest from its centre
        let h = (z0 - at).abs().max((z1 - at).abs());
        h < r && off + rc.r <= (r * r - h * h).sqrt() + room
    };
    fits.then(|| (seen(s.tri, &s.face).min(seen(c.tri, &c.face)), room))
}

/// The material round a socket stays outside the socket's sphere, so it is clear of a skin that stays inside it.
/// When clear: the most area a film between them can have, and how thick.
fn in_socket(s: &Side, q: &Side, film: f64) -> Option<(f64, f64)> {
    let Face::Ball { c, r, convex: false, .. } = s.face else { return None };
    let pq = prism(q);
    // inside a sphere is all of a piece: the corners decide
    pq.v.iter().all(|v| len(sub(*v, c)) + pq.pad <= r + CORNER + film).then(|| (seen(s.tri, &s.face).min(seen(q.tri, &q.face)), CORNER + film))
}

/// The skin under a triangle: the triangle pushed out by as far as the true surface can be outside it, and in by
/// SKIN beyond as far as the true surface can be behind it.
struct Prism {
    v: [V3; 6],
    n: V3,
    /// the triangle's edges: unit directions and lengths
    e: [V3; 3],
    lens: [f64; 3],
    area: f64,
    /// how tall: out plus in
    tall: f64,
    /// on an exact plane
    exact: bool,
    /// grown this much all round (a sliver has no direction to push along)
    pad: f64,
}

fn prism(s: &Side) -> Prism {
    let (t, n, up, down, exact) = match s.face {
        // the corners moved onto the exact plane
        Face::Plane { n, d } => (s.tri.map(|v| sub(v, scale(n, dot(n, v) - d))), n, 0.0, SKIN, true),
        f => (*s.tri, s.n, f.out(), SKIN + f.behind(), false),
    };
    let pad = if len2(n) < 0.5 { up.max(down) } else { 0.0 };
    let (a, b) = (scale(n, up), scale(n, -down));
    let sides = [sub(t[1], t[0]), sub(t[2], t[1]), sub(t[0], t[2])];
    Prism {
        v: [add(t[0], a), add(t[1], a), add(t[2], a), add(t[0], b), add(t[1], b), add(t[2], b)],
        n,
        e: sides.map(unit),
        lens: sides.map(len),
        area: 0.5 * len(cross(sides[0], sides[1])),
        tall: up + down,
        exact,
        pad,
    }
}

impl Prism {
    /// How much of an overlap along unit `u` is within what the numbers can tell.
    #[inline]
    fn slack(&self, u: V3) -> f64 {
        if self.exact {
            let k = dot(u, self.n).abs().min(1.0);
            EXACT * k + CORNER * (1.0 - k * k).max(0.0).sqrt()
        } else {
            CORNER
        }
    }
    #[inline]
    fn span(&self, u: V3) -> (f64, f64) {
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for v in &self.v {
            let d = dot(*v, u);
            lo = lo.min(d);
            hi = hi.max(d);
        }
        (lo - self.pad, hi + self.pad)
    }
    /// How big the skin looks seen along unit `u`.
    fn shadow(&self, u: V3) -> f64 {
        if self.pad > 0.0 {
            return self.area + 0.5 * (self.tall + 2.0 * self.pad) * (self.lens[0] + self.lens[1] + self.lens[2]) + 4.0 * self.pad * self.pad;
        }
        let mut walls = 0.0;
        for i in 0..3 {
            walls += self.lens[i] * dot(u, cross(self.e[i], self.n)).abs();
        }
        self.area * dot(u, self.n).abs() + 0.5 * self.tall * walls
    }
}

/// Whether the skins under two triangles are clear of each other: some direction separates them (to within
/// `film`). When one does: the most area the overlap can have across it, and how thick it can be along it.
fn skins_clear(a: &Side, b: &Side, film: f64) -> Option<(f64, f64)> {
    let (pa, pb) = (prism(a), prism(b));
    let splits = |u: V3| -> Option<(f64, f64)> {
        let l2 = len2(u);
        if l2 < 1e-20 {
            return None;
        }
        let u = scale(u, 1.0 / l2.sqrt());
        let (a0, a1) = pa.span(u);
        let (b0, b1) = pb.span(u);
        let slack = pa.slack(u) + pb.slack(u) + film;
        if b0 - a1 >= -slack || a0 - b1 >= -slack {
            Some((pa.shadow(u).min(pb.shadow(u)), slack))
        } else {
            None
        }
    };
    let mut axes: Vec<V3> = Vec::with_capacity(24);
    axes.extend([pa.n, pb.n, cross(pa.n, pb.n)]);
    for i in 0..3 {
        axes.extend([cross(pa.e[i], pa.n), cross(pb.e[i], pb.n), cross(pa.e[i], pb.n), cross(pa.n, pb.e[i])]);
        for j in 0..3 {
            axes.push(cross(pa.e[i], pb.e[j]));
        }
    }
    if film == 0.0 {
        return axes.into_iter().find_map(splits);
    }
    // a film: the direction it is smallest across
    axes.into_iter().filter_map(splits).min_by(|x, y| (x.0 * x.1).partial_cmp(&(y.0 * y.1)).unwrap_or(std::cmp::Ordering::Equal))
}

/// A flat face round a hole has no material inside the hole's radius, so it is clear of anything that stays inside.
/// When clear: the most area a film between them can have, and how thick.
fn in_hole(p: &Side, q: &Side, film: f64) -> Option<(f64, f64)> {
    for &(o, dir, r) in &p.holes {
        if let Some(rq) = round(&q.face) {
            // a shaft on a parallel line: as wide as it gets under this triangle
            if rq.convex && len(cross(dir, rq.dir)) <= PARALLEL && len(across(o, dir, rq.o)) + rq.ends(q.tri).1 <= r + EXACT + film {
                return Some(((width(o, dir, q.tri) + 2.0 * SKIN) * (SKIN * (1.0 + rq.slope.abs())), EXACT + film));
            }
        }
        let pq = prism(q);
        if pq.v.iter().all(|v| len(across(o, dir, *v)) + pq.pad <= r + CORNER + film) {
            return Some((seen(p.tri, &p.face).min(seen(q.tri, &q.face)), CORNER + film));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::testing::Builder;

    fn shift(t: V3) -> Xf {
        Xf { l: Xf::IDENTITY.l, t }
    }
    /// A turn about z by `deg`, then a shift.
    fn turn_z(deg: f64, t: V3) -> Xf {
        let (s, c) = deg.to_radians().sin_cos();
        Xf { l: [c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0], t }
    }

    #[test]
    fn boxes_touching_are_clear_and_overlapping_are_not() {
        let a = Builder::default().cuboid([0.0; 3], [40.0, 30.0, 10.0]).geom();
        let b = Builder::default().cuboid([0.0; 3], [20.0, 20.0, 20.0]).geom();
        // b stands on a
        assert!(classify(&a, &b, &shift([5.0, 5.0, 10.0])).clear());
        // sunk in by a thousandth
        let o = classify(&a, &b, &shift([5.0, 5.0, 9.95]));
        assert_eq!(o.why, Why::Close, "{o:?}");
        // sunk in by a thousandth: a film, over the 20 x 20 where they meet at most
        let o = classify(&a, &b, &shift([5.0, 5.0, 9.999]));
        assert_eq!(o.why, Why::Shallow, "{o:?}");
        // the true overlap is 20 x 20 x 0.001
        assert!(o.depth >= 0.001 && o.volume >= 0.4 && o.volume < 1.0, "{o:?}");
        // lifted by a thousandth
        assert!(classify(&a, &b, &shift([5.0, 5.0, 10.001])).clear());
        // turned on the face, hanging over the edge
        assert!(classify(&a, &b, &turn_z(33.0, [30.0, 20.0, 10.0])).clear());
        // side by side, edges lined up
        assert!(classify(&a, &b, &shift([40.0, 0.0, 0.0])).clear());
        assert_eq!(classify(&a, &b, &shift([39.9, 0.0, 0.0])).why, Why::Close);
        // far apart: nothing to look at
        let far = classify(&a, &b, &shift([100.0, 0.0, 0.0]));
        assert!(far.clear() && far.candidates == 0);
    }

    #[test]
    fn a_part_inside_another_is_not_clear() {
        let a = Builder::default().cuboid([0.0; 3], [40.0, 30.0, 10.0]).geom();
        let b = Builder::default().cuboid([0.0; 3], [2.0, 2.0, 2.0]).geom();
        let o = classify(&a, &b, &shift([10.0, 10.0, 4.0]));
        assert_eq!(o.why, Why::Inside);
        let o = classify(&b, &a, &shift([-10.0, -10.0, -4.0]));
        assert_eq!(o.why, Why::Inside);
    }

    #[test]
    fn a_mirrored_part_is_placed_right() {
        let a = Builder::default().cuboid([0.0; 3], [40.0, 30.0, 10.0]).geom();
        let b = Builder::default().cuboid([0.0; 3], [20.0, 20.0, 20.0]).geom();
        // b mirrored in z hangs under a
        let under = Xf { l: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, -1.0], t: [5.0, 5.0, 0.0] };
        assert!(classify(&a, &b, &under).clear());
        let into = Xf { l: under.l, t: [5.0, 5.0, 0.05] };
        assert_eq!(classify(&a, &b, &into).why, Why::Close);
    }

    #[test]
    fn a_shaft_in_a_hole_its_own_size() {
        let plate = Builder::default().plate_with_hole(0.0, 0.0, 20.0, 5.0, 0.0, 8.0, 14, 0.13).geom();
        assert!(plate.closed);
        // a pin through the plate and out both sides, its flats not lined up with the hole's
        let pin = Builder::default().shaft(0.0, 0.0, 5.0, -4.0, 12.0, 15, 0.0).geom();
        let o = classify(&plate, &pin, &Xf::IDENTITY);
        assert!(o.clear(), "{o:?}");
        assert!(o.candidates > 0);
        assert!(classify(&pin, &plate, &Xf::IDENTITY).clear());
        // too big
        let fat = Builder::default().shaft(0.0, 0.0, 5.05, -4.0, 12.0, 15, 0.0).geom();
        assert_eq!(classify(&plate, &fat, &Xf::IDENTITY).why, Why::Close);
        // smaller, pushed against the wall
        let thin = Builder::default().shaft(0.0, 0.0, 4.9, -4.0, 12.0, 15, 0.0).geom();
        assert!(classify(&plate, &thin, &shift([0.1, 0.0, 0.0])).clear());
        assert_eq!(classify(&plate, &thin, &shift([0.15, 0.0, 0.0])).why, Why::Close);
        // the pin three ten-thousandths off the hole's axis: an overlap, but only a film of it
        let o = classify(&plate, &pin, &shift([0.0003, 0.0, 0.0]));
        assert_eq!(o.why, Why::Shallow, "{o:?}");
        // the true overlap is a crescent 0.0003 deep at its thickest round half the hole's wall (8 mm tall)
        let truth = 0.0003 * 2.0 * 5.0 * 8.0;
        assert!(o.volume > truth && o.volume < 0.25, "{o:?}");
        // turned about the hole's axis, and the whole thing the other way up
        assert!(classify(&plate, &pin, &turn_z(71.0, [0.0; 3])).clear());
        // flush: the pin's ends level with the plate's faces
        let flush = Builder::default().shaft(0.0, 0.0, 5.0, 0.0, 8.0, 15, 0.4).geom();
        let o = classify(&plate, &flush, &Xf::IDENTITY);
        assert!(o.clear(), "{o:?}");
    }

    #[test]
    fn a_bolt_through_a_plate() {
        let plate = Builder::default().plate_with_hole(0.0, 0.0, 20.0, 3.0, 0.0, 8.0, 14, 0.13).geom();
        // shank 3 mm radius through the hole, head sitting on the top face
        let bolt = Builder::default().bolt(0.0, 0.0, 3.0, 5.5, -2.0, 8.0, 12.0, 15, 0.3).geom();
        assert!(bolt.closed);
        let o = classify(&plate, &bolt, &Xf::IDENTITY);
        assert!(o.clear(), "{o:?}");
        // a clearance hole
        let loose = Builder::default().plate_with_hole(0.0, 0.0, 20.0, 3.2, 0.0, 8.0, 14, 0.13).geom();
        assert!(classify(&loose, &bolt, &shift([0.15, 0.0, 0.0])).clear());
        // the head pulled a twentieth into the plate
        let o = classify(&plate, &bolt, &shift([0.0, 0.0, -0.05]));
        assert_eq!(o.why, Why::Close, "{o:?}");
        // the hole too small for the shank
        let tight = Builder::default().plate_with_hole(0.0, 0.0, 20.0, 2.98, 0.0, 8.0, 14, 0.13).geom();
        assert_eq!(classify(&tight, &bolt, &Xf::IDENTITY).why, Why::Close);
        // placed somewhere else, both turned the same way: still clear
        let x = turn_z(40.0, [100.0, -50.0, 20.0]);
        let o = classify(&plate, &bolt, &x.inverse().mul(&x));
        assert!(o.clear(), "{o:?}");
    }

    #[test]
    fn shafts_side_by_side_and_on_a_plane() {
        let a = Builder::default().shaft(0.0, 0.0, 5.0, 0.0, 20.0, 14, 0.0).geom();
        let b = Builder::default().shaft(0.0, 0.0, 3.0, 0.0, 20.0, 15, 0.2).geom();
        assert!(classify(&a, &b, &shift([8.0, 0.0, 0.0])).clear());
        assert_eq!(classify(&a, &b, &shift([7.95, 0.0, 0.0])).why, Why::Close);
        // end to end
        assert!(classify(&a, &b, &shift([0.0, 0.0, 20.0])).clear());
        assert_eq!(classify(&a, &b, &shift([0.0, 0.0, 19.9])).why, Why::Close);
        // a shaft lying on a block: laid along x, resting on z = 0
        let block = Builder::default().cuboid([-30.0, -30.0, -10.0], [30.0, 30.0, 0.0]).geom();
        let lying = Xf { l: [0.0, 0.0, 1.0, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0], t: [-10.0, 0.0, 5.0] };
        let o = classify(&block, &a, &lying);
        assert!(o.clear(), "{o:?}");
        let sunk = Xf { l: lying.l, t: [-10.0, 0.0, 4.95] };
        assert_eq!(classify(&block, &a, &sunk).why, Why::Close);
    }

    #[test]
    fn a_countersunk_screw_seated_in_its_countersink() {
        // a 3 mm shank under a 90 degree head, flush with the top of an 8 mm plate
        let plate = Builder::default().plate_with_countersink(0.0, 0.0, 20.0, 1.5, 3.0, 0.0, 6.5, 8.0, 14, 0.2).geom();
        let screw = Builder::default().countersunk(0.0, 0.0, 1.5, 3.0, -4.0, 6.5, 8.0, 16, 0.0).geom();
        assert!(plate.closed && screw.closed);
        let o = classify(&plate, &screw, &Xf::IDENTITY);
        assert!(o.clear(), "{o:?}");
        assert!(classify(&screw, &plate, &Xf::IDENTITY).clear());
        // standing proud by a tenth: still clear
        assert!(classify(&plate, &screw, &shift([0.0, 0.0, 0.1])).clear());
        // pulled a twentieth too deep: the cones overlap
        let o = classify(&plate, &screw, &shift([0.0, 0.0, -0.05]));
        assert_eq!(o.why, Why::Close, "{o:?}");
        // turned upside down with the plate: the same
        let flip = Xf { l: [1.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0], t: [3.0, 4.0, 5.0] };
        let o = classify(&plate, &screw, &flip.inverse().mul(&flip));
        assert!(o.clear(), "{o:?}");
    }

    #[test]
    fn thin_triangles_beside_a_hole_do_not_block_the_pin() {
        // the plate's faces are meshed with long thin triangles that only touch the hole at a corner and cut across
        // the sliver between the hole's flats and its true circle, as the kernel's mesher does on large faces
        let plate = Builder::default().plate_skewed(0.0, 0.0, 30.0, 5.0, 0.0, 8.0, 14, 0.13).geom();
        assert!(plate.closed);
        assert_eq!(plate.mismatched, 0);
        // more triangles reach into the hole's circle than have an edge on it
        assert!(plate.tri_holes.len() > 2 * 14, "{}", plate.tri_holes.len());
        let pin = Builder::default().shaft(0.0, 0.0, 5.0, -4.0, 12.0, 15, 0.0).geom();
        let o = classify(&plate, &pin, &Xf::IDENTITY);
        assert!(o.clear(), "{o:?}");
        let flush = Builder::default().shaft(0.0, 0.0, 5.0, 0.0, 8.0, 15, 0.4).geom();
        let o = classify(&plate, &flush, &Xf::IDENTITY);
        assert!(o.clear(), "{o:?}");
        let fat = Builder::default().shaft(0.0, 0.0, 5.05, -4.0, 12.0, 15, 0.0).geom();
        assert_eq!(classify(&plate, &fat, &Xf::IDENTITY).why, Why::Close);
    }

    #[test]
    fn a_cone_against_the_plane_it_ends_on() {
        // a countersunk screw head down on a block: the head's cone ends at the flat top, which touches the block
        let screw = Builder::default().countersunk(0.0, 0.0, 1.5, 3.0, -4.0, 6.5, 8.0, 16, 0.0).geom();
        let block = Builder::default().cuboid([-10.0, -10.0, 8.0], [10.0, 10.0, 12.0]).geom();
        let o = classify(&block, &screw, &Xf::IDENTITY);
        assert!(o.clear(), "{o:?}");
        assert_eq!(classify(&block, &screw, &shift([0.0, 0.0, 0.05])).why, Why::Close);
        // a hundredth into it: a film, and how much of one (the head is 3 mm in radius)
        let o = classify(&block, &screw, &shift([0.0, 0.0, 0.01]));
        assert_eq!(o.why, Why::Shallow, "{o:?}");
        let truth = std::f64::consts::PI * 9.0 * 0.01;
        assert!(o.volume > truth && o.volume < 3.0 * truth, "{o:?} against {truth}");
    }
}
