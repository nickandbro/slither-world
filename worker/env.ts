import type { GameRoom } from './game/room'

export interface Env {
  DB: D1Database
  GAME_ROOMS: DurableObjectNamespace<GameRoom>
  ASSETS: Fetcher
}
