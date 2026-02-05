use super::math::{clamp, cross, dot, normalize};
use super::types::Point;
use crate::protocol::Encoder;
use std::f64::consts::PI;

pub const BASE_PLANET_RADIUS: f64 = 1.0;
pub const PLANET_RADIUS: f64 = 3.0;
pub const PLANET_SCALE: f64 = PLANET_RADIUS / BASE_PLANET_RADIUS;

pub const LAKE_COUNT: usize = 2;
pub const LAKE_MIN_ANGLE: f64 = 0.9 / PLANET_SCALE;
pub const LAKE_MAX_ANGLE: f64 = 1.3 / PLANET_SCALE;
pub const LAKE_MIN_DEPTH: f64 = BASE_PLANET_RADIUS * 0.07;
pub const LAKE_MAX_DEPTH: f64 = BASE_PLANET_RADIUS * 0.12;
pub const LAKE_EDGE_FALLOFF: f64 = 0.08;
pub const LAKE_EDGE_SHARPNESS: f64 = 1.8;
pub const LAKE_NOISE_AMPLITUDE: f64 = 0.55;
pub const LAKE_NOISE_FREQ_MIN: f64 = 3.0;
pub const LAKE_NOISE_FREQ_MAX: f64 = 6.0;
pub const LAKE_SHELF_DEPTH_RATIO: f64 = 0.45;
pub const LAKE_SHELF_CORE: f64 = 0.55;
pub const LAKE_CENTER_PIT_START: f64 = 0.72;
pub const LAKE_CENTER_PIT_RATIO: f64 = 0.35;
pub const LAKE_SURFACE_INSET_RATIO: f64 = 0.5;
pub const LAKE_SURFACE_EXTRA_INSET: f64 = BASE_PLANET_RADIUS * 0.01;
pub const LAKE_WATER_MASK_THRESHOLD: f64 = 0.0;
pub const LAKE_EXCLUSION_THRESHOLD: f64 = 0.18;

pub const TREE_COUNT: usize = 36;
pub const MOUNTAIN_COUNT: usize = 8;
pub const TREE_INSTANCE_COUNT: usize = TREE_COUNT - MOUNTAIN_COUNT;

pub const SNAKE_RADIUS: f64 = 0.045;
pub const TREE_HEIGHT: f64 = BASE_PLANET_RADIUS * 0.3;
pub const TREE_TRUNK_HEIGHT: f64 = TREE_HEIGHT / 3.0;
pub const TREE_TRUNK_RADIUS: f64 = TREE_HEIGHT * 0.12;
pub const TREE_TIER_HEIGHT_FACTORS: [f64; 4] = [0.4, 0.33, 0.27, 0.21];
pub const TREE_TIER_OVERLAP: f64 = 0.55;
pub const TREE_MIN_SCALE: f64 = 0.9;
pub const TREE_MAX_SCALE: f64 = 1.15;
pub const TREE_MIN_ANGLE: f64 = 0.42;
pub const TREE_MIN_HEIGHT: f64 = SNAKE_RADIUS * 9.5;
pub const TREE_MAX_HEIGHT: f64 = TREE_MIN_HEIGHT * 1.5;

pub const MOUNTAIN_VARIANTS: usize = 3;
pub const MOUNTAIN_RADIUS_MIN: f64 = BASE_PLANET_RADIUS * 0.12;
pub const MOUNTAIN_RADIUS_MAX: f64 = BASE_PLANET_RADIUS * 0.22;
pub const MOUNTAIN_HEIGHT_MIN: f64 = BASE_PLANET_RADIUS * 0.12;
pub const MOUNTAIN_HEIGHT_MAX: f64 = BASE_PLANET_RADIUS * 0.26;
pub const MOUNTAIN_MIN_ANGLE: f64 = 0.55;
pub const MOUNTAIN_OUTLINE_SAMPLES: usize = 64;

const LAKE_SEED: u32 = 0x91fcae12;
const ENV_SEED: u32 = 0x6f35d2a1;
const MOUNTAIN_VARIANT_SEED: u32 = 0x03f2a9b1;

#[derive(Debug, Clone)]
pub struct Lake {
  pub center: Point,
  pub radius: f64,
  pub depth: f64,
  pub shelf_depth: f64,
  pub edge_falloff: f64,
  pub noise_amplitude: f64,
  pub noise_frequency: f64,
  pub noise_frequency_b: f64,
  pub noise_frequency_c: f64,
  pub noise_phase: f64,
  pub noise_phase_b: f64,
  pub noise_phase_c: f64,
  pub warp_amplitude: f64,
  pub surface_inset: f64,
  pub tangent: Point,
  pub bitangent: Point,
}

#[derive(Debug, Clone)]
pub struct TreeInstance {
  pub normal: Point,
  pub width_scale: f64,
  pub height_scale: f64,
  pub twist: f64,
}

#[derive(Debug, Clone)]
pub struct MountainInstance {
  pub normal: Point,
  pub radius: f64,
  pub height: f64,
  pub variant: u8,
  pub twist: f64,
  pub outline: Vec<f64>,
}

#[derive(Debug, Clone)]
pub struct Environment {
  pub lakes: Vec<Lake>,
  pub trees: Vec<TreeInstance>,
  pub mountains: Vec<MountainInstance>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub struct LakeSample {
  pub boundary: f64,
  pub depth: f64,
  pub lake_index: Option<usize>,
}

impl Environment {
  pub fn generate() -> Self {
    let lakes = create_lakes(LAKE_SEED, LAKE_COUNT);
    let mut rng = SeededRng::new(ENV_SEED);
    let rand_range = |rng: &mut SeededRng, min: f64, max: f64| min + (max - min) * rng.next_f64();

    let tier_height_sum: f64 = TREE_TIER_HEIGHT_FACTORS.iter().copied().sum();
    let tier_height_scale = if tier_height_sum > 0.0 {
      (TREE_HEIGHT - TREE_TRUNK_HEIGHT) / tier_height_sum
    } else {
      0.0
    };
    let tree_tier_heights: Vec<f64> = TREE_TIER_HEIGHT_FACTORS
      .iter()
      .map(|factor| factor * tier_height_scale)
      .collect();
    let mut tier_base = TREE_TRUNK_HEIGHT * 0.75;
    let mut base_tree_height = TREE_TRUNK_HEIGHT;
    for height in &tree_tier_heights {
      let top = tier_base + height;
      if top > base_tree_height {
        base_tree_height = top;
      }
      tier_base += height * (1.0 - TREE_TIER_OVERLAP);
    }

    let min_height_scale = TREE_MIN_HEIGHT / base_tree_height;
    let max_height_scale = (TREE_MAX_HEIGHT / base_tree_height).max(min_height_scale);

    let min_dot = TREE_MIN_ANGLE.cos();
    let mut trees = Vec::with_capacity(TREE_INSTANCE_COUNT);
    let is_in_lake = |candidate: Point| sample_lakes(candidate, &lakes).boundary > LAKE_EXCLUSION_THRESHOLD;

    let mut tree_normals: Vec<Point> = Vec::with_capacity(TREE_INSTANCE_COUNT);
    for _ in 0..TREE_INSTANCE_COUNT {
      let candidate = pick_sparse_normal(&mut rng, min_dot, &tree_normals, &is_in_lake);
      let width_scale = rand_range(&mut rng, TREE_MIN_SCALE, TREE_MAX_SCALE);
      let height_scale = rand_range(&mut rng, min_height_scale, max_height_scale);
      let twist = rand_range(&mut rng, 0.0, PI * 2.0);
      tree_normals.push(candidate);
      trees.push(TreeInstance {
        normal: candidate,
        width_scale,
        height_scale,
        twist,
      });
    }

    let mountain_min_dot = MOUNTAIN_MIN_ANGLE.cos();
    let mut mountains = Vec::with_capacity(MOUNTAIN_COUNT);
    let mut mountain_normals: Vec<Point> = Vec::with_capacity(MOUNTAIN_COUNT);
    for _ in 0..MOUNTAIN_COUNT {
      let candidate = pick_sparse_normal(&mut rng, mountain_min_dot, &mountain_normals, &is_in_lake);
      let radius = rand_range(&mut rng, MOUNTAIN_RADIUS_MIN, MOUNTAIN_RADIUS_MAX);
      let height = rand_range(&mut rng, MOUNTAIN_HEIGHT_MIN, MOUNTAIN_HEIGHT_MAX);
      let variant = (rng.next_f64() * MOUNTAIN_VARIANTS as f64).floor() as u8;
      let twist = rand_range(&mut rng, 0.0, PI * 2.0);
      let variant_seed = MOUNTAIN_VARIANT_SEED + (variant as u32) * 57;
      let base_angle = radius / PLANET_RADIUS;
      let outline = build_mountain_outline(variant_seed, base_angle);
      mountain_normals.push(candidate);
      mountains.push(MountainInstance {
        normal: candidate,
        radius,
        height,
        variant,
        twist,
        outline,
      });
    }

    Environment {
      lakes,
      trees,
      mountains,
    }
  }

  pub fn encoded_len(&self) -> usize {
    let mut len = 0usize;
    len += 2 + self.lakes.len() * (16 * 4);
    len += 2 + self.trees.len() * (6 * 4);
    len += 2;
    for mountain in &self.mountains {
      len += 12 + 4 + 4 + 1 + 4 + 2 + mountain.outline.len() * 4;
    }
    len
  }

  pub fn write_to(&self, encoder: &mut Encoder) {
    encoder.write_u16(self.lakes.len().min(u16::MAX as usize) as u16);
    for lake in &self.lakes {
      encoder.write_f32(lake.center.x as f32);
      encoder.write_f32(lake.center.y as f32);
      encoder.write_f32(lake.center.z as f32);
      encoder.write_f32(lake.radius as f32);
      encoder.write_f32(lake.depth as f32);
      encoder.write_f32(lake.shelf_depth as f32);
      encoder.write_f32(lake.edge_falloff as f32);
      encoder.write_f32(lake.noise_amplitude as f32);
      encoder.write_f32(lake.noise_frequency as f32);
      encoder.write_f32(lake.noise_frequency_b as f32);
      encoder.write_f32(lake.noise_frequency_c as f32);
      encoder.write_f32(lake.noise_phase as f32);
      encoder.write_f32(lake.noise_phase_b as f32);
      encoder.write_f32(lake.noise_phase_c as f32);
      encoder.write_f32(lake.warp_amplitude as f32);
      encoder.write_f32(lake.surface_inset as f32);
    }

    encoder.write_u16(self.trees.len().min(u16::MAX as usize) as u16);
    for tree in &self.trees {
      encoder.write_f32(tree.normal.x as f32);
      encoder.write_f32(tree.normal.y as f32);
      encoder.write_f32(tree.normal.z as f32);
      encoder.write_f32(tree.width_scale as f32);
      encoder.write_f32(tree.height_scale as f32);
      encoder.write_f32(tree.twist as f32);
    }

    encoder.write_u16(self.mountains.len().min(u16::MAX as usize) as u16);
    for mountain in &self.mountains {
      encoder.write_f32(mountain.normal.x as f32);
      encoder.write_f32(mountain.normal.y as f32);
      encoder.write_f32(mountain.normal.z as f32);
      encoder.write_f32(mountain.radius as f32);
      encoder.write_f32(mountain.height as f32);
      encoder.write_u8(mountain.variant);
      encoder.write_f32(mountain.twist as f32);
      let outline_len = mountain.outline.len().min(u16::MAX as usize) as u16;
      encoder.write_u16(outline_len);
      for value in mountain.outline.iter().take(outline_len as usize) {
        encoder.write_f32(*value as f32);
      }
    }
  }
}

pub fn sample_lakes(normal: Point, lakes: &[Lake]) -> LakeSample {
  let mut max_boundary = 0.0;
  let mut max_depth = 0.0;
  let mut lake_index = None;

  for (index, lake) in lakes.iter().enumerate() {
    let dot_value = clamp(dot(lake.center, normal), -1.0, 1.0);
    let angle = dot_value.acos();
    if angle >= lake.radius + lake.edge_falloff {
      continue;
    }

    let temp = Point {
      x: normal.x - lake.center.x * dot_value,
      y: normal.y - lake.center.y * dot_value,
      z: normal.z - lake.center.z * dot_value,
    };
    let x = dot(temp, lake.tangent);
    let y = dot(temp, lake.bitangent);
    let warp = (x + y) * lake.noise_frequency_c + lake.noise_phase_c;
    let warp = warp.sin() * lake.warp_amplitude;
    let u = x * lake.noise_frequency + lake.noise_phase + warp;
    let v = y * lake.noise_frequency_b + lake.noise_phase_b - warp;
    let w = (x - y) * lake.noise_frequency_c + lake.noise_phase_c * 0.7;
    let noise =
      u.sin() + v.sin() + 0.6 * (2.0 * u + v * 0.6).sin() + 0.45 * (2.3 * v - 0.7 * u).sin() + 0.35 * w.sin();
    let noise_normalized = noise / 3.15;
    let edge_radius = clamp(
      lake.radius * (1.0 + lake.noise_amplitude * noise_normalized),
      lake.radius * 0.65,
      lake.radius * 1.35,
    );
    if angle >= edge_radius {
      continue;
    }

    let shelf_radius = (edge_radius - lake.edge_falloff).max(1e-3);
    let edge_t = clamp((edge_radius - angle) / lake.edge_falloff, 0.0, 1.0);
    let edge_blend = edge_t.powf(LAKE_EDGE_SHARPNESS);
    let core = clamp(1.0 - angle / shelf_radius, 0.0, 1.0);
    let basin_factor = smoothstep(LAKE_SHELF_CORE, 1.0, core);
    let pit_factor = smoothstep(LAKE_CENTER_PIT_START, 1.0, core);
    let pit_depth = pit_factor * pit_factor * lake.depth * LAKE_CENTER_PIT_RATIO;
    let depth = edge_blend * (lake.shelf_depth + basin_factor * (lake.depth - lake.shelf_depth) + pit_depth);

    if edge_blend > max_boundary {
      max_boundary = edge_blend;
      lake_index = Some(index);
    }
    if depth > max_depth {
      max_depth = depth;
    }
  }

  LakeSample {
    boundary: max_boundary,
    depth: max_depth,
    lake_index,
  }
}

fn create_lakes(seed: u32, count: usize) -> Vec<Lake> {
  let mut rng = SeededRng::new(seed);
  let mut lakes = Vec::with_capacity(count);
  let rand_range = |rng: &mut SeededRng, min: f64, max: f64| min + (max - min) * rng.next_f64();

  for _ in 0..count {
    let radius = rand_range(&mut rng, LAKE_MIN_ANGLE, LAKE_MAX_ANGLE);
    let depth = rand_range(&mut rng, LAKE_MIN_DEPTH, LAKE_MAX_DEPTH);
    let shelf_depth = depth * LAKE_SHELF_DEPTH_RATIO;
    let center = pick_lake_center(radius, &lakes, &mut rng);
    let (tangent, bitangent) = tangent_basis(center);
    let noise_frequency = rand_range(&mut rng, LAKE_NOISE_FREQ_MIN, LAKE_NOISE_FREQ_MAX);
    let noise_frequency_b = noise_frequency * rand_range(&mut rng, 0.55, 0.95);
    let noise_frequency_c = noise_frequency * rand_range(&mut rng, 1.1, 1.7);
    let noise_phase = rng.next_f64() * PI * 2.0;
    let noise_phase_b = rng.next_f64() * PI * 2.0;
    let noise_phase_c = rng.next_f64() * PI * 2.0;
    let warp_amplitude = rand_range(&mut rng, 0.08, 0.18);
    let surface_inset = shelf_depth * LAKE_SURFACE_INSET_RATIO + LAKE_SURFACE_EXTRA_INSET;

    lakes.push(Lake {
      center,
      radius,
      depth,
      shelf_depth,
      edge_falloff: LAKE_EDGE_FALLOFF,
      noise_amplitude: LAKE_NOISE_AMPLITUDE,
      noise_frequency,
      noise_frequency_b,
      noise_frequency_c,
      noise_phase,
      noise_phase_b,
      noise_phase_c,
      warp_amplitude,
      surface_inset,
      tangent,
      bitangent,
    });
  }

  lakes
}

fn pick_lake_center(radius: f64, lakes: &[Lake], rng: &mut SeededRng) -> Point {
  for _ in 0..80 {
    let candidate = random_on_sphere(rng);
    let mut ok = true;
    for lake in lakes {
      let min_sep = (radius + lake.radius) * 0.75;
      if dot(candidate, lake.center) > min_sep.cos() {
        ok = false;
        break;
      }
    }
    if ok {
      return candidate;
    }
  }
  random_on_sphere(rng)
}

fn pick_sparse_normal(
  rng: &mut SeededRng,
  min_dot: f64,
  existing: &[Point],
  is_in_lake: &dyn Fn(Point) -> bool,
) -> Point {
  for _ in 0..60 {
    let candidate = random_on_sphere(rng);
    if is_in_lake(candidate) {
      continue;
    }
    let mut ok = true;
    for other in existing {
      if dot(*other, candidate) > min_dot {
        ok = false;
        break;
      }
    }
    if ok {
      return candidate;
    }
  }
  for _ in 0..40 {
    let candidate = random_on_sphere(rng);
    if !is_in_lake(candidate) {
      return candidate;
    }
  }
  random_on_sphere(rng)
}

fn tangent_basis(normal: Point) -> (Point, Point) {
  let up = if normal.y.abs() < 0.9 {
    Point { x: 0.0, y: 1.0, z: 0.0 }
  } else {
    Point { x: 1.0, y: 0.0, z: 0.0 }
  };
  let tangent = normalize(cross(up, normal));
  let bitangent = normalize(cross(normal, tangent));
  (tangent, bitangent)
}

fn build_mountain_outline(seed: u32, base_angle: f64) -> Vec<f64> {
  let mut rng = SeededRng::new(seed);
  let variance = 0.18 + rng.next_f64() * 0.06;
  let mut outline = vec![0.0; MOUNTAIN_OUTLINE_SAMPLES];
  for i in 0..MOUNTAIN_OUTLINE_SAMPLES {
    let theta = (i as f64 / MOUNTAIN_OUTLINE_SAMPLES as f64) * PI * 2.0;
    let dir = Point {
      x: theta.cos(),
      y: 0.0,
      z: theta.sin(),
    };
    let qx = (dir.x * 1024.0).round() as i32;
    let qy = (dir.y * 1024.0).round() as i32;
    let qz = (dir.z * 1024.0).round() as i32;
    let jitter = hash3(seed, qx, qy, qz) * 2.0 - 1.0;
    let scale = 1.0 + jitter * variance;
    outline[i] = (base_angle * scale).max(base_angle * 0.5);
  }

  // Smooth the outline to avoid sharp discontinuities.
  let mut smoothed = vec![0.0; MOUNTAIN_OUTLINE_SAMPLES];
  for i in 0..MOUNTAIN_OUTLINE_SAMPLES {
    let mut sum = 0.0;
    let mut count = 0.0;
    for offset in -2..=2 {
      let idx = (i as isize + offset).rem_euclid(MOUNTAIN_OUTLINE_SAMPLES as isize) as usize;
      sum += outline[idx];
      count += 1.0;
    }
    smoothed[i] = sum / count;
  }

  smoothed
}

fn hash3(seed: u32, x: i32, y: i32, z: i32) -> f64 {
  let mut h = seed ^ 0x9e3779b9;
  h = (h ^ x as u32).wrapping_mul(0x85ebca6b);
  h = (h ^ y as u32).wrapping_mul(0xc2b2ae35);
  h = (h ^ z as u32).wrapping_mul(0x27d4eb2f);
  h ^= h >> 16;
  (h as f64) / 4294967296.0
}

fn smoothstep(edge0: f64, edge1: f64, x: f64) -> f64 {
  let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  t * t * (3.0 - 2.0 * t)
}

fn random_on_sphere(rng: &mut SeededRng) -> Point {
  let theta = rng.next_f64() * PI * 2.0;
  let z = rng.next_f64() * 2.0 - 1.0;
  let r = (1.0 - z * z).max(0.0).sqrt();
  Point {
    x: r * theta.cos(),
    y: z,
    z: r * theta.sin(),
  }
}

#[derive(Debug, Clone)]
struct SeededRng {
  state: u32,
}

impl SeededRng {
  fn new(seed: u32) -> Self {
    Self { state: seed }
  }

  fn next_f64(&mut self) -> f64 {
    self.state = self.state.wrapping_add(0x6d2b79f5);
    let mut t = self.state;
    t = (t ^ (t >> 15)).wrapping_mul(1 | t);
    let t2 = (t ^ (t >> 7)).wrapping_mul(61 | t);
    t ^= t.wrapping_add(t2);
    let value = t ^ (t >> 14);
    (value as f64) / 4294967296.0
  }
}
