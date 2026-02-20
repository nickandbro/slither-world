import {
  readLocalStorage,
  writeLocalStorage,
} from '@shared/storage/localStorage'

const LOCAL_STORAGE_ID = 'spherical_snake_player_id'
const LOCAL_STORAGE_NAME = 'spherical_snake_player_name'
const LOCAL_STORAGE_ROOM = 'spherical_snake_room'

export const DEFAULT_ROOM = 'main'
const MAX_ROOM_NAME_LENGTH = 64

export function createRandomPlayerName() {
  return `Player-${Math.floor(Math.random() * 999) + 1}`
}

export function getInitialName() {
  const stored = readLocalStorage(LOCAL_STORAGE_NAME)
  if (stored) return stored
  const fallback = createRandomPlayerName()
  writeLocalStorage(LOCAL_STORAGE_NAME, fallback)
  return fallback
}

export function getStoredPlayerId() {
  return readLocalStorage(LOCAL_STORAGE_ID)
}

export function sanitizeRoomName(value: string) {
  const cleaned = value.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, '')
  if (!cleaned) return DEFAULT_ROOM
  return cleaned.slice(0, MAX_ROOM_NAME_LENGTH)
}

export function getInitialRoom() {
  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get('room')
  const stored = readLocalStorage(LOCAL_STORAGE_ROOM)
  return sanitizeRoomName(fromUrl ?? stored ?? DEFAULT_ROOM)
}

export function storePlayerName(name: string) {
  writeLocalStorage(LOCAL_STORAGE_NAME, name)
}

export function storeRoomName(roomName: string) {
  writeLocalStorage(LOCAL_STORAGE_ROOM, roomName)
}

export function storePlayerId(playerId: string) {
  writeLocalStorage(LOCAL_STORAGE_ID, playerId)
}
