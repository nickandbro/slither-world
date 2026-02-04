use super::constants::{
  BASE_PELLET_COUNT, BASE_SPEED, BOOST_MULTIPLIER, COLOR_POOL, MAX_PELLETS, PLAYER_TIMEOUT_MS,
  RESPAWN_COOLDOWN_MS, SPAWN_CONE_ANGLE, STAMINA_DRAIN_PER_SEC, STAMINA_MAX,
  STAMINA_RECHARGE_PER_SEC, TICK_MS, TURN_RATE,
};
use super::digestion::{add_digestion, advance_digestions, get_digestion_progress};
use super::input::parse_axis;
use super::math::{
  collision, normalize, point_from_spherical, random_axis, rotate_toward, rotate_y, rotate_z,
};
use super::snake::{apply_snake_rotation, create_snake, rotate_snake};
use super::types::{GameStateSnapshot, Player, PlayerSnapshot, Point, SnakeNode};
use crate::shared::names::sanitize_player_name;
use rand::Rng;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug)]
pub struct Room {
  state: Mutex<RoomState>,
  running: AtomicBool,
}

#[derive(Debug)]
struct SessionEntry {
  sender: UnboundedSender<String>,
  player_id: Option<String>,
}

#[derive(Debug)]
struct RoomState {
  sessions: HashMap<String, SessionEntry>,
  players: HashMap<String, Player>,
  pellets: Vec<Point>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ClientMessage {
  #[serde(rename = "join")]
  Join {
    name: Option<String>,
    #[serde(rename = "playerId")]
    player_id: Option<String>,
  },
  #[serde(rename = "respawn")]
  Respawn,
  #[serde(rename = "input")]
  Input { axis: Option<Point>, boost: Option<bool> },
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "type")]
enum ServerMessage {
  #[serde(rename = "init")]
  Init {
    #[serde(rename = "playerId")]
    player_id: String,
    state: GameStateSnapshot,
  },
  #[serde(rename = "state")]
  State { state: GameStateSnapshot },
}

impl Room {
  pub fn new() -> Self {
    Self {
      state: Mutex::new(RoomState {
        sessions: HashMap::new(),
        players: HashMap::new(),
        pellets: Vec::new(),
      }),
      running: AtomicBool::new(false),
    }
  }

  pub async fn add_session(&self, sender: UnboundedSender<String>) -> String {
    let session_id = Uuid::new_v4().to_string();
    let mut state = self.state.lock().await;
    state.sessions.insert(
      session_id.clone(),
      SessionEntry {
        sender,
        player_id: None,
      },
    );
    session_id
  }

  pub async fn remove_session(&self, session_id: &str) {
    let mut state = self.state.lock().await;
    state.disconnect_session(session_id);
  }

  pub async fn handle_text_message(self: &Arc<Self>, session_id: &str, text: &str) {
    let Ok(message) = serde_json::from_str::<ClientMessage>(text) else { return };
    let mut state = self.state.lock().await;
    match message {
      ClientMessage::Join { name, player_id } => {
        state.handle_join(session_id, name, player_id);
        drop(state);
        self.ensure_loop();
      }
      ClientMessage::Respawn => {
        state.handle_respawn(session_id);
      }
      ClientMessage::Input { axis, boost } => {
        state.handle_input(session_id, axis, boost);
      }
    }
  }

  fn ensure_loop(self: &Arc<Self>) {
    if self
      .running
      .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
      .is_err()
    {
      return;
    }

    let room = Arc::clone(self);
    tokio::spawn(async move {
      let mut interval = tokio::time::interval(std::time::Duration::from_millis(TICK_MS));
      loop {
        interval.tick().await;
        let mut state = room.state.lock().await;
        if state.sessions.is_empty() {
          room.running.store(false, Ordering::SeqCst);
          break;
        }
        state.tick();
      }
    });
  }
}

impl RoomState {
  fn now_millis() -> i64 {
    let now = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap_or_default();
    now.as_millis() as i64
  }

  fn disconnect_session(&mut self, session_id: &str) {
    let Some(entry) = self.sessions.remove(session_id) else { return };
    if let Some(player_id) = entry.player_id {
      if let Some(player) = self.players.get_mut(&player_id) {
        player.connected = false;
        player.last_seen = Self::now_millis();
      }
    }
  }

  fn handle_join(&mut self, session_id: &str, name: Option<String>, player_id: Option<String>) {
    let raw_name = name.unwrap_or_else(|| "Player".to_string());
    let sanitized_name = sanitize_player_name(&raw_name, "Player");
    let requested_id = player_id.and_then(|value| if value.is_empty() { None } else { Some(value) });

    let player_id = if let Some(id) = requested_id {
      if let Some(player) = self.players.get_mut(&id) {
        player.name = sanitized_name.clone();
        player.connected = true;
        player.last_seen = Self::now_millis();
        id
      } else {
        let new_player = self.create_player(id.clone(), sanitized_name.clone());
        self.players.insert(id.clone(), new_player);
        id
      }
    } else {
      let id = Uuid::new_v4().to_string();
      let new_player = self.create_player(id.clone(), sanitized_name.clone());
      self.players.insert(id.clone(), new_player);
      id
    };

    let snapshot = self.build_state_snapshot();
    let payload = serde_json::to_string(&ServerMessage::Init {
      player_id: player_id.clone(),
      state: snapshot,
    });

    if let Some(session) = self.sessions.get_mut(session_id) {
      session.player_id = Some(player_id);
      if let Ok(payload) = payload {
        let _ = session.sender.send(payload);
      }
    }
  }

  fn handle_respawn(&mut self, session_id: &str) {
    let Some(player_id) = self.session_player_id(session_id) else { return };
    let should_respawn = match self.players.get(&player_id) {
      Some(player) => {
        if player.alive {
          false
        } else if let Some(respawn_at) = player.respawn_at {
          Self::now_millis() >= respawn_at
        } else {
          true
        }
      }
      None => false,
    };
    if should_respawn {
      self.respawn_player(&player_id);
    }
  }

  fn handle_input(&mut self, session_id: &str, axis: Option<Point>, boost: Option<bool>) {
    let Some(player_id) = self.session_player_id(session_id) else { return };
    let Some(player) = self.players.get_mut(&player_id) else { return };

    if let Some(axis) = axis.and_then(parse_axis) {
      player.target_axis = axis;
    }

    player.boost = boost.unwrap_or(false);
    player.last_seen = Self::now_millis();
  }

  fn session_player_id(&self, session_id: &str) -> Option<String> {
    self
      .sessions
      .get(session_id)
      .and_then(|entry| entry.player_id.clone())
  }

  fn create_player(&self, id: String, name: String) -> Player {
    let base_axis = random_axis();
    let spawned = self.spawn_snake(base_axis);

    Player {
      id,
      name,
      color: COLOR_POOL[self.players.len() % COLOR_POOL.len()].to_string(),
      axis: spawned.axis,
      target_axis: spawned.axis,
      boost: false,
      stamina: STAMINA_MAX,
      score: 0,
      alive: true,
      connected: true,
      last_seen: Self::now_millis(),
      respawn_at: None,
      snake: spawned.snake,
      digestions: Vec::new(),
    }
  }

  fn spawn_snake(&self, base_axis: Point) -> SpawnedSnake {
    let mut rng = rand::thread_rng();
    for _ in 0..8 {
      let mut snake = create_snake(base_axis);
      let theta = rng.gen::<f64>() * std::f64::consts::PI * 2.0;
      let phi = std::f64::consts::PI - rng.gen::<f64>() * SPAWN_CONE_ANGLE;
      let rotate_y_angle = std::f64::consts::PI - phi;

      rotate_snake(&mut snake, theta, rotate_y_angle);
      let mut rotated_axis = base_axis;
      rotate_y(&mut rotated_axis, rotate_y_angle);
      rotate_z(&mut rotated_axis, theta);
      let axis = normalize(rotated_axis);

      if !self.is_snake_too_close(&snake) {
        return SpawnedSnake { snake, axis };
      }
    }

    SpawnedSnake {
      snake: create_snake(base_axis),
      axis: base_axis,
    }
  }

  fn is_snake_too_close(&self, snake: &[SnakeNode]) -> bool {
    let Some(head) = snake.first() else { return false };
    let head_point = Point {
      x: head.x,
      y: head.y,
      z: head.z,
    };

    for player in self.players.values() {
      if !player.alive {
        continue;
      }
      for node in &player.snake {
        let node_point = Point {
          x: node.x,
          y: node.y,
          z: node.z,
        };
        if collision(head_point, node_point) {
          return true;
        }
      }
    }
    false
  }

  fn ensure_pellets(&mut self) {
    let mut rng = rand::thread_rng();
    while self.pellets.len() < BASE_PELLET_COUNT {
      let theta = rng.gen::<f64>() * std::f64::consts::PI * 2.0;
      let phi = rng.gen::<f64>() * std::f64::consts::PI;
      self.pellets.push(point_from_spherical(theta, phi));
    }
  }

  fn tick(&mut self) {
    let now = Self::now_millis();
    self.ensure_pellets();
    let dt_seconds = TICK_MS as f64 / 1000.0;
    let mut move_steps: HashMap<String, i32> = HashMap::new();

    self.players.retain(|_, player| {
      if player.connected {
        true
      } else {
        now - player.last_seen <= PLAYER_TIMEOUT_MS
      }
    });

    let player_ids: Vec<String> = self.players.keys().cloned().collect();
    for id in &player_ids {
      let Some(player) = self.players.get_mut(id) else { continue };
      if !player.alive {
        continue;
      }
      player.axis = rotate_toward(player.axis, player.target_axis, TURN_RATE);
      let wants_boost = player.boost;
      let has_stamina = player.stamina > 0.0;
      let is_boosting = wants_boost && has_stamina;
      if is_boosting {
        player.stamina = (player.stamina - STAMINA_DRAIN_PER_SEC * dt_seconds).max(0.0);
      } else if !wants_boost {
        player.stamina = (player.stamina + STAMINA_RECHARGE_PER_SEC * dt_seconds).min(STAMINA_MAX);
      }
      let speed_factor = if is_boosting { BOOST_MULTIPLIER } else { 1.0 };
      let step_count = (speed_factor.round() as i32).max(1);
      let step_velocity = (BASE_SPEED * speed_factor) / step_count as f64;
      apply_snake_rotation(&mut player.snake, player.axis, step_velocity, step_count);
      move_steps.insert(player.id.clone(), step_count);
    }

    let player_snapshots: Vec<(String, bool, Vec<Point>)> = self
      .players
      .values()
      .map(|player| {
        let snake_points = player
          .snake
          .iter()
          .map(|node| Point {
            x: node.x,
            y: node.y,
            z: node.z,
          })
          .collect::<Vec<_>>();
        (player.id.clone(), player.alive, snake_points)
      })
      .collect();

    let mut dead: HashSet<String> = HashSet::new();

    for (id, alive, snake) in &player_snapshots {
      if !*alive || snake.len() < 3 {
        continue;
      }
      let head = snake[0];
      for node in snake.iter().skip(2) {
        if collision(head, *node) {
          dead.insert(id.clone());
          break;
        }
      }
      if dead.contains(id) {
        continue;
      }
      for (other_id, other_alive, other_snake) in &player_snapshots {
        if !*other_alive || other_id == id {
          continue;
        }
        for node in other_snake {
          if collision(head, *node) {
            dead.insert(id.clone());
            break;
          }
        }
        if dead.contains(id) {
          break;
        }
      }
    }

    for id in dead {
      self.handle_death(&id);
    }

    let player_ids: Vec<String> = self.players.keys().cloned().collect();
    for id in &player_ids {
      let Some(player) = self.players.get_mut(id) else { continue };
      if !player.alive {
        continue;
      }
      let mut i = self.pellets.len();
      while i > 0 {
        i -= 1;
        if !collision(
          Point {
            x: player.snake[0].x,
            y: player.snake[0].y,
            z: player.snake[0].z,
          },
          self.pellets[i],
        ) {
          continue;
        }
        self.pellets.remove(i);
        player.score += 1;
        add_digestion(player);
        if self.pellets.len() < MAX_PELLETS {
          let mut rng = rand::thread_rng();
          let theta = rng.gen::<f64>() * std::f64::consts::PI * 2.0;
          let phi = rng.gen::<f64>() * std::f64::consts::PI;
          self.pellets.push(point_from_spherical(theta, phi));
        }
      }
    }

    let player_ids: Vec<String> = self.players.keys().cloned().collect();
    for id in &player_ids {
      let Some(player) = self.players.get_mut(id) else { continue };
      if !player.alive {
        continue;
      }
      let steps = *move_steps.get(&player.id).unwrap_or(&1);
      advance_digestions(player, steps);
    }

    self.broadcast_state();
  }

  fn handle_death(&mut self, player_id: &str) {
    let Some(player) = self.players.get_mut(player_id) else { return };
    if !player.alive {
      return;
    }
    player.alive = false;
    player.respawn_at = Some(Self::now_millis() + RESPAWN_COOLDOWN_MS);
    player.digestions.clear();

    let mut index = 2;
    while index < player.snake.len() && self.pellets.len() < MAX_PELLETS {
      let node = &player.snake[index];
      self.pellets.push(Point {
        x: node.x,
        y: node.y,
        z: node.z,
      });
      index += 2;
    }

    player.score = 0;
  }

  fn respawn_player(&mut self, player_id: &str) {
    let base_axis = random_axis();
    let spawned = self.spawn_snake(base_axis);
    let Some(player) = self.players.get_mut(player_id) else { return };
    player.axis = spawned.axis;
    player.target_axis = spawned.axis;
    player.score = 0;
    player.alive = true;
    player.boost = false;
    player.stamina = STAMINA_MAX;
    player.respawn_at = None;
    player.snake = spawned.snake;
    player.digestions.clear();
  }

  fn build_state_snapshot(&self) -> GameStateSnapshot {
    GameStateSnapshot {
      now: Self::now_millis(),
      pellets: self.pellets.iter().copied().collect(),
      players: self
        .players
        .values()
        .map(|player| PlayerSnapshot {
          id: player.id.clone(),
          name: player.name.clone(),
          color: player.color.clone(),
          score: player.score,
          stamina: player.stamina,
          alive: player.alive,
          snake: player
            .snake
            .iter()
            .map(|node| Point {
              x: node.x,
              y: node.y,
              z: node.z,
            })
            .collect(),
          digestions: player
            .digestions
            .iter()
            .map(get_digestion_progress)
            .collect(),
        })
        .collect(),
    }
  }

  fn broadcast_state(&mut self) {
    let snapshot = self.build_state_snapshot();
    let Ok(payload) = serde_json::to_string(&ServerMessage::State { state: snapshot }) else {
      return;
    };
    let mut stale = Vec::new();
    for (session_id, session) in &self.sessions {
      if session.sender.send(payload.clone()).is_err() {
        stale.push(session_id.clone());
      }
    }
    for session_id in stale {
      self.disconnect_session(&session_id);
    }
  }
}

#[derive(Debug)]
struct SpawnedSnake {
  snake: Vec<SnakeNode>,
  axis: Point,
}
