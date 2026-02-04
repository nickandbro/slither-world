export type Point = {
  x: number
  y: number
  z: number
}

export type SnakeNode = Point & {
  posQueue: Array<Point | null>
}

export type Digestion = {
  remaining: number
  total: number
  growthSteps: number
}

export type Player = {
  id: string
  name: string
  color: string
  axis: Point
  targetAxis: Point
  boost: boolean
  stamina: number
  score: number
  alive: boolean
  connected: boolean
  lastSeen: number
  respawnAt?: number
  snake: SnakeNode[]
  digestions: Digestion[]
}

export type Session = {
  socket: WebSocket
  playerId?: string
}

export type GameStateSnapshot = {
  now: number
  pellets: Point[]
  players: Array<{
    id: string
    name: string
    color: string
    score: number
    stamina: number
    alive: boolean
    snake: Point[]
    digestions: number[]
  }>
}
