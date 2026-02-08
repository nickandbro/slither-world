use super::math::{length, normalize};
use super::types::Point;

pub fn parse_axis(value: Point) -> Option<Point> {
    if !value.x.is_finite() || !value.y.is_finite() || !value.z.is_finite() {
        return None;
    }
    let normalized = normalize(value);
    if length(normalized) == 0.0 {
        return None;
    }
    Some(normalized)
}
