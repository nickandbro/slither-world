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
pub const DIGESTION_TRAVEL_SPEED_MULT: f64 = 3.0;
pub const TURN_RATE: f64 = 0.3 / WORLD_SCALE;
pub const COLLISION_DISTANCE: f64 = 0.10467191248588766 / WORLD_SCALE;
pub const BASE_PELLET_COUNT: usize = 3;
pub const MAX_PELLETS: usize = 12;
pub const TICK_MS: u64 = 50;
pub const RESPAWN_COOLDOWN_MS: i64 = 5000;
pub const RESPAWN_RETRY_MS: i64 = 500;
pub const PLAYER_TIMEOUT_MS: i64 = 15000;
pub const SPAWN_CONE_ANGLE: f64 = std::f64::consts::PI / 3.0;
pub const MAX_SPAWN_ATTEMPTS: usize = 32;
pub const DIGESTION_GROWTH_STEPS: i64 = NODE_QUEUE_SIZE as i64;
pub const BOT_COUNT: usize = 2;
pub const BOT_BOOST_DISTANCE: f64 = 0.6 / WORLD_SCALE;
pub const BOT_MIN_STAMINA_TO_BOOST: f64 = 0.6;

pub const COLOR_POOL: [&str; 8] = [
  "#ff6b6b",
  "#ffd166",
  "#06d6a0",
  "#4dabf7",
  "#f06595",
  "#845ef7",
  "#20c997",
  "#fcc419",
];
