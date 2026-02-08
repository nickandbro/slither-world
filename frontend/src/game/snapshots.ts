import type {
  DigestionSnapshot,
  GameStateSnapshot,
  PelletSnapshot,
  PlayerSnapshot,
  Point,
} from './types'
import { clamp, lerp, lerpPoint } from './math'

export type TimedSnapshot = GameStateSnapshot & {
  receivedAt: number
}

const MAX_DIGESTION_PROGRESS = 2

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
        strength: clamp(lerp(digestionA.strength, digestionB.strength, t), 0.05, 1),
      })
    } else {
      digestions.push({
        id: digestionB.id,
        progress: clamp(digestionB.progress, 0, MAX_DIGESTION_PROGRESS),
        strength: clamp(digestionB.strength, 0.05, 1),
      })
    }
  }

  if (t < 0.95) {
    for (const digestionA of a) {
      if (digestionsB.has(digestionA.id)) continue
      digestions.push({
        id: digestionA.id,
        progress: clamp(digestionA.progress, 0, MAX_DIGESTION_PROGRESS),
        strength: clamp(digestionA.strength, 0.05, 1),
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

function blendPlayers(a: PlayerSnapshot, b: PlayerSnapshot, t: number): PlayerSnapshot {
  if (a.alive !== b.alive) {
    return b
  }
  let snake: Point[] = []
  if (canBlendSnakeWindow(a, b)) {
    const maxLength = Math.max(a.snake.length, b.snake.length)
    const tailA = a.snake[a.snake.length - 1]
    for (let i = 0; i < maxLength; i += 1) {
      const nodeA = a.snake[i]
      const nodeB = b.snake[i]
      if (nodeA && nodeB) {
        snake.push(lerpPoint(nodeA, nodeB, t))
      } else if (nodeB) {
        if (tailA) {
          snake.push(lerpPoint(tailA, nodeB, t))
        } else {
          snake.push({ ...nodeB })
        }
      } else if (nodeA) {
        snake.push({ ...nodeA })
      }
    }
  } else {
    snake = b.snake.map((node) => ({ ...node }))
  }

  return {
    id: b.id,
    name: b.name,
    color: b.color,
    score: b.score,
    scoreFraction: blendScoreFraction(a, b, t),
    oxygen: lerp(a.oxygen, b.oxygen, t),
    isBoosting: b.isBoosting,
    girthScale: lerp(a.girthScale, b.girthScale, t),
    tailExtension: lerp(a.tailExtension, b.tailExtension, t),
    alive: b.alive,
    snakeDetail: b.snakeDetail,
    snakeStart: b.snakeStart,
    snakeTotalLen: b.snakeTotalLen,
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
