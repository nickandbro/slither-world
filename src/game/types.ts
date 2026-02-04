export type Point = {
  x: number
  y: number
  z: number
}

export type PlayerSnapshot = {
  id: string
  name: string
  color: string
  score: number
  stamina: number
  alive: boolean
  snake: Point[]
  digestions: number[]
}

export type GameStateSnapshot = {
  now: number
  pellets: Point[]
  players: PlayerSnapshot[]
}

export type Quaternion = {
  x: number
  y: number
  z: number
  w: number
}

export type Camera = {
  q: Quaternion
  active: boolean
}
