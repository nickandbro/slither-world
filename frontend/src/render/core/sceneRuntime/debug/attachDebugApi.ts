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

type DebugBoostTrailState = {
  samples: Array<{ createdAt: number }>
  boosting: boolean
  retiring: boolean
  retireCut: number
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

type BoostTrailInfo = {
  sampleCount: number
  boosting: boolean
  retiring: boolean
  oldestAgeMs: number
  newestAgeMs: number
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
  getBoostTrailInfo: (id: string) => BoostTrailInfo | null
  getBoostDraftInfo: (id: string) => BoostDraftInfo | null
  getBoostBodyGlowInfo: (id: string) => BoostBodyGlowInfo | null
  getDayNightInfo: () => DayNightInfo
}

export type RegisterSceneDebugApiParams = {
  enabled: boolean
  snakes: Map<string, DebugSnakeVisual>
  boostTrails: Map<string, DebugBoostTrailState[]>
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
  boostTrails,
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
    getBoostTrailInfo: (id: string) => {
      const trails = boostTrails.get(id)
      if (!trails || trails.length === 0) return null
      const nowMs = performance.now()
      let sampleCount = 0
      let boosting = false
      let retiring = false
      let oldestCreatedAt = Number.POSITIVE_INFINITY
      let newestCreatedAt = 0
      for (const trail of trails) {
        const visibleRatio = trail.retiring ? Math.max(0, 1 - trail.retireCut) : 1
        sampleCount += Math.ceil(trail.samples.length * visibleRatio)
        boosting = boosting || trail.boosting
        retiring = retiring || trail.retiring
        const oldest = trail.samples[0]
        const newest = trail.samples[trail.samples.length - 1]
        if (oldest && oldest.createdAt < oldestCreatedAt) {
          oldestCreatedAt = oldest.createdAt
        }
        if (newest && newest.createdAt > newestCreatedAt) {
          newestCreatedAt = newest.createdAt
        }
      }
      const hasSamples = sampleCount > 0
      return {
        sampleCount,
        boosting,
        retiring,
        oldestAgeMs: hasSamples ? Math.max(0, nowMs - oldestCreatedAt) : 0,
        newestAgeMs: hasSamples ? Math.max(0, nowMs - newestCreatedAt) : 0,
      }
    },
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
