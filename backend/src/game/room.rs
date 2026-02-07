use super::constants::{
    BASE_PELLET_COUNT, BASE_SPEED, BIG_PELLET_GROWTH_FRACTION, BOOST_MULTIPLIER,
    BOT_BOOST_DISTANCE, BOT_COUNT, BOT_MIN_STAMINA_TO_BOOST, COLOR_POOL, DEATH_PELLET_SIZE_MAX,
    DEATH_PELLET_SIZE_MIN, MAX_PELLETS, MAX_SPAWN_ATTEMPTS, MIN_SURVIVAL_LENGTH, NODE_QUEUE_SIZE,
    OXYGEN_DRAIN_PER_SEC, OXYGEN_MAX, PELLET_SIZE_ENCODE_MAX, PELLET_SIZE_ENCODE_MIN,
    PLAYER_TIMEOUT_MS, RESPAWN_COOLDOWN_MS, RESPAWN_RETRY_MS, SMALL_PELLET_ATTRACT_RADIUS,
    SMALL_PELLET_ATTRACT_SPEED, SMALL_PELLET_ATTRACT_STEP_MAX_RATIO, SMALL_PELLET_CONSUME_ANGLE,
    SMALL_PELLET_DIGESTION_STRENGTH, SMALL_PELLET_DIGESTION_STRENGTH_MAX,
    SMALL_PELLET_GROWTH_FRACTION,
    SMALL_PELLET_LOCK_CONE_ANGLE, SMALL_PELLET_MOUTH_FORWARD, SMALL_PELLET_SHRINK_MIN_RATIO,
    SMALL_PELLET_SIZE_MAX, SMALL_PELLET_SIZE_MIN, SMALL_PELLET_SPAWN_HEAD_EXCLUSION_ANGLE,
    SMALL_PELLET_VIEW_MARGIN_MAX, SMALL_PELLET_VIEW_MARGIN_MIN, SMALL_PELLET_VISIBLE_MAX,
    SMALL_PELLET_VISIBLE_MIN, SMALL_PELLET_ZOOM_MAX_CAMERA_DISTANCE,
    SMALL_PELLET_ZOOM_MIN_CAMERA_DISTANCE, SNAKE_GIRTH_MAX_SCALE, SNAKE_GIRTH_NODES_PER_STEP,
    SNAKE_GIRTH_STEP_PERCENT, SPAWN_CONE_ANGLE, SPAWN_PLAYER_MIN_DISTANCE, STAMINA_DRAIN_PER_SEC,
    STAMINA_MAX, STAMINA_RECHARGE_PER_SEC, STARTING_LENGTH, TICK_MS, TURN_RATE,
};
use super::digestion::{add_digestion_with_strength, advance_digestions, get_digestion_progress};
use super::environment::{
    sample_lakes, Environment, LAKE_EXCLUSION_THRESHOLD, LAKE_WATER_MASK_THRESHOLD, PLANET_RADIUS,
    SNAKE_RADIUS, TREE_TRUNK_RADIUS,
};
use super::input::parse_axis;
use super::math::{
    base_collision_angular_radius, clamp, collision_distance_for_angular_radii,
    collision_with_angular_radii, cross, dot, length, normalize, point_from_spherical, random_axis,
    rotate_around_axis, rotate_toward, rotate_y, rotate_z,
};
use super::physics::apply_snake_with_collisions;
use super::snake::{create_snake, rotate_snake};
use super::types::{Pellet, PelletState, Player, Point, SnakeNode};
use crate::protocol;
use crate::shared::names::sanitize_player_name;
use rand::Rng;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;
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
    pellets: Vec<Pellet>,
    next_pellet_id: u32,
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

#[derive(Clone, Copy, Debug)]
struct HeadAttractor {
    head: Point,
    forward: Point,
    mouth: Point,
}

#[derive(Debug)]
struct PlayerCollisionSnapshot {
    id: String,
    alive: bool,
    snake: Vec<Point>,
    contact_angular_radius: f64,
    body_angular_radius: f64,
}

const SMALL_PELLET_COLOR_COUNT: u8 = 12;
const PELLET_SPAWN_COLLIDER_MARGIN_ANGLE: f64 = 0.0055;
const PELLET_DEATH_LOCAL_RESPAWN_ATTEMPTS: usize = 14;
const PELLET_DEATH_GLOBAL_RESPAWN_ATTEMPTS: usize = 40;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum JsonClientMessage {
    #[serde(rename = "join")]
    Join {
        name: Option<String>,
        #[serde(rename = "playerId")]
        player_id: Option<String>,
        #[serde(rename = "deferSpawn")]
        defer_spawn: Option<bool>,
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
                next_pellet_id: 0,
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
            JsonClientMessage::Join {
                name,
                player_id,
                defer_spawn,
            } => {
                let player_id = player_id.and_then(|value| Uuid::parse_str(&value).ok());
                protocol::ClientMessage::Join {
                    name,
                    player_id,
                    defer_spawn: defer_spawn.unwrap_or(false),
                }
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
            protocol::ClientMessage::Join {
                name,
                player_id,
                defer_spawn,
            } => {
                state.handle_join(session_id, name, player_id, defer_spawn);
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

    fn handle_join(
        &mut self,
        session_id: &str,
        name: Option<String>,
        player_id: Option<Uuid>,
        defer_spawn: bool,
    ) {
        let raw_name = name.unwrap_or_else(|| "Player".to_string());
        let sanitized_name = sanitize_player_name(&raw_name, "Player");

        let player_id = if let Some(id) = player_id {
            let id_string = id.to_string();
            if let Some(player) = self.players.get_mut(&id_string) {
                player.name = sanitized_name.clone();
                player.connected = true;
                player.last_seen = Self::now_millis();
                if defer_spawn && !player.is_bot {
                    Self::prepare_player_for_manual_spawn(player);
                }
                id_string
            } else {
                let mut new_player = self.create_player(id, sanitized_name.clone(), false);
                if defer_spawn {
                    Self::prepare_player_for_manual_spawn(&mut new_player);
                }
                self.players.insert(id_string.clone(), new_player);
                id_string
            }
        } else {
            let id = Uuid::new_v4();
            let id_string = id.to_string();
            let mut new_player = self.create_player(id, sanitized_name.clone(), false);
            if defer_spawn {
                Self::prepare_player_for_manual_spawn(&mut new_player);
            }
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

    fn prepare_player_for_manual_spawn(player: &mut Player) {
        player.boost = false;
        player.is_boosting = false;
        player.stamina = STAMINA_MAX;
        player.oxygen = OXYGEN_MAX;
        player.oxygen_damage_accumulator = 0.0;
        player.score = 0;
        player.alive = false;
        player.respawn_at = None;
        player.snake.clear();
        player.pellet_growth_fraction = 0.0;
        player.tail_extension = 0.0;
        player.next_digestion_id = 0;
        player.digestions.clear();
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

    fn pellet_zoom_t(camera_distance: Option<f64>) -> f64 {
        let distance = camera_distance
            .unwrap_or((VIEW_CAMERA_DISTANCE_MIN + VIEW_CAMERA_DISTANCE_MAX) * 0.5)
            .clamp(
                SMALL_PELLET_ZOOM_MIN_CAMERA_DISTANCE,
                SMALL_PELLET_ZOOM_MAX_CAMERA_DISTANCE,
            );
        let denom = (SMALL_PELLET_ZOOM_MAX_CAMERA_DISTANCE - SMALL_PELLET_ZOOM_MIN_CAMERA_DISTANCE)
            .max(1e-6);
        (distance - SMALL_PELLET_ZOOM_MIN_CAMERA_DISTANCE) / denom
    }

    fn pellet_view_params(&self, session_id: &str) -> Option<(Point, f64, usize)> {
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
        let zoom_t = Self::pellet_zoom_t(session.camera_distance);
        let visible_count = ((SMALL_PELLET_VISIBLE_MIN as f64)
            + ((SMALL_PELLET_VISIBLE_MAX - SMALL_PELLET_VISIBLE_MIN) as f64) * zoom_t)
            .round()
            .max(1.0) as usize;
        let extra_margin = SMALL_PELLET_VIEW_MARGIN_MIN
            + (SMALL_PELLET_VIEW_MARGIN_MAX - SMALL_PELLET_VIEW_MARGIN_MIN) * zoom_t;
        let visible_cos = (view_radius + VIEW_RADIUS_MARGIN + extra_margin).cos();
        Some((view_center, visible_cos, visible_count))
    }

    fn visible_pellets_for_session<'a>(&'a self, session_id: &str) -> Vec<&'a Pellet> {
        let absolute_max = u16::MAX as usize;
        let Some((view_center, view_cos, max_visible)) = self.pellet_view_params(session_id) else {
            return self.pellets.iter().take(absolute_max).collect();
        };
        let capped_visible = max_visible.min(absolute_max);
        let mut visible = Vec::with_capacity(capped_visible.min(self.pellets.len()));
        for pellet in &self.pellets {
            if dot(view_center, pellet.normal) < view_cos {
                continue;
            }
            visible.push(pellet);
            if visible.len() >= capped_visible {
                break;
            }
        }
        visible
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
        let pellets: Vec<Point> = self.pellets.iter().map(|pellet| pellet.normal).collect();
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
        let spawned = self.spawn_snake(base_axis, None);
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
            is_boosting: false,
            stamina: STAMINA_MAX,
            oxygen: OXYGEN_MAX,
            oxygen_damage_accumulator: 0.0,
            score: 0,
            alive,
            connected: true,
            last_seen: Self::now_millis(),
            respawn_at,
            snake,
            pellet_growth_fraction: 0.0,
            tail_extension: 0.0,
            next_digestion_id: 0,
            digestions: Vec::new(),
        }
    }

    fn spawn_snake(
        &self,
        base_axis: Point,
        excluded_player_id: Option<&str>,
    ) -> Option<SpawnedSnake> {
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

            if !self.is_snake_too_close(&snake, excluded_player_id) {
                return Some(SpawnedSnake { snake, axis });
            }
        }

        None
    }

    fn is_snake_too_close(&self, snake: &[SnakeNode], excluded_player_id: Option<&str>) -> bool {
        if snake.is_empty() {
            return false;
        }
        let candidate_girth_scale = 1.0;
        let candidate_body_angular_radius =
            Self::snake_body_angular_radius_for_scale(candidate_girth_scale);
        let candidate_head = Point {
            x: snake[0].x,
            y: snake[0].y,
            z: snake[0].z,
        };

        for player in self.players.values() {
            if excluded_player_id == Some(player.id.as_str()) {
                continue;
            }
            let Some(other_head) = player.snake.first() else {
                continue;
            };
            let other_body_angular_radius =
                Self::snake_body_angular_radius_for_len(player.snake.len());
            let dynamic_min_distance = collision_distance_for_angular_radii(
                candidate_body_angular_radius,
                other_body_angular_radius,
            ) * 2.0;
            let min_head_distance = dynamic_min_distance.max(SPAWN_PLAYER_MIN_DISTANCE);
            let distance = length(Point {
                x: candidate_head.x - other_head.x,
                y: candidate_head.y - other_head.y,
                z: candidate_head.z - other_head.z,
            });
            if distance < min_head_distance {
                return true;
            }
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
            if excluded_player_id == Some(player.id.as_str()) {
                continue;
            }
            let other_body_angular_radius =
                Self::snake_body_angular_radius_for_len(player.snake.len());
            for node in &player.snake {
                let node_point = Point {
                    x: node.x,
                    y: node.y,
                    z: node.z,
                };
                for candidate in &candidate_points {
                    if collision_with_angular_radii(
                        *candidate,
                        node_point,
                        candidate_body_angular_radius,
                        other_body_angular_radius,
                    ) {
                        return true;
                    }
                }
            }
        }
        false
    }

    fn next_small_pellet_id(&mut self) -> u32 {
        let id = self.next_pellet_id;
        self.next_pellet_id = self.next_pellet_id.wrapping_add(1);
        id
    }

    fn random_unit_point(rng: &mut impl Rng) -> Point {
        let theta = rng.gen::<f64>() * PI * 2.0;
        let phi = rng.gen::<f64>() * PI;
        point_from_spherical(theta, phi)
    }

    fn random_small_pellet(&mut self, rng: &mut impl Rng) -> Pellet {
        let normal = Self::random_unit_point(rng);
        let size = rng.gen_range(SMALL_PELLET_SIZE_MIN..=SMALL_PELLET_SIZE_MAX);
        Pellet {
            id: self.next_small_pellet_id(),
            normal,
            color_index: rng.gen_range(0..SMALL_PELLET_COLOR_COUNT),
            base_size: size,
            current_size: size,
            growth_fraction: SMALL_PELLET_GROWTH_FRACTION,
            state: PelletState::Idle,
        }
    }

    fn is_far_enough_from_heads(&self, point: Point) -> bool {
        let min_dot = SMALL_PELLET_SPAWN_HEAD_EXCLUSION_ANGLE.cos();
        for player in self.players.values() {
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
            if dot(head_point, point) > min_dot {
                return false;
            }
        }
        true
    }

    fn tangent_basis(normal: Point) -> (Point, Point) {
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

    fn sample_outline_radius(outline: &[f64], theta: f64) -> f64 {
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

    fn point_inside_tree_or_cactus_collider(&self, point: Point) -> bool {
        for tree in &self.environment.trees {
            let trunk_radius = (TREE_TRUNK_RADIUS * tree.width_scale.abs()) / PLANET_RADIUS;
            let dot_value = clamp(dot(point, tree.normal), -1.0, 1.0);
            let angle = dot_value.acos();
            if !angle.is_finite() {
                continue;
            }
            if angle < trunk_radius + PELLET_SPAWN_COLLIDER_MARGIN_ANGLE {
                return true;
            }
        }
        false
    }

    fn point_inside_mountain_collider(
        point: Point,
        mountain: &super::environment::MountainInstance,
    ) -> bool {
        let dot_value = clamp(dot(point, mountain.normal), -1.0, 1.0);
        let angle = dot_value.acos();
        if !angle.is_finite() {
            return false;
        }

        let (tangent, bitangent) = Self::tangent_basis(mountain.normal);
        let mut projection = Point {
            x: point.x - mountain.normal.x * dot_value,
            y: point.y - mountain.normal.y * dot_value,
            z: point.z - mountain.normal.z * dot_value,
        };
        if length(projection) < 1e-6 {
            projection = tangent;
        }
        let x = dot(projection, tangent);
        let y = dot(projection, bitangent);
        let mut theta = y.atan2(x);
        if theta < 0.0 {
            theta += PI * 2.0;
        }
        let outline_radius = Self::sample_outline_radius(&mountain.outline, theta);
        angle < outline_radius + PELLET_SPAWN_COLLIDER_MARGIN_ANGLE
    }

    fn is_invalid_pellet_spawn(&self, point: Point) -> bool {
        let len = length(point);
        if !len.is_finite() || len <= 1e-8 {
            return true;
        }

        // Keep legacy tests and non-surface diagnostics deterministic by only applying
        // terrain collider checks to points that are on the sphere surface.
        if !(0.85..=1.15).contains(&len) {
            return false;
        }

        let normal = Point {
            x: point.x / len,
            y: point.y / len,
            z: point.z / len,
        };

        if sample_lakes(normal, &self.environment.lakes).boundary > LAKE_EXCLUSION_THRESHOLD {
            return true;
        }

        if self.point_inside_tree_or_cactus_collider(normal) {
            return true;
        }

        self.environment
            .mountains
            .iter()
            .any(|mountain| Self::point_inside_mountain_collider(normal, mountain))
    }

    fn pick_valid_death_pellet_spawn(&self, origin: Point, rng: &mut impl Rng) -> Option<Point> {
        let len = length(origin);
        if !len.is_finite() || len <= 1e-8 {
            return None;
        }
        if !(0.85..=1.15).contains(&len) {
            return Some(origin);
        }

        let origin_normal = Point {
            x: origin.x / len,
            y: origin.y / len,
            z: origin.z / len,
        };
        if !self.is_invalid_pellet_spawn(origin_normal) {
            return Some(origin_normal);
        }

        for _ in 0..PELLET_DEATH_LOCAL_RESPAWN_ATTEMPTS {
            let target = Self::random_unit_point(rng);
            let jitter_angle = rng.gen_range(0.025..0.26);
            let candidate = rotate_toward(origin_normal, target, jitter_angle);
            if !self.is_invalid_pellet_spawn(candidate) {
                return Some(candidate);
            }
        }

        for _ in 0..PELLET_DEATH_GLOBAL_RESPAWN_ATTEMPTS {
            let candidate = Self::random_unit_point(rng);
            if !self.is_invalid_pellet_spawn(candidate) {
                return Some(candidate);
            }
        }

        None
    }

    fn spawn_small_pellet_with_rng(&mut self, rng: &mut impl Rng) -> Option<Pellet> {
        const SPAWN_ATTEMPTS: usize = 20;
        for _ in 0..SPAWN_ATTEMPTS {
            let pellet = self.random_small_pellet(rng);
            if self.is_far_enough_from_heads(pellet.normal)
                && !self.is_invalid_pellet_spawn(pellet.normal)
            {
                return Some(pellet);
            }
        }
        None
    }

    fn ensure_pellets(&mut self) {
        if self.pellets.len() > MAX_PELLETS {
            let excess = self.pellets.len() - MAX_PELLETS;
            self.pellets.drain(0..excess);
        }
        let target = BASE_PELLET_COUNT.min(MAX_PELLETS);
        if self.pellets.len() >= target {
            return;
        }
        let mut rng = rand::thread_rng();
        let mut attempts = 0usize;
        let max_attempts = (target.saturating_sub(self.pellets.len()) * 24).max(64);
        while self.pellets.len() < target && attempts < max_attempts {
            if let Some(pellet) = self.spawn_small_pellet_with_rng(&mut rng) {
                self.pellets.push(pellet);
            }
            attempts += 1;
        }
    }

    fn build_head_attractors(&self) -> HashMap<String, HeadAttractor> {
        let mut attractors = HashMap::with_capacity(self.players.len());
        for (id, player) in &self.players {
            if !player.alive {
                continue;
            }
            let Some(head_node) = player.snake.first() else {
                continue;
            };
            let head = Point {
                x: head_node.x,
                y: head_node.y,
                z: head_node.z,
            };
            let head = normalize(head);

            let mut forward = if player.snake.len() > 1 {
                let next_node = player.snake[1].clone();
                let next = normalize(Point {
                    x: next_node.x,
                    y: next_node.y,
                    z: next_node.z,
                });
                let raw = Point {
                    x: head.x - next.x,
                    y: head.y - next.y,
                    z: head.z - next.z,
                };
                let projected = Point {
                    x: raw.x - head.x * dot(raw, head),
                    y: raw.y - head.y * dot(raw, head),
                    z: raw.z - head.z * dot(raw, head),
                };
                if length(projected) > 1e-6 {
                    normalize(projected)
                } else {
                    Point {
                        x: 0.0,
                        y: 0.0,
                        z: 0.0,
                    }
                }
            } else {
                Point {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                }
            };

            if length(forward) <= 1e-6 {
                let fallback = cross(player.axis, head);
                if length(fallback) > 1e-6 {
                    forward = normalize(fallback);
                } else {
                    let up = Point {
                        x: 0.0,
                        y: 1.0,
                        z: 0.0,
                    };
                    let world_right = Point {
                        x: 1.0,
                        y: 0.0,
                        z: 0.0,
                    };
                    let cross_up = cross(head, up);
                    if length(cross_up) > 1e-6 {
                        forward = normalize(cross_up);
                    } else {
                        forward = normalize(cross(head, world_right));
                    }
                }
            }

            let mouth = normalize(Point {
                x: head.x + forward.x * SMALL_PELLET_MOUTH_FORWARD,
                y: head.y + forward.y * SMALL_PELLET_MOUTH_FORWARD,
                z: head.z + forward.z * SMALL_PELLET_MOUTH_FORWARD,
            });
            attractors.insert(
                id.clone(),
                HeadAttractor {
                    head,
                    forward,
                    mouth,
                },
            );
        }
        attractors
    }

    fn find_pellet_target(
        pellet: Point,
        attractors: &HashMap<String, HeadAttractor>,
    ) -> Option<(String, HeadAttractor)> {
        let attract_cos = SMALL_PELLET_ATTRACT_RADIUS.cos();
        let lock_cone_cos = SMALL_PELLET_LOCK_CONE_ANGLE.cos();
        let mut best: Option<(String, HeadAttractor, f64)> = None;
        for (id, attractor) in attractors {
            let head_dot = dot(attractor.head, pellet);
            if head_dot < attract_cos {
                continue;
            }
            let toward = Point {
                x: pellet.x - attractor.head.x * head_dot,
                y: pellet.y - attractor.head.y * head_dot,
                z: pellet.z - attractor.head.z * head_dot,
            };
            let toward_len = length(toward);
            if toward_len > 1e-6 {
                let toward_dir = Point {
                    x: toward.x / toward_len,
                    y: toward.y / toward_len,
                    z: toward.z / toward_len,
                };
                if dot(attractor.forward, toward_dir) < lock_cone_cos {
                    continue;
                }
            }
            match best {
                Some((_, _, best_dot)) if head_dot <= best_dot => {}
                _ => best = Some((id.clone(), *attractor, head_dot)),
            }
        }
        best.map(|(id, attractor, _)| (id, attractor))
    }

    fn consume_small_pellets(&mut self, consumed: HashMap<String, (usize, f64)>) {
        for (player_id, (count, growth_fraction_total)) in consumed {
            let Some(player) = self.players.get_mut(&player_id) else {
                continue;
            };
            if !player.alive || count == 0 {
                continue;
            }
            let growth = growth_fraction_total.max(0.0);
            if growth <= 0.0 {
                continue;
            }
            let burst_t = clamp(growth, 0.0, 1.0) as f32;
            let strength = SMALL_PELLET_DIGESTION_STRENGTH
                + (SMALL_PELLET_DIGESTION_STRENGTH_MAX - SMALL_PELLET_DIGESTION_STRENGTH) * burst_t;
            add_digestion_with_strength(player, strength, growth);

            let score_growth = if BIG_PELLET_GROWTH_FRACTION > 0.0 {
                growth / BIG_PELLET_GROWTH_FRACTION
            } else {
                growth
            };
            player.pellet_growth_fraction += score_growth;
            let whole_score = player.pellet_growth_fraction.floor() as i64;
            if whole_score > 0 {
                player.score += whole_score;
                player.pellet_growth_fraction -= whole_score as f64;
            }
        }
    }

    fn update_small_pellets(&mut self, dt_seconds: f64) {
        if self.pellets.is_empty() {
            return;
        }
        let attractors = self.build_head_attractors();
        let consume_cos = SMALL_PELLET_CONSUME_ANGLE.cos();
        // Cap angular travel per tick so attracted pellets visibly move/shrink toward the mouth
        // instead of snapping directly into the consume angle in one update.
        let step = (SMALL_PELLET_ATTRACT_SPEED * dt_seconds)
            .min(SMALL_PELLET_ATTRACT_RADIUS * SMALL_PELLET_ATTRACT_STEP_MAX_RATIO);
        let mut consumed_by: HashMap<String, (usize, f64)> = HashMap::new();
        let mut i = 0usize;
        while i < self.pellets.len() {
            let target = {
                let pellet = &self.pellets[i];
                match &pellet.state {
                    PelletState::Attracting { target_player_id } => attractors
                        .get(target_player_id)
                        .copied()
                        .map(|attractor| (target_player_id.clone(), attractor))
                        .or_else(|| Self::find_pellet_target(pellet.normal, &attractors)),
                    PelletState::Idle => Self::find_pellet_target(pellet.normal, &attractors),
                }
            };

            if let Some((target_id, attractor)) = target {
                let pellet = &mut self.pellets[i];
                pellet.state = PelletState::Attracting {
                    target_player_id: target_id.clone(),
                };

                let to_mouth_dot = clamp(dot(pellet.normal, attractor.mouth), -1.0, 1.0);
                if to_mouth_dot >= consume_cos {
                    let entry = consumed_by.entry(target_id).or_insert((0, 0.0));
                    entry.0 += 1;
                    entry.1 += pellet.growth_fraction;
                    self.pellets.swap_remove(i);
                    continue;
                }

                pellet.normal = rotate_toward(pellet.normal, attractor.mouth, step);
                let after_dot = clamp(dot(pellet.normal, attractor.mouth), -1.0, 1.0);
                if after_dot >= consume_cos {
                    let entry = consumed_by.entry(target_id).or_insert((0, 0.0));
                    entry.0 += 1;
                    entry.1 += pellet.growth_fraction;
                    self.pellets.swap_remove(i);
                    continue;
                }
                let angle = after_dot.acos();
                let ratio = clamp(angle / SMALL_PELLET_ATTRACT_RADIUS, 0.0, 1.0) as f32;
                let shrink =
                    SMALL_PELLET_SHRINK_MIN_RATIO + (1.0 - SMALL_PELLET_SHRINK_MIN_RATIO) * ratio;
                pellet.current_size = pellet.base_size * shrink;
            } else {
                let pellet = &mut self.pellets[i];
                pellet.state = PelletState::Idle;
                pellet.current_size = pellet.base_size;
            }
            i += 1;
        }

        self.consume_small_pellets(consumed_by);
    }

    fn player_girth_scale_from_len(snake_len: usize) -> f64 {
        let step_nodes = SNAKE_GIRTH_NODES_PER_STEP.max(1);
        let added_nodes = snake_len.saturating_sub(STARTING_LENGTH);
        let growth_per_node = SNAKE_GIRTH_STEP_PERCENT / step_nodes as f64;
        let uncapped = 1.0 + (added_nodes as f64) * growth_per_node;
        clamp(uncapped, 1.0, SNAKE_GIRTH_MAX_SCALE.max(1.0))
    }

    fn snake_contact_angular_radius_for_scale(girth_scale: f64) -> f64 {
        (SNAKE_RADIUS / PLANET_RADIUS) * girth_scale.max(0.0)
    }

    fn snake_body_angular_radius_for_scale(girth_scale: f64) -> f64 {
        base_collision_angular_radius() * girth_scale.max(0.0)
    }

    fn snake_contact_angular_radius_for_len(snake_len: usize) -> f64 {
        let scale = Self::player_girth_scale_from_len(snake_len);
        Self::snake_contact_angular_radius_for_scale(scale)
    }

    fn snake_body_angular_radius_for_len(snake_len: usize) -> f64 {
        let scale = Self::player_girth_scale_from_len(snake_len);
        Self::snake_body_angular_radius_for_scale(scale)
    }

    fn project_to_tangent(direction: Point, normal: Point) -> Point {
        Point {
            x: direction.x - normal.x * dot(direction, normal),
            y: direction.y - normal.y * dot(direction, normal),
            z: direction.z - normal.z * dot(direction, normal),
        }
    }

    fn extended_tail_point(player: &Player) -> Option<Point> {
        if player.tail_extension <= 1e-6 || player.snake.len() < 2 {
            return None;
        }
        let tail_node = player.snake.last()?;
        let prev_node = player.snake.get(player.snake.len().saturating_sub(2))?;
        let tail = normalize(Point {
            x: tail_node.x,
            y: tail_node.y,
            z: tail_node.z,
        });
        let prev = normalize(Point {
            x: prev_node.x,
            y: prev_node.y,
            z: prev_node.z,
        });

        let mut base_segment = Point {
            x: tail.x - prev.x,
            y: tail.y - prev.y,
            z: tail.z - prev.z,
        };
        let mut base_length = length(base_segment);
        let mut tail_dir = Self::project_to_tangent(base_segment, tail);

        if length(tail_dir) <= 1e-8 && player.snake.len() >= 3 {
            let prev_prev_node = player.snake.get(player.snake.len().saturating_sub(3))?;
            let prev_prev = normalize(Point {
                x: prev_prev_node.x,
                y: prev_prev_node.y,
                z: prev_prev_node.z,
            });
            base_segment = Point {
                x: prev.x - prev_prev.x,
                y: prev.y - prev_prev.y,
                z: prev.z - prev_prev.z,
            };
            base_length = length(base_segment);
            tail_dir = Self::project_to_tangent(base_segment, tail);
        }
        if base_length <= 1e-8 || !base_length.is_finite() {
            return None;
        }
        let tail_dir_len = length(tail_dir);
        if tail_dir_len <= 1e-8 || !tail_dir_len.is_finite() {
            return None;
        }
        let tail_dir = Point {
            x: tail_dir.x / tail_dir_len,
            y: tail_dir.y / tail_dir_len,
            z: tail_dir.z / tail_dir_len,
        };

        let extension_ratio = clamp(player.tail_extension, 0.0, 0.999_999);
        let extend_distance = base_length * extension_ratio;
        if extend_distance <= 1e-8 || !extend_distance.is_finite() {
            return None;
        }

        let axis = cross(tail, tail_dir);
        let axis_len = length(axis);
        let tail_radius = length(tail).max(1e-6);
        let angle = extend_distance / tail_radius;
        let mut extended = tail;
        if axis_len > 1e-8 && angle.is_finite() {
            let axis_unit = Point {
                x: axis.x / axis_len,
                y: axis.y / axis_len,
                z: axis.z / axis_len,
            };
            rotate_around_axis(&mut extended, axis_unit, angle);
            return Some(normalize(extended));
        }

        let fallback = normalize(Point {
            x: tail.x + tail_dir.x * extend_distance,
            y: tail.y + tail_dir.y * extend_distance,
            z: tail.z + tail_dir.z * extend_distance,
        });
        Some(fallback)
    }

    fn self_collision_start_index(body_angular_radius: f64) -> usize {
        let boost_steps = (BOOST_MULTIPLIER.round() as i32).max(1) as f64;
        let min_step_velocity = (BASE_SPEED * BOOST_MULTIPLIER) / boost_steps;
        let min_node_spacing = (NODE_QUEUE_SIZE as f64) * min_step_velocity;
        if !min_node_spacing.is_finite() || min_node_spacing <= 1e-9 {
            return 2;
        }
        let required = ((2.0 * body_angular_radius.max(0.0)) / min_node_spacing).ceil() as usize;
        required.max(2)
    }

    fn tick(&mut self) {
        let now = Self::now_millis();
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
        self.ensure_pellets();
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
            player.is_boosting = is_boosting;
            if is_boosting {
                player.stamina = (player.stamina - STAMINA_DRAIN_PER_SEC * dt_seconds).max(0.0);
            } else if !wants_boost {
                player.stamina =
                    (player.stamina + STAMINA_RECHARGE_PER_SEC * dt_seconds).min(STAMINA_MAX);
            }
            let speed_factor = if is_boosting { BOOST_MULTIPLIER } else { 1.0 };
            let step_count = (speed_factor.round() as i32).max(1);
            let step_velocity = (BASE_SPEED * speed_factor) / step_count as f64;
            let snake_angular_radius =
                Self::snake_contact_angular_radius_for_len(player.snake.len());
            apply_snake_with_collisions(
                &mut player.snake,
                &mut player.axis,
                snake_angular_radius,
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
                    player.oxygen_damage_accumulator = 0.0;
                    oxygen_dead.insert(player.id.clone());
                    death_reasons.entry(player.id.clone()).or_insert("oxygen");
                }
            } else {
                player.oxygen = OXYGEN_MAX;
                player.oxygen_damage_accumulator = 0.0;
            }
        }

        let player_snapshots: Vec<PlayerCollisionSnapshot> = self
            .players
            .values()
            .map(|player| {
                let girth_scale = Self::player_girth_scale_from_len(player.snake.len());
                let mut snake_points = player
                    .snake
                    .iter()
                    .map(|node| Point {
                        x: node.x,
                        y: node.y,
                        z: node.z,
                    })
                    .collect::<Vec<_>>();
                if let Some(extended_tail) = Self::extended_tail_point(player) {
                    snake_points.push(extended_tail);
                }
                PlayerCollisionSnapshot {
                    id: player.id.clone(),
                    alive: player.alive,
                    snake: snake_points,
                    contact_angular_radius: Self::snake_contact_angular_radius_for_scale(
                        girth_scale,
                    ),
                    body_angular_radius: Self::snake_body_angular_radius_for_scale(girth_scale),
                }
            })
            .collect();

        let mut dead: HashSet<String> = HashSet::new();
        for snapshot in &player_snapshots {
            if !snapshot.alive || snapshot.snake.is_empty() {
                continue;
            }
            let head = snapshot.snake[0];
            for cactus in &self.environment.trees {
                if cactus.width_scale >= 0.0 {
                    continue;
                }
                let cactus_radius = (TREE_TRUNK_RADIUS * cactus.width_scale.abs()) / PLANET_RADIUS;
                let dot_value = clamp(dot(head, cactus.normal), -1.0, 1.0);
                let angle = dot_value.acos();
                if !angle.is_finite() {
                    continue;
                }
                if angle < cactus_radius + snapshot.contact_angular_radius {
                    dead.insert(snapshot.id.clone());
                    death_reasons
                        .entry(snapshot.id.clone())
                        .or_insert("cactus_collision");
                    break;
                }
            }
        }

        for snapshot in &player_snapshots {
            if dead.contains(&snapshot.id) || !snapshot.alive || snapshot.snake.len() < 3 {
                continue;
            }
            let head = snapshot.snake[0];
            let self_collision_start =
                Self::self_collision_start_index(snapshot.body_angular_radius);
            for node in snapshot.snake.iter().skip(self_collision_start) {
                if collision_with_angular_radii(
                    head,
                    *node,
                    snapshot.body_angular_radius,
                    snapshot.body_angular_radius,
                ) {
                    dead.insert(snapshot.id.clone());
                    death_reasons
                        .entry(snapshot.id.clone())
                        .or_insert("self_collision");
                    break;
                }
            }
            if dead.contains(&snapshot.id) {
                continue;
            }
            for other_snapshot in &player_snapshots {
                if !other_snapshot.alive || other_snapshot.id == snapshot.id {
                    continue;
                }
                for node in &other_snapshot.snake {
                    if collision_with_angular_radii(
                        head,
                        *node,
                        snapshot.body_angular_radius,
                        other_snapshot.body_angular_radius,
                    ) {
                        dead.insert(snapshot.id.clone());
                        death_reasons
                            .entry(snapshot.id.clone())
                            .or_insert("snake_collision");
                        break;
                    }
                }
                if dead.contains(&snapshot.id) {
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
            let steps = *move_steps.get(&player.id).unwrap_or(&1);
            advance_digestions(player, steps);
        }

        // Advance existing digestions before applying newly swallowed pellets so new bulges
        // always begin from the same head-relative start regardless of boost step count.
        self.update_small_pellets(dt_seconds);
        self.ensure_pellets();

        self.broadcast_state();
    }

    fn handle_death(&mut self, player_id: &str) {
        let (is_bot, dropped_points) = {
            let Some(player) = self.players.get_mut(player_id) else {
                return;
            };
            if !player.alive {
                return;
            }
            player.alive = false;
            player.respawn_at = Some(Self::now_millis() + RESPAWN_COOLDOWN_MS);
            player.is_boosting = false;
            player.digestions.clear();
            player.next_digestion_id = 0;
            player.pellet_growth_fraction = 0.0;
            player.tail_extension = 0.0;
            player.oxygen_damage_accumulator = 0.0;
            player.score = 0;
            let dropped_points = player
                .snake
                .iter()
                .skip(1)
                .map(|node| Point {
                    x: node.x,
                    y: node.y,
                    z: node.z,
                })
                .collect::<Vec<_>>();
            (player.is_bot, dropped_points)
        };
        tracing::debug!(player_id, is_bot, "player died");

        let mut rng = rand::thread_rng();
        for point in dropped_points {
            let Some(spawn_point) = self.pick_valid_death_pellet_spawn(point, &mut rng) else {
                continue;
            };
            let size = rng.gen_range(DEATH_PELLET_SIZE_MIN..=DEATH_PELLET_SIZE_MAX);
            let color_index = rng.gen_range(0..SMALL_PELLET_COLOR_COUNT);
            let pellet_id = self.next_small_pellet_id();
            self.pellets.push(Pellet {
                id: pellet_id,
                normal: spawn_point,
                color_index,
                base_size: size,
                current_size: size,
                growth_fraction: BIG_PELLET_GROWTH_FRACTION,
                state: PelletState::Idle,
            });
        }

        if self.pellets.len() > MAX_PELLETS {
            let excess = self.pellets.len() - MAX_PELLETS;
            self.pellets.drain(0..excess);
        }
    }

    fn respawn_player(&mut self, player_id: &str) {
        let base_axis = random_axis();
        let spawned = self.spawn_snake(base_axis, Some(player_id));
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
        player.is_boosting = false;
        player.stamina = STAMINA_MAX;
        player.oxygen = OXYGEN_MAX;
        player.oxygen_damage_accumulator = 0.0;
        player.respawn_at = None;
        player.snake = spawned.snake;
        player.pellet_growth_fraction = 0.0;
        player.tail_extension = 0.0;
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
        let visible_pellets = self.visible_pellets_for_session(session_id);
        let total_players = self.players.len().min(u16::MAX as usize);
        let visible_player_count = visible_players.len().min(u16::MAX as usize);
        let pellet_count = visible_pellets.len().min(u16::MAX as usize);
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
            capacity += 16 + 1 + 4 + 4 + 4 + 1 + 4 + 4 + 1 + 2;
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
                capacity += player.digestions.len() * 12;
            }
        }
        capacity += self.environment.encoded_len();

        let mut encoder = protocol::Encoder::with_capacity(capacity);
        encoder.write_header(protocol::TYPE_INIT, 0);
        encoder.write_uuid(&player_bytes);
        encoder.write_i64(now);
        encoder.write_u16(pellet_count as u16);
        for pellet in visible_pellets.into_iter().take(pellet_count) {
            self.write_pellet(&mut encoder, pellet);
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
        let visible_players = self.visible_players_for_session(session_id);
        let visible_pellets = self.visible_pellets_for_session(session_id);
        let total_players = self.players.len().min(u16::MAX as usize);
        let visible_player_count = visible_players.len().min(u16::MAX as usize);
        let visible_pellet_count = visible_pellets.len().min(u16::MAX as usize);

        let mut capacity = 4 + 8 + 2 + visible_pellet_count * 12 + 2 + 2;
        for visible in visible_players.iter().take(visible_player_count) {
            let player = visible.player;
            let window = visible.window;
            capacity += 16 + 1 + 4 + 4 + 4 + 1 + 4 + 4 + 1 + 2;
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
                capacity += player.digestions.len() * 12;
            }
        }

        let mut encoder = protocol::Encoder::with_capacity(capacity);
        encoder.write_header(protocol::TYPE_STATE, 0);
        encoder.write_i64(now);
        encoder.write_u16(visible_pellet_count as u16);
        for pellet in visible_pellets.into_iter().take(visible_pellet_count) {
            self.write_pellet(&mut encoder, pellet);
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

    fn quantize_pellet_normal(value: f64) -> i16 {
        let clamped = clamp(value, -1.0, 1.0);
        (clamped * i16::MAX as f64).round() as i16
    }

    fn quantize_pellet_size(size: f32) -> u8 {
        let range = (PELLET_SIZE_ENCODE_MAX - PELLET_SIZE_ENCODE_MIN).max(1e-4);
        let t = ((size - PELLET_SIZE_ENCODE_MIN) / range).clamp(0.0, 1.0);
        (t * u8::MAX as f32).round() as u8
    }

    fn write_pellet(&self, encoder: &mut protocol::Encoder, pellet: &Pellet) {
        encoder.write_u32(pellet.id);
        encoder.write_i16(Self::quantize_pellet_normal(pellet.normal.x));
        encoder.write_i16(Self::quantize_pellet_normal(pellet.normal.y));
        encoder.write_i16(Self::quantize_pellet_normal(pellet.normal.z));
        encoder.write_u8(
            pellet
                .color_index
                .min(SMALL_PELLET_COLOR_COUNT.saturating_sub(1)),
        );
        encoder.write_u8(Self::quantize_pellet_size(pellet.current_size));
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
        encoder.write_u8(if player.is_boosting { 1 } else { 0 });
        let girth_scale = Self::player_girth_scale_from_len(player.snake.len());
        encoder.write_f32(girth_scale as f32);
        encoder.write_f32(clamp(player.tail_extension, 0.0, 1.0) as f32);
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

        let digestion_total = if window.include_digestions() {
            player.digestions.len()
        } else {
            0
        };
        let digestion_len = digestion_total.min(u8::MAX as usize) as u8;
        let digestion_start = digestion_total.saturating_sub(digestion_len as usize);
        encoder.write_u8(digestion_len);
        for digestion in player
            .digestions
            .iter()
            .skip(digestion_start)
            .take(digestion_len as usize)
        {
            encoder.write_u32(digestion.id);
            encoder.write_f32(get_digestion_progress(digestion) as f32);
            encoder.write_f32(digestion.strength);
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
            is_boosting: false,
            stamina: STAMINA_MAX,
            oxygen: OXYGEN_MAX,
            oxygen_damage_accumulator: 0.0,
            score: 0,
            alive: true,
            connected: true,
            last_seen: 0,
            respawn_at: None,
            snake,
            pellet_growth_fraction: 0.0,
            tail_extension: 0.0,
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
            next_pellet_id: 0,
            environment: Environment::generate(),
        }
    }

    fn make_pellet(id: u32, normal: Point) -> Pellet {
        Pellet {
            id,
            normal,
            color_index: 0,
            base_size: 1.0,
            current_size: 1.0,
            growth_fraction: SMALL_PELLET_GROWTH_FRACTION,
            state: PelletState::Idle,
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
        *offset += 1; // is_boosting
        *offset += 4; // girth scale
        *offset += 4; // tail extension
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
        *offset += digestion_len as usize * 12;
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

    #[test]
    fn girth_scale_grows_per_node_and_caps() {
        assert!((RoomState::player_girth_scale_from_len(STARTING_LENGTH) - 1.0).abs() < 1e-9);
        assert!((RoomState::player_girth_scale_from_len(STARTING_LENGTH + 1) - 1.01).abs() < 1e-9);
        assert!((RoomState::player_girth_scale_from_len(STARTING_LENGTH + 9) - 1.09).abs() < 1e-9);
        assert!((RoomState::player_girth_scale_from_len(STARTING_LENGTH + 10) - 1.1).abs() < 1e-9);
        assert!((RoomState::player_girth_scale_from_len(STARTING_LENGTH + 15) - 1.15).abs() < 1e-9);
        assert!((RoomState::player_girth_scale_from_len(STARTING_LENGTH + 20) - 1.2).abs() < 1e-9);
        assert!((RoomState::player_girth_scale_from_len(STARTING_LENGTH + 500) - 2.0).abs() < 1e-9);
    }

    #[test]
    fn self_collision_skip_count_increases_with_girth() {
        let base_radius = RoomState::snake_body_angular_radius_for_scale(1.0);
        let capped_radius = RoomState::snake_body_angular_radius_for_scale(SNAKE_GIRTH_MAX_SCALE);
        assert_eq!(RoomState::self_collision_start_index(base_radius), 2);
        assert!(RoomState::self_collision_start_index(capped_radius) >= 3);
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
    fn spawn_rejects_heads_within_min_distance() {
        let mut state = make_state();
        state.players.insert(
            "other".to_string(),
            make_player("other", snake_from_xs(&[0.0, 0.4, 0.8])),
        );

        let candidate = snake_from_xs(&[SPAWN_PLAYER_MIN_DISTANCE * 0.75]);
        assert!(state.is_snake_too_close(&candidate, None));
    }

    #[test]
    fn spawn_allows_heads_outside_min_distance() {
        let mut state = make_state();
        state.players.insert(
            "other".to_string(),
            make_player("other", snake_from_xs(&[0.0, 0.4, 0.8])),
        );

        let candidate = snake_from_xs(&[SPAWN_PLAYER_MIN_DISTANCE + 0.05]);
        assert!(!state.is_snake_too_close(&candidate, None));
    }

    #[test]
    fn spawn_check_ignores_excluded_player_id() {
        let mut state = make_state();
        let player_id = "respawn-player".to_string();
        state.players.insert(
            player_id.clone(),
            make_player(&player_id, snake_from_xs(&[0.0, 0.4, 0.8])),
        );

        let candidate = snake_from_xs(&[SPAWN_PLAYER_MIN_DISTANCE * 0.75]);
        assert!(state.is_snake_too_close(&candidate, None));
        assert!(!state.is_snake_too_close(&candidate, Some(&player_id)));
    }

    #[test]
    fn death_drops_pellets_for_each_body_node() {
        let mut state = make_state();
        state.environment.lakes.clear();
        state.environment.trees.clear();
        state.environment.mountains.clear();
        let snake = make_snake(6, 0.0);
        let player_id = "player-1".to_string();
        let player = make_player(&player_id, snake.clone());
        state.players.insert(player_id.clone(), player);

        state.handle_death(&player_id);

        assert_eq!(state.pellets.len(), snake.len() - 1);
        for (pellet, node) in state.pellets.iter().zip(snake.iter().skip(1)) {
            assert_eq!(pellet.normal.x, node.x);
            assert_eq!(pellet.normal.y, node.y);
            assert_eq!(pellet.normal.z, node.z);
            assert!(pellet.base_size >= DEATH_PELLET_SIZE_MIN);
            assert!(pellet.base_size <= DEATH_PELLET_SIZE_MAX);
        }
    }

    #[test]
    fn death_pellets_clamp_to_u16_max() {
        let mut state = make_state();
        state.environment.lakes.clear();
        state.environment.trees.clear();
        state.environment.mountains.clear();
        let base_len = u16::MAX as usize - 2;
        state.pellets = (0..base_len)
            .map(|index| Pellet {
                id: index as u32,
                normal: Point {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
                color_index: 0,
                base_size: SMALL_PELLET_SIZE_MIN,
                current_size: SMALL_PELLET_SIZE_MIN,
                growth_fraction: SMALL_PELLET_GROWTH_FRACTION,
                state: PelletState::Idle,
            })
            .collect();

        let snake = make_snake(5, 100.0);
        let player_id = "player-2".to_string();
        let player = make_player(&player_id, snake.clone());
        state.players.insert(player_id.clone(), player);

        state.handle_death(&player_id);

        assert_eq!(state.pellets.len(), u16::MAX as usize);
        let tail = &state.pellets[state.pellets.len() - 4..];
        for (pellet, node) in tail.iter().zip(snake.iter().skip(1)) {
            assert_eq!(pellet.normal.x, node.x);
            assert_eq!(pellet.normal.y, node.y);
            assert_eq!(pellet.normal.z, node.z);
            assert!(pellet.base_size > SMALL_PELLET_SIZE_MAX);
        }
    }

    #[test]
    fn spawn_small_pellet_rejects_lake_zone() {
        let mut state = make_full_lake_state();
        let mut rng = rand::thread_rng();
        assert!(state.spawn_small_pellet_with_rng(&mut rng).is_none());
    }

    #[test]
    fn pellet_spawn_invalid_inside_tree_or_cactus_collider() {
        use crate::game::environment::TreeInstance;
        let mut state = make_state();
        state.environment.lakes.clear();
        state.environment.mountains.clear();
        state.environment.trees = vec![
            TreeInstance {
                normal: Point {
                    x: 1.0,
                    y: 0.0,
                    z: 0.0,
                },
                width_scale: 1.0,
                height_scale: 1.0,
                twist: 0.0,
            },
            TreeInstance {
                normal: Point {
                    x: -1.0,
                    y: 0.0,
                    z: 0.0,
                },
                width_scale: -1.0,
                height_scale: 1.0,
                twist: 0.0,
            },
        ];

        assert!(state.is_invalid_pellet_spawn(Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        }));
        assert!(state.is_invalid_pellet_spawn(Point {
            x: -1.0,
            y: 0.0,
            z: 0.0,
        }));
        assert!(!state.is_invalid_pellet_spawn(Point {
            x: 0.0,
            y: 1.0,
            z: 0.0,
        }));
    }

    #[test]
    fn pellet_spawn_invalid_inside_mountain_collider() {
        use crate::game::environment::MountainInstance;
        let mut state = make_state();
        state.environment.lakes.clear();
        state.environment.trees.clear();
        state.environment.mountains = vec![MountainInstance {
            normal: Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            },
            radius: 0.5,
            height: 0.2,
            variant: 0,
            twist: 0.0,
            outline: vec![0.28; 64],
        }];

        assert!(state.is_invalid_pellet_spawn(Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        }));
        assert!(!state.is_invalid_pellet_spawn(Point {
            x: 0.0,
            y: 1.0,
            z: 0.0,
        }));
    }

    #[test]
    fn death_drop_repositions_invalid_points_to_valid_spawn() {
        use crate::game::environment::TreeInstance;
        let mut state = make_state();
        state.environment.lakes.clear();
        state.environment.mountains.clear();
        state.environment.trees = vec![TreeInstance {
            normal: Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            },
            width_scale: 1.0,
            height_scale: 1.0,
            twist: 0.0,
        }];
        let player_id = "death-spawn-adjust".to_string();
        let snake = vec![
            SnakeNode {
                x: 0.0,
                y: 1.0,
                z: 0.0,
                pos_queue: VecDeque::new(),
            },
            SnakeNode {
                x: 1.0,
                y: 0.0,
                z: 0.0,
                pos_queue: VecDeque::new(),
            },
            SnakeNode {
                x: 0.0,
                y: 0.0,
                z: 1.0,
                pos_queue: VecDeque::new(),
            },
        ];
        state
            .players
            .insert(player_id.clone(), make_player(&player_id, snake));

        state.handle_death(&player_id);

        assert_eq!(state.pellets.len(), 2);
        assert!(!state
            .pellets
            .iter()
            .any(|pellet| (pellet.normal.x - 1.0).abs() < 1e-6
                && pellet.normal.y.abs() < 1e-6
                && pellet.normal.z.abs() < 1e-6));
        for pellet in &state.pellets {
            assert!(!state.is_invalid_pellet_spawn(pellet.normal));
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
            settle_steps: 1,
            growth_amount: 0.75,
            applied: true,
            strength: 0.35,
        });

        let mut encoder = protocol::Encoder::with_capacity(256);
        state.write_player_state(&mut encoder, &player);
        let payload = encoder.into_vec();

        let mut offset = 16 + 1 + 4 + 4 + 4;
        let encoded_is_boosting = payload[offset];
        assert_eq!(encoded_is_boosting, 0);
        offset += 1;
        let encoded_girth_scale =
            f32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap());
        assert!((encoded_girth_scale - 1.0).abs() < 1e-6);
        offset += 4;
        let encoded_tail_extension =
            f32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap());
        assert!((encoded_tail_extension - 0.0).abs() < 1e-6);
        offset += 4;
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
        offset += 4;

        let encoded_strength = f32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap());
        assert!((encoded_strength - player.digestions[0].strength).abs() < 1e-6);
    }

    #[test]
    fn write_player_state_encodes_authoritative_is_boosting_flag() {
        let state = make_state();
        let mut player = make_player("player-boosting", make_snake(3, 0.0));
        player.boost = true;
        player.is_boosting = true;

        let mut encoder = protocol::Encoder::with_capacity(256);
        state.write_player_state(&mut encoder, &player);
        let payload = encoder.into_vec();

        let mut offset = 16 + 1 + 4 + 4 + 4; // id, alive, score, stamina, oxygen
        let encoded_is_boosting = payload[offset];
        assert_eq!(encoded_is_boosting, 1);
        offset += 1;
        let encoded_girth_scale =
            f32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap());
        assert!((encoded_girth_scale - 1.0).abs() < 1e-6);
    }

    #[test]
    fn write_player_state_encodes_most_recent_digestions_when_capped() {
        let state = make_state();
        let mut player = make_player("player-recent-digest", make_snake(2, 0.0));
        for id in 0..300u32 {
            player.digestions.push(Digestion {
                id,
                remaining: 2,
                total: 4,
                settle_steps: 1,
                growth_amount: 0.4,
                applied: true,
                strength: 0.4,
            });
        }

        let mut encoder = protocol::Encoder::with_capacity(8192);
        state.write_player_state(&mut encoder, &player);
        let payload = encoder.into_vec();

        let mut offset = 16 + 1 + 4 + 4 + 4 + 1 + 4 + 4; // id, alive, score, stamina, oxygen, is_boosting, girth, tail_extension
        let detail = payload[offset];
        assert_eq!(detail, protocol::SNAKE_DETAIL_FULL);
        offset += 1;

        let _encoded_total_len =
            u16::from_le_bytes(payload[offset..offset + 2].try_into().unwrap());
        offset += 2;
        let encoded_window_len =
            u16::from_le_bytes(payload[offset..offset + 2].try_into().unwrap());
        offset += 2;
        offset += encoded_window_len as usize * 12;

        let digestion_len = payload[offset] as usize;
        assert_eq!(digestion_len, u8::MAX as usize);
        offset += 1;

        let first_id = u32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap());
        let last_offset = offset + (digestion_len - 1) * 12;
        let last_id = u32::from_le_bytes(payload[last_offset..last_offset + 4].try_into().unwrap());
        assert_eq!(first_id, 45);
        assert_eq!(last_id, 299);
    }

    #[test]
    fn small_pellet_locks_and_shrinks_toward_target_head() {
        let mut state = make_state();
        let player_id = "pellet-lock-player".to_string();
        let snake = vec![
            SnakeNode {
                x: 1.0,
                y: 0.0,
                z: 0.0,
                pos_queue: VecDeque::new(),
            },
            SnakeNode {
                x: 0.9805806756909201,
                y: -0.19611613513818402,
                z: 0.0,
                pos_queue: VecDeque::new(),
            },
        ];
        state
            .players
            .insert(player_id.clone(), make_player(&player_id, snake));
        state.pellets.push(make_pellet(
            7,
            normalize(Point {
                x: 1.0,
                y: 0.03,
                z: 0.0,
            }),
        ));

        state.update_small_pellets(0.005);

        assert_eq!(state.pellets.len(), 1);
        let pellet = &state.pellets[0];
        match &pellet.state {
            PelletState::Attracting { target_player_id } => {
                assert_eq!(target_player_id, &player_id);
            }
            PelletState::Idle => panic!("pellet should lock to a nearby head"),
        }
        assert!(pellet.current_size < pellet.base_size);
    }

    #[test]
    fn small_pellet_near_attract_edge_moves_and_shrinks_before_consume() {
        let mut state = make_state();
        let player_id = "pellet-edge-player".to_string();
        let snake = vec![
            SnakeNode {
                x: 1.0,
                y: 0.0,
                z: 0.0,
                pos_queue: VecDeque::new(),
            },
            SnakeNode {
                x: 0.9805806756909201,
                y: -0.19611613513818402,
                z: 0.0,
                pos_queue: VecDeque::new(),
            },
        ];
        state
            .players
            .insert(player_id.clone(), make_player(&player_id, snake));

        let pellet_start = normalize(Point {
            x: 1.0,
            y: SMALL_PELLET_ATTRACT_RADIUS * 0.95,
            z: 0.0,
        });
        let mouth = normalize(Point {
            x: 1.0,
            y: SMALL_PELLET_MOUTH_FORWARD,
            z: 0.0,
        });
        let before_dot = dot(pellet_start, mouth);
        state.pellets.push(make_pellet(17, pellet_start));

        state.update_small_pellets(TICK_MS as f64 / 1000.0);

        assert_eq!(state.pellets.len(), 1);
        let pellet = &state.pellets[0];
        let after_dot = dot(pellet.normal, mouth);
        assert!(after_dot > before_dot);
        match &pellet.state {
            PelletState::Attracting { target_player_id } => {
                assert_eq!(target_player_id, &player_id);
            }
            PelletState::Idle => panic!("pellet should remain locked while approaching"),
        }
        assert!(pellet.current_size < pellet.base_size);
    }

    #[test]
    fn small_pellet_growth_is_fractional_before_full_score_tick() {
        let mut state = make_state();
        let player_id = "pellet-growth-player".to_string();
        let snake = vec![
            SnakeNode {
                x: 1.0,
                y: 0.0,
                z: 0.0,
                pos_queue: VecDeque::new(),
            },
            SnakeNode {
                x: 0.9805806756909201,
                y: -0.19611613513818402,
                z: 0.0,
                pos_queue: VecDeque::new(),
            },
        ];
        state
            .players
            .insert(player_id.clone(), make_player(&player_id, snake));
        let mouth = normalize(Point {
            x: 1.0,
            y: SMALL_PELLET_MOUTH_FORWARD,
            z: 0.0,
        });
        for i in 0..7u32 {
            state.pellets.push(make_pellet(i, mouth));
        }

        state.update_small_pellets(TICK_MS as f64 / 1000.0);
        let player_after_partial = state.players.get(&player_id).expect("player");
        assert_eq!(player_after_partial.score, 0);
        assert_eq!(player_after_partial.digestions.len(), 1);
        assert!(player_after_partial.digestions[0].growth_amount > 0.034);
        assert!(player_after_partial.digestions[0].growth_amount < 0.036);
        assert!(player_after_partial.pellet_growth_fraction > 0.34);
        assert!(player_after_partial.pellet_growth_fraction < 0.36);

        for i in 0..193u32 {
            state.pellets.push(make_pellet(100 + i, mouth));
        }
        state.update_small_pellets(TICK_MS as f64 / 1000.0);
        let player_after_full = state.players.get(&player_id).expect("player");
        assert!(player_after_full.score >= 1);
        assert_eq!(player_after_full.digestions.len(), 2);
        assert!(player_after_full.pellet_growth_fraction < 1.0);
        assert!(player_after_full
            .digestions
            .iter()
            .all(|digestion| digestion.growth_amount > 0.0));
        assert!(player_after_full
            .digestions
            .iter()
            .all(|digestion| digestion.strength <= 1.0));
    }

    #[test]
    fn death_pellet_grants_big_pellet_growth_fraction() {
        let mut state = make_state();
        let player_id = "death-pellet-growth-player".to_string();
        let snake = vec![
            SnakeNode {
                x: 1.0,
                y: 0.0,
                z: 0.0,
                pos_queue: VecDeque::new(),
            },
            SnakeNode {
                x: 0.9805806756909201,
                y: -0.19611613513818402,
                z: 0.0,
                pos_queue: VecDeque::new(),
            },
        ];
        state
            .players
            .insert(player_id.clone(), make_player(&player_id, snake));
        let mouth = normalize(Point {
            x: 1.0,
            y: SMALL_PELLET_MOUTH_FORWARD,
            z: 0.0,
        });
        state.pellets.push(Pellet {
            id: 700,
            normal: mouth,
            color_index: 0,
            base_size: DEATH_PELLET_SIZE_MIN,
            current_size: DEATH_PELLET_SIZE_MIN,
            growth_fraction: BIG_PELLET_GROWTH_FRACTION,
            state: PelletState::Idle,
        });

        state.update_small_pellets(TICK_MS as f64 / 1000.0);

        let player_after = state.players.get(&player_id).expect("player");
        assert_eq!(player_after.score, 1);
        assert!(player_after.pellet_growth_fraction.abs() < 0.01);
        assert!(player_after
            .digestions
            .iter()
            .any(|digestion| {
                digestion.growth_amount >= BIG_PELLET_GROWTH_FRACTION - 1e-6
                    && digestion.growth_amount <= BIG_PELLET_GROWTH_FRACTION + 1e-6
            }));
    }

    #[test]
    fn small_pellet_consumes_when_head_moves_more_than_consume_angle_between_ticks() {
        let mut state = make_state();
        let player_id = "pellet-moving-mouth-player".to_string();
        let head = Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        };
        let trailing = normalize(Point {
            x: 1.0,
            y: -0.05,
            z: 0.0,
        });
        state.players.insert(
            player_id.clone(),
            make_player(
                &player_id,
                vec![
                    SnakeNode {
                        x: head.x,
                        y: head.y,
                        z: head.z,
                        pos_queue: VecDeque::new(),
                    },
                    SnakeNode {
                        x: trailing.x,
                        y: trailing.y,
                        z: trailing.z,
                        pos_queue: VecDeque::new(),
                    },
                ],
            ),
        );
        let travel_target = Point {
            x: 0.0,
            y: 1.0,
            z: 0.0,
        };
        let pellet_start = rotate_toward(head, travel_target, SMALL_PELLET_CONSUME_ANGLE * 8.0);
        state.pellets.push(make_pellet(701, pellet_start));

        let dt_seconds = TICK_MS as f64 / 1000.0;
        let head_step = SMALL_PELLET_CONSUME_ANGLE * 1.25;
        for _ in 0..12 {
            state.update_small_pellets(dt_seconds);
            if state.pellets.is_empty() {
                break;
            }
            let player = state.players.get_mut(&player_id).expect("player");
            let old_head = Point {
                x: player.snake[0].x,
                y: player.snake[0].y,
                z: player.snake[0].z,
            };
            let next_head = rotate_toward(old_head, travel_target, head_step);
            player.snake[1] = SnakeNode {
                x: old_head.x,
                y: old_head.y,
                z: old_head.z,
                pos_queue: VecDeque::new(),
            };
            player.snake[0] = SnakeNode {
                x: next_head.x,
                y: next_head.y,
                z: next_head.z,
                pos_queue: VecDeque::new(),
            };
        }

        assert!(state.pellets.is_empty());
        let player_after = state.players.get(&player_id).expect("player");
        assert_eq!(player_after.digestions.len(), 1);
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
        state.environment.trees.clear();
        state.environment.mountains.clear();
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

    fn make_cactus_collision_state(cactus_normal: Point, cactus_width_scale: f64) -> RoomState {
        use crate::game::environment::TreeInstance;
        let mut state = make_state();
        state.environment.lakes.clear();
        state.environment.mountains.clear();
        state.environment.trees = vec![TreeInstance {
            normal: cactus_normal,
            width_scale: -cactus_width_scale.abs(),
            height_scale: 1.0,
            twist: 0.0,
        }];
        state
    }

    #[test]
    fn cactus_collision_kills_on_head_contact() {
        let mut state = make_cactus_collision_state(
            Point {
                x: 0.0,
                y: 0.0,
                z: -1.0,
            },
            1.0,
        );
        let player_id = "player-cactus-hit".to_string();
        let mut snake = create_snake(Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        });
        snake.truncate(2);
        let mut player = make_player(&player_id, snake);
        player.axis = Point {
            x: 0.0,
            y: 0.0,
            z: -1.0,
        };
        player.target_axis = player.axis;
        state.players.insert(player_id.clone(), player);

        state.tick();

        let player = state.players.get(&player_id).expect("player");
        assert!(!player.alive);
    }

    #[test]
    fn cactus_collision_does_not_kill_without_contact() {
        let mut state = make_cactus_collision_state(
            Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            },
            1.0,
        );
        let player_id = "player-cactus-safe".to_string();
        let mut snake = create_snake(Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        });
        snake.truncate(2);
        let mut player = make_player(&player_id, snake);
        player.axis = Point {
            x: 0.0,
            y: 0.0,
            z: -1.0,
        };
        player.target_axis = player.axis;
        state.players.insert(player_id.clone(), player);

        state.tick();

        let player = state.players.get(&player_id).expect("player");
        assert!(player.alive);
    }

    #[test]
    fn forest_tree_collision_is_not_instant_death() {
        use crate::game::environment::TreeInstance;
        let mut state = make_state();
        state.environment.lakes.clear();
        state.environment.mountains.clear();
        state.environment.trees = vec![TreeInstance {
            normal: Point {
                x: 0.0,
                y: 0.0,
                z: -1.0,
            },
            width_scale: 1.0,
            height_scale: 1.0,
            twist: 0.0,
        }];
        let player_id = "player-forest-tree".to_string();
        let mut snake = create_snake(Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        });
        snake.truncate(2);
        let mut player = make_player(&player_id, snake);
        player.axis = Point {
            x: 0.0,
            y: 0.0,
            z: -1.0,
        };
        player.target_axis = player.axis;
        state.players.insert(player_id.clone(), player);

        state.tick();

        let player = state.players.get(&player_id).expect("player");
        assert!(player.alive);
    }

    #[test]
    fn oxygen_depletion_kills_immediately_when_empty() {
        let mut state = make_full_lake_state();
        let player_id = "player-oxygen-immediate".to_string();
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

        state.tick();

        let player = state.players.get(&player_id).expect("player");
        assert!(!player.alive);
        assert_eq!(player.score, 0);
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

        state.tick();

        let player = state.players.get(&player_id).expect("player");
        assert!(!player.alive);
        assert_eq!(player.score, 0);
    }

    #[test]
    fn oxygen_replenishes_when_not_underwater() {
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
        player.oxygen = 0.5;
        state.players.insert(player_id.clone(), player);

        state.tick();
        let oxygen_underwater = state.players.get(&player_id).expect("player").oxygen;
        assert!(oxygen_underwater < 0.5);
        assert!(oxygen_underwater > 0.0);

        state.environment.lakes.clear();
        state.tick();

        let player = state.players.get(&player_id).expect("player");
        assert!(player.alive);
        assert_eq!(player.oxygen, OXYGEN_MAX);
        assert_eq!(player.oxygen_damage_accumulator, 0.0);
        assert_eq!(player.snake.len(), 8);
    }
}
