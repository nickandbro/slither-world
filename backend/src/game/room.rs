use super::constants::{
    BASE_PELLET_COUNT, BASE_SPEED, BOOST_MULTIPLIER, BOT_BOOST_DISTANCE, BOT_COUNT,
    BOT_MIN_STAMINA_TO_BOOST, COLOR_POOL, MAX_PELLETS, MAX_SPAWN_ATTEMPTS, MIN_SURVIVAL_LENGTH,
    OXYGEN_DAMAGE_NODE_INTERVAL_SEC, OXYGEN_DRAIN_PER_SEC, OXYGEN_MAX, PLAYER_TIMEOUT_MS,
    RESPAWN_COOLDOWN_MS, RESPAWN_RETRY_MS, SPAWN_CONE_ANGLE, STAMINA_DRAIN_PER_SEC, STAMINA_MAX,
    STAMINA_RECHARGE_PER_SEC, TICK_MS, TURN_RATE,
};
use super::digestion::{add_digestion, advance_digestions, get_digestion_progress};
use super::environment::{sample_lakes, Environment, LAKE_WATER_MASK_THRESHOLD};
use super::input::parse_axis;
use super::math::{
    clamp, collision, cross, dot, length, normalize, point_from_spherical, random_axis,
    rotate_toward, rotate_y, rotate_z,
};
use super::physics::apply_snake_with_collisions;
use super::snake::{create_snake, rotate_snake};
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

const VIEW_RADIUS_MIN: f64 = 0.2;
const VIEW_RADIUS_MAX: f64 = 1.4;
const VIEW_RADIUS_MARGIN: f64 = 0.14;
const VIEW_NODE_PADDING: usize = 3;
const VIEW_MIN_WINDOW_POINTS: usize = 2;
const VIEW_CAMERA_DISTANCE_MIN: f64 = 4.0;
const VIEW_CAMERA_DISTANCE_MAX: f64 = 10.0;

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
    view_center: Option<Point>,
    view_radius: Option<f64>,
    camera_distance: Option<f64>,
}

#[derive(Debug)]
struct RoomState {
    sessions: HashMap<String, SessionEntry>,
    players: HashMap<String, Player>,
    pellets: Vec<Point>,
    environment: Environment,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SnakeDetail {
    Full,
    Window,
    Stub,
}

#[derive(Clone, Copy, Debug)]
struct SnakeWindow {
    detail: SnakeDetail,
    total_len: usize,
    start: usize,
    len: usize,
}

impl SnakeWindow {
    fn full(total_len: usize) -> Self {
        Self {
            detail: SnakeDetail::Full,
            total_len,
            start: 0,
            len: total_len,
        }
    }

    fn window(total_len: usize, start: usize, len: usize) -> Self {
        if start == 0 && len >= total_len {
            return Self::full(total_len);
        }
        Self {
            detail: SnakeDetail::Window,
            total_len,
            start,
            len,
        }
    }

    fn stub(total_len: usize) -> Self {
        Self {
            detail: SnakeDetail::Stub,
            total_len,
            start: 0,
            len: 0,
        }
    }

    fn include_digestions(&self) -> bool {
        self.detail == SnakeDetail::Full
    }
}

#[derive(Clone, Copy, Debug)]
struct VisiblePlayer<'a> {
    player: &'a Player,
    window: SnakeWindow,
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
    Input {
        axis: Option<Point>,
        boost: Option<bool>,
        #[serde(rename = "viewCenter")]
        view_center: Option<Point>,
        #[serde(rename = "viewRadius")]
        view_radius: Option<f32>,
        #[serde(rename = "cameraDistance")]
        camera_distance: Option<f32>,
    },
}

impl Room {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(RoomState {
                sessions: HashMap::new(),
                players: HashMap::new(),
                pellets: Vec::new(),
                environment: Environment::generate(),
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
                view_center: None,
                view_radius: None,
                camera_distance: None,
            },
        );
        session_id
    }

    pub async fn remove_session(&self, session_id: &str) {
        let mut state = self.state.lock().await;
        state.disconnect_session(session_id);
    }

    pub async fn handle_text_message(self: &Arc<Self>, session_id: &str, text: &str) {
        let Ok(message) = serde_json::from_str::<JsonClientMessage>(text) else {
            return;
        };
        let message = match message {
            JsonClientMessage::Join { name, player_id } => {
                let player_id = player_id.and_then(|value| Uuid::parse_str(&value).ok());
                protocol::ClientMessage::Join { name, player_id }
            }
            JsonClientMessage::Respawn => protocol::ClientMessage::Respawn,
            JsonClientMessage::Input {
                axis,
                boost,
                view_center,
                view_radius,
                camera_distance,
            } => protocol::ClientMessage::Input {
                axis,
                boost: boost.unwrap_or(false),
                view_center,
                view_radius,
                camera_distance,
            },
        };
        self.handle_client_message(session_id, message).await;
    }

    pub async fn handle_binary_message(self: &Arc<Self>, session_id: &str, data: &[u8]) {
        let Some(message) = protocol::decode_client_message(data) else {
            return;
        };
        self.handle_client_message(session_id, message).await;
    }

    async fn handle_client_message(
        self: &Arc<Self>,
        session_id: &str,
        message: protocol::ClientMessage,
    ) {
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
            protocol::ClientMessage::Input {
                axis,
                boost,
                view_center,
                view_radius,
                camera_distance,
            } => {
                state.handle_input(
                    session_id,
                    axis,
                    boost,
                    view_center,
                    view_radius,
                    camera_distance,
                );
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
        let Some(entry) = self.sessions.remove(session_id) else {
            return;
        };
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

        let sender = if let Some(session) = self.sessions.get_mut(session_id) {
            session.player_id = Some(player_id.clone());
            Some(session.sender.clone())
        } else {
            None
        };
        if let Some(sender) = sender {
            let payload = self.build_init_payload_for_session(session_id, &player_id);
            let _ = sender.send(payload);
        }
        self.broadcast_player_meta(&[player_id]);
    }

    fn handle_respawn(&mut self, session_id: &str) {
        let Some(player_id) = self.session_player_id(session_id) else {
            return;
        };
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

    fn handle_input(
        &mut self,
        session_id: &str,
        axis: Option<Point>,
        boost: bool,
        view_center: Option<Point>,
        view_radius: Option<f32>,
        camera_distance: Option<f32>,
    ) {
        if let Some(session) = self.sessions.get_mut(session_id) {
            session.view_center = view_center.and_then(parse_axis);
            session.view_radius = view_radius
                .map(|value| value as f64)
                .filter(|value| value.is_finite())
                .map(|value| clamp(value, VIEW_RADIUS_MIN, VIEW_RADIUS_MAX));
            session.camera_distance = camera_distance
                .map(|value| value as f64)
                .filter(|value| value.is_finite())
                .map(|value| clamp(value, VIEW_CAMERA_DISTANCE_MIN, VIEW_CAMERA_DISTANCE_MAX));
        }

        let Some(player_id) = self.session_player_id(session_id) else {
            return;
        };
        let Some(player) = self.players.get_mut(&player_id) else {
            return;
        };

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

        let alive_bots = self
            .players
            .values()
            .filter(|player| player.alive && player.is_bot)
            .count();
        let alive_humans = self
            .players
            .values()
            .filter(|player| player.alive && !player.is_bot)
            .count();
        tracing::debug!(
            alive_bots,
            alive_humans,
            total_players = self.players.len(),
            "debug_kill_no_target"
        );

        None
    }

    fn session_player_id(&self, session_id: &str) -> Option<String> {
        self.sessions
            .get(session_id)
            .and_then(|entry| entry.player_id.clone())
    }

    fn session_view_params(&self, session_id: &str) -> Option<(Point, f64)> {
        let session = self.sessions.get(session_id)?;
        let player_id = session.player_id.as_ref()?;
        let player = self.players.get(player_id)?;
        let default_center = player
            .snake
            .first()
            .map(|node| Point {
                x: node.x,
                y: node.y,
                z: node.z,
            })
            .and_then(parse_axis);
        let view_center = session.view_center.or(default_center)?;
        let view_radius = session
            .view_radius
            .unwrap_or(1.0)
            .clamp(VIEW_RADIUS_MIN, VIEW_RADIUS_MAX);
        let view_cos = (view_radius + VIEW_RADIUS_MARGIN).cos();
        Some((view_center, view_cos))
    }

    fn snake_window_for_player(
        &self,
        player: &Player,
        is_local_player: bool,
        view: Option<(Point, f64)>,
    ) -> SnakeWindow {
        let total_len = player.snake.len();
        if total_len == 0 {
            return SnakeWindow::stub(0);
        }
        if is_local_player || view.is_none() {
            return SnakeWindow::full(total_len);
        }
        let (view_center, view_cos) = view.expect("checked above");
        let mut best_start = 0usize;
        let mut best_len = 0usize;
        let mut run_start = 0usize;
        let mut run_len = 0usize;

        for (index, node) in player.snake.iter().enumerate() {
            let visible = dot(
                view_center,
                Point {
                    x: node.x,
                    y: node.y,
                    z: node.z,
                },
            ) >= view_cos;
            if visible {
                if run_len == 0 {
                    run_start = index;
                }
                run_len += 1;
                if run_len > best_len {
                    best_len = run_len;
                    best_start = run_start;
                }
            } else {
                run_len = 0;
            }
        }

        if best_len == 0 {
            return SnakeWindow::stub(total_len);
        }

        let start = best_start.saturating_sub(VIEW_NODE_PADDING);
        let end = (best_start + best_len + VIEW_NODE_PADDING).min(total_len);
        let len = end.saturating_sub(start);
        if len < VIEW_MIN_WINDOW_POINTS {
            return SnakeWindow::stub(total_len);
        }
        SnakeWindow::window(total_len, start, len)
    }

    fn visible_players_for_session<'a>(&'a self, session_id: &str) -> Vec<VisiblePlayer<'a>> {
        let local_player_id = self
            .sessions
            .get(session_id)
            .and_then(|session| session.player_id.as_deref());
        let view = self.session_view_params(session_id);
        let mut visible_players = Vec::with_capacity(self.players.len());
        for player in self.players.values() {
            let is_local_player = local_player_id == Some(player.id.as_str());
            let window = self.snake_window_for_player(player, is_local_player, view);
            if is_local_player || window.detail != SnakeDetail::Stub {
                visible_players.push(VisiblePlayer { player, window });
            }
        }
        visible_players
    }

    fn pellet_visible(pellet: Point, view: Option<(Point, f64)>) -> bool {
        let Some((view_center, view_cos)) = view else {
            return true;
        };
        dot(view_center, pellet) >= view_cos
    }

    fn human_count(&self) -> usize {
        self.players
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
        self.players
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
            .filter_map(|(id, player)| {
                if player.is_bot {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect();

        for bot_id in bot_ids {
            let Some(player) = self.players.get_mut(&bot_id) else {
                continue;
            };
            if !player.alive {
                continue;
            }

            let Some(head) = player.snake.first() else {
                continue;
            };
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
                player.boost =
                    dist > BOT_BOOST_DISTANCE && player.stamina > BOT_MIN_STAMINA_TO_BOOST;
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
            oxygen: OXYGEN_MAX,
            oxygen_damage_accumulator: 0.0,
            score: 0,
            alive,
            connected: true,
            last_seen: Self::now_millis(),
            respawn_at,
            snake,
            next_digestion_id: 0,
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
            let Some(player) = self.players.get_mut(id) else {
                continue;
            };
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
                player.stamina =
                    (player.stamina + STAMINA_RECHARGE_PER_SEC * dt_seconds).min(STAMINA_MAX);
            }
            let speed_factor = if is_boosting { BOOST_MULTIPLIER } else { 1.0 };
            let step_count = (speed_factor.round() as i32).max(1);
            let step_velocity = (BASE_SPEED * speed_factor) / step_count as f64;
            apply_snake_with_collisions(
                &mut player.snake,
                &mut player.axis,
                step_velocity,
                step_count,
                &self.environment,
            );
            move_steps.insert(player.id.clone(), step_count);
        }

        let mut death_reasons: HashMap<String, &'static str> = HashMap::new();
        let mut oxygen_dead: HashSet<String> = HashSet::new();
        let player_ids: Vec<String> = self.players.keys().cloned().collect();
        for id in &player_ids {
            let Some(player) = self.players.get_mut(id) else {
                continue;
            };
            if !player.alive {
                continue;
            }
            let head = Point {
                x: player.snake[0].x,
                y: player.snake[0].y,
                z: player.snake[0].z,
            };
            let sample = sample_lakes(head, &self.environment.lakes);
            if sample.boundary > LAKE_WATER_MASK_THRESHOLD {
                player.oxygen = (player.oxygen - OXYGEN_DRAIN_PER_SEC * dt_seconds).max(0.0);
                if player.oxygen <= 0.0 {
                    player.oxygen_damage_accumulator += dt_seconds;
                    let mut drown_dead = false;
                    while player.oxygen_damage_accumulator >= OXYGEN_DAMAGE_NODE_INTERVAL_SEC {
                        player.oxygen_damage_accumulator -= OXYGEN_DAMAGE_NODE_INTERVAL_SEC;
                        if player.snake.len() > MIN_SURVIVAL_LENGTH {
                            player.snake.pop();
                        } else {
                            drown_dead = true;
                            break;
                        }
                    }
                    if drown_dead {
                        oxygen_dead.insert(player.id.clone());
                        death_reasons.entry(player.id.clone()).or_insert("oxygen");
                        player.oxygen_damage_accumulator = 0.0;
                    }
                } else {
                    player.oxygen_damage_accumulator = 0.0;
                }
            } else {
                player.oxygen = OXYGEN_MAX;
                player.oxygen_damage_accumulator = 0.0;
            }
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
                    death_reasons.entry(id.clone()).or_insert("self_collision");
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
                        death_reasons.entry(id.clone()).or_insert("snake_collision");
                        break;
                    }
                }
                if dead.contains(id) {
                    break;
                }
            }
        }

        dead.extend(oxygen_dead);
        for id in dead {
            let reason = death_reasons.get(&id).copied().unwrap_or("collision");
            tracing::debug!(player_id = %id, reason, "death_reason");
            self.handle_death(&id);
        }

        let player_ids: Vec<String> = self.players.keys().cloned().collect();
        for id in &player_ids {
            let Some(player) = self.players.get_mut(id) else {
                continue;
            };
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
            let Some(player) = self.players.get_mut(id) else {
                continue;
            };
            if !player.alive {
                continue;
            }
            let steps = *move_steps.get(&player.id).unwrap_or(&1);
            advance_digestions(player, steps);
        }

        self.broadcast_state();
    }

    fn handle_death(&mut self, player_id: &str) {
        let Some(player) = self.players.get_mut(player_id) else {
            return;
        };
        if !player.alive {
            return;
        }
        tracing::debug!(player_id, is_bot = player.is_bot, "player died");
        player.alive = false;
        player.respawn_at = Some(Self::now_millis() + RESPAWN_COOLDOWN_MS);
        player.digestions.clear();
        player.next_digestion_id = 0;
        player.oxygen_damage_accumulator = 0.0;

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
        let Some(player) = self.players.get_mut(player_id) else {
            return;
        };
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
        player.oxygen = OXYGEN_MAX;
        player.oxygen_damage_accumulator = 0.0;
        player.respawn_at = None;
        player.snake = spawned.snake;
        player.digestions.clear();
        player.next_digestion_id = 0;
        tracing::debug!(player_id, is_bot = player.is_bot, "player respawned");
    }

    fn build_init_payload_for_session(&self, session_id: &str, player_id: &str) -> Vec<u8> {
        let player_bytes = self
            .players
            .get(player_id)
            .map(|player| player.id_bytes)
            .unwrap_or([0u8; 16]);
        let visible_players = self.visible_players_for_session(session_id);
        let total_players = self.players.len().min(u16::MAX as usize);
        let visible_player_count = visible_players.len().min(u16::MAX as usize);
        let pellet_count = self.pellets.len().min(u16::MAX as usize);
        let now = Self::now_millis();
        let mut capacity = 4 + 16 + 8 + 2 + pellet_count * 12 + 2 + 2;
        for player in self.players.values().take(total_players) {
            capacity += 16;
            capacity += 1 + Self::truncated_len(&player.name);
            capacity += 1 + Self::truncated_len(&player.color);
        }
        capacity += 2;
        for visible in visible_players.iter().take(visible_player_count) {
            let player = visible.player;
            let window = visible.window;
            capacity += 16
                + 1
                + 4
                + 4
                + 4
                + 1
                + 2;
            match window.detail {
                SnakeDetail::Full => {
                    capacity += 2 + window.len * 12;
                }
                SnakeDetail::Window => {
                    capacity += 2 + 2 + window.len * 12;
                }
                SnakeDetail::Stub => {}
            }
            capacity += 1;
            if window.include_digestions() {
                capacity += player.digestions.len() * 8;
            }
        }
        capacity += self.environment.encoded_len();

        let mut encoder = protocol::Encoder::with_capacity(capacity);
        encoder.write_header(protocol::TYPE_INIT, 0);
        encoder.write_uuid(&player_bytes);
        encoder.write_i64(now);
        encoder.write_u16(pellet_count as u16);
        for pellet in self.pellets.iter().take(pellet_count) {
            encoder.write_f32(pellet.x as f32);
            encoder.write_f32(pellet.y as f32);
            encoder.write_f32(pellet.z as f32);
        }

        encoder.write_u16(total_players as u16);
        encoder.write_u16(total_players as u16);
        for player in self.players.values().take(total_players) {
            encoder.write_uuid(&player.id_bytes);
            encoder.write_string(&player.name);
            encoder.write_string(&player.color);
        }

        encoder.write_u16(visible_player_count as u16);
        for visible in visible_players.into_iter().take(visible_player_count) {
            self.write_player_state_with_window(&mut encoder, visible.player, visible.window);
        }

        self.environment.write_to(&mut encoder);

        encoder.into_vec()
    }

    fn build_state_payload_for_session(&self, now: i64, session_id: &str) -> Vec<u8> {
        let view = self.session_view_params(session_id);
        let visible_players = self.visible_players_for_session(session_id);
        let total_players = self.players.len().min(u16::MAX as usize);
        let visible_player_count = visible_players.len().min(u16::MAX as usize);

        let visible_pellets = self
            .pellets
            .iter()
            .filter(|pellet| Self::pellet_visible(**pellet, view))
            .count();
        let visible_pellet_count = visible_pellets.min(u16::MAX as usize);

        let mut capacity = 4 + 8 + 2 + visible_pellet_count * 12 + 2 + 2;
        for visible in visible_players.iter().take(visible_player_count) {
            let player = visible.player;
            let window = visible.window;
            capacity += 16 + 1 + 4 + 4 + 4 + 1 + 2;
            match window.detail {
                SnakeDetail::Full => {
                    capacity += 2 + window.len * 12;
                }
                SnakeDetail::Window => {
                    capacity += 2 + 2 + window.len * 12;
                }
                SnakeDetail::Stub => {}
            }
            capacity += 1;
            if window.include_digestions() {
                capacity += player.digestions.len() * 8;
            }
        }

        let mut encoder = protocol::Encoder::with_capacity(capacity);
        encoder.write_header(protocol::TYPE_STATE, 0);
        encoder.write_i64(now);
        encoder.write_u16(visible_pellet_count as u16);
        let mut written_visible_pellets = 0usize;
        for pellet in &self.pellets {
            if !Self::pellet_visible(*pellet, view) {
                continue;
            }
            if written_visible_pellets >= visible_pellet_count {
                break;
            }
            encoder.write_f32(pellet.x as f32);
            encoder.write_f32(pellet.y as f32);
            encoder.write_f32(pellet.z as f32);
            written_visible_pellets += 1;
        }

        encoder.write_u16(total_players as u16);
        encoder.write_u16(visible_player_count as u16);
        for visible in visible_players.into_iter().take(visible_player_count) {
            self.write_player_state_with_window(&mut encoder, visible.player, visible.window);
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
        let Some(payload) = self.build_player_meta_payload(player_ids) else {
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

    fn write_player_state(&self, encoder: &mut protocol::Encoder, player: &Player) {
        self.write_player_state_with_window(encoder, player, SnakeWindow::full(player.snake.len()));
    }

    fn write_player_state_with_window(
        &self,
        encoder: &mut protocol::Encoder,
        player: &Player,
        window: SnakeWindow,
    ) {
        encoder.write_uuid(&player.id_bytes);
        encoder.write_u8(if player.alive { 1 } else { 0 });
        encoder.write_i32(player.score as i32);
        encoder.write_f32(player.stamina as f32);
        encoder.write_f32(player.oxygen as f32);
        let detail = match window.detail {
            SnakeDetail::Full => protocol::SNAKE_DETAIL_FULL,
            SnakeDetail::Window => protocol::SNAKE_DETAIL_WINDOW,
            SnakeDetail::Stub => protocol::SNAKE_DETAIL_STUB,
        };
        encoder.write_u8(detail);
        let total_len = window.total_len.min(u16::MAX as usize) as u16;
        encoder.write_u16(total_len);

        let available = player.snake.len();
        let clamped_start = window.start.min(available).min(u16::MAX as usize);
        let remaining = available.saturating_sub(clamped_start);
        let clamped_len = window.len.min(remaining).min(u16::MAX as usize);

        match window.detail {
            SnakeDetail::Full => {
                encoder.write_u16(clamped_len as u16);
            }
            SnakeDetail::Window => {
                encoder.write_u16(clamped_start as u16);
                encoder.write_u16(clamped_len as u16);
            }
            SnakeDetail::Stub => {}
        }

        if window.detail != SnakeDetail::Stub {
            let end = clamped_start + clamped_len;
            for node in player
                .snake
                .iter()
                .skip(clamped_start)
                .take(end - clamped_start)
            {
                encoder.write_f32(node.x as f32);
                encoder.write_f32(node.y as f32);
                encoder.write_f32(node.z as f32);
            }
        }

        let digestion_len = if window.include_digestions() {
            player.digestions.len().min(u8::MAX as usize) as u8
        } else {
            0
        };
        encoder.write_u8(digestion_len);
        for digestion in player.digestions.iter().take(digestion_len as usize) {
            encoder.write_u32(digestion.id);
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
        let mut stale = Vec::new();
        for (session_id, session) in &self.sessions {
            let payload = self.build_state_payload_for_session(now, session_id);
            if session.sender.send(payload).is_err() {
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
    use crate::game::types::Digestion;
    use std::collections::{HashMap, VecDeque};
    use tokio::sync::mpsc::unbounded_channel;

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
            axis: Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            },
            target_axis: Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            },
            boost: false,
            stamina: STAMINA_MAX,
            oxygen: OXYGEN_MAX,
            oxygen_damage_accumulator: 0.0,
            score: 0,
            alive: true,
            connected: true,
            last_seen: 0,
            respawn_at: None,
            snake,
            next_digestion_id: 0,
            digestions: Vec::new(),
        }
    }

    fn snake_from_xs(xs: &[f64]) -> Vec<SnakeNode> {
        xs.iter()
            .map(|x| SnakeNode {
                x: *x,
                y: 0.0,
                z: 0.0,
                pos_queue: VecDeque::new(),
            })
            .collect()
    }

    fn make_state() -> RoomState {
        RoomState {
            sessions: HashMap::new(),
            players: HashMap::new(),
            pellets: Vec::new(),
            environment: Environment::generate(),
        }
    }

    fn read_u8(bytes: &[u8], offset: &mut usize) -> u8 {
        let value = bytes[*offset];
        *offset += 1;
        value
    }

    fn read_u16(bytes: &[u8], offset: &mut usize) -> u16 {
        let value = u16::from_le_bytes(bytes[*offset..*offset + 2].try_into().unwrap());
        *offset += 2;
        value
    }

    fn skip_player_state(bytes: &[u8], offset: &mut usize) {
        *offset += 16; // player id
        *offset += 1; // alive
        *offset += 4; // score
        *offset += 4; // stamina
        *offset += 4; // oxygen
        let detail = read_u8(bytes, offset);
        let total_len = read_u16(bytes, offset);
        let snake_len = match detail {
            protocol::SNAKE_DETAIL_FULL => read_u16(bytes, offset),
            protocol::SNAKE_DETAIL_WINDOW => {
                let _start = read_u16(bytes, offset);
                read_u16(bytes, offset)
            }
            protocol::SNAKE_DETAIL_STUB => 0,
            _ => panic!("unexpected snake detail"),
        };
        assert!(snake_len <= total_len);
        *offset += snake_len as usize * 12;
        let digestion_len = read_u8(bytes, offset);
        *offset += digestion_len as usize * 8;
    }

    fn decode_state_counts(payload: &[u8]) -> (u16, u16) {
        let mut offset = 0usize;
        let version = read_u8(payload, &mut offset);
        assert_eq!(version, protocol::VERSION);
        let message_type = read_u8(payload, &mut offset);
        assert_eq!(message_type, protocol::TYPE_STATE);
        let _flags = read_u16(payload, &mut offset);
        offset += 8; // now
        let pellet_count = read_u16(payload, &mut offset);
        offset += pellet_count as usize * 12;
        let total_players = read_u16(payload, &mut offset);
        let visible_players = read_u16(payload, &mut offset);
        for _ in 0..visible_players {
            skip_player_state(payload, &mut offset);
        }
        assert_eq!(offset, payload.len());
        (total_players, visible_players)
    }

    fn decode_init_counts(payload: &[u8]) -> (u16, u16) {
        let mut offset = 0usize;
        let version = read_u8(payload, &mut offset);
        assert_eq!(version, protocol::VERSION);
        let message_type = read_u8(payload, &mut offset);
        assert_eq!(message_type, protocol::TYPE_INIT);
        let _flags = read_u16(payload, &mut offset);
        offset += 16; // local player id
        offset += 8; // now
        let pellet_count = read_u16(payload, &mut offset);
        offset += pellet_count as usize * 12;
        let total_players = read_u16(payload, &mut offset);
        let meta_count = read_u16(payload, &mut offset);
        for _ in 0..meta_count {
            offset += 16; // player id
            let name_len = read_u8(payload, &mut offset) as usize;
            offset += name_len;
            let color_len = read_u8(payload, &mut offset) as usize;
            offset += color_len;
        }
        let visible_players = read_u16(payload, &mut offset);
        for _ in 0..visible_players {
            skip_player_state(payload, &mut offset);
        }
        assert!(offset <= payload.len());
        (total_players, visible_players)
    }

    fn insert_session_with_view(
        state: &mut RoomState,
        session_id: &str,
        player_id: &str,
        view_center: Option<Point>,
        view_radius: Option<f64>,
    ) {
        let (tx, _rx) = unbounded_channel::<Vec<u8>>();
        state.sessions.insert(
            session_id.to_string(),
            SessionEntry {
                sender: tx,
                player_id: Some(player_id.to_string()),
                view_center,
                view_radius,
                camera_distance: None,
            },
        );
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
        state.pellets = vec![
            Point {
                x: 0.0,
                y: 0.0,
                z: 0.0
            };
            base_len
        ];

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

    #[test]
    fn write_player_state_encodes_digestion_id_and_progress() {
        let state = make_state();
        let mut player = make_player("player-3", make_snake(2, 0.0));
        player.digestions.push(Digestion {
            id: 42,
            remaining: 2,
            total: 4,
            growth_steps: 1,
        });

        let mut encoder = protocol::Encoder::with_capacity(256);
        state.write_player_state(&mut encoder, &player);
        let payload = encoder.into_vec();

        let mut offset = 16 + 1 + 4 + 4 + 4;
        let detail = payload[offset];
        assert_eq!(detail, protocol::SNAKE_DETAIL_FULL);
        offset += 1;

        let encoded_total_len = u16::from_le_bytes(payload[offset..offset + 2].try_into().unwrap());
        assert_eq!(encoded_total_len as usize, player.snake.len());
        offset += 2;

        let encoded_window_len =
            u16::from_le_bytes(payload[offset..offset + 2].try_into().unwrap());
        assert_eq!(encoded_window_len as usize, player.snake.len());
        offset += 2;
        offset += player.snake.len() * 12;

        assert_eq!(payload[offset], 1);
        offset += 1;

        let encoded_id = u32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap());
        assert_eq!(encoded_id, 42);
        offset += 4;

        let encoded_progress = f32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap());
        let expected_progress = get_digestion_progress(&player.digestions[0]) as f32;
        assert!((encoded_progress - expected_progress).abs() < 1e-6);
    }

    #[test]
    fn snake_window_uses_partial_window_for_remote_players() {
        let state = make_state();
        let player = make_player(
            "player-window",
            snake_from_xs(&[
                -0.9, -0.8, -0.7, -0.6, -0.5, -0.2, 0.92, 0.9, -0.1, -0.2, -0.3, -0.4, -0.5, -0.6,
            ]),
        );

        let view_cos = (0.6f64 + VIEW_RADIUS_MARGIN).cos();
        let window = state.snake_window_for_player(
            &player,
            false,
            Some((
                Point {
                    x: 1.0,
                    y: 0.0,
                    z: 0.0,
                },
                view_cos,
            )),
        );

        assert_eq!(window.detail, SnakeDetail::Window);
        assert_eq!(window.total_len, 14);
        assert_eq!(window.start, 3);
        assert_eq!(window.len, 8);
    }

    #[test]
    fn snake_window_returns_stub_when_remote_snake_is_out_of_view() {
        let state = make_state();
        let player = make_player(
            "player-stub",
            snake_from_xs(&[-0.95, -0.9, -0.88, -0.85, -0.82]),
        );
        let view_cos = (0.45f64 + VIEW_RADIUS_MARGIN).cos();
        let window = state.snake_window_for_player(
            &player,
            false,
            Some((
                Point {
                    x: 1.0,
                    y: 0.0,
                    z: 0.0,
                },
                view_cos,
            )),
        );
        assert_eq!(window.detail, SnakeDetail::Stub);
        assert_eq!(window.total_len, 5);
    }

    #[test]
    fn build_state_payload_for_session_excludes_stub_remote_players() {
        let mut state = make_state();
        let local_id = "local-player".to_string();
        let visible_remote_id = "visible-remote".to_string();
        let hidden_remote_id = "hidden-remote".to_string();

        state.players.insert(
            local_id.clone(),
            make_player(&local_id, snake_from_xs(&[0.2, 0.1, 0.0, -0.1])),
        );
        state.players.insert(
            visible_remote_id,
            make_player("visible-remote", snake_from_xs(&[0.96, 0.94, 0.9, 0.86])),
        );
        state.players.insert(
            hidden_remote_id,
            make_player("hidden-remote", snake_from_xs(&[-0.95, -0.92, -0.9, -0.88])),
        );
        insert_session_with_view(
            &mut state,
            "session-1",
            &local_id,
            Some(Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            }),
            Some(0.45),
        );

        let payload = state.build_state_payload_for_session(1234, "session-1");
        let (total_players, visible_players) = decode_state_counts(&payload);
        assert_eq!(total_players, 3);
        assert_eq!(visible_players, 2);
    }

    #[test]
    fn build_init_payload_for_session_uses_view_scoped_player_count() {
        let mut state = make_state();
        let local_id = "local-player".to_string();
        state.players.insert(
            local_id.clone(),
            make_player(&local_id, snake_from_xs(&[0.2, 0.1, 0.0, -0.1])),
        );
        state.players.insert(
            "visible-remote".to_string(),
            make_player("visible-remote", snake_from_xs(&[0.96, 0.94, 0.9, 0.86])),
        );
        state.players.insert(
            "hidden-remote".to_string(),
            make_player("hidden-remote", snake_from_xs(&[-0.95, -0.92, -0.9, -0.88])),
        );
        insert_session_with_view(
            &mut state,
            "session-2",
            &local_id,
            Some(Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            }),
            Some(0.45),
        );

        let payload = state.build_init_payload_for_session("session-2", &local_id);
        let (total_players, visible_players) = decode_init_counts(&payload);
        assert_eq!(total_players, 3);
        assert_eq!(visible_players, 2);
    }

    #[test]
    fn build_state_payload_includes_local_player_when_local_snake_is_empty() {
        let mut state = make_state();
        let local_id = "local-empty".to_string();
        let mut local_player = make_player(&local_id, Vec::new());
        local_player.alive = false;
        state.players.insert(local_id.clone(), local_player);
        state.players.insert(
            "hidden-remote".to_string(),
            make_player("hidden-remote", snake_from_xs(&[-0.95, -0.92, -0.9, -0.88])),
        );
        insert_session_with_view(
            &mut state,
            "session-3",
            &local_id,
            Some(Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            }),
            Some(0.45),
        );

        let payload = state.build_state_payload_for_session(1234, "session-3");
        let (total_players, visible_players) = decode_state_counts(&payload);
        assert_eq!(total_players, 2);
        assert_eq!(visible_players, 1);
    }

    fn make_full_lake_state() -> RoomState {
        use crate::game::environment::Lake;
        let mut state = make_state();
        state.environment.lakes = vec![Lake {
            center: Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            },
            radius: std::f64::consts::PI,
            depth: 0.2,
            shelf_depth: 0.1,
            edge_falloff: 0.05,
            noise_amplitude: 0.0,
            noise_frequency: 1.0,
            noise_frequency_b: 1.0,
            noise_frequency_c: 1.0,
            noise_phase: 0.0,
            noise_phase_b: 0.0,
            noise_phase_c: 0.0,
            warp_amplitude: 0.0,
            surface_inset: 0.08,
            tangent: Point {
                x: 0.0,
                y: 1.0,
                z: 0.0,
            },
            bitangent: Point {
                x: 0.0,
                y: 0.0,
                z: 1.0,
            },
        }];
        state
    }

    #[test]
    fn oxygen_depletion_shrinks_snake_over_time() {
        let mut state = make_full_lake_state();
        let player_id = "player-oxygen-shrink".to_string();
        let mut player = make_player(
            &player_id,
            create_snake(Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            }),
        );
        player.oxygen = 0.0;
        state.players.insert(player_id.clone(), player);

        for _ in 0..20 {
            state.tick();
        }

        let player = state.players.get(&player_id).expect("player");
        assert!(player.alive);
        assert_eq!(player.snake.len(), 7);
    }

    #[test]
    fn oxygen_depletion_kills_at_min_survival_length() {
        let mut state = make_full_lake_state();
        let player_id = "player-oxygen-min".to_string();
        let mut snake = create_snake(Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        });
        snake.truncate(MIN_SURVIVAL_LENGTH);
        let mut player = make_player(&player_id, snake);
        player.oxygen = 0.0;
        state.players.insert(player_id.clone(), player);

        for _ in 0..20 {
            state.tick();
        }

        let player = state.players.get(&player_id).expect("player");
        assert!(!player.alive);
        assert_eq!(player.score, 0);
    }

    #[test]
    fn oxygen_damage_accumulator_resets_when_not_underwater() {
        let mut state = make_full_lake_state();
        let player_id = "player-oxygen-reset".to_string();
        let mut player = make_player(
            &player_id,
            create_snake(Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            }),
        );
        player.oxygen = 0.0;
        state.players.insert(player_id.clone(), player);

        for _ in 0..10 {
            state.tick();
        }

        let half_accumulated = state
            .players
            .get(&player_id)
            .expect("player")
            .oxygen_damage_accumulator;
        assert!(half_accumulated > 0.0 && half_accumulated < OXYGEN_DAMAGE_NODE_INTERVAL_SEC);

        state.environment.lakes.clear();
        state.tick();

        let player = state.players.get(&player_id).expect("player");
        assert_eq!(player.oxygen, OXYGEN_MAX);
        assert_eq!(player.oxygen_damage_accumulator, 0.0);
        assert_eq!(player.snake.len(), 8);
    }
}
