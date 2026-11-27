//! A tree of boxes over a triangle mesh, for finding the triangles of two parts that come close, casting rays and
//! collecting the triangles in a region. The tree is in the part's own coordinates, so one tree serves every place
//! the part is used: a query between two parts carries the second part's placement relative to the first.

use crate::tri::*;
use crate::vec::*;

const LEAF: usize = 4;

#[derive(Clone, Copy)]
struct Node {
    b: Aabb,
    /// children at `left` and `left + 1` for an inner node; first triangle slot for a leaf
    left: u32,
    /// 0 for an inner node; number of triangles for a leaf
    count: u32,
}

pub struct Bvh {
    nodes: Vec<Node>,
    /// triangle indices, leaf by leaf
    order: Vec<u32>,
}

fn tri_box(t: &Tri) -> Aabb {
    let mut b = Aabb::EMPTY;
    b.grow(t[0]);
    b.grow(t[1]);
    b.grow(t[2]);
    b
}

impl Bvh {
    pub fn build(tris: &[Tri]) -> Bvh {
        let n = tris.len();
        let mut order: Vec<u32> = (0..n as u32).collect();
        let cent: Vec<V3> = tris.iter().map(|t| scale(add(add(t[0], t[1]), t[2]), 1.0 / 3.0)).collect();
        let boxes: Vec<Aabb> = tris.iter().map(tri_box).collect();
        let mut nodes: Vec<Node> = Vec::with_capacity(2 * n / LEAF + 2);
        nodes.push(Node { b: Aabb::EMPTY, left: 0, count: 0 });
        // (node, first slot, end slot)
        let mut stack: Vec<(usize, usize, usize)> = vec![(0, 0, n)];
        while let Some((at, lo, hi)) = stack.pop() {
            let mut b = Aabb::EMPTY;
            let mut cb = Aabb::EMPTY;
            for &t in &order[lo..hi] {
                b.union(&boxes[t as usize]);
                cb.grow(cent[t as usize]);
            }
            nodes[at].b = b;
            if hi - lo <= LEAF {
                nodes[at].left = lo as u32;
                nodes[at].count = (hi - lo) as u32;
                continue;
            }
            let ext = sub(cb.hi, cb.lo);
            let axis = if ext[0] >= ext[1] && ext[0] >= ext[2] { 0 } else if ext[1] >= ext[2] { 1 } else { 2 };
            let mid = (lo + hi) / 2;
            order[lo..hi].select_nth_unstable_by(mid - lo, |x, y| cent[*x as usize][axis].partial_cmp(&cent[*y as usize][axis]).unwrap_or(std::cmp::Ordering::Equal));
            let left = nodes.len();
            nodes.push(Node { b: Aabb::EMPTY, left: 0, count: 0 });
            nodes.push(Node { b: Aabb::EMPTY, left: 0, count: 0 });
            nodes[at].left = left as u32;
            nodes[at].count = 0;
            stack.push((left, lo, mid));
            stack.push((left + 1, mid, hi));
        }
        Bvh { nodes, order }
    }

    pub fn bounds(&self) -> Aabb {
        self.nodes[0].b
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    /// Calls `f(mine, theirs, distance squared)` for each pair of triangles, one of this mesh and one of `other`,
    /// that come within `gap` of each other. `x` places `other` in this mesh's coordinates. Stops when `f` returns
    /// false; returns false when stopped.
    pub fn pairs_within<F: FnMut(u32, u32, &Tri, f64) -> bool>(&self, tris: &[Tri], other: &Bvh, other_tris: &[Tri], x: &Xf, gap: f64, mut f: F) -> bool {
        if self.is_empty() || other.is_empty() {
            return true;
        }
        let abs = x.abs_linear();
        let g2 = gap * gap;
        // their boxes and triangles in my coordinates, worked out when first needed
        let mut placed_box: Vec<Option<Aabb>> = vec![None; other.nodes.len()];
        let mut placed_tri: Vec<Option<Tri>> = vec![None; other_tris.len()];
        let mut stack: Vec<(u32, u32)> = vec![(0, 0)];
        while let Some((i, j)) = stack.pop() {
            let a = &self.nodes[i as usize];
            let b = &other.nodes[j as usize];
            let bb = *placed_box[j as usize].get_or_insert_with(|| b.b.placed(x, &abs));
            if a.b.gap2(&bb) > g2 {
                continue;
            }
            let leaf_a = a.count > 0;
            let leaf_b = b.count > 0;
            if leaf_a && leaf_b {
                for s in a.left..a.left + a.count {
                    let ta = self.order[s as usize];
                    let tri_a = &tris[ta as usize];
                    let box_a = tri_box(tri_a);
                    for t in b.left..b.left + b.count {
                        let tb = other.order[t as usize];
                        let tri_b = *placed_tri[tb as usize].get_or_insert_with(|| {
                            let o = &other_tris[tb as usize];
                            [x.point(o[0]), x.point(o[1]), x.point(o[2])]
                        });
                        if box_a.gap2(&tri_box(&tri_b)) > g2 {
                            continue;
                        }
                        let d2 = tri_tri_dist2(tri_a, &tri_b);
                        if d2 <= g2 && !f(ta, tb, &tri_b, d2) {
                            return false;
                        }
                    }
                }
            } else if leaf_b || (!leaf_a && a.b.size() >= bb.size()) {
                stack.push((a.left, j));
                stack.push((a.left + 1, j));
            } else {
                stack.push((i, b.left));
                stack.push((i, b.left + 1));
            }
        }
        true
    }

    /// Calls `f(triangle)` for each triangle whose box overlaps `q`. Stops when `f` returns false.
    pub fn in_box<F: FnMut(u32) -> bool>(&self, tris: &[Tri], q: &Aabb, mut f: F) {
        if self.is_empty() {
            return;
        }
        let mut stack: Vec<u32> = vec![0];
        while let Some(i) = stack.pop() {
            let n = &self.nodes[i as usize];
            if n.b.gap2(q) > 0.0 {
                continue;
            }
            if n.count > 0 {
                for s in n.left..n.left + n.count {
                    let t = self.order[s as usize];
                    if tri_box(&tris[t as usize]).gap2(q) <= 0.0 && !f(t) {
                        return;
                    }
                }
            } else {
                stack.push(n.left);
                stack.push(n.left + 1);
            }
        }
    }

    /// How many times a ray from `p` along `d` crosses the surface.
    pub fn crossings(&self, tris: &[Tri], p: V3, d: V3) -> u32 {
        if self.is_empty() {
            return 0;
        }
        let inv = [1.0 / d[0], 1.0 / d[1], 1.0 / d[2]];
        let mut hits = 0;
        let mut stack: Vec<u32> = vec![0];
        while let Some(i) = stack.pop() {
            let n = &self.nodes[i as usize];
            // slab test
            let mut t0 = 0.0f64;
            let mut t1 = f64::INFINITY;
            for k in 0..3 {
                let a = (n.b.lo[k] - p[k]) * inv[k];
                let b = (n.b.hi[k] - p[k]) * inv[k];
                t0 = t0.max(a.min(b));
                t1 = t1.min(a.max(b));
            }
            if t0 > t1 {
                continue;
            }
            if n.count > 0 {
                for s in n.left..n.left + n.count {
                    if ray_hits(p, d, &tris[self.order[s as usize] as usize]).is_some() {
                        hits += 1;
                    }
                }
            } else {
                stack.push(n.left);
                stack.push(n.left + 1);
            }
        }
        hits
    }

    /// How far along the ray from `p` along `d` the surface is first met (in lengths of `d`).
    pub fn first_hit(&self, tris: &[Tri], p: V3, d: V3) -> Option<f64> {
        if self.is_empty() {
            return None;
        }
        let inv = [1.0 / d[0], 1.0 / d[1], 1.0 / d[2]];
        let mut best = f64::INFINITY;
        let mut stack: Vec<u32> = vec![0];
        while let Some(i) = stack.pop() {
            let n = &self.nodes[i as usize];
            let mut t0 = 0.0f64;
            let mut t1 = best;
            for k in 0..3 {
                let a = (n.b.lo[k] - p[k]) * inv[k];
                let b = (n.b.hi[k] - p[k]) * inv[k];
                // a ray along a box side gives 0 * inf = NaN: min and max then keep the other number
                t0 = t0.max(a.min(b));
                t1 = t1.min(a.max(b));
            }
            if t0 > t1 {
                continue;
            }
            if n.count > 0 {
                for s in n.left..n.left + n.count {
                    if let Some(t) = ray_hits(p, d, &tris[self.order[s as usize] as usize]) {
                        best = best.min(t);
                    }
                }
            } else {
                stack.push(n.left);
                stack.push(n.left + 1);
            }
        }
        if best.is_finite() {
            Some(best)
        } else {
            None
        }
    }

    /// The squared distance from `p` to the nearest triangle, if within `max`.
    pub fn dist2(&self, tris: &[Tri], p: V3, max: f64) -> f64 {
        let mut best = max * max;
        if self.is_empty() {
            return best;
        }
        let pb = Aabb { lo: p, hi: p };
        let mut stack: Vec<u32> = vec![0];
        while let Some(i) = stack.pop() {
            let n = &self.nodes[i as usize];
            if n.b.gap2(&pb) > best {
                continue;
            }
            if n.count > 0 {
                for s in n.left..n.left + n.count {
                    best = best.min(point_tri_dist2(p, &tris[self.order[s as usize] as usize]));
                }
            } else {
                stack.push(n.left);
                stack.push(n.left + 1);
            }
        }
        best
    }
}

/// Möller-Trumbore, for a ray (t > 0): how far along it the triangle is.
fn ray_hits(p: V3, d: V3, t: &Tri) -> Option<f64> {
    let e1 = sub(t[1], t[0]);
    let e2 = sub(t[2], t[0]);
    let h = cross(d, e2);
    let a = dot(e1, h);
    if a.abs() < 1e-18 {
        return None;
    }
    let f = 1.0 / a;
    let s = sub(p, t[0]);
    let u = f * dot(s, h);
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = cross(s, e1);
    let v = f * dot(d, q);
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let at = f * dot(e2, q);
    if at > 1e-12 {
        Some(at)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A closed box as 12 triangles, wound outward.
    pub fn box_tris(lo: V3, hi: V3) -> Vec<Tri> {
        let p = |i: usize| -> V3 { [if i & 1 != 0 { hi[0] } else { lo[0] }, if i & 2 != 0 { hi[1] } else { lo[1] }, if i & 4 != 0 { hi[2] } else { lo[2] }] };
        let quads: [[usize; 4]; 6] = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
        let mut out = Vec::new();
        for q in quads {
            out.push([p(q[0]), p(q[1]), p(q[2])]);
            out.push([p(q[0]), p(q[2]), p(q[3])]);
        }
        out
    }

    #[test]
    fn inside_and_outside_by_ray() {
        let t = box_tris([0.0; 3], [2.0, 3.0, 4.0]);
        let b = Bvh::build(&t);
        let d = [0.5773, 0.5774, 0.5772];
        assert_eq!(b.crossings(&t, [1.0, 1.0, 1.0], d) % 2, 1);
        assert_eq!(b.crossings(&t, [-1.0, 1.0, 1.0], d) % 2, 0);
        assert_eq!(b.crossings(&t, [1.0, 1.0, 5.0], d) % 2, 0);
    }

    #[test]
    fn close_pairs_with_a_placement() {
        let a = box_tris([0.0; 3], [10.0, 10.0, 10.0]);
        let b = box_tris([0.0; 3], [5.0, 5.0, 5.0]);
        let (ba, bb) = (Bvh::build(&a), Bvh::build(&b));
        // b sits 0.5 above a
        let x = Xf { l: Xf::IDENTITY.l, t: [2.0, 2.0, 10.5] };
        let mut n = 0;
        let mut near = f64::INFINITY;
        ba.pairs_within(&a, &bb, &b, &x, 0.6, |_, _, _, d2| {
            n += 1;
            near = near.min(d2);
            true
        });
        assert!(n > 0);
        assert!((near.sqrt() - 0.5).abs() < 1e-12);
        let mut m = 0;
        ba.pairs_within(&a, &bb, &b, &x, 0.4, |_, _, _, _| {
            m += 1;
            true
        });
        assert_eq!(m, 0);
    }

    #[test]
    fn nearest_distance() {
        let t = box_tris([0.0; 3], [1.0, 1.0, 1.0]);
        let b = Bvh::build(&t);
        assert!((b.dist2(&t, [0.5, 0.5, 3.0], 10.0) - 4.0).abs() < 1e-12);
        assert!((b.dist2(&t, [0.5, 0.5, 0.5], 10.0) - 0.25).abs() < 1e-12);
    }
}
