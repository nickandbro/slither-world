import * as THREE from 'three'
import type {
  Environment,
} from '../../../game/types'
import {
  buildTangentBasis,
  getVisualLakeTerrainDepth,
  sampleDesertBlend,
  sampleDuneOffset,
  sampleLakes,
} from './environment/lakes'
import { sampleTerrainContactRadius } from './environment/terrain'
import {
  createEnvironmentRuntimeController,
  type EnvironmentRuntimeControllerState,
} from './environment/runtimeController'
import { createInitialEnvironmentRuntimeState } from './environment/initialRuntimeState'
import { createMenuPreviewRuntime } from './overlays/menuPreviewRuntime'
import { createPelletBucketManager, type PelletSpriteBucket } from './pellets/buckets'
import {
  createPelletMotionHelpers,
  type PelletMotionState,
  type PelletVisualState,
} from './pellets/motion'
import {
  createPelletSurfaceSampler,
  type PelletGroundCacheEntry,
} from './pellets/surface'
import {
  createPelletConsumeGhostHelpers,
  type PelletConsumeGhost,
} from './pellets/consumeGhosts'
import { createPelletRuntimeUpdater } from './pellets/runtime'
import { createDayNightRuntime } from './render/dayNightRuntime'
import { createDayNightBootstrap } from './render/dayNightBootstrap'
import { createSceneFrameRuntime } from './render/frameRuntime'
import { createWebgpuOffscreenSetup, createWebgpuWorldTarget } from './render/webgpuOffscreen'
import { createRenderer } from './render/passes'
import type { SceneDebugApi } from './debug/attachDebugApi'
import { registerRuntimeDebugApi } from './debug/registerRuntimeDebug'
import {
  createBoostTrailAlphaTexture,
  createBoostTrailController,
  createBoostTrailMaterial,
  createBoostTrailWarmupManager,
  type BoostTrailState,
} from './snake/boostTrail'
import { createSnakeCollectionRuntime } from './snake/collectionRuntime'
import { createSnakePlayerVisualRuntime } from './snake/playerVisualRuntime'
import { createSnakePlayerRuntime } from './snake/playerUpdateRuntime'
import {
  createSnakeTubeGeometryHelpers,
  computeExtendedTailPoint,
  computeTailExtendDirection,
  projectToTangentPlane,
  type SnakeTubeCache,
  transportDirectionOnSphere,
} from './snake/geometry'
import {
  createSnakeCurveBuilder,
  type SnakeGroundingInfo,
} from './snake/grounding'
import { createSnakeOverlapGlowHelpers } from './snake/overlapGlow'
import {
  buildTailCapGeometry,
  computeDigestionStartOffset,
  createDigestionBulgeApplicator,
  storeTailFrameState,
  type TailFrameState,
} from './snake/tailShape'
import { type RenderPerfInfo } from './debug/perf'
import {
  clamp,
  smoothstep,
} from './utils/math'
import {
  createBoostDraftTexture,
  createIntakeConeTexture,
  createNameplateTexture,
  createPelletCoreTexture,
  createPelletGlowTexture,
  createPelletInnerGlowTexture,
  createPelletShadowTexture,
} from './utils/texture'
import * as SCENE_CONSTANTS from './constants'
import type {
  DeathState,
  RendererBackend,
  RendererPreference,
  RenderScene,
  SnakeVisual,
} from './runtimeTypes'
export type {
  CreateRenderSceneResult,
  DayNightDebugMode,
  RendererBackend,
  RendererPreference,
  RenderScene,
  WebGLScene,
} from './runtimeTypes'
export const createScene = async (
  canvas: HTMLCanvasElement,
  requestedBackend: RendererPreference,
  activeBackend: RendererBackend,
  fallbackReason: string | null,
): Promise<RenderScene> => {
  const renderer = await createRenderer(canvas, activeBackend)
  const webglShaderHooksEnabled = activeBackend === 'webgl'
  const webgpuOffscreenEnabled = activeBackend === 'webgpu'
  // WebGPURenderer runs an internal output conversion pass when rendering to the canvas.
  // Our world render is multi-pass; rendering everything into an explicit RenderTarget keeps
  // depth consistent between passes (so pellet glow never sees terrain depth) and presents once.
  const webgpuOffscreenSetup = createWebgpuOffscreenSetup(webgpuOffscreenEnabled)
  let webgpuWorldTarget = webgpuOffscreenSetup.worldTarget
  let webgpuWorldSamples = webgpuOffscreenSetup.worldSamples
  const webgpuPresentScene = webgpuOffscreenSetup.presentScene
  const webgpuPresentCamera = webgpuOffscreenSetup.presentCamera
  let webgpuPresentMaterial = webgpuOffscreenSetup.presentMaterial
  let webgpuPresentQuad = webgpuOffscreenSetup.presentQuad
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20)
  camera.position.set(0, 0, 3)
  scene.add(camera)
  const world = new THREE.Group()
  scene.add(world)
  const ambient = new THREE.AmbientLight(0xffffff, 0.65)
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.9)
  keyLight.position.set(2, 3, 4)
  const rimLight = new THREE.DirectionalLight(0x9bd7ff, 0.35)
  rimLight.position.set(-2, -1, 2)
  camera.add(ambient)
  camera.add(keyLight)
  camera.add(rimLight)
  const {
    dayNightState,
    getDayNightInfo,
    setDayNightDebugMode,
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
  } = await createDayNightBootstrap(camera, webglShaderHooksEnabled)
  const environmentState: EnvironmentRuntimeControllerState = createInitialEnvironmentRuntimeState()
  const environmentGroup = new THREE.Group()
  world.add(environmentGroup)
  const boostTrailsGroup = new THREE.Group()
  const snakesGroup = new THREE.Group()
  const pelletsGroup = new THREE.Group()
  world.add(boostTrailsGroup)
  world.add(snakesGroup)
  world.add(pelletsGroup)
  const headGeometry = new THREE.SphereGeometry(SCENE_CONSTANTS.HEAD_RADIUS, 18, 18)
  const bowlGeometry = new THREE.SphereGeometry(SCENE_CONSTANTS.HEAD_RADIUS * 1.55, 20, 20)
  const tailGeometry = new THREE.SphereGeometry(1, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2)
  const eyeGeometry = new THREE.SphereGeometry(SCENE_CONSTANTS.EYE_RADIUS, 12, 12)
  const pupilGeometry = new THREE.SphereGeometry(SCENE_CONSTANTS.PUPIL_RADIUS, 10, 10)
  const eyeMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.2 })
  const pupilMaterial = new THREE.MeshStandardMaterial({ color: '#1b1b1b', roughness: 0.4 })
  const boostDraftGeometry = new THREE.SphereGeometry(1, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.5)
  const boostDraftTexture = createBoostDraftTexture()
  const intakeConeGeometry = new THREE.PlaneGeometry(1, 1, 1, 1)
  intakeConeGeometry.translate(0, 0.5, 0)
  const intakeConeTexture = createIntakeConeTexture()
  // WebGPU does not support variable-size point primitives, so render pellets via instanced sprites.
  const pelletsUseSprites = activeBackend === 'webgpu'
  // Avoid mid-game resizes (and the associated pipeline/binding churn) by giving WebGPU buckets a
  // reasonable initial capacity. Per-bucket counts tend to be in the tens/low-hundreds even during
  // mass deaths, so 128 is a good tradeoff.
  const PELLET_SPRITE_BUCKET_MIN_CAPACITY = 128
  const PELLET_COLOR_BUCKET_COUNT = SCENE_CONSTANTS.PELLET_COLORS.length
  const PELLET_BUCKET_COUNT = PELLET_COLOR_BUCKET_COUNT * SCENE_CONSTANTS.PELLET_SIZE_TIER_MULTIPLIERS.length
  const PELLET_SHADOW_POINT_SIZE = SCENE_CONSTANTS.PELLET_RADIUS * 9.4
  const PELLET_CORE_POINT_SIZE = SCENE_CONSTANTS.PELLET_RADIUS * 5
  const PELLET_INNER_GLOW_POINT_SIZE = SCENE_CONSTANTS.PELLET_RADIUS * 14
  const PELLET_GLOW_POINT_SIZE = SCENE_CONSTANTS.PELLET_RADIUS * 23
  const pelletShadowTexture = createPelletShadowTexture()
  const pelletCoreTexture = createPelletCoreTexture()
  const pelletInnerGlowTexture = createPelletInnerGlowTexture()
  const pelletGlowTexture = createPelletGlowTexture()
  // WebGPU does not support `MeshDepthMaterial` (it can't be converted to a node material),
  // but for this pass we only need depth writes. Use a depth-only basic material instead.
  const occluderDepthMaterial = webglShaderHooksEnabled
    ? new THREE.MeshDepthMaterial({
        depthPacking: THREE.BasicDepthPacking,
      })
    : new THREE.MeshBasicMaterial()
  occluderDepthMaterial.depthTest = true
  occluderDepthMaterial.depthWrite = true
  occluderDepthMaterial.colorWrite = false
  let localGroundingInfo: SnakeGroundingInfo | null = null
  const pelletBuckets: Array<PelletSpriteBucket | null> = new Array(PELLET_BUCKET_COUNT).fill(null)
  const pelletBucketCounts = new Array<number>(PELLET_BUCKET_COUNT).fill(0)
  const pelletBucketOffsets = new Array<number>(PELLET_BUCKET_COUNT).fill(0)
  const pelletBucketPositionArrays: Array<Float32Array | null> = new Array(PELLET_BUCKET_COUNT).fill(null)
  const pelletBucketOpacityArrays: Array<Float32Array | null> = new Array(PELLET_BUCKET_COUNT).fill(null)
  const pelletGroundCache = new Map<number, PelletGroundCacheEntry>()
  const pelletMotionStates = new Map<number, PelletMotionState>()
  const pelletVisualStates = new Map<number, PelletVisualState>()
  const pelletConsumeGhosts: PelletConsumeGhost[] = []
  const pelletMouthTargets = new Map<string, THREE.Vector3>()
  const pelletConsumeTargetByPelletId = new Map<number, string>()
  const {
    menuPreviewOverlay,
    pointerArrowOverlay,
    pointerOverlayScene,
    pointerOverlayRoot,
    snakeSkinTextureCache,
    getSnakeSkinTexture,
    setMenuPreviewVisible,
    setMenuPreviewSkin,
    setMenuPreviewOrbit,
    queuePelletConsumeTargets,
    clearPelletConsumeTargets,
  } = createMenuPreviewRuntime({
    renderer,
    headGeometry,
    snakeRadius: SCENE_CONSTANTS.SNAKE_RADIUS,
    snakeTubeRadialSegments: SCENE_CONSTANTS.SNAKE_TUBE_RADIAL_SEGMENTS,
    tailCapSegments: SCENE_CONSTANTS.TAIL_CAP_SEGMENTS,
    snakeTailCapUSpan: SCENE_CONSTANTS.SNAKE_TAIL_CAP_U_SPAN,
    applySnakeSkinUVs: (...args) => applySnakeSkinUVs(...args),
    buildTailCapGeometry,
    pelletConsumeTargetByPelletId,
  })
  const pelletIdsSeen = new Set<number>()
  let viewportWidth = 1
  let viewportHeight = 1
  let viewportDpr = 1
  const viewportState = {
    get width() {
      return viewportWidth
    },
    get height() {
      return viewportHeight
    },
  }
  const snakes = new Map<string, SnakeVisual>()
  const snakeTubeCaches = new Map<string, SnakeTubeCache>()
  const boostTrails = new Map<string, BoostTrailState[]>()
  const deathStates = new Map<string, DeathState>()
  const lastAliveStates = new Map<string, boolean>()
  const lastHeadPositions = new Map<string, THREE.Vector3>()
  const lastForwardDirections = new Map<string, THREE.Vector3>()
  const lastTailDirections = new Map<string, THREE.Vector3>()
  const lastTailContactNormals = new Map<string, THREE.Vector3>()
  const tailFrameStates = new Map<string, TailFrameState>()
  const lastSnakeStarts = new Map<string, number>()
  const tempVector = new THREE.Vector3()
  const tempVectorB = new THREE.Vector3()
  const tempVectorC = new THREE.Vector3()
  const tempVectorD = new THREE.Vector3()
  const tempVectorE = new THREE.Vector3()
  const tempVectorF = new THREE.Vector3()
  const tempVectorG = new THREE.Vector3()
  const tempVectorH = new THREE.Vector3()
  const patchCenterQuat = new THREE.Quaternion()
  const lakeSampleTemp = new THREE.Vector3()
  const cameraLocalPosTemp = new THREE.Vector3()
  const cameraLocalDirTemp = new THREE.Vector3()
  const snakeContactTangentTemp = new THREE.Vector3()
  const snakeContactBitangentTemp = new THREE.Vector3()
  const snakeContactFallbackTemp = new THREE.Vector3()
  const debugEnabled = import.meta.env.DEV || import.meta.env.VITE_E2E_DEBUG === '1'
  const perfDebugEnabled = (() => {
    if (typeof window === 'undefined') return false
    try {
      const url = new URL(window.location.href)
      return url.searchParams.get('rafPerf') === '1'
    } catch {
      return false
    }
  })()
  const renderPerfSlowFramesMax = 24
  const renderPerfInfo: RenderPerfInfo = {
    enabled: perfDebugEnabled,
    thresholdMs: 50,
    frameCount: 0,
    slowFrameCount: 0,
    maxTotalMs: 0,
    lastFrame: null,
    slowFrames: [],
  }
  let debugApi: SceneDebugApi | null = null
  debugApi = registerRuntimeDebugApi({
    enabled: debugEnabled || perfDebugEnabled,
    snakes,
    boostTrails,
    getRendererInfo: () => ({
      requestedBackend,
      activeBackend,
      fallbackReason,
      webglShaderHooksEnabled,
    }),
    renderPerfInfo,
    getTerrainPatchInfo: () => ({
      totalPatches: environmentState.planetPatches.length,
      visiblePatches: environmentState.visiblePlanetPatchCount,
      patchBands: SCENE_CONSTANTS.PLANET_PATCH_BANDS,
      patchSlices: SCENE_CONSTANTS.PLANET_PATCH_SLICES,
      dynamicRebuilds: false,
      wireframeEnabled: environmentState.terrainTessellationDebugEnabled,
    }),
    getEnvironmentCullInfo: () => ({
      totalTrees: environmentState.treeCullEntries.length,
      visibleTrees: environmentState.visibleTreeCount,
      totalCactuses: environmentState.cactusTrunkSourceMatrices.length,
      visibleCactuses: environmentState.visibleCactusCount,
      totalMountains: environmentState.mountains.length,
      visibleMountains: environmentState.visibleMountainCount,
      totalPebbles: environmentState.pebbleCullEntries.length,
      visiblePebbles: environmentState.visiblePebbleCount,
      totalLakes: environmentState.lakes.length,
      visibleLakes: environmentState.visibleLakeCount,
    }),
    getSnakeGroundingInfo: () =>
      localGroundingInfo
        ? {
            minClearance: localGroundingInfo.minClearance,
            maxPenetration: localGroundingInfo.maxPenetration,
            maxAppliedLift: localGroundingInfo.maxAppliedLift,
            sampleCount: localGroundingInfo.sampleCount,
          }
        : null,
    getDayNightInfo,
    boostDraftMinActiveOpacity: SCENE_CONSTANTS.BOOST_DRAFT_MIN_ACTIVE_OPACITY,
  })
  const resetSnakeTransientState = (id: string) => {
    lastHeadPositions.delete(id)
    lastForwardDirections.delete(id)
    lastTailDirections.delete(id)
    lastTailContactNormals.delete(id)
    tailFrameStates.delete(id)
  }
  const {
    buildEnvironment,
    disposeEnvironment,
    updatePlanetPatchVisibility,
    updateLakeVisibility,
    updateEnvironmentVisibility,
    setDebugFlags: setEnvironmentDebugFlags,
  } = createEnvironmentRuntimeController({
    state: environmentState,
    world,
    environmentGroup,
    camera,
    patchCenterQuat,
    cameraLocalPosTemp,
    cameraLocalDirTemp,
    getViewport: () => ({ width: viewportWidth, height: viewportHeight }),
    webglShaderHooksEnabled,
    tempVector,
    tempVectorB,
    buildTangentBasis,
    pelletGroundCache,
    pelletMotionStates,
    pelletVisualStates,
    pelletConsumeGhosts,
    pelletMouthTargets,
    pelletConsumeTargetByPelletId,
  })
  buildEnvironment(null)
  const {
    createBoostDraftMaterial,
    createSnakeVisual,
    updateIntakeCone,
    updateBoostDraft,
  } = createSnakePlayerVisualRuntime({
    webglShaderHooksEnabled,
    world,
    camera,
    headGeometry,
    bowlGeometry,
    tailGeometry,
    eyeGeometry,
    pupilGeometry,
    eyeMaterial,
    pupilMaterial,
    boostDraftGeometry,
    boostDraftTexture,
    intakeConeGeometry,
    intakeConeTexture,
    createNameplateTexture,
    nameplateWorldWidth: SCENE_CONSTANTS.NAMEPLATE_WORLD_WIDTH,
    nameplateWorldAspect: SCENE_CONSTANTS.NAMEPLATE_WORLD_ASPECT,
    headRadius: SCENE_CONSTANTS.HEAD_RADIUS,
    constants: { boostDraftEdgeFadeStart: SCENE_CONSTANTS.BOOST_DRAFT_EDGE_FADE_START, boostDraftEdgeFadeEnd: SCENE_CONSTANTS.BOOST_DRAFT_EDGE_FADE_END, boostDraftColorA: SCENE_CONSTANTS.BOOST_DRAFT_COLOR_A, boostDraftColorB: SCENE_CONSTANTS.BOOST_DRAFT_COLOR_B, boostDraftColorShiftSpeed: SCENE_CONSTANTS.BOOST_DRAFT_COLOR_SHIFT_SPEED, boostDraftPulseSpeed: SCENE_CONSTANTS.BOOST_DRAFT_PULSE_SPEED, boostDraftOpacity: SCENE_CONSTANTS.BOOST_DRAFT_OPACITY, boostDraftFadeInRate: SCENE_CONSTANTS.BOOST_DRAFT_FADE_IN_RATE, boostDraftFadeOutRate: SCENE_CONSTANTS.BOOST_DRAFT_FADE_OUT_RATE, boostDraftMinActiveOpacity: SCENE_CONSTANTS.BOOST_DRAFT_MIN_ACTIVE_OPACITY, boostDraftBaseRadius: SCENE_CONSTANTS.BOOST_DRAFT_BASE_RADIUS, boostDraftFrontOffset: SCENE_CONSTANTS.BOOST_DRAFT_FRONT_OFFSET, boostDraftLift: SCENE_CONSTANTS.BOOST_DRAFT_LIFT, boostDraftLocalForwardAxis: SCENE_CONSTANTS.BOOST_DRAFT_LOCAL_FORWARD_AXIS, intakeConeDisengageHoldMs: SCENE_CONSTANTS.INTAKE_CONE_DISENGAGE_HOLD_MS, intakeConeViewMargin: SCENE_CONSTANTS.INTAKE_CONE_VIEW_MARGIN, intakeConeFadeInRate: SCENE_CONSTANTS.INTAKE_CONE_FADE_IN_RATE, intakeConeFadeOutRate: SCENE_CONSTANTS.INTAKE_CONE_FADE_OUT_RATE, intakeConeMaxOpacity: SCENE_CONSTANTS.INTAKE_CONE_MAX_OPACITY, intakeConeBaseLength: SCENE_CONSTANTS.INTAKE_CONE_BASE_LENGTH, intakeConeBaseWidth: SCENE_CONSTANTS.INTAKE_CONE_BASE_WIDTH, intakeConeLift: SCENE_CONSTANTS.INTAKE_CONE_LIFT, deathVisibilityCutoff: SCENE_CONSTANTS.DEATH_VISIBILITY_CUTOFF },
  })
  const getAnalyticTerrainRadius = (
    normal: THREE.Vector3,
    sample?: ReturnType<typeof sampleLakes>,
  ) => {
    const lakeSample = sample ?? sampleLakes(normal, environmentState.lakes, lakeSampleTemp)
    const depth = getVisualLakeTerrainDepth(lakeSample)
    const duneOffset = sampleDuneOffset(normal) * sampleDesertBlend(normal)
    return SCENE_CONSTANTS.PLANET_RADIUS + duneOffset - depth
  }
  const getTerrainRadius = (
    normal: THREE.Vector3,
    sample?: ReturnType<typeof sampleLakes>,
  ) => {
    if (environmentState.terrainContactSampler) {
      const sampled = sampleTerrainContactRadius(environmentState.terrainContactSampler, normal)
      if (sampled !== null) return sampled
    }
    return getAnalyticTerrainRadius(normal, sample)
  }
  const boostTrailAlphaTexture = createBoostTrailAlphaTexture({
    width: SCENE_CONSTANTS.BOOST_TRAIL_ALPHA_TEXTURE_WIDTH,
    height: SCENE_CONSTANTS.BOOST_TRAIL_ALPHA_TEXTURE_HEIGHT,
    edgeFadeCap: SCENE_CONSTANTS.BOOST_TRAIL_EDGE_FADE_CAP,
    sideFadeCap: SCENE_CONSTANTS.BOOST_TRAIL_SIDE_FADE_CAP,
  })
  const createBoostTrailMaterialInstance = () =>
    createBoostTrailMaterial({
      color: SCENE_CONSTANTS.BOOST_TRAIL_COLOR,
      opacity: SCENE_CONSTANTS.BOOST_TRAIL_OPACITY,
      alphaTexture: boostTrailAlphaTexture,
      retireFeather: SCENE_CONSTANTS.BOOST_TRAIL_RETIRE_FEATHER,
      webglShaderHooksEnabled,
    })
  const boostTrailWarmup = createBoostTrailWarmupManager({
    world,
    scene,
    camera,
    renderer,
    createBoostDraftMaterial,
    boostDraftGeometry,
    createBoostTrailMaterial: createBoostTrailMaterialInstance,
    webglShaderHooksEnabled,
  })
  boostTrailWarmup.warmOnce()
  const {
    updateBoostTrailForPlayer,
    updateInactiveBoostTrails,
    disposeAllBoostTrails,
  } = createBoostTrailController({
    boostTrails,
    boostTrailsGroup,
    createBoostTrailMaterial: createBoostTrailMaterialInstance,
    webglShaderHooksEnabled,
    getTerrainRadius,
    buildTangentBasis,
    planetRadius: SCENE_CONSTANTS.PLANET_RADIUS,
    boostTrailSurfaceOffset: SCENE_CONSTANTS.BOOST_TRAIL_SURFACE_OFFSET,
    boostTrailMinSampleDistance: SCENE_CONSTANTS.BOOST_TRAIL_MIN_SAMPLE_DISTANCE,
    boostTrailMaxSamples: SCENE_CONSTANTS.BOOST_TRAIL_MAX_SAMPLES,
    boostTrailMaxArcAngle: SCENE_CONSTANTS.BOOST_TRAIL_MAX_ARC_ANGLE,
    boostTrailFadeSeconds: SCENE_CONSTANTS.BOOST_TRAIL_FADE_SECONDS,
    boostTrailMaxCurveSegments: SCENE_CONSTANTS.BOOST_TRAIL_MAX_CURVE_SEGMENTS,
    boostTrailCurveSegmentsPerPoint: SCENE_CONSTANTS.BOOST_TRAIL_CURVE_SEGMENTS_PER_POINT,
    boostTrailMaxCenterPoints: SCENE_CONSTANTS.BOOST_TRAIL_MAX_CENTER_POINTS,
    boostTrailMaxVertexCount: SCENE_CONSTANTS.BOOST_TRAIL_MAX_VERTEX_COUNT,
    boostTrailMaxIndexCount: SCENE_CONSTANTS.BOOST_TRAIL_MAX_INDEX_COUNT,
    boostTrailPoolMax: SCENE_CONSTANTS.BOOST_TRAIL_POOL_MAX,
    boostTrailWidth: SCENE_CONSTANTS.BOOST_TRAIL_WIDTH,
    boostTrailRetireFeather: SCENE_CONSTANTS.BOOST_TRAIL_RETIRE_FEATHER,
    boostTrailEdgeFadeCap: SCENE_CONSTANTS.BOOST_TRAIL_EDGE_FADE_CAP,
  })
  const getSnakeCenterlineRadius = (
    normal: THREE.Vector3,
    radiusOffset: number,
    snakeRadius: number,
  ) => {
    const sample = sampleLakes(normal, environmentState.lakes, lakeSampleTemp)
    const terrainRadius = getTerrainRadius(normal, sample)
    let centerlineRadius = terrainRadius + radiusOffset
    if (!sample.lake || sample.boundary <= SCENE_CONSTANTS.LAKE_WATER_MASK_THRESHOLD) {
      return centerlineRadius
    }
    const boundary = clamp(sample.boundary, 0, 1)
    const submergeBlend = smoothstep(
      SCENE_CONSTANTS.SNAKE_WATERLINE_BLEND_START,
      SCENE_CONSTANTS.SNAKE_WATERLINE_BLEND_END,
      boundary,
    )
    if (submergeBlend <= 0) return centerlineRadius
    const waterRadius = SCENE_CONSTANTS.PLANET_RADIUS - sample.lake.surfaceInset
    const minCenterlineRadius = terrainRadius + SCENE_CONSTANTS.SNAKE_MIN_TERRAIN_CLEARANCE
    const maxUnderwaterRadius = waterRadius - (snakeRadius + SCENE_CONSTANTS.SNAKE_UNDERWATER_CLEARANCE)
    const submergedRadius = Math.max(
      minCenterlineRadius,
      Math.min(centerlineRadius, maxUnderwaterRadius),
    )
    centerlineRadius += (submergedRadius - centerlineRadius) * submergeBlend
    return centerlineRadius
  }
  const { applySnakeContactLift, buildSnakeCurvePoints } = createSnakeCurveBuilder({
    planetRadius: SCENE_CONSTANTS.PLANET_RADIUS,
    getTerrainRadius,
    getSnakeCenterlineRadius,
    buildTangentBasis,
    snakeContactArcSamples: SCENE_CONSTANTS.SNAKE_CONTACT_ARC_SAMPLES,
    snakeContactLiftIterations: SCENE_CONSTANTS.SNAKE_CONTACT_LIFT_ITERATIONS,
    snakeContactLiftEps: SCENE_CONSTANTS.SNAKE_CONTACT_LIFT_EPS,
    snakeContactClearance: SCENE_CONSTANTS.SNAKE_CONTACT_CLEARANCE,
    snakeSlopeInsertRadiusDelta: SCENE_CONSTANTS.SNAKE_SLOPE_INSERT_RADIUS_DELTA,
  })
  const {
    getPelletSurfacePositionFromNormal,
  } = createPelletSurfaceSampler({
    pelletGroundCache,
    getTerrainRadius,
    pelletGroundCacheNormalEps: SCENE_CONSTANTS.PELLET_GROUND_CACHE_NORMAL_EPS,
    pelletSizeMin: SCENE_CONSTANTS.PELLET_SIZE_MIN,
    pelletSizeMax: SCENE_CONSTANTS.PELLET_SIZE_MAX,
    pelletRadius: SCENE_CONSTANTS.PELLET_RADIUS,
    pelletSurfaceClearance: SCENE_CONSTANTS.PELLET_SURFACE_CLEARANCE,
  })
  const { reconcilePelletVisualState, resolvePelletRenderSize, applyPelletWobble } =
    createPelletMotionHelpers({
      pelletMotionStates,
      pelletVisualStates,
      buildTangentBasis,
      pelletSizeMin: SCENE_CONSTANTS.PELLET_SIZE_MIN,
      pelletSizeMax: SCENE_CONSTANTS.PELLET_SIZE_MAX,
      pelletWobbleWspRange: SCENE_CONSTANTS.PELLET_WOBBLE_WSP_RANGE,
      pelletWobbleGfrRate: SCENE_CONSTANTS.PELLET_WOBBLE_GFR_RATE,
      pelletWobbleDistance: SCENE_CONSTANTS.PELLET_WOBBLE_DISTANCE,
      pelletPredictionMaxHorizonSecs: SCENE_CONSTANTS.PELLET_PREDICTION_MAX_HORIZON_SECS,
      pelletCorrectionRate: SCENE_CONSTANTS.PELLET_CORRECTION_RATE,
      pelletSnapDotThreshold: SCENE_CONSTANTS.PELLET_SNAP_DOT_THRESHOLD,
      pelletPosSmoothRate: SCENE_CONSTANTS.PELLET_POS_SMOOTH_RATE,
      pelletSizeSmoothRate: SCENE_CONSTANTS.PELLET_SIZE_SMOOTH_RATE,
    })
  const resolveConsumeGhostTarget = (
    targetPlayerId: string | null,
    consumeBlend: number,
    out: THREE.Vector3,
  ) => {
    if (!targetPlayerId || targetPlayerId.length <= 0) return false
    const mouthTarget = pelletMouthTargets.get(targetPlayerId)
    if (!mouthTarget) return false
    out.copy(mouthTarget)
    const forward = lastForwardDirections.get(targetPlayerId)
    if (forward && forward.lengthSq() > 1e-8) {
      out.addScaledVector(forward, SCENE_CONSTANTS.PELLET_CONSUME_GHOST_FORWARD_LEAD * Math.max(0, 1 - consumeBlend))
    }
    return true
  }
  const { spawnPelletConsumeGhost, updatePelletConsumeGhost } = createPelletConsumeGhostHelpers({
    pelletConsumeGhosts,
    resolveConsumeGhostTarget,
    getPelletSurfacePositionFromNormal,
    resolvePelletRenderSize,
    buildTangentBasis,
    pelletConsumeGhostDurationSecs: SCENE_CONSTANTS.PELLET_CONSUME_GHOST_DURATION_SECS,
    pelletConsumeGhostWobbleSpeedMin: SCENE_CONSTANTS.PELLET_CONSUME_GHOST_WOBBLE_SPEED_MIN,
    pelletConsumeGhostWobbleSpeedMax: SCENE_CONSTANTS.PELLET_CONSUME_GHOST_WOBBLE_SPEED_MAX,
    pelletConsumeGhostWobbleDistance: SCENE_CONSTANTS.PELLET_CONSUME_GHOST_WOBBLE_DISTANCE,
  })
  const {
    computeSnakeSelfOverlapPointIntensities,
    getTubeParams,
    applySnakeSelfOverlapColors,
  } = createSnakeOverlapGlowHelpers({
    minArcMult: SCENE_CONSTANTS.SNAKE_SELF_OVERLAP_MIN_ARC_MULT,
    gridCells: SCENE_CONSTANTS.SNAKE_SELF_OVERLAP_GRID_CELLS,
    distFullMult: SCENE_CONSTANTS.SNAKE_SELF_OVERLAP_DIST_FULL_MULT,
    distStartMult: SCENE_CONSTANTS.SNAKE_SELF_OVERLAP_DIST_START_MULT,
    blurRadius: SCENE_CONSTANTS.SNAKE_SELF_OVERLAP_BLUR_RADIUS,
    blurPasses: SCENE_CONSTANTS.SNAKE_SELF_OVERLAP_BLUR_PASSES,
  })
  const {
    applySnakeSkinUVs,
    ensureSnakeTubeCache,
    updateSnakeTubeGeometry,
    updateSnakeTailCap,
  } = createSnakeTubeGeometryHelpers({
    snakeTubeCaches,
    getTubeParams,
    buildTangentBasis,
    snakeTubeRadialSegments: SCENE_CONSTANTS.SNAKE_TUBE_RADIAL_SEGMENTS,
    planetRadius: SCENE_CONSTANTS.PLANET_RADIUS,
    snakeTailCapUSpan: SCENE_CONSTANTS.SNAKE_TAIL_CAP_U_SPAN,
    tailCapSegments: SCENE_CONSTANTS.TAIL_CAP_SEGMENTS,
    baseTailGeometry: tailGeometry,
  })
  const applyDigestionBulges = createDigestionBulgeApplicator({
    getTubeParams,
    digestionWidthMin: SCENE_CONSTANTS.DIGESTION_WIDTH_MIN,
    digestionWidthMax: SCENE_CONSTANTS.DIGESTION_WIDTH_MAX,
    digestionBulgeMin: SCENE_CONSTANTS.DIGESTION_BULGE_MIN,
    digestionBulgeMax: SCENE_CONSTANTS.DIGESTION_BULGE_MAX,
    digestionMaxBulgeMin: SCENE_CONSTANTS.DIGESTION_MAX_BULGE_MIN,
    digestionMaxBulgeMax: SCENE_CONSTANTS.DIGESTION_MAX_BULGE_MAX,
  })
  const storeTailFrameStateForPlayer = (
    playerId: string,
    tailNormal: THREE.Vector3,
    tailDirection: THREE.Vector3,
  ) => {
    storeTailFrameState({
      tailFrameStates,
      playerId,
      tailNormal,
      tailDirection,
      projectToTangentPlane,
    })
  }
  const snakeTubeCurve = new THREE.CatmullRomCurve3([new THREE.Vector3(), new THREE.Vector3()], false, 'centripetal')
  const { updateSnake } = createSnakePlayerRuntime({
    constants: { deathFadeDuration: SCENE_CONSTANTS.DEATH_FADE_DURATION, deathStartOpacity: SCENE_CONSTANTS.DEATH_START_OPACITY, deathVisibilityCutoff: SCENE_CONSTANTS.DEATH_VISIBILITY_CUTOFF, digestionTravelEase: SCENE_CONSTANTS.DIGESTION_TRAVEL_EASE, snakeGirthScaleMin: SCENE_CONSTANTS.SNAKE_GIRTH_SCALE_MIN, snakeGirthScaleMax: SCENE_CONSTANTS.SNAKE_GIRTH_SCALE_MAX, digestionBulgeGirthMinScale: SCENE_CONSTANTS.DIGESTION_BULGE_GIRTH_MIN_SCALE, digestionBulgeGirthCurve: SCENE_CONSTANTS.DIGESTION_BULGE_GIRTH_CURVE, digestionBulgeRadiusCurve: SCENE_CONSTANTS.DIGESTION_BULGE_RADIUS_CURVE, snakeRadius: SCENE_CONSTANTS.SNAKE_RADIUS, snakeLiftFactor: SCENE_CONSTANTS.SNAKE_LIFT_FACTOR, headRadius: SCENE_CONSTANTS.HEAD_RADIUS, tailDirMinRatio: SCENE_CONSTANTS.TAIL_DIR_MIN_RATIO, digestionStartNodeIndex: SCENE_CONSTANTS.DIGESTION_START_NODE_INDEX, snakeSelfOverlapGlowEnabled: SCENE_CONSTANTS.SNAKE_SELF_OVERLAP_GLOW_ENABLED, snakeSelfOverlapMinPoints: SCENE_CONSTANTS.SNAKE_SELF_OVERLAP_MIN_POINTS, snakeSelfOverlapGlowVisibilityThreshold: SCENE_CONSTANTS.SNAKE_SELF_OVERLAP_GLOW_VISIBILITY_THRESHOLD, snakeSelfOverlapGlowOpacity: SCENE_CONSTANTS.SNAKE_SELF_OVERLAP_GLOW_OPACITY, lakeWaterMaskThreshold: SCENE_CONSTANTS.LAKE_WATER_MASK_THRESHOLD, tongueMouthForward: SCENE_CONSTANTS.TONGUE_MOUTH_FORWARD, tongueMouthOut: SCENE_CONSTANTS.TONGUE_MOUTH_OUT, nameplateFadeNearDistance: SCENE_CONSTANTS.NAMEPLATE_FADE_NEAR_DISTANCE, nameplateFadeFarDistance: SCENE_CONSTANTS.NAMEPLATE_FADE_FAR_DISTANCE, nameplateWorldWidth: SCENE_CONSTANTS.NAMEPLATE_WORLD_WIDTH, nameplateWorldAspect: SCENE_CONSTANTS.NAMEPLATE_WORLD_ASPECT, nameplateWorldOffset: SCENE_CONSTANTS.NAMEPLATE_WORLD_OFFSET },
    camera,
    getLakes: () => environmentState.lakes,
    getSnakeCenterlineRadius,
    getSnakeSkinTexture,
    createSnakeVisual,
    snakes,
    snakesGroup,
    deathStates,
    lastAliveStates,
    lastSnakeStarts,
    tailFrameStates,
    lastTailDirections,
    lastTailContactNormals,
    lastHeadPositions,
    lastForwardDirections,
    pelletMouthTargets,
    resetSnakeTransientState,
    setLocalGroundingInfo: (value) => {
      localGroundingInfo = value
    },
    buildSnakeCurvePoints,
    applySnakeContactLift,
    ensureSnakeTubeCache,
    snakeTubeCurve,
    updateSnakeTubeGeometry,
    applySnakeSkinUVs,
    computeDigestionStartOffset,
    applyDigestionBulges,
    computeSnakeSelfOverlapPointIntensities,
    applySnakeSelfOverlapColors,
    computeTailExtendDirection,
    computeExtendedTailPoint,
    projectToTangentPlane,
    transportDirectionOnSphere,
    buildTangentBasis,
    storeTailFrameStateForPlayer,
    updateSnakeTailCap,
    updateBoostDraft,
    updateIntakeCone,
  })
  const { removeSnake, updateSnakes } = createSnakeCollectionRuntime({
    snakesGroup,
    tailGeometry,
    resetSnakeTransientState,
    pelletMouthTargets,
    deathStates,
    lastAliveStates,
    lastSnakeStarts,
    snakeTubeCaches,
    snakes,
    lastHeadPositions,
    lastForwardDirections,
    lastTailContactNormals,
    setLocalGroundingInfo: (value) => {
      localGroundingInfo = value
    },
    updateSnake,
    updateBoostTrailForPlayer,
    updateInactiveBoostTrails,
  })
  const { pelletBucketIndex, ensurePelletBucketCapacity } = createPelletBucketManager({
    pelletBuckets,
    pelletsGroup,
    pelletsUseSprites,
    pelletSpriteBucketMinCapacity: PELLET_SPRITE_BUCKET_MIN_CAPACITY,
    pelletColorBucketCount: PELLET_COLOR_BUCKET_COUNT,
    pelletSizeTierMultipliers: SCENE_CONSTANTS.PELLET_SIZE_TIER_MULTIPLIERS,
    pelletSizeTierMediumMin: SCENE_CONSTANTS.PELLET_SIZE_TIER_MEDIUM_MIN,
    pelletSizeTierLargeMin: SCENE_CONSTANTS.PELLET_SIZE_TIER_LARGE_MIN,
    pelletShadowPointSize: PELLET_SHADOW_POINT_SIZE,
    pelletCorePointSize: PELLET_CORE_POINT_SIZE,
    pelletInnerGlowPointSize: PELLET_INNER_GLOW_POINT_SIZE,
    pelletGlowPointSize: PELLET_GLOW_POINT_SIZE,
    pelletShadowTexture,
    pelletCoreTexture,
    pelletInnerGlowTexture,
    pelletGlowTexture,
    pelletColors: SCENE_CONSTANTS.PELLET_COLORS,
    pelletShadowOpacityBase: SCENE_CONSTANTS.PELLET_SHADOW_OPACITY_BASE,
    pelletCoreOpacityBase: SCENE_CONSTANTS.PELLET_CORE_OPACITY_BASE,
    pelletInnerGlowOpacityBase: SCENE_CONSTANTS.PELLET_INNER_GLOW_OPACITY_BASE,
    pelletGlowOpacityBase: SCENE_CONSTANTS.PELLET_GLOW_OPACITY_BASE,
  })
  const { updatePellets, updatePelletGlow } = createPelletRuntimeUpdater({
    reconcilePelletVisualState,
    pelletIdsSeen,
    pelletVisualStates,
    pelletConsumeTargetByPelletId,
    spawnPelletConsumeGhost,
    pelletConsumeGhosts,
    updatePelletConsumeGhost,
    pelletBucketCounts,
    pelletBucketOffsets,
    pelletBucketPositionArrays,
    pelletBucketOpacityArrays,
    pelletBuckets,
    pelletBucketIndex,
    ensurePelletBucketCapacity,
    resolvePelletRenderSize,
    tempVector,
    getPelletSurfacePositionFromNormal,
    applyPelletWobble,
    pelletGroundCache,
    pelletMotionStates,
  })
  const { updateDayNightVisuals } = createDayNightRuntime({
    state: dayNightState,
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
  })
  const { render, setPointerScreen, getPointerAxis } = createSceneFrameRuntime({
    renderer,
    scene,
    camera,
    world,
    skyGroup,
    environmentGroup,
    snakesGroup,
    pelletsGroup,
    lakeMeshes: environmentState.lakeMeshes,
    lakeMaterials: environmentState.lakeMaterials,
    snakes,
    occluderDepthMaterial,
    menuPreviewOverlay,
    pointerArrowOverlay,
    pointerOverlayRoot,
    pointerOverlayScene,
    patchCenterQuat,
    cameraLocalPosTemp,
    cameraLocalDirTemp,
    tempVectorC,
    snakeContactTangentTemp,
    snakeContactFallbackTemp,
    snakeContactBitangentTemp,
    updateDayNightVisuals,
    updateSnakes,
    updatePellets,
    updatePelletGlow,
    updatePlanetPatchVisibility,
    updateLakeVisibility,
    updateEnvironmentVisibility,
    buildTangentBasis,
    getSnakeCenterlineRadius,
    applySnakeContactLift,
    getTerrainRadius: (normal) => getTerrainRadius(normal),
    getViewportSize: () => ({ width: viewportWidth, height: viewportHeight }),
    renderPerfInfo,
    renderPerfSlowFramesMax,
    webgpuOffscreenEnabled,
    webgpuWorldTarget,
    webgpuPresentScene,
    webgpuPresentCamera,
    constants: { snakeRadius: SCENE_CONSTANTS.SNAKE_RADIUS, snakeGirthScaleMin: SCENE_CONSTANTS.SNAKE_GIRTH_SCALE_MIN, snakeGirthScaleMax: SCENE_CONSTANTS.SNAKE_GIRTH_SCALE_MAX, snakeLiftFactor: SCENE_CONSTANTS.SNAKE_LIFT_FACTOR, headRadius: SCENE_CONSTANTS.HEAD_RADIUS, lakeWaterEmissiveBase: SCENE_CONSTANTS.LAKE_WATER_EMISSIVE_BASE, lakeWaterEmissivePulse: SCENE_CONSTANTS.LAKE_WATER_EMISSIVE_PULSE, lakeWaterWaveSpeed: SCENE_CONSTANTS.LAKE_WATER_WAVE_SPEED, planetPatchEnabled: SCENE_CONSTANTS.PLANET_PATCH_ENABLED },
  })
  const setEnvironment = (environment: Environment) => buildEnvironment(environment)
  const setDebugFlags = setEnvironmentDebugFlags
	  const resize = (width: number, height: number, dpr: number) => {
	    viewportWidth = width
	    viewportHeight = height
	    viewportDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
	    renderer.setPixelRatio(dpr)
	    renderer.setSize(width, height, false)
	    if (webgpuWorldTarget) {
	      const rtW = Math.max(1, Math.floor(width * viewportDpr))
	      const rtH = Math.max(1, Math.floor(height * viewportDpr))
	      webgpuWorldTarget.setSize(rtW, rtH)
	    }
	    const safeHeight = height > 0 ? height : 1
	    const aspect = width / safeHeight
	    camera.aspect = aspect
	    camera.updateProjectionMatrix()
    menuPreviewOverlay.resize(width, aspect)
  }
  const setWebgpuWorldSamples = (requestedSamples: number) => {
    if (!webgpuOffscreenEnabled) return
    const rounded = Math.round(requestedSamples)
    const nextSamples = rounded <= 1 ? 1 : 4
    if (nextSamples === webgpuWorldSamples) return
    webgpuWorldSamples = nextSamples
    if (!webgpuWorldTarget || !webgpuPresentMaterial) return
    const previousTarget = webgpuWorldTarget
    const nextTarget = createWebgpuWorldTarget(webgpuWorldSamples)
    const rtW = Math.max(1, Math.floor(viewportWidth * viewportDpr))
    const rtH = Math.max(1, Math.floor(viewportHeight * viewportDpr))
    nextTarget.setSize(rtW, rtH)
    webgpuWorldTarget = nextTarget
    webgpuPresentMaterial.map = nextTarget.texture
    webgpuPresentMaterial.needsUpdate = true
    previousTarget.dispose()
  }
		  const dispose = () => {
	    if (webgpuPresentQuad) {
	      webgpuPresentQuad.geometry.dispose()
	      webgpuPresentQuad = null
	    }
	    if (webgpuPresentMaterial) {
	      webgpuPresentMaterial.dispose()
	      webgpuPresentMaterial = null
	    }
		    if (webgpuWorldTarget) {
		      webgpuWorldTarget.dispose()
		      webgpuWorldTarget = null
		    }
		    renderer.dispose()
		    boostTrailWarmup.dispose()
	    disposeEnvironment()
    camera.remove(skyGroup)
    skyDomeGeometry.dispose()
    skyDomeMaterial.dispose()
    starsGeometry.dispose()
    starsMaterial.dispose()
    starTexture?.dispose()
    horizonTexture?.dispose()
    horizonMaterial.dispose()
    skyGradient?.texture.dispose()
    sunTexture?.dispose()
    sunGlowTexture?.dispose()
    moonTexture?.dispose()
    moonGlowTexture?.dispose()
    sunCoreMaterial.dispose()
    sunGlowMaterial.dispose()
    moonCoreMaterial.dispose()
    moonGlowMaterial.dispose()
    headGeometry.dispose()
    bowlGeometry.dispose()
    tailGeometry.dispose()
    eyeGeometry.dispose()
    pupilGeometry.dispose()
    eyeMaterial.dispose()
    pupilMaterial.dispose()
	    boostDraftGeometry.dispose()
	    boostDraftTexture?.dispose()
    intakeConeGeometry.dispose()
    intakeConeTexture?.dispose()
    menuPreviewOverlay.dispose()
    pointerArrowOverlay.material.dispose()
    pointerArrowOverlay.geometry.dispose()
		    for (const texture of snakeSkinTextureCache.values()) {
		      texture.dispose()
		    }
    snakeSkinTextureCache.clear()
    for (let i = 0; i < pelletBuckets.length; i += 1) {
      const bucket = pelletBuckets[i]
      if (!bucket) continue
      if (bucket.kind === 'points') {
        pelletsGroup.remove(bucket.shadowPoints)
        pelletsGroup.remove(bucket.glowPoints)
        pelletsGroup.remove(bucket.innerGlowPoints)
        pelletsGroup.remove(bucket.corePoints)
        bucket.corePoints.geometry.dispose()
        bucket.shadowMaterial.dispose()
        bucket.coreMaterial.dispose()
        bucket.innerGlowMaterial.dispose()
        bucket.glowMaterial.dispose()
      } else {
        pelletsGroup.remove(bucket.shadowSprite)
        pelletsGroup.remove(bucket.glowSprite)
        pelletsGroup.remove(bucket.innerGlowSprite)
        pelletsGroup.remove(bucket.coreSprite)
        // Sprite geometry is shared; only dispose materials.
        bucket.shadowMaterial.dispose()
        bucket.coreMaterial.dispose()
        bucket.innerGlowMaterial.dispose()
        bucket.glowMaterial.dispose()
      }
      pelletBuckets[i] = null
    }
    pelletShadowTexture?.dispose()
    pelletCoreTexture?.dispose()
    pelletInnerGlowTexture?.dispose()
    pelletGlowTexture?.dispose()
    occluderDepthMaterial.dispose()
    pelletGroundCache.clear()
    pelletMotionStates.clear()
    pelletVisualStates.clear()
    pelletConsumeGhosts.length = 0
    pelletMouthTargets.clear()
    pelletConsumeTargetByPelletId.clear()
    pelletIdsSeen.clear()
    for (const [id, visual] of snakes) {
      removeSnake(visual, id)
    }
    snakes.clear()
    disposeAllBoostTrails()
    boostTrailAlphaTexture?.dispose()
    if ((debugEnabled || perfDebugEnabled) && typeof window !== 'undefined') {
      const debugWindow = window as Window & { __SNAKE_DEBUG__?: unknown }
      if (debugWindow.__SNAKE_DEBUG__ === debugApi) {
        delete debugWindow.__SNAKE_DEBUG__
      }
    }
  }
  return {
    resize,
    render,
    setPointerScreen,
    getPointerAxis,
    setMenuPreviewVisible,
    setMenuPreviewSkin,
    setMenuPreviewOrbit,
    queuePelletConsumeTargets,
    clearPelletConsumeTargets,
    setWebgpuWorldSamples: webgpuOffscreenEnabled ? setWebgpuWorldSamples : undefined,
    setEnvironment,
    setDebugFlags,
    setDayNightDebugMode,
    dispose,
  }
}
