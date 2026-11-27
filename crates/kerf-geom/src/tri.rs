//! Distances between points, segments, lines and triangles.

use crate::vec::*;

pub type Tri = [V3; 3];

/// The closest point of triangle `t` to `p`.
pub fn closest_on_tri(p: V3, t: &Tri) -> V3 {
    // Ericson, Real-Time Collision Detection, 5.1.5
    let (a, b, c) = (t[0], t[1], t[2]);
    let ab = sub(b, a);
    let ac = sub(c, a);
    let ap = sub(p, a);
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }
    let bp = sub(p, b);
    let d3 = dot(ab, bp);
    let d4 = dot(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return add(a, scale(ab, v));
    }
    let cp = sub(p, c);
    let d5 = dot(ab, cp);
    let d6 = dot(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return add(a, scale(ac, w));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return add(b, scale(sub(c, b), w));
    }
    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    add(a, add(scale(ab, v), scale(ac, w)))
}

#[inline]
pub fn point_tri_dist2(p: V3, t: &Tri) -> f64 {
    len2(sub(p, closest_on_tri(p, t)))
}

/// Squared distance between segments p1-q1 and p2-q2.
pub fn seg_seg_dist2(p1: V3, q1: V3, p2: V3, q2: V3) -> f64 {
    // Ericson 5.1.9
    let d1 = sub(q1, p1);
    let d2 = sub(q2, p2);
    let r = sub(p1, p2);
    let a = dot(d1, d1);
    let e = dot(d2, d2);
    let f = dot(d2, r);
    let (s, t);
    const EPS: f64 = 1e-24;
    if a <= EPS && e <= EPS {
        return len2(r);
    }
    if a <= EPS {
        s = 0.0;
        t = (f / e).clamp(0.0, 1.0);
    } else {
        let c = dot(d1, r);
        if e <= EPS {
            t = 0.0;
            s = (-c / a).clamp(0.0, 1.0);
        } else {
            let b = dot(d1, d2);
            let denom = a * e - b * b;
            let mut s0 = if denom > 1e-18 * a * e { ((b * f - c * e) / denom).clamp(0.0, 1.0) } else { 0.0 };
            let mut t0 = (b * s0 + f) / e;
            if t0 < 0.0 {
                t0 = 0.0;
                s0 = (-c / a).clamp(0.0, 1.0);
            } else if t0 > 1.0 {
                t0 = 1.0;
                s0 = ((b - c) / a).clamp(0.0, 1.0);
            }
            s = s0;
            t = t0;
        }
    }
    let c1 = add(p1, scale(d1, s));
    let c2 = add(p2, scale(d2, t));
    len2(sub(c1, c2))
}

/// Whether segment p-q passes through triangle `t` (touching counts).
pub fn seg_hits_tri(p: V3, q: V3, t: &Tri) -> bool {
    let e1 = sub(t[1], t[0]);
    let e2 = sub(t[2], t[0]);
    let d = sub(q, p);
    let h = cross(d, e2);
    let a = dot(e1, h);
    if a.abs() < 1e-18 {
        return false; // parallel: the edge tests of the caller cover a segment lying in the plane
    }
    let f = 1.0 / a;
    let s = sub(p, t[0]);
    let u = f * dot(s, h);
    if !(0.0..=1.0).contains(&u) {
        return false;
    }
    let qv = cross(s, e1);
    let v = f * dot(d, qv);
    if v < 0.0 || u + v > 1.0 {
        return false;
    }
    let tt = f * dot(e2, qv);
    (0.0..=1.0).contains(&tt)
}

/// Squared distance between two triangles (0 when they touch or cross).
pub fn tri_tri_dist2(a: &Tri, b: &Tri) -> f64 {
    for i in 0..3 {
        if seg_hits_tri(a[i], a[(i + 1) % 3], b) || seg_hits_tri(b[i], b[(i + 1) % 3], a) {
            return 0.0;
        }
    }
    let mut best = f64::INFINITY;
    for i in 0..3 {
        best = best.min(point_tri_dist2(a[i], b)).min(point_tri_dist2(b[i], a));
        for j in 0..3 {
            best = best.min(seg_seg_dist2(a[i], a[(i + 1) % 3], b[j], b[(j + 1) % 3]));
        }
    }
    best
}

/// The distance from the line through `o` along unit `d` to the segment p-q.
pub fn line_seg_dist(o: V3, d: V3, p: V3, q: V3) -> f64 {
    // drop the part along the line: the distance between a line and a segment is the distance from the origin to
    // the segment's shadow on the plane across the line
    let pp = sub(p, o);
    let qq = sub(q, o);
    let a = sub(pp, scale(d, dot(pp, d)));
    let b = sub(qq, scale(d, dot(qq, d)));
    let ab = sub(b, a);
    let l2 = len2(ab);
    let t = if l2 > 1e-300 { (-dot(a, ab) / l2).clamp(0.0, 1.0) } else { 0.0 };
    len(add(a, scale(ab, t)))
}

/// The distance from the line through `o` along unit `d` to triangle `t` (0 when the line passes through it).
pub fn line_tri_dist(o: V3, d: V3, t: &Tri) -> f64 {
    // the triangle's shadow on the plane across the line holds the origin when the line pierces it
    let mut s = [[0.0f64; 3]; 3];
    for i in 0..3 {
        let p = sub(t[i], o);
        s[i] = sub(p, scale(d, dot(p, d)));
    }
    let mut pos = 0;
    let mut neg = 0;
    for i in 0..3 {
        let c = dot(cross(s[i], s[(i + 1) % 3]), d);
        if c > 0.0 {
            pos += 1;
        } else if c < 0.0 {
            neg += 1;
        }
    }
    if pos == 0 || neg == 0 {
        // every edge winds the same way round the line (or lies on it): the origin is inside the shadow, unless the
        // shadow is a sliver seen edge on
        let area = len(cross(sub(s[1], s[0]), sub(s[2], s[0])));
        if area > 1e-18 {
            return 0.0;
        }
    }
    let mut best = f64::INFINITY;
    for i in 0..3 {
        best = best.min(line_seg_dist(o, d, t[i], t[(i + 1) % 3]));
    }
    best
}

/// A triangle's unit normal by its winding (zero for a sliver).
#[inline]
pub fn tri_normal(t: &Tri) -> V3 {
    unit(cross(sub(t[1], t[0]), sub(t[2], t[0])))
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: Tri = [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 2.0, 0.0]];

    #[test]
    fn point_to_triangle() {
        assert!((point_tri_dist2([0.5, 0.5, 3.0], &T) - 9.0).abs() < 1e-12);
        assert!((point_tri_dist2([-1.0, -1.0, 0.0], &T) - 2.0).abs() < 1e-12);
        assert!((point_tri_dist2([3.0, 0.0, 0.0], &T) - 1.0).abs() < 1e-12);
        // off the slanted edge
        assert!((point_tri_dist2([2.0, 2.0, 0.0], &T) - 2.0).abs() < 1e-12);
    }

    #[test]
    fn segments() {
        // crossing in the middle, 1 apart
        assert!((seg_seg_dist2([-1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, -1.0, 1.0], [0.0, 1.0, 1.0]) - 1.0).abs() < 1e-12);
        // parallel
        assert!((seg_seg_dist2([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 2.0, 0.0], [1.0, 2.0, 0.0]) - 4.0).abs() < 1e-12);
        // end to end
        assert!((seg_seg_dist2([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [3.0, 0.0, 0.0], [4.0, 0.0, 0.0]) - 4.0).abs() < 1e-12);
    }

    #[test]
    fn triangles() {
        let up: Tri = [[0.0, 0.0, 1.5], [2.0, 0.0, 1.5], [0.0, 2.0, 1.5]];
        assert!((tri_tri_dist2(&T, &up) - 2.25).abs() < 1e-12);
        // one pokes through the other
        let through: Tri = [[0.5, 0.5, -1.0], [0.5, 0.5, 1.0], [5.0, 5.0, 1.0]];
        assert_eq!(tri_tri_dist2(&T, &through), 0.0);
        // side by side in the same plane, 1 apart
        let beside: Tri = [[3.0, 0.0, 0.0], [5.0, 0.0, 0.0], [3.0, 2.0, 0.0]];
        assert!((tri_tri_dist2(&T, &beside) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn line_to_triangle() {
        let z = [0.0, 0.0, 1.0];
        assert_eq!(line_tri_dist([0.5, 0.5, -3.0], z, &T), 0.0);
        assert!((line_tri_dist([-1.0, 0.5, 0.0], z, &T) - 1.0).abs() < 1e-12);
        // a chord of a circle of radius 2 about the z axis: its middle is nearest
        let chord: Tri = [[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [2.0, 2.0, 0.0]];
        assert!((line_tri_dist([0.0, 0.0, 0.0], z, &chord) - 2f64.sqrt()).abs() < 1e-12);
    }
}
