use super::constants::{
  BASE_PELLET_COUNT, BASE_SPEED, BOOST_MULTIPLIER, BOT_BOOST_DISTANCE, BOT_COUNT,
  BOT_MIN_STAMINA_TO_BOOST, COLOR_POOL, MAX_PELLETS, MAX_SPAWN_ATTEMPTS, PLAYER_TIMEOUT_MS,
  RESPAWN_COOLDOWN_MS, RESPAWN_RETRY_MS, SPAWN_CONE_ANGLE, STAMINA_DRAIN_PER_SEC, STAMINA_MAX,
  STAMINA_RECHARGE_PER_SEC, TICK_MS, TURN_RATE,
};
use super::digestion::{add_digestion, advance_digestions, get_digestion_progress};
use super::input::parse_axis;
use super::math::{
  collision, cross, length, normalize, point_from_spherical, random_axis, rotate_toward, rotate_y,
  rotate_z,
};
use super::snake::{apply_snake_rotation, create_snake, rotate_snake};
use super::types::{Player, Point, SnakeNode};
use crate::protocol;
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

#[derive(Debug, Clone, Copy)]
pub enum DebugKillTarget {
  Any,
  Bot,
  Human,
}

#[derive(Debug)]
struct SessionEntry {
  sender: UnboundedSender<Vec<u8>>,
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
enum JsonClientMessage {
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

  pub async fn add_session(&self, sender: UnboundedSender<Vec<u8>>) -> String {
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
    let Ok(message) = serde_json::from_str::<JsonClientMessage>(text) else { return };
    let message = match message {
      JsonClientMessage::Join { name, player_id } => {
        let player_id = player_id.and_then(|value| Uuid::parse_str(&value).ok());
        protocol::ClientMessage::Join { name, player_id }
      }
      JsonClientMessage::Respawn => protocol::ClientMessage::Respawn,
      JsonClientMessage::Input { axis, boost } => {
        protocol::ClientMessage::Input {
          axis,
          boost: boost.unwrap_or(false),
        }
      }
    };
    self.handle_client_message(session_id, message).await;
  }

  pub async fn handle_binary_message(self: &Arc<Self>, session_id: &str, data: &[u8]) {
    let Some(message) = protocol::decode_client_message(data) else { return };
    self.handle_client_message(session_id, message).await;
  }

  async fn handle_client_message(self: &Arc<Self>, session_id: &str, message: protocol::ClientMessage) {
    let mut state = self.state.lock().await;
    match message {
      protocol::ClientMessage::Join { name, player_id } => {
        state.handle_join(session_id, name, player_id);
        drop(state);
        self.ensure_loop();
      }
      protocol::ClientMessage::Respawn => {
        state.handle_respawn(session_id);
      }
      protocol::ClientMessage::Input { axis, boost } => {
        state.handle_input(session_id, axis, boost);
      }
    }
  }

  pub async fn debug_kill(&self, target: DebugKillTarget) -> Option<String> {
    let mut state = self.state.lock().await;
    state.debug_kill(target)
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
    if self.human_count() == 0 {
      self.remove_bots();
    }
  }

  fn handle_join(&mut self, session_id: &str, name: Option<String>, player_id: Option<Uuid>) {
    let raw_name = name.unwrap_or_else(|| "Player".to_string());
    let sanitized_name = sanitize_player_name(&raw_name, "Player");

    let player_id = if let Some(id) = player_id {
      let id_string = id.to_string();
      if let Some(player) = self.players.get_mut(&id_string) {
        player.name = sanitized_name.clone();
        player.connected = true;
        player.last_seen = Self::now_millis();
        id_string
      } else {
        let new_player = self.create_player(id, sanitized_name.clone(), false);
        self.players.insert(id_string.clone(), new_player);
        id_string
      }
    } else {
      let id = Uuid::new_v4();
      let id_string = id.to_string();
      let new_player = self.create_player(id, sanitized_name.clone(), false);
      self.players.insert(id_string.clone(), new_player);
      id_string
    };

    let payload = self.build_init_payload(&player_id);
    if let Some(session) = self.sessions.get_mut(session_id) {
      session.player_id = Some(player_id.clone());
      let _ = session.sender.send(payload);
    }
    self.broadcast_player_meta(&[player_id]);
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

  fn handle_input(&mut self, session_id: &str, axis: Option<Point>, boost: bool) {
    let Some(player_id) = self.session_player_id(session_id) else { return };
    let Some(player) = self.players.get_mut(&player_id) else { return };

    if let Some(axis) = axis.and_then(parse_axis) {
      player.target_axis = axis;
    }

    player.boost = boost;
    player.last_seen = Self::now_millis();
  }

  fn debug_kill(&mut self, target: DebugKillTarget) -> Option<String> {
    let target_id = self
      .players
      .iter()
      .filter(|(_, player)| player.alive)
      .filter(|(_, player)| match target {
        DebugKillTarget::Any => true,
        DebugKillTarget::Bot => player.is_bot,
        DebugKillTarget::Human => !player.is_bot && player.connected,
      })
      .map(|(id, _)| id.clone())
      .next();

    if let Some(id) = target_id {
      self.handle_death(&id);
      return Some(id);
    }

    None
  }

  fn session_player_id(&self, session_id: &str) -> Option<String> {
    self
      .sessions
      .get(session_id)
      .and_then(|entry| entry.player_id.clone())
  }

  fn human_count(&self) -> usize {
    self
      .players
      .values()
      .filter(|player| !player.is_bot && player.connected)
      .count()
  }

  fn bot_count(&self) -> usize {
    self.players.values().filter(|player| player.is_bot).count()
  }

  fn remove_bots(&mut self) {
    self.players.retain(|_, player| !player.is_bot);
  }

  fn next_bot_index(&self) -> usize {
    self
      .players
      .values()
      .filter(|player| player.is_bot)
      .filter_map(|player| player.name.strip_prefix("Bot-"))
      .filter_map(|suffix| suffix.parse::<usize>().ok())
      .max()
      .unwrap_or(0)
      + 1
  }

  fn ensure_bots(&mut self) {
    if self.human_count() == 0 {
      self.remove_bots();
      return;
    }

    let mut current = self.bot_count();
    if current >= BOT_COUNT {
      return;
    }

    let mut index = self.next_bot_index();
    let mut new_bot_ids: Vec<String> = Vec::new();
    while current < BOT_COUNT {
      let id = Uuid::new_v4();
      let id_string = id.to_string();
      let name = format!("Bot-{}", index);
      let bot = self.create_player(id, name, true);
      self.players.insert(id_string.clone(), bot);
      new_bot_ids.push(id_string);
      current += 1;
      index += 1;
    }
    if !new_bot_ids.is_empty() {
      self.broadcast_player_meta(&new_bot_ids);
    }
  }

  fn update_bots(&mut self) {
    if self.bot_count() == 0 {
      return;
    }
    let pellets = self.pellets.clone();
    let bot_ids: Vec<String> = self
      .players
      .iter()
      .filter_map(|(id, player)| if player.is_bot { Some(id.clone()) } else { None })
      .collect();

    for bot_id in bot_ids {
      let Some(player) = self.players.get_mut(&bot_id) else { continue };
      if !player.alive {
        continue;
      }

      let Some(head) = player.snake.first() else { continue };
      let head_point = Point {
        x: head.x,
        y: head.y,
        z: head.z,
      };

      let mut nearest: Option<(Point, f64)> = None;
      for pellet in &pellets {
        let delta = Point {
          x: pellet.x - head_point.x,
          y: pellet.y - head_point.y,
          z: pellet.z - head_point.z,
        };
        let dist = length(delta);
        match nearest {
          Some((_, best)) if dist >= best => {}
          _ => nearest = Some((*pellet, dist)),
        }
      }

      if let Some((target_pellet, dist)) = nearest {
        let axis_raw = cross(head_point, target_pellet);
        let axis = if length(axis_raw) < 1e-6 {
          random_axis()
        } else {
          normalize(axis_raw)
        };
        player.target_axis = axis;
        player.boost = dist > BOT_BOOST_DISTANCE && player.stamina > BOT_MIN_STAMINA_TO_BOOST;
      } else {
        player.target_axis = random_axis();
        player.boost = false;
      }
    }
  }

  fn auto_respawn_players(&mut self, now: i64) {
    let respawn_ids: Vec<String> = self
      .players
      .iter()
      .filter_map(|(id, player)| {
        if player.alive {
          return None;
        }
        if !player.is_bot && !player.connected {
          return None;
        }
        match player.respawn_at {
          Some(respawn_at) if now >= respawn_at => Some(id.clone()),
          _ => None,
        }
      })
      .collect();

    for id in respawn_ids {
      self.respawn_player(&id);
    }
  }

  fn create_player(&self, id: Uuid, name: String, is_bot: bool) -> Player {
    let base_axis = random_axis();
    let spawned = self.spawn_snake(base_axis);
    let (alive, axis, snake, respawn_at) = match spawned {
      Some(spawned) => (true, spawned.axis, spawned.snake, None),
      None => (
        false,
        base_axis,
        Vec::new(),
        Some(Self::now_millis() + RESPAWN_RETRY_MS),
      ),
    };

    let id_string = id.to_string();

    Player {
      id: id_string,
      id_bytes: *id.as_bytes(),
      name,
      color: COLOR_POOL[self.players.len() % COLOR_POOL.len()].to_string(),
      is_bot,
      axis,
      target_axis: axis,
      boost: false,
      stamina: STAMINA_MAX,
      score: 0,
      alive,
      connected: true,
      last_seen: Self::now_millis(),
      respawn_at,
      snake,
      digestions: Vec::new(),
    }
  }

  fn spawn_snake(&self, base_axis: Point) -> Option<SpawnedSnake> {
    let mut rng = rand::thread_rng();
    for attempt in 0..MAX_SPAWN_ATTEMPTS {
      let axis_seed = if attempt == 0 {
        base_axis
      } else {
        random_axis()
      };
      let mut snake = create_snake(axis_seed);
      let theta = rng.gen::<f64>() * std::f64::consts::PI * 2.0;
      let phi = std::f64::consts::PI - rng.gen::<f64>() * SPAWN_CONE_ANGLE;
      let rotate_y_angle = std::f64::consts::PI - phi;

      rotate_snake(&mut snake, theta, rotate_y_angle);
      let mut rotated_axis = axis_seed;
      rotate_y(&mut rotated_axis, rotate_y_angle);
      rotate_z(&mut rotated_axis, theta);
      let axis = normalize(rotated_axis);

      if !self.is_snake_too_close(&snake) {
        return Some(SpawnedSnake { snake, axis });
      }
    }

    None
  }

  fn is_snake_too_close(&self, snake: &[SnakeNode]) -> bool {
    if snake.is_empty() {
      return false;
    }

    let candidate_points: Vec<Point> = snake
      .iter()
      .map(|node| Point {
        x: node.x,
        y: node.y,
        z: node.z,
      })
      .collect();

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
        for candidate in &candidate_points {
          if collision(*candidate, node_point) {
            return true;
          }
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

    self.ensure_bots();
    self.update_bots();
    self.auto_respawn_players(now);

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
    tracing::debug!(player_id, is_bot = player.is_bot, "player died");
    player.alive = false;
    player.respawn_at = Some(Self::now_millis() + RESPAWN_COOLDOWN_MS);
    player.digestions.clear();

    for node in player.snake.iter().skip(1) {
      self.pellets.push(Point {
        x: node.x,
        y: node.y,
        z: node.z,
      });
    }

    let max_pellets = u16::MAX as usize;
    if self.pellets.len() > max_pellets {
      let excess = self.pellets.len() - max_pellets;
      self.pellets.drain(0..excess);
    }

    player.score = 0;
  }

  fn respawn_player(&mut self, player_id: &str) {
    let base_axis = random_axis();
    let spawned = self.spawn_snake(base_axis);
    let Some(player) = self.players.get_mut(player_id) else { return };
    let Some(spawned) = spawned else {
      player.respawn_at = Some(Self::now_millis() + RESPAWN_RETRY_MS);
      return;
    };
    player.axis = spawned.axis;
    player.target_axis = spawned.axis;
    player.score = 0;
    player.alive = true;
    player.boost = false;
    player.stamina = STAMINA_MAX;
    player.respawn_at = None;
    player.snake = spawned.snake;
    player.digestions.clear();
    tracing::debug!(player_id, is_bot = player.is_bot, "player respawned");
  }

  fn build_init_payload(&self, player_id: &str) -> Vec<u8> {
    let player_bytes = self
      .players
      .get(player_id)
      .map(|player| player.id_bytes)
      .unwrap_or([0u8; 16]);
    let now = Self::now_millis();
    let mut capacity = 4 + 16 + 8 + 2 + self.pellets.len() * 12 + 2;
    for player in self.players.values() {
      capacity += 16;
      capacity += 1 + Self::truncated_len(&player.name);
      capacity += 1 + Self::truncated_len(&player.color);
    }
    capacity += 2;
    for player in self.players.values() {
      capacity += 16 + 1 + 4 + 4 + 2 + player.snake.len() * 12 + 1 + player.digestions.len() * 4;
    }

    let mut encoder = protocol::Encoder::with_capacity(capacity);
    encoder.write_header(protocol::TYPE_INIT, 0);
    encoder.write_uuid(&player_bytes);
    encoder.write_i64(now);
    encoder.write_u16(self.pellets.len() as u16);
    for pellet in &self.pellets {
      encoder.write_f32(pellet.x as f32);
      encoder.write_f32(pellet.y as f32);
      encoder.write_f32(pellet.z as f32);
    }

    encoder.write_u16(self.players.len() as u16);
    for player in self.players.values() {
      encoder.write_uuid(&player.id_bytes);
      encoder.write_string(&player.name);
      encoder.write_string(&player.color);
    }

    encoder.write_u16(self.players.len() as u16);
    for player in self.players.values() {
      self.write_player_state(&mut encoder, player);
    }

    encoder.into_vec()
  }

  fn build_state_payload(&self, now: i64) -> Vec<u8> {
    let mut capacity = 4 + 8 + 2 + self.pellets.len() * 12 + 2;
    for player in self.players.values() {
      capacity += 16 + 1 + 4 + 4 + 2 + player.snake.len() * 12 + 1 + player.digestions.len() * 4;
    }

    let mut encoder = protocol::Encoder::with_capacity(capacity);
    encoder.write_header(protocol::TYPE_STATE, 0);
    encoder.write_i64(now);
    encoder.write_u16(self.pellets.len() as u16);
    for pellet in &self.pellets {
      encoder.write_f32(pellet.x as f32);
      encoder.write_f32(pellet.y as f32);
      encoder.write_f32(pellet.z as f32);
    }

    encoder.write_u16(self.players.len() as u16);
    for player in self.players.values() {
      self.write_player_state(&mut encoder, player);
    }

    encoder.into_vec()
  }

  fn build_player_meta_payload(&self, player_ids: &[String]) -> Option<Vec<u8>> {
    let mut players: Vec<&Player> = Vec::new();
    for id in player_ids {
      if let Some(player) = self.players.get(id) {
        players.push(player);
      }
    }
    if players.is_empty() {
      return None;
    }

    let mut capacity = 4 + 2;
    for player in &players {
      capacity += 16;
      capacity += 1 + Self::truncated_len(&player.name);
      capacity += 1 + Self::truncated_len(&player.color);
    }

    let mut encoder = protocol::Encoder::with_capacity(capacity);
    encoder.write_header(protocol::TYPE_PLAYER_META, 0);
    encoder.write_u16(players.len() as u16);
    for player in players {
      encoder.write_uuid(&player.id_bytes);
      encoder.write_string(&player.name);
      encoder.write_string(&player.color);
    }
    Some(encoder.into_vec())
  }

  fn broadcast_player_meta(&mut self, player_ids: &[String]) {
    let Some(payload) = self.build_player_meta_payload(player_ids) else { return };
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

  fn write_player_state(&self, encoder: &mut protocol::Encoder, player: &Player) {
    encoder.write_uuid(&player.id_bytes);
    encoder.write_u8(if player.alive { 1 } else { 0 });
    encoder.write_i32(player.score as i32);
    encoder.write_f32(player.stamina as f32);
    let snake_len = player.snake.len().min(u16::MAX as usize) as u16;
    encoder.write_u16(snake_len);
    for node in player.snake.iter().take(snake_len as usize) {
      encoder.write_f32(node.x as f32);
      encoder.write_f32(node.y as f32);
      encoder.write_f32(node.z as f32);
    }
    let digestion_len = player.digestions.len().min(u8::MAX as usize) as u8;
    encoder.write_u8(digestion_len);
    for digestion in player.digestions.iter().take(digestion_len as usize) {
      encoder.write_f32(get_digestion_progress(digestion) as f32);
    }
  }

  fn truncated_len(value: &str) -> usize {
    let bytes = value.as_bytes();
    let mut end = bytes.len().min(u8::MAX as usize);
    while !value.is_char_boundary(end) {
      end = end.saturating_sub(1);
    }
    end
  }

  fn broadcast_state(&mut self) {
    let now = Self::now_millis();
    let payload = self.build_state_payload(now);
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

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::{HashMap, VecDeque};

  fn make_snake(len: usize, start: f64) -> Vec<SnakeNode> {
    (0..len)
      .map(|index| SnakeNode {
        x: start + index as f64,
        y: 0.0,
        z: 0.0,
        pos_queue: VecDeque::new(),
      })
      .collect()
  }

  fn make_player(id: &str, snake: Vec<SnakeNode>) -> Player {
    Player {
      id: id.to_string(),
      id_bytes: [0u8; 16],
      name: "Test".to_string(),
      color: "#ffffff".to_string(),
      is_bot: false,
      axis: Point { x: 1.0, y: 0.0, z: 0.0 },
      target_axis: Point { x: 1.0, y: 0.0, z: 0.0 },
      boost: false,
      stamina: STAMINA_MAX,
      score: 0,
      alive: true,
      connected: true,
      last_seen: 0,
      respawn_at: None,
      snake,
      digestions: Vec::new(),
    }
  }

  fn make_state() -> RoomState {
    RoomState {
      sessions: HashMap::new(),
      players: HashMap::new(),
      pellets: Vec::new(),
    }
  }

  #[test]
  fn death_drops_pellets_for_each_body_node() {
    let mut state = make_state();
    let snake = make_snake(6, 0.0);
    let player_id = "player-1".to_string();
    let player = make_player(&player_id, snake.clone());
    state.players.insert(player_id.clone(), player);

    state.handle_death(&player_id);

    assert_eq!(state.pellets.len(), snake.len() - 1);
    for (pellet, node) in state.pellets.iter().zip(snake.iter().skip(1)) {
      assert_eq!(pellet.x, node.x);
      assert_eq!(pellet.y, node.y);
      assert_eq!(pellet.z, node.z);
    }
  }

  #[test]
  fn death_pellets_clamp_to_u16_max() {
    let mut state = make_state();
    let base_len = u16::MAX as usize - 2;
    state.pellets = vec![Point { x: 0.0, y: 0.0, z: 0.0 }; base_len];

    let snake = make_snake(5, 100.0);
    let player_id = "player-2".to_string();
    let player = make_player(&player_id, snake.clone());
    state.players.insert(player_id.clone(), player);

    state.handle_death(&player_id);

    assert_eq!(state.pellets.len(), u16::MAX as usize);
    let tail = &state.pellets[state.pellets.len() - 4..];
    for (pellet, node) in tail.iter().zip(snake.iter().skip(1)) {
      assert_eq!(pellet.x, node.x);
      assert_eq!(pellet.y, node.y);
      assert_eq!(pellet.z, node.z);
    }
  }
}
