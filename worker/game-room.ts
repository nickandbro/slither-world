type Point = {
  x: number
  y: number
  z: number
}

type SnakeNode = Point & {
  posQueue: Array<Point | null>
}

type Player = {
  id: string
  name: string
  color: string
  axis: Point
  targetAxis: Point
  boost: boolean
  score: number
  alive: boolean
  connected: boolean
  lastSeen: number
  respawnAt?: number
  snake: SnakeNode[]
}

type Session = {
  socket: WebSocket
  playerId?: string
}

type GameStateSnapshot = {
  now: number
  pellets: Point[]
  players: Array<{
    id: string
    name: string
    color: string
    score: number
    alive: boolean
    snake: Point[]
  }>
}

const NODE_ANGLE = Math.PI / 60
const NODE_QUEUE_SIZE = 9
const STARTING_LENGTH = 8
const BASE_SPEED = (NODE_ANGLE * 2) / (NODE_QUEUE_SIZE + 1)
const BOOST_MULTIPLIER = 1.75
const TURN_RATE = 0.08
const COLLISION_DISTANCE = 2 * Math.sin(NODE_ANGLE)
const BASE_PELLET_COUNT = 3
const MAX_PELLETS = 12
const TICK_MS = 50
const RESPAWN_COOLDOWN_MS = 0
const PLAYER_TIMEOUT_MS = 15000
const SPAWN_CONE_ANGLE = Math.PI / 3

const COLOR_POOL = [
  '#ff6b6b',
  '#ffd166',
  '#06d6a0',
  '#4dabf7',
  '#f06595',
  '#845ef7',
  '#20c997',
  '#fcc419',
]

function pointFromSpherical(theta: number, phi: number): Point {
  const sinPhi = Math.sin(phi)
  return {
    x: Math.cos(theta) * sinPhi,
    y: Math.sin(theta) * sinPhi,
    z: Math.cos(phi),
  }
}

function copyPoint(src: Point): Point {
  return { x: src.x, y: src.y, z: src.z }
}

function length(point: Point) {
  return Math.sqrt(point.x * point.x + point.y * point.y + point.z * point.z)
}

function normalize(point: Point): Point {
  const len = length(point)
  if (!Number.isFinite(len) || len === 0) return { x: 0, y: 0, z: 0 }
  return { x: point.x / len, y: point.y / len, z: point.z / len }
}

function dot(a: Point, b: Point) {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function cross(a: Point, b: Point): Point {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function rotateZ(point: Point, angle: number) {
  const cosA = Math.cos(angle)
  const sinA = Math.sin(angle)
  const x = point.x
  const y = point.y
  point.x = cosA * x - sinA * y
  point.y = sinA * x + cosA * y
}

function rotateY(point: Point, angle: number) {
  const cosA = Math.cos(angle)
  const sinA = Math.sin(angle)
  const x = point.x
  const z = point.z
  point.x = cosA * x + sinA * z
  point.z = -sinA * x + cosA * z
}

function rotateAroundAxis(point: Point, axis: Point, angle: number) {
  const u = normalize(axis)
  const cosA = Math.cos(angle)
  const sinA = Math.sin(angle)
  const ux = u.x
  const uy = u.y
  const uz = u.z
  const x = point.x
  const y = point.y
  const z = point.z
  const dotProd = ux * x + uy * y + uz * z

  point.x = x * cosA + (uy * z - uz * y) * sinA + ux * dotProd * (1 - cosA)
  point.y = y * cosA + (uz * x - ux * z) * sinA + uy * dotProd * (1 - cosA)
  point.z = z * cosA + (ux * y - uy * x) * sinA + uz * dotProd * (1 - cosA)
}

function rotateToward(current: Point, target: Point, maxAngle: number) {
  const currentNorm = normalize(current)
  const targetNorm = normalize(target)
  const dotValue = clamp(dot(currentNorm, targetNorm), -1, 1)
  const angle = Math.acos(dotValue)
  if (!Number.isFinite(angle) || angle <= maxAngle) return targetNorm
  if (angle === 0) return currentNorm

  const axis = cross(currentNorm, targetNorm)
  const axisLength = length(axis)
  if (axisLength === 0) return currentNorm
  const axisNorm = { x: axis.x / axisLength, y: axis.y / axisLength, z: axis.z / axisLength }
  const rotated = { ...currentNorm }
  rotateAroundAxis(rotated, axisNorm, maxAngle)
  return normalize(rotated)
}

function randomAxis(): Point {
  const angle = Math.random() * Math.PI * 2
  return { x: Math.cos(angle), y: Math.sin(angle), z: 0 }
}

function addSnakeNode(snake: SnakeNode[], axis: Point) {
  const snakeNode: SnakeNode = {
    x: 0,
    y: 0,
    z: -1,
    posQueue: [],
  }

  for (let i = 0; i < NODE_QUEUE_SIZE; i += 1) {
    snakeNode.posQueue.push(null)
  }

  if (snake.length > 0) {
    const last = snake[snake.length - 1]
    const lastPos = last.posQueue[NODE_QUEUE_SIZE - 1]

    if (lastPos === null) {
      snakeNode.x = last.x
      snakeNode.y = last.y
      snakeNode.z = last.z
      rotateAroundAxis(snakeNode, axis, -NODE_ANGLE * 2)
    } else {
      snakeNode.x = lastPos.x
      snakeNode.y = lastPos.y
      snakeNode.z = lastPos.z
    }
  }

  snake.push(snakeNode)
}

function applySnakeRotation(snake: SnakeNode[], axis: Point, velocity: number) {
  let nextPosition: Point | null = null

  for (let i = 0; i < snake.length; i += 1) {
    const node = snake[i]
    const oldPosition = copyPoint(node)

    if (i === 0) {
      rotateAroundAxis(node, axis, velocity)
    } else if (nextPosition === null) {
      rotateAroundAxis(node, axis, velocity)
    } else {
      node.x = nextPosition.x
      node.y = nextPosition.y
      node.z = nextPosition.z
    }

    node.posQueue.unshift(oldPosition)
    nextPosition = node.posQueue.pop() ?? null
  }
}

function collision(a: Point, b: Point) {
  const dist = Math.sqrt(
    Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2) + Math.pow(a.z - b.z, 2),
  )
  return dist < COLLISION_DISTANCE
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function sanitizeName(name: string) {
  const cleaned = name.trim().replace(/\s+/g, ' ')
  if (cleaned.length === 0) return 'Player'
  return cleaned.slice(0, 20)
}

function parseAxis(value: unknown): Point | null {
  if (!value || typeof value !== 'object') return null
  const axis = value as { x?: unknown; y?: unknown; z?: unknown }
  const x = typeof axis.x === 'number' ? axis.x : NaN
  const y = typeof axis.y === 'number' ? axis.y : NaN
  const z = typeof axis.z === 'number' ? axis.z : NaN
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  const normalized = normalize({ x, y, z })
  if (length(normalized) === 0) return null
  return normalized
}

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
        const name = sanitizeName(String(message.name ?? 'Player'))
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
      score: 0,
      alive: true,
      connected: true,
      lastSeen: Date.now(),
      snake,
    }
  }

  private spawnSnake(baseAxis: Point): { snake: SnakeNode[]; axis: Point } {
    let snake: SnakeNode[] = []
    let axis = baseAxis

    for (let attempt = 0; attempt < 8; attempt += 1) {
      snake = this.createSnake(baseAxis)
      const theta = Math.random() * Math.PI * 2
      const phi = Math.PI - Math.random() * SPAWN_CONE_ANGLE
      const rotateYAngle = Math.PI - phi

      this.rotateSnake(snake, theta, rotateYAngle)
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

  private createSnake(axis: Point) {
    const snake: SnakeNode[] = []
    for (let i = 0; i < STARTING_LENGTH; i += 1) {
      addSnakeNode(snake, axis)
    }
    return snake
  }

  private rotateSnake(snake: SnakeNode[], zAngle: number, yAngle: number) {
    for (const node of snake) {
      rotateY(node, yAngle)
      rotateZ(node, zAngle)
      for (const queued of node.posQueue) {
        if (!queued) continue
        rotateY(queued, yAngle)
        rotateZ(queued, zAngle)
      }
    }
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

    for (const [id, player] of this.players) {
      if (!player.connected && now - player.lastSeen > PLAYER_TIMEOUT_MS) {
        this.players.delete(id)
        continue
      }
    }

    for (const player of this.players.values()) {
      if (!player.alive) continue
      player.axis = rotateToward(player.axis, player.targetAxis, TURN_RATE)
      const speed = BASE_SPEED * (player.boost ? BOOST_MULTIPLIER : 1)
      applySnakeRotation(player.snake, player.axis, speed)
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
        addSnakeNode(player.snake, player.axis)
        if (this.pellets.length < MAX_PELLETS) {
          this.pellets.push(pointFromSpherical(Math.random() * Math.PI * 2, Math.random() * Math.PI))
        }
      }
    }

    this.broadcastState()
  }

  private handleDeath(player: Player) {
    if (!player.alive) return
    player.alive = false
    player.respawnAt = Date.now() + RESPAWN_COOLDOWN_MS

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
    player.respawnAt = undefined
    player.snake = spawned.snake
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
        alive: player.alive,
        snake: player.snake.map(copyPoint),
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
