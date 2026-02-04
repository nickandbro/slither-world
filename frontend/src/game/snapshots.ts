import type { GameStateSnapshot, PlayerSnapshot, Point } from './types'
import { clamp, lerp, lerpPoint } from './math'

export type TimedSnapshot = GameStateSnapshot & {
  receivedAt: number
}

const MAX_DIGESTION_PROGRESS = 2

function blendDigestions(a: number[], b: number[], t: number) {
  const maxLength = Math.max(a.length, b.length)
  const digestions: number[] = []
  for (let i = 0; i < maxLength; i += 1) {
    const da = a[i]
    const db = b[i]
    if (typeof da === 'number' && typeof db === 'number') {
      digestions.push(clamp(lerp(da, db, t), 0, MAX_DIGESTION_PROGRESS))
    } else if (typeof db === 'number') {
      digestions.push(clamp(db, 0, MAX_DIGESTION_PROGRESS))
    } else if (typeof da === 'number' && t < 0.95) {
      digestions.push(clamp(da, 0, MAX_DIGESTION_PROGRESS))
    }
  }
  return digestions
}

function blendPlayers(a: PlayerSnapshot, b: PlayerSnapshot, t: number): PlayerSnapshot {
  if (a.alive !== b.alive) {
    return b
  }
  const maxLength = Math.max(a.snake.length, b.snake.length)
  const snake: Point[] = []
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

  return {
    id: b.id,
    name: b.name,
    color: b.color,
    score: b.score,
    stamina: lerp(a.stamina, b.stamina, t),
    alive: b.alive,
    snake,
    digestions: blendDigestions(a.digestions, b.digestions, t),
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
    pellets: t < 0.5 ? a.pellets : b.pellets,
    players,
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
