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
    pub settle_steps: i64,
    pub growth_amount: f64,
    pub applied: bool,
    pub strength: f32,
}

#[derive(Debug, Clone)]
pub enum PelletState {
    Idle,
    Attracting { target_player_id: String },
}

#[derive(Debug, Clone)]
pub struct Pellet {
    pub id: u32,
    pub normal: Point,
    pub color_index: u8,
    pub base_size: f32,
    pub current_size: f32,
    pub growth_fraction: f64,
    pub state: PelletState,
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
    pub is_boosting: bool,
    pub oxygen: f64,
    pub oxygen_damage_accumulator: f64,
    pub score: i64,
    pub alive: bool,
    pub connected: bool,
    pub last_seen: i64,
    pub respawn_at: Option<i64>,
    pub boost_floor_len: usize,
    pub snake: Vec<SnakeNode>,
    pub pellet_growth_fraction: f64,
    pub tail_extension: f64,
    pub next_digestion_id: u32,
    pub digestions: Vec<Digestion>,
}
