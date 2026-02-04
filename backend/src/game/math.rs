use super::constants::COLLISION_DISTANCE;
use super::types::Point;

pub fn point_from_spherical(theta: f64, phi: f64) -> Point {
  let sin_phi = phi.sin();
  Point {
    x: theta.cos() * sin_phi,
    y: theta.sin() * sin_phi,
    z: phi.cos(),
  }
}

pub fn length(point: Point) -> f64 {
  (point.x * point.x + point.y * point.y + point.z * point.z).sqrt()
}

pub fn normalize(point: Point) -> Point {
  let len = length(point);
  if !len.is_finite() || len == 0.0 {
    return Point { x: 0.0, y: 0.0, z: 0.0 };
  }
  Point {
    x: point.x / len,
    y: point.y / len,
    z: point.z / len,
  }
}

pub fn dot(a: Point, b: Point) -> f64 {
  a.x * b.x + a.y * b.y + a.z * b.z
}

pub fn cross(a: Point, b: Point) -> Point {
  Point {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

pub fn rotate_z(point: &mut Point, angle: f64) {
  let cos_a = angle.cos();
  let sin_a = angle.sin();
  let x = point.x;
  let y = point.y;
  point.x = cos_a * x - sin_a * y;
  point.y = sin_a * x + cos_a * y;
}

pub fn rotate_y(point: &mut Point, angle: f64) {
  let cos_a = angle.cos();
  let sin_a = angle.sin();
  let x = point.x;
  let z = point.z;
  point.x = cos_a * x + sin_a * z;
  point.z = -sin_a * x + cos_a * z;
}

pub fn rotate_around_axis(point: &mut Point, axis: Point, angle: f64) {
  let u = normalize(axis);
  let cos_a = angle.cos();
  let sin_a = angle.sin();
  let ux = u.x;
  let uy = u.y;
  let uz = u.z;
  let x = point.x;
  let y = point.y;
  let z = point.z;
  let dot_prod = ux * x + uy * y + uz * z;

  point.x = x * cos_a + (uy * z - uz * y) * sin_a + ux * dot_prod * (1.0 - cos_a);
  point.y = y * cos_a + (uz * x - ux * z) * sin_a + uy * dot_prod * (1.0 - cos_a);
  point.z = z * cos_a + (ux * y - uy * x) * sin_a + uz * dot_prod * (1.0 - cos_a);
}

pub fn rotate_toward(current: Point, target: Point, max_angle: f64) -> Point {
  let current_norm = normalize(current);
  let target_norm = normalize(target);
  let dot_value = clamp(dot(current_norm, target_norm), -1.0, 1.0);
  let angle = dot_value.acos();
  if !angle.is_finite() || angle <= max_angle {
    return target_norm;
  }
  if angle == 0.0 {
    return current_norm;
  }

  let axis = cross(current_norm, target_norm);
  let axis_length = length(axis);
  if axis_length == 0.0 {
    return current_norm;
  }
  let axis_norm = Point {
    x: axis.x / axis_length,
    y: axis.y / axis_length,
    z: axis.z / axis_length,
  };
  let mut rotated = current_norm;
  rotate_around_axis(&mut rotated, axis_norm, max_angle);
  normalize(rotated)
}

pub fn random_axis() -> Point {
  let angle = rand::random::<f64>() * std::f64::consts::PI * 2.0;
  Point {
    x: angle.cos(),
    y: angle.sin(),
    z: 0.0,
  }
}

pub fn collision(a: Point, b: Point) -> bool {
  let dist = ((a.x - b.x).powi(2) + (a.y - b.y).powi(2) + (a.z - b.z).powi(2)).sqrt();
  dist < COLLISION_DISTANCE
}

pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
  value.min(max).max(min)
}
