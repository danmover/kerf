//! Which parts touch, and which holds which up: for the check that every part is held in place.

use crate::mesh::Geom;
use crate::vec::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Touch {
    /// a rests on b: b's surface faces up under a's facing down where they meet
    pub a_on_b: bool,
    pub b_on_a: bool,
}

/// Whether the surfaces of two placed parts come within `gap` of each other, and which (if either) holds the other
/// up against gravity (-Z in the world). `xa` and `xb` place the parts in the world. An open mesh touches nothing.
pub fn touching(a: &Geom, b: &Geom, xa: &Xf, xb: &Xf, gap: f64) -> Option<Touch> {
    if !a.closed || !b.closed {
        return None;
    }
    // b as a sees it
    let x = xa.inverse().mul(xb);
    // world up, as a sees it: the third row of a's turn
    let up = [xa.l[6], xa.l[7], xa.l[8]];
    let mut touch = false;
    let mut out = Touch { a_on_b: false, b_on_a: false };
    a.bvh.pairs_within(&a.tris, &b.bvh, &b.tris, &x, gap, |ta, tb, _, _| {
        touch = true;
        let za = dot(a.facing(ta), up);
        let zb = dot(x.dir(b.facing(tb)), up);
        if zb > 0.5 && za < -0.5 {
            out.a_on_b = true;
        }
        if za > 0.5 && zb < -0.5 {
            out.b_on_a = true;
        }
        !(out.a_on_b && out.b_on_a)
    });
    if touch {
        Some(out)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::testing::Builder;

    #[test]
    fn a_box_resting_on_another() {
        let a = Builder::default().cuboid([0.0; 3], [40.0, 30.0, 10.0]).geom();
        let b = Builder::default().cuboid([0.0; 3], [20.0, 20.0, 20.0]).geom();
        let at = |t: V3| Xf { l: Xf::IDENTITY.l, t };
        // b stands on a: b rests on a, not the other way round
        let t = touching(&a, &b, &Xf::IDENTITY, &at([5.0, 5.0, 10.0]), 0.3).expect("touch");
        assert_eq!(t, Touch { a_on_b: false, b_on_a: true });
        // side by side: they touch, neither holds the other
        let t = touching(&a, &b, &Xf::IDENTITY, &at([40.1, 0.0, 0.0]), 0.3).expect("touch");
        assert_eq!(t, Touch { a_on_b: false, b_on_a: false });
        // a millimetre apart: no touch
        assert!(touching(&a, &b, &Xf::IDENTITY, &at([41.0, 0.0, 0.0]), 0.3).is_none());
        // the whole assembly tipped on its side (a quarter turn about x): what was on top is now beside
        let tip = Xf { l: [1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 1.0, 0.0], t: [0.0; 3] };
        let t = touching(&a, &b, &tip, &tip.mul(&at([5.0, 5.0, 10.0])), 0.3).expect("touch");
        assert_eq!(t, Touch { a_on_b: false, b_on_a: false });
    }
}
