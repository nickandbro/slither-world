import { clamp, cross, dot, normalize } from '../math'
import type { Point } from '../types'
import type { PredictionCommand } from './types'

const WORLD_SCALE = 3
const NODE_ANGLE = Math.PI / 60 / WORLD_SCALE
const NODE_QUEUE_SIZE = 9
const MOVE_SPEED_MULTIPLIER = 1.75
const BASE_SPEED = ((NODE_ANGLE * 2) / (NODE_QUEUE_SIZE + 1)) * MOVE_SPEED_MULTIPLIER
const BOOST_MULTIPLIER = 2.16
const TURN_RATE = 0.13
const STARTING_LENGTH = 8
const TURN_SCANG_BASE = 0.13
const TURN_SCANG_RANGE = 0.87
const TURN_SC_LENGTH_DIVISOR = 106
const TURN_SC_MAX = 6
const TURN_SPEED_BOOST_TURN_PENALTY = 1.25
const TURN_SPEED_MIN_MULTIPLIER = 0.2
const TURN_RESPONSE_GAIN_NORMAL_PER_SEC = 9.5
const TURN_RESPONSE_GAIN_BOOST_PER_SEC = 3.2
const TURN_RATE_MIN_MULTIPLIER = 0.22
const TURN_RATE_MAX_MULTIPLIER = 1.35
const TICK_MS = 50
const REPLAY_MAX_TICKS = 4
const REPLAY_SUBSTEP_TARGET_MS = 8
const REPLAY_MAX_SUBSTEPS = 24

export type ReplayPredictionOptions = {
  snake: Point[]
  baseReceivedAtMs: number
  nowMs: number
  pendingCommands: PredictionCommand[]
  fallbackAxis: Point | null
  boostAllowed: boolean
}

export type ReplayPredictionResult = {
  snake: Point[]
  axis: Point
  replayedCommandCount: number
}

export function cloneSnake(snake: Point[]): Point[] {
  return snake.map((node) => normalize({ ...node }))
}

export function angleBetweenDeg(a: Point | null, b: Point | null): number {
  if (!a || !b) return 0
  const an = normalize(a)
  const bn = normalize(b)
  const d = clamp(dot(an, bn), -1, 1)
  const radians = Math.acos(d)
  return Number.isFinite(radians) ? radians * (180 / Math.PI) : 0
}

export function deriveLocalAxis(snake: Point[], fallbackAxis: Point | null): Point {
  if (snake.length >= 2) {
    const head = normalize(snake[0]!)
    const neck = normalize(snake[1]!)
    const raw = {
      x: head.x - neck.x,
      y: head.y - neck.y,
      z: head.z - neck.z,
    }
    const radial = dot(raw, head)
    const tangent = normalize({
      x: raw.x - head.x * radial,
      y: raw.y - head.y * radial,
      z: raw.z - head.z * radial,
    })
    const derived = normalize(cross(head, tangent))
    if (Number.isFinite(derived.x) && Number.isFinite(derived.y) && Number.isFinite(derived.z)) {
      const mag = Math.hypot(derived.x, derived.y, derived.z)
      if (mag > 1e-6) return derived
    }
  }

  if (fallbackAxis) {
    const normalized = normalize(fallbackAxis)
    const mag = Math.hypot(normalized.x, normalized.y, normalized.z)
    if (mag > 1e-6) return normalized
  }

  const head = snake.length > 0 ? normalize(snake[0]!) : { x: 0, y: 0, z: 1 }
  const worldUp = Math.abs(head.y) > 0.95 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
  return normalize(cross(head, worldUp))
}

function rotateAroundAxis(point: Point, axis: Point, angle: number): Point {
  const u = normalize(axis)
  const cosA = Math.cos(angle)
  const sinA = Math.sin(angle)
  const dotProd = u.x * point.x + u.y * point.y + u.z * point.z
  return normalize({
    x:
      point.x * cosA +
      (u.y * point.z - u.z * point.y) * sinA +
      u.x * dotProd * (1 - cosA),
    y:
      point.y * cosA +
      (u.z * point.x - u.x * point.z) * sinA +
      u.y * dotProd * (1 - cosA),
    z:
      point.z * cosA +
      (u.x * point.y - u.y * point.x) * sinA +
      u.z * dotProd * (1 - cosA),
  })
}

function rotateToward(current: Point, target: Point, maxAngle: number): Point {
  const currentNorm = normalize(current)
  const targetNorm = normalize(target)
  const d = clamp(dot(currentNorm, targetNorm), -1, 1)
  const angle = Math.acos(d)
  if (!Number.isFinite(angle) || angle <= maxAngle) return targetNorm
  if (angle <= 0) return currentNorm

  const axis = normalize(cross(currentNorm, targetNorm))
  const mag = Math.hypot(axis.x, axis.y, axis.z)
  if (mag <= 1e-6) return currentNorm
  return rotateAroundAxis(currentNorm, axis, maxAngle)
}

function slitherScangForLen(snakeLen: number): number {
  const clampedLen = Math.max(2, snakeLen)
  const sc = Math.min(TURN_SC_MAX, 1 + (clampedLen - 2) / TURN_SC_LENGTH_DIVISOR)
  const lengthRatio = Math.max(0, (7 - sc) / 6)
  return TURN_SCANG_BASE + TURN_SCANG_RANGE * lengthRatio * lengthRatio
}

function slitherSpangForSpeed(speedFactor: number): number {
  const safeSpeedFactor = Number.isFinite(speedFactor) ? Math.max(0, speedFactor) : 0
  const boostExcess = Math.max(0, safeSpeedFactor - 1)
  const penalty = 1 + Math.max(0, TURN_SPEED_BOOST_TURN_PENALTY) * boostExcess
  const damped = 1 / Math.max(1e-6, penalty)
  return clamp(damped, TURN_SPEED_MIN_MULTIPLIER, 1)
}

function resolveTurnRate(snakeLen: number, speedFactor: number): number {
  const scang = slitherScangForLen(snakeLen)
  const spang = slitherSpangForSpeed(speedFactor)
  const baselineScang = slitherScangForLen(STARTING_LENGTH)
  const baselineSpang = slitherSpangForSpeed(1)
  const baseline = Math.max(1e-6, baselineScang * baselineSpang)
  const normalized = (scang * spang) / baseline
  const rawTurnRate = TURN_RATE * normalized
  return clamp(
    rawTurnRate,
    TURN_RATE * TURN_RATE_MIN_MULTIPLIER,
    TURN_RATE * TURN_RATE_MAX_MULTIPLIER,
  )
}

function steeringGainForSpeed(speedFactor: number): number {
  const safeSpeedFactor = Number.isFinite(speedFactor) ? Math.max(0, speedFactor) : 0
  const boostWindow = Math.max(1e-6, BOOST_MULTIPLIER - 1)
  const blend = clamp((safeSpeedFactor - 1) / boostWindow, 0, 1)
  return (
    TURN_RESPONSE_GAIN_NORMAL_PER_SEC +
    (TURN_RESPONSE_GAIN_BOOST_PER_SEC - TURN_RESPONSE_GAIN_NORMAL_PER_SEC) * blend
  )
}

function resolveTurnStep(
  currentAxis: Point,
  targetAxis: Point,
  snakeLen: number,
  speedFactor: number,
  stepMs: number,
): number {
  const turnCap = Math.max(0, resolveTurnRate(snakeLen, speedFactor) * (stepMs / TICK_MS))
  if (turnCap <= 0) return 0
  const current = normalize(currentAxis)
  const target = normalize(targetAxis)
  const angleError = Math.acos(clamp(dot(current, target), -1, 1))
  if (!Number.isFinite(angleError)) return turnCap
  const dtSec = Math.max(0, stepMs) / 1000
  const proportionalStep = angleError * Math.max(0, steeringGainForSpeed(speedFactor)) * dtSec
  return clamp(proportionalStep, 0, turnCap)
}

function applySnakeRotationStep(snake: Point[], axis: Point, velocity: number): Point[] {
  return snake.map((node) => rotateAroundAxis(node, axis, velocity))
}

export function replayPredictedSnake(options: ReplayPredictionOptions): ReplayPredictionResult {
  const {
    snake,
    baseReceivedAtMs,
    nowMs,
    pendingCommands,
    fallbackAxis,
    boostAllowed,
  } = options
  const outputSnake = cloneSnake(snake)
  if (outputSnake.length === 0) {
    return {
      snake: outputSnake,
      axis: fallbackAxis ? normalize(fallbackAxis) : { x: 0, y: 1, z: 0 },
      replayedCommandCount: 0,
    }
  }

  const startMs = Number.isFinite(baseReceivedAtMs) ? baseReceivedAtMs : nowMs
  const cappedNowMs = Math.max(startMs, nowMs)
  let durationMs = Math.max(0, cappedNowMs - startMs)
  if (durationMs <= 0.25) {
    return {
      snake: outputSnake,
      axis: deriveLocalAxis(outputSnake, fallbackAxis),
      replayedCommandCount: 0,
    }
  }

  const sortedCommands = pendingCommands
    .slice()
    .sort((a, b) => a.sentAtMs - b.sentAtMs)
    .filter((command) => Number.isFinite(command.sentAtMs))

  let axis = deriveLocalAxis(outputSnake, fallbackAxis)
  let replayedCommandCount = 0
  let activeAxis: Point | null = null
  let activeBoost = false
  let commandIndex = 0

  const consumeCommandsUntil = (timeMs: number) => {
    while (commandIndex < sortedCommands.length && sortedCommands[commandIndex]!.sentAtMs <= timeMs) {
      activeAxis = sortedCommands[commandIndex]!.axis
      activeBoost = sortedCommands[commandIndex]!.boost
      commandIndex += 1
      replayedCommandCount += 1
    }
  }
  consumeCommandsUntil(startMs)

  const maxReplayMs = TICK_MS * REPLAY_MAX_TICKS
  durationMs = Math.min(durationMs, maxReplayMs)
  const substepCount = clamp(
    Math.ceil(durationMs / REPLAY_SUBSTEP_TARGET_MS),
    1,
    REPLAY_MAX_SUBSTEPS,
  )
  const stepMs = durationMs / substepCount
  const speedPerStep = BASE_SPEED * (stepMs / TICK_MS)

  for (let step = 0; step < substepCount; step += 1) {
    const stepEndMs = startMs + (step + 1) * stepMs
    consumeCommandsUntil(stepEndMs)

    const targetAxis = activeAxis ? normalize(activeAxis) : axis
    const speedFactor = activeBoost && boostAllowed ? BOOST_MULTIPLIER : 1
    const turnPerStep = resolveTurnStep(axis, targetAxis, outputSnake.length, speedFactor, stepMs)
    axis = rotateToward(axis, targetAxis, Math.max(0, turnPerStep))
    const velocity = speedPerStep * speedFactor
    const nextSnake = applySnakeRotationStep(outputSnake, axis, velocity)
    outputSnake.splice(0, outputSnake.length, ...nextSnake)
  }

  return {
    snake: outputSnake,
    axis,
    replayedCommandCount,
  }
}
