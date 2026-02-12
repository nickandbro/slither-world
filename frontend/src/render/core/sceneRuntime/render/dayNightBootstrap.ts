import * as THREE from 'three'
import * as SCENE_CONSTANTS from '../constants'
import type { DayNightDebugMode } from '../runtimeTypes'
import { createSeededRandom } from '../utils/math'
import {
  createHorizonScatteringTexture,
  createMoonTextureFromAsset,
  createPelletRadialTexture,
  createSkyGradientTexture,
} from '../utils/texture'

export type DayNightBootstrap = {
  dayNightState: {
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
  getDayNightInfo: () => {
    mode: DayNightDebugMode
    phase: number
    dayFactor: number
    cycleMs: number
    sourceNowMs: number | null
  }
  setDayNightDebugMode: (mode: DayNightDebugMode) => void
  skyGroup: THREE.Group
  skyGradient: ReturnType<typeof createSkyGradientTexture>
  skyTopTemp: THREE.Color
  skyHorizonTemp: THREE.Color
  skyBottomTemp: THREE.Color
  horizonColorTemp: THREE.Color
  skyDomeGeometry: THREE.SphereGeometry
  skyDomeMaterial: THREE.MeshBasicMaterial
  starsGeometry: THREE.BufferGeometry
  starsMaterial: THREE.PointsMaterial
  starsMesh: THREE.Points
  starTexture: THREE.CanvasTexture | null
  horizonTexture: THREE.CanvasTexture | null
  horizonMaterial: THREE.SpriteMaterial
  horizonSprite: THREE.Sprite
  sunTexture: THREE.CanvasTexture | null
  sunGlowTexture: THREE.CanvasTexture | null
  moonTexture: THREE.CanvasTexture | null
  moonGlowTexture: THREE.CanvasTexture | null
  sunCoreMaterial: THREE.SpriteMaterial
  sunGlowMaterial: THREE.SpriteMaterial
  moonCoreMaterial: THREE.SpriteMaterial
  moonGlowMaterial: THREE.SpriteMaterial
  sunGroup: THREE.Group
  moonGroup: THREE.Group
}

export const createDayNightBootstrap = async (
  camera: THREE.PerspectiveCamera,
  webglShaderHooksEnabled: boolean,
): Promise<DayNightBootstrap> => {
  let dayNightDebugMode: DayNightDebugMode = 'auto'
  let dayNightPhase = 0
  let dayNightFactor = 1
  let dayNightCycleMs = SCENE_CONSTANTS.DAY_NIGHT_CYCLE_MS
  let dayNightSourceNowMs: number | null = null
  let lastSkyGradientFactor = Number.NaN
  let lastPlanetScreenCenterX = 0.5
  let lastPlanetScreenCenterY = 0.5
  let lastPlanetScreenRadiusPx = 240
  const dayNightState = {
    get dayNightDebugMode() {
      return dayNightDebugMode
    },
    set dayNightDebugMode(value: DayNightDebugMode) {
      dayNightDebugMode = value
    },
    get dayNightPhase() {
      return dayNightPhase
    },
    set dayNightPhase(value: number) {
      dayNightPhase = value
    },
    get dayNightFactor() {
      return dayNightFactor
    },
    set dayNightFactor(value: number) {
      dayNightFactor = value
    },
    get dayNightCycleMs() {
      return dayNightCycleMs
    },
    set dayNightCycleMs(value: number) {
      dayNightCycleMs = value
    },
    get dayNightSourceNowMs() {
      return dayNightSourceNowMs
    },
    set dayNightSourceNowMs(value: number | null) {
      dayNightSourceNowMs = value
    },
    get lastSkyGradientFactor() {
      return lastSkyGradientFactor
    },
    set lastSkyGradientFactor(value: number) {
      lastSkyGradientFactor = value
    },
    get lastPlanetScreenCenterX() {
      return lastPlanetScreenCenterX
    },
    set lastPlanetScreenCenterX(value: number) {
      lastPlanetScreenCenterX = value
    },
    get lastPlanetScreenCenterY() {
      return lastPlanetScreenCenterY
    },
    set lastPlanetScreenCenterY(value: number) {
      lastPlanetScreenCenterY = value
    },
    get lastPlanetScreenRadiusPx() {
      return lastPlanetScreenRadiusPx
    },
    set lastPlanetScreenRadiusPx(value: number) {
      lastPlanetScreenRadiusPx = value
    },
  }

  const skyGroup = new THREE.Group()
  skyGroup.renderOrder = -50
  camera.add(skyGroup)

  const skyTopTemp = new THREE.Color()
  const skyHorizonTemp = new THREE.Color()
  const skyBottomTemp = new THREE.Color()
  const horizonColorTemp = new THREE.Color()

  const skyGradient = createSkyGradientTexture(SCENE_CONSTANTS.DAY_NIGHT_SKY_TEXTURE_SIZE)
  const skyDomeGeometry = new THREE.SphereGeometry(SCENE_CONSTANTS.DAY_NIGHT_SKY_RADIUS, 48, 32)
  const skyDomeMaterial = new THREE.MeshBasicMaterial({
    map: skyGradient?.texture ?? null,
    color: '#ffffff',
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })
  const skyDome = new THREE.Mesh(skyDomeGeometry, skyDomeMaterial)
  skyDome.renderOrder = -50
  skyDome.frustumCulled = false
  skyGroup.add(skyDome)

  const horizonTexture = createHorizonScatteringTexture()
  const horizonMaterial = new THREE.SpriteMaterial({
    map: horizonTexture ?? null,
    color: SCENE_CONSTANTS.HORIZON_DAY_COLOR.clone(),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })
  const horizonSprite = new THREE.Sprite(horizonMaterial)
  horizonSprite.renderOrder = -49
  horizonSprite.frustumCulled = false
  skyGroup.add(horizonSprite)

  const starsGeometry = new THREE.BufferGeometry()
  const starPositions = new Float32Array(SCENE_CONSTANTS.DAY_NIGHT_STAR_COUNT * 3)
  const starRandom = createSeededRandom(0x4f23d19a)
  for (let i = 0; i < SCENE_CONSTANTS.DAY_NIGHT_STAR_COUNT; i += 1) {
    const z = starRandom() * 2 - 1
    const theta = starRandom() * SCENE_CONSTANTS.DAY_NIGHT_TAU
    const radial = Math.sqrt(Math.max(0, 1 - z * z))
    const radius = SCENE_CONSTANTS.DAY_NIGHT_STAR_RADIUS * (0.95 + starRandom() * 0.08)
    const offset = i * 3
    starPositions[offset] = Math.cos(theta) * radial * radius
    starPositions[offset + 1] = z * radius
    starPositions[offset + 2] = Math.sin(theta) * radial * radius
  }
  starsGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))

  const starTexture = webglShaderHooksEnabled
    ? createPelletRadialTexture(96, [
        { offset: 0, color: 'rgba(255,255,255,1)' },
        { offset: 0.75, color: 'rgba(255,255,255,0.4)' },
        { offset: 1, color: 'rgba(255,255,255,0)' },
      ])
    : null
  const starsMaterial = new THREE.PointsMaterial({
    color: '#f3f8ff',
    size: SCENE_CONSTANTS.DAY_NIGHT_STAR_SIZE,
    transparent: true,
    opacity: 0,
    map: starTexture,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    sizeAttenuation: true,
  })
  const starsMesh = new THREE.Points(starsGeometry, starsMaterial)
  starsMesh.frustumCulled = false
  starsMesh.renderOrder = -49
  skyGroup.add(starsMesh)

  const sunTexture = createPelletRadialTexture(192, [
    { offset: 0, color: 'rgba(255,255,255,1)' },
    { offset: 0.5, color: 'rgba(255,244,185,0.96)' },
    { offset: 1, color: 'rgba(255,244,185,0)' },
  ])
  const sunGlowTexture = createPelletRadialTexture(224, [
    { offset: 0, color: 'rgba(255,245,188,0.95)' },
    { offset: 0.62, color: 'rgba(255,245,188,0.42)' },
    { offset: 1, color: 'rgba(255,245,188,0)' },
  ])
  const moonTexture =
    (await createMoonTextureFromAsset(
      SCENE_CONSTANTS.DAY_NIGHT_MOON_TEXTURE_URL,
      SCENE_CONSTANTS.DAY_NIGHT_MOON_TEXTURE_SIZE,
      SCENE_CONSTANTS.DAY_NIGHT_MOON_TEXTURE_EDGE_FEATHER,
    )) ??
    createPelletRadialTexture(192, [
      { offset: 0, color: 'rgba(255,255,255,0.95)' },
      { offset: 0.54, color: 'rgba(216,227,255,0.84)' },
      { offset: 1, color: 'rgba(216,227,255,0)' },
    ])
  const moonGlowTexture = createPelletRadialTexture(192, [
    { offset: 0, color: 'rgba(196,214,255,0.78)' },
    { offset: 0.7, color: 'rgba(196,214,255,0.28)' },
    { offset: 1, color: 'rgba(196,214,255,0)' },
  ])

  const sunCoreMaterial = new THREE.SpriteMaterial({
    map: sunTexture ?? null,
    color: SCENE_CONSTANTS.SUN_CORE_COLOR.clone(),
    transparent: true,
    opacity: 1,
    depthWrite: false,
    depthTest: true,
    fog: false,
  })
  const sunGlowMaterial = new THREE.SpriteMaterial({
    map: sunGlowTexture ?? null,
    color: SCENE_CONSTANTS.SUN_GLOW_COLOR.clone(),
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
  })
  const moonCoreMaterial = new THREE.SpriteMaterial({
    map: moonTexture ?? null,
    color: SCENE_CONSTANTS.MOON_CORE_COLOR.clone(),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
    fog: false,
  })
  const moonGlowMaterial = new THREE.SpriteMaterial({
    map: moonGlowTexture ?? null,
    color: SCENE_CONSTANTS.MOON_GLOW_COLOR.clone(),
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
  })

  const sunGroup = new THREE.Group()
  const moonGroup = new THREE.Group()
  sunGroup.renderOrder = -48
  moonGroup.renderOrder = -48
  sunGroup.frustumCulled = false
  moonGroup.frustumCulled = false

  const sunGlow = new THREE.Sprite(sunGlowMaterial)
  const sunCore = new THREE.Sprite(sunCoreMaterial)
  sunGlow.scale.set(SCENE_CONSTANTS.DAY_NIGHT_SUN_GLOW_SIZE, SCENE_CONSTANTS.DAY_NIGHT_SUN_GLOW_SIZE, 1)
  sunCore.scale.set(SCENE_CONSTANTS.DAY_NIGHT_SUN_SIZE, SCENE_CONSTANTS.DAY_NIGHT_SUN_SIZE, 1)
  sunGlow.frustumCulled = false
  sunCore.frustumCulled = false
  sunGlow.renderOrder = -48
  sunCore.renderOrder = -47
  sunGroup.add(sunGlow)
  sunGroup.add(sunCore)

  const moonGlow = new THREE.Sprite(moonGlowMaterial)
  const moonCore = new THREE.Sprite(moonCoreMaterial)
  moonGlow.scale.set(
    SCENE_CONSTANTS.DAY_NIGHT_MOON_GLOW_SIZE,
    SCENE_CONSTANTS.DAY_NIGHT_MOON_GLOW_SIZE,
    1,
  )
  moonCore.scale.set(SCENE_CONSTANTS.DAY_NIGHT_MOON_SIZE, SCENE_CONSTANTS.DAY_NIGHT_MOON_SIZE, 1)
  moonGlow.frustumCulled = false
  moonCore.frustumCulled = false
  moonGlow.renderOrder = -48
  moonCore.renderOrder = -47
  moonGroup.add(moonGlow)
  moonGroup.add(moonCore)
  skyGroup.add(sunGroup)
  skyGroup.add(moonGroup)

  return {
    dayNightState,
    getDayNightInfo: () => ({
      mode: dayNightDebugMode,
      phase: dayNightPhase,
      dayFactor: dayNightFactor,
      cycleMs: dayNightCycleMs,
      sourceNowMs: dayNightSourceNowMs,
    }),
    setDayNightDebugMode: (mode: DayNightDebugMode) => {
      if (mode === 'accelerated' || mode === 'auto') {
        dayNightDebugMode = mode
        return
      }
      dayNightDebugMode = 'auto'
    },
    skyGroup,
    skyGradient,
    skyTopTemp,
    skyHorizonTemp,
    skyBottomTemp,
    horizonColorTemp,
    skyDomeGeometry,
    skyDomeMaterial,
    starsGeometry,
    starsMaterial,
    starsMesh,
    starTexture,
    horizonTexture,
    horizonMaterial,
    horizonSprite,
    sunTexture,
    sunGlowTexture,
    moonTexture,
    moonGlowTexture,
    sunCoreMaterial,
    sunGlowMaterial,
    moonCoreMaterial,
    moonGlowMaterial,
    sunGroup,
    moonGroup,
  }
}
