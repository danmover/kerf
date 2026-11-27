//! Small vector and matrix helpers. Everything is f64, in millimetres.

pub type V3 = [f64; 3];

#[inline]
pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
pub fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
#[inline]
pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
pub fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
#[inline]
pub fn len(a: V3) -> f64 {
    dot(a, a).sqrt()
}
#[inline]
pub fn len2(a: V3) -> f64 {
    dot(a, a)
}
/// The unit vector along `a`, or zero when `a` is (nearly) zero.
#[inline]
pub fn unit(a: V3) -> V3 {
    let l = len(a);
    if l > 1e-300 {
        scale(a, 1.0 / l)
    } else {
        [0.0; 3]
    }
}
#[inline]
pub fn lerp(a: V3, b: V3, t: f64) -> V3 {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/// A placement: a 3x3 linear part (a turn, maybe with a mirror) and a shift. `p' = l * p + t`.
#[derive(Clone, Copy, Debug)]
pub struct Xf {
    /// row-major 3x3
    pub l: [f64; 9],
    pub t: V3,
}

impl Xf {
    pub const IDENTITY: Xf = Xf { l: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], t: [0.0; 3] };

    /// From a column-major 4x4 matrix (the layout three.js and Kerf's `xformMatrix` use).
    pub fn from_cols16(m: &[f64]) -> Xf {
        Xf { l: [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]], t: [m[12], m[13], m[14]] }
    }
    #[inline]
    pub fn point(&self, p: V3) -> V3 {
        let l = &self.l;
        [l[0] * p[0] + l[1] * p[1] + l[2] * p[2] + self.t[0], l[3] * p[0] + l[4] * p[1] + l[5] * p[2] + self.t[1], l[6] * p[0] + l[7] * p[1] + l[8] * p[2] + self.t[2]]
    }
    /// A direction: turned (and mirrored), not shifted. Outward normals of a mirrored solid map this way too.
    #[inline]
    pub fn dir(&self, d: V3) -> V3 {
        let l = &self.l;
        [l[0] * d[0] + l[1] * d[1] + l[2] * d[2], l[3] * d[0] + l[4] * d[1] + l[5] * d[2], l[6] * d[0] + l[7] * d[1] + l[8] * d[2]]
    }
    pub fn det(&self) -> f64 {
        let l = &self.l;
        l[0] * (l[4] * l[8] - l[5] * l[7]) - l[1] * (l[3] * l[8] - l[5] * l[6]) + l[2] * (l[3] * l[7] - l[4] * l[6])
    }
    /// `self` after `b`: `(self * b)(p) = self(b(p))`.
    pub fn mul(&self, b: &Xf) -> Xf {
        let a = &self.l;
        let c = &b.l;
        let mut l = [0.0; 9];
        for r in 0..3 {
            for k in 0..3 {
                l[r * 3 + k] = a[r * 3] * c[k] + a[r * 3 + 1] * c[3 + k] + a[r * 3 + 2] * c[6 + k];
            }
        }
        Xf { l, t: self.point(b.t) }
    }
    /// The inverse of a placement (any invertible linear part).
    pub fn inverse(&self) -> Xf {
        let a = &self.l;
        let d = self.det();
        let i = 1.0 / d;
        let l = [
            (a[4] * a[8] - a[5] * a[7]) * i,
            (a[2] * a[7] - a[1] * a[8]) * i,
            (a[1] * a[5] - a[2] * a[4]) * i,
            (a[5] * a[6] - a[3] * a[8]) * i,
            (a[0] * a[8] - a[2] * a[6]) * i,
            (a[2] * a[3] - a[0] * a[5]) * i,
            (a[3] * a[7] - a[4] * a[6]) * i,
            (a[1] * a[6] - a[0] * a[7]) * i,
            (a[0] * a[4] - a[1] * a[3]) * i,
        ];
        let x = Xf { l, t: [0.0; 3] };
        let t = x.dir(self.t);
        Xf { l, t: [-t[0], -t[1], -t[2]] }
    }
    /// |l|: used to carry a box through the placement.
    pub fn abs_linear(&self) -> [f64; 9] {
        let mut a = self.l;
        for v in a.iter_mut() {
            *v = v.abs();
        }
        a
    }
}

/// An axis-aligned box.
#[derive(Clone, Copy, Debug)]
pub struct Aabb {
    pub lo: V3,
    pub hi: V3,
}

impl Aabb {
    pub const EMPTY: Aabb = Aabb { lo: [f64::INFINITY; 3], hi: [f64::NEG_INFINITY; 3] };
    #[inline]
    pub fn grow(&mut self, p: V3) {
        for k in 0..3 {
            if p[k] < self.lo[k] {
                self.lo[k] = p[k];
            }
            if p[k] > self.hi[k] {
                self.hi[k] = p[k];
            }
        }
    }
    #[inline]
    pub fn union(&mut self, o: &Aabb) {
        for k in 0..3 {
            if o.lo[k] < self.lo[k] {
                self.lo[k] = o.lo[k];
            }
            if o.hi[k] > self.hi[k] {
                self.hi[k] = o.hi[k];
            }
        }
    }
    /// The squared gap between two boxes (0 when they overlap).
    #[inline]
    pub fn gap2(&self, o: &Aabb) -> f64 {
        let mut s = 0.0;
        for k in 0..3 {
            let d = (self.lo[k] - o.hi[k]).max(o.lo[k] - self.hi[k]).max(0.0);
            s += d * d;
        }
        s
    }
    #[inline]
    pub fn size(&self) -> f64 {
        (self.hi[0] - self.lo[0]) + (self.hi[1] - self.lo[1]) + (self.hi[2] - self.lo[2])
    }
    /// The box that holds this one after a placement.
    pub fn placed(&self, x: &Xf, abs: &[f64; 9]) -> Aabb {
        let c = scale(add(self.lo, self.hi), 0.5);
        let h = scale(sub(self.hi, self.lo), 0.5);
        let c2 = x.point(c);
        let h2 = [abs[0] * h[0] + abs[1] * h[1] + abs[2] * h[2], abs[3] * h[0] + abs[4] * h[1] + abs[5] * h[2], abs[6] * h[0] + abs[7] * h[1] + abs[8] * h[2]];
        Aabb { lo: sub(c2, h2), hi: add(c2, h2) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inverse_undoes_a_mirrored_turn() {
        // a turn about z by 30 degrees, mirrored in x, shifted
        let (s, c) = (0.5f64, 0.75f64.sqrt());
        let x = Xf { l: [-c, s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0], t: [3.0, -2.0, 7.0] };
        assert!(x.det() < 0.0);
        let p = [1.5, 2.5, -4.0];
        let q = x.inverse().point(x.point(p));
        for k in 0..3 {
            assert!((p[k] - q[k]).abs() < 1e-12);
        }
        let i = x.mul(&x.inverse());
        for (k, v) in i.l.iter().enumerate() {
            let want = if k % 4 == 0 { 1.0 } else { 0.0 };
            assert!((v - want).abs() < 1e-12);
        }
    }

    #[test]
    fn cols16_matches_three_layout() {
        // translation by (1,2,3) in column-major
        let m = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 2.0, 3.0, 1.0];
        let x = Xf::from_cols16(&m);
        assert_eq!(x.point([0.0, 0.0, 0.0]), [1.0, 2.0, 3.0]);
    }
}
