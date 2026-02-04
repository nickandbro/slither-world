export const NODE_ANGLE = Math.PI / 60
export const NODE_QUEUE_SIZE = 9
export const STARTING_LENGTH = 8
export const BASE_SPEED = (NODE_ANGLE * 2) / (NODE_QUEUE_SIZE + 1)
export const BOOST_MULTIPLIER = 1.75
export const STAMINA_MAX = 1
export const STAMINA_DRAIN_PER_SEC = 0.6
export const STAMINA_RECHARGE_PER_SEC = 0.35
export const DIGESTION_TRAVEL_SPEED_MULT = 3
export const TURN_RATE = 0.08
export const COLLISION_DISTANCE = 2 * Math.sin(NODE_ANGLE)
export const BASE_PELLET_COUNT = 3
export const MAX_PELLETS = 12
export const TICK_MS = 50
export const RESPAWN_COOLDOWN_MS = 0
export const PLAYER_TIMEOUT_MS = 15000
export const SPAWN_CONE_ANGLE = Math.PI / 3
export const DIGESTION_GROWTH_STEPS = NODE_QUEUE_SIZE

export const COLOR_POOL = [
  '#ff6b6b',
  '#ffd166',
  '#06d6a0',
  '#4dabf7',
  '#f06595',
  '#845ef7',
  '#20c997',
  '#fcc419',
]
