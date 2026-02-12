import * as THREE from 'three'
import type { DayNightDebugMode } from '../runtimeTypes'
import {
  DAY_LIGHT_COLOR,
  DAY_NIGHT_CELESTIAL_BLEND_END,
  DAY_NIGHT_CELESTIAL_BLEND_START,
  DAY_NIGHT_CELESTIAL_ORBIT_BASE_Y,
  DAY_NIGHT_CELESTIAL_ORBIT_X,
  DAY_NIGHT_CELESTIAL_ORBIT_Y,
  DAY_NIGHT_CELESTIAL_ORBIT_Z,
  DAY_NIGHT_CELESTIAL_RIM_OFFSET_PX,
  DAY_NIGHT_CELESTIAL_SAFE_MARGIN_PX,
  DAY_NIGHT_CYCLE_ACCELERATED_MS,
  DAY_NIGHT_CYCLE_MS,
  DAY_NIGHT_DAY_EDGE_END,
  DAY_NIGHT_DAY_EDGE_START,
  DAY_NIGHT_EXPOSURE_DAY,
  DAY_NIGHT_EXPOSURE_NIGHT,
  DAY_NIGHT_HORIZON_DEPTH,
  DAY_NIGHT_HORIZON_MAX_OPACITY,
  DAY_NIGHT_HORIZON_MIN_OPACITY,
  DAY_NIGHT_HORIZON_SCALE,
  DAY_NIGHT_MOON_GLOW_SIZE,
  DAY_NIGHT_SUN_GLOW_SIZE,
  DAY_NIGHT_STAR_EDGE_END,
  DAY_NIGHT_STAR_EDGE_START,
  DAY_NIGHT_STAR_TWINKLE_SPEED,
  DAY_NIGHT_TAU,
  HORIZON_DAY_COLOR,
  HORIZON_NIGHT_COLOR,
  MOON_CORE_COLOR,
  MOON_GLOW_COLOR,
  NIGHT_LIGHT_COLOR,
  NIGHT_RIM_COLOR,
  PLANET_RADIUS,
  SKY_DAY_BOTTOM_COLOR,
  SKY_DAY_HORIZON_COLOR,
  SKY_DAY_TOP_COLOR,
  SKY_NIGHT_BOTTOM_COLOR,
  SKY_NIGHT_HORIZON_COLOR,
  SKY_NIGHT_TOP_COLOR,
  SUN_CORE_COLOR,
  SUN_GLOW_COLOR,
  WORLD_RIGHT,
  WORLD_UP,
} from '../constants'
import { clamp, lerp, smoothstep } from '../utils/math'
import type { SkyGradientTexture } from '../utils/texture'
import { paintSkyGradientTexture } from '../utils/texture'

type DayNightState = {
  dayNightDebugMode: DayNightDebugMode
  dayNightPhase: number
  dayNightFactor: number
  dayNightCycleMs: number
  dayNightSourceNowMs: number | null
  lastSkyGradientFactor: number
  lastPlanetScreenCenterX: number
  lastPlanetScreenCenterY: number
  lastPlanetScreenRadiusPx: number
}

type ViewportState = {
  width: number
  height: number
}

type CreateDayNightRuntimeOptions = {
  state: DayNightState
  viewportState: ViewportState
  camera: THREE.PerspectiveCamera
  renderer: { toneMappingExposure: number }
  ambient: THREE.AmbientLight
  keyLight: THREE.DirectionalLight
  rimLight: THREE.DirectionalLight
  skyGradient: SkyGradientTexture | null
  skyTopTemp: THREE.Color
  skyHorizonTemp: THREE.Color
  skyBottomTemp: THREE.Color
  horizonColorTemp: THREE.Color
  horizonMaterial: THREE.SpriteMaterial
  horizonSprite: THREE.Sprite
  starsMaterial: THREE.PointsMaterial
  starsMesh: THREE.Points
  sunCoreMaterial: THREE.SpriteMaterial
  sunGlowMaterial: THREE.SpriteMaterial
  moonCoreMaterial: THREE.SpriteMaterial
  moonGlowMaterial: THREE.SpriteMaterial
  sunGroup: THREE.Group
  moonGroup: THREE.Group
  tempVectorD: THREE.Vector3
  tempVectorE: THREE.Vector3
  tempVectorF: THREE.Vector3
  tempVectorG: THREE.Vector3
  tempVectorH: THREE.Vector3
}

type DayNightRuntime = {
  resolveDayFactor: (sourceNowMs: number) => number
  projectScreenToCamera: (
    xPx: number,
    yPx: number,
    depth: number,
    out: THREE.Vector3,
  ) => THREE.Vector3
  computePlanetScreenInfo: () => {
    centerX: number
    centerY: number
    radiusPx: number
  }
  updateDayNightVisuals: (sourceNowMs: number) => void
}

export const createDayNightRuntime = (
  options: CreateDayNightRuntimeOptions,
): DayNightRuntime => {
  const {
    state,
    viewportState,
    camera,
    renderer,
    ambient,
    keyLight,
    rimLight,
    skyGradient,
    skyTopTemp,
    skyHorizonTemp,
    skyBottomTemp,
    horizonColorTemp,
    horizonMaterial,
    horizonSprite,
    starsMaterial,
    starsMesh,
    sunCoreMaterial,
    sunGlowMaterial,
    moonCoreMaterial,
    moonGlowMaterial,
    sunGroup,
    moonGroup,
    tempVectorD,
    tempVectorE,
    tempVectorF,
    tempVectorG,
    tempVectorH,
  } = options

  const resolveDayFactor = (sourceNowMs: number) => {
    state.dayNightCycleMs =
      state.dayNightDebugMode === 'accelerated'
        ? DAY_NIGHT_CYCLE_ACCELERATED_MS
        : DAY_NIGHT_CYCLE_MS
    const wrapped =
      ((sourceNowMs % state.dayNightCycleMs) + state.dayNightCycleMs) % state.dayNightCycleMs
    state.dayNightPhase = wrapped / state.dayNightCycleMs
    const daylightWave = Math.sin(state.dayNightPhase * DAY_NIGHT_TAU - Math.PI * 0.5) * 0.5 + 0.5
    state.dayNightFactor = smoothstep(DAY_NIGHT_DAY_EDGE_START, DAY_NIGHT_DAY_EDGE_END, daylightWave)
    return state.dayNightFactor
  }

  const projectScreenToCamera = (
    xPx: number,
    yPx: number,
    depth: number,
    out: THREE.Vector3,
  ) => {
    const viewportWidth = viewportState.width
    const viewportHeight = viewportState.height
    const safeDepth = Math.max(0.001, Math.abs(depth))
    if (viewportWidth <= 1 || viewportHeight <= 1) {
      out.set(0, 0, -safeDepth)
      return out
    }
    const ndcX = (xPx / viewportWidth) * 2 - 1
    const ndcY = 1 - (yPx / viewportHeight) * 2
    const halfFov = THREE.MathUtils.degToRad(camera.fov) * 0.5
    const tanHalf = Math.tan(halfFov)
    out.set(ndcX * safeDepth * tanHalf * camera.aspect, ndcY * safeDepth * tanHalf, -safeDepth)
    return out
  }

  const computePlanetScreenInfo = () => {
    const viewportWidth = viewportState.width
    const viewportHeight = viewportState.height
    const safeWidth = Math.max(1, viewportWidth)
    const safeHeight = Math.max(1, viewportHeight)
    const fallbackCenterX = state.lastPlanetScreenCenterX * safeWidth
    const fallbackCenterY = state.lastPlanetScreenCenterY * safeHeight
    const fallbackRadius = clamp(
      state.lastPlanetScreenRadiusPx,
      Math.min(safeWidth, safeHeight) * 0.08,
      Math.max(safeWidth, safeHeight) * 0.95,
    )

    const centerNdc = tempVectorD.set(0, 0, 0).project(camera)
    if (!Number.isFinite(centerNdc.x) || !Number.isFinite(centerNdc.y) || !Number.isFinite(centerNdc.z)) {
      return {
        centerX: fallbackCenterX,
        centerY: fallbackCenterY,
        radiusPx: fallbackRadius,
      }
    }

    const centerX = (centerNdc.x * 0.5 + 0.5) * safeWidth
    const centerY = (-centerNdc.y * 0.5 + 0.5) * safeHeight
    let radiusPx = fallbackRadius

    const centerDistance = camera.position.length()
    if (centerDistance > PLANET_RADIUS + 1e-4) {
      tempVectorE.copy(camera.position).multiplyScalar(-1)
      tempVectorF.copy(tempVectorE).cross(WORLD_UP)
      if (tempVectorF.lengthSq() <= 1e-8) {
        tempVectorF.copy(tempVectorE).cross(WORLD_RIGHT)
      }
      if (tempVectorF.lengthSq() > 1e-8) {
        tempVectorF.normalize().multiplyScalar(PLANET_RADIUS)
        const rimNdc = tempVectorG.copy(tempVectorF).project(camera)
        if (Number.isFinite(rimNdc.x) && Number.isFinite(rimNdc.y)) {
          const dxPx = (rimNdc.x - centerNdc.x) * safeWidth * 0.5
          const dyPx = (rimNdc.y - centerNdc.y) * safeHeight * 0.5
          radiusPx = Math.hypot(dxPx, dyPx)
        }
      }

      if (!Number.isFinite(radiusPx) || radiusPx <= 0) {
        const halfFov = THREE.MathUtils.degToRad(camera.fov) * 0.5
        const focalPx = (safeHeight * 0.5) / Math.tan(halfFov)
        radiusPx = (PLANET_RADIUS / centerDistance) * focalPx
      }
    }

    if (Number.isFinite(centerX) && Number.isFinite(centerY) && Number.isFinite(radiusPx) && radiusPx > 1) {
      state.lastPlanetScreenCenterX = centerX / safeWidth
      state.lastPlanetScreenCenterY = centerY / safeHeight
      state.lastPlanetScreenRadiusPx = radiusPx
      return { centerX, centerY, radiusPx }
    }

    return {
      centerX: fallbackCenterX,
      centerY: fallbackCenterY,
      radiusPx: fallbackRadius,
    }
  }

  const updateDayNightVisuals = (sourceNowMs: number) => {
    state.dayNightSourceNowMs = sourceNowMs
    const dayFactor = resolveDayFactor(sourceNowMs)
    const nightFactor = 1 - dayFactor
    const starFactor = smoothstep(
      DAY_NIGHT_STAR_EDGE_START,
      DAY_NIGHT_STAR_EDGE_END,
      nightFactor,
    )

    skyTopTemp.lerpColors(SKY_NIGHT_TOP_COLOR, SKY_DAY_TOP_COLOR, dayFactor)
    skyHorizonTemp.lerpColors(SKY_NIGHT_HORIZON_COLOR, SKY_DAY_HORIZON_COLOR, dayFactor)
    skyBottomTemp.lerpColors(SKY_NIGHT_BOTTOM_COLOR, SKY_DAY_BOTTOM_COLOR, dayFactor)
    if (
      skyGradient &&
      (!Number.isFinite(state.lastSkyGradientFactor) ||
        Math.abs(state.lastSkyGradientFactor - dayFactor) > 0.004)
    ) {
      paintSkyGradientTexture(skyGradient, skyTopTemp, skyHorizonTemp, skyBottomTemp)
      state.lastSkyGradientFactor = dayFactor
    }

    ambient.intensity = lerp(0.26, 0.68, dayFactor)
    keyLight.intensity = lerp(0.14, 0.5, dayFactor)
    rimLight.intensity = lerp(0.12, 0.3, dayFactor)
    keyLight.color.lerpColors(NIGHT_LIGHT_COLOR, DAY_LIGHT_COLOR, dayFactor)
    rimLight.color.lerpColors(NIGHT_RIM_COLOR, HORIZON_DAY_COLOR, dayFactor)
    renderer.toneMappingExposure = lerp(DAY_NIGHT_EXPOSURE_NIGHT, DAY_NIGHT_EXPOSURE_DAY, dayFactor)

    const twinkle =
      0.88 + 0.12 * Math.sin(sourceNowMs * 0.001 * DAY_NIGHT_STAR_TWINKLE_SPEED)
    const starsOpacity = clamp(starFactor * twinkle, 0, 1)
    starsMaterial.opacity = starsOpacity
    starsMesh.visible = starsOpacity > 0.001

    const { centerX, centerY, radiusPx } = computePlanetScreenInfo()
    const safeWidth = Math.max(1, viewportState.width)
    const safeHeight = Math.max(1, viewportState.height)
    const halfFov = THREE.MathUtils.degToRad(camera.fov) * 0.5
    const tanHalf = Math.tan(halfFov)
    const sunDepth = Math.abs(DAY_NIGHT_CELESTIAL_ORBIT_Z)
    const moonDepth = Math.abs(DAY_NIGHT_CELESTIAL_ORBIT_Z + 0.2)
    const pixelsPerUnitAtSunDepth = (safeHeight * 0.5) / Math.max(0.001, tanHalf * sunDepth)
    const sunSpriteRadiusPx = DAY_NIGHT_SUN_GLOW_SIZE * pixelsPerUnitAtSunDepth * 0.5
    const moonSpriteRadiusPx = DAY_NIGHT_MOON_GLOW_SIZE * pixelsPerUnitAtSunDepth * 0.5

    const baseRimRadius = Math.max(1, radiusPx + DAY_NIGHT_CELESTIAL_RIM_OFFSET_PX)
    const orbitTheta = state.dayNightPhase * DAY_NIGHT_TAU - Math.PI * 0.5
    const orbitScaleX = DAY_NIGHT_CELESTIAL_ORBIT_X / 3.7
    const orbitScaleY = DAY_NIGHT_CELESTIAL_ORBIT_Y / 3.3
    const ellipseX = Math.cos(orbitTheta) * orbitScaleX
    const ellipseY = Math.sin(orbitTheta) * orbitScaleY

    const placeOnRim = (
      seedX: number,
      seedY: number,
      spriteRadiusPx: number,
      phaseX: number,
      phaseY: number,
    ) => {
      let x = seedX
      let y = seedY
      const margin = DAY_NIGHT_CELESTIAL_SAFE_MARGIN_PX + spriteRadiusPx
      x = clamp(x, margin, safeWidth - margin)
      y = clamp(y, margin, safeHeight - margin)
      const dx = x - centerX
      const dy = y - centerY
      const dist = Math.hypot(dx, dy)
      const minDist = radiusPx + spriteRadiusPx + 10
      if (dist < minDist) {
        const ux = dist > 1e-4 ? dx / dist : phaseX
        const uy = dist > 1e-4 ? dy / dist : phaseY
        x = centerX + ux * minDist
        y = centerY + uy * minDist
        x = clamp(x, margin, safeWidth - margin)
        y = clamp(y, margin, safeHeight - margin)
      }
      return { x, y }
    }

    const sunSeedX = centerX + ellipseX * baseRimRadius
    const sunSeedY = centerY + ellipseY * baseRimRadius
    const sunPos = placeOnRim(sunSeedX, sunSeedY, sunSpriteRadiusPx, ellipseX, ellipseY)
    const moonSeedX = centerX - ellipseX * baseRimRadius
    const moonSeedY = centerY - ellipseY * baseRimRadius + DAY_NIGHT_CELESTIAL_ORBIT_BASE_Y * 10
    const moonPos = placeOnRim(moonSeedX, moonSeedY, moonSpriteRadiusPx, -ellipseX, -ellipseY)

    projectScreenToCamera(sunPos.x, sunPos.y, sunDepth, tempVectorG)
    sunGroup.position.copy(tempVectorG)
    projectScreenToCamera(moonPos.x, moonPos.y, moonDepth, tempVectorH)
    moonGroup.position.copy(tempVectorH)

    const horizonDay = smoothstep(0.18, 0.82, dayFactor)
    const unitsPerPixelAtHorizonDepth =
      (Math.max(0.001, DAY_NIGHT_HORIZON_DEPTH) * tanHalf * 2) / safeHeight
    const horizonDiameterPx = Math.max(2, radiusPx * DAY_NIGHT_HORIZON_SCALE * 2)
    const horizonScale = horizonDiameterPx * unitsPerPixelAtHorizonDepth
    projectScreenToCamera(centerX, centerY, DAY_NIGHT_HORIZON_DEPTH, tempVectorF)
    horizonSprite.position.copy(tempVectorF)
    horizonSprite.scale.set(horizonScale, horizonScale, 1)
    horizonColorTemp.lerpColors(HORIZON_NIGHT_COLOR, HORIZON_DAY_COLOR, dayFactor)
    horizonMaterial.color.copy(horizonColorTemp)
    horizonMaterial.opacity = lerp(
      DAY_NIGHT_HORIZON_MIN_OPACITY,
      DAY_NIGHT_HORIZON_MAX_OPACITY,
      horizonDay,
    )
    horizonSprite.visible = horizonMaterial.opacity > 0.001

    const blendT = smoothstep(
      DAY_NIGHT_CELESTIAL_BLEND_START,
      DAY_NIGHT_CELESTIAL_BLEND_END,
      dayFactor,
    )
    const sunBaseOpacity = smoothstep(0.08, 0.4, dayFactor)
    const moonBaseOpacity = smoothstep(0.08, 0.5, nightFactor)
    const sunOpacity = sunBaseOpacity * blendT
    const moonOpacity = moonBaseOpacity * (1 - blendT)
    sunCoreMaterial.opacity = sunOpacity
    sunGlowMaterial.opacity = sunOpacity * 0.65
    moonCoreMaterial.opacity = moonOpacity
    moonGlowMaterial.opacity = moonOpacity * 0.55
    sunGroup.visible = sunOpacity > 0.001
    moonGroup.visible = moonOpacity > 0.001

    sunCoreMaterial.color.copy(SUN_CORE_COLOR)
    sunGlowMaterial.color.copy(SUN_GLOW_COLOR)
    moonCoreMaterial.color.copy(MOON_CORE_COLOR)
    moonGlowMaterial.color.copy(MOON_GLOW_COLOR)
  }

  return {
    resolveDayFactor,
    projectScreenToCamera,
    computePlanetScreenInfo,
    updateDayNightVisuals,
  }
}
