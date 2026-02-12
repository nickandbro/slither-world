const hasWindow = () => typeof window !== 'undefined'

export const readLocalStorage = (key: string): string | null => {
  if (!hasWindow()) return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export const writeLocalStorage = (key: string, value: string): boolean => {
  if (!hasWindow()) return false
  try {
    window.localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export const removeLocalStorage = (key: string): boolean => {
  if (!hasWindow()) return false
  try {
    window.localStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}

export const readLocalStorageJson = <T>(key: string): T | null => {
  const value = readLocalStorage(key)
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

export const readLocalStorageBool = (key: string, fallback: boolean): boolean => {
  const value = readLocalStorage(key)
  if (value === '1') return true
  if (value === '0') return false
  return fallback
}

export const readLocalStorageNumber = (
  key: string,
  fallback: number,
  options?: { min?: number; max?: number },
): number => {
  const value = readLocalStorage(key)
  if (value === null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const min = options?.min
  const max = options?.max
  let next = parsed
  if (typeof min === 'number') next = Math.max(min, next)
  if (typeof max === 'number') next = Math.min(max, next)
  return next
}
