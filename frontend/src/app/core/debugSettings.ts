import type { DayNightDebugMode } from '../../render/webglScene'

const MOUNTAIN_DEBUG_KEY = 'spherical_snake_mountain_debug'
const LAKE_DEBUG_KEY = 'spherical_snake_lake_debug'
const TREE_DEBUG_KEY = 'spherical_snake_tree_debug'
const TERRAIN_WIREFRAME_DEBUG_KEY = 'spherical_snake_terrain_wireframe_debug'
const TERRAIN_TESSELLATION_DEBUG_KEY_LEGACY = 'spherical_snake_terrain_tessellation_debug'
const DAY_NIGHT_DEBUG_MODE_KEY = 'spherical_snake_day_night_debug_mode'
const NET_DEBUG_KEY = 'spherical_snake_net_debug'

export const DEBUG_UI_ENABLED = import.meta.env.DEV || import.meta.env.VITE_E2E_DEBUG === '1'

export const getMountainDebug = () => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(MOUNTAIN_DEBUG_KEY) === '1'
  } catch {
    return false
  }
}

export const getLakeDebug = () => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(LAKE_DEBUG_KEY) === '1'
  } catch {
    return false
  }
}

export const getTreeDebug = () => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(TREE_DEBUG_KEY) === '1'
  } catch {
    return false
  }
}

export const getTerrainTessellationDebug = () => {
  if (typeof window === 'undefined') return false
  try {
    const wireframe = window.localStorage.getItem(TERRAIN_WIREFRAME_DEBUG_KEY)
    if (wireframe !== null) return wireframe === '1'
    return window.localStorage.getItem(TERRAIN_TESSELLATION_DEBUG_KEY_LEGACY) === '1'
  } catch {
    return false
  }
}

export const getDayNightDebugMode = (): DayNightDebugMode => {
  if (typeof window === 'undefined') return 'auto'
  try {
    const value = window.localStorage.getItem(DAY_NIGHT_DEBUG_MODE_KEY)
    if (value === 'auto' || value === 'accelerated') return value
  } catch {
    // ignore persistence errors
  }
  return 'auto'
}

export const getNetDebugEnabled = () => {
  if (typeof window === 'undefined') return false
  try {
    const url = new URL(window.location.href)
    const host = url.hostname.toLowerCase()
    const queryValue = url.searchParams.get('netDebug')
    if (queryValue === '1') {
      window.localStorage.setItem(NET_DEBUG_KEY, '1')
      return true
    }
    if (queryValue === '0') {
      window.localStorage.setItem(NET_DEBUG_KEY, '0')
      return false
    }
    const stored = window.localStorage.getItem(NET_DEBUG_KEY)
    if (stored === '1') return true
    if (stored === '0') return false

    // Default to enabled on localhost/loopback so local production-like copies
    // expose net debugging without extra flags.
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
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
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(MOUNTAIN_DEBUG_KEY, settings.mountainDebug ? '1' : '0')
    window.localStorage.setItem(LAKE_DEBUG_KEY, settings.lakeDebug ? '1' : '0')
    window.localStorage.setItem(TREE_DEBUG_KEY, settings.treeDebug ? '1' : '0')
    window.localStorage.setItem(
      TERRAIN_WIREFRAME_DEBUG_KEY,
      settings.terrainTessellationDebug ? '1' : '0',
    )
  } catch {
    // ignore persistence errors
  }
}

export const persistDayNightDebugMode = (mode: DayNightDebugMode) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DAY_NIGHT_DEBUG_MODE_KEY, mode)
  } catch {
    // ignore persistence errors
  }
}
