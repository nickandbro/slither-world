use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Point {
  pub x: f64,
  pub y: f64,
  pub z: f64,
}

#[derive(Debug, Clone)]
pub struct SnakeNode {
  pub x: f64,
  pub y: f64,
  pub z: f64,
  pub pos_queue: VecDeque<Option<Point>>,
}

#[derive(Debug, Clone)]
pub struct Digestion {
  pub id: u32,
  pub remaining: i64,
  pub total: i64,
  pub growth_steps: i64,
}

#[derive(Debug, Clone)]
pub struct Player {
  pub id: String,
  pub id_bytes: [u8; 16],
  pub name: String,
  pub color: String,
  pub is_bot: bool,
  pub axis: Point,
  pub target_axis: Point,
  pub boost: bool,
  pub stamina: f64,
  pub oxygen: f64,
  pub oxygen_damage_accumulator: f64,
  pub score: i64,
  pub alive: bool,
  pub connected: bool,
  pub last_seen: i64,
  pub respawn_at: Option<i64>,
  pub snake: Vec<SnakeNode>,
  pub next_digestion_id: u32,
  pub digestions: Vec<Digestion>,
}
