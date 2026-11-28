//! Explains what the classifier makes of one pair of parts, from a file the app's side wrote (two parts one after
//! the other: four counts, then corners, triangles, each triangle's face, the faces, and the placement).
//!
//!   cargo run --release -p kerf-geom --example pair -- some.pair

use kerf_geom::clash;
use kerf_geom::mesh::Geom;
use kerf_geom::vec::Xf;

fn take<'a>(bytes: &'a [u8], at: &mut usize, n: usize) -> &'a [u8] {
    let s = &bytes[*at..*at + n];
    *at += n;
    s
}

fn part(bytes: &[u8], at: &mut usize, stray: f64) -> (Geom, Xf) {
    let head: Vec<usize> = take(bytes, at, 16).chunks(4).map(|c| u32::from_le_bytes(c.try_into().unwrap()) as usize).collect();
    let pos: Vec<f32> = take(bytes, at, head[0] * 4).chunks(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
    let idx: Vec<u32> = take(bytes, at, head[1] * 4).chunks(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
    let tri_face: Vec<i32> = take(bytes, at, head[2] * 4).chunks(4).map(|c| i32::from_le_bytes(c.try_into().unwrap())).collect();
    let faces: Vec<f64> = take(bytes, at, head[3] * 8).chunks(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    let x: Vec<f64> = take(bytes, at, 128).chunks(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    (Geom::new(&pos, &idx, &tri_face, &faces, stray), Xf::from_cols16(&x))
}

fn main() {
    let path = std::env::args().nth(1).expect("a .pair file");
    let bytes = std::fs::read(&path).expect("readable");
    let mut at = 0;
    let (a, xa) = part(&bytes, &mut at, 1.0);
    let (b, xb) = part(&bytes, &mut at, 1.0);
    let x = xa.inverse().mul(&xb);
    for (name, g) in [("a", &a), ("b", &b)] {
        println!("{name}: {} triangles, {} faces, closed {}, pieces {}, mismatched {}, reach {:.4}", g.tris.len(), g.faces.len(), g.closed, g.pieces.len(), g.mismatched, g.reach);
    }
    let t = std::time::Instant::now();
    let o = clash::classify(&a, &b, &x);
    println!("{:?} in {:?}", o, t.elapsed());
    if o.why == clash::Why::Close {
        let (ta, tb) = (o.tris[0], o.tris[1]);
        println!("a's triangle {ta}: {:?}\n  face {:?}", a.tris[ta as usize], a.face(ta));
        let tri_b = b.tris[tb as usize].map(|v| x.point(v));
        println!("b's triangle {tb} (as a sees it): {:?}\n  face {:?} (in b's own coordinates)", tri_b, b.face(tb));
        println!("  b placed: {:?}", clash::placed(b.face(tb), &x));
    }
    for line in clash::explain(&a, &b, &x, 12) {
        println!("{line}");
    }
}
