//! The geometry core as a WebAssembly module, for today's app.
//!
//! A plain C interface (numbers and pointers into the module's memory), so it needs no glue code: the page copies a
//! part's mesh and faces in once, gets a handle back, and asks about pairs of handles.

use std::cell::RefCell;

use kerf_geom::clash;
use kerf_geom::mesh::Geom;
use kerf_geom::vec::Xf;

thread_local! {
    static GEOMS: RefCell<Vec<Option<Geom>>> = const { RefCell::new(Vec::new()) };
}

/// Memory for the caller to fill: `bytes` long, good for 8-byte numbers.
#[no_mangle]
pub extern "C" fn kerf_alloc(bytes: usize) -> *mut u8 {
    let mut v = Vec::<u64>::with_capacity(bytes.div_ceil(8).max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p as *mut u8
}

/// # Safety
/// `ptr` and `bytes` are what `kerf_alloc` was called with and returned.
#[no_mangle]
pub unsafe extern "C" fn kerf_free(ptr: *mut u8, bytes: usize) {
    drop(Vec::from_raw_parts(ptr as *mut u64, 0, bytes.div_ceil(8).max(1)));
}

/// A part: its mesh (`pos` three numbers per corner, `idx` three corners per triangle), each triangle's face
/// (`tri_face`, a row of `faces` or -1), and the faces as the kernel knows them (8 numbers each). Returns a handle.
///
/// # Safety
/// Each pointer is to as many numbers of its type as the count after it says.
#[no_mangle]
pub unsafe extern "C" fn geom_new(pos: *const f32, n_pos: usize, idx: *const u32, n_idx: usize, tri_face: *const i32, n_tri_face: usize, faces: *const f64, n_faces: usize, deflection: f64) -> u32 {
    let g = Geom::new(std::slice::from_raw_parts(pos, n_pos), std::slice::from_raw_parts(idx, n_idx), std::slice::from_raw_parts(tri_face, n_tri_face), std::slice::from_raw_parts(faces, n_faces), deflection);
    GEOMS.with(|all| {
        let mut all = all.borrow_mut();
        match all.iter().position(|slot| slot.is_none()) {
            Some(i) => {
                all[i] = Some(g);
                i as u32
            }
            None => {
                all.push(Some(g));
                all.len() as u32 - 1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn geom_drop(handle: u32) {
    GEOMS.with(|all| {
        if let Some(slot) = all.borrow_mut().get_mut(handle as usize) {
            *slot = None;
        }
    });
}

/// What was made of a part, 8 numbers into `out`: closed (1 or 0), pieces, faces the mesh disagreed with, triangles,
/// flat faces, round faces, other faces, the most a face's triangles can be off by.
///
/// # Safety
/// `out` has room for 8 numbers.
#[no_mangle]
pub unsafe extern "C" fn geom_info(handle: u32, out: *mut f64) -> u32 {
    let out = std::slice::from_raw_parts_mut(out, 8);
    GEOMS.with(|all| {
        let all = all.borrow();
        let Some(Some(g)) = all.get(handle as usize) else { return 0 };
        let count = |want: &[u8]| g.faces.iter().filter(|f| want.contains(&f.kind())).count() as f64;
        out.copy_from_slice(&[g.closed as u32 as f64, g.pieces.len() as f64, g.mismatched as f64, g.tris.len() as f64, count(&[0]), count(&[1, 3, 4]), count(&[2]), g.reach]);
        1
    })
}

/// Whether two placed parts are proved not to overlap. `xa` and `xb` are their placements as 4x4 matrices, column
/// by column. Returns `clash::Why` (0: proved clear; 5: proved to overlap by no more than a film; anything else: ask
/// the kernel) and writes 8 numbers to `out`: triangle pairs looked at, the kinds of the two faces that could not be
/// cleared, their triangles, their gap, and the most the parts can overlap by in mm³ (-1 when not proved).
///
/// # Safety
/// `xa` and `xb` are 16 numbers each and `out` has room for 8.
#[no_mangle]
pub unsafe extern "C" fn pair_classify(a: u32, b: u32, xa: *const f64, xb: *const f64, out: *mut f64) -> u32 {
    let xa = Xf::from_cols16(std::slice::from_raw_parts(xa, 16));
    let xb = Xf::from_cols16(std::slice::from_raw_parts(xb, 16));
    let out = std::slice::from_raw_parts_mut(out, 8);
    GEOMS.with(|all| {
        let all = all.borrow();
        let (Some(Some(ga)), Some(Some(gb))) = (all.get(a as usize), all.get(b as usize)) else { return clash::Why::Open as u32 };
        // b as a sees it
        let x = xa.inverse().mul(&xb);
        let o = clash::classify(ga, gb, &x);
        out.copy_from_slice(&[o.candidates as f64, o.kinds[0] as f64, o.kinds[1] as f64, o.tris[0] as f64, o.tris[1] as f64, o.gap, o.volume_bound().unwrap_or(-1.0), o.depth]);
        o.why as u32
    })
}

/// Whether the surfaces of two placed parts come within `gap`, and which holds the other up against gravity (-Z).
/// Bit 0: they touch. Bit 1: a rests on b. Bit 2: b rests on a.
///
/// # Safety
/// `xa` and `xb` are 16 numbers each.
#[no_mangle]
pub unsafe extern "C" fn pair_touch(a: u32, b: u32, xa: *const f64, xb: *const f64, gap: f64) -> u32 {
    let xa = Xf::from_cols16(std::slice::from_raw_parts(xa, 16));
    let xb = Xf::from_cols16(std::slice::from_raw_parts(xb, 16));
    GEOMS.with(|all| {
        let all = all.borrow();
        let (Some(Some(ga)), Some(Some(gb))) = (all.get(a as usize), all.get(b as usize)) else { return 0 };
        match kerf_geom::touch::touching(ga, gb, &xa, &xb, gap) {
            Some(t) => 1 | (t.a_on_b as u32) << 1 | (t.b_on_a as u32) << 2,
            None => 0,
        }
    })
}
