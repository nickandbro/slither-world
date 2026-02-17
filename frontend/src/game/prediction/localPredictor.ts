import { clamp, cross, dot, normalize } from '../math'
import type { Environment, Point } from '../types'
import type { PredictionCommand } from './types'
import {
  BASE_SPEED,
  BOOST_MULTIPLIER,
  TICK_MS,
  steeringGainForSpeed,
  TURN_SUBSTEPS_BOOST,
  TURN_SUBSTEPS_NORMAL,
  turnRateFor,
} from './parity/constants'
import { applySnakeWithCollisions } from './parity/collision'
import {
  createSnakeParityStateFromPoints,
  pointsFromSnakeParityState,
  rebaseSnakeParityState,
  rotateAroundAxis,
  type SnakeParityState,
} from './parity/snake'

const REPLAY_MAX_TICKS = 4

type CoalescedTickInput = {
  axis: Point | null
  boost: boolean
  sourceCount: number
}

export type ReplayPredictionOptions = {
  snake: Point[]
  baseReceivedAtMs: number
  nowMs: number
  pendingCommands: PredictionCommand[]
  fallbackAxis: Point | null
  boostAllowed: boolean
  snakeAngularRadius: number
  environment: Environment | null
  previousParityState: SnakeParityState | null
}

export type ReplayPredictionResult = {
  snake: Point[]
  axis: Point
  parityState: SnakeParityState
  replayedCommandCount: number
  replayedTickCount: number
  commandsDroppedByCoalescing: number
  commandsCoalescedPerTickP95: number
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

function steeringTurnStep(
  currentAxis: Point,
  targetAxis: Point,
  turnCap: number,
  steeringGainPerSec: number,
  dtSeconds: number,
): number {
  const cappedTurn = Math.max(0, turnCap)
  if (cappedTurn <= 0) return 0
  const current = normalize(currentAxis)
  const target = normalize(targetAxis)
  const angleError = Math.acos(clamp(dot(current, target), -1, 1))
  if (!Number.isFinite(angleError)) return cappedTurn
  const proportionalStep = angleError * Math.max(0, steeringGainPerSec) * Math.max(0, dtSeconds)
  return clamp(proportionalStep, 0, cappedTurn)
}

function computeP95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1))
  return sorted[index] ?? 0
}

function coalesceCommandsByTick(
  sortedCommands: PredictionCommand[],
  startMs: number,
  durationMs: number,
): {
  tickInputs: CoalescedTickInput[]
  droppedByCoalescing: number
  replayedCommandCount: number
  coalescedPerTickP95: number
} {
  const tickCount = Math.max(1, Math.ceil(durationMs / TICK_MS))
  const tickInputs: CoalescedTickInput[] = new Array(tickCount)
  const consumedPerTick: number[] = []
  let droppedByCoalescing = 0
  let replayedCommandCount = 0

  let commandIndex = 0
  let activeAxis: Point | null = null
  let activeBoost = false

  while (
    commandIndex < sortedCommands.length &&
    Number.isFinite(sortedCommands[commandIndex]?.sentAtMs) &&
    (sortedCommands[commandIndex]?.sentAtMs ?? 0) <= startMs
  ) {
    const command = sortedCommands[commandIndex]
    if (!command) break
    activeAxis = command.axis
    activeBoost = command.boost
    commandIndex += 1
  }

  for (let tickIndex = 0; tickIndex < tickCount; tickIndex += 1) {
    const tickEndMs = startMs + Math.min(durationMs, (tickIndex + 1) * TICK_MS)
    let latestInWindow: PredictionCommand | null = null
    let consumedInWindow = 0
    while (
      commandIndex < sortedCommands.length &&
      Number.isFinite(sortedCommands[commandIndex]?.sentAtMs) &&
      (sortedCommands[commandIndex]?.sentAtMs ?? Number.POSITIVE_INFINITY) <= tickEndMs
    ) {
      const command = sortedCommands[commandIndex]
      if (!command) break
      latestInWindow = command
      consumedInWindow += 1
      commandIndex += 1
    }
    if (latestInWindow) {
      activeAxis = latestInWindow.axis
      activeBoost = latestInWindow.boost
      replayedCommandCount += 1
    }
    if (consumedInWindow > 0) {
      consumedPerTick.push(consumedInWindow)
      droppedByCoalescing += Math.max(0, consumedInWindow - 1)
    }
    tickInputs[tickIndex] = {
      axis: activeAxis,
      boost: activeBoost,
      sourceCount: consumedInWindow,
    }
  }

  return {
    tickInputs,
    droppedByCoalescing,
    replayedCommandCount,
    coalescedPerTickP95: computeP95(consumedPerTick),
  }
}

export function replayPredictedSnake(options: ReplayPredictionOptions): ReplayPredictionResult {
  const {
    snake,
    baseReceivedAtMs,
    nowMs,
    pendingCommands,
    fallbackAxis,
    boostAllowed,
    snakeAngularRadius,
    environment,
    previousParityState,
  } = options
  const outputSnake = cloneSnake(snake)
  const baseState = rebaseSnakeParityState(outputSnake, previousParityState)
  if (baseState.nodes.length === 0) {
    const emptyState = createSnakeParityStateFromPoints([])
    return {
      snake: [],
      axis: fallbackAxis ? normalize(fallbackAxis) : { x: 0, y: 1, z: 0 },
      parityState: emptyState,
      replayedCommandCount: 0,
      replayedTickCount: 0,
      commandsDroppedByCoalescing: 0,
      commandsCoalescedPerTickP95: 0,
    }
  }

  const startMs = Number.isFinite(baseReceivedAtMs) ? baseReceivedAtMs : nowMs
  const cappedNowMs = Math.max(startMs, nowMs)
  let durationMs = Math.max(0, cappedNowMs - startMs)
  if (durationMs <= 0.25) {
    const basePoints = pointsFromSnakeParityState(baseState)
    return {
      snake: basePoints,
      axis: deriveLocalAxis(basePoints, fallbackAxis),
      parityState: baseState,
      replayedCommandCount: 0,
      replayedTickCount: 0,
      commandsDroppedByCoalescing: 0,
      commandsCoalescedPerTickP95: 0,
    }
  }

  const sortedCommands = pendingCommands
    .slice()
    .sort((a, b) => a.sentAtMs - b.sentAtMs)
    .filter((command) => Number.isFinite(command.sentAtMs))

  const maxReplayMs = TICK_MS * REPLAY_MAX_TICKS
  durationMs = Math.min(durationMs, maxReplayMs)
  const tickReplay = coalesceCommandsByTick(sortedCommands, startMs, durationMs)
  let axis = deriveLocalAxis(pointsFromSnakeParityState(baseState), fallbackAxis)

  for (let tickIndex = 0; tickIndex < tickReplay.tickInputs.length; tickIndex += 1) {
    const tickInput = tickReplay.tickInputs[tickIndex]
    const tickStartMs = tickIndex * TICK_MS
    const tickEndMs = Math.min(durationMs, tickStartMs + TICK_MS)
    const tickDurationMs = Math.max(0, tickEndMs - tickStartMs)
    if (tickDurationMs <= 0) continue

    const targetAxis = tickInput?.axis ? normalize(tickInput.axis) : axis
    const speedFactor = tickInput?.boost && boostAllowed ? BOOST_MULTIPLIER : 1
    const stepCount =
      tickInput?.boost && boostAllowed
        ? Math.max(1, TURN_SUBSTEPS_BOOST)
        : Math.max(1, TURN_SUBSTEPS_NORMAL)
    const stepVelocity = (BASE_SPEED * speedFactor) / stepCount
    const turnPerTick = turnRateFor(baseState.nodes.length, speedFactor)
    const turnPerSubstepCap = turnPerTick / stepCount
    const steeringGain = steeringGainForSpeed(speedFactor)
    const substepDtSeconds = (tickDurationMs / 1000) / stepCount
    for (let substep = 0; substep < stepCount; substep += 1) {
      const turnStep = steeringTurnStep(
        axis,
        targetAxis,
        turnPerSubstepCap,
        steeringGain,
        substepDtSeconds,
      )
      axis = rotateToward(axis, targetAxis, turnStep)
      axis = applySnakeWithCollisions(
        baseState,
        axis,
        snakeAngularRadius,
        stepVelocity,
        1,
        environment,
      )
    }
  }

  const replayedSnake = pointsFromSnakeParityState(baseState)
  return {
    snake: replayedSnake,
    axis,
    parityState: baseState,
    replayedCommandCount: tickReplay.replayedCommandCount,
    replayedTickCount: tickReplay.tickInputs.length,
    commandsDroppedByCoalescing: tickReplay.droppedByCoalescing,
    commandsCoalescedPerTickP95: tickReplay.coalescedPerTickP95,
  }
}
