import { resolveApiUrl } from './backend'

export type MatchmakeResponse = {
  roomId: string
  roomToken: string
  capacity: number
  expiresAt: number
}

type MatchmakeRequest = {
  preferredRoom?: string
}

export async function requestMatchmake(preferredRoom?: string): Promise<MatchmakeResponse> {
  const body: MatchmakeRequest = {}
  if (preferredRoom && preferredRoom.trim()) {
    body.preferredRoom = preferredRoom.trim()
  }
  const response = await fetch(resolveApiUrl('/api/matchmake'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`Matchmake request failed (${response.status})`)
  }
  return (await response.json()) as MatchmakeResponse
}
