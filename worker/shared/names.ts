export const MAX_PLAYER_NAME_LENGTH = 20

export function sanitizePlayerName(name: string, fallback = 'Player') {
  const cleaned = name.trim().replace(/\s+/g, ' ')
  if (!cleaned) return fallback
  return cleaned.slice(0, MAX_PLAYER_NAME_LENGTH)
}
