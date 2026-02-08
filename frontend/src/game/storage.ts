const LOCAL_STORAGE_ID = 'spherical_snake_player_id'
const LOCAL_STORAGE_NAME = 'spherical_snake_player_name'
const LOCAL_STORAGE_BEST = 'spherical_snake_best_score'
const LOCAL_STORAGE_ROOM = 'spherical_snake_room'
const LOCAL_STORAGE_RENDERER = 'spherical_snake_renderer'

export const DEFAULT_ROOM = 'main'
export const DEFAULT_RENDERER = 'auto'
export type RendererPreference = 'auto' | 'webgl' | 'webgpu'
const MAX_ROOM_NAME_LENGTH = 64

export function createRandomPlayerName() {
  return `Player-${Math.floor(Math.random() * 999) + 1}`
}

export function sanitizeRendererPreference(value: string | null | undefined): RendererPreference {
  if (value === 'webgl' || value === 'webgpu' || value === 'auto') {
    return value
  }
  return DEFAULT_RENDERER
}

export function getInitialName() {
  const stored = localStorage.getItem(LOCAL_STORAGE_NAME)
  if (stored) return stored
  const fallback = createRandomPlayerName()
  localStorage.setItem(LOCAL_STORAGE_NAME, fallback)
  return fallback
}

export function getStoredBestScore() {
  const value = localStorage.getItem(LOCAL_STORAGE_BEST)
  if (!value) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function getStoredPlayerId() {
  return localStorage.getItem(LOCAL_STORAGE_ID)
}

export function sanitizeRoomName(value: string) {
  const cleaned = value.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, '')
  if (!cleaned) return DEFAULT_ROOM
  return cleaned.slice(0, MAX_ROOM_NAME_LENGTH)
}

export function getInitialRoom() {
  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get('room')
  const stored = localStorage.getItem(LOCAL_STORAGE_ROOM)
  return sanitizeRoomName(fromUrl ?? stored ?? DEFAULT_ROOM)
}

export function getStoredRendererPreference() {
  const value = localStorage.getItem(LOCAL_STORAGE_RENDERER)
  return sanitizeRendererPreference(value)
}

export function getInitialRendererPreference() {
  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get('renderer')
  if (fromUrl) {
    return sanitizeRendererPreference(fromUrl)
  }
  return getStoredRendererPreference()
}

export function storePlayerName(name: string) {
  localStorage.setItem(LOCAL_STORAGE_NAME, name)
}

export function storeBestScore(score: number) {
  localStorage.setItem(LOCAL_STORAGE_BEST, String(score))
}

export function storeRoomName(roomName: string) {
  localStorage.setItem(LOCAL_STORAGE_ROOM, roomName)
}

export function storePlayerId(playerId: string) {
  localStorage.setItem(LOCAL_STORAGE_ID, playerId)
}

export function storeRendererPreference(renderer: RendererPreference) {
  localStorage.setItem(LOCAL_STORAGE_RENDERER, renderer)
}
