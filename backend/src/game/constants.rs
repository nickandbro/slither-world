pub const WORLD_SCALE: f64 = 3.0;
pub const NODE_ANGLE: f64 = std::f64::consts::PI / 60.0 / WORLD_SCALE;
pub const NODE_QUEUE_SIZE: usize = 9;
pub const STARTING_LENGTH: usize = 8;
pub const BASE_SPEED: f64 = (NODE_ANGLE * 2.0) / ((NODE_QUEUE_SIZE + 1) as f64);
pub const BOOST_MULTIPLIER: f64 = 1.75;
pub const STAMINA_MAX: f64 = 1.0;
pub const STAMINA_DRAIN_PER_SEC: f64 = 0.6;
pub const STAMINA_RECHARGE_PER_SEC: f64 = 0.35;
pub const OXYGEN_MAX: f64 = 1.0;
pub const OXYGEN_DRAIN_PER_SEC: f64 = 0.1;
pub const MIN_SURVIVAL_LENGTH: usize = 3;
pub const DIGESTION_TRAVEL_SPEED_MULT: f64 = 3.0;
pub const TURN_RATE: f64 = 0.3 / WORLD_SCALE;
pub const COLLISION_DISTANCE: f64 = 0.10467191248588766 / WORLD_SCALE;
#[cfg(not(test))]
pub const BASE_PELLET_COUNT: usize = 2400;
#[cfg(test)]
pub const BASE_PELLET_COUNT: usize = 3;
pub const MAX_PELLETS: usize = u16::MAX as usize;
pub const SMALL_PELLET_GROWTH_FRACTION: f64 = 0.125;
pub const SMALL_PELLET_DIGESTION_STRENGTH: f32 = 0.28;
pub const SMALL_PELLET_DIGESTION_STRENGTH_MAX: f32 = 1.0;
pub const SMALL_PELLET_RING_BATCH_SIZE_CAP: usize = 5;
pub const SMALL_PELLET_SIZE_MIN: f32 = 0.55;
pub const SMALL_PELLET_SIZE_MAX: f32 = 0.95;
pub const DEATH_PELLET_SIZE_MIN: f32 = 1.2;
pub const DEATH_PELLET_SIZE_MAX: f32 = 1.75;
pub const PELLET_SIZE_ENCODE_MIN: f32 = SMALL_PELLET_SIZE_MIN;
pub const PELLET_SIZE_ENCODE_MAX: f32 = DEATH_PELLET_SIZE_MAX;
pub const SMALL_PELLET_SHRINK_MIN_RATIO: f32 = 0.24;
pub const SMALL_PELLET_ATTRACT_RADIUS: f64 = 0.16;
pub const SMALL_PELLET_LOCK_CONE_ANGLE: f64 = std::f64::consts::PI * 0.30;
pub const SMALL_PELLET_CONSUME_ANGLE: f64 = 0.0034;
pub const SMALL_PELLET_ATTRACT_SPEED: f64 = 3.2;
pub const SMALL_PELLET_MOUTH_FORWARD: f64 = 0.0;
pub const SMALL_PELLET_SPAWN_HEAD_EXCLUSION_ANGLE: f64 = 0.08;
pub const SMALL_PELLET_ZOOM_MIN_CAMERA_DISTANCE: f64 = 4.0;
pub const SMALL_PELLET_ZOOM_MAX_CAMERA_DISTANCE: f64 = 10.0;
pub const SMALL_PELLET_VISIBLE_MIN: usize = 520;
pub const SMALL_PELLET_VISIBLE_MAX: usize = 2200;
pub const SMALL_PELLET_VIEW_MARGIN_MIN: f64 = 0.06;
pub const SMALL_PELLET_VIEW_MARGIN_MAX: f64 = 0.2;
pub const TICK_MS: u64 = 50;
pub const RESPAWN_COOLDOWN_MS: i64 = 5000;
pub const RESPAWN_RETRY_MS: i64 = 500;
pub const PLAYER_TIMEOUT_MS: i64 = 15000;
pub const SPAWN_CONE_ANGLE: f64 = std::f64::consts::PI / 3.0;
pub const MAX_SPAWN_ATTEMPTS: usize = 32;
pub const SPAWN_PLAYER_MIN_DISTANCE: f64 = COLLISION_DISTANCE * 2.0;
pub const DIGESTION_GROWTH_STEPS: i64 = NODE_QUEUE_SIZE as i64;
pub const BOT_COUNT: usize = 5;
pub const BOT_BOOST_DISTANCE: f64 = 0.6 / WORLD_SCALE;
pub const BOT_MIN_STAMINA_TO_BOOST: f64 = 0.6;

pub const COLOR_POOL: [&str; 8] = [
    "#ff6b6b", "#ffd166", "#06d6a0", "#4dabf7", "#f06595", "#845ef7", "#20c997", "#fcc419",
];
