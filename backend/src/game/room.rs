use super::constants::{
    BASE_PELLET_COUNT, BASE_SPEED, BIG_PELLET_GROWTH_FRACTION, BOOST_MULTIPLIER,
    BOOST_NODE_DRAIN_PER_SEC, BOOST_SCORE_DRAIN_PER_SEC, BOOST_TRAIL_PELLET_GROWTH_FRACTION,
    BOOST_TRAIL_PELLET_INTERVAL_MS, BOOST_TRAIL_PELLET_SIZE_MAX, BOOST_TRAIL_PELLET_SIZE_MIN,
    BOOST_TRAIL_PELLET_TTL_MS, BOT_BOOST_DISTANCE, BOT_COUNT, COLOR_POOL, DEATH_PELLET_SIZE_MAX,
    DEATH_PELLET_SIZE_MIN, EVASIVE_PELLET_CHASE_CONE_ANGLE,
    EVASIVE_PELLET_CHASE_MAX_ANGLE_RATIO, EVASIVE_PELLET_COOLDOWN_JITTER_MS,
    EVASIVE_PELLET_COOLDOWN_MS, EVASIVE_PELLET_EVADE_FADE_RADIUS_RATIO,
    EVASIVE_PELLET_EVADE_FULL_RADIUS_RATIO, EVASIVE_PELLET_EVADE_MIN_FACTOR,
    EVASIVE_PELLET_EVADE_RADIUS, EVASIVE_PELLET_EVADE_SPEED, EVASIVE_PELLET_EVADE_STEP_MAX,
    EVASIVE_PELLET_LIFETIME_MS, EVASIVE_PELLET_MAX_LEN, EVASIVE_PELLET_MAX_PER_PLAYER,
    EVASIVE_PELLET_MAX_STEP_PER_TICK, EVASIVE_PELLET_MIN_LEN,
    EVASIVE_PELLET_OTHER_HEAD_EXCLUSION_ANGLE, EVASIVE_PELLET_OWNER_NEAR_ANGLE_MAX,
    EVASIVE_PELLET_OWNER_NEAR_ANGLE_MIN, EVASIVE_PELLET_RETRY_DELAY_MS, EVASIVE_PELLET_SIZE_MAX,
    EVASIVE_PELLET_SIZE_MIN, EVASIVE_PELLET_SPAWN_ATTEMPTS, EVASIVE_PELLET_SUCTION_RADIUS,
    EVASIVE_PELLET_SUCTION_SPEED, EVASIVE_PELLET_SUCTION_STEP_MAX, EVASIVE_PELLET_ZIGZAG_HZ,
    EVASIVE_PELLET_ZIGZAG_STRENGTH, MAX_PELLETS, MAX_SPAWN_ATTEMPTS, MIN_SURVIVAL_LENGTH,
    OXYGEN_DRAIN_PER_SEC, OXYGEN_MAX, PELLET_SIZE_ENCODE_MAX, PELLET_SIZE_ENCODE_MIN,
    PLAYER_TIMEOUT_MS, RESPAWN_COOLDOWN_MS, RESPAWN_RETRY_MS, SMALL_PELLET_ATTRACT_RADIUS,
    SMALL_PELLET_ATTRACT_SPEED, SMALL_PELLET_ATTRACT_STEP_MAX_RATIO, SMALL_PELLET_CONSUME_ANGLE,
    SMALL_PELLET_DIGESTION_STRENGTH, SMALL_PELLET_DIGESTION_STRENGTH_MAX,
    SMALL_PELLET_COLOR_PALETTE, SMALL_PELLET_GROWTH_FRACTION, SMALL_PELLET_LOCK_CONE_ANGLE,
    SMALL_PELLET_MOUTH_FORWARD, SMALL_PELLET_SHRINK_MIN_RATIO, SMALL_PELLET_SIZE_MAX,
    SMALL_PELLET_SIZE_MIN,
    SMALL_PELLET_SPAWN_HEAD_EXCLUSION_ANGLE, SMALL_PELLET_VIEW_MARGIN_MAX,
    SMALL_PELLET_VIEW_MARGIN_MIN, SMALL_PELLET_VISIBLE_MAX, SMALL_PELLET_VISIBLE_MIN,
    SMALL_PELLET_ZOOM_MAX_CAMERA_DISTANCE, SMALL_PELLET_ZOOM_MIN_CAMERA_DISTANCE,
    SNAKE_GIRTH_MAX_SCALE, SNAKE_GIRTH_NODES_PER_STEP, SNAKE_GIRTH_STEP_PERCENT, SPAWN_CONE_ANGLE,
    SPAWN_PLAYER_MIN_DISTANCE, STARTING_LENGTH, TICK_MS, TURN_BOOST_TURN_RATE_MULTIPLIER,
    TURN_RATE, TURN_RATE_MAX_MULTIPLIER, TURN_RATE_MIN_MULTIPLIER,
    TURN_RESPONSE_GAIN_BOOST_PER_SEC, TURN_RESPONSE_GAIN_NORMAL_PER_SEC, TURN_SCANG_BASE,
    TURN_SCANG_RANGE, TURN_SC_LENGTH_DIVISOR, TURN_SC_MAX, TURN_SPEED_BOOST_TURN_PENALTY,
    TURN_SPEED_MIN_MULTIPLIER, TURN_SUBSTEPS_BOOST, TURN_SUBSTEPS_NORMAL,
};
use super::digestion::{
    add_digestion_with_strength, advance_digestions_with_boost, get_digestion_progress,
    get_digestion_visual_strength, BoostDrainConfig,
};
use super::environment::{
    sample_lakes, Environment, LAKE_EXCLUSION_THRESHOLD, LAKE_WATER_MASK_THRESHOLD, PLANET_RADIUS,
    SNAKE_RADIUS, TREE_TRUNK_RADIUS,
};
use super::geometry::{sample_outline_radius, tangent_basis};
use super::input::parse_axis;
use super::math::{
    base_collision_angular_radius, clamp, collision_distance_for_angular_radii,
    collision_with_angular_radii, cross, dot, length, normalize, point_from_spherical, random_axis,
    rotate_toward, rotate_y, rotate_z,
};
use super::physics::apply_snake_with_collisions;
use super::snake::{compute_extended_tail_point, compute_tail_tip_point, create_snake, rotate_snake};
use super::types::{Pellet, PelletState, Player, Point, SnakeNode};
use crate::protocol;
use crate::shared::names::sanitize_player_name;
use rand::Rng;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

mod session;
#[cfg(test)]
mod tests;
mod visibility;

pub use session::{LatestFrame, SessionInbound, SessionIo};

const VIEW_RADIUS_MIN: f64 = 0.2;
const VIEW_RADIUS_MAX: f64 = 1.4;
const VIEW_RADIUS_MARGIN: f64 = 0.14;
const VIEW_NODE_PADDING: usize = 3;
const VIEW_MIN_WINDOW_POINTS: usize = 2;
const VIEW_CAMERA_DISTANCE_MIN: f64 = 4.0;
const VIEW_CAMERA_DISTANCE_MAX: f64 = 10.0;

const OUTBOUND_HI_CAPACITY: usize = 16;
const OUTBOUND_LO_CAPACITY: usize = 16;
const PELLET_RESET_RETRY_MS: i64 = 250;
const STATE_DELTA_KEYFRAME_INTERVAL: u32 = 4;
const BOT_COUNT_ENV_KEY: &str = "SNAKE_BOT_COUNT";
const BOT_SUPPRESS_ROOM_PREFIX_ENV_KEY: &str = "SNAKE_NO_BOTS_ROOM_PREFIX";
const OXYGEN_DISABLED_ENV_KEY: &str = "SNAKE_DISABLE_OXYGEN";
const ROCK_PELLET_FREQ_MULT_ENV_KEY: &str = "SNAKE_DEBUG_ROCK_PELLET_FREQ_MULT";

const DELTA_FRAME_KEYFRAME: u8 = 1 << 0;

const DELTA_FIELD_FLAGS: u16 = 1 << 0;
const DELTA_FIELD_SCORE: u16 = 1 << 1;
const DELTA_FIELD_SCORE_FRACTION: u16 = 1 << 2;
const DELTA_FIELD_OXYGEN: u16 = 1 << 3;
const DELTA_FIELD_GIRTH: u16 = 1 << 4;
const DELTA_FIELD_TAIL_EXT: u16 = 1 << 5;
const DELTA_FIELD_SNAKE: u16 = 1 << 6;
const DELTA_FIELD_DIGESTIONS: u16 = 1 << 7;
const DELTA_FIELD_TAIL_TIP: u16 = 1 << 8;

const DELTA_SNAKE_REBASE: u8 = 0;
const DELTA_SNAKE_SHIFT_HEAD: u8 = 1;

#[derive(Debug)]
pub struct Room {
    state: Mutex<RoomState>,
    running: AtomicBool,
    max_human_players: Option<usize>,
}

#[derive(Debug, Clone, Copy)]
pub struct RoomStats {
    pub human_players: usize,
    pub total_sessions: usize,
}

#[derive(Debug, Clone, Copy)]
pub enum DebugKillTarget {
    Any,
    Bot,
    Human,
}

#[derive(Debug)]
struct SessionEntry {
    outbound_state: Arc<LatestFrame>,
    outbound_hi: mpsc::Sender<Vec<u8>>,
    outbound_lo: mpsc::Sender<Vec<u8>>,
    inbound: Arc<SessionInbound>,
    player_id: Option<String>,
    view_center: Option<Point>,
    view_radius: Option<f64>,
    camera_distance: Option<f64>,
    pellet_view_ids: HashSet<u32>,
    pellet_view_initialized: bool,
    pellet_reset_retry_at: i64,
    delta_player_cache: HashMap<u16, DeltaPlayerCache>,
    force_next_keyframe: bool,
    latest_applied_input_seq: u16,
}

#[derive(Debug)]
struct RoomState {
    room_id: String,
    sessions: HashMap<String, SessionEntry>,
    players: HashMap<String, Player>,
    pellets: Vec<Pellet>,
    next_pellet_id: u32,
    next_state_seq: u32,
    next_player_net_id: u16,
    next_evasive_spawn_at: HashMap<String, i64>,
    pending_pellet_consumes: Vec<(u32, String)>,
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

#[derive(Debug, Clone, PartialEq)]
struct DeltaDigestionCache {
    id: u32,
    progress_q: u16,
    strength_q: u8,
}

#[derive(Debug, Clone, PartialEq)]
struct DeltaSnakeCache {
    detail: u8,
    total_len: u16,
    start: u16,
    len: u16,
    points: Vec<(i16, i16)>,
}

#[derive(Debug, Clone, PartialEq)]
struct DeltaPlayerCache {
    flags: u8,
    score: i32,
    score_fraction_q: u8,
    oxygen_q: u8,
    girth_q: u8,
    tail_ext_q: u16,
    tail_tip_oct: (i16, i16),
    snake: DeltaSnakeCache,
    digestions: Vec<DeltaDigestionCache>,
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

const PELLET_SPAWN_COLLIDER_MARGIN_ANGLE: f64 = 0.0055;
const PELLET_DEATH_LOCAL_RESPAWN_ATTEMPTS: usize = 14;
const PELLET_DEATH_GLOBAL_RESPAWN_ATTEMPTS: usize = 40;
const ROCK_PELLET_RING_OFFSET_MIN_ANGLE: f64 = 0.006;
const ROCK_PELLET_RING_OFFSET_MAX_ANGLE: f64 = 0.06;
const ROCK_PELLET_SPAWN_ATTEMPTS: usize = 8;

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
        Self::with_room_id_and_max_human_players("main".to_string(), None)
    }

    pub fn with_room_id(room_id: String) -> Self {
        Self::with_room_id_and_max_human_players(room_id, None)
    }

    pub fn with_max_human_players(max_human_players: Option<usize>) -> Self {
        Self::with_room_id_and_max_human_players("main".to_string(), max_human_players)
    }

    pub fn with_room_id_and_max_human_players(
        room_id: String,
        max_human_players: Option<usize>,
    ) -> Self {
        Self {
            state: Mutex::new(RoomState {
                room_id,
                sessions: HashMap::new(),
                players: HashMap::new(),
                pellets: Vec::new(),
                next_pellet_id: 0,
                next_state_seq: 1,
                next_player_net_id: 1,
                next_evasive_spawn_at: HashMap::new(),
                pending_pellet_consumes: Vec::new(),
                environment: Environment::generate(),
            }),
            running: AtomicBool::new(false),
            max_human_players,
        }
    }

    pub async fn add_session(&self) -> SessionIo {
        let session_id = Uuid::new_v4().to_string();
        let inbound = Arc::new(SessionInbound::new());
        let outbound_state = Arc::new(LatestFrame::new());
        let (outbound_hi, outbound_hi_rx) = mpsc::channel::<Vec<u8>>(OUTBOUND_HI_CAPACITY);
        let (outbound_lo, outbound_lo_rx) = mpsc::channel::<Vec<u8>>(OUTBOUND_LO_CAPACITY);
        let mut state = self.state.lock().await;
        state.sessions.insert(
            session_id.clone(),
            SessionEntry {
                outbound_state: Arc::clone(&outbound_state),
                outbound_hi,
                outbound_lo,
                inbound: Arc::clone(&inbound),
                player_id: None,
                view_center: None,
                view_radius: None,
                camera_distance: None,
                pellet_view_ids: HashSet::new(),
                pellet_view_initialized: false,
                pellet_reset_retry_at: 0,
                delta_player_cache: HashMap::new(),
                force_next_keyframe: true,
                latest_applied_input_seq: 0,
            },
        );
        SessionIo {
            session_id,
            inbound,
            outbound_state,
            outbound_hi_rx,
            outbound_lo_rx,
        }
    }

    pub async fn remove_session(&self, session_id: &str) {
        let mut state = self.state.lock().await;
        state.disconnect_session(session_id);
    }

    pub async fn handle_text_message(
        self: &Arc<Self>,
        session_id: &str,
        inbound: &Arc<SessionInbound>,
        text: &str,
    ) -> bool {
        let Ok(message) = serde_json::from_str::<JsonClientMessage>(text) else {
            return true;
        };
        match message {
            JsonClientMessage::Join {
                name,
                player_id,
                defer_spawn,
            } => {
                let player_id = player_id.and_then(|value| Uuid::parse_str(&value).ok());
                self.handle_client_message(
                    session_id,
                    protocol::ClientMessage::Join {
                        name,
                        player_id,
                        defer_spawn: defer_spawn.unwrap_or(false),
                        skin: None,
                    },
                )
                .await
            }
            JsonClientMessage::Respawn => {
                self.handle_client_message(session_id, protocol::ClientMessage::Respawn)
                    .await
            }
            JsonClientMessage::Input {
                axis,
                boost,
                view_center,
                view_radius,
                camera_distance,
            } => {
                inbound.update_input(axis, boost.unwrap_or(false), None);
                inbound.update_view(view_center, view_radius, camera_distance);
                true
            }
        }
    }

    pub async fn handle_binary_message(
        self: &Arc<Self>,
        session_id: &str,
        inbound: &Arc<SessionInbound>,
        data: &[u8],
    ) -> bool {
        let Some(message) = protocol::decode_client_message(data) else {
            return true;
        };
        match message {
            protocol::ClientMessage::Input {
                axis,
                boost,
                input_seq,
            } => {
                inbound.update_input(axis, boost, Some(input_seq));
                true
            }
            protocol::ClientMessage::View {
                view_center,
                view_radius,
                camera_distance,
            } => {
                inbound.update_view(view_center, view_radius, camera_distance);
                true
            }
            _ => self.handle_client_message(session_id, message).await,
        }
    }

    async fn handle_client_message(
        self: &Arc<Self>,
        session_id: &str,
        message: protocol::ClientMessage,
    ) -> bool {
        let mut state = self.state.lock().await;
        match message {
            protocol::ClientMessage::Join {
                name,
                player_id,
                defer_spawn,
                skin,
            } => {
                let accepted = state.handle_join(
                    session_id,
                    name,
                    player_id,
                    defer_spawn,
                    skin,
                    self.max_human_players,
                );
                if !accepted {
                    return false;
                }
                drop(state);
                self.ensure_loop();
                true
            }
            protocol::ClientMessage::Respawn => {
                state.handle_respawn(session_id);
                true
            }
            protocol::ClientMessage::Input {
                axis,
                boost,
                input_seq,
            } => {
                state.handle_input(session_id, axis, boost, Some(input_seq));
                true
            }
            protocol::ClientMessage::View {
                view_center,
                view_radius,
                camera_distance,
            } => {
                state.handle_view(session_id, view_center, view_radius, camera_distance);
                true
            }
        }
    }

    pub async fn debug_kill(&self, target: DebugKillTarget) -> Option<String> {
        let mut state = self.state.lock().await;
        state.debug_kill(target)
    }

    pub async fn stats(&self) -> RoomStats {
        let state = self.state.lock().await;
        RoomStats {
            human_players: state.human_count(),
            total_sessions: state.sessions.len(),
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
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
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
        skin: Option<Vec<[u8; 3]>>,
        max_human_players: Option<usize>,
    ) -> bool {
        let raw_name = name.unwrap_or_else(|| "Player".to_string());
        let sanitized_name = sanitize_player_name(&raw_name, "Player");

        let existing_player_id = player_id.map(|id| id.to_string());
        let is_existing_human = existing_player_id
            .as_deref()
            .and_then(|id| self.players.get(id))
            .map(|player| !player.is_bot)
            .unwrap_or(false);
        if let Some(max_players) = max_human_players {
            if self.human_count() >= max_players && !is_existing_human {
                tracing::warn!(
                    room_capacity = max_players,
                    current_humans = self.human_count(),
                    "room_join_rejected_capacity_reached"
                );
                return false;
            }
        }

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

        if let Some(pattern) = skin {
            let clamped_len = pattern.len().min(8);
            let stored = if clamped_len > 0 {
                Some(
                    pattern
                        .into_iter()
                        .take(clamped_len)
                        .collect::<Vec<[u8; 3]>>(),
                )
            } else {
                None
            };
            if let Some(player) = self.players.get_mut(&player_id) {
                player.skin = stored.clone();
                if let Some(first) = stored.as_ref().and_then(|v| v.first()) {
                    player.color = format!("#{:02x}{:02x}{:02x}", first[0], first[1], first[2]);
                }
                player.trail_color_cycle_cursor = 0;
                player.next_boost_trail_pellet_at_ms = 0;
            }
        }

        let outbound_hi = if let Some(session) = self.sessions.get_mut(session_id) {
            session.player_id = Some(player_id.clone());
            session.pellet_view_initialized = false;
            session.pellet_view_ids.clear();
            session.pellet_reset_retry_at = 0;
            session.delta_player_cache.clear();
            session.force_next_keyframe = true;
            Some(session.outbound_hi.clone())
        } else {
            None
        };
        if let Some(outbound_hi) = outbound_hi {
            let payload = self.build_init_payload_for_session(session_id, &player_id);
            if outbound_hi.try_send(payload).is_err() {
                self.disconnect_session(session_id);
                return false;
            }
        }
        self.maybe_send_pellet_reset_for_session(session_id);
        self.broadcast_player_meta(&[player_id]);
        true
    }

    fn prepare_player_for_manual_spawn(player: &mut Player) {
        player.boost = false;
        player.is_boosting = false;
        player.oxygen = OXYGEN_MAX;
        player.oxygen_damage_accumulator = 0.0;
        player.score = 0;
        player.alive = false;
        player.respawn_at = None;
        player.boost_floor_len = STARTING_LENGTH;
        player.trail_color_cycle_cursor = 0;
        player.next_boost_trail_pellet_at_ms = 0;
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
        input_seq: Option<u16>,
    ) {
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
        if let Some(seq) = input_seq {
            if let Some(session) = self.sessions.get_mut(session_id) {
                session.latest_applied_input_seq = seq;
            }
        }
    }

    fn handle_view(
        &mut self,
        session_id: &str,
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
        self.maybe_send_pellet_reset_for_session(session_id);
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

    fn human_count(&self) -> usize {
        self.players
            .values()
            .filter(|player| !player.is_bot && player.connected)
            .count()
    }

    fn desired_bot_count(&self) -> usize {
        static BOT_COUNT_OVERRIDE: OnceLock<Option<usize>> = OnceLock::new();
        static BOT_SUPPRESS_ROOM_PREFIX: OnceLock<Option<String>> = OnceLock::new();

        let suppress_prefix = BOT_SUPPRESS_ROOM_PREFIX.get_or_init(|| {
            std::env::var(BOT_SUPPRESS_ROOM_PREFIX_ENV_KEY)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        });
        if let Some(prefix) = suppress_prefix {
            if self.room_id.starts_with(prefix) {
                return 0;
            }
        }

        let override_count = BOT_COUNT_OVERRIDE.get_or_init(|| {
            std::env::var(BOT_COUNT_ENV_KEY)
                .ok()
                .and_then(|value| value.trim().parse::<usize>().ok())
        });
        override_count.unwrap_or(BOT_COUNT)
    }

    fn oxygen_disabled() -> bool {
        static OXYGEN_DISABLED: OnceLock<bool> = OnceLock::new();
        *OXYGEN_DISABLED.get_or_init(|| {
            std::env::var(OXYGEN_DISABLED_ENV_KEY)
                .ok()
                .map(|value| value.trim().to_ascii_lowercase())
                .map(|value| value == "1" || value == "true" || value == "yes" || value == "on")
                .unwrap_or(false)
        })
    }

    fn rock_pellet_frequency_multiplier() -> f64 {
        static ROCK_PELLET_FREQ_MULT: OnceLock<f64> = OnceLock::new();
        *ROCK_PELLET_FREQ_MULT.get_or_init(|| {
            std::env::var(ROCK_PELLET_FREQ_MULT_ENV_KEY)
                .ok()
                .and_then(|value| value.trim().parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value > 0.0)
                .unwrap_or(1.0)
        })
    }

    fn rock_pellet_spawn_bias_probability(&self) -> f64 {
        if self.environment.mountains.is_empty() {
            return 0.0;
        }

        let multiplier = Self::rock_pellet_frequency_multiplier();
        if multiplier <= 1.0 {
            return 0.0;
        }

        // `1 - 1/m` gives an intuitive curve:
        // - 2x -> 50% near-rock bias
        // - 5x -> 80% near-rock bias
        // - 20x -> 95% near-rock bias
        clamp(1.0 - (1.0 / multiplier), 0.0, 0.98)
    }

    fn bot_count(&self) -> usize {
        self.players.values().filter(|player| player.is_bot).count()
    }

    fn prune_evasive_spawn_timers(&mut self) {
        self.next_evasive_spawn_at
            .retain(|player_id, _| self.players.contains_key(player_id));
    }

    fn remove_bots(&mut self) {
        self.players.retain(|_, player| !player.is_bot);
        self.prune_evasive_spawn_timers();
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

        let desired_bot_count = self.desired_bot_count();
        if desired_bot_count == 0 {
            self.remove_bots();
            return;
        }

        let mut current = self.bot_count();
        if current >= desired_bot_count {
            return;
        }

        let mut index = self.next_bot_index();
        let mut new_bot_ids: Vec<String> = Vec::new();
        while current < desired_bot_count {
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
                player.boost = dist > BOT_BOOST_DISTANCE && Self::can_player_boost(player);
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

    fn allocate_player_net_id(&mut self) -> u16 {
        let mut candidate = self.next_player_net_id.max(1);
        for _ in 0..=u16::MAX {
            if candidate == 0 {
                candidate = 1;
            }
            if !self
                .players
                .values()
                .any(|player| player.net_id == candidate)
            {
                self.next_player_net_id = candidate.wrapping_add(1);
                if self.next_player_net_id == 0 {
                    self.next_player_net_id = 1;
                }
                return candidate;
            }
            candidate = candidate.wrapping_add(1);
        }
        0
    }

    fn create_player(&mut self, id: Uuid, name: String, is_bot: bool) -> Player {
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
        let net_id = self.allocate_player_net_id();

        Player {
            id: id_string,
            id_bytes: *id.as_bytes(),
            net_id,
            name,
            color: COLOR_POOL[self.players.len() % COLOR_POOL.len()].to_string(),
            skin: None,
            is_bot,
            axis,
            target_axis: axis,
            boost: false,
            is_boosting: false,
            oxygen: OXYGEN_MAX,
            oxygen_damage_accumulator: 0.0,
            score: snake.len() as i64,
            alive,
            connected: true,
            last_seen: Self::now_millis(),
            respawn_at,
            boost_floor_len: snake.len().max(STARTING_LENGTH),
            trail_color_cycle_cursor: 0,
            next_boost_trail_pellet_at_ms: 0,
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

    fn random_pellet_color_rgb(rng: &mut impl Rng) -> [u8; 3] {
        let index = rng.gen_range(0..SMALL_PELLET_COLOR_PALETTE.len());
        SMALL_PELLET_COLOR_PALETTE[index]
    }

    fn parse_hex_rgb(value: &str) -> Option<[u8; 3]> {
        let hex = value.strip_prefix('#')?;
        if hex.len() != 6 {
            return None;
        }
        let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
        let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
        let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
        Some([r, g, b])
    }

    fn player_skin_cycle_color(player: &mut Player) -> [u8; 3] {
        if let Some(skin) = player.skin.as_ref() {
            if !skin.is_empty() {
                let index = player.trail_color_cycle_cursor % skin.len();
                player.trail_color_cycle_cursor = player.trail_color_cycle_cursor.wrapping_add(1);
                return skin[index];
            }
        }
        let fallback = Self::parse_hex_rgb(player.color.as_str()).unwrap_or([255, 255, 255]);
        player.trail_color_cycle_cursor = player.trail_color_cycle_cursor.wrapping_add(1);
        fallback
    }

    fn make_small_pellet(&mut self, normal: Point, rng: &mut impl Rng) -> Pellet {
        let size = rng.gen_range(SMALL_PELLET_SIZE_MIN..=SMALL_PELLET_SIZE_MAX);
        Pellet {
            id: self.next_small_pellet_id(),
            normal,
            color_rgb: Self::random_pellet_color_rgb(rng),
            base_size: size,
            current_size: size,
            growth_fraction: SMALL_PELLET_GROWTH_FRACTION,
            expires_at_ms: None,
            state: PelletState::Idle,
        }
    }

    fn random_small_pellet(&mut self, rng: &mut impl Rng) -> Pellet {
        let normal = Self::random_unit_point(rng);
        self.make_small_pellet(normal, rng)
    }

    fn random_small_pellet_near_rock(&mut self, rng: &mut impl Rng) -> Option<Pellet> {
        if self.environment.mountains.is_empty() {
            return None;
        }

        for _ in 0..ROCK_PELLET_SPAWN_ATTEMPTS {
            let mountain_index = rng.gen_range(0..self.environment.mountains.len());
            let mountain = &self.environment.mountains[mountain_index];
            let (tangent, bitangent) = tangent_basis(mountain.normal);
            let theta = rng.gen::<f64>() * PI * 2.0;
            let dir = normalize(Point {
                x: tangent.x * theta.cos() + bitangent.x * theta.sin(),
                y: tangent.y * theta.cos() + bitangent.y * theta.sin(),
                z: tangent.z * theta.cos() + bitangent.z * theta.sin(),
            });
            let outline_radius = sample_outline_radius(&mountain.outline, theta);
            let ring_offset = rng
                .gen_range(ROCK_PELLET_RING_OFFSET_MIN_ANGLE..=ROCK_PELLET_RING_OFFSET_MAX_ANGLE);
            let angle = clamp(
                outline_radius + PELLET_SPAWN_COLLIDER_MARGIN_ANGLE + ring_offset,
                0.0,
                PI - 1e-4,
            );
            let candidate = normalize(Point {
                x: mountain.normal.x * angle.cos() + dir.x * angle.sin(),
                y: mountain.normal.y * angle.cos() + dir.y * angle.sin(),
                z: mountain.normal.z * angle.cos() + dir.z * angle.sin(),
            });
            if self.is_far_enough_from_heads(candidate) && !self.is_invalid_pellet_spawn(candidate)
            {
                return Some(self.make_small_pellet(candidate, rng));
            }
        }

        None
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

        let (tangent, bitangent) = tangent_basis(mountain.normal);
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
        let outline_radius = sample_outline_radius(&mountain.outline, theta);
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
        let rock_spawn_bias_probability = self.rock_pellet_spawn_bias_probability();
        for _ in 0..SPAWN_ATTEMPTS {
            if rock_spawn_bias_probability > 0.0 && rng.gen_bool(rock_spawn_bias_probability) {
                if let Some(pellet) = self.random_small_pellet_near_rock(rng) {
                    return Some(pellet);
                }
            }
            let pellet = self.random_small_pellet(rng);
            if self.is_far_enough_from_heads(pellet.normal)
                && !self.is_invalid_pellet_spawn(pellet.normal)
            {
                return Some(pellet);
            }
        }
        None
    }

    fn next_evasive_spawn_delay_ms(rng: &mut impl Rng) -> i64 {
        let jitter = if EVASIVE_PELLET_COOLDOWN_JITTER_MS > 0 {
            rng.gen_range(-EVASIVE_PELLET_COOLDOWN_JITTER_MS..=EVASIVE_PELLET_COOLDOWN_JITTER_MS)
        } else {
            0
        };
        (EVASIVE_PELLET_COOLDOWN_MS + jitter).max(EVASIVE_PELLET_RETRY_DELAY_MS)
    }

    fn is_evasive_eligible_player(player: &Player) -> bool {
        if player.is_bot || !player.connected || !player.alive {
            return false;
        }
        (EVASIVE_PELLET_MIN_LEN..=EVASIVE_PELLET_MAX_LEN).contains(&player.snake.len())
    }

    fn active_evasive_pellet_count_for_owner(&self, owner_player_id: &str) -> usize {
        self.pellets
            .iter()
            .filter(|pellet| match &pellet.state {
                PelletState::Evasive {
                    owner_player_id: state_owner,
                    ..
                } => state_owner == owner_player_id,
                _ => false,
            })
            .count()
    }

    fn is_far_enough_from_other_heads(&self, owner_player_id: &str, point: Point) -> bool {
        let min_dot = EVASIVE_PELLET_OTHER_HEAD_EXCLUSION_ANGLE.cos();
        for (player_id, player) in &self.players {
            if player_id == owner_player_id || !player.alive {
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

    fn pick_evasive_spawn_for_owner(
        &self,
        owner_player_id: &str,
        rng: &mut impl Rng,
    ) -> Option<Point> {
        let owner = self.players.get(owner_player_id)?;
        let head = owner.snake.first()?;
        let head = normalize(Point {
            x: head.x,
            y: head.y,
            z: head.z,
        });

        let owner_min_dot = EVASIVE_PELLET_OWNER_NEAR_ANGLE_MIN.cos();
        for _ in 0..EVASIVE_PELLET_SPAWN_ATTEMPTS {
            let target = Self::random_unit_point(rng);
            let angle = rng.gen_range(
                EVASIVE_PELLET_OWNER_NEAR_ANGLE_MIN..=EVASIVE_PELLET_OWNER_NEAR_ANGLE_MAX,
            );
            let candidate = normalize(rotate_toward(head, target, angle));
            if dot(head, candidate) > owner_min_dot {
                continue;
            }
            if self.is_invalid_pellet_spawn(candidate) {
                continue;
            }
            if !self.is_far_enough_from_other_heads(owner_player_id, candidate) {
                continue;
            }
            return Some(candidate);
        }
        None
    }

    fn spawn_evasive_pellets(&mut self, now_ms: i64) {
        let mut rng = rand::thread_rng();
        let eligible_player_ids: Vec<String> = self
            .players
            .iter()
            .filter_map(|(player_id, player)| {
                if Self::is_evasive_eligible_player(player) {
                    Some(player_id.clone())
                } else {
                    None
                }
            })
            .collect();
        if eligible_player_ids.is_empty() {
            return;
        }

        for owner_player_id in eligible_player_ids {
            if self.active_evasive_pellet_count_for_owner(&owner_player_id)
                >= EVASIVE_PELLET_MAX_PER_PLAYER
            {
                continue;
            }
            let next_spawn_at = self
                .next_evasive_spawn_at
                .entry(owner_player_id.clone())
                .or_insert_with(|| now_ms + Self::next_evasive_spawn_delay_ms(&mut rng));
            if now_ms < *next_spawn_at {
                continue;
            }

            let Some(spawn_point) = self.pick_evasive_spawn_for_owner(&owner_player_id, &mut rng)
            else {
                self.next_evasive_spawn_at
                    .insert(owner_player_id, now_ms + EVASIVE_PELLET_RETRY_DELAY_MS);
                continue;
            };

            let size = rng.gen_range(EVASIVE_PELLET_SIZE_MIN..=EVASIVE_PELLET_SIZE_MAX);
            let pellet_id = self.next_small_pellet_id();
            self.pellets.push(Pellet {
                id: pellet_id,
                normal: spawn_point,
                color_rgb: Self::random_pellet_color_rgb(&mut rng),
                base_size: size,
                current_size: size,
                growth_fraction: BIG_PELLET_GROWTH_FRACTION,
                expires_at_ms: None,
                state: PelletState::Evasive {
                    owner_player_id: owner_player_id.clone(),
                    expires_at_ms: now_ms + EVASIVE_PELLET_LIFETIME_MS,
                },
            });
            self.next_evasive_spawn_at.insert(
                owner_player_id,
                now_ms + Self::next_evasive_spawn_delay_ms(&mut rng),
            );
        }

        if self.pellets.len() > MAX_PELLETS {
            let excess = self.pellets.len() - MAX_PELLETS;
            self.pellets.drain(0..excess);
        }
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

    fn spawn_boost_trail_pellets(&mut self, now_ms: i64) {
        if BOOST_TRAIL_PELLET_INTERVAL_MS <= 0 {
            return;
        }

        let mut pending_spawns: Vec<(Point, [u8; 3])> = Vec::new();
        let player_ids: Vec<String> = self.players.keys().cloned().collect();
        for player_id in player_ids {
            let Some(player) = self.players.get_mut(&player_id) else {
                continue;
            };
            if !player.alive || !player.is_boosting {
                player.next_boost_trail_pellet_at_ms = now_ms;
                continue;
            }
            if player.next_boost_trail_pellet_at_ms <= 0 {
                player.next_boost_trail_pellet_at_ms = now_ms;
            }
            if now_ms < player.next_boost_trail_pellet_at_ms {
                continue;
            }
            let Some(tail_node) = player.snake.last() else {
                player.next_boost_trail_pellet_at_ms = now_ms + BOOST_TRAIL_PELLET_INTERVAL_MS;
                continue;
            };
            let tail_normal = normalize(Point {
                x: tail_node.x,
                y: tail_node.y,
                z: tail_node.z,
            });
            if length(tail_normal) <= 1e-8 {
                player.next_boost_trail_pellet_at_ms = now_ms + BOOST_TRAIL_PELLET_INTERVAL_MS;
                continue;
            }
            let color_rgb = Self::player_skin_cycle_color(player);
            pending_spawns.push((tail_normal, color_rgb));
            player.next_boost_trail_pellet_at_ms = now_ms + BOOST_TRAIL_PELLET_INTERVAL_MS;
        }

        if pending_spawns.is_empty() {
            return;
        }

        let mut rng = rand::thread_rng();
        for (normal, color_rgb) in pending_spawns {
            let size = rng.gen_range(BOOST_TRAIL_PELLET_SIZE_MIN..=BOOST_TRAIL_PELLET_SIZE_MAX);
            let pellet_id = self.next_small_pellet_id();
            self.pellets.push(Pellet {
                id: pellet_id,
                normal,
                color_rgb,
                base_size: size,
                current_size: size,
                growth_fraction: BOOST_TRAIL_PELLET_GROWTH_FRACTION,
                expires_at_ms: Some(now_ms + BOOST_TRAIL_PELLET_TTL_MS),
                state: PelletState::Idle,
            });
        }

        if self.pellets.len() > MAX_PELLETS {
            let excess = self.pellets.len() - MAX_PELLETS;
            self.pellets.drain(0..excess);
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
            let head_dot = clamp(dot(attractor.head, pellet), -1.0, 1.0);
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
            let mouth_dot = clamp(dot(attractor.mouth, pellet), -1.0, 1.0);
            match best {
                Some((_, _, best_dot)) if mouth_dot <= best_dot => {}
                _ => best = Some((id.clone(), *attractor, mouth_dot)),
            }
        }
        best.map(|(id, attractor, _)| (id, attractor))
    }

    fn find_consuming_player(
        pellet: Point,
        consume_cos: f64,
        attractors: &HashMap<String, HeadAttractor>,
    ) -> Option<String> {
        let mut best: Option<(String, f64)> = None;
        for (player_id, attractor) in attractors {
            let consume_dot = clamp(dot(pellet, attractor.mouth), -1.0, 1.0);
            if consume_dot < consume_cos {
                continue;
            }
            match best {
                Some((_, best_dot)) if consume_dot <= best_dot => {}
                _ => best = Some((player_id.clone(), consume_dot)),
            }
        }
        best.map(|(player_id, _)| player_id)
    }

    fn find_suction_target(
        pellet: Point,
        suction_cos: f64,
        attractors: &HashMap<String, HeadAttractor>,
    ) -> Option<(String, HeadAttractor)> {
        let mut best: Option<(String, HeadAttractor, f64)> = None;
        for (player_id, attractor) in attractors {
            let suction_dot = clamp(dot(pellet, attractor.mouth), -1.0, 1.0);
            if suction_dot < suction_cos {
                continue;
            }
            match best {
                Some((_, _, best_dot)) if suction_dot <= best_dot => {}
                _ => best = Some((player_id.clone(), *attractor, suction_dot)),
            }
        }
        best.map(|(player_id, attractor, _)| (player_id, attractor))
    }

    fn evasive_speed_factor(owner_dot: f64) -> f64 {
        let owner_angle = clamp(owner_dot, -1.0, 1.0).acos();
        let full_angle = EVASIVE_PELLET_EVADE_RADIUS * EVASIVE_PELLET_EVADE_FULL_RADIUS_RATIO;
        let fade_angle = EVASIVE_PELLET_EVADE_RADIUS * EVASIVE_PELLET_EVADE_FADE_RADIUS_RATIO;
        let fade_span = (fade_angle - full_angle).max(1e-6);
        let t = clamp((owner_angle - full_angle) / fade_span, 0.0, 1.0);
        let smooth = t * t * (3.0 - 2.0 * t);
        EVASIVE_PELLET_EVADE_MIN_FACTOR + (1.0 - EVASIVE_PELLET_EVADE_MIN_FACTOR) * (1.0 - smooth)
    }

    fn is_owner_chasing_evasive(owner_attractor: HeadAttractor, pellet: Point) -> bool {
        let head_dot = clamp(dot(owner_attractor.head, pellet), -1.0, 1.0);
        let head_angle = head_dot.acos();
        if head_angle > EVASIVE_PELLET_EVADE_RADIUS * EVASIVE_PELLET_CHASE_MAX_ANGLE_RATIO {
            return false;
        }

        let toward = Point {
            x: pellet.x - owner_attractor.head.x * head_dot,
            y: pellet.y - owner_attractor.head.y * head_dot,
            z: pellet.z - owner_attractor.head.z * head_dot,
        };
        let toward_len = length(toward);
        if toward_len <= 1e-6 {
            return true;
        }
        let toward_dir = Point {
            x: toward.x / toward_len,
            y: toward.y / toward_len,
            z: toward.z / toward_len,
        };

        dot(owner_attractor.forward, toward_dir) >= EVASIVE_PELLET_CHASE_CONE_ANGLE.cos()
    }

    fn evasive_tangent_direction(
        pellet: &Pellet,
        owner_attractor: HeadAttractor,
        now_ms: i64,
    ) -> Option<Point> {
        let owner_dot = clamp(dot(pellet.normal, owner_attractor.head), -1.0, 1.0);
        let toward_owner = Point {
            x: owner_attractor.head.x - pellet.normal.x * owner_dot,
            y: owner_attractor.head.y - pellet.normal.y * owner_dot,
            z: owner_attractor.head.z - pellet.normal.z * owner_dot,
        };
        let mut away = Point {
            x: -toward_owner.x,
            y: -toward_owner.y,
            z: -toward_owner.z,
        };
        if length(away) <= 1e-6 {
            away = Point {
                x: owner_attractor.forward.x
                    - pellet.normal.x * dot(owner_attractor.forward, pellet.normal),
                y: owner_attractor.forward.y
                    - pellet.normal.y * dot(owner_attractor.forward, pellet.normal),
                z: owner_attractor.forward.z
                    - pellet.normal.z * dot(owner_attractor.forward, pellet.normal),
            };
        }
        let away_len = length(away);
        if away_len <= 1e-6 {
            return None;
        }
        let away_dir = Point {
            x: away.x / away_len,
            y: away.y / away_len,
            z: away.z / away_len,
        };
        let mut strafe = cross(pellet.normal, away_dir);
        let strafe_len = length(strafe);
        if strafe_len <= 1e-6 {
            return Some(away_dir);
        }
        strafe = Point {
            x: strafe.x / strafe_len,
            y: strafe.y / strafe_len,
            z: strafe.z / strafe_len,
        };

        let phase = now_ms as f64 * 0.001 * EVASIVE_PELLET_ZIGZAG_HZ * PI * 2.0
            + pellet.id as f64 * 0.754_877_666_246_692_7;
        let zigzag = phase.sin() * EVASIVE_PELLET_ZIGZAG_STRENGTH;
        let desired = Point {
            x: away_dir.x + strafe.x * zigzag,
            y: away_dir.y + strafe.y * zigzag,
            z: away_dir.z + strafe.z * zigzag,
        };
        let desired_len = length(desired);
        if desired_len <= 1e-6 {
            return Some(away_dir);
        }
        Some(Point {
            x: desired.x / desired_len,
            y: desired.y / desired_len,
            z: desired.z / desired_len,
        })
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
        let now_ms = Self::now_millis();
        let attractors = self.build_head_attractors();
        let consume_cos = SMALL_PELLET_CONSUME_ANGLE.cos();
        let suction_cos = EVASIVE_PELLET_SUCTION_RADIUS.cos();
        // Cap angular travel per tick so attracted pellets visibly move/shrink toward the mouth
        // instead of snapping directly into the consume angle in one update.
        let attract_step = (SMALL_PELLET_ATTRACT_SPEED * dt_seconds)
            .min(SMALL_PELLET_ATTRACT_RADIUS * SMALL_PELLET_ATTRACT_STEP_MAX_RATIO);
        let evasive_step = (EVASIVE_PELLET_EVADE_SPEED * dt_seconds)
            .min(EVASIVE_PELLET_EVADE_STEP_MAX)
            .min(EVASIVE_PELLET_MAX_STEP_PER_TICK);
        let suction_step =
            (EVASIVE_PELLET_SUCTION_SPEED * dt_seconds).min(EVASIVE_PELLET_SUCTION_STEP_MAX);
        let mut consumed_by: HashMap<String, (usize, f64)> = HashMap::new();
        let mut consumed_events: Vec<(u32, String)> = Vec::new();
        let mut i = 0usize;
        while i < self.pellets.len() {
            if self.pellets[i]
                .expires_at_ms
                .is_some_and(|expires_at_ms| expires_at_ms <= now_ms)
            {
                self.pellets.swap_remove(i);
                continue;
            }
            let pellet_state = self.pellets[i].state.clone();

            if let PelletState::Evasive {
                owner_player_id,
                expires_at_ms,
            } = pellet_state
            {
                if expires_at_ms <= now_ms {
                    self.pellets.swap_remove(i);
                    continue;
                }

                if let Some(player_id) =
                    Self::find_consuming_player(self.pellets[i].normal, consume_cos, &attractors)
                {
                    let pellet_id = self.pellets[i].id;
                    let growth_fraction = self.pellets[i].growth_fraction;
                    let entry = consumed_by.entry(player_id.clone()).or_insert((0, 0.0));
                    entry.0 += 1;
                    entry.1 += growth_fraction;
                    consumed_events.push((pellet_id, player_id));
                    self.pellets.swap_remove(i);
                    continue;
                }

                let Some(owner_attractor) = attractors.get(&owner_player_id).copied() else {
                    self.pellets.swap_remove(i);
                    continue;
                };
                let owner_is_chasing =
                    Self::is_owner_chasing_evasive(owner_attractor, self.pellets[i].normal);
                let suction_target =
                    Self::find_suction_target(self.pellets[i].normal, suction_cos, &attractors);

                {
                    let pellet = &mut self.pellets[i];
                    if let Some((_, suction_attractor)) = suction_target {
                        pellet.normal =
                            rotate_toward(pellet.normal, suction_attractor.mouth, suction_step);
                    } else if owner_is_chasing {
                        let owner_dot = clamp(dot(pellet.normal, owner_attractor.head), -1.0, 1.0);
                        let speed_factor = Self::evasive_speed_factor(owner_dot);
                        let step = (evasive_step * speed_factor).max(1e-4);
                        if let Some(tangent_dir) =
                            Self::evasive_tangent_direction(pellet, owner_attractor, now_ms)
                        {
                            let target = normalize(Point {
                                x: pellet.normal.x + tangent_dir.x * step,
                                y: pellet.normal.y + tangent_dir.y * step,
                                z: pellet.normal.z + tangent_dir.z * step,
                            });
                            pellet.normal = rotate_toward(pellet.normal, target, step);
                        }
                    }
                    pellet.current_size = pellet.base_size;
                }

                if let Some(player_id) =
                    Self::find_consuming_player(self.pellets[i].normal, consume_cos, &attractors)
                {
                    let pellet_id = self.pellets[i].id;
                    let growth_fraction = self.pellets[i].growth_fraction;
                    let entry = consumed_by.entry(player_id.clone()).or_insert((0, 0.0));
                    entry.0 += 1;
                    entry.1 += growth_fraction;
                    consumed_events.push((pellet_id, player_id));
                    self.pellets.swap_remove(i);
                    continue;
                }

                i += 1;
                continue;
            }

            let target = match pellet_state {
                PelletState::Attracting {
                    ref target_player_id,
                } => {
                    // Preserve the current intake target while that target remains valid/alive.
                    // Only reacquire if the current target is no longer available.
                    attractors
                        .get(target_player_id)
                        .copied()
                        .map(|attractor| (target_player_id.clone(), attractor))
                        .or_else(|| Self::find_pellet_target(self.pellets[i].normal, &attractors))
                }
                PelletState::Idle => Self::find_pellet_target(self.pellets[i].normal, &attractors),
                PelletState::Evasive { .. } => None,
            };

            if let Some((target_id, attractor)) = target {
                let pellet = &mut self.pellets[i];
                pellet.state = PelletState::Attracting {
                    target_player_id: target_id.clone(),
                };

                let to_mouth_dot = clamp(dot(pellet.normal, attractor.mouth), -1.0, 1.0);
                if to_mouth_dot >= consume_cos {
                    let pellet_id = pellet.id;
                    let growth_fraction = pellet.growth_fraction;
                    let entry = consumed_by.entry(target_id.clone()).or_insert((0, 0.0));
                    entry.0 += 1;
                    entry.1 += growth_fraction;
                    consumed_events.push((pellet_id, target_id));
                    self.pellets.swap_remove(i);
                    continue;
                }

                pellet.normal = rotate_toward(pellet.normal, attractor.mouth, attract_step);
                let after_dot = clamp(dot(pellet.normal, attractor.mouth), -1.0, 1.0);
                if after_dot >= consume_cos {
                    let pellet_id = pellet.id;
                    let growth_fraction = pellet.growth_fraction;
                    let entry = consumed_by.entry(target_id.clone()).or_insert((0, 0.0));
                    entry.0 += 1;
                    entry.1 += growth_fraction;
                    consumed_events.push((pellet_id, target_id));
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

        if !consumed_events.is_empty() {
            self.pending_pellet_consumes.extend(consumed_events);
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

    fn detect_snake_head_body_collisions(
        player_snapshots: &[PlayerCollisionSnapshot],
        dead: &mut HashSet<String>,
        death_reasons: &mut HashMap<String, &'static str>,
    ) {
        for snapshot in player_snapshots {
            if dead.contains(&snapshot.id) || !snapshot.alive || snapshot.snake.len() < 3 {
                continue;
            }
            let head = snapshot.snake[0];
            for other_snapshot in player_snapshots {
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
    }

    fn can_player_continue_boost(player: &Player) -> bool {
        if player.snake.len() > player.boost_floor_len.max(1) {
            return true;
        }
        if player.tail_extension > 1e-6 {
            return true;
        }
        player
            .digestions
            .iter()
            .any(|digestion| digestion.growth_amount - digestion.applied_growth > 1e-6)
    }

    fn min_boost_start_score(player: &Player) -> i64 {
        player
            .boost_floor_len
            .saturating_add(1)
            .min(i64::MAX as usize) as i64
    }

    fn can_player_boost(player: &Player) -> bool {
        if !Self::can_player_continue_boost(player) {
            return false;
        }
        player.is_boosting || player.score >= Self::min_boost_start_score(player)
    }

    fn slither_scang_for_len(snake_len: usize) -> f64 {
        let sc =
            (1.0 + (snake_len.saturating_sub(2) as f64) / TURN_SC_LENGTH_DIVISOR).min(TURN_SC_MAX);
        let length_ratio = ((7.0 - sc) / 6.0).max(0.0);
        TURN_SCANG_BASE + TURN_SCANG_RANGE * length_ratio * length_ratio
    }

    fn slither_spang_for_speed(speed_factor: f64) -> f64 {
        let speed = if speed_factor.is_finite() {
            speed_factor.max(0.0)
        } else {
            0.0
        };
        let boost_excess = (speed - 1.0).max(0.0);
        let penalty = 1.0 + TURN_SPEED_BOOST_TURN_PENALTY.max(0.0) * boost_excess;
        let damped = 1.0 / penalty.max(1e-6);
        clamp(damped, TURN_SPEED_MIN_MULTIPLIER, 1.0)
    }

    fn steering_gain_for_speed(speed_factor: f64) -> f64 {
        let speed = if speed_factor.is_finite() {
            speed_factor.max(0.0)
        } else {
            0.0
        };
        let boost_window = (BOOST_MULTIPLIER - 1.0).max(1e-6);
        let blend = clamp((speed - 1.0) / boost_window, 0.0, 1.0);
        TURN_RESPONSE_GAIN_NORMAL_PER_SEC
            + (TURN_RESPONSE_GAIN_BOOST_PER_SEC - TURN_RESPONSE_GAIN_NORMAL_PER_SEC) * blend
    }

    fn movement_substep_count(is_boosting: bool) -> usize {
        if is_boosting {
            TURN_SUBSTEPS_BOOST.max(1)
        } else {
            TURN_SUBSTEPS_NORMAL.max(1)
        }
    }

    fn steering_turn_step(
        current_axis: Point,
        target_axis: Point,
        turn_cap: f64,
        steering_gain_per_sec: f64,
        dt_seconds: f64,
    ) -> f64 {
        let capped_turn = turn_cap.max(0.0);
        if capped_turn <= 0.0 {
            return 0.0;
        }
        let current = normalize(current_axis);
        let target = normalize(target_axis);
        if length(current) <= 1e-6 || length(target) <= 1e-6 {
            return capped_turn;
        }
        let angle_error = clamp(dot(current, target), -1.0, 1.0).acos();
        if !angle_error.is_finite() {
            return capped_turn;
        }
        let proportional_step = angle_error * steering_gain_per_sec.max(0.0) * dt_seconds.max(0.0);
        clamp(proportional_step, 0.0, capped_turn)
    }

    fn turn_rate_for(snake_len: usize, speed_factor: f64) -> f64 {
        let speed = if speed_factor.is_finite() {
            speed_factor.max(0.0)
        } else {
            0.0
        };
        let scang = Self::slither_scang_for_len(snake_len);
        let spang = Self::slither_spang_for_speed(speed);
        let baseline_scang = Self::slither_scang_for_len(STARTING_LENGTH);
        let baseline_spang = Self::slither_spang_for_speed(1.0);
        let baseline = (baseline_scang * baseline_spang).max(1e-6);
        let boost_window = (BOOST_MULTIPLIER - 1.0).max(1e-6);
        let boost_blend = clamp((speed - 1.0) / boost_window, 0.0, 1.0);
        let boost_turn_mult = 1.0 + (TURN_BOOST_TURN_RATE_MULTIPLIER - 1.0).max(0.0) * boost_blend;
        let normalized = (scang * spang) / baseline;
        let raw_turn_rate = TURN_RATE * normalized * boost_turn_mult;
        clamp(
            raw_turn_rate,
            TURN_RATE * TURN_RATE_MIN_MULTIPLIER,
            TURN_RATE * TURN_RATE_MAX_MULTIPLIER,
        )
    }

    fn player_score_fraction(player: &Player) -> f64 {
        clamp(player.pellet_growth_fraction, 0.0, 0.999_999)
    }

    fn apply_session_inbound(&mut self) {
        for session in self.sessions.values_mut() {
            let inbound = session.inbound.snapshot();

            session.view_center = inbound.view_center;
            session.view_radius = inbound.view_radius;
            session.camera_distance = inbound.camera_distance;

            let Some(player_id) = session.player_id.as_deref() else {
                continue;
            };
            let Some(player) = self.players.get_mut(player_id) else {
                continue;
            };

            if let Some(axis) = inbound.input_axis {
                player.target_axis = axis;
            }
            player.boost = inbound.boost;
            if let Some(seq) = inbound.latest_input_seq {
                session.latest_applied_input_seq = seq;
            }
            if inbound.last_input_at > 0 {
                player.last_seen = inbound.last_input_at;
            }
        }
    }

    fn tick(&mut self) {
        let now = Self::now_millis();
        self.apply_session_inbound();

        // If we had to drop pellet deltas due to backpressure, resync via reset as soon as the
        // session can accept reliable frames again.
        let pellet_reset_sessions: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, session)| {
                !session.pellet_view_initialized && now >= session.pellet_reset_retry_at
            })
            .map(|(id, _)| id.clone())
            .collect();
        for session_id in pellet_reset_sessions {
            self.maybe_send_pellet_reset_for_session(&session_id);
        }

        let dt_seconds = TICK_MS as f64 / 1000.0;
        let mut move_steps: HashMap<String, i32> = HashMap::new();

        self.players.retain(|_, player| {
            if player.connected {
                true
            } else {
                now - player.last_seen <= PLAYER_TIMEOUT_MS
            }
        });
        self.prune_evasive_spawn_timers();

        self.ensure_bots();
        self.ensure_pellets();
        self.update_bots();
        self.auto_respawn_players(now);
        self.spawn_evasive_pellets(now);

        let player_ids: Vec<String> = self.players.keys().cloned().collect();
        for id in &player_ids {
            let Some(player) = self.players.get_mut(id) else {
                continue;
            };
            if !player.alive {
                continue;
            }
            let wants_boost = player.boost;
            let is_boosting = wants_boost && Self::can_player_boost(player);
            player.is_boosting = is_boosting;
            let speed_factor = if is_boosting { BOOST_MULTIPLIER } else { 1.0 };
            let step_count = Self::movement_substep_count(is_boosting);
            let step_velocity = (BASE_SPEED * speed_factor) / step_count as f64;
            let turn_per_tick = Self::turn_rate_for(player.snake.len(), speed_factor);
            let turn_per_substep_cap = turn_per_tick / step_count as f64;
            let steering_gain_per_sec = Self::steering_gain_for_speed(speed_factor);
            let substep_dt_seconds = dt_seconds / step_count as f64;
            let target_axis = normalize(player.target_axis);
            let snake_angular_radius =
                Self::snake_contact_angular_radius_for_len(player.snake.len());
            for _ in 0..step_count {
                let turn_step = Self::steering_turn_step(
                    player.axis,
                    target_axis,
                    turn_per_substep_cap,
                    steering_gain_per_sec,
                    substep_dt_seconds,
                );
                player.axis = rotate_toward(player.axis, target_axis, turn_step);
                apply_snake_with_collisions(
                    &mut player.snake,
                    &mut player.axis,
                    snake_angular_radius,
                    step_velocity,
                    1,
                    &self.environment,
                );
            }
            move_steps.insert(player.id.clone(), step_count as i32);
        }

        let mut death_reasons: HashMap<String, &'static str> = HashMap::new();
        let mut oxygen_dead: HashSet<String> = HashSet::new();
        let oxygen_disabled = Self::oxygen_disabled();
        let player_ids: Vec<String> = self.players.keys().cloned().collect();
        for id in &player_ids {
            let Some(player) = self.players.get_mut(id) else {
                continue;
            };
            if !player.alive {
                continue;
            }
            if oxygen_disabled {
                player.oxygen = OXYGEN_MAX;
                player.oxygen_damage_accumulator = 0.0;
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
                if let Some(extended_tail) =
                    compute_extended_tail_point(&player.snake, player.tail_extension)
                {
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

        Self::detect_snake_head_body_collisions(&player_snapshots, &mut dead, &mut death_reasons);

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
            let step_count = steps.max(1) as f64;
            let boost_drain = if player.is_boosting {
                BoostDrainConfig {
                    active: true,
                    min_length: player.boost_floor_len.max(MIN_SURVIVAL_LENGTH),
                    score_per_step: (BOOST_SCORE_DRAIN_PER_SEC * dt_seconds) / step_count,
                    node_per_step: (BOOST_NODE_DRAIN_PER_SEC * dt_seconds) / step_count,
                }
            } else {
                BoostDrainConfig::default()
            };
            let boost_active_after = advance_digestions_with_boost(player, steps, boost_drain);
            player.is_boosting = player.boost && boost_active_after;
        }

        self.spawn_boost_trail_pellets(now);

        // Advance existing digestions before applying newly swallowed pellets so new bulges
        // always begin from the same head-relative start regardless of boost step count.
        self.update_small_pellets(dt_seconds);
        self.ensure_pellets();

        let now = Self::now_millis();
        let state_seq = self.next_state_seq;
        self.broadcast_pellet_consumes(now, state_seq);
        self.broadcast_state_delta(now, state_seq);
        self.broadcast_pellet_delta(now, state_seq);
        self.next_state_seq = self.next_state_seq.wrapping_add(1);
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
            player.next_boost_trail_pellet_at_ms = 0;
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
            let pellet_id = self.next_small_pellet_id();
            self.pellets.push(Pellet {
                id: pellet_id,
                normal: spawn_point,
                color_rgb: Self::random_pellet_color_rgb(&mut rng),
                base_size: size,
                current_size: size,
                growth_fraction: BIG_PELLET_GROWTH_FRACTION,
                expires_at_ms: None,
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
        player.alive = true;
        player.boost = false;
        player.is_boosting = false;
        player.oxygen = OXYGEN_MAX;
        player.oxygen_damage_accumulator = 0.0;
        player.respawn_at = None;
        player.snake = spawned.snake;
        player.score = player.snake.len() as i64;
        player.boost_floor_len = player.snake.len().max(STARTING_LENGTH);
        player.trail_color_cycle_cursor = 0;
        player.next_boost_trail_pellet_at_ms = 0;
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
        let total_players = self.players.len().min(u16::MAX as usize);
        let visible_player_count = visible_players.len().min(u16::MAX as usize);
        let now = Self::now_millis();
        let state_seq = self.next_state_seq.wrapping_sub(1);
        let tick_ms = TICK_MS.min(u16::MAX as u64) as u16;
        let mut capacity = 4 + 16 + 8 + 4 + 2 + 2 + 2;
        for player in self.players.values().take(total_players) {
            capacity += 2; // net id
            capacity += 16;
            capacity += 1 + Self::truncated_len(&player.name);
            capacity += 1 + Self::truncated_len(&player.color);
            capacity += 1;
            capacity += player
                .skin
                .as_ref()
                .map(|skin| skin.len().min(8) * 3)
                .unwrap_or(0);
        }
        capacity += 2;
        for visible in visible_players.iter().take(visible_player_count) {
            let player = visible.player;
            let window = visible.window;
            capacity += 2 + 1 + 4 + 2 + 2 + 1 + 2 + 4 + 1 + 2; // net id + flags + score + frac + oxygen + girth + tail_ext + tail_tip(oct) + detail + total_len
            match window.detail {
                SnakeDetail::Full => {
                    capacity += 2 + window.len * 4;
                }
                SnakeDetail::Window => {
                    capacity += 2 + 2 + window.len * 4;
                }
                SnakeDetail::Stub => {}
            }
            capacity += 1; // digestion len
            if window.include_digestions() {
                capacity += player.digestions.len() * 12;
            }
        }
        capacity += self.environment.encoded_len();

        let mut encoder = protocol::Encoder::with_capacity(capacity);
        encoder.write_header(protocol::TYPE_INIT, 0);
        encoder.write_uuid(&player_bytes);
        encoder.write_i64(now);
        encoder.write_u32(state_seq);
        encoder.write_u16(tick_ms);
        encoder.write_u16(total_players as u16);
        encoder.write_u16(total_players as u16);
        for player in self.players.values().take(total_players) {
            encoder.write_u16(player.net_id);
            encoder.write_uuid(&player.id_bytes);
            encoder.write_string(&player.name);
            encoder.write_string(&player.color);
            if let Some(skin) = player.skin.as_ref() {
                let len = skin.len().min(8);
                encoder.write_u8(len as u8);
                for rgb in skin.iter().take(len) {
                    encoder.write_u8(rgb[0]);
                    encoder.write_u8(rgb[1]);
                    encoder.write_u8(rgb[2]);
                }
            } else {
                encoder.write_u8(0);
            }
        }

        encoder.write_u16(visible_player_count as u16);
        for visible in visible_players.into_iter().take(visible_player_count) {
            self.write_player_state_with_window(&mut encoder, visible.player, visible.window);
        }

        self.environment.write_to(&mut encoder);

        encoder.into_vec()
    }

    fn build_state_delta_payload_for_session(
        &mut self,
        now: i64,
        state_seq: u32,
        session_id: &str,
    ) -> Option<Vec<u8>> {
        let visible_players = self.visible_players_for_session(session_id);
        let total_players = self.players.len().min(u16::MAX as usize);
        let visible_player_count = visible_players.len().min(u16::MAX as usize);

        let mut current_players: Vec<(u16, DeltaPlayerCache)> =
            Vec::with_capacity(visible_player_count);
        for visible in visible_players.into_iter().take(visible_player_count) {
            let encoded = self.encode_delta_player_cache(visible.player, visible.window);
            current_players.push((visible.player.net_id, encoded));
        }

        let session = self.sessions.get_mut(session_id)?;
        let keyframe = session.force_next_keyframe
            || state_seq % STATE_DELTA_KEYFRAME_INTERVAL == 0
            || session.delta_player_cache.is_empty();
        session.force_next_keyframe = false;

        let mut encoder =
            protocol::Encoder::with_capacity(128 + visible_player_count.saturating_mul(64));
        encoder.write_header(protocol::TYPE_STATE_DELTA, 0);
        encoder.write_i64(now);
        encoder.write_u32(state_seq);
        encoder.write_u16(total_players as u16);
        encoder.write_u16(session.latest_applied_input_seq);
        encoder.write_u8(if keyframe { DELTA_FRAME_KEYFRAME } else { 0 });
        encoder.write_u16(visible_player_count as u16);

        let mut next_cache: HashMap<u16, DeltaPlayerCache> =
            HashMap::with_capacity(visible_player_count);
        for (net_id, current) in current_players {
            let previous = if keyframe {
                None
            } else {
                session.delta_player_cache.get(&net_id)
            };

            let mut field_mask: u16 = 0;
            if previous
                .map(|prev| prev.flags != current.flags)
                .unwrap_or(true)
            {
                field_mask |= DELTA_FIELD_FLAGS;
            }
            if previous
                .map(|prev| prev.score != current.score)
                .unwrap_or(true)
            {
                field_mask |= DELTA_FIELD_SCORE;
            }
            if previous
                .map(|prev| prev.score_fraction_q != current.score_fraction_q)
                .unwrap_or(true)
            {
                field_mask |= DELTA_FIELD_SCORE_FRACTION;
            }
            if previous
                .map(|prev| prev.oxygen_q != current.oxygen_q)
                .unwrap_or(true)
            {
                field_mask |= DELTA_FIELD_OXYGEN;
            }
            if previous
                .map(|prev| prev.girth_q != current.girth_q)
                .unwrap_or(true)
            {
                field_mask |= DELTA_FIELD_GIRTH;
            }
            if previous
                .map(|prev| prev.tail_ext_q != current.tail_ext_q)
                .unwrap_or(true)
            {
                field_mask |= DELTA_FIELD_TAIL_EXT;
            }
            if previous
                .map(|prev| prev.tail_tip_oct != current.tail_tip_oct)
                .unwrap_or(true)
            {
                field_mask |= DELTA_FIELD_TAIL_TIP;
            }

            let mut snake_mode: Option<u8> = None;
            let mut shifted_head: Option<(i16, i16)> = None;
            if let Some(prev) = previous {
                if prev.snake != current.snake {
                    field_mask |= DELTA_FIELD_SNAKE;
                    if let Some(head) =
                        Self::delta_shift_head_candidate(&prev.snake, &current.snake)
                    {
                        snake_mode = Some(DELTA_SNAKE_SHIFT_HEAD);
                        shifted_head = Some(head);
                    } else {
                        snake_mode = Some(DELTA_SNAKE_REBASE);
                    }
                }
            } else {
                field_mask |= DELTA_FIELD_SNAKE;
                snake_mode = Some(DELTA_SNAKE_REBASE);
            }

            if previous
                .map(|prev| prev.digestions != current.digestions)
                .unwrap_or(true)
            {
                field_mask |= DELTA_FIELD_DIGESTIONS;
            }

            encoder.write_u16(net_id);
            encoder.write_u16(field_mask);

            if field_mask & DELTA_FIELD_FLAGS != 0 {
                encoder.write_u8(current.flags);
            }
            if field_mask & DELTA_FIELD_SCORE != 0 {
                encoder.write_var_i32(current.score);
            }
            if field_mask & DELTA_FIELD_SCORE_FRACTION != 0 {
                encoder.write_u8(current.score_fraction_q);
            }
            if field_mask & DELTA_FIELD_OXYGEN != 0 {
                encoder.write_u8(current.oxygen_q);
            }
            if field_mask & DELTA_FIELD_GIRTH != 0 {
                encoder.write_u8(current.girth_q);
            }
            if field_mask & DELTA_FIELD_TAIL_EXT != 0 {
                encoder.write_u16(current.tail_ext_q);
            }
            if field_mask & DELTA_FIELD_TAIL_TIP != 0 {
                encoder.write_i16(current.tail_tip_oct.0);
                encoder.write_i16(current.tail_tip_oct.1);
            }
            if field_mask & DELTA_FIELD_SNAKE != 0 {
                let mode = snake_mode.unwrap_or(DELTA_SNAKE_REBASE);
                encoder.write_u8(mode);
                if mode == DELTA_SNAKE_SHIFT_HEAD {
                    if let Some((ox, oy)) = shifted_head {
                        encoder.write_i16(ox);
                        encoder.write_i16(oy);
                    } else {
                        encoder.write_i16(0);
                        encoder.write_i16(0);
                    }
                } else {
                    encoder.write_u8(current.snake.detail);
                    encoder.write_u16(current.snake.total_len);
                    match current.snake.detail {
                        protocol::SNAKE_DETAIL_FULL => {
                            encoder.write_u16(current.snake.len);
                        }
                        protocol::SNAKE_DETAIL_WINDOW => {
                            encoder.write_u16(current.snake.start);
                            encoder.write_u16(current.snake.len);
                        }
                        protocol::SNAKE_DETAIL_STUB => {}
                        _ => {}
                    }
                    for (ox, oy) in &current.snake.points {
                        encoder.write_i16(*ox);
                        encoder.write_i16(*oy);
                    }
                }
            }
            if field_mask & DELTA_FIELD_DIGESTIONS != 0 {
                let digestion_len = current.digestions.len().min(u8::MAX as usize) as u8;
                encoder.write_u8(digestion_len);
                for digestion in current.digestions.iter().take(digestion_len as usize) {
                    encoder.write_u32(digestion.id);
                    encoder.write_u16(digestion.progress_q);
                    encoder.write_u8(digestion.strength_q);
                }
            }

            next_cache.insert(net_id, current);
        }

        session.delta_player_cache = next_cache;
        Some(encoder.into_vec())
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
            capacity += 2; // net id
            capacity += 16;
            capacity += 1 + Self::truncated_len(&player.name);
            capacity += 1 + Self::truncated_len(&player.color);
            capacity += 1;
            capacity += player
                .skin
                .as_ref()
                .map(|skin| skin.len().min(8) * 3)
                .unwrap_or(0);
        }

        let mut encoder = protocol::Encoder::with_capacity(capacity);
        encoder.write_header(protocol::TYPE_PLAYER_META, 0);
        encoder.write_u16(players.len() as u16);
        for player in players {
            encoder.write_u16(player.net_id);
            encoder.write_uuid(&player.id_bytes);
            encoder.write_string(&player.name);
            encoder.write_string(&player.color);
            if let Some(skin) = player.skin.as_ref() {
                let len = skin.len().min(8);
                encoder.write_u8(len as u8);
                for rgb in skin.iter().take(len) {
                    encoder.write_u8(rgb[0]);
                    encoder.write_u8(rgb[1]);
                    encoder.write_u8(rgb[2]);
                }
            } else {
                encoder.write_u8(0);
            }
        }
        Some(encoder.into_vec())
    }

    fn broadcast_player_meta(&mut self, player_ids: &[String]) {
        let Some(payload) = self.build_player_meta_payload(player_ids) else {
            return;
        };
        let mut stale = Vec::new();
        for (session_id, session) in &self.sessions {
            if session.outbound_hi.try_send(payload.clone()).is_err() {
                stale.push(session_id.clone());
            }
        }
        for session_id in stale {
            self.disconnect_session(&session_id);
        }
    }

    fn encode_delta_player_cache(&self, player: &Player, window: SnakeWindow) -> DeltaPlayerCache {
        let mut flags: u8 = 0;
        if player.alive {
            flags |= 1 << 0;
        }
        if player.is_boosting {
            flags |= 1 << 1;
        }

        let available = player.snake.len();
        let clamped_start = window.start.min(available).min(u16::MAX as usize);
        let remaining = available.saturating_sub(clamped_start);
        let clamped_len = window.len.min(remaining).min(u16::MAX as usize);
        let detail = match window.detail {
            SnakeDetail::Full => protocol::SNAKE_DETAIL_FULL,
            SnakeDetail::Window => protocol::SNAKE_DETAIL_WINDOW,
            SnakeDetail::Stub => protocol::SNAKE_DETAIL_STUB,
        };

        let mut points: Vec<(i16, i16)> = Vec::new();
        if window.detail != SnakeDetail::Stub {
            let end = clamped_start + clamped_len;
            points.reserve(end.saturating_sub(clamped_start));
            for node in player
                .snake
                .iter()
                .skip(clamped_start)
                .take(end - clamped_start)
            {
                points.push(Self::encode_unit_vec_oct_i16(Point {
                    x: node.x,
                    y: node.y,
                    z: node.z,
                }));
            }
        }

        let digestion_total = if window.include_digestions() {
            player.digestions.len()
        } else {
            0
        };
        let digestion_len = digestion_total.min(u8::MAX as usize);
        let digestion_start = digestion_total.saturating_sub(digestion_len);
        let mut digestions = Vec::with_capacity(digestion_len);
        for digestion in player
            .digestions
            .iter()
            .skip(digestion_start)
            .take(digestion_len)
        {
            digestions.push(DeltaDigestionCache {
                id: digestion.id,
                progress_q: Self::quantize_unit_u16(get_digestion_progress(digestion)),
                strength_q: Self::quantize_unit_u8(get_digestion_visual_strength(digestion) as f64),
            });
        }

        DeltaPlayerCache {
            flags,
            score: player.score.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
            score_fraction_q: Self::quantize_unit_u8(Self::player_score_fraction(player)),
            oxygen_q: Self::quantize_unit_u8(clamp(player.oxygen, 0.0, 1.0)),
            girth_q: Self::quantize_girth_scale_u8(Self::player_girth_scale_from_len(
                player.snake.len(),
            )),
            tail_ext_q: Self::quantize_unit_u16(clamp(player.tail_extension, 0.0, 1.0)),
            tail_tip_oct: compute_tail_tip_point(&player.snake, player.tail_extension)
                .map(Self::encode_unit_vec_oct_i16)
                .unwrap_or((0, 0)),
            snake: DeltaSnakeCache {
                detail,
                total_len: window.total_len.min(u16::MAX as usize) as u16,
                start: clamped_start as u16,
                len: clamped_len as u16,
                points,
            },
            digestions,
        }
    }

    fn delta_shift_head_candidate(
        previous: &DeltaSnakeCache,
        current: &DeltaSnakeCache,
    ) -> Option<(i16, i16)> {
        if previous.detail != current.detail
            || previous.total_len != current.total_len
            || previous.start != current.start
            || previous.len != current.len
        {
            return None;
        }
        let len = current.len as usize;
        if len == 0
            || previous.points.len() != len
            || current.points.len() != len
            || current.detail == protocol::SNAKE_DETAIL_STUB
        {
            return None;
        }
        for idx in 1..len {
            if current.points[idx] != previous.points[idx - 1] {
                return None;
            }
        }
        current.points.first().copied()
    }

    fn quantize_pellet_size(size: f32) -> u8 {
        let range = (PELLET_SIZE_ENCODE_MAX - PELLET_SIZE_ENCODE_MIN).max(1e-4);
        let t = ((size - PELLET_SIZE_ENCODE_MIN) / range).clamp(0.0, 1.0);
        (t * u8::MAX as f32).round() as u8
    }

    fn write_pellet(&self, encoder: &mut protocol::Encoder, pellet: &Pellet) {
        encoder.write_u32(pellet.id);
        let (ox, oy) = Self::encode_unit_vec_oct_i16(pellet.normal);
        encoder.write_i16(ox);
        encoder.write_i16(oy);
        encoder.write_u8(pellet.color_rgb[0]);
        encoder.write_u8(pellet.color_rgb[1]);
        encoder.write_u8(pellet.color_rgb[2]);
        encoder.write_u8(Self::quantize_pellet_size(pellet.current_size));
    }

    fn quantize_unit_u16(value: f64) -> u16 {
        let t = clamp(value, 0.0, 1.0);
        (t * u16::MAX as f64).round() as u16
    }

    fn quantize_unit_u8(value: f64) -> u8 {
        let t = clamp(value, 0.0, 1.0);
        (t * u8::MAX as f64).round() as u8
    }

    fn quantize_girth_scale_u8(scale: f64) -> u8 {
        // `player_girth_scale_from_len` is clamped to `[1..=SNAKE_GIRTH_MAX_SCALE]`.
        let denom = (SNAKE_GIRTH_MAX_SCALE - 1.0).max(1e-6);
        Self::quantize_unit_u8((scale - 1.0) / denom)
    }

    fn oct_sign(value: f64) -> f64 {
        if value >= 0.0 {
            1.0
        } else {
            -1.0
        }
    }

    fn oct_quantize(value: f64) -> i16 {
        let t = clamp(value, -1.0, 1.0);
        let scaled = (t * i16::MAX as f64).round() as i32;
        let clamped = scaled.clamp(-(i16::MAX as i32), i16::MAX as i32);
        clamped as i16
    }

    fn encode_unit_vec_oct_i16(point: Point) -> (i16, i16) {
        let normalized = normalize(point);
        if !normalized.x.is_finite() || !normalized.y.is_finite() || !normalized.z.is_finite() {
            return (0, 0);
        }
        let l1 = normalized.x.abs() + normalized.y.abs() + normalized.z.abs();
        if !(l1 > 1e-9) {
            return (0, 0);
        }
        let mut x = normalized.x / l1;
        let mut y = normalized.y / l1;
        let z = normalized.z / l1;
        if z < 0.0 {
            let ox = (1.0 - y.abs()) * Self::oct_sign(x);
            let oy = (1.0 - x.abs()) * Self::oct_sign(y);
            x = ox;
            y = oy;
        }
        (Self::oct_quantize(x), Self::oct_quantize(y))
    }

    fn write_player_state_with_window(
        &self,
        encoder: &mut protocol::Encoder,
        player: &Player,
        window: SnakeWindow,
    ) {
        encoder.write_u16(player.net_id);
        let mut flags: u8 = 0;
        if player.alive {
            flags |= 1 << 0;
        }
        if player.is_boosting {
            flags |= 1 << 1;
        }
        encoder.write_u8(flags);
        encoder.write_i32(player.score as i32);
        encoder.write_u16(Self::quantize_unit_u16(Self::player_score_fraction(player)));
        encoder.write_u16(Self::quantize_unit_u16(clamp(player.oxygen, 0.0, 1.0)));
        let girth_scale = Self::player_girth_scale_from_len(player.snake.len());
        encoder.write_u8(Self::quantize_girth_scale_u8(girth_scale));
        encoder.write_u16(Self::quantize_unit_u16(clamp(
            player.tail_extension,
            0.0,
            1.0,
        )));
        let tail_tip_oct = compute_tail_tip_point(&player.snake, player.tail_extension)
            .map(Self::encode_unit_vec_oct_i16)
            .unwrap_or((0, 0));
        encoder.write_i16(tail_tip_oct.0);
        encoder.write_i16(tail_tip_oct.1);
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
                let (ox, oy) = Self::encode_unit_vec_oct_i16(Point {
                    x: node.x,
                    y: node.y,
                    z: node.z,
                });
                encoder.write_i16(ox);
                encoder.write_i16(oy);
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
            encoder.write_f32(get_digestion_visual_strength(digestion));
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

    fn broadcast_state_delta(&mut self, now: i64, state_seq: u32) {
        let session_ids: Vec<String> = self.sessions.keys().cloned().collect();
        for session_id in session_ids {
            let Some(payload) =
                self.build_state_delta_payload_for_session(now, state_seq, &session_id)
            else {
                continue;
            };
            if let Some(session) = self.sessions.get(&session_id) {
                session.outbound_state.store(payload);
            }
        }
    }

    fn pellet_needs_update(pellet: &Pellet) -> bool {
        match pellet.state {
            // Keep evasive pellet movement authoritative. Intake-locked pellets can be
            // animated client-side at consume time to save bandwidth.
            PelletState::Evasive { .. } => true,
            _ => false,
        }
    }

    fn build_pellet_reset_payload_for_indices(
        &self,
        now: i64,
        state_seq: u32,
        indices: &[usize],
    ) -> Vec<u8> {
        let pellet_count = indices.len().min(u16::MAX as usize);
        let capacity = 4 + 8 + 4 + 2 + pellet_count * 12;
        let mut encoder = protocol::Encoder::with_capacity(capacity);
        encoder.write_header(protocol::TYPE_PELLET_RESET, 0);
        encoder.write_i64(now);
        encoder.write_u32(state_seq);
        encoder.write_u16(pellet_count as u16);
        for index in indices.iter().take(pellet_count) {
            if let Some(pellet) = self.pellets.get(*index) {
                self.write_pellet(&mut encoder, pellet);
            }
        }
        encoder.into_vec()
    }

    fn build_pellet_delta_payload(
        &self,
        now: i64,
        state_seq: u32,
        adds: &[usize],
        updates: &[usize],
        removes: &[u32],
    ) -> Vec<u8> {
        let add_count = adds.len().min(u16::MAX as usize);
        let update_count = updates.len().min(u16::MAX as usize);
        let remove_count = removes.len().min(u16::MAX as usize);
        let capacity =
            4 + 8 + 4 + 2 + add_count * 12 + 2 + update_count * 12 + 2 + remove_count * 4;
        let mut encoder = protocol::Encoder::with_capacity(capacity);
        encoder.write_header(protocol::TYPE_PELLET_DELTA, 0);
        encoder.write_i64(now);
        encoder.write_u32(state_seq);
        encoder.write_u16(add_count as u16);
        for index in adds.iter().take(add_count) {
            if let Some(pellet) = self.pellets.get(*index) {
                self.write_pellet(&mut encoder, pellet);
            }
        }
        encoder.write_u16(update_count as u16);
        for index in updates.iter().take(update_count) {
            if let Some(pellet) = self.pellets.get(*index) {
                self.write_pellet(&mut encoder, pellet);
            }
        }
        encoder.write_u16(remove_count as u16);
        for id in removes.iter().take(remove_count) {
            encoder.write_u32(*id);
        }
        encoder.into_vec()
    }

    fn build_pellet_consume_payload(
        &self,
        now: i64,
        state_seq: u32,
        consumes: &[(u32, u16)],
    ) -> Vec<u8> {
        let consume_count = consumes.len().min(u16::MAX as usize);
        let capacity = 4 + 8 + 4 + 2 + consume_count * 6;
        let mut encoder = protocol::Encoder::with_capacity(capacity);
        encoder.write_header(protocol::TYPE_PELLET_CONSUME, 0);
        encoder.write_i64(now);
        encoder.write_u32(state_seq);
        encoder.write_u16(consume_count as u16);
        for (pellet_id, target_net_id) in consumes.iter().take(consume_count) {
            encoder.write_u32(*pellet_id);
            encoder.write_u16(*target_net_id);
        }
        encoder.into_vec()
    }

    fn broadcast_pellet_consumes(&mut self, now: i64, state_seq: u32) {
        if self.pending_pellet_consumes.is_empty() {
            return;
        }
        let pending = std::mem::take(&mut self.pending_pellet_consumes);
        let resolved_consumes: Vec<(u32, u16)> = pending
            .into_iter()
            .filter_map(|(pellet_id, target_player_id)| {
                self.players
                    .get(&target_player_id)
                    .map(|player| (pellet_id, player.net_id))
            })
            .collect();
        if resolved_consumes.is_empty() {
            return;
        }

        let session_ids: Vec<String> = self.sessions.keys().cloned().collect();
        let mut stale = Vec::new();
        for session_id in session_ids {
            let Some(session) = self.sessions.get(&session_id) else {
                continue;
            };
            if !session.pellet_view_initialized {
                continue;
            }
            let session_consumes: Vec<(u32, u16)> = resolved_consumes
                .iter()
                .filter(|(pellet_id, _)| session.pellet_view_ids.contains(pellet_id))
                .copied()
                .collect();
            if session_consumes.is_empty() {
                continue;
            }
            let payload = self.build_pellet_consume_payload(now, state_seq, &session_consumes);
            if let Some(session) = self.sessions.get_mut(&session_id) {
                match session.outbound_hi.try_send(payload) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        // Consume hints are visual-only; if a client is stalled, skip this hint.
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        stale.push(session_id);
                    }
                }
            }
        }

        for session_id in stale {
            self.disconnect_session(&session_id);
        }
    }

    fn maybe_send_pellet_reset_for_session(&mut self, session_id: &str) {
        let Some((initialized, retry_at)) = self.sessions.get(session_id).map(|session| {
            (
                session.pellet_view_initialized,
                session.pellet_reset_retry_at,
            )
        }) else {
            return;
        };
        if initialized {
            return;
        }
        let now = Self::now_millis();
        if now < retry_at {
            return;
        }

        let Some((view_center, view_cos, max_visible)) = self.pellet_view_params(session_id) else {
            return;
        };
        let indices = self.visible_pellet_indices(view_center, view_cos, max_visible);
        let state_seq = self.next_state_seq.wrapping_sub(1);
        let payload = self.build_pellet_reset_payload_for_indices(now, state_seq, &indices);

        if let Some(session) = self.sessions.get_mut(session_id) {
            match session.outbound_hi.try_send(payload) {
                Ok(()) => {
                    session.pellet_view_initialized = true;
                    session.pellet_reset_retry_at = 0;
                    session.pellet_view_ids.clear();
                    for index in &indices {
                        if let Some(pellet) = self.pellets.get(*index) {
                            session.pellet_view_ids.insert(pellet.id);
                        }
                    }
                }
                Err(mpsc::error::TrySendError::Full(_)) => {
                    // The client is not keeping up; retry later without building unbounded backlog.
                    session.pellet_reset_retry_at = now + PELLET_RESET_RETRY_MS;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    self.disconnect_session(session_id);
                }
            }
        }
    }

    fn broadcast_pellet_delta(&mut self, now: i64, state_seq: u32) {
        let session_ids: Vec<String> = self.sessions.keys().cloned().collect();
        let mut stale = Vec::new();

        for session_id in session_ids {
            if !self
                .sessions
                .get(&session_id)
                .map(|session| session.pellet_view_initialized)
                .unwrap_or(false)
            {
                continue;
            }

            let Some((view_center, view_cos, max_visible)) = self.pellet_view_params(&session_id)
            else {
                continue;
            };
            let indices = self.visible_pellet_indices(view_center, view_cos, max_visible);

            let mut next_ids: HashSet<u32> = HashSet::with_capacity(indices.len());
            let mut adds: Vec<usize> = Vec::new();
            let mut updates: Vec<usize> = Vec::new();
            if let Some(session) = self.sessions.get(&session_id) {
                for index in &indices {
                    if let Some(pellet) = self.pellets.get(*index) {
                        next_ids.insert(pellet.id);
                        if !session.pellet_view_ids.contains(&pellet.id) {
                            adds.push(*index);
                        } else if Self::pellet_needs_update(pellet) {
                            updates.push(*index);
                        }
                    }
                }
            }

            let removes: Vec<u32> = self
                .sessions
                .get(&session_id)
                .map(|session| {
                    session
                        .pellet_view_ids
                        .iter()
                        .filter(|id| !next_ids.contains(id))
                        .copied()
                        .collect::<Vec<u32>>()
                })
                .unwrap_or_default();

            // Skip sending empty delta frames to reduce bandwidth (no visible-set changes and no
            // active pellet states that require updates).
            if adds.is_empty() && updates.is_empty() && removes.is_empty() {
                continue;
            }

            let payload =
                self.build_pellet_delta_payload(now, state_seq, &adds, &updates, &removes);

            if let Some(session) = self.sessions.get_mut(&session_id) {
                match session.outbound_lo.try_send(payload) {
                    Ok(()) => {
                        session.pellet_view_ids = next_ids;
                    }
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        // If a client can't keep up with deltas, force a reset once it catches up
                        // so pellet visuals stay correct without growing unbounded backlog.
                        session.pellet_view_initialized = false;
                        session.pellet_view_ids.clear();
                        session.pellet_reset_retry_at = now;
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        stale.push(session_id);
                    }
                }
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
