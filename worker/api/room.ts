import type { Env } from '../env'

export function handleRoom(request: Request, env: Env, room: string) {
  const id = env.GAME_ROOMS.idFromName(room)
  const stub = env.GAME_ROOMS.get(id)
  return stub.fetch(request)
}
