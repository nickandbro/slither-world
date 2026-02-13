import {
  registerSceneDebugApi,
  type RegisterSceneDebugApiParams,
  type SceneDebugApi,
} from './attachDebugApi'
import type { RenderPerfInfo } from './perf'
import { cloneRenderPerfInfo } from './perf'
import type { BoostTrailState } from '../snake/boostTrail'
import type { SnakeVisual } from '../runtimeTypes'

type RegisterRuntimeDebugDeps = {
  enabled: RegisterSceneDebugApiParams['enabled']
  snakes: Map<string, SnakeVisual>
  boostTrails: Map<string, BoostTrailState[]>
  lastForwardDirections: RegisterSceneDebugApiParams['lastForwardDirections']
  getRendererInfo: RegisterSceneDebugApiParams['getRendererInfo']
  renderPerfInfo: RenderPerfInfo
  getTerrainPatchInfo: RegisterSceneDebugApiParams['getTerrainPatchInfo']
  getEnvironmentCullInfo: RegisterSceneDebugApiParams['getEnvironmentCullInfo']
  getSnakeGroundingInfo: RegisterSceneDebugApiParams['getSnakeGroundingInfo']
  getDayNightInfo: RegisterSceneDebugApiParams['getDayNightInfo']
  boostBodyGlowMinActiveOpacity: RegisterSceneDebugApiParams['boostBodyGlowMinActiveOpacity']
}

export const registerRuntimeDebugApi = (deps: RegisterRuntimeDebugDeps): SceneDebugApi | null =>
  registerSceneDebugApi({
    enabled: deps.enabled,
    snakes: deps.snakes,
    boostTrails: deps.boostTrails,
    lastForwardDirections: deps.lastForwardDirections,
    getRendererInfo: deps.getRendererInfo,
    getRenderPerfInfo: () => cloneRenderPerfInfo(deps.renderPerfInfo),
    getTerrainPatchInfo: deps.getTerrainPatchInfo,
    getEnvironmentCullInfo: deps.getEnvironmentCullInfo,
    getSnakeGroundingInfo: deps.getSnakeGroundingInfo,
    getDayNightInfo: deps.getDayNightInfo,
    boostBodyGlowMinActiveOpacity: deps.boostBodyGlowMinActiveOpacity,
  })
