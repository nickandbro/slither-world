import { clamp } from '@game/math'

// Keep in sync with backend movement/collision constants.
export const WORLD_SCALE = 3
export const PLANET_RADIUS = 3
export const NODE_ANGLE = Math.PI / 60 / WORLD_SCALE
export const NODE_QUEUE_SIZE = 9
export const MOVE_SPEED_MULTIPLIER = 1.75
export const BASE_SPEED = ((NODE_ANGLE * 2) / (NODE_QUEUE_SIZE + 1)) * MOVE_SPEED_MULTIPLIER
export const BOOST_MULTIPLIER = 2.16
export const TURN_RATE = 0.13
export const STARTING_LENGTH = 8
export const TURN_SCANG_BASE = 0.13
export const TURN_SCANG_RANGE = 0.87
export const TURN_SC_LENGTH_DIVISOR = 106
export const TURN_SC_MAX = 6
export const TURN_SPEED_BOOST_TURN_PENALTY = 0.55
export const TURN_SPEED_MIN_MULTIPLIER = 0.2
export const TURN_BOOST_TURN_RATE_MULTIPLIER = 4
export const TURN_RESPONSE_GAIN_NORMAL_PER_SEC = 9.5
export const TURN_RESPONSE_GAIN_BOOST_PER_SEC = 5.8
export const TURN_RATE_MIN_MULTIPLIER = 0.22
export const TURN_RATE_MAX_MULTIPLIER = 4
export const TICK_MS = 50
export const SNAKE_RADIUS = 0.045
export const TREE_TRUNK_RADIUS = 0.036
export const CONTACT_ITERATIONS = 4
export const STICK_THRESHOLD = 0.01

export function snakeContactAngularRadiusForScale(girthScale: number): number {
  return (SNAKE_RADIUS / PLANET_RADIUS) * Math.max(0, girthScale)
}

export function slitherScangForLen(snakeLen: number): number {
  const clampedLen = Math.max(2, snakeLen)
  const sc = Math.min(TURN_SC_MAX, 1 + (clampedLen - 2) / TURN_SC_LENGTH_DIVISOR)
  const lengthRatio = Math.max(0, (7 - sc) / 6)
  return TURN_SCANG_BASE + TURN_SCANG_RANGE * lengthRatio * lengthRatio
}

export function slitherSpangForSpeed(speedFactor: number): number {
  const safeSpeedFactor = Number.isFinite(speedFactor) ? Math.max(0, speedFactor) : 0
  const boostExcess = Math.max(0, safeSpeedFactor - 1)
  const penalty = 1 + Math.max(0, TURN_SPEED_BOOST_TURN_PENALTY) * boostExcess
  const damped = 1 / Math.max(1e-6, penalty)
  return clamp(damped, TURN_SPEED_MIN_MULTIPLIER, 1)
}

export function turnRateFor(snakeLen: number, speedFactor: number): number {
  const safeSpeedFactor = Number.isFinite(speedFactor) ? Math.max(0, speedFactor) : 0
  const scang = slitherScangForLen(snakeLen)
  const spang = slitherSpangForSpeed(safeSpeedFactor)
  const baselineScang = slitherScangForLen(STARTING_LENGTH)
  const baselineSpang = slitherSpangForSpeed(1)
  const baseline = Math.max(1e-6, baselineScang * baselineSpang)
  const boostWindow = Math.max(1e-6, BOOST_MULTIPLIER - 1)
  const boostBlend = clamp((safeSpeedFactor - 1) / boostWindow, 0, 1)
  const boostTurnMult = 1 + Math.max(0, TURN_BOOST_TURN_RATE_MULTIPLIER - 1) * boostBlend
  const normalized = (scang * spang) / baseline
  const rawTurnRate = TURN_RATE * normalized * boostTurnMult
  return clamp(
    rawTurnRate,
    TURN_RATE * TURN_RATE_MIN_MULTIPLIER,
    TURN_RATE * TURN_RATE_MAX_MULTIPLIER,
  )
}

export function steeringGainForSpeed(speedFactor: number): number {
  const safeSpeedFactor = Number.isFinite(speedFactor) ? Math.max(0, speedFactor) : 0
  const boostWindow = Math.max(1e-6, BOOST_MULTIPLIER - 1)
  const blend = clamp((safeSpeedFactor - 1) / boostWindow, 0, 1)
  return (
    TURN_RESPONSE_GAIN_NORMAL_PER_SEC +
    (TURN_RESPONSE_GAIN_BOOST_PER_SEC - TURN_RESPONSE_GAIN_NORMAL_PER_SEC) * blend
  )
}
