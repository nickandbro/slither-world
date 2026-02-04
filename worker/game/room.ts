import type { GameStateSnapshot, Player, Point, Session, SnakeNode } from './types'
import {
  BASE_PELLET_COUNT,
  BASE_SPEED,
  BOOST_MULTIPLIER,
  COLOR_POOL,
  MAX_PELLETS,
  PLAYER_TIMEOUT_MS,
  RESPAWN_COOLDOWN_MS,
  SPAWN_CONE_ANGLE,
  STAMINA_DRAIN_PER_SEC,
  STAMINA_MAX,
  STAMINA_RECHARGE_PER_SEC,
  TICK_MS,
  TURN_RATE,
} from './constants'
import {
  collision,
  copyPoint,
  normalize,
  pointFromSpherical,
  randomAxis,
  rotateToward,
  rotateY,
  rotateZ,
} from './math'
import { addDigestion, advanceDigestions, getDigestionProgress } from './digestion'
import { parseAxis } from './input'
import { applySnakeRotation, createSnake, rotateSnake as rotateSnakeNodes } from './snake'
import { sanitizePlayerName } from '../shared/names'

export class GameRoom {
  private sessions = new Map<WebSocket, Session>()
  private players = new Map<string, Player>()
  private pellets: Point[] = []
  private intervalId: number | undefined

  constructor() {}

  async fetch(request: Request) {
    const upgradeHeader = request.headers.get('Upgrade')
    if (upgradeHeader?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    this.handleSession(server)

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  private handleSession(webSocket: WebSocket) {
    webSocket.accept()

    const session: Session = { socket: webSocket }
    this.sessions.set(webSocket, session)

    webSocket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      let data: unknown
      try {
        data = JSON.parse(event.data)
      } catch {
        return
      }

      if (!data || typeof data !== 'object') return
      const message = data as {
        type?: string
        name?: unknown
        playerId?: unknown
        boost?: unknown
        axis?: unknown
      }

      if (message.type === 'join') {
        const name = sanitizePlayerName(String(message.name ?? 'Player'))
        const requestedId = typeof message.playerId === 'string' ? message.playerId : undefined

        let player = requestedId ? this.players.get(requestedId) : undefined
        if (!player) {
          const id = requestedId ?? crypto.randomUUID()
          player = this.createPlayer(id, name)
          this.players.set(id, player)
        }

        player.name = name
        player.connected = true
        player.lastSeen = Date.now()

        session.playerId = player.id

        this.send(webSocket, {
          type: 'init',
          playerId: player.id,
          state: this.buildStateSnapshot(),
        })

        this.ensureLoop()
        return
      }

      if (message.type === 'respawn') {
        if (!session.playerId) return
        const player = this.players.get(session.playerId)
        if (!player || player.alive) return
        if (player.respawnAt && Date.now() < player.respawnAt) return
        this.respawnPlayer(player)
        return
      }

      if (message.type === 'input') {
        if (!session.playerId) return
        const player = this.players.get(session.playerId)
        if (!player) return

        const axis = parseAxis(message.axis)
        if (axis) player.targetAxis = axis
        player.boost = Boolean(message.boost)
        player.lastSeen = Date.now()
      }
    })

    const closeHandler = () => {
      const existing = this.sessions.get(webSocket)
      if (existing?.playerId) {
        const player = this.players.get(existing.playerId)
        if (player) {
          player.connected = false
          player.lastSeen = Date.now()
        }
      }

      this.sessions.delete(webSocket)
      if (this.sessions.size === 0) {
        this.stopLoop()
      }
    }

    webSocket.addEventListener('close', closeHandler)
    webSocket.addEventListener('error', closeHandler)
  }

  private ensureLoop() {
    if (this.intervalId !== undefined) return
    this.intervalId = setInterval(() => this.tick(), TICK_MS) as unknown as number
  }

  private stopLoop() {
    if (this.intervalId === undefined) return
    clearInterval(this.intervalId)
    this.intervalId = undefined
  }

  private createPlayer(id: string, name: string): Player {
    const baseAxis = randomAxis()
    const { snake, axis } = this.spawnSnake(baseAxis)

    return {
      id,
      name,
      color: COLOR_POOL[this.players.size % COLOR_POOL.length],
      axis,
      targetAxis: axis,
      boost: false,
      stamina: STAMINA_MAX,
      score: 0,
      alive: true,
      connected: true,
      lastSeen: Date.now(),
      snake,
      digestions: [],
    }
  }

  private spawnSnake(baseAxis: Point): { snake: SnakeNode[]; axis: Point } {
    let snake: SnakeNode[] = []
    let axis = baseAxis

    for (let attempt = 0; attempt < 8; attempt += 1) {
      snake = createSnake(baseAxis)
      const theta = Math.random() * Math.PI * 2
      const phi = Math.PI - Math.random() * SPAWN_CONE_ANGLE
      const rotateYAngle = Math.PI - phi

      rotateSnakeNodes(snake, theta, rotateYAngle)
      const rotatedAxis = { ...baseAxis }
      rotateY(rotatedAxis, rotateYAngle)
      rotateZ(rotatedAxis, theta)
      axis = normalize(rotatedAxis)
      if (!this.isSnakeTooClose(snake)) {
        return { snake, axis }
      }
    }

    return { snake, axis }
  }

  private isSnakeTooClose(snake: SnakeNode[]) {
    for (const player of this.players.values()) {
      if (!player.alive) continue
      for (const node of player.snake) {
        if (collision(snake[0], node)) return true
      }
    }
    return false
  }

  private ensurePellets() {
    while (this.pellets.length < BASE_PELLET_COUNT) {
      this.pellets.push(pointFromSpherical(Math.random() * Math.PI * 2, Math.random() * Math.PI))
    }
  }

  private tick() {
    const now = Date.now()
    this.ensurePellets()
    const dtSeconds = TICK_MS / 1000
    const moveSteps = new Map<string, number>()

    for (const [id, player] of this.players) {
      if (!player.connected && now - player.lastSeen > PLAYER_TIMEOUT_MS) {
        this.players.delete(id)
        continue
      }
    }

    for (const player of this.players.values()) {
      if (!player.alive) continue
      player.axis = rotateToward(player.axis, player.targetAxis, TURN_RATE)
      const wantsBoost = player.boost
      const hasStamina = player.stamina > 0
      const isBoosting = wantsBoost && hasStamina
      if (isBoosting) {
        player.stamina = Math.max(0, player.stamina - STAMINA_DRAIN_PER_SEC * dtSeconds)
      } else if (!wantsBoost) {
        player.stamina = Math.min(
          STAMINA_MAX,
          player.stamina + STAMINA_RECHARGE_PER_SEC * dtSeconds,
        )
      }
      const speedFactor = isBoosting ? BOOST_MULTIPLIER : 1
      const stepCount = Math.max(1, Math.round(speedFactor))
      const stepVelocity = (BASE_SPEED * speedFactor) / stepCount
      applySnakeRotation(player.snake, player.axis, stepVelocity, stepCount)
      moveSteps.set(player.id, stepCount)
    }

    const dead: Player[] = []

    for (const player of this.players.values()) {
      if (!player.alive) continue
      const head = player.snake[0]
      for (let i = 2; i < player.snake.length; i += 1) {
        if (collision(head, player.snake[i])) {
          dead.push(player)
          break
        }
      }
      if (dead.includes(player)) continue

      for (const other of this.players.values()) {
        if (!other.alive || other.id === player.id) continue
        for (const node of other.snake) {
          if (collision(head, node)) {
            dead.push(player)
            break
          }
        }
        if (dead.includes(player)) break
      }
    }

    for (const player of dead) {
      this.handleDeath(player)
    }

    for (const player of this.players.values()) {
      if (!player.alive) continue
      for (let i = this.pellets.length - 1; i >= 0; i -= 1) {
        if (!collision(player.snake[0], this.pellets[i])) continue
        this.pellets.splice(i, 1)
        player.score += 1
        addDigestion(player)
        if (this.pellets.length < MAX_PELLETS) {
          this.pellets.push(pointFromSpherical(Math.random() * Math.PI * 2, Math.random() * Math.PI))
        }
      }
    }

    for (const player of this.players.values()) {
      if (!player.alive) continue
      const steps = moveSteps.get(player.id) ?? 1
      advanceDigestions(player, steps)
    }

    this.broadcastState()
  }

  private handleDeath(player: Player) {
    if (!player.alive) return
    player.alive = false
    player.respawnAt = Date.now() + RESPAWN_COOLDOWN_MS
    player.digestions = []

    for (let i = 2; i < player.snake.length && this.pellets.length < MAX_PELLETS; i += 2) {
      const node = player.snake[i]
      this.pellets.push({ x: node.x, y: node.y, z: node.z })
    }

    player.score = 0
  }

  private respawnPlayer(player: Player) {
    const baseAxis = randomAxis()
    const spawned = this.spawnSnake(baseAxis)
    player.axis = spawned.axis
    player.targetAxis = spawned.axis
    player.score = 0
    player.alive = true
    player.boost = false
    player.stamina = STAMINA_MAX
    player.respawnAt = undefined
    player.snake = spawned.snake
    player.digestions = []
  }

  private buildStateSnapshot(): GameStateSnapshot {
    return {
      now: Date.now(),
      pellets: this.pellets.map(copyPoint),
      players: Array.from(this.players.values()).map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        score: player.score,
        stamina: player.stamina,
        alive: player.alive,
        snake: player.snake.map(copyPoint),
        digestions: player.digestions.map(getDigestionProgress),
      })),
    }
  }

  private send(socket: WebSocket, payload: unknown) {
    socket.send(JSON.stringify(payload))
  }

  private broadcastState() {
    const snapshot = this.buildStateSnapshot()
    const message = JSON.stringify({ type: 'state', state: snapshot })

    for (const session of this.sessions.values()) {
      try {
        session.socket.send(message)
      } catch {
        this.sessions.delete(session.socket)
      }
    }
  }
}
