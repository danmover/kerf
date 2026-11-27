//! Kerf's geometry core: the part of the checks that works on meshes and exact faces, without the CAD kernel.
//!
//! It is plain Rust with no dependencies, so the same code runs as WebAssembly inside today's app and natively in
//! the Rust app.

pub mod bvh;
pub mod clash;
pub mod mesh;
pub mod touch;
pub mod tri;
pub mod vec;
