import * as THREE from 'three'
import type { RenderPerfInfo } from './perf'

type DebugSnakeVisual = {
  tube: { material: { opacity: number } }
  head: { position: THREE.Vector3 }
  group: { visible: boolean }
  boostBodyGlowIntensity: number
  boostBodyGlowWaveCount: number
  boostBodyGlowMode: 'off' | 'sprite-wave'
}

type RendererInfo = {
  activeBackend: 'webgl'
  webglShaderHooksEnabled: boolean
}

type TerrainPatchInfo = {
  totalPatches: number
  visiblePatches: number
  patchBands: number
  patchSlices: number
  dynamicRebuilds: boolean
  wireframeEnabled: boolean
}

type EnvironmentCullInfo = {
  totalTrees: number
  visibleTrees: number
  totalCactuses: number
  visibleCactuses: number
  totalMountains: number
  visibleMountains: number
  totalPebbles: number
  visiblePebbles: number
  totalLakes: number
  visibleLakes: number
}

type SnakeGroundingInfoSnapshot = {
  minClearance: number
  maxPenetration: number
  maxAppliedLift: number
  sampleCount: number
}

type BoostDraftInfo = {
  visible: boolean
  opacity: number
  planeCount: number
}

type BoostBodyGlowInfo = {
  visible: boolean
  intensity: number
  waveCount: number
  backendMode: 'off' | 'sprite-wave'
}

type DayNightInfo = {
  mode: 'auto' | 'accelerated'
  phase: number
  dayFactor: number
  cycleMs: number
  sourceNowMs: number | null
}

export type SceneDebugApi = {
  getSnakeOpacity: (id: string) => number | null
  getSnakeHeadPosition: (id: string) => { x: number; y: number; z: number } | null
  getSnakeHeadForward: (id: string) => { x: number; y: number; z: number } | null
  isSnakeVisible: (id: string) => boolean | null
  getRendererInfo: () => RendererInfo
  getRenderPerfInfo: () => RenderPerfInfo
  getTerrainPatchInfo: () => TerrainPatchInfo
  getEnvironmentCullInfo: () => EnvironmentCullInfo
  getSnakeGroundingInfo: () => SnakeGroundingInfoSnapshot | null
  getSnakeIds: () => string[]
  getBoostDraftInfo: (id: string) => BoostDraftInfo | null
  getBoostBodyGlowInfo: (id: string) => BoostBodyGlowInfo | null
  getDayNightInfo: () => DayNightInfo
}

export type RegisterSceneDebugApiParams = {
  enabled: boolean
  snakes: Map<string, DebugSnakeVisual>
  lastForwardDirections: Map<string, THREE.Vector3>
  getRendererInfo: () => RendererInfo
  getRenderPerfInfo: () => RenderPerfInfo
  getTerrainPatchInfo: () => TerrainPatchInfo
  getEnvironmentCullInfo: () => EnvironmentCullInfo
  getSnakeGroundingInfo: () => SnakeGroundingInfoSnapshot | null
  getDayNightInfo: () => DayNightInfo
  boostBodyGlowMinActiveOpacity: number
}

export const registerSceneDebugApi = ({
  enabled,
  snakes,
  lastForwardDirections,
  getRendererInfo,
  getRenderPerfInfo,
  getTerrainPatchInfo,
  getEnvironmentCullInfo,
  getSnakeGroundingInfo,
  getDayNightInfo,
  boostBodyGlowMinActiveOpacity,
}: RegisterSceneDebugApiParams): SceneDebugApi | null => {
  if (!enabled || typeof window === 'undefined') return null
  const debugApi: SceneDebugApi = {
    getSnakeOpacity: (id: string) => {
      const visual = snakes.get(id)
      return visual ? visual.tube.material.opacity : null
    },
    getSnakeHeadPosition: (id: string) => {
      const visual = snakes.get(id)
      if (!visual) return null
      const pos = visual.head.position
      return { x: pos.x, y: pos.y, z: pos.z }
    },
    getSnakeHeadForward: (id: string) => {
      const forward = lastForwardDirections.get(id)
      if (!forward) return null
      const lenSq = forward.lengthSq()
      if (!(lenSq > 1e-10) || !Number.isFinite(lenSq)) return null
      const invLen = 1 / Math.sqrt(lenSq)
      return {
        x: forward.x * invLen,
        y: forward.y * invLen,
        z: forward.z * invLen,
      }
    },
    isSnakeVisible: (id: string) => {
      const visual = snakes.get(id)
      return visual ? visual.group.visible : null
    },
    getRendererInfo,
    getRenderPerfInfo,
    getTerrainPatchInfo,
    getEnvironmentCullInfo,
    getSnakeGroundingInfo,
    getSnakeIds: () => Array.from(snakes.keys()),
    getBoostDraftInfo: (id: string) => {
      const visual = snakes.get(id)
      if (!visual) return null
      return {
        visible: false,
        opacity: 0,
        planeCount: 0,
      }
    },
    getBoostBodyGlowInfo: (id: string) => {
      const visual = snakes.get(id)
      if (!visual) return null
      const intensity = Math.max(0, visual.boostBodyGlowIntensity)
      const backendMode =
        intensity > boostBodyGlowMinActiveOpacity
          ? visual.boostBodyGlowMode
          : 'off'
      return {
        visible: backendMode !== 'off',
        intensity,
        waveCount: Math.max(1, visual.boostBodyGlowWaveCount),
        backendMode,
      }
    },
    getDayNightInfo,
  }

  const debugWindow = window as Window & {
    __SNAKE_DEBUG__?: Record<string, unknown>
  }
  const existing =
    debugWindow.__SNAKE_DEBUG__ && typeof debugWindow.__SNAKE_DEBUG__ === 'object'
      ? debugWindow.__SNAKE_DEBUG__
      : {}
  debugWindow.__SNAKE_DEBUG__ = {
    ...existing,
    ...debugApi,
  }
  return debugApi
}
