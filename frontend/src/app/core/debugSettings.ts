import { readLocalStorage, writeLocalStorage } from '@shared/storage/localStorage'
import type { DayNightDebugMode } from '../../render/webglScene'

const MOUNTAIN_DEBUG_KEY = 'spherical_snake_mountain_debug'
const LAKE_DEBUG_KEY = 'spherical_snake_lake_debug'
const TREE_DEBUG_KEY = 'spherical_snake_tree_debug'
const TERRAIN_WIREFRAME_DEBUG_KEY = 'spherical_snake_terrain_wireframe_debug'
const TERRAIN_TESSELLATION_DEBUG_KEY_LEGACY = 'spherical_snake_terrain_tessellation_debug'
const DAY_NIGHT_DEBUG_MODE_KEY = 'spherical_snake_day_night_debug_mode'
const NET_DEBUG_KEY = 'spherical_snake_net_debug'
const TAIL_DEBUG_KEY = 'spherical_snake_tail_debug'

export const DEBUG_UI_ENABLED = import.meta.env.DEV || import.meta.env.VITE_E2E_DEBUG === '1'

export const getMountainDebug = () => {
  return readLocalStorage(MOUNTAIN_DEBUG_KEY) === '1'
}

export const getLakeDebug = () => {
  return readLocalStorage(LAKE_DEBUG_KEY) === '1'
}

export const getTreeDebug = () => {
  return readLocalStorage(TREE_DEBUG_KEY) === '1'
}

export const getTerrainTessellationDebug = () => {
  const wireframe = readLocalStorage(TERRAIN_WIREFRAME_DEBUG_KEY)
  if (wireframe !== null) return wireframe === '1'
  return readLocalStorage(TERRAIN_TESSELLATION_DEBUG_KEY_LEGACY) === '1'
}

export const getDayNightDebugMode = (): DayNightDebugMode => {
  const value = readLocalStorage(DAY_NIGHT_DEBUG_MODE_KEY)
  if (value === 'auto' || value === 'accelerated') return value
  return 'auto'
}

export const getNetDebugEnabled = () => {
  if (typeof window === 'undefined') return false
  try {
    const url = new URL(window.location.href)
    const host = url.hostname.toLowerCase()
    const queryValue = url.searchParams.get('netDebug')
    if (queryValue === '1') {
      writeLocalStorage(NET_DEBUG_KEY, '1')
      return true
    }
    if (queryValue === '0') {
      writeLocalStorage(NET_DEBUG_KEY, '0')
      return false
    }
    const stored = readLocalStorage(NET_DEBUG_KEY)
    if (stored === '1') return true
    if (stored === '0') return false

    // Default to enabled on localhost/loopback so local production-like copies
    // expose net debugging without extra flags.
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

export const getTailDebugEnabled = () => {
  if (typeof window === 'undefined') return false
  try {
    const url = new URL(window.location.href)
    const queryValue = url.searchParams.get('tailDebug')
    if (queryValue === '1') {
      writeLocalStorage(TAIL_DEBUG_KEY, '1')
      return true
    }
    if (queryValue === '0') {
      writeLocalStorage(TAIL_DEBUG_KEY, '0')
      return false
    }
    const stored = readLocalStorage(TAIL_DEBUG_KEY)
    if (stored === '1') return true
    if (stored === '0') return false
    return false
  } catch {
    return false
  }
}

export const persistDebugSettings = (settings: {
  mountainDebug: boolean
  lakeDebug: boolean
  treeDebug: boolean
  terrainTessellationDebug: boolean
}) => {
  writeLocalStorage(MOUNTAIN_DEBUG_KEY, settings.mountainDebug ? '1' : '0')
  writeLocalStorage(LAKE_DEBUG_KEY, settings.lakeDebug ? '1' : '0')
  writeLocalStorage(TREE_DEBUG_KEY, settings.treeDebug ? '1' : '0')
  writeLocalStorage(
    TERRAIN_WIREFRAME_DEBUG_KEY,
    settings.terrainTessellationDebug ? '1' : '0',
  )
}

export const persistDayNightDebugMode = (mode: DayNightDebugMode) => {
  writeLocalStorage(DAY_NIGHT_DEBUG_MODE_KEY, mode)
}
