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
  pub remaining: i64,
  pub total: i64,
  pub growth_steps: i64,
}

#[derive(Debug, Clone)]
pub struct Player {
  pub id: String,
  pub name: String,
  pub color: String,
  pub axis: Point,
  pub target_axis: Point,
  pub boost: bool,
  pub stamina: f64,
  pub score: i64,
  pub alive: bool,
  pub connected: bool,
  pub last_seen: i64,
  pub respawn_at: Option<i64>,
  pub snake: Vec<SnakeNode>,
  pub digestions: Vec<Digestion>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlayerSnapshot {
  pub id: String,
  pub name: String,
  pub color: String,
  pub score: i64,
  pub stamina: f64,
  pub alive: bool,
  pub snake: Vec<Point>,
  pub digestions: Vec<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GameStateSnapshot {
  pub now: i64,
  pub pellets: Vec<Point>,
  pub players: Vec<PlayerSnapshot>,
}
