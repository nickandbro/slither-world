use super::math::{cross, normalize};
use super::types::Point;
use std::f64::consts::PI;

pub fn tangent_basis(normal: Point) -> (Point, Point) {
    let up = if normal.y.abs() < 0.9 {
        Point {
            x: 0.0,
            y: 1.0,
            z: 0.0,
        }
    } else {
        Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        }
    };
    let tangent = normalize(cross(up, normal));
    let bitangent = normalize(cross(normal, tangent));
    (tangent, bitangent)
}

pub fn sample_outline_radius(outline: &[f64], theta: f64) -> f64 {
    if outline.is_empty() {
        return 0.0;
    }
    let total = PI * 2.0;
    let normalized = (theta / total).clamp(0.0, 1.0);
    let idx = normalized * outline.len() as f64;
    let i0 = idx.floor() as usize % outline.len();
    let i1 = (i0 + 1) % outline.len();
    let t = idx - idx.floor();
    outline[i0] * (1.0 - t) + outline[i1] * t
}
