import type {
  DigestionSnapshot,
  GameStateSnapshot,
  PelletSnapshot,
  PlayerSnapshot,
  Point,
} from './types'
import { clamp, lerp, lerpPoint, normalize } from './math'

export type TimedSnapshot = GameStateSnapshot & {
  receivedAt: number
}

const MAX_DIGESTION_PROGRESS = 2
const SNAKE_EXT_EPS = 1e-6

const pointDistance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

const nlerpPoint = (a: Point, b: Point, t: number): Point => normalize(lerpPoint(a, b, t))
const dotPoint = (a: Point, b: Point) => a.x * b.x + a.y * b.y + a.z * b.z

const angularDistance = (a: Point, b: Point) =>
  Math.acos(clamp(dotPoint(normalize(a), normalize(b)), -1, 1))

function tangentToward(from: Point, to: Point): Point | null {
  const fromNorm = normalize(from)
  const toNorm = normalize(to)
  const raw = {
    x: toNorm.x - fromNorm.x,
    y: toNorm.y - fromNorm.y,
    z: toNorm.z - fromNorm.z,
  }
  const radial = dotPoint(raw, fromNorm)
  const tangent = {
    x: raw.x - fromNorm.x * radial,
    y: raw.y - fromNorm.y * radial,
    z: raw.z - fromNorm.z * radial,
  }
  const len = Math.hypot(tangent.x, tangent.y, tangent.z)
  if (!(len > SNAKE_EXT_EPS) || !Number.isFinite(len)) return null
  return {
    x: tangent.x / len,
    y: tangent.y / len,
    z: tangent.z / len,
  }
}

function advanceAlongArc(from: Point, toward: Point, angleRad: number): Point {
  const fromNorm = normalize(from)
  const clampedAngle = clamp(angleRad, 0, Math.PI)
  if (!(clampedAngle > SNAKE_EXT_EPS)) return fromNorm
  const tangent = tangentToward(fromNorm, toward)
  if (!tangent) return normalize(toward)
  const sinTheta = Math.sin(clampedAngle)
  const cosTheta = Math.cos(clampedAngle)
  return normalize({
    x: fromNorm.x * cosTheta + tangent.x * sinTheta,
    y: fromNorm.y * cosTheta + tangent.y * sinTheta,
    z: fromNorm.z * cosTheta + tangent.z * sinTheta,
  })
}

function preserveSnakeSegmentSpacing(snake: Point[], segmentAngles: number[]): Point[] {
  if (snake.length <= 1) return cloneSnake(snake)
  const out: Point[] = [normalize(snake[0])]
  for (let i = 1; i < snake.length; i += 1) {
    const prev = out[i - 1]
    const current = normalize(snake[i])
    if (!prev) {
      out.push(current)
      continue
    }
    const targetAngle = segmentAngles[i - 1]
    if (!Number.isFinite(targetAngle) || targetAngle <= SNAKE_EXT_EPS) {
      out.push(current)
      continue
    }
    out.push(advanceAlongArc(prev, current, targetAngle))
  }
  return out
}

const cloneSnake = (snake: Point[]) => snake.map((node) => ({ ...node }))

function tailStepLength(snake: Point[]) {
  if (snake.length < 2) return 0
  const tail = normalize(snake[snake.length - 1])
  const prev = normalize(snake[snake.length - 2])
  let len = pointDistance(tail, prev)
  if (!(len > SNAKE_EXT_EPS) && snake.length >= 3) {
    const prevPrev = normalize(snake[snake.length - 3])
    len = pointDistance(prev, prevPrev)
  }
  return Number.isFinite(len) && len > 0 ? len : 0
}

function tangentDirAtTail(tail: Point, prev: Point): Point | null {
  const tailN = normalize(tail)
  const prevN = normalize(prev)
  const seg = { x: tailN.x - prevN.x, y: tailN.y - prevN.y, z: tailN.z - prevN.z }
  const dotSegN = seg.x * tailN.x + seg.y * tailN.y + seg.z * tailN.z
  const dir = {
    x: seg.x - tailN.x * dotSegN,
    y: seg.y - tailN.y * dotSegN,
    z: seg.z - tailN.z * dotSegN,
  }
  const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z)
  if (!(len > SNAKE_EXT_EPS)) return null
  return { x: dir.x / len, y: dir.y / len, z: dir.z / len }
}

function extendSnakeTailForGrowth(snake: Point[], targetLength: number): Point[] {
  if (snake.length >= targetLength) return cloneSnake(snake)
  const out = cloneSnake(snake)
  if (out.length === 0) return out
  const tail0 = normalize(out[out.length - 1])
  if (out.length < 2) {
    while (out.length < targetLength) out.push({ ...tail0 })
    return out
  }

  const stepLen = tailStepLength(out)
  if (!(stepLen > SNAKE_EXT_EPS)) {
    while (out.length < targetLength) out.push({ ...tail0 })
    return out
  }

  while (out.length < targetLength) {
    const tail = normalize(out[out.length - 1])
    const prev = normalize(out[out.length - 2])
    const dir = tangentDirAtTail(tail, prev)
    if (!dir) {
      out.push({ ...tail })
      continue
    }
    const next = normalize({
      x: tail.x + dir.x * stepLen,
      y: tail.y + dir.y * stepLen,
      z: tail.z + dir.z * stepLen,
    })
    out.push(next)
  }
  return out
}

function extendSnakeTailByRepeatingTail(snake: Point[], targetLength: number): Point[] {
  if (snake.length >= targetLength) return cloneSnake(snake)
  const out = cloneSnake(snake)
  if (out.length === 0) return out
  const tail = normalize(out[out.length - 1])
  while (out.length < targetLength) out.push({ ...tail })
  return out
}

function blendDigestions(a: DigestionSnapshot[], b: DigestionSnapshot[], t: number) {
  const digestions: DigestionSnapshot[] = []
  const digestionsA = new Map(a.map((digestion) => [digestion.id, digestion]))
  const digestionsB = new Set(b.map((digestion) => digestion.id))

  for (const digestionB of b) {
    const digestionA = digestionsA.get(digestionB.id)
    if (digestionA) {
      digestions.push({
        id: digestionB.id,
        progress: clamp(
          lerp(digestionA.progress, digestionB.progress, t),
          0,
          MAX_DIGESTION_PROGRESS,
        ),
        strength: clamp(lerp(digestionA.strength, digestionB.strength, t), 0, 1),
      })
    } else {
      digestions.push({
        id: digestionB.id,
        progress: clamp(digestionB.progress, 0, MAX_DIGESTION_PROGRESS),
        strength: clamp(digestionB.strength, 0, 1),
      })
    }
  }

  if (t < 0.95) {
    for (const digestionA of a) {
      if (digestionsB.has(digestionA.id)) continue
      digestions.push({
        id: digestionA.id,
        progress: clamp(digestionA.progress, 0, MAX_DIGESTION_PROGRESS),
        strength: clamp(digestionA.strength, 0, 1),
      })
    }
  }

  return digestions
}

function blendPellets(a: PelletSnapshot[], b: PelletSnapshot[], t: number) {
  const pellets: PelletSnapshot[] = []
  const pelletsA = new Map(a.map((pellet) => [pellet.id, pellet]))
  const pelletsB = new Set(b.map((pellet) => pellet.id))

  for (const pelletB of b) {
    const pelletA = pelletsA.get(pelletB.id)
    if (pelletA) {
      pellets.push({
        id: pelletB.id,
        x: lerp(pelletA.x, pelletB.x, t),
        y: lerp(pelletA.y, pelletB.y, t),
        z: lerp(pelletA.z, pelletB.z, t),
        colorIndex: pelletB.colorIndex,
        size: Math.max(0, lerp(pelletA.size, pelletB.size, t)),
      })
    } else {
      pellets.push({ ...pelletB })
    }
  }

  if (t < 0.9) {
    const fade = 1 - t / 0.9
    for (const pelletA of a) {
      if (pelletsB.has(pelletA.id)) continue
      const fadedSize = pelletA.size * fade
      if (fadedSize <= 0.01) continue
      pellets.push({ ...pelletA, size: fadedSize })
    }
  }

  return pellets
}

function canBlendSnakeWindow(a: PlayerSnapshot, b: PlayerSnapshot) {
  if (a.snakeDetail !== b.snakeDetail) return false
  if (a.snakeDetail === 'stub') return true
  if (a.snakeDetail === 'window') {
    return (
      a.snakeStart === b.snakeStart &&
      a.snake.length === b.snake.length &&
      a.snakeTotalLen === b.snakeTotalLen
    )
  }
  return true
}

function blendScoreFraction(a: PlayerSnapshot, b: PlayerSnapshot, t: number) {
  const fracA = clamp(a.scoreFraction, 0, 0.999_999)
  const fracB = clamp(b.scoreFraction, 0, 0.999_999)
  const scoreDelta = b.score - a.score

  if (scoreDelta === -1 && fracB > fracA) {
    const blended = lerp(fracA, fracB - 1, t)
    return blended < 0 ? blended + 1 : blended
  }
  if (scoreDelta === 1 && fracB < fracA) {
    const blended = lerp(fracA, fracB + 1, t)
    return blended >= 1 ? blended - 1 : blended
  }

  return clamp(lerp(fracA, fracB, t), 0, 0.999_999)
}

function blendTailTip(a: Point | null, b: Point | null, t: number): Point | null {
  if (a && b) return nlerpPoint(a, b, t)
  if (b) return { ...b }
  if (a && t < 0.95) return { ...a }
  return null
}

function blendPlayers(a: PlayerSnapshot, b: PlayerSnapshot, t: number): PlayerSnapshot {
  if (a.alive !== b.alive) {
    return b
  }
  const tLen = clamp(t, 0, 1)
  let snakeStart = b.snakeStart
  let snakeTotalLen = b.snakeTotalLen
  let tailExtension = lerp(a.tailExtension, b.tailExtension, tLen)

  let snake: Point[] = []
  if (canBlendSnakeWindow(a, b)) {
    const isFull = a.snakeDetail === 'full' && b.snakeDetail === 'full'
    if (isFull) {
      const lenA = a.snake.length
      const lenB = b.snake.length
      const maxLength = Math.max(lenA, lenB)
      if (maxLength > 0) {
        const aExt = lenA < maxLength ? extendSnakeTailForGrowth(a.snake, maxLength) : cloneSnake(a.snake)
        const bExt = lenB < maxLength ? extendSnakeTailByRepeatingTail(b.snake, maxLength) : cloneSnake(b.snake)
        const segmentAngles: number[] = []
        const blended: Point[] = []
        for (let i = 0; i < maxLength; i += 1) {
          const nodeA = aExt[i]
          const nodeB = bExt[i]
          blended.push(nlerpPoint(nodeA, nodeB, t))
          if (i > 0) {
            const prevA = aExt[i - 1]
            const prevB = bExt[i - 1]
            const angleA = angularDistance(prevA, nodeA)
            const angleB = angularDistance(prevB, nodeB)
            segmentAngles.push(lerp(angleA, angleB, tLen))
          }
        }
        const blendedWithSpacing = preserveSnakeSegmentSpacing(blended, segmentAngles)

        // Preserve visual continuity across "commit a new node" boundaries by blending
        // length-units (integer nodes + fractional tail extension) and then re-deriving
        // `{ snakeTotalLen, tailExtension }`. This avoids one-frame "shrink then pop" under
        // rapid growth/boost transitions.
        const lenUnitsA = lenA + clamp(a.tailExtension, 0, 0.999_999)
        const lenUnitsB = lenB + clamp(b.tailExtension, 0, 0.999_999)
        const lenUnits = lerp(lenUnitsA, lenUnitsB, tLen)
        const outTotalLen = Math.max(0, Math.min(maxLength, Math.floor(lenUnits + 1e-6)))
        snakeTotalLen = outTotalLen
        snakeStart = 0
        tailExtension = clamp(lenUnits - outTotalLen, 0, 0.999_999)
        snake = blendedWithSpacing.slice(0, outTotalLen)
      } else {
        snakeTotalLen = 0
        snakeStart = 0
        tailExtension = 0
        snake = []
      }
    } else {
      const maxLength = Math.max(a.snake.length, b.snake.length)
      const tailA = a.snake[a.snake.length - 1]
      for (let i = 0; i < maxLength; i += 1) {
        const nodeA = a.snake[i]
        const nodeB = b.snake[i]
        if (nodeA && nodeB) {
          snake.push(nlerpPoint(nodeA, nodeB, t))
        } else if (nodeB) {
          if (tailA) {
            snake.push(nlerpPoint(tailA, nodeB, t))
          } else {
            snake.push({ ...nodeB })
          }
        } else if (nodeA) {
          snake.push({ ...nodeA })
        }
      }
    }
  } else {
    snake = cloneSnake(b.snake)
  }

  return {
    id: b.id,
    name: b.name,
    color: b.color,
    skinColors: b.skinColors ?? a.skinColors,
    score: b.score,
    scoreFraction: blendScoreFraction(a, b, t),
    oxygen: lerp(a.oxygen, b.oxygen, t),
    isBoosting: b.isBoosting,
    girthScale: lerp(a.girthScale, b.girthScale, t),
    tailExtension,
    tailTip: blendTailTip(a.tailTip, b.tailTip, t),
    alive: b.alive,
    snakeDetail: b.snakeDetail,
    snakeStart,
    snakeTotalLen,
    snake,
    digestions:
      a.snakeDetail === 'full' && b.snakeDetail === 'full'
        ? blendDigestions(a.digestions, b.digestions, t)
        : b.digestions,
  }
}

function blendSnapshots(a: GameStateSnapshot, b: GameStateSnapshot, t: number): GameStateSnapshot {
  const playersA = new Map(a.players.map((player) => [player.id, player]))
  const playersB = new Map(b.players.map((player) => [player.id, player]))
  const orderedIds: string[] = []

  for (const player of b.players) orderedIds.push(player.id)
  for (const player of a.players) {
    if (!playersB.has(player.id)) orderedIds.push(player.id)
  }

  const players: PlayerSnapshot[] = []
  for (const id of orderedIds) {
    const playerA = playersA.get(id)
    const playerB = playersB.get(id)
    if (playerA && playerB) {
      players.push(blendPlayers(playerA, playerB, t))
    } else if (playerB) {
      players.push(playerB)
    } else if (playerA && t < 0.95) {
      players.push(playerA)
    }
  }

  return {
    now: lerp(a.now, b.now, t),
    seq: t < 0.5 ? a.seq : b.seq,
    pellets: blendPellets(a.pellets, b.pellets, t),
    players,
    totalPlayers: t < 0.5 ? a.totalPlayers : b.totalPlayers,
    ackInputSeq: t < 0.5 ? (a.ackInputSeq ?? null) : (b.ackInputSeq ?? null),
  }
}

export function buildInterpolatedSnapshot(
  buffer: TimedSnapshot[],
  renderTime: number,
  maxExtrapolationMs: number,
): GameStateSnapshot | null {
  if (buffer.length === 0) return null

  while (buffer.length > 2 && buffer[1].now <= renderTime - maxExtrapolationMs) {
    buffer.shift()
  }

  let before = buffer[0]
  let after: TimedSnapshot | undefined

  for (let i = 1; i < buffer.length; i += 1) {
    if (buffer[i].now >= renderTime) {
      before = buffer[i - 1]
      after = buffer[i]
      break
    }
  }

  if (!after) {
    const latest = buffer[buffer.length - 1]
    const previous = buffer.length > 1 ? buffer[buffer.length - 2] : null
    const extra = renderTime - latest.now
    if (previous && extra > 0 && extra <= maxExtrapolationMs) {
      const dt = latest.now - previous.now
      if (dt > 0) {
        const t = 1 + extra / dt
        return blendSnapshots(previous, latest, t)
      }
    }
    return latest
  }

  if (renderTime <= before.now) return before

  const span = after.now - before.now
  if (span <= 0) return before
  const t = (renderTime - before.now) / span
  return blendSnapshots(before, after, t)
}
