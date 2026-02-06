export type Point = {
  x: number
  y: number
  z: number
}

export type DigestionSnapshot = {
  id: number
  progress: number
}

export type PlayerSnapshot = {
  id: string
  name: string
  color: string
  score: number
  stamina: number
  oxygen: number
  alive: boolean
  snakeDetail: 'full' | 'window' | 'stub'
  snakeStart: number
  snakeTotalLen: number
  snake: Point[]
  digestions: DigestionSnapshot[]
}

export type Lake = {
  center: Point
  radius: number
  depth: number
  shelfDepth: number
  edgeFalloff: number
  noiseAmplitude: number
  noiseFrequency: number
  noiseFrequencyB: number
  noiseFrequencyC: number
  noisePhase: number
  noisePhaseB: number
  noisePhaseC: number
  warpAmplitude: number
  surfaceInset: number
}

export type TreeInstance = {
  normal: Point
  widthScale: number
  heightScale: number
  twist: number
}

export type MountainInstance = {
  normal: Point
  radius: number
  height: number
  variant: number
  twist: number
  outline: number[]
}

export type Environment = {
  lakes: Lake[]
  trees: TreeInstance[]
  mountains: MountainInstance[]
}

export type GameStateSnapshot = {
  now: number
  pellets: Point[]
  players: PlayerSnapshot[]
  totalPlayers: number
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
