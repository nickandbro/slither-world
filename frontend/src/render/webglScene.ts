import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils'
import type {
  Camera,
  DigestionSnapshot,
  Environment,
  GameStateSnapshot,
  PelletSnapshot,
  PlayerSnapshot,
  Point,
} from '../game/types'

type SnakeVisual = {
  group: THREE.Group
  tube: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  head: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  tail: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  eyeLeft: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  eyeRight: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  pupilLeft: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  pupilRight: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  tongue: THREE.Group
  tongueBase: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  tongueForkLeft: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  tongueForkRight: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  bowl: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>
  bowlMaterial: THREE.MeshPhysicalMaterial
  bowlCrackUniform: { value: number }
  color: string
}

type TongueState = {
  length: number
  mode: 'idle' | 'extend' | 'retract'
  targetPosition: THREE.Vector3 | null
  carrying: boolean
}

type PelletOverride = {
  id: number
  position: THREE.Vector3
}

type DigestionVisual = {
  t: number
  strength: number
}

type PelletSpriteBucket = {
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>
  positionAttribute: THREE.BufferAttribute
  capacity: number
}

const createPelletSpriteTexture = () => {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const center = size * 0.5
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, center)
  gradient.addColorStop(0, 'rgba(255,255,255,0.96)')
  gradient.addColorStop(0.2, 'rgba(255,255,255,0.82)')
  gradient.addColorStop(0.54, 'rgba(255,255,255,0.3)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.clearRect(0, 0, size, size)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

type TailAddState = {
  progress: number
  duration: number
  carryDistance: number
  carryExtra: number | null
  startPos: THREE.Vector3 | null
}

type TailExtraState = {
  value: number
}

type TailDebugState = {
  lastExtendActive: boolean
  lastExtBucket: number
  lastDirAngleBucket: number
}

type DeathState = {
  start: number
}

type Lake = {
  center: THREE.Vector3
  radius: number
  depth: number
  shelfDepth: number
  edgeFalloff: number
  noiseAmplitude: number
  noiseFrequency: number
  noiseFrequencyB: number
  noiseFrequencyC: number
  noisePhase: number
  noisePhaseB: number
  noisePhaseC: number
  warpAmplitude: number
  tangent: THREE.Vector3
  bitangent: THREE.Vector3
  surfaceInset: number
}

type LakeWaterUniforms = {
  time: { value: number }
}

type LakeMaterialUserData = {
  lakeWaterUniforms?: LakeWaterUniforms
}

type TreeInstance = {
  normal: THREE.Vector3
  widthScale: number
  heightScale: number
  twist: number
}

type MountainInstance = {
  normal: THREE.Vector3
  radius: number
  height: number
  variant: number
  twist: number
  outline: number[]
  tangent: THREE.Vector3
  bitangent: THREE.Vector3
}

type TerrainPatchInstance = {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  center: THREE.Vector3
  angularExtent: number
  visible: boolean
}

type TreeCullEntry = {
  basePoint: THREE.Vector3
  topPoint: THREE.Vector3
  baseRadius: number
  topRadius: number
}

type CactusCullEntry = {
  basePoint: THREE.Vector3
  topPoint: THREE.Vector3
  leftArmTipPoint: THREE.Vector3
  rightArmTipPoint: THREE.Vector3
  baseRadius: number
  topRadius: number
  armRadius: number
}

type MountainCullEntry = {
  basePoint: THREE.Vector3
  peakPoint: THREE.Vector3
  baseRadius: number
  peakRadius: number
  variant: number
}

type PebbleCullEntry = {
  point: THREE.Vector3
  radius: number
}

type TerrainContactTriangle = {
  ax: number
  ay: number
  az: number
  e1x: number
  e1y: number
  e1z: number
  e2x: number
  e2y: number
  e2z: number
}

type TerrainContactSampler = {
  bands: number
  slices: number
  buckets: number[][]
  triangles: TerrainContactTriangle[]
}

type SnakeGroundingInfo = {
  minClearance: number
  maxPenetration: number
  maxAppliedLift: number
  sampleCount: number
}

export type RendererPreference = 'auto' | 'webgl' | 'webgpu'
export type RendererBackend = 'webgl' | 'webgpu'

export type RenderScene = {
  resize: (width: number, height: number, dpr: number) => void
  render: (
    snapshot: GameStateSnapshot | null,
    camera: Camera,
    localPlayerId: string | null,
    cameraDistance: number,
  ) => { x: number; y: number } | null
  setEnvironment: (environment: Environment) => void
  setDebugFlags: (flags: {
    mountainOutline?: boolean
    lakeCollider?: boolean
    treeCollider?: boolean
    terrainTessellation?: boolean
  }) => void
  dispose: () => void
}

export type WebGLScene = RenderScene

export type CreateRenderSceneResult = {
  scene: RenderScene
  activeBackend: RendererBackend
  fallbackReason: string | null
}

const BASE_PLANET_RADIUS = 1
const PLANET_RADIUS = 3
const PLANET_SCALE = PLANET_RADIUS / BASE_PLANET_RADIUS
const PLANET_BASE_ICOSPHERE_DETAIL = 16
const PLANET_PATCH_ENABLED = true
const PLANET_PATCH_BANDS = 12
const PLANET_PATCH_SLICES = 24
const TERRAIN_CONTACT_BANDS = PLANET_PATCH_BANDS
const TERRAIN_CONTACT_SLICES = PLANET_PATCH_SLICES
const TERRAIN_CONTACT_EPS = 1e-6
const PLANET_PATCH_VIEW_MARGIN = 0.18
const PLANET_PATCH_HIDE_EXTRA = 0.06
const PLANET_OBJECT_VIEW_MARGIN = 0.14
const PLANET_OBJECT_HIDE_EXTRA = 0.06
const PLANET_EDGE_PRELOAD_START_ANGLE = 0.45
const PLANET_EDGE_PRELOAD_END_ANGLE = 1.25
const TREE_EDGE_PRELOAD_MARGIN = 0.22
const TREE_EDGE_PRELOAD_HIDE_EXTRA = 0.14
const TREE_EDGE_PRELOAD_OCCLUSION_LEAD = 1.9
const ROCK_EDGE_PRELOAD_MARGIN = 0.2
const ROCK_EDGE_PRELOAD_HIDE_EXTRA = 0.12
const ROCK_EDGE_PRELOAD_OCCLUSION_LEAD = 1.55
const PEBBLE_EDGE_PRELOAD_MARGIN = 0.16
const PEBBLE_EDGE_PRELOAD_HIDE_EXTRA = 0.1
const PEBBLE_EDGE_PRELOAD_OCCLUSION_LEAD = 1.4
const PLANET_PATCH_OUTER_MIN = 0.22
const PLANET_PATCH_OUTER_MAX = 1.4
const LAKE_SURFACE_ICOSPHERE_DETAIL = 18
const LAKE_SURFACE_SEGMENTS = 96
const LAKE_SURFACE_RINGS = 64
const LAKE_COUNT = 2
const LAKE_MIN_ANGLE = 0.9 / PLANET_SCALE
const LAKE_MAX_ANGLE = 1.3 / PLANET_SCALE
const LAKE_MIN_DEPTH = BASE_PLANET_RADIUS * 0.1
const LAKE_MAX_DEPTH = BASE_PLANET_RADIUS * 0.17
// Wider and softer shoreline transition to reduce visible faceting pop at patch updates.
const LAKE_EDGE_FALLOFF = 0.08 * 2.5
const LAKE_EDGE_SHARPNESS = 1.8 / 2.4
const LAKE_NOISE_AMPLITUDE = 0.55
const LAKE_NOISE_FREQ_MIN = 3
const LAKE_NOISE_FREQ_MAX = 6
const LAKE_SHELF_DEPTH_RATIO = 0.45
const LAKE_SHELF_CORE = 0.55
const LAKE_CENTER_PIT_START = 0.72
const LAKE_CENTER_PIT_RATIO = 0.5
const LAKE_SURFACE_INSET_RATIO = 0.5
const LAKE_SURFACE_EXTRA_INSET = BASE_PLANET_RADIUS * 0.01
const LAKE_SURFACE_DEPTH_EPS = BASE_PLANET_RADIUS * 0.0015
const LAKE_DEBUG_SEGMENTS = 128
const LAKE_DEBUG_OFFSET = 0.02
const TREE_DEBUG_SEGMENTS = 64
const TREE_DEBUG_OFFSET = 0.02
const DEATH_FADE_DURATION = 3
const DEATH_START_OPACITY = 0.9
const DEATH_VISIBILITY_CUTOFF = 0.02

const WORLD_UP = new THREE.Vector3(0, 1, 0)
const WORLD_RIGHT = new THREE.Vector3(1, 0, 0)
const LAKE_WATER_OVERDRAW = BASE_PLANET_RADIUS * 0.01
const LAKE_WATER_SURFACE_LIFT = LAKE_WATER_OVERDRAW * 1.4
const LAKE_WATER_EDGE_EXPAND_ANGLE = 0.045
const LAKE_WATER_EDGE_EXPAND_BOUNDARY = 0.12
const LAKE_VISIBILITY_EXTRA_RADIUS = 0.1
const LAKE_VISIBILITY_MARGIN = 0.32
const LAKE_VISIBILITY_HIDE_EXTRA = 0.18
const LAKE_TERRAIN_CLAMP_EPS = BASE_PLANET_RADIUS * 0.0012
const LAKE_VISUAL_DEPTH_MULT = 1.75
const LAKE_SHORE_DROP_BLEND_START = 0.05
const LAKE_SHORE_DROP_BLEND_END = 0.85
const LAKE_SHORE_DROP_EXP = 1.2
const LAKE_SHORE_DROP_EXTRA_MAX = BASE_PLANET_RADIUS * 0.045
const LAKE_WATER_OPACITY = 0.65
const LAKE_WATER_WAVE_SPEED = 0.65
const LAKE_WATER_WAVE_SCALE = 22
const LAKE_WATER_WAVE_STRENGTH = 0.18
const LAKE_WATER_FRESNEL_STRENGTH = 0.35
const LAKE_WATER_ALPHA_PULSE = 0.1
const LAKE_WATER_EMISSIVE_BASE = 0.38
const LAKE_WATER_EMISSIVE_PULSE = 0.08
const LAKE_WATER_MASK_THRESHOLD = 0
const LAKE_GRID_MASK_THRESHOLD = LAKE_WATER_MASK_THRESHOLD
const LAKE_EXCLUSION_THRESHOLD = 0.18
const GRID_LINE_COLOR = '#6fc85f'
const GRID_LINE_OPACITY = 0.16
const SHORELINE_LINE_OPACITY = 0.24
const SHORE_SAND_COLOR = '#d8c48a'
const SNAKE_RADIUS = 0.045
const HEAD_RADIUS = SNAKE_RADIUS * 1.35
const SNAKE_LIFT_FACTOR = 0.85
const SNAKE_UNDERWATER_CLEARANCE = SNAKE_RADIUS * 0.18
const SNAKE_MIN_TERRAIN_CLEARANCE = SNAKE_RADIUS * 0.1
const SNAKE_CONTACT_CLEARANCE = SNAKE_RADIUS * 0.04
const SNAKE_CONTACT_ARC_SAMPLES = 7
const SNAKE_CONTACT_LIFT_ITERATIONS = 2
const SNAKE_CONTACT_LIFT_EPS = 1e-5
const SNAKE_WATERLINE_BLEND_START = 0.08
const SNAKE_WATERLINE_BLEND_END = 0.55
const SNAKE_SLOPE_INSERT_RADIUS_DELTA = SNAKE_RADIUS * 0.4
const EYE_RADIUS = SNAKE_RADIUS * 0.62
const PUPIL_RADIUS = EYE_RADIUS * 0.4
const PUPIL_OFFSET = EYE_RADIUS - PUPIL_RADIUS * 0.6
const PELLET_RADIUS = SNAKE_RADIUS * 0.34
const PELLET_OFFSET = 0.02
const PELLET_GROUND_CACHE_NORMAL_EPS = 0.0000005
const PELLET_COLORS = [
  '#ff5f6d',
  '#ffc857',
  '#5cff8d',
  '#5dc9ff',
  '#9f7bff',
  '#ff7bcb',
  '#ffd86b',
  '#6bffea',
  '#8be15b',
  '#ff9642',
  '#6f8bff',
  '#f9ff6b',
]
const TONGUE_MAX_LENGTH = HEAD_RADIUS * 2.8
const TONGUE_MAX_RANGE = HEAD_RADIUS * 3.1
const TONGUE_NEAR_RANGE = HEAD_RADIUS * 2.4
const TONGUE_RADIUS = SNAKE_RADIUS * 0.2
const TONGUE_FORK_LENGTH = HEAD_RADIUS * 0.45
const TONGUE_FORK_SPREAD = 0.55
const TONGUE_MOUTH_FORWARD = HEAD_RADIUS * 0.6
const TONGUE_MOUTH_OUT = HEAD_RADIUS * 0.1
const TONGUE_ANGLE_LIMIT = Math.PI / 6
const TONGUE_EXTEND_RATE = 10
const TONGUE_RETRACT_RATE = 14
const TONGUE_HIDE_THRESHOLD = HEAD_RADIUS * 0.12
const TONGUE_GRAB_EPS = HEAD_RADIUS * 0.12
const TONGUE_PELLET_MATCH = HEAD_RADIUS * 1.6
const TAIL_CAP_SEGMENTS = 5
const TAIL_DIR_MIN_RATIO = 0.35
const DIGESTION_BULGE_MIN = 0.14
const DIGESTION_BULGE_MAX = 0.55
const DIGESTION_WIDTH_MIN = 1.5
const DIGESTION_WIDTH_MAX = 3.2
const DIGESTION_MAX_BULGE_MIN = 0.8
const DIGESTION_MAX_BULGE_MAX = 0.85
const DIGESTION_START_RINGS = 0
const DIGESTION_START_MAX = 0
const DIGESTION_TRAVEL_EASE = 1
const TAIL_ADD_SMOOTH_MS = 180
const TAIL_EXTEND_RATE_UP = 0.14
const TAIL_EXTEND_RATE_DOWN = 2.6
const TAIL_EXTEND_RATE_UP_ADD = 0.12
const TAIL_EXTEND_RATE_DOWN_ADD = 1.6
const TAIL_EXTEND_MAX_GROW_SPEED = 0.12
const TAIL_EXTEND_MAX_GROW_SPEED_ADD = 0.08
const TAIL_EXTEND_MAX_SHRINK_SPEED = 0.35
const TAIL_EXTEND_MAX_SHRINK_SPEED_ADD = 0.25
const TAIL_GROWTH_RATE_UP = 0.35
const TAIL_GROWTH_RATE_DOWN = 1.2
const TAIL_GROWTH_EASE = 2.5
const TAIL_EXTEND_CURVE_BLEND = 0.65
const DEBUG_TAIL = false
const TREE_COUNT = 36
const TREE_BASE_OFFSET = 0.004
const TREE_HEIGHT = BASE_PLANET_RADIUS * 0.3
const TREE_TRUNK_HEIGHT = TREE_HEIGHT / 3
const TREE_TRUNK_RADIUS = TREE_HEIGHT * 0.12
const TREE_TIER_HEIGHT_FACTORS = [0.4, 0.33, 0.27, 0.21]
const TREE_TIER_RADIUS_FACTORS = [0.5, 0.44, 0.36, 0.28]
const TREE_TIER_OVERLAP = 0.55
const TREE_MIN_SCALE = 0.9
const TREE_MAX_SCALE = 1.15
const TREE_MIN_ANGLE = 0.42
const TREE_MIN_HEIGHT = SNAKE_RADIUS * 9.5
const TREE_MAX_HEIGHT = TREE_MIN_HEIGHT * 1.5
const DESERT_CACTUS_COUNT = 8
const DESERT_BIOME_ANGLE = 0.86
const DESERT_BIOME_BLEND = 0.12
const DESERT_DUNE_PRIMARY = BASE_PLANET_RADIUS * 0.065
const DESERT_DUNE_SECONDARY = BASE_PLANET_RADIUS * 0.03
const DESERT_DUNE_TERTIARY = BASE_PLANET_RADIUS * 0.018
const DESERT_GROUND_COLOR = new THREE.Color('#d8bf78')
const FOREST_GROUND_COLOR = new THREE.Color('#6ea95a')
const DESERT_BIOME_CENTER = new THREE.Vector3(
  -0.19391259652276868,
  0.9788150619715452,
  0.06571894222701674,
).normalize()
const DESERT_BIOME_MIN_DOT = Math.cos(DESERT_BIOME_ANGLE)
const CACTUS_TRUNK_HEIGHT = TREE_HEIGHT * 0.96
const CACTUS_TRUNK_RADIUS = TREE_TRUNK_RADIUS * 0.88
const CACTUS_LEFT_ARM_BASE_HEIGHT = CACTUS_TRUNK_HEIGHT * 0.36
const CACTUS_RIGHT_ARM_BASE_HEIGHT = CACTUS_TRUNK_HEIGHT * 0.57
const CACTUS_LEFT_ARM_RADIUS = CACTUS_TRUNK_RADIUS * 0.58
const CACTUS_RIGHT_ARM_RADIUS = CACTUS_TRUNK_RADIUS * 0.5
const CACTUS_TRUNK_TUBE_SEGMENTS = 18
const CACTUS_ARM_TUBE_SEGMENTS = 14
const CACTUS_TUBE_RADIAL_SEGMENTS = 8
const CACTUS_UNIFORM_SCALE_MULTIPLIER = 1.0
const CACTUS_MIN_UNIFORM_SCALE = 0.98
const CACTUS_MAX_UNIFORM_SCALE = 1.2
// Match tree grounding so cactus bases clip slightly into the surface.
const CACTUS_BASE_SINK = CACTUS_TRUNK_HEIGHT * 0.12
const MOUNTAIN_COUNT = 8
const MOUNTAIN_VARIANTS = 3
const MOUNTAIN_OUTLINE_SAMPLES = 64
const MOUNTAIN_RADIUS_MIN = BASE_PLANET_RADIUS * 0.12
const MOUNTAIN_RADIUS_MAX = BASE_PLANET_RADIUS * 0.22
const MOUNTAIN_HEIGHT_MIN = BASE_PLANET_RADIUS * 0.12
const MOUNTAIN_HEIGHT_MAX = BASE_PLANET_RADIUS * 0.26
const MOUNTAIN_BASE_SINK = 0.015
const MOUNTAIN_MIN_ANGLE = 0.55
const PEBBLE_COUNT = 220
const PEBBLE_RADIUS_MIN = BASE_PLANET_RADIUS * 0.0045
const PEBBLE_RADIUS_MAX = BASE_PLANET_RADIUS * 0.014
const PEBBLE_OFFSET = 0.0015
const PEBBLE_RADIUS_VARIANCE = 0.8

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
const formatNum = (value: number, digits = 4) =>
  Number.isFinite(value) ? value.toFixed(digits) : 'NaN'
const smoothValue = (current: number, target: number, deltaSeconds: number, rateUp: number, rateDown: number) => {
  const rate = target >= current ? rateUp : rateDown
  const alpha = 1 - Math.exp(-rate * Math.max(0, deltaSeconds))
  return current + (target - current) * alpha
}

const surfaceAngleFromRay = (cameraDistance: number, halfFov: number) => {
  const clampedDistance = Math.max(cameraDistance, PLANET_RADIUS + 1e-3)
  const sinHalf = Math.sin(halfFov)
  const cosHalf = Math.cos(halfFov)
  const under = PLANET_RADIUS * PLANET_RADIUS - clampedDistance * clampedDistance * sinHalf * sinHalf
  if (under <= 0) {
    return Math.acos(clamp(PLANET_RADIUS / clampedDistance, -1, 1))
  }
  const rayDistance = clampedDistance * cosHalf - Math.sqrt(under)
  const hitZ = clampedDistance - rayDistance * cosHalf
  return Math.acos(clamp(hitZ / PLANET_RADIUS, -1, 1))
}

const computeVisibleSurfaceAngle = (cameraDistance: number, aspect: number) => {
  const halfY = (40 * Math.PI) / 360
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const halfX = Math.atan(Math.tan(halfY) * safeAspect)
  const halfDiag = Math.min(Math.PI * 0.499, Math.hypot(halfX, halfY))
  const base = surfaceAngleFromRay(cameraDistance, halfDiag)
  return clamp(base, PLANET_PATCH_OUTER_MIN, PLANET_PATCH_OUTER_MAX)
}
const createMountainGeometry = (seed: number) => {
  const rand = createSeededRandom(seed)
  const baseGeometry = new THREE.DodecahedronGeometry(1, 0)
  const geometry = mergeVertices(baseGeometry, 1e-3)
  const positions = geometry.attributes.position
  const temp = new THREE.Vector3()
  const variance = 0.18 + rand() * 0.06
  const hash3 = (x: number, y: number, z: number) => {
    let h = seed ^ 0x9e3779b9
    h = Math.imul(h ^ x, 0x85ebca6b)
    h = Math.imul(h ^ y, 0xc2b2ae35)
    h = Math.imul(h ^ z, 0x27d4eb2f)
    h ^= h >>> 16
    return (h >>> 0) / 4294967296
  }
  for (let i = 0; i < positions.count; i += 1) {
    temp.set(positions.getX(i), positions.getY(i), positions.getZ(i))
    if (temp.lengthSq() < 1e-6) continue
    temp.normalize()
    const qx = Math.round(temp.x * 1024)
    const qy = Math.round(temp.y * 1024)
    const qz = Math.round(temp.z * 1024)
    const jitter = hash3(qx, qy, qz) * 2 - 1
    const scale = 1 + jitter * variance
    temp.multiplyScalar(scale)
    positions.setXYZ(i, temp.x, temp.y, temp.z)
  }
  positions.needsUpdate = true
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}
const slerpOnSphere = (from: THREE.Vector3, to: THREE.Vector3, alpha: number, radius: number) => {
  const fromDir = from.clone().normalize()
  const toDir = to.clone().normalize()
  const dotValue = clamp(fromDir.dot(toDir), -1, 1)
  const angle = Math.acos(dotValue)
  if (!Number.isFinite(angle) || angle < 1e-6) {
    return toDir.multiplyScalar(radius)
  }
  const axis = new THREE.Vector3().crossVectors(fromDir, toDir)
  if (axis.lengthSq() < 1e-8) {
    return toDir.multiplyScalar(radius)
  }
  axis.normalize()
  fromDir.applyAxisAngle(axis, angle * alpha)
  return fromDir.multiplyScalar(radius)
}
const createSeededRandom = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const createIcosphereGeometry = (radius: number, detail: number) => {
  const clampedDetail = Math.max(0, Math.floor(detail))
  const geometry = new THREE.IcosahedronGeometry(radius, clampedDetail)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

const bucketIndexFromDirection = (
  normal: THREE.Vector3,
  bands: number,
  slices: number,
) => {
  const latitude = Math.asin(clamp(normal.y, -1, 1))
  const longitude = Math.atan2(normal.z, normal.x)
  const band = clamp(
    Math.floor(((latitude + Math.PI * 0.5) / Math.PI) * bands),
    0,
    bands - 1,
  )
  const slice = clamp(
    Math.floor(((longitude + Math.PI) / (Math.PI * 2)) * slices),
    0,
    slices - 1,
  )
  return { band, slice }
}

const createTerrainContactSampler = (
  geometry: THREE.BufferGeometry,
  bands: number,
  slices: number,
): TerrainContactSampler | null => {
  const positionAttr = geometry.getAttribute('position')
  if (!(positionAttr instanceof THREE.BufferAttribute)) return null
  const indexAttr = geometry.getIndex()
  const triCount = indexAttr
    ? Math.floor(indexAttr.count / 3)
    : Math.floor(positionAttr.count / 3)
  if (triCount <= 0) return null

  const buckets = Array.from({ length: bands * slices }, () => [] as number[])
  const triangles: TerrainContactTriangle[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const edge1 = new THREE.Vector3()
  const edge2 = new THREE.Vector3()
  const cross = new THREE.Vector3()
  const centroid = new THREE.Vector3()

  const readVertex = (index: number, out: THREE.Vector3) => {
    out.set(positionAttr.getX(index), positionAttr.getY(index), positionAttr.getZ(index))
  }

  for (let tri = 0; tri < triCount; tri += 1) {
    const i0 = indexAttr ? indexAttr.getX(tri * 3) : tri * 3
    const i1 = indexAttr ? indexAttr.getX(tri * 3 + 1) : tri * 3 + 1
    const i2 = indexAttr ? indexAttr.getX(tri * 3 + 2) : tri * 3 + 2
    readVertex(i0, a)
    readVertex(i1, b)
    readVertex(i2, c)

    edge1.copy(b).sub(a)
    edge2.copy(c).sub(a)
    cross.copy(edge1).cross(edge2)
    if (cross.lengthSq() <= TERRAIN_CONTACT_EPS) continue

    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3)
    if (centroid.lengthSq() <= TERRAIN_CONTACT_EPS) continue
    centroid.normalize()
    const { band, slice } = bucketIndexFromDirection(centroid, bands, slices)
    const triIndex = triangles.length
    triangles.push({
      ax: a.x,
      ay: a.y,
      az: a.z,
      e1x: edge1.x,
      e1y: edge1.y,
      e1z: edge1.z,
      e2x: edge2.x,
      e2y: edge2.y,
      e2z: edge2.z,
    })
    buckets[band * slices + slice].push(triIndex)
  }

  if (triangles.length === 0) return null
  return { bands, slices, buckets, triangles }
}

const sampleTerrainContactRadius = (
  sampler: TerrainContactSampler,
  direction: THREE.Vector3,
): number | null => {
  if (direction.lengthSq() <= TERRAIN_CONTACT_EPS) return null
  const { band, slice } = bucketIndexFromDirection(
    direction,
    sampler.bands,
    sampler.slices,
  )
  let bestT = Number.POSITIVE_INFINITY

  for (let bandOffset = -1; bandOffset <= 1; bandOffset += 1) {
    const sampleBand = band + bandOffset
    if (sampleBand < 0 || sampleBand >= sampler.bands) continue
    for (let sliceOffset = -1; sliceOffset <= 1; sliceOffset += 1) {
      let sampleSlice = slice + sliceOffset
      if (sampleSlice < 0) sampleSlice += sampler.slices
      if (sampleSlice >= sampler.slices) sampleSlice -= sampler.slices
      const bucket = sampler.buckets[sampleBand * sampler.slices + sampleSlice]
      if (!bucket || bucket.length === 0) continue

      for (let i = 0; i < bucket.length; i += 1) {
        const triangle = sampler.triangles[bucket[i]]
        if (!triangle) continue

        const hx = direction.y * triangle.e2z - direction.z * triangle.e2y
        const hy = direction.z * triangle.e2x - direction.x * triangle.e2z
        const hz = direction.x * triangle.e2y - direction.y * triangle.e2x
        const det = triangle.e1x * hx + triangle.e1y * hy + triangle.e1z * hz
        if (Math.abs(det) <= TERRAIN_CONTACT_EPS) continue
        const invDet = 1 / det

        const sx = -triangle.ax
        const sy = -triangle.ay
        const sz = -triangle.az
        const u = (sx * hx + sy * hy + sz * hz) * invDet
        if (u < 0 || u > 1) continue

        const qx = sy * triangle.e1z - sz * triangle.e1y
        const qy = sz * triangle.e1x - sx * triangle.e1z
        const qz = sx * triangle.e1y - sy * triangle.e1x
        const v = (direction.x * qx + direction.y * qy + direction.z * qz) * invDet
        if (v < 0 || u + v > 1) continue

        const t = (triangle.e2x * qx + triangle.e2y * qy + triangle.e2z * qz) * invDet
        if (t > TERRAIN_CONTACT_EPS && t < bestT) {
          bestT = t
        }
      }
    }
  }

  if (!Number.isFinite(bestT)) return null
  return bestT
}

const createLakes = (seed: number, count: number) => {
  const rng = createSeededRandom(seed)
  const lakes: Lake[] = []
  const randRange = (min: number, max: number) => min + (max - min) * rng()
  const pickCenter = (radius: number, out: THREE.Vector3) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      randomOnSphere(rng, out)
      if (isDesertBiome(out)) {
        continue
      }
      let ok = true
      for (const lake of lakes) {
        const minSeparation = (radius + lake.radius) * 0.75
        if (out.dot(lake.center) > Math.cos(minSeparation)) {
          ok = false
          break
        }
      }
      if (ok) return out
    }
    for (let attempt = 0; attempt < 120; attempt += 1) {
      randomOnSphere(rng, out)
      if (!isDesertBiome(out)) return out
    }
    return randomOnSphere(rng, out)
  }
  for (let i = 0; i < count; i += 1) {
    const radius = randRange(LAKE_MIN_ANGLE, LAKE_MAX_ANGLE)
    const depth = randRange(LAKE_MIN_DEPTH, LAKE_MAX_DEPTH)
    const shelfDepth = depth * LAKE_SHELF_DEPTH_RATIO
    const center = new THREE.Vector3()
    pickCenter(radius, center)
    const up = Math.abs(center.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
    const tangent = new THREE.Vector3().crossVectors(up, center).normalize()
    const bitangent = new THREE.Vector3().crossVectors(center, tangent).normalize()
    const noiseFrequency = randRange(LAKE_NOISE_FREQ_MIN, LAKE_NOISE_FREQ_MAX)
    const noiseFrequencyB = noiseFrequency * randRange(0.55, 0.95)
    const noiseFrequencyC = noiseFrequency * randRange(1.1, 1.7)
    const noisePhase = rng() * Math.PI * 2
    const noisePhaseB = rng() * Math.PI * 2
    const noisePhaseC = rng() * Math.PI * 2
    const warpAmplitude = randRange(0.08, 0.18)
    lakes.push({
      center,
      radius,
      depth,
      shelfDepth,
      edgeFalloff: LAKE_EDGE_FALLOFF,
      noiseAmplitude: LAKE_NOISE_AMPLITUDE,
      noiseFrequency,
      noiseFrequencyB,
      noiseFrequencyC,
      noisePhase,
      noisePhaseB,
      noisePhaseC,
      warpAmplitude,
      tangent,
      bitangent,
      surfaceInset: shelfDepth * LAKE_SURFACE_INSET_RATIO + LAKE_SURFACE_EXTRA_INSET,
    })
  }
  return lakes
}
const buildTangentBasis = (
  normal: THREE.Vector3,
  tangent: THREE.Vector3,
  bitangent: THREE.Vector3,
) => {
  const up = Math.abs(normal.y) < 0.9 ? WORLD_UP : WORLD_RIGHT
  tangent.copy(up).cross(normal).normalize()
  bitangent.copy(normal).cross(tangent).normalize()
}

const buildLakeFromData = (data: Environment['lakes'][number]) => {
  const center = new THREE.Vector3(data.center.x, data.center.y, data.center.z).normalize()
  const tangent = new THREE.Vector3()
  const bitangent = new THREE.Vector3()
  buildTangentBasis(center, tangent, bitangent)
  return {
    center,
    radius: data.radius,
    depth: data.depth,
    shelfDepth: data.shelfDepth,
    edgeFalloff: data.edgeFalloff,
    noiseAmplitude: data.noiseAmplitude,
    noiseFrequency: data.noiseFrequency,
    noiseFrequencyB: data.noiseFrequencyB,
    noiseFrequencyC: data.noiseFrequencyC,
    noisePhase: data.noisePhase,
    noisePhaseB: data.noisePhaseB,
    noisePhaseC: data.noisePhaseC,
    warpAmplitude: data.warpAmplitude,
    surfaceInset: data.surfaceInset,
    tangent,
    bitangent,
  }
}

const buildTreeFromData = (data: Environment['trees'][number]): TreeInstance => ({
  normal: new THREE.Vector3(data.normal.x, data.normal.y, data.normal.z).normalize(),
  widthScale: data.widthScale,
  heightScale: data.heightScale,
  twist: data.twist,
})

const buildMountainFromData = (data: Environment['mountains'][number]): MountainInstance => {
  const normal = new THREE.Vector3(data.normal.x, data.normal.y, data.normal.z).normalize()
  const tangent = new THREE.Vector3()
  const bitangent = new THREE.Vector3()
  buildTangentBasis(normal, tangent, bitangent)
  return {
    normal,
    radius: data.radius,
    height: data.height,
    variant: data.variant,
    twist: data.twist,
    outline: [...data.outline],
    tangent,
    bitangent,
  }
}
const sampleLakes = (normal: THREE.Vector3, lakes: Lake[], temp: THREE.Vector3) => {
  let maxBoundary = 0
  let maxDepth = 0
  let boundaryLake: Lake | null = null
  for (const lake of lakes) {
    const dot = clamp(lake.center.dot(normal), -1, 1)
    const angle = Math.acos(dot)
    if (angle >= lake.radius + lake.edgeFalloff) continue

    temp.copy(normal).addScaledVector(lake.center, -dot)
    const x = temp.dot(lake.tangent)
    const y = temp.dot(lake.bitangent)
    const warp = Math.sin((x + y) * lake.noiseFrequencyC + lake.noisePhaseC) * lake.warpAmplitude
    const u = x * lake.noiseFrequency + lake.noisePhase + warp
    const v = y * lake.noiseFrequencyB + lake.noisePhaseB - warp
    const w = (x - y) * lake.noiseFrequencyC + lake.noisePhaseC * 0.7
    const noise =
      Math.sin(u) +
      Math.sin(v) +
      0.6 * Math.sin(2 * u + v * 0.6) +
      0.45 * Math.sin(2.3 * v - 0.7 * u) +
      0.35 * Math.sin(w)
    const noiseNormalized = noise / 3.15
    const edgeRadius = clamp(
      lake.radius * (1 + lake.noiseAmplitude * noiseNormalized),
      lake.radius * 0.65,
      lake.radius * 1.35,
    )
    if (angle >= edgeRadius) continue

    const shelfRadius = Math.max(1e-3, edgeRadius - lake.edgeFalloff)
    const edgeT = clamp((edgeRadius - angle) / lake.edgeFalloff, 0, 1)
    const edgeBlend = Math.pow(edgeT, LAKE_EDGE_SHARPNESS)
    const core = clamp(1 - angle / shelfRadius, 0, 1)
    const basinFactor = smoothstep(LAKE_SHELF_CORE, 1, core)
    const pitFactor = smoothstep(LAKE_CENTER_PIT_START, 1, core)
    const pitDepth = pitFactor * pitFactor * lake.depth * LAKE_CENTER_PIT_RATIO
    const depth =
      edgeBlend *
      (lake.shelfDepth + basinFactor * (lake.depth - lake.shelfDepth) + pitDepth)

    if (edgeBlend > maxBoundary) {
      maxBoundary = edgeBlend
      boundaryLake = lake
    }
    if (depth > maxDepth) maxDepth = depth
  }
  return { boundary: maxBoundary, depth: maxDepth, lake: boundaryLake }
}

const getLakeTerrainDepth = (sample: ReturnType<typeof sampleLakes>) => {
  if (!sample.lake || sample.boundary <= LAKE_WATER_MASK_THRESHOLD) return 0
  // Keep beds below water so moving actors follow the same terrain shape as the planet mesh.
  return Math.max(sample.depth, sample.lake.surfaceInset + LAKE_TERRAIN_CLAMP_EPS)
}

const getVisualLakeTerrainDepth = (sample: ReturnType<typeof sampleLakes>) => {
  const baseDepth = getLakeTerrainDepth(sample)
  if (!sample.lake || baseDepth <= 0) return 0
  const boundary = clamp(sample.boundary, 0, 1)
  const shoreBlendRaw =
    1 - smoothstep(LAKE_SHORE_DROP_BLEND_START, LAKE_SHORE_DROP_BLEND_END, boundary)
  const shoreBlend = Math.pow(shoreBlendRaw, LAKE_SHORE_DROP_EXP)
  const deepened = baseDepth * LAKE_VISUAL_DEPTH_MULT + shoreBlend * LAKE_SHORE_DROP_EXTRA_MAX
  return Math.max(deepened, sample.lake.surfaceInset + LAKE_TERRAIN_CLAMP_EPS)
}

const isDesertBiome = (normal: THREE.Vector3) => normal.dot(DESERT_BIOME_CENTER) >= DESERT_BIOME_MIN_DOT

const sampleDesertBlend = (normal: THREE.Vector3) => {
  const angle = Math.acos(clamp(normal.dot(DESERT_BIOME_CENTER), -1, 1))
  const start = Math.max(0, DESERT_BIOME_ANGLE - DESERT_BIOME_BLEND)
  const end = DESERT_BIOME_ANGLE + DESERT_BIOME_BLEND
  return 1 - smoothstep(start, end, angle)
}

const sampleDuneOffset = (normal: THREE.Vector3) => {
  const lon = Math.atan2(normal.z, normal.x)
  const lat = Math.asin(clamp(normal.y, -1, 1))
  const waveA = Math.sin(lon * 3.1 + lat * 1.7)
  const waveB = Math.sin(lon * 5.8 - lat * 2.6 + 1.2)
  const waveC = Math.cos((normal.x * 2.9 + normal.z * 2.15) * Math.PI + lat * 0.75)
  return waveA * DESERT_DUNE_PRIMARY + waveB * DESERT_DUNE_SECONDARY + waveC * DESERT_DUNE_TERTIARY
}

const applyLakeDepressions = (geometry: THREE.BufferGeometry, lakes: Lake[]) => {
  const positions = geometry.attributes.position
  const normal = new THREE.Vector3()
  const temp = new THREE.Vector3()
  const colors = new Float32Array(positions.count * 3)
  const deltaR = DESERT_GROUND_COLOR.r - FOREST_GROUND_COLOR.r
  const deltaG = DESERT_GROUND_COLOR.g - FOREST_GROUND_COLOR.g
  const deltaB = DESERT_GROUND_COLOR.b - FOREST_GROUND_COLOR.b
  for (let i = 0; i < positions.count; i += 1) {
    normal.set(positions.getX(i), positions.getY(i), positions.getZ(i)).normalize()
    const sample = sampleLakes(normal, lakes, temp)
    const depth = getVisualLakeTerrainDepth(sample)
    const desertBlend = sampleDesertBlend(normal)
    const duneOffset = sampleDuneOffset(normal) * desertBlend
    const radius = PLANET_RADIUS + duneOffset - depth
    positions.setXYZ(i, normal.x * radius, normal.y * radius, normal.z * radius)
    const colorIndex = i * 3
    colors[colorIndex] = FOREST_GROUND_COLOR.r + deltaR * desertBlend
    colors[colorIndex + 1] = FOREST_GROUND_COLOR.g + deltaG * desertBlend
    colors[colorIndex + 2] = FOREST_GROUND_COLOR.b + deltaB * desertBlend
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  positions.needsUpdate = true
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
}
const createLakeSurfaceGeometry = (sampleGeometry: THREE.BufferGeometry, lakes: Lake[]) => {
  const basePositions = sampleGeometry.attributes.position
  const lakePositions: number[] = []
  const lakeNormals: number[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const bc = new THREE.Vector3()
  const ca = new THREE.Vector3()
  const centroid = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const temp = new THREE.Vector3()
  const debug = isLakeDebugEnabled()
  const stats = debug
    ? {
        total: 0,
        included: 0,
        excludedNoLake: 0,
        excludedShallow: 0,
        boundary: 0,
        includedByDepth: 0,
        includedByBoundary: 0,
        maxBoundary: 0,
        minBoundary: Number.POSITIVE_INFINITY,
        minDepth: Number.POSITIVE_INFINITY,
        maxDepth: 0,
        minWaterLevel: Number.POSITIVE_INFINITY,
        maxWaterLevel: 0,
      }
    : null
  const samples: Array<{ sample: ReturnType<typeof sampleLakes>; depth: number }> = []
  const pushSample = (point: THREE.Vector3) => {
    normal.copy(point).normalize()
    const sample = sampleLakes(normal, lakes, temp)
    samples.push({ sample, depth: getVisualLakeTerrainDepth(sample) })
  }
  for (let i = 0; i < basePositions.count; i += 3) {
    if (stats) stats.total += 1
    a.set(basePositions.getX(i), basePositions.getY(i), basePositions.getZ(i))
    b.set(basePositions.getX(i + 1), basePositions.getY(i + 1), basePositions.getZ(i + 1))
    c.set(basePositions.getX(i + 2), basePositions.getY(i + 2), basePositions.getZ(i + 2))
    samples.length = 0

    pushSample(a)
    pushSample(b)
    pushSample(c)

    ab.copy(a).lerp(b, 0.5)
    pushSample(ab)
    bc.copy(b).lerp(c, 0.5)
    pushSample(bc)
    ca.copy(c).lerp(a, 0.5)
    pushSample(ca)

    ab.copy(a).lerp(b, 1 / 3)
    pushSample(ab)
    ab.copy(a).lerp(b, 2 / 3)
    pushSample(ab)
    bc.copy(b).lerp(c, 1 / 3)
    pushSample(bc)
    bc.copy(b).lerp(c, 2 / 3)
    pushSample(bc)
    ca.copy(c).lerp(a, 1 / 3)
    pushSample(ca)
    ca.copy(c).lerp(a, 2 / 3)
    pushSample(ca)

    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3)
    pushSample(centroid)

    let bestSample = samples[0]
    let maxDepth = samples[0].depth
    let maxBoundary = samples[0].sample.boundary
    for (let s = 1; s < samples.length; s += 1) {
      if (samples[s].depth > maxDepth) maxDepth = samples[s].depth
      if (samples[s].sample.boundary > maxBoundary) {
        maxBoundary = samples[s].sample.boundary
        bestSample = samples[s]
      }
    }

    if (!bestSample.sample.lake) {
      if (stats) stats.excludedNoLake += 1
      continue
    }

    let minDepth = samples[0].depth
    let minBoundary = samples[0].sample.boundary
    let minWaterLevel = Number.POSITIVE_INFINITY
    let maxWaterLevel = 0
    let includedByDepth = false
    let includedByBoundary = false
    for (let s = 1; s < samples.length; s += 1) {
      if (samples[s].depth < minDepth) minDepth = samples[s].depth
      if (samples[s].sample.boundary < minBoundary) minBoundary = samples[s].sample.boundary
    }
    for (let s = 0; s < samples.length; s += 1) {
      const lake = samples[s].sample.lake
      if (lake) {
        const waterLevel = lake.surfaceInset + LAKE_SURFACE_DEPTH_EPS - LAKE_WATER_OVERDRAW
        minWaterLevel = Math.min(minWaterLevel, waterLevel)
        maxWaterLevel = Math.max(maxWaterLevel, waterLevel)
        if (samples[s].depth > waterLevel) includedByDepth = true
      }
      if (samples[s].sample.boundary > LAKE_WATER_MASK_THRESHOLD - LAKE_WATER_EDGE_EXPAND_BOUNDARY) {
        includedByBoundary = true
      }
    }
    const waterLevel =
      bestSample.sample.lake.surfaceInset + LAKE_SURFACE_DEPTH_EPS - LAKE_WATER_OVERDRAW
    if (stats) {
      stats.minDepth = Math.min(stats.minDepth, minDepth)
      stats.maxDepth = Math.max(stats.maxDepth, maxDepth)
      stats.minBoundary = Math.min(stats.minBoundary, minBoundary)
      stats.maxBoundary = Math.max(stats.maxBoundary, maxBoundary)
      stats.minWaterLevel = Math.min(stats.minWaterLevel, minWaterLevel)
      stats.maxWaterLevel = Math.max(stats.maxWaterLevel, maxWaterLevel)
      if (minDepth < waterLevel && maxDepth > waterLevel) {
        stats.boundary += 1
      }
    }
    if (!includedByDepth && !includedByBoundary) {
      if (stats) stats.excludedShallow += 1
      continue
    }
    if (stats) {
      stats.included += 1
      if (includedByDepth) stats.includedByDepth += 1
      if (includedByBoundary) stats.includedByBoundary += 1
    }

    const surfaceRadius =
      PLANET_RADIUS - bestSample.sample.lake.surfaceInset + LAKE_WATER_SURFACE_LIFT
    normal.copy(a).normalize()
    lakePositions.push(normal.x * surfaceRadius, normal.y * surfaceRadius, normal.z * surfaceRadius)
    lakeNormals.push(normal.x, normal.y, normal.z)
    normal.copy(b).normalize()
    lakePositions.push(normal.x * surfaceRadius, normal.y * surfaceRadius, normal.z * surfaceRadius)
    lakeNormals.push(normal.x, normal.y, normal.z)
    normal.copy(c).normalize()
    lakePositions.push(normal.x * surfaceRadius, normal.y * surfaceRadius, normal.z * surfaceRadius)
    lakeNormals.push(normal.x, normal.y, normal.z)
  }

  const geometry = new THREE.BufferGeometry()
  if (lakePositions.length > 0) {
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(lakePositions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(lakeNormals, 3))
    geometry.computeBoundingSphere()
  }
  if (stats) {
    console.info('[LakeDebug]', stats)
    dumpLakeGeometry(geometry)
  }
  return geometry
}

const createLakeMaskMaterial = (lake: Lake) => {
  const material = new THREE.MeshStandardMaterial({
    color: '#2aa9ff',
    roughness: 0.18,
    metalness: 0.05,
    emissive: '#0a386b',
    emissiveIntensity: LAKE_WATER_EMISSIVE_BASE,
    transparent: true,
    opacity: LAKE_WATER_OPACITY,
  })
  material.depthWrite = true
  material.depthTest = true
  material.polygonOffset = true
  material.polygonOffsetFactor = -1
  material.polygonOffsetUnits = -1
  const extensions =
    (material as THREE.Material & { extensions?: { derivatives?: boolean } }).extensions ?? {}
  extensions.derivatives = true
  ;(material as THREE.Material & { extensions?: { derivatives?: boolean } }).extensions = extensions
  material.onBeforeCompile = (shader) => {
    const timeUniform = { value: 0 }
    shader.uniforms.lakeTime = timeUniform
    shader.uniforms.lakeCenter = { value: lake.center }
    shader.uniforms.lakeTangent = { value: lake.tangent }
    shader.uniforms.lakeBitangent = { value: lake.bitangent }
    shader.uniforms.lakeRadius = { value: lake.radius }
    shader.uniforms.lakeEdgeFalloff = { value: lake.edgeFalloff }
    shader.uniforms.lakeEdgeExpand = { value: LAKE_WATER_EDGE_EXPAND_ANGLE }
    shader.uniforms.lakeEdgeSharpness = { value: LAKE_EDGE_SHARPNESS }
    shader.uniforms.lakeNoiseAmplitude = { value: lake.noiseAmplitude }
    shader.uniforms.lakeNoiseFrequency = { value: lake.noiseFrequency }
    shader.uniforms.lakeNoiseFrequencyB = { value: lake.noiseFrequencyB }
    shader.uniforms.lakeNoiseFrequencyC = { value: lake.noiseFrequencyC }
    shader.uniforms.lakeNoisePhase = { value: lake.noisePhase }
    shader.uniforms.lakeNoisePhaseB = { value: lake.noisePhaseB }
    shader.uniforms.lakeNoisePhaseC = { value: lake.noisePhaseC }
    shader.uniforms.lakeWarpAmplitude = { value: lake.warpAmplitude }
    shader.uniforms.lakeWaveScale = { value: LAKE_WATER_WAVE_SCALE }
    shader.uniforms.lakeWaveSpeed = { value: LAKE_WATER_WAVE_SPEED }
    shader.uniforms.lakeWaveStrength = { value: LAKE_WATER_WAVE_STRENGTH }
    shader.uniforms.lakeFresnelStrength = { value: LAKE_WATER_FRESNEL_STRENGTH }
    shader.uniforms.lakeAlphaPulse = { value: LAKE_WATER_ALPHA_PULSE }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n varying vec3 vLakeLocalPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vLakeLocalPosition = position;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vLakeLocalPosition;
uniform vec3 lakeCenter;
uniform vec3 lakeTangent;
uniform vec3 lakeBitangent;
uniform float lakeRadius;
uniform float lakeEdgeFalloff;
uniform float lakeEdgeExpand;
uniform float lakeEdgeSharpness;
uniform float lakeNoiseAmplitude;
uniform float lakeNoiseFrequency;
uniform float lakeNoiseFrequencyB;
uniform float lakeNoiseFrequencyC;
uniform float lakeNoisePhase;
uniform float lakeNoisePhaseB;
uniform float lakeNoisePhaseC;
uniform float lakeWarpAmplitude;
uniform float lakeTime;
uniform float lakeWaveScale;
uniform float lakeWaveSpeed;
uniform float lakeWaveStrength;
uniform float lakeFresnelStrength;
uniform float lakeAlphaPulse;

float lakeWavePattern(vec3 normal, float time) {
  float dotValue = dot(lakeCenter, normal);
  vec3 temp = normal - lakeCenter * dotValue;
  float x = dot(temp, lakeTangent);
  float y = dot(temp, lakeBitangent);
  float phaseA = (x + y * 0.35) * lakeWaveScale + time * lakeWaveSpeed;
  float phaseB = (y - x * 0.28) * (lakeWaveScale * 1.35) - time * lakeWaveSpeed * 1.27;
  float wave = sin(phaseA) * 0.6 + sin(phaseB) * 0.4;
  return wave * 0.5 + 0.5;
}

float lakeEdgeBlend(vec3 normal) {
  float dotValue = clamp(dot(lakeCenter, normal), -1.0, 1.0);
  float angle = acos(dotValue);
  if (angle >= lakeRadius + lakeEdgeFalloff + lakeEdgeExpand) return 0.0;
  vec3 temp = normal - lakeCenter * dotValue;
  float x = dot(temp, lakeTangent);
  float y = dot(temp, lakeBitangent);
  float warp = sin((x + y) * lakeNoiseFrequencyC + lakeNoisePhaseC) * lakeWarpAmplitude;
  float u = x * lakeNoiseFrequency + lakeNoisePhase + warp;
  float v = y * lakeNoiseFrequencyB + lakeNoisePhaseB - warp;
  float w = (x - y) * lakeNoiseFrequencyC + lakeNoisePhaseC * 0.7;
  float noise = sin(u) + sin(v) + 0.6 * sin(2.0 * u + v * 0.6)
    + 0.45 * sin(2.3 * v - 0.7 * u) + 0.35 * sin(w);
  float noiseNormalized = noise / 3.15;
  float edgeRadius = clamp(
    lakeRadius * (1.0 + lakeNoiseAmplitude * noiseNormalized),
    lakeRadius * 0.65,
    lakeRadius * 1.35
  ) + lakeEdgeExpand;
  if (angle >= edgeRadius) return 0.0;
  float shelfRadius = max(1e-3, edgeRadius - lakeEdgeFalloff);
  float edgeT = clamp((edgeRadius - angle) / lakeEdgeFalloff, 0.0, 1.0);
  return pow(edgeT, lakeEdgeSharpness);
}
`,
      )
      .replace(
        '#include <dithering_fragment>',
        `
float lakeEdge = lakeEdgeBlend(normalize(vLakeLocalPosition));
if (lakeEdge <= 0.0) discard;
float lakeAa = fwidth(lakeEdge) * 1.5;
float lakeMask = smoothstep(0.0, lakeAa, lakeEdge);
float lakeWave = lakeWavePattern(normalize(vLakeLocalPosition), lakeTime);
float lakeFresnel = pow(1.0 - clamp(dot(normalize(geometryNormal), normalize(geometryViewDir)), 0.0, 1.0), 2.2);
float waveMix = lakeWave * lakeWaveStrength;
diffuseColor.rgb += vec3(0.03, 0.08, 0.12) * (waveMix + lakeFresnel * lakeFresnelStrength);
totalEmissiveRadiance += vec3(0.02, 0.05, 0.08) * (waveMix * 0.9 + lakeFresnel * lakeFresnelStrength);
float alphaPulse = 1.0 + (lakeWave - 0.5) * lakeAlphaPulse;
diffuseColor.a *= lakeMask * alphaPulse;
#include <dithering_fragment>`,
      )
    ;(material.userData as LakeMaterialUserData).lakeWaterUniforms = {
      time: timeUniform,
    }
  }
  return material
}

const createLakeMaterial = () => {
  const material = new THREE.MeshStandardMaterial({
    color: '#2aa9ff',
    roughness: 0.2,
    metalness: 0.04,
    emissive: '#0b426f',
    emissiveIntensity: LAKE_WATER_EMISSIVE_BASE,
    transparent: true,
    opacity: LAKE_WATER_OPACITY,
  })
  material.depthWrite = true
  material.depthTest = true
  material.polygonOffset = true
  material.polygonOffsetFactor = -1
  material.polygonOffsetUnits = -1
  return material
}

const createShorelineFillGeometry = (planetGeometry: THREE.BufferGeometry, lakes: Lake[]) => {
  const positions = planetGeometry.attributes.position
  const shoreline: number[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const bc = new THREE.Vector3()
  const ca = new THREE.Vector3()
  const centroid = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const temp = new THREE.Vector3()
  const isInsideLake = (point: THREE.Vector3) => {
    if (point.lengthSq() < 1e-8) return false
    normal.copy(point).normalize()
    const sample = sampleLakes(normal, lakes, temp)
    if (!sample.lake) return false
    return sample.boundary > LAKE_WATER_MASK_THRESHOLD
  }
  for (let i = 0; i < positions.count; i += 3) {
    a.set(positions.getX(i), positions.getY(i), positions.getZ(i))
    b.set(positions.getX(i + 1), positions.getY(i + 1), positions.getZ(i + 1))
    c.set(positions.getX(i + 2), positions.getY(i + 2), positions.getZ(i + 2))
    let hasInside = false
    let hasOutside = false
    const mark = (point: THREE.Vector3) => {
      if (isInsideLake(point)) {
        hasInside = true
      } else {
        hasOutside = true
      }
    }
    mark(a)
    mark(b)
    mark(c)
    if (!(hasInside && hasOutside)) {
      ab.copy(a).lerp(b, 0.5)
      mark(ab)
    }
    if (!(hasInside && hasOutside)) {
      bc.copy(b).lerp(c, 0.5)
      mark(bc)
    }
    if (!(hasInside && hasOutside)) {
      ca.copy(c).lerp(a, 0.5)
      mark(ca)
    }
    if (!(hasInside && hasOutside)) {
      centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3)
      mark(centroid)
    }
    if (!(hasInside && hasOutside)) continue
    shoreline.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
  }
  const geometry = new THREE.BufferGeometry()
  if (shoreline.length > 0) {
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(shoreline, 3))
    geometry.computeVertexNormals()
    geometry.computeBoundingSphere()
  }
  return geometry
}
const createFilteredGridGeometry = (gridGeometry: THREE.BufferGeometry, lakes: Lake[]) => {
  const positions = gridGeometry.attributes.position
  const filtered: number[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const samplePoint = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const temp = new THREE.Vector3()
  const shouldHide = (point: THREE.Vector3) => {
    if (point.lengthSq() < 1e-8) return false
    normal.copy(point).normalize()
    const sample = sampleLakes(normal, lakes, temp)
    if (!sample.lake) return false
    return true
  }
  for (let i = 0; i < positions.count; i += 2) {
    a.set(positions.getX(i), positions.getY(i), positions.getZ(i))
    b.set(positions.getX(i + 1), positions.getY(i + 1), positions.getZ(i + 1))
    let hide = shouldHide(a) || shouldHide(b)
    if (!hide) {
      samplePoint.copy(a).lerp(b, 0.25)
      hide = shouldHide(samplePoint)
    }
    if (!hide) {
      samplePoint.copy(a).lerp(b, 0.5)
      hide = shouldHide(samplePoint)
    }
    if (!hide) {
      samplePoint.copy(a).lerp(b, 0.75)
      hide = shouldHide(samplePoint)
    }
    if (hide) continue
    filtered.push(a.x, a.y, a.z, b.x, b.y, b.z)
  }
  const geometry = new THREE.BufferGeometry()
  if (filtered.length > 0) {
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(filtered, 3))
    geometry.computeBoundingSphere()
  }
  return geometry
}
const createShorelineGeometry = (gridGeometry: THREE.BufferGeometry, lakes: Lake[]) => {
  const positions = gridGeometry.attributes.position
  const shoreline: number[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const samplePoint = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const temp = new THREE.Vector3()
  const isInsideLake = (point: THREE.Vector3) => {
    if (point.lengthSq() < 1e-8) return false
    normal.copy(point).normalize()
    const sample = sampleLakes(normal, lakes, temp)
    if (!sample.lake) return false
    return sample.boundary > LAKE_GRID_MASK_THRESHOLD
  }
  for (let i = 0; i < positions.count; i += 2) {
    a.set(positions.getX(i), positions.getY(i), positions.getZ(i))
    b.set(positions.getX(i + 1), positions.getY(i + 1), positions.getZ(i + 1))
    const insideA = isInsideLake(a)
    const insideB = isInsideLake(b)
    let crosses = insideA !== insideB
    if (!crosses) {
      samplePoint.copy(a).lerp(b, 0.25)
      const insideQuarter = isInsideLake(samplePoint)
      samplePoint.copy(a).lerp(b, 0.5)
      const insideMid = isInsideLake(samplePoint)
      samplePoint.copy(a).lerp(b, 0.75)
      const insideThreeQuarter = isInsideLake(samplePoint)
      crosses =
        insideQuarter !== insideA ||
        insideMid !== insideA ||
        insideThreeQuarter !== insideA
    }
    if (!crosses) continue
    shoreline.push(a.x, a.y, a.z, b.x, b.y, b.z)
  }
  const geometry = new THREE.BufferGeometry()
  if (shoreline.length > 0) {
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(shoreline, 3))
    geometry.computeBoundingSphere()
  }
  return geometry
}
const randomOnSphere = (rand: () => number, target = new THREE.Vector3()) => {
  const theta = rand() * Math.PI * 2
  const z = rand() * 2 - 1
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  target.set(r * Math.cos(theta), z, r * Math.sin(theta))
  return target
}
const advanceOnSphere = (
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  distance: number,
  radius: number,
) => {
  if (distance <= 0) return origin.clone()
  const normal = origin.clone().normalize()
  const dir = direction.clone().addScaledVector(normal, -direction.dot(normal))
  if (dir.lengthSq() < 1e-8) return origin.clone()
  dir.normalize()
  const axis = normal.clone().cross(dir)
  const angle = distance / radius
  if (axis.lengthSq() < 1e-8 || !Number.isFinite(angle)) {
    return origin.clone().addScaledVector(dir, distance).normalize().multiplyScalar(radius)
  }
  axis.normalize()
  return origin.clone().applyAxisAngle(axis, angle).normalize().multiplyScalar(radius)
}
const isTailDebugEnabled = () => {
  if (DEBUG_TAIL) return true
  if (typeof window === 'undefined') return false
  try {
    if ((window as { __TAIL_DEBUG__?: boolean }).__TAIL_DEBUG__ === true) return true
    return window.localStorage.getItem('spherical_snake_tail_debug') === '1'
  } catch {
    return false
  }
}
const isLakeDebugEnabled = () => {
  if (typeof window === 'undefined') return false
  try {
    if ((window as { __LAKE_DEBUG__?: boolean }).__LAKE_DEBUG__ === true) return true
    return window.localStorage.getItem('spherical_snake_lake_debug') === '1'
  } catch {
    return false
  }
}
const dumpLakeGeometry = (geometry: THREE.BufferGeometry) => {
  if (typeof window === 'undefined') return
  const positionAttr = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  const normalAttr = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined
  if (!positionAttr || !normalAttr) return
  const positions = Array.from(positionAttr.array as Iterable<number>)
  const normals = Array.from(normalAttr.array as Iterable<number>)
  const payload = {
    vertexCount: positionAttr.count,
    positions,
    normals,
  }
  ;(window as { __LAKE_GEOMETRY__?: typeof payload }).__LAKE_GEOMETRY__ = payload
  console.info('[LakeGeometry]', payload)
}

const slerpProjectedPoint = (from: THREE.Vector3, to: THREE.Vector3, alpha: number) => {
  const fromRadius = from.length()
  const toRadius = to.length()
  const blendedRadius = fromRadius + (toRadius - fromRadius) * alpha
  return slerpOnSphere(from, to, alpha, blendedRadius)
}

const formatRendererError = (error: unknown) => {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  return 'WebGPU initialization failed'
}

const hasWebGpuSupport = async () => {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & {
    gpu?: {
      requestAdapter?: () => Promise<unknown>
    }
  }
  if (!nav.gpu || typeof nav.gpu.requestAdapter !== 'function') {
    return false
  }
  try {
    const adapter = await nav.gpu.requestAdapter()
    return !!adapter
  } catch {
    return false
  }
}

const createRenderer = async (
  canvas: HTMLCanvasElement,
  backend: RendererBackend,
): Promise<THREE.WebGLRenderer | WebGPURenderer> => {
  if (backend === 'webgpu') {
    const renderer = new WebGPURenderer({
      canvas,
      antialias: true,
      alpha: true,
    })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    renderer.setClearColor(0x000000, 0)
    await renderer.init()
    return renderer
  }

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.setClearColor(0x000000, 0)
  return renderer
}

const createScene = async (
  canvas: HTMLCanvasElement,
  requestedBackend: RendererPreference,
  activeBackend: RendererBackend,
  fallbackReason: string | null,
): Promise<RenderScene> => {
  const renderer = await createRenderer(canvas, activeBackend)
  const webglShaderHooksEnabled = activeBackend === 'webgl'

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

  let lakes: Lake[] = []
  let trees: TreeInstance[] = []
  let mountains: MountainInstance[] = []
  let planetMesh: THREE.Mesh | null = null
  let planetPatches: TerrainPatchInstance[] = []
  let planetPatchMaterial: THREE.MeshStandardMaterial | null = null
  let visiblePlanetPatchCount = 0
  let gridMesh: THREE.LineSegments | null = null
  let shorelineLineMesh: THREE.LineSegments | null = null
  let shorelineFillMesh: THREE.Mesh | null = null
  let lakeSurfaceGeometry: THREE.BufferGeometry | null = null
  let lakeMeshes: THREE.Mesh[] = []
  let lakeMaterials: THREE.MeshStandardMaterial[] = []
  let mountainDebugGroup: THREE.Group | null = null
  let mountainDebugMaterial: THREE.LineBasicMaterial | null = null
  let mountainDebugEnabled = false
  let lakeDebugGroup: THREE.Group | null = null
  let lakeDebugMaterial: THREE.LineBasicMaterial | null = null
  let lakeDebugEnabled = false
  let treeDebugGroup: THREE.Group | null = null
  let treeDebugMaterial: THREE.LineBasicMaterial | null = null
  let treeDebugEnabled = false
  let terrainTessellationDebugEnabled = false

  const environmentGroup = new THREE.Group()
  world.add(environmentGroup)

  const snakesGroup = new THREE.Group()
  const pelletsGroup = new THREE.Group()
  world.add(snakesGroup)
  world.add(pelletsGroup)

  const headGeometry = new THREE.SphereGeometry(HEAD_RADIUS, 18, 18)
  const bowlGeometry = new THREE.SphereGeometry(HEAD_RADIUS * 1.55, 20, 20)
  const tailGeometry = new THREE.SphereGeometry(1, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2)
  const eyeGeometry = new THREE.SphereGeometry(EYE_RADIUS, 12, 12)
  const pupilGeometry = new THREE.SphereGeometry(PUPIL_RADIUS, 10, 10)
  const eyeMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.2 })
  const pupilMaterial = new THREE.MeshStandardMaterial({ color: '#1b1b1b', roughness: 0.4 })
  const tongueBaseGeometry = new THREE.CylinderGeometry(
    TONGUE_RADIUS,
    TONGUE_RADIUS * 0.9,
    1,
    10,
    1,
    true,
  )
  tongueBaseGeometry.translate(0, 0.5, 0)
  const tongueForkGeometry = new THREE.CylinderGeometry(
    TONGUE_RADIUS * 0.7,
    TONGUE_RADIUS * 0.25,
    1,
    8,
    1,
    true,
  )
  tongueForkGeometry.translate(0, 0.5, 0)
  const tongueMaterial = new THREE.MeshStandardMaterial({
    color: '#ff6f9f',
    roughness: 0.25,
    metalness: 0.05,
    emissive: '#ff4f8a',
    emissiveIntensity: 0.3,
  })

  const PELLET_BUCKET_COUNT = PELLET_COLORS.length
  const PELLET_POINT_SIZE = PELLET_RADIUS * 7.1
  const pelletSpriteTexture = createPelletSpriteTexture()
  let treeTierGeometries: THREE.BufferGeometry[] = []
  let treeTierMeshes: THREE.InstancedMesh[] = []
  let treeTrunkGeometry: THREE.BufferGeometry | null = null
  let treeTrunkMesh: THREE.InstancedMesh | null = null
  let treeLeafMaterial: THREE.MeshStandardMaterial | null = null
  let treeTrunkMaterial: THREE.MeshStandardMaterial | null = null
  let cactusPartGeometries: THREE.BufferGeometry[] = []
  let cactusPartMeshes: THREE.InstancedMesh[] = []
  let cactusTrunkGeometry: THREE.BufferGeometry | null = null
  let cactusTrunkMesh: THREE.InstancedMesh | null = null
  let cactusMaterial: THREE.MeshStandardMaterial | null = null
  let cactusArmMaterial: THREE.MeshStandardMaterial | null = null
  let mountainGeometries: THREE.BufferGeometry[] = []
  let mountainMeshes: THREE.InstancedMesh[] = []
  let mountainMaterial: THREE.MeshStandardMaterial | null = null
  let pebbleGeometry: THREE.BufferGeometry | null = null
  let pebbleMaterial: THREE.MeshStandardMaterial | null = null
  let pebbleMesh: THREE.InstancedMesh | null = null
  let treeTrunkSourceMatrices: THREE.Matrix4[] = []
  let treeTierSourceMatrices: THREE.Matrix4[][] = []
  let treeCullEntries: TreeCullEntry[] = []
  let treeVisibilityState: boolean[] = []
  let treeVisibleIndices: number[] = []
  let cactusTrunkSourceMatrices: THREE.Matrix4[] = []
  let cactusPartSourceMatrices: THREE.Matrix4[][] = []
  let cactusCullEntries: CactusCullEntry[] = []
  let cactusVisibilityState: boolean[] = []
  let cactusVisibleIndices: number[] = []
  let visibleTreeCount = 0
  let visibleCactusCount = 0
  let mountainSourceMatricesByVariant: THREE.Matrix4[][] = []
  let mountainCullEntriesByVariant: MountainCullEntry[][] = []
  let mountainVisibilityStateByVariant: boolean[][] = []
  let mountainVisibleIndicesByVariant: number[][] = []
  let visibleMountainCount = 0
  let pebbleSourceMatrices: THREE.Matrix4[] = []
  let pebbleCullEntries: PebbleCullEntry[] = []
  let pebbleVisibilityState: boolean[] = []
  let pebbleVisibleIndices: number[] = []
  let visiblePebbleCount = 0
  let visibleLakeCount = 0
  let terrainContactSampler: TerrainContactSampler | null = null
  let localGroundingInfo: SnakeGroundingInfo | null = null
  const pelletBuckets: Array<PelletSpriteBucket | null> = new Array(PELLET_BUCKET_COUNT).fill(null)
  const pelletBucketCounts = new Array<number>(PELLET_BUCKET_COUNT).fill(0)
  const pelletBucketOffsets = new Array<number>(PELLET_BUCKET_COUNT).fill(0)
  const pelletGroundCache = new Map<number, { x: number; y: number; z: number; radius: number }>()
  const pelletIdsSeen = new Set<number>()
  let viewportWidth = 1
  let viewportHeight = 1
  let lastFrameTime = performance.now()

  const snakes = new Map<string, SnakeVisual>()
  const deathStates = new Map<string, DeathState>()
  const lastAliveStates = new Map<string, boolean>()
  const lastHeadPositions = new Map<string, THREE.Vector3>()
  const lastForwardDirections = new Map<string, THREE.Vector3>()
  const lastTailDirections = new Map<string, THREE.Vector3>()
  const lastSnakeLengths = new Map<string, number>()
  const lastSnakeStarts = new Map<string, number>()
  const tailAddStates = new Map<string, TailAddState>()
  const tailExtraStates = new Map<string, TailExtraState>()
  const lastTailBasePositions = new Map<string, THREE.Vector3>()
  const lastTailExtensionDistances = new Map<string, number>()
  const lastTailTotalLengths = new Map<string, number>()
  const tailGrowthStates = new Map<string, number>()
  const tailDebugStates = new Map<string, TailDebugState>()
  const tongueStates = new Map<string, TongueState>()
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
  const tempQuat = new THREE.Quaternion()
  const cameraLocalPosTemp = new THREE.Vector3()
  const cameraLocalDirTemp = new THREE.Vector3()
  const directionTemp = new THREE.Vector3()
  const rayDirTemp = new THREE.Vector3()
  const occlusionPointTemp = new THREE.Vector3()
  const snakeContactCenterTemp = new THREE.Vector3()
  const snakeContactTangentTemp = new THREE.Vector3()
  const snakeContactBitangentTemp = new THREE.Vector3()
  const snakeContactOffsetTemp = new THREE.Vector3()
  const snakeContactPointTemp = new THREE.Vector3()
  const snakeContactNormalTemp = new THREE.Vector3()
  const snakeContactFallbackTemp = new THREE.Vector3()
  const tongueUp = new THREE.Vector3(0, 1, 0)
  const debugEnabled = import.meta.env.DEV || import.meta.env.VITE_E2E_DEBUG === '1'
  let debugApi:
    | {
        getSnakeOpacity: (id: string) => number | null
        getSnakeHeadPosition: (id: string) => { x: number; y: number; z: number } | null
        isSnakeVisible: (id: string) => boolean | null
        getRendererInfo: () => {
          requestedBackend: RendererPreference
          activeBackend: RendererBackend
          fallbackReason: string | null
          webglShaderHooksEnabled: boolean
        }
        getTerrainPatchInfo: () => {
          totalPatches: number
          visiblePatches: number
          patchBands: number
          patchSlices: number
          dynamicRebuilds: boolean
          wireframeEnabled: boolean
        }
        getEnvironmentCullInfo: () => {
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
        getSnakeGroundingInfo: () => SnakeGroundingInfo | null
      }
    | null = null

  const attachDebugApi = () => {
    if (!debugEnabled || typeof window === 'undefined') return
    const debugWindow = window as Window & {
      __SNAKE_DEBUG__?: {
        getSnakeOpacity: (id: string) => number | null
        getSnakeHeadPosition: (id: string) => { x: number; y: number; z: number } | null
        isSnakeVisible: (id: string) => boolean | null
        getRendererInfo: () => {
          requestedBackend: RendererPreference
          activeBackend: RendererBackend
          fallbackReason: string | null
          webglShaderHooksEnabled: boolean
        }
        getTerrainPatchInfo: () => {
          totalPatches: number
          visiblePatches: number
          patchBands: number
          patchSlices: number
          dynamicRebuilds: boolean
          wireframeEnabled: boolean
        }
        getEnvironmentCullInfo: () => {
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
        getSnakeGroundingInfo: () => SnakeGroundingInfo | null
      }
    }
    debugApi = {
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
      isSnakeVisible: (id: string) => {
        const visual = snakes.get(id)
        return visual ? visual.group.visible : null
      },
      getRendererInfo: () => ({
        requestedBackend,
        activeBackend,
        fallbackReason,
        webglShaderHooksEnabled,
      }),
      getTerrainPatchInfo: () => ({
        totalPatches: planetPatches.length,
        visiblePatches: visiblePlanetPatchCount,
        patchBands: PLANET_PATCH_BANDS,
        patchSlices: PLANET_PATCH_SLICES,
        dynamicRebuilds: false,
        wireframeEnabled: terrainTessellationDebugEnabled,
      }),
      getEnvironmentCullInfo: () => ({
        totalTrees: treeCullEntries.length,
        visibleTrees: visibleTreeCount,
        totalCactuses: cactusTrunkSourceMatrices.length,
        visibleCactuses: visibleCactusCount,
        totalMountains: mountains.length,
        visibleMountains: visibleMountainCount,
        totalPebbles: pebbleCullEntries.length,
        visiblePebbles: visiblePebbleCount,
        totalLakes: lakes.length,
        visibleLakes: visibleLakeCount,
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
    }
    debugWindow.__SNAKE_DEBUG__ = debugApi
  }

  attachDebugApi()

  const resetSnakeTransientState = (id: string) => {
    lastHeadPositions.delete(id)
    lastForwardDirections.delete(id)
    lastTailDirections.delete(id)
    lastSnakeLengths.delete(id)
    tailAddStates.delete(id)
    tailExtraStates.delete(id)
    lastTailBasePositions.delete(id)
    lastTailExtensionDistances.delete(id)
    lastTailTotalLengths.delete(id)
    tailGrowthStates.delete(id)
    tailDebugStates.delete(id)
    tongueStates.delete(id)
  }

  const disposeMaterial = (material: THREE.Material | THREE.Material[] | null) => {
    if (!material) return
    if (Array.isArray(material)) {
      for (const mat of material) {
        mat.dispose()
      }
    } else {
      material.dispose()
    }
  }

  const disposeEnvironment = () => {
    visiblePlanetPatchCount = 0
    terrainContactSampler = null
    pelletGroundCache.clear()
    if (planetMesh) {
      world.remove(planetMesh)
      planetMesh.geometry.dispose()
      disposeMaterial(planetMesh.material)
      planetMesh = null
    }
    for (const patch of planetPatches) {
      world.remove(patch.mesh)
      patch.mesh.geometry.dispose()
    }
    planetPatches = []
    if (planetPatchMaterial) {
      planetPatchMaterial.dispose()
      planetPatchMaterial = null
    }
    if (gridMesh) {
      world.remove(gridMesh)
      gridMesh.geometry.dispose()
      disposeMaterial(gridMesh.material)
      gridMesh = null
    }
    if (shorelineLineMesh) {
      world.remove(shorelineLineMesh)
      shorelineLineMesh.geometry.dispose()
      disposeMaterial(shorelineLineMesh.material)
      shorelineLineMesh = null
    }
    if (shorelineFillMesh) {
      world.remove(shorelineFillMesh)
      shorelineFillMesh.geometry.dispose()
      disposeMaterial(shorelineFillMesh.material)
      shorelineFillMesh = null
    }
    for (const mesh of lakeMeshes) {
      world.remove(mesh)
    }
    for (const material of lakeMaterials) {
      material.dispose()
    }
    lakeMeshes = []
    lakeMaterials = []
    if (lakeSurfaceGeometry) {
      lakeSurfaceGeometry.dispose()
      lakeSurfaceGeometry = null
    }
    if (mountainDebugGroup) {
      world.remove(mountainDebugGroup)
      mountainDebugGroup.traverse((child) => {
        if (child instanceof THREE.LineLoop) {
          child.geometry.dispose()
        }
      })
      mountainDebugGroup = null
    }
    if (mountainDebugMaterial) {
      mountainDebugMaterial.dispose()
      mountainDebugMaterial = null
    }
    if (lakeDebugGroup) {
      world.remove(lakeDebugGroup)
      lakeDebugGroup.traverse((child) => {
        if (child instanceof THREE.LineLoop) {
          child.geometry.dispose()
        }
      })
      lakeDebugGroup = null
    }
    if (lakeDebugMaterial) {
      lakeDebugMaterial.dispose()
      lakeDebugMaterial = null
    }
    if (treeDebugGroup) {
      world.remove(treeDebugGroup)
      treeDebugGroup.traverse((child) => {
        if (child instanceof THREE.LineLoop) {
          child.geometry.dispose()
        }
      })
      treeDebugGroup = null
    }
    if (treeDebugMaterial) {
      treeDebugMaterial.dispose()
      treeDebugMaterial = null
    }

    for (const mesh of treeTierMeshes) {
      environmentGroup.remove(mesh)
    }
    if (treeTrunkMesh) {
      environmentGroup.remove(treeTrunkMesh)
    }
    for (const mesh of cactusPartMeshes) {
      environmentGroup.remove(mesh)
    }
    if (cactusTrunkMesh) {
      environmentGroup.remove(cactusTrunkMesh)
    }
    for (const mesh of mountainMeshes) {
      environmentGroup.remove(mesh)
    }
    if (pebbleMesh) {
      environmentGroup.remove(pebbleMesh)
    }

    for (const geometry of treeTierGeometries) {
      geometry.dispose()
    }
    treeTierGeometries = []
    treeTierMeshes = []
    if (treeTrunkGeometry) {
      treeTrunkGeometry.dispose()
      treeTrunkGeometry = null
    }
    if (treeLeafMaterial) {
      treeLeafMaterial.dispose()
      treeLeafMaterial = null
    }
    if (treeTrunkMaterial) {
      treeTrunkMaterial.dispose()
      treeTrunkMaterial = null
    }
    for (const geometry of cactusPartGeometries) {
      geometry.dispose()
    }
    cactusPartGeometries = []
    cactusPartMeshes = []
    if (cactusTrunkGeometry) {
      cactusTrunkGeometry.dispose()
      cactusTrunkGeometry = null
    }
    if (cactusMaterial) {
      cactusMaterial.dispose()
      cactusMaterial = null
    }
    if (cactusArmMaterial) {
      cactusArmMaterial.dispose()
      cactusArmMaterial = null
    }

    for (const geometry of mountainGeometries) {
      geometry.dispose()
    }
    mountainGeometries = []
    mountainMeshes = []
    if (mountainMaterial) {
      mountainMaterial.dispose()
      mountainMaterial = null
    }

    if (pebbleGeometry) {
      pebbleGeometry.dispose()
      pebbleGeometry = null
    }
    if (pebbleMaterial) {
      pebbleMaterial.dispose()
      pebbleMaterial = null
    }
    pebbleMesh = null
    treeTrunkSourceMatrices = []
    treeTierSourceMatrices = []
    cactusTrunkSourceMatrices = []
    cactusPartSourceMatrices = []
    treeCullEntries = []
    treeVisibilityState = []
    treeVisibleIndices = []
    cactusCullEntries = []
    cactusVisibilityState = []
    cactusVisibleIndices = []
    visibleTreeCount = 0
    visibleCactusCount = 0
    mountainSourceMatricesByVariant = []
    mountainCullEntriesByVariant = []
    mountainVisibilityStateByVariant = []
    mountainVisibleIndicesByVariant = []
    visibleMountainCount = 0
    pebbleSourceMatrices = []
    pebbleCullEntries = []
    pebbleVisibilityState = []
    pebbleVisibleIndices = []
    visiblePebbleCount = 0
    visibleLakeCount = 0

    lakes = []
    trees = []
    mountains = []
  }

  const rebuildMountainDebug = () => {
    if (mountainDebugGroup) {
      world.remove(mountainDebugGroup)
      mountainDebugGroup.traverse((child) => {
        if (child instanceof THREE.LineLoop) {
          child.geometry.dispose()
        }
      })
      mountainDebugGroup = null
    }
    if (mountainDebugMaterial) {
      mountainDebugMaterial.dispose()
      mountainDebugMaterial = null
    }
    if (mountains.length === 0) return

    const material = new THREE.LineBasicMaterial({
      color: '#f97316',
      transparent: true,
      opacity: 0.75,
    })
    material.depthWrite = false
    material.depthTest = false
    mountainDebugMaterial = material
    const group = new THREE.Group()
    const offset = 0.01

    for (const mountain of mountains) {
      const outline = mountain.outline
      if (outline.length < 3) continue
      const positions: number[] = []
      for (let i = 0; i < outline.length; i += 1) {
        const theta = (i / outline.length) * Math.PI * 2
        const dir = tempVector
          .copy(mountain.tangent)
          .multiplyScalar(Math.cos(theta))
          .addScaledVector(mountain.bitangent, Math.sin(theta))
          .normalize()
        const angle = outline[i]
        const point = tempVectorB
          .copy(mountain.normal)
          .multiplyScalar(Math.cos(angle))
          .addScaledVector(dir, Math.sin(angle))
          .normalize()
          .multiplyScalar(PLANET_RADIUS + offset)
        positions.push(point.x, point.y, point.z)
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geometry.computeBoundingSphere()
      const line = new THREE.LineLoop(geometry, material)
      line.renderOrder = 4
      group.add(line)
    }

    group.visible = mountainDebugEnabled
    world.add(group)
    mountainDebugGroup = group
  }

  const computeLakeEdgeRadius = (lake: Lake, theta: number) => {
    let angle = lake.radius
    for (let i = 0; i < 2; i += 1) {
      const sinAngle = Math.sin(angle)
      const x = Math.cos(theta) * sinAngle
      const y = Math.sin(theta) * sinAngle
      const warp =
        Math.sin((x + y) * lake.noiseFrequencyC + lake.noisePhaseC) * lake.warpAmplitude
      const u = x * lake.noiseFrequency + lake.noisePhase + warp
      const v = y * lake.noiseFrequencyB + lake.noisePhaseB - warp
      const w = (x - y) * lake.noiseFrequencyC + lake.noisePhaseC * 0.7
      const noise =
        Math.sin(u) +
        Math.sin(v) +
        0.6 * Math.sin(2 * u + v * 0.6) +
        0.45 * Math.sin(2.3 * v - 0.7 * u) +
        0.35 * Math.sin(w)
      const noiseNormalized = noise / 3.15
      angle = clamp(
        lake.radius * (1 + lake.noiseAmplitude * noiseNormalized),
        lake.radius * 0.65,
        lake.radius * 1.35,
      )
    }
    return angle
  }

  const rebuildLakeDebug = () => {
    if (lakeDebugGroup) {
      world.remove(lakeDebugGroup)
      lakeDebugGroup.traverse((child) => {
        if (child instanceof THREE.LineLoop) {
          child.geometry.dispose()
        }
      })
      lakeDebugGroup = null
    }
    if (lakeDebugMaterial) {
      lakeDebugMaterial.dispose()
      lakeDebugMaterial = null
    }
    if (lakes.length === 0) return

    const material = new THREE.LineBasicMaterial({
      color: '#38bdf8',
      transparent: true,
      opacity: 0.75,
    })
    material.depthWrite = false
    material.depthTest = false
    lakeDebugMaterial = material

    const group = new THREE.Group()
    const dir = new THREE.Vector3()
    const point = new THREE.Vector3()
    for (const lake of lakes) {
      const positions: number[] = []
      for (let i = 0; i < LAKE_DEBUG_SEGMENTS; i += 1) {
        const theta = (i / LAKE_DEBUG_SEGMENTS) * Math.PI * 2
        const angle = computeLakeEdgeRadius(lake, theta)
        dir
          .copy(lake.tangent)
          .multiplyScalar(Math.cos(theta))
          .addScaledVector(lake.bitangent, Math.sin(theta))
          .normalize()
        point
          .copy(lake.center)
          .multiplyScalar(Math.cos(angle))
          .addScaledVector(dir, Math.sin(angle))
          .normalize()
          .multiplyScalar(PLANET_RADIUS + LAKE_DEBUG_OFFSET)
        positions.push(point.x, point.y, point.z)
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geometry.computeBoundingSphere()
      const line = new THREE.LineLoop(geometry, material)
      line.renderOrder = 4
      group.add(line)
    }

    group.visible = lakeDebugEnabled
    world.add(group)
    lakeDebugGroup = group
  }

  const rebuildTreeDebug = () => {
    if (treeDebugGroup) {
      world.remove(treeDebugGroup)
      treeDebugGroup.traverse((child) => {
        if (child instanceof THREE.LineLoop) {
          child.geometry.dispose()
        }
      })
      treeDebugGroup = null
    }
    if (treeDebugMaterial) {
      treeDebugMaterial.dispose()
      treeDebugMaterial = null
    }
    if (trees.length === 0) return

    const material = new THREE.LineBasicMaterial({
      color: '#facc15',
      transparent: true,
      opacity: 0.75,
    })
    material.depthWrite = false
    material.depthTest = false
    treeDebugMaterial = material

    const group = new THREE.Group()
    const tangent = new THREE.Vector3()
    const bitangent = new THREE.Vector3()
    const dir = new THREE.Vector3()
    const point = new THREE.Vector3()

    for (const tree of trees) {
      if (tree.widthScale >= 0) continue
      const angle = (TREE_TRUNK_RADIUS * Math.abs(tree.widthScale)) / PLANET_RADIUS
      if (!Number.isFinite(angle) || angle <= 0) continue
      buildTangentBasis(tree.normal, tangent, bitangent)
      const positions: number[] = []
      for (let i = 0; i < TREE_DEBUG_SEGMENTS; i += 1) {
        const theta = (i / TREE_DEBUG_SEGMENTS) * Math.PI * 2
        dir
          .copy(tangent)
          .multiplyScalar(Math.cos(theta))
          .addScaledVector(bitangent, Math.sin(theta))
          .normalize()
        point
          .copy(tree.normal)
          .multiplyScalar(Math.cos(angle))
          .addScaledVector(dir, Math.sin(angle))
          .normalize()
          .multiplyScalar(PLANET_RADIUS + TREE_DEBUG_OFFSET)
        positions.push(point.x, point.y, point.z)
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geometry.computeBoundingSphere()
      const line = new THREE.LineLoop(geometry, material)
      line.renderOrder = 4
      group.add(line)
    }

    group.visible = treeDebugEnabled
    world.add(group)
    treeDebugGroup = group
  }

  const arraysEqual = (a: number[], b: number[]) => {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false
    }
    return true
  }

  const isAngularVisible = (
    directionDot: number,
    viewAngle: number,
    angularRadius: number,
    wasVisible: boolean,
    margin: number,
    hideExtra: number,
  ) => {
    const limit = Math.min(
      Math.PI - 1e-4,
      viewAngle + angularRadius + margin + (wasVisible ? hideExtra : 0),
    )
    return directionDot >= Math.cos(limit)
  }

  const isOccludedByPlanet = (point: THREE.Vector3, cameraLocalPos: THREE.Vector3) => {
    rayDirTemp.copy(point).sub(cameraLocalPos)
    const segmentLength = rayDirTemp.length()
    if (!Number.isFinite(segmentLength) || segmentLength <= 1e-6) return false
    rayDirTemp.multiplyScalar(1 / segmentLength)

    const tca = -cameraLocalPos.dot(rayDirTemp)
    const occluderRadius = PLANET_RADIUS - 1e-4
    const d2 = cameraLocalPos.lengthSq() - tca * tca
    const radiusSq = occluderRadius * occluderRadius
    if (d2 >= radiusSq) return false

    const thc = Math.sqrt(radiusSq - d2)
    const t0 = tca - thc
    const t1 = tca + thc
    const maxT = segmentLength - 1e-4
    return (t0 > 1e-4 && t0 < maxT) || (t1 > 1e-4 && t1 < maxT)
  }

  const isPointVisible = (
    point: THREE.Vector3,
    pointRadius: number,
    cameraLocalPos: THREE.Vector3,
    cameraLocalDir: THREE.Vector3,
    viewAngle: number,
    wasVisible: boolean,
    margin = PLANET_OBJECT_VIEW_MARGIN,
    hideExtra = PLANET_OBJECT_HIDE_EXTRA,
    occlusionLead = 1,
  ) => {
    const radiusFromCenter = point.length()
    if (!Number.isFinite(radiusFromCenter) || radiusFromCenter <= 1e-6) return false
    directionTemp.copy(point).multiplyScalar(1 / radiusFromCenter)
    const directionDot = directionTemp.dot(cameraLocalDir)
    const angularRadius =
      pointRadius > 0 ? Math.asin(clamp(pointRadius / radiusFromCenter, 0, 1)) : 0
    if (
      !isAngularVisible(
        directionDot,
        viewAngle,
        angularRadius,
        wasVisible,
        margin,
        hideExtra,
      )
    ) {
      return false
    }
    if (pointRadius > 1e-6 && occlusionLead > 0) {
      occlusionPointTemp
        .copy(directionTemp)
        .multiplyScalar(pointRadius * occlusionLead)
        .add(point)
      return !isOccludedByPlanet(occlusionPointTemp, cameraLocalPos)
    }
    return !isOccludedByPlanet(point, cameraLocalPos)
  }

  const buildPlanetPatchAtlas = (
    planetGeometry: THREE.BufferGeometry,
    material: THREE.MeshStandardMaterial,
  ) => {
    const positionAttr = planetGeometry.getAttribute('position')
    if (!(positionAttr instanceof THREE.BufferAttribute)) return
    const colorRaw = planetGeometry.getAttribute('color')
    const colorAttr = colorRaw instanceof THREE.BufferAttribute ? colorRaw : null
    const normalRaw = planetGeometry.getAttribute('normal')
    const normalAttr = normalRaw instanceof THREE.BufferAttribute ? normalRaw : null
    const indexAttr = planetGeometry.getIndex()
    const patchCount = PLANET_PATCH_BANDS * PLANET_PATCH_SLICES
    const buckets = Array.from({ length: patchCount }, () => ({
      positions: [] as number[],
      normals: [] as number[],
      colors: [] as number[],
    }))
    const triCount = indexAttr
      ? Math.floor(indexAttr.count / 3)
      : Math.floor(positionAttr.count / 3)
    const vertexA = new THREE.Vector3()
    const vertexB = new THREE.Vector3()
    const vertexC = new THREE.Vector3()
    const centroid = new THREE.Vector3()
    const normal = new THREE.Vector3()

    const readVertex = (index: number, out: THREE.Vector3) => {
      out.set(positionAttr.getX(index), positionAttr.getY(index), positionAttr.getZ(index))
    }
    const readNormal = (index: number, out: THREE.Vector3) => {
      if (normalAttr) {
        out.set(normalAttr.getX(index), normalAttr.getY(index), normalAttr.getZ(index))
      } else {
        out.set(positionAttr.getX(index), positionAttr.getY(index), positionAttr.getZ(index))
      }
      if (out.lengthSq() > 1e-8) {
        out.normalize()
      } else {
        out.set(0, 1, 0)
      }
    }
    const pushColor = (bucket: { colors: number[] }, index: number) => {
      if (!colorAttr) return
      bucket.colors.push(
        colorAttr.getX(index),
        colorAttr.getY(index),
        colorAttr.getZ(index),
      )
    }

    for (let tri = 0; tri < triCount; tri += 1) {
      const i0 = indexAttr ? indexAttr.getX(tri * 3) : tri * 3
      const i1 = indexAttr ? indexAttr.getX(tri * 3 + 1) : tri * 3 + 1
      const i2 = indexAttr ? indexAttr.getX(tri * 3 + 2) : tri * 3 + 2
      readVertex(i0, vertexA)
      readVertex(i1, vertexB)
      readVertex(i2, vertexC)
      centroid.copy(vertexA).add(vertexB).add(vertexC).multiplyScalar(1 / 3)
      if (centroid.lengthSq() <= 1e-10) continue
      centroid.normalize()
      const latitude = Math.asin(clamp(centroid.y, -1, 1))
      const longitude = Math.atan2(centroid.z, centroid.x)
      const band = clamp(
        Math.floor(((latitude + Math.PI * 0.5) / Math.PI) * PLANET_PATCH_BANDS),
        0,
        PLANET_PATCH_BANDS - 1,
      )
      const slice = clamp(
        Math.floor(((longitude + Math.PI) / (Math.PI * 2)) * PLANET_PATCH_SLICES),
        0,
        PLANET_PATCH_SLICES - 1,
      )
      const bucket = buckets[band * PLANET_PATCH_SLICES + slice]
      bucket.positions.push(
        vertexA.x,
        vertexA.y,
        vertexA.z,
        vertexB.x,
        vertexB.y,
        vertexB.z,
        vertexC.x,
        vertexC.y,
        vertexC.z,
      )
      readNormal(i0, normal)
      bucket.normals.push(normal.x, normal.y, normal.z)
      readNormal(i1, normal)
      bucket.normals.push(normal.x, normal.y, normal.z)
      readNormal(i2, normal)
      bucket.normals.push(normal.x, normal.y, normal.z)
      pushColor(bucket, i0)
      pushColor(bucket, i1)
      pushColor(bucket, i2)
    }

    for (const bucket of buckets) {
      if (bucket.positions.length < 9) continue
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3))
      if (bucket.normals.length === bucket.positions.length) {
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.normals, 3))
      } else {
        geometry.computeVertexNormals()
      }
      if (bucket.colors.length === bucket.positions.length) {
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(bucket.colors, 3))
      }
      geometry.computeBoundingSphere()

      const center = new THREE.Vector3()
      for (let i = 0; i < bucket.positions.length; i += 3) {
        directionTemp
          .set(bucket.positions[i], bucket.positions[i + 1], bucket.positions[i + 2])
          .normalize()
        center.add(directionTemp)
      }
      if (center.lengthSq() <= 1e-10) {
        geometry.dispose()
        continue
      }
      center.normalize()
      let angularExtent = 0
      for (let i = 0; i < bucket.positions.length; i += 3) {
        directionTemp
          .set(bucket.positions[i], bucket.positions[i + 1], bucket.positions[i + 2])
          .normalize()
        const angle = Math.acos(clamp(directionTemp.dot(center), -1, 1))
        if (angle > angularExtent) angularExtent = angle
      }

      const mesh = new THREE.Mesh(geometry, material)
      mesh.visible = false
      world.add(mesh)
      planetPatches.push({ mesh, center, angularExtent, visible: false })
    }
    visiblePlanetPatchCount = 0
  }

  const updatePlanetPatchVisibility = (cameraLocalDir: THREE.Vector3, viewAngle: number) => {
    let visibleCount = 0
    for (const patch of planetPatches) {
      const directionDot = patch.center.dot(cameraLocalDir)
      const visible = isAngularVisible(
        directionDot,
        viewAngle,
        patch.angularExtent,
        patch.visible,
        PLANET_PATCH_VIEW_MARGIN,
        PLANET_PATCH_HIDE_EXTRA,
      )
      patch.visible = visible
      patch.mesh.visible = visible
      if (visible) visibleCount += 1
    }
    visiblePlanetPatchCount = visibleCount
  }

  const updateLakeVisibility = (cameraLocalDir: THREE.Vector3, viewAngle: number) => {
    if (lakeMeshes.length === 0 || lakes.length === 0) {
      visibleLakeCount = 0
      return
    }

    if (webglShaderHooksEnabled) {
      let visible = 0
      for (let i = 0; i < lakeMeshes.length; i += 1) {
        const lake = lakes[i]
        const mesh = lakeMeshes[i]
        if (!lake || !mesh) continue
        const effectiveRadius = lake.radius + LAKE_VISIBILITY_EXTRA_RADIUS
        const inView = isAngularVisible(
          lake.center.dot(cameraLocalDir),
          viewAngle,
          effectiveRadius,
          mesh.visible,
          LAKE_VISIBILITY_MARGIN,
          LAKE_VISIBILITY_HIDE_EXTRA,
        )
        const visibleNow = inView
        mesh.visible = visibleNow
        if (visibleNow) visible += 1
      }
      visibleLakeCount = visible
      return
    }

    let anyVisible = false
    let visible = 0
    for (const lake of lakes) {
      const effectiveRadius = lake.radius + LAKE_VISIBILITY_EXTRA_RADIUS
      const visibleNow =
        isAngularVisible(
          lake.center.dot(cameraLocalDir),
          viewAngle,
          effectiveRadius,
          anyVisible,
          LAKE_VISIBILITY_MARGIN,
          LAKE_VISIBILITY_HIDE_EXTRA,
        )
      if (visibleNow) {
        anyVisible = true
        visible += 1
      }
    }
    for (const mesh of lakeMeshes) {
      mesh.visible = anyVisible
    }
    visibleLakeCount = visible
  }

  const updateEnvironmentVisibility = (
    cameraLocalPos: THREE.Vector3,
    cameraLocalDir: THREE.Vector3,
    viewAngle: number,
  ) => {
    const edgePreload = smoothstep(
      PLANET_EDGE_PRELOAD_START_ANGLE,
      PLANET_EDGE_PRELOAD_END_ANGLE,
      viewAngle,
    )
    const treeMargin = PLANET_OBJECT_VIEW_MARGIN + TREE_EDGE_PRELOAD_MARGIN * edgePreload
    const treeHideExtra = PLANET_OBJECT_HIDE_EXTRA + TREE_EDGE_PRELOAD_HIDE_EXTRA * edgePreload
    const treeOcclusionLead = 1 + TREE_EDGE_PRELOAD_OCCLUSION_LEAD * edgePreload
    const cactusMargin = treeMargin
    const cactusHideExtra = treeHideExtra
    const cactusOcclusionLead = treeOcclusionLead
    const rockMargin = PLANET_OBJECT_VIEW_MARGIN + ROCK_EDGE_PRELOAD_MARGIN * edgePreload
    const rockHideExtra = PLANET_OBJECT_HIDE_EXTRA + ROCK_EDGE_PRELOAD_HIDE_EXTRA * edgePreload
    const rockOcclusionLead = 1 + ROCK_EDGE_PRELOAD_OCCLUSION_LEAD * edgePreload
    const pebbleMargin = PLANET_OBJECT_VIEW_MARGIN + PEBBLE_EDGE_PRELOAD_MARGIN * edgePreload
    const pebbleHideExtra = PLANET_OBJECT_HIDE_EXTRA + PEBBLE_EDGE_PRELOAD_HIDE_EXTRA * edgePreload
    const pebbleOcclusionLead = 1 + PEBBLE_EDGE_PRELOAD_OCCLUSION_LEAD * edgePreload

    const nextTreeVisible: number[] = []
    for (let i = 0; i < treeCullEntries.length; i += 1) {
      const entry = treeCullEntries[i]
      const wasVisible = treeVisibilityState[i] ?? false
      const visible =
        isPointVisible(
          entry.basePoint,
          entry.baseRadius,
          cameraLocalPos,
          cameraLocalDir,
          viewAngle,
          wasVisible,
          treeMargin,
          treeHideExtra,
          treeOcclusionLead,
        ) ||
        isPointVisible(
          entry.topPoint,
          entry.topRadius,
          cameraLocalPos,
          cameraLocalDir,
          viewAngle,
          wasVisible,
          treeMargin,
          treeHideExtra,
          treeOcclusionLead,
        )
      treeVisibilityState[i] = visible
      if (visible) nextTreeVisible.push(i)
    }
    if (!arraysEqual(nextTreeVisible, treeVisibleIndices)) {
      treeVisibleIndices = nextTreeVisible
      if (treeTrunkMesh) {
        for (let write = 0; write < treeVisibleIndices.length; write += 1) {
          const source = treeTrunkSourceMatrices[treeVisibleIndices[write]]
          if (!source) continue
          treeTrunkMesh.setMatrixAt(write, source)
        }
        treeTrunkMesh.count = treeVisibleIndices.length
        treeTrunkMesh.instanceMatrix.needsUpdate = true
      }
      for (let tier = 0; tier < treeTierMeshes.length; tier += 1) {
        const mesh = treeTierMeshes[tier]
        const sourceMatrices = treeTierSourceMatrices[tier]
        if (!mesh || !sourceMatrices) continue
        for (let write = 0; write < treeVisibleIndices.length; write += 1) {
          const source = sourceMatrices[treeVisibleIndices[write]]
          if (!source) continue
          mesh.setMatrixAt(write, source)
        }
        mesh.count = treeVisibleIndices.length
        mesh.instanceMatrix.needsUpdate = true
      }
    }
    visibleTreeCount = treeVisibleIndices.length

    const nextCactusVisible: number[] = []
    for (let i = 0; i < cactusCullEntries.length; i += 1) {
      const entry = cactusCullEntries[i]
      const wasVisible = cactusVisibilityState[i] ?? false
      const visible =
        isPointVisible(
          entry.basePoint,
          entry.baseRadius,
          cameraLocalPos,
          cameraLocalDir,
          viewAngle,
          wasVisible,
          cactusMargin,
          cactusHideExtra,
          cactusOcclusionLead,
        ) ||
        isPointVisible(
          entry.topPoint,
          entry.topRadius,
          cameraLocalPos,
          cameraLocalDir,
          viewAngle,
          wasVisible,
          cactusMargin,
          cactusHideExtra,
          cactusOcclusionLead,
        ) ||
        isPointVisible(
          entry.leftArmTipPoint,
          entry.armRadius,
          cameraLocalPos,
          cameraLocalDir,
          viewAngle,
          wasVisible,
          cactusMargin,
          cactusHideExtra,
          cactusOcclusionLead,
        ) ||
        isPointVisible(
          entry.rightArmTipPoint,
          entry.armRadius,
          cameraLocalPos,
          cameraLocalDir,
          viewAngle,
          wasVisible,
          cactusMargin,
          cactusHideExtra,
          cactusOcclusionLead,
        )
      cactusVisibilityState[i] = visible
      if (visible) nextCactusVisible.push(i)
    }
    if (!arraysEqual(nextCactusVisible, cactusVisibleIndices)) {
      cactusVisibleIndices = nextCactusVisible
      if (cactusTrunkMesh) {
        for (let write = 0; write < cactusVisibleIndices.length; write += 1) {
          const source = cactusTrunkSourceMatrices[cactusVisibleIndices[write]]
          if (!source) continue
          cactusTrunkMesh.setMatrixAt(write, source)
        }
        cactusTrunkMesh.count = cactusVisibleIndices.length
        cactusTrunkMesh.instanceMatrix.needsUpdate = true
      }
      for (let p = 0; p < cactusPartMeshes.length; p += 1) {
        const mesh = cactusPartMeshes[p]
        const sourceMatrices = cactusPartSourceMatrices[p]
        if (!mesh || !sourceMatrices) continue
        for (let write = 0; write < cactusVisibleIndices.length; write += 1) {
          const source = sourceMatrices[cactusVisibleIndices[write]]
          if (!source) continue
          mesh.setMatrixAt(write, source)
        }
        mesh.count = cactusVisibleIndices.length
        mesh.instanceMatrix.needsUpdate = true
      }
    }
    visibleCactusCount = cactusVisibleIndices.length

    let mountainVisibleTotal = 0
    for (let variant = 0; variant < mountainMeshes.length; variant += 1) {
      const entries = mountainCullEntriesByVariant[variant] ?? []
      const state = mountainVisibilityStateByVariant[variant] ?? []
      const nextVariantVisible: number[] = []
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i]
        const wasVisible = state[i] ?? false
        const visible =
          isPointVisible(
            entry.basePoint,
            entry.baseRadius,
            cameraLocalPos,
            cameraLocalDir,
            viewAngle,
            wasVisible,
            rockMargin,
            rockHideExtra,
            rockOcclusionLead,
          ) ||
          isPointVisible(
            entry.peakPoint,
            entry.peakRadius,
            cameraLocalPos,
            cameraLocalDir,
            viewAngle,
            wasVisible,
            rockMargin,
            rockHideExtra,
            rockOcclusionLead,
          )
        state[i] = visible
        if (visible) nextVariantVisible.push(i)
      }
      mountainVisibilityStateByVariant[variant] = state
      const currentVisible = mountainVisibleIndicesByVariant[variant] ?? []
      if (!arraysEqual(nextVariantVisible, currentVisible)) {
        mountainVisibleIndicesByVariant[variant] = nextVariantVisible
        const mesh = mountainMeshes[variant]
        const sourceMatrices = mountainSourceMatricesByVariant[variant] ?? []
        if (mesh) {
          for (let write = 0; write < nextVariantVisible.length; write += 1) {
            const source = sourceMatrices[nextVariantVisible[write]]
            if (!source) continue
            mesh.setMatrixAt(write, source)
          }
          mesh.count = nextVariantVisible.length
          mesh.instanceMatrix.needsUpdate = true
        }
      }
      mountainVisibleTotal += (mountainVisibleIndicesByVariant[variant] ?? []).length
    }
    visibleMountainCount = mountainVisibleTotal

    const nextPebbleVisible: number[] = []
    for (let i = 0; i < pebbleCullEntries.length; i += 1) {
      const entry = pebbleCullEntries[i]
      const wasVisible = pebbleVisibilityState[i] ?? false
      const visible = isPointVisible(
        entry.point,
        entry.radius,
        cameraLocalPos,
        cameraLocalDir,
        viewAngle,
        wasVisible,
        pebbleMargin,
        pebbleHideExtra,
        pebbleOcclusionLead,
      )
      pebbleVisibilityState[i] = visible
      if (visible) nextPebbleVisible.push(i)
    }
    if (!arraysEqual(nextPebbleVisible, pebbleVisibleIndices)) {
      pebbleVisibleIndices = nextPebbleVisible
      if (pebbleMesh) {
        for (let write = 0; write < pebbleVisibleIndices.length; write += 1) {
          const source = pebbleSourceMatrices[pebbleVisibleIndices[write]]
          if (!source) continue
          pebbleMesh.setMatrixAt(write, source)
        }
        pebbleMesh.count = pebbleVisibleIndices.length
        pebbleMesh.instanceMatrix.needsUpdate = true
      }
    }
    visiblePebbleCount = pebbleVisibleIndices.length
  }

  const buildEnvironment = (data: Environment | null) => {
    disposeEnvironment()

    lakes = data?.lakes?.length ? data.lakes.map(buildLakeFromData) : createLakes(0x91fcae12, LAKE_COUNT)

    const planetMaterial = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.9,
      metalness: 0.05,
      side: THREE.FrontSide,
      vertexColors: true,
      wireframe: terrainTessellationDebugEnabled,
    })
    if (PLANET_PATCH_ENABLED) {
      const basePlanetGeometry = createIcosphereGeometry(PLANET_RADIUS, PLANET_BASE_ICOSPHERE_DETAIL)
      const planetGeometry = basePlanetGeometry.clone()
      applyLakeDepressions(planetGeometry, lakes)
      terrainContactSampler = createTerrainContactSampler(
        planetGeometry,
        TERRAIN_CONTACT_BANDS,
        TERRAIN_CONTACT_SLICES,
      )
      planetPatchMaterial = planetMaterial
      buildPlanetPatchAtlas(planetGeometry, planetMaterial)

      const rawShorelineGeometry = new THREE.WireframeGeometry(planetGeometry)
      const shorelineOnlyGeometry = createShorelineGeometry(rawShorelineGeometry, lakes)
      rawShorelineGeometry.dispose()
      if ((shorelineOnlyGeometry.attributes.position?.count ?? 0) > 0) {
        const shorelineLineMaterial = new THREE.LineBasicMaterial({
          color: GRID_LINE_COLOR,
          transparent: true,
          opacity: SHORELINE_LINE_OPACITY,
        })
        shorelineLineMaterial.depthWrite = false
        shorelineLineMesh = new THREE.LineSegments(shorelineOnlyGeometry, shorelineLineMaterial)
        shorelineLineMesh.scale.setScalar(1.002)
        world.add(shorelineLineMesh)
      } else {
        shorelineOnlyGeometry.dispose()
      }

      const shorelineFillGeometry = createShorelineFillGeometry(planetGeometry, lakes)
      if ((shorelineFillGeometry.attributes.position?.count ?? 0) > 0) {
        const shorelineFillMaterial = new THREE.MeshStandardMaterial({
          color: SHORE_SAND_COLOR,
          roughness: 0.92,
          metalness: 0.05,
          transparent: true,
        })
        shorelineFillMaterial.depthWrite = false
        shorelineFillMaterial.depthTest = true
        shorelineFillMaterial.polygonOffset = true
        shorelineFillMaterial.polygonOffsetFactor = -1
        shorelineFillMaterial.polygonOffsetUnits = -1
        shorelineFillMesh = new THREE.Mesh(shorelineFillGeometry, shorelineFillMaterial)
        shorelineFillMesh.renderOrder = 1
        shorelineFillMesh.scale.setScalar(1.001)
        world.add(shorelineFillMesh)
      } else {
        shorelineFillGeometry.dispose()
      }

      planetGeometry.dispose()
      basePlanetGeometry.dispose()
    } else {
      const basePlanetGeometry = createIcosphereGeometry(PLANET_RADIUS, PLANET_BASE_ICOSPHERE_DETAIL)
      const planetGeometry = basePlanetGeometry.clone()
      applyLakeDepressions(planetGeometry, lakes)
      terrainContactSampler = createTerrainContactSampler(
        planetGeometry,
        TERRAIN_CONTACT_BANDS,
        TERRAIN_CONTACT_SLICES,
      )
      planetMesh = new THREE.Mesh(planetGeometry, planetMaterial)
      world.add(planetMesh)

      const rawGridGeometry = new THREE.WireframeGeometry(planetGeometry)
      const gridGeometry = createFilteredGridGeometry(rawGridGeometry, lakes)
      const shorelineLineGeometry = createShorelineGeometry(rawGridGeometry, lakes)
      rawGridGeometry.dispose()
      const gridMaterial = new THREE.LineBasicMaterial({
        color: GRID_LINE_COLOR,
        transparent: true,
        opacity: GRID_LINE_OPACITY,
      })
      gridMaterial.depthWrite = false
      gridMesh = new THREE.LineSegments(gridGeometry, gridMaterial)
      gridMesh.scale.setScalar(1.002)
      world.add(gridMesh)
      const shorelineLineMaterial = new THREE.LineBasicMaterial({
        color: GRID_LINE_COLOR,
        transparent: true,
        opacity: SHORELINE_LINE_OPACITY,
      })
      shorelineLineMaterial.depthWrite = false
      shorelineLineMesh = new THREE.LineSegments(shorelineLineGeometry, shorelineLineMaterial)
      shorelineLineMesh.scale.setScalar(1.002)
      world.add(shorelineLineMesh)

      const shorelineFillGeometry = createShorelineFillGeometry(planetGeometry, lakes)
      const shorelineFillMaterial = new THREE.MeshStandardMaterial({
        color: SHORE_SAND_COLOR,
        roughness: 0.92,
        metalness: 0.05,
        transparent: true,
      })
      shorelineFillMaterial.depthWrite = false
      shorelineFillMaterial.depthTest = true
      shorelineFillMaterial.polygonOffset = true
      shorelineFillMaterial.polygonOffsetFactor = -1
      shorelineFillMaterial.polygonOffsetUnits = -1
      shorelineFillMesh = new THREE.Mesh(shorelineFillGeometry, shorelineFillMaterial)
      shorelineFillMesh.renderOrder = 1
      shorelineFillMesh.scale.setScalar(1.001)
      world.add(shorelineFillMesh)

      basePlanetGeometry.dispose()
    }

    if (webglShaderHooksEnabled) {
      lakeSurfaceGeometry = new THREE.SphereGeometry(1, LAKE_SURFACE_SEGMENTS, LAKE_SURFACE_RINGS)
      for (const lake of lakes) {
        const lakeMaterial = createLakeMaskMaterial(lake)
        const lakeMesh = new THREE.Mesh(lakeSurfaceGeometry, lakeMaterial)
        lakeMesh.scale.setScalar(PLANET_RADIUS - lake.surfaceInset + LAKE_WATER_SURFACE_LIFT)
        lakeMesh.renderOrder = 2
        world.add(lakeMesh)
        lakeMeshes.push(lakeMesh)
        lakeMaterials.push(lakeMaterial)
      }
    } else {
      const lakeBaseGeometry = createIcosphereGeometry(PLANET_RADIUS, LAKE_SURFACE_ICOSPHERE_DETAIL)
      lakeSurfaceGeometry = createLakeSurfaceGeometry(lakeBaseGeometry, lakes)
      lakeBaseGeometry.dispose()
      if ((lakeSurfaceGeometry.attributes.position?.count ?? 0) > 0) {
        const lakeMaterial = createLakeMaterial()
        const lakeMesh = new THREE.Mesh(lakeSurfaceGeometry, lakeMaterial)
        lakeMesh.renderOrder = 2
        world.add(lakeMesh)
        lakeMeshes.push(lakeMesh)
        lakeMaterials.push(lakeMaterial)
      }
    }
    if (isLakeDebugEnabled()) {
      const lakeBaseGeometry = createIcosphereGeometry(PLANET_RADIUS, LAKE_SURFACE_ICOSPHERE_DETAIL)
      const lakeGeometry = createLakeSurfaceGeometry(lakeBaseGeometry, lakes)
      lakeGeometry.dispose()
      lakeBaseGeometry.dispose()
    }
    const rng = createSeededRandom(0x6f35d2a1)
    const randRange = (min: number, max: number) => min + (max - min) * rng()
    const tierHeightSum = TREE_TIER_HEIGHT_FACTORS.reduce((sum, value) => sum + value, 0)
    const tierHeightScale =
      tierHeightSum > 0 ? (TREE_HEIGHT - TREE_TRUNK_HEIGHT) / tierHeightSum : 0
    const treeTierHeights = TREE_TIER_HEIGHT_FACTORS.map(
      (factor) => factor * tierHeightScale,
    )
    const treeTierRadii = TREE_TIER_RADIUS_FACTORS.map((factor) => factor * TREE_HEIGHT)
    const treeTierOffsets: number[] = []
    let tierBase = TREE_TRUNK_HEIGHT * 0.75
    for (let i = 0; i < treeTierHeights.length; i += 1) {
      const height = treeTierHeights[i]
      treeTierOffsets.push(tierBase - height * 0.08)
      tierBase += height * (1 - TREE_TIER_OVERLAP)
    }
    let baseTreeHeight = TREE_TRUNK_HEIGHT
    for (let i = 0; i < treeTierHeights.length; i += 1) {
      const top = treeTierOffsets[i] + treeTierHeights[i]
      if (top > baseTreeHeight) baseTreeHeight = top
    }

    const leafMaterial = new THREE.MeshStandardMaterial({
      color: '#7fb35a',
      roughness: 0.85,
      metalness: 0.05,
      flatShading: true,
    })
    const trunkMaterial = new THREE.MeshStandardMaterial({
      color: '#b8743c',
      roughness: 0.9,
      metalness: 0.05,
      flatShading: true,
    })
    const cactusBodyMaterial = new THREE.MeshStandardMaterial({
      color: '#228f44',
      roughness: 0.88,
      metalness: 0.03,
      flatShading: true,
    })
    const cactusArmMat = new THREE.MeshStandardMaterial({
      color: '#279a4b',
      roughness: 0.87,
      metalness: 0.03,
      flatShading: true,
    })
    treeLeafMaterial = leafMaterial
    treeTrunkMaterial = trunkMaterial
    cactusMaterial = cactusBodyMaterial
    cactusArmMaterial = cactusArmMat
    const treeInstanceCount = Math.max(0, TREE_COUNT - MOUNTAIN_COUNT)

    for (let i = 0; i < treeTierHeights.length; i += 1) {
      const height = treeTierHeights[i]
      const radius = treeTierRadii[i]
      const geometry = new THREE.ConeGeometry(radius, height, 6, 1)
      geometry.translate(0, height / 2, 0)
      treeTierGeometries.push(geometry)
      const mesh = new THREE.InstancedMesh(geometry, leafMaterial, TREE_COUNT)
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
      mesh.frustumCulled = false
      mesh.count = treeInstanceCount
      treeTierMeshes.push(mesh)
      environmentGroup.add(mesh)
    }

    treeTrunkGeometry = new THREE.CylinderGeometry(
      TREE_TRUNK_RADIUS * 0.7,
      TREE_TRUNK_RADIUS,
      TREE_TRUNK_HEIGHT,
      6,
      1,
    )
    treeTrunkGeometry.translate(0, TREE_TRUNK_HEIGHT / 2, 0)
    treeTrunkMesh = new THREE.InstancedMesh(treeTrunkGeometry, trunkMaterial, TREE_COUNT)
    treeTrunkMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    treeTrunkMesh.frustumCulled = false
    treeTrunkMesh.count = treeInstanceCount
    environmentGroup.add(treeTrunkMesh)

    const trunkSpinePoints = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, CACTUS_TRUNK_HEIGHT * 0.3, 0),
      new THREE.Vector3(0, CACTUS_TRUNK_HEIGHT * 0.68, 0),
      new THREE.Vector3(0, CACTUS_TRUNK_HEIGHT, 0),
    ]
    const leftArmSpinePoints = [
      new THREE.Vector3(-CACTUS_TRUNK_RADIUS * 0.5, CACTUS_LEFT_ARM_BASE_HEIGHT, 0),
      new THREE.Vector3(-CACTUS_TRUNK_RADIUS * 1.28, CACTUS_LEFT_ARM_BASE_HEIGHT + CACTUS_TRUNK_HEIGHT * 0.09, 0),
      new THREE.Vector3(-CACTUS_TRUNK_RADIUS * 1.72, CACTUS_LEFT_ARM_BASE_HEIGHT + CACTUS_TRUNK_HEIGHT * 0.26, 0),
      new THREE.Vector3(-CACTUS_TRUNK_RADIUS * 1.66, CACTUS_LEFT_ARM_BASE_HEIGHT + CACTUS_TRUNK_HEIGHT * 0.47, 0),
    ]
    const rightArmSpinePoints = [
      new THREE.Vector3(CACTUS_TRUNK_RADIUS * 0.48, CACTUS_RIGHT_ARM_BASE_HEIGHT, 0),
      new THREE.Vector3(CACTUS_TRUNK_RADIUS * 1.1, CACTUS_RIGHT_ARM_BASE_HEIGHT + CACTUS_TRUNK_HEIGHT * 0.07, 0),
      new THREE.Vector3(CACTUS_TRUNK_RADIUS * 1.42, CACTUS_RIGHT_ARM_BASE_HEIGHT + CACTUS_TRUNK_HEIGHT * 0.21, 0),
      new THREE.Vector3(CACTUS_TRUNK_RADIUS * 1.32, CACTUS_RIGHT_ARM_BASE_HEIGHT + CACTUS_TRUNK_HEIGHT * 0.37, 0),
    ]

    const trunkCurve = new THREE.CatmullRomCurve3(trunkSpinePoints, false, 'centripetal', 0.25)
    cactusTrunkGeometry = new THREE.TubeGeometry(
      trunkCurve,
      CACTUS_TRUNK_TUBE_SEGMENTS,
      CACTUS_TRUNK_RADIUS,
      CACTUS_TUBE_RADIAL_SEGMENTS,
      false,
    )
    cactusTrunkMesh = new THREE.InstancedMesh(cactusTrunkGeometry, cactusBodyMaterial, TREE_COUNT)
    cactusTrunkMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    cactusTrunkMesh.frustumCulled = false
    cactusTrunkMesh.count = 0
    environmentGroup.add(cactusTrunkMesh)

    const cactusArmSpecs: Array<{
      points: THREE.Vector3[]
      radius: number
    }> = [
      { points: leftArmSpinePoints, radius: CACTUS_LEFT_ARM_RADIUS },
      { points: rightArmSpinePoints, radius: CACTUS_RIGHT_ARM_RADIUS },
    ]
    for (const spec of cactusArmSpecs) {
      const curve = new THREE.CatmullRomCurve3(spec.points, false, 'centripetal', 0.25)
      const geometry = new THREE.TubeGeometry(
        curve,
        CACTUS_ARM_TUBE_SEGMENTS,
        spec.radius,
        CACTUS_TUBE_RADIAL_SEGMENTS,
        false,
      )
      cactusPartGeometries.push(geometry)
      const mesh = new THREE.InstancedMesh(geometry, cactusArmMat, TREE_COUNT)
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
      mesh.frustumCulled = false
      mesh.count = 0
      cactusPartMeshes.push(mesh)
      environmentGroup.add(mesh)
    }

    const cactusSphereSpecs: Array<{
      point: THREE.Vector3
      radius: number
      material: THREE.Material
    }> = [
      {
        point: trunkSpinePoints[0].clone(),
        radius: CACTUS_TRUNK_RADIUS * 1.05,
        material: cactusBodyMaterial,
      },
      {
        point: trunkSpinePoints[trunkSpinePoints.length - 1].clone(),
        radius: CACTUS_TRUNK_RADIUS * 1.05,
        material: cactusBodyMaterial,
      },
      {
        point: leftArmSpinePoints[0].clone(),
        radius: CACTUS_LEFT_ARM_RADIUS * 1.05,
        material: cactusBodyMaterial,
      },
      {
        point: leftArmSpinePoints[leftArmSpinePoints.length - 1].clone(),
        radius: CACTUS_LEFT_ARM_RADIUS * 1.03,
        material: cactusArmMat,
      },
      {
        point: rightArmSpinePoints[0].clone(),
        radius: CACTUS_RIGHT_ARM_RADIUS * 1.05,
        material: cactusBodyMaterial,
      },
      {
        point: rightArmSpinePoints[rightArmSpinePoints.length - 1].clone(),
        radius: CACTUS_RIGHT_ARM_RADIUS * 1.03,
        material: cactusArmMat,
      },
    ]
    for (const spec of cactusSphereSpecs) {
      const geometry = new THREE.SphereGeometry(spec.radius, 8, 6)
      geometry.translate(spec.point.x, spec.point.y, spec.point.z)
      cactusPartGeometries.push(geometry)
      const mesh = new THREE.InstancedMesh(geometry, spec.material, TREE_COUNT)
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
      mesh.frustumCulled = false
      mesh.count = 0
      cactusPartMeshes.push(mesh)
      environmentGroup.add(mesh)
    }

    mountainMaterial = new THREE.MeshStandardMaterial({
      color: '#8f8f8f',
      roughness: 0.95,
      metalness: 0.02,
      flatShading: true,
    })
    for (let i = 0; i < MOUNTAIN_VARIANTS; i += 1) {
      const geometry = createMountainGeometry(0x3f2a9b1 + i * 57)
      mountainGeometries.push(geometry)
      const mesh = new THREE.InstancedMesh(geometry, mountainMaterial, MOUNTAIN_COUNT)
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
      mesh.frustumCulled = false
      mesh.count = 0
      mountainMeshes.push(mesh)
      environmentGroup.add(mesh)
    }

    pebbleGeometry = new THREE.IcosahedronGeometry(1, 0)
    const rockMaterial = new THREE.MeshStandardMaterial({
      color: '#808080',
      roughness: 0.95,
      metalness: 0.05,
      flatShading: true,
    })
    pebbleMaterial = rockMaterial
    pebbleMesh = new THREE.InstancedMesh(pebbleGeometry, rockMaterial, PEBBLE_COUNT)
    pebbleMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    pebbleMesh.frustumCulled = false
    environmentGroup.add(pebbleMesh)

    const up = new THREE.Vector3(0, 1, 0)
    const normal = new THREE.Vector3()
    const position = new THREE.Vector3()
    const baseQuat = new THREE.Quaternion()
    const twistQuat = new THREE.Quaternion()
    const baseScale = new THREE.Vector3()
    const baseMatrix = new THREE.Matrix4()
    const localMatrix = new THREE.Matrix4()
    const worldMatrix = new THREE.Matrix4()

    const minDot = Math.cos(TREE_MIN_ANGLE)
    const minHeightScale = TREE_MIN_HEIGHT / baseTreeHeight
    const maxHeightScale = Math.max(minHeightScale, TREE_MAX_HEIGHT / baseTreeHeight)
    const lakeSampleTemp = new THREE.Vector3()
    const isInLake = (candidate: THREE.Vector3) =>
      sampleLakes(candidate, lakes, lakeSampleTemp).boundary > LAKE_EXCLUSION_THRESHOLD
    treeTrunkSourceMatrices = []
    treeTierSourceMatrices = treeTierMeshes.map(() => [])
    cactusTrunkSourceMatrices = []
    cactusPartSourceMatrices = cactusPartMeshes.map(() => [])
    treeCullEntries = []
    treeVisibilityState = []
    treeVisibleIndices = []
    cactusCullEntries = []
    cactusVisibilityState = []
    cactusVisibleIndices = []
    visibleTreeCount = 0
    visibleCactusCount = 0
    mountainSourceMatricesByVariant = mountainMeshes.map(() => [])
    mountainCullEntriesByVariant = mountainMeshes.map(() => [])
    mountainVisibilityStateByVariant = mountainMeshes.map(() => [])
    mountainVisibleIndicesByVariant = mountainMeshes.map(() => [])
    visibleMountainCount = 0
    pebbleSourceMatrices = []
    pebbleCullEntries = []
    pebbleVisibilityState = []
    pebbleVisibleIndices = []
    visiblePebbleCount = 0

    if (data?.trees?.length) {
      trees = data.trees.map(buildTreeFromData)
    } else {
      const forestNormals: THREE.Vector3[] = []
      const cactusNormals: THREE.Vector3[] = []
      const treeScales: THREE.Vector3[] = []
      const cactusScales: THREE.Vector3[] = []
      const pickSparseNormal = (
        out: THREE.Vector3,
        existing: THREE.Vector3[],
        minDot: number,
        predicate: (candidate: THREE.Vector3) => boolean,
      ) => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          randomOnSphere(rng, out)
          if (predicate(out)) continue
          let ok = true
          for (const sample of existing) {
            if (sample.dot(out) > minDot) {
              ok = false
              break
            }
          }
          if (ok) return out
        }
        for (let attempt = 0; attempt < 40; attempt += 1) {
          randomOnSphere(rng, out)
          if (!predicate(out)) return out
        }
        return out
      }

      const cactusCount = Math.min(DESERT_CACTUS_COUNT, treeInstanceCount)
      const forestCount = Math.max(0, treeInstanceCount - cactusCount)
      const cactusMinDot = Math.cos(0.34)
      for (let i = 0; i < forestCount; i += 1) {
        const candidate = new THREE.Vector3()
        pickSparseNormal(
          candidate,
          forestNormals,
          minDot,
          (out) => isInLake(out) || isDesertBiome(out),
        )
        const widthScale = randRange(TREE_MIN_SCALE, TREE_MAX_SCALE)
        const heightScale = randRange(minHeightScale, maxHeightScale)
        forestNormals.push(candidate)
        treeScales.push(new THREE.Vector3(widthScale, heightScale, widthScale))
      }
      for (let i = 0; i < cactusCount; i += 1) {
        const candidate = new THREE.Vector3()
        pickSparseNormal(
          candidate,
          cactusNormals,
          cactusMinDot,
          (out) => isInLake(out) || !isDesertBiome(out),
        )
        const widthScale = randRange(TREE_MIN_SCALE, TREE_MAX_SCALE)
        const heightScale = randRange(minHeightScale, maxHeightScale)
        cactusNormals.push(candidate)
        cactusScales.push(new THREE.Vector3(widthScale, heightScale, widthScale))
      }

      const generatedForest = forestNormals.map((treeNormal, index) => ({
        normal: treeNormal,
        widthScale: treeScales[index]?.x ?? 1,
        heightScale: treeScales[index]?.y ?? 1,
        twist: randRange(0, Math.PI * 2),
      }))
      const generatedCactus = cactusNormals.map((treeNormal, index) => ({
        normal: treeNormal,
        widthScale: -(cactusScales[index]?.x ?? 1),
        heightScale: cactusScales[index]?.y ?? 1,
        twist: randRange(0, Math.PI * 2),
      }))
      trees = [...generatedForest, ...generatedCactus]
    }

    const forestTrees = trees.filter((tree) => tree.widthScale >= 0)
    const cactusTrees = trees.filter((tree) => tree.widthScale < 0)
    const appliedTreeCount = Math.min(treeInstanceCount, forestTrees.length)
    const treeBaseRadius = PLANET_RADIUS + TREE_BASE_OFFSET - TREE_TRUNK_HEIGHT * 0.12
    const treeCanopyRadius = treeTierRadii.reduce((max, radius) => Math.max(max, radius), 0)
    for (let i = 0; i < appliedTreeCount; i += 1) {
      const tree = forestTrees[i]
      normal.copy(tree.normal)
      baseQuat.setFromUnitVectors(up, normal)
      twistQuat.setFromAxisAngle(up, tree.twist)
      baseQuat.multiply(twistQuat)
      baseScale.set(tree.widthScale, tree.heightScale, tree.widthScale)
      position.copy(normal).multiplyScalar(treeBaseRadius)
      baseMatrix.compose(position, baseQuat, baseScale)
      treeTrunkSourceMatrices.push(baseMatrix.clone())

      for (let t = 0; t < treeTierMeshes.length; t += 1) {
        localMatrix.makeTranslation(0, treeTierOffsets[t], 0)
        worldMatrix.copy(baseMatrix).multiply(localMatrix)
        treeTierSourceMatrices[t]?.push(worldMatrix.clone())
      }
      treeCullEntries.push({
        basePoint: normal.clone().multiplyScalar(treeBaseRadius),
        topPoint: normal
          .clone()
          .multiplyScalar(treeBaseRadius + baseTreeHeight * tree.heightScale),
        baseRadius: TREE_TRUNK_RADIUS * tree.widthScale,
        topRadius: Math.max(TREE_TRUNK_RADIUS, treeCanopyRadius) * tree.widthScale,
      })
      treeVisibilityState.push(false)
    }
    cactusTrunkSourceMatrices = []
    cactusPartSourceMatrices = cactusPartMeshes.map(() => [])
    cactusCullEntries = []
    cactusVisibilityState = []
    cactusVisibleIndices = []
    const cactusBaseRadius = PLANET_RADIUS + TREE_BASE_OFFSET - CACTUS_BASE_SINK
    const appliedCactusCount = Math.min(treeInstanceCount, cactusTrees.length)
    const cactusTopLocalPoint = trunkSpinePoints[trunkSpinePoints.length - 1] ?? new THREE.Vector3(0, CACTUS_TRUNK_HEIGHT, 0)
    const cactusLeftTipLocalPoint =
      leftArmSpinePoints[leftArmSpinePoints.length - 1] ??
      new THREE.Vector3(-CACTUS_TRUNK_RADIUS * 1.66, CACTUS_LEFT_ARM_BASE_HEIGHT + CACTUS_TRUNK_HEIGHT * 0.47, 0)
    const cactusRightTipLocalPoint =
      rightArmSpinePoints[rightArmSpinePoints.length - 1] ??
      new THREE.Vector3(CACTUS_TRUNK_RADIUS * 1.32, CACTUS_RIGHT_ARM_BASE_HEIGHT + CACTUS_TRUNK_HEIGHT * 0.37, 0)
    for (let i = 0; i < appliedCactusCount; i += 1) {
      const cactus = cactusTrees[i]
      const widthScale = Math.abs(cactus.widthScale)
      normal.copy(cactus.normal)
      baseQuat.setFromUnitVectors(up, normal)
      twistQuat.setFromAxisAngle(up, cactus.twist)
      baseQuat.multiply(twistQuat)
      const cactusScale = clamp(
        widthScale * CACTUS_UNIFORM_SCALE_MULTIPLIER,
        CACTUS_MIN_UNIFORM_SCALE,
        CACTUS_MAX_UNIFORM_SCALE,
      )
      baseScale.set(cactusScale, cactusScale, cactusScale)
      position.copy(normal).multiplyScalar(cactusBaseRadius)
      baseMatrix.compose(position, baseQuat, baseScale)
      cactusTrunkSourceMatrices.push(baseMatrix.clone())
      for (let p = 0; p < cactusPartMeshes.length; p += 1) {
        cactusPartSourceMatrices[p]?.push(baseMatrix.clone())
      }
      const basePoint = new THREE.Vector3(0, 0, 0).applyMatrix4(baseMatrix)
      const topPoint = cactusTopLocalPoint.clone().applyMatrix4(baseMatrix)
      const leftArmTipPoint = cactusLeftTipLocalPoint.clone().applyMatrix4(baseMatrix)
      const rightArmTipPoint = cactusRightTipLocalPoint.clone().applyMatrix4(baseMatrix)
      const baseRadius = CACTUS_TRUNK_RADIUS * cactusScale
      const armRadius = Math.max(CACTUS_LEFT_ARM_RADIUS, CACTUS_RIGHT_ARM_RADIUS) * cactusScale
      cactusCullEntries.push({
        basePoint,
        topPoint,
        leftArmTipPoint,
        rightArmTipPoint,
        baseRadius,
        topRadius: baseRadius * 0.96,
        armRadius,
      })
      cactusVisibilityState.push(false)
    }

    if (treeTrunkMesh) {
      treeTrunkMesh.count = 0
      treeTrunkMesh.instanceMatrix.needsUpdate = true
    }
    for (const mesh of treeTierMeshes) {
      mesh.count = 0
      mesh.instanceMatrix.needsUpdate = true
    }
    if (cactusTrunkMesh) {
      cactusTrunkMesh.count = 0
      cactusTrunkMesh.instanceMatrix.needsUpdate = true
    }
    for (let p = 0; p < cactusPartMeshes.length; p += 1) {
      const mesh = cactusPartMeshes[p]
      mesh.count = 0
      mesh.instanceMatrix.needsUpdate = true
    }
    visibleCactusCount = 0

    if (data?.mountains?.length) {
      mountains = data.mountains.map(buildMountainFromData)
    } else {
      const mountainNormals: THREE.Vector3[] = []
      const mountainMinDot = Math.cos(MOUNTAIN_MIN_ANGLE)
      const pickMountainNormal = (out: THREE.Vector3) => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          randomOnSphere(rng, out)
          if (isInLake(out) || isDesertBiome(out)) continue
          let ok = true
          for (const existing of mountainNormals) {
            if (existing.dot(out) > mountainMinDot) {
              ok = false
              break
            }
          }
          if (ok) return out
        }
        for (let attempt = 0; attempt < 40; attempt += 1) {
          randomOnSphere(rng, out)
          if (!isInLake(out) && !isDesertBiome(out)) return out
        }
        return out
      }
      for (let i = 0; i < MOUNTAIN_COUNT; i += 1) {
        const candidate = new THREE.Vector3()
        pickMountainNormal(candidate)
        const radius = randRange(MOUNTAIN_RADIUS_MIN, MOUNTAIN_RADIUS_MAX)
        const height = randRange(MOUNTAIN_HEIGHT_MIN, MOUNTAIN_HEIGHT_MAX)
        const variant = Math.floor(rng() * MOUNTAIN_VARIANTS)
        const twist = randRange(0, Math.PI * 2)
        const outline = new Array(MOUNTAIN_OUTLINE_SAMPLES).fill(radius / PLANET_RADIUS)
        const upVector = Math.abs(candidate.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
        const tangent = new THREE.Vector3().crossVectors(upVector, candidate).normalize()
        const bitangent = new THREE.Vector3().crossVectors(candidate, tangent).normalize()
        mountainNormals.push(candidate)
        mountains.push({
          normal: candidate,
          radius,
          height,
          variant,
          twist,
          outline,
          tangent,
          bitangent,
        })
      }
    }

    if (mountainMeshes.length > 0) {
      for (const mountain of mountains) {
        const variantIndex = Math.min(mountainMeshes.length - 1, Math.max(0, Math.floor(mountain.variant)))
        if (variantIndex < 0) continue
        normal.copy(mountain.normal)
        baseQuat.setFromUnitVectors(up, normal)
        twistQuat.setFromAxisAngle(up, mountain.twist)
        baseQuat.multiply(twistQuat)
        baseScale.set(mountain.radius, mountain.height, mountain.radius)
        position.copy(normal).multiplyScalar(PLANET_RADIUS - MOUNTAIN_BASE_SINK)
        baseMatrix.compose(position, baseQuat, baseScale)
        mountainSourceMatricesByVariant[variantIndex]?.push(baseMatrix.clone())
        mountainCullEntriesByVariant[variantIndex]?.push({
          basePoint: normal.clone().multiplyScalar(PLANET_RADIUS - MOUNTAIN_BASE_SINK),
          peakPoint: normal
            .clone()
            .multiplyScalar(PLANET_RADIUS - MOUNTAIN_BASE_SINK + mountain.height * 0.92),
          baseRadius: mountain.radius,
          peakRadius: mountain.radius * 0.58,
          variant: variantIndex,
        })
        mountainVisibilityStateByVariant[variantIndex]?.push(false)
      }
      for (let i = 0; i < mountainMeshes.length; i += 1) {
        const mesh = mountainMeshes[i]
        mesh.count = 0
        mesh.instanceMatrix.needsUpdate = true
      }
    }

    if (pebbleMesh) {
      const pebbleQuat = new THREE.Quaternion()
      const pebbleScale = new THREE.Vector3()
      const scaleMin = 1 - PEBBLE_RADIUS_VARIANCE * 0.45
      const scaleMax = 1 + PEBBLE_RADIUS_VARIANCE * 0.55
      let placed = 0
      let attempts = 0
      const maxAttempts = PEBBLE_COUNT * 10
      while (placed < PEBBLE_COUNT && attempts < maxAttempts) {
        attempts += 1
        randomOnSphere(rng, normal)
        if (isInLake(normal) || isDesertBiome(normal)) continue
        pebbleQuat.setFromUnitVectors(up, normal)
        twistQuat.setFromAxisAngle(up, randRange(0, Math.PI * 2))
        pebbleQuat.multiply(twistQuat)
        const radiusBlend = Math.pow(rng(), 0.8)
        const radius =
          PEBBLE_RADIUS_MIN +
          (PEBBLE_RADIUS_MAX - PEBBLE_RADIUS_MIN) * radiusBlend
        pebbleScale.set(
          radius * randRange(scaleMin, scaleMax),
          radius * randRange(scaleMin * 0.9, scaleMax * 0.9),
          radius * randRange(scaleMin, scaleMax),
        )
        position
          .copy(normal)
          .multiplyScalar(PLANET_RADIUS + PEBBLE_OFFSET - radius * 0.25)
        worldMatrix.compose(position, pebbleQuat, pebbleScale)
        pebbleSourceMatrices.push(worldMatrix.clone())
        pebbleCullEntries.push({
          point: position.clone(),
          radius: radius * 1.2,
        })
        pebbleVisibilityState.push(false)
        placed += 1
      }
      pebbleMesh.count = 0
      pebbleMesh.instanceMatrix.needsUpdate = true
    }

    patchCenterQuat.copy(world.quaternion).invert()
    cameraLocalPosTemp.copy(camera.position).applyQuaternion(patchCenterQuat)
    cameraLocalDirTemp.copy(cameraLocalPosTemp).normalize()
    const aspect = viewportHeight > 0 ? viewportWidth / viewportHeight : 1
    const viewAngle = computeVisibleSurfaceAngle(camera.position.z, aspect)
    updatePlanetPatchVisibility(cameraLocalDirTemp, viewAngle)
    updateLakeVisibility(cameraLocalDirTemp, viewAngle)
    updateEnvironmentVisibility(cameraLocalPosTemp, cameraLocalDirTemp, viewAngle)

    rebuildMountainDebug()
    rebuildLakeDebug()
    rebuildTreeDebug()
  }

  buildEnvironment(null)

  const createSnakeVisual = (color: string): SnakeVisual => {
    const group = new THREE.Group()

    const tubeMaterial = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.35,
      metalness: 0.1,
      flatShading: true,
    })
    const tube = new THREE.Mesh(new THREE.BufferGeometry(), tubeMaterial)
    group.add(tube)

    const headMaterial = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.25,
      metalness: 0.1,
    })
    const head = new THREE.Mesh(headGeometry, headMaterial)
    group.add(head)

    const bowlCrackUniform = { value: 0 }
    const bowlMaterial = new THREE.MeshPhysicalMaterial({
      color: '#cfefff',
      roughness: 0.08,
      metalness: 0.0,
      transmission: 0.7,
      thickness: 0.35,
      clearcoat: 1,
      clearcoatRoughness: 0.1,
      transparent: true,
      opacity: 0.45,
    })
    bowlMaterial.depthWrite = false
    if (webglShaderHooksEnabled) {
      bowlMaterial.onBeforeCompile = (shader) => {
        shader.uniforms.crackAmount = bowlCrackUniform
        shader.fragmentShader = `uniform float crackAmount;\n${shader.fragmentShader}`
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `
          float crackMask = 0.0;
          vec3 crackPos = normalize(vNormal);
          float lineA = abs(sin(crackPos.x * 24.0) * sin(crackPos.y * 21.0));
          float lineB = abs(sin(crackPos.y * 17.0 + crackPos.z * 11.0));
          float lineC = abs(sin(crackPos.z * 19.0 - crackPos.x * 13.0));
          float lines = max(lineA, max(lineB, lineC));
          crackMask = smoothstep(0.92, 0.985, lines) * crackAmount;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1, 0.16, 0.2), crackMask);
          diffuseColor.a = max(diffuseColor.a, crackMask * 0.6);
          #include <dithering_fragment>
          `,
        )
      }
    }
    const bowl = new THREE.Mesh(bowlGeometry, bowlMaterial)
    bowl.renderOrder = 3
    bowl.visible = false
    group.add(bowl)

    const tail = new THREE.Mesh(tailGeometry, tubeMaterial)
    group.add(tail)

    const eyeMaterialLocal = eyeMaterial.clone()
    const pupilMaterialLocal = pupilMaterial.clone()
    const tongueMaterialLocal = tongueMaterial.clone()
    const eyeLeft = new THREE.Mesh(eyeGeometry, eyeMaterialLocal)
    const eyeRight = new THREE.Mesh(eyeGeometry, eyeMaterialLocal)
    const pupilLeft = new THREE.Mesh(pupilGeometry, pupilMaterialLocal)
    const pupilRight = new THREE.Mesh(pupilGeometry, pupilMaterialLocal)
    const tongue = new THREE.Group()
    const tongueBase = new THREE.Mesh(tongueBaseGeometry, tongueMaterialLocal)
    const tongueForkLeft = new THREE.Mesh(tongueForkGeometry, tongueMaterialLocal)
    const tongueForkRight = new THREE.Mesh(tongueForkGeometry, tongueMaterialLocal)
    tongueForkLeft.rotation.z = TONGUE_FORK_SPREAD
    tongueForkRight.rotation.z = -TONGUE_FORK_SPREAD
    tongue.add(tongueBase)
    tongue.add(tongueForkLeft)
    tongue.add(tongueForkRight)
    tongue.visible = false
    group.add(eyeLeft)
    group.add(eyeRight)
    group.add(pupilLeft)
    group.add(pupilRight)
    group.add(tongue)

    return {
      group,
      tube,
      head,
      tail,
      eyeLeft,
      eyeRight,
      pupilLeft,
      pupilRight,
      tongue,
      tongueBase,
      tongueForkLeft,
      tongueForkRight,
      bowl,
      bowlMaterial,
      bowlCrackUniform,
      color,
    }
  }

  const updateSnakeMaterial = (
    material: THREE.MeshStandardMaterial,
    color: string,
    isLocal: boolean,
    opacity: number,
    emissiveIntensity?: number,
  ) => {
    const base = new THREE.Color(color)
    material.color.copy(base)
    material.emissive.copy(base)
    material.emissiveIntensity = emissiveIntensity ?? (isLocal ? 0.3 : 0.12)
    material.opacity = opacity
    const shouldBeTransparent = opacity < 0.999
    if (material.transparent !== shouldBeTransparent) {
      material.transparent = shouldBeTransparent
      material.needsUpdate = true
    }
    material.depthWrite = !shouldBeTransparent
  }

  const createGroundingInfo = (): SnakeGroundingInfo => ({
    minClearance: Number.POSITIVE_INFINITY,
    maxPenetration: 0,
    maxAppliedLift: 0,
    sampleCount: 0,
  })

  const finalizeGroundingInfo = (
    info: SnakeGroundingInfo | null,
  ): SnakeGroundingInfo | null => {
    if (!info || info.sampleCount <= 0) return null
    return {
      minClearance: Number.isFinite(info.minClearance) ? info.minClearance : 0,
      maxPenetration: info.maxPenetration,
      maxAppliedLift: info.maxAppliedLift,
      sampleCount: info.sampleCount,
    }
  }

  const getAnalyticTerrainRadius = (
    normal: THREE.Vector3,
    sample?: ReturnType<typeof sampleLakes>,
  ) => {
    const lakeSample = sample ?? sampleLakes(normal, lakes, lakeSampleTemp)
    const depth = getVisualLakeTerrainDepth(lakeSample)
    const duneOffset = sampleDuneOffset(normal) * sampleDesertBlend(normal)
    return PLANET_RADIUS + duneOffset - depth
  }

  const getTerrainRadius = (
    normal: THREE.Vector3,
    sample?: ReturnType<typeof sampleLakes>,
  ) => {
    if (terrainContactSampler) {
      const sampled = sampleTerrainContactRadius(terrainContactSampler, normal)
      if (sampled !== null) return sampled
    }
    return getAnalyticTerrainRadius(normal, sample)
  }

  const sampleSnakeContactLift = (
    normal: THREE.Vector3,
    tangent: THREE.Vector3,
    centerlineRadius: number,
    supportRadius: number,
    clearance: number,
    stats: SnakeGroundingInfo | null,
  ) => {
    if (supportRadius <= 0) return 0
    snakeContactTangentTemp.copy(tangent)
    snakeContactTangentTemp.addScaledVector(normal, -snakeContactTangentTemp.dot(normal))
    if (snakeContactTangentTemp.lengthSq() <= 1e-8) {
      buildTangentBasis(normal, snakeContactTangentTemp, snakeContactBitangentTemp)
    } else {
      snakeContactTangentTemp.normalize()
      snakeContactBitangentTemp.crossVectors(normal, snakeContactTangentTemp)
      if (snakeContactBitangentTemp.lengthSq() <= 1e-8) {
        buildTangentBasis(normal, snakeContactTangentTemp, snakeContactBitangentTemp)
      } else {
        snakeContactBitangentTemp.normalize()
      }
    }

    snakeContactCenterTemp.copy(normal).multiplyScalar(centerlineRadius)
    let maxLift = 0
    const sampleCount = Math.max(3, SNAKE_CONTACT_ARC_SAMPLES)
    const denominator = sampleCount - 1
    for (let i = 0; i < sampleCount; i += 1) {
      const t = denominator > 0 ? i / denominator : 0.5
      const angle = -Math.PI * 0.5 + t * Math.PI
      const sin = Math.sin(angle)
      const cos = Math.cos(angle)
      snakeContactOffsetTemp.copy(snakeContactBitangentTemp).multiplyScalar(sin)
      snakeContactOffsetTemp.addScaledVector(normal, -cos)
      snakeContactPointTemp
        .copy(snakeContactCenterTemp)
        .addScaledVector(snakeContactOffsetTemp, supportRadius)
      const pointRadius = snakeContactPointTemp.length()
      if (!Number.isFinite(pointRadius) || pointRadius <= 1e-6) continue
      snakeContactNormalTemp.copy(snakeContactPointTemp).multiplyScalar(1 / pointRadius)
      const terrainRadius = getTerrainRadius(snakeContactNormalTemp)
      const requiredRadius = terrainRadius + clearance
      const clearanceValue = pointRadius - requiredRadius
      if (stats) {
        stats.sampleCount += 1
        stats.minClearance = Math.min(stats.minClearance, clearanceValue)
        if (clearanceValue < 0) {
          stats.maxPenetration = Math.max(stats.maxPenetration, -clearanceValue)
        }
      }
      if (clearanceValue >= 0) continue

      const pointDotNormal = snakeContactPointTemp.dot(normal)
      const requiredSq = requiredRadius * requiredRadius
      const pointSq = pointRadius * pointRadius
      const discriminant = Math.max(
        0,
        pointDotNormal * pointDotNormal + (requiredSq - pointSq),
      )
      let lift = -clearanceValue
      const solvedLift = -pointDotNormal + Math.sqrt(discriminant)
      if (Number.isFinite(solvedLift) && solvedLift > lift) {
        lift = solvedLift
      }
      if (lift > maxLift) maxLift = lift
    }

    return maxLift
  }

  const applySnakeContactLift = (
    normal: THREE.Vector3,
    tangent: THREE.Vector3,
    centerlineRadius: number,
    supportRadius: number,
    groundingInfo: SnakeGroundingInfo | null,
  ) => {
    let liftedRadius = centerlineRadius
    let totalLift = 0
    for (let iteration = 0; iteration < SNAKE_CONTACT_LIFT_ITERATIONS; iteration += 1) {
      const lift = sampleSnakeContactLift(
        normal,
        tangent,
        liftedRadius,
        supportRadius,
        SNAKE_CONTACT_CLEARANCE,
        null,
      )
      if (lift <= SNAKE_CONTACT_LIFT_EPS) break
      liftedRadius += lift
      totalLift += lift
    }
    if (groundingInfo) {
      sampleSnakeContactLift(
        normal,
        tangent,
        liftedRadius,
        supportRadius,
        SNAKE_CONTACT_CLEARANCE,
        groundingInfo,
      )
      groundingInfo.maxAppliedLift = Math.max(groundingInfo.maxAppliedLift, totalLift)
    }
    return totalLift
  }

  const getSnakeCenterlineRadius = (
    normal: THREE.Vector3,
    radiusOffset: number,
    snakeRadius: number,
  ) => {
    const sample = sampleLakes(normal, lakes, lakeSampleTemp)
    const terrainRadius = getTerrainRadius(normal, sample)
    let centerlineRadius = terrainRadius + radiusOffset
    if (!sample.lake || sample.boundary <= LAKE_WATER_MASK_THRESHOLD) {
      return centerlineRadius
    }

    const boundary = clamp(sample.boundary, 0, 1)
    const submergeBlend = smoothstep(
      SNAKE_WATERLINE_BLEND_START,
      SNAKE_WATERLINE_BLEND_END,
      boundary,
    )
    if (submergeBlend <= 0) return centerlineRadius

    const waterRadius = PLANET_RADIUS - sample.lake.surfaceInset
    const minCenterlineRadius = terrainRadius + SNAKE_MIN_TERRAIN_CLEARANCE
    const maxUnderwaterRadius = waterRadius - (snakeRadius + SNAKE_UNDERWATER_CLEARANCE)
    const submergedRadius = Math.max(
      minCenterlineRadius,
      Math.min(centerlineRadius, maxUnderwaterRadius),
    )
    centerlineRadius += (submergedRadius - centerlineRadius) * submergeBlend
    return centerlineRadius
  }

  const buildSnakeCurvePoints = (
    nodes: Point[],
    radiusOffset: number,
    snakeRadius: number,
    groundingInfo: SnakeGroundingInfo | null,
  ) => {
    const curvePoints: THREE.Vector3[] = []
    if (nodes.length === 0) return curvePoints

    const nodeNormals = new Array<THREE.Vector3>(nodes.length)
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]
      nodeNormals[i] = new THREE.Vector3(node.x, node.y, node.z).normalize()
    }

    const nodeTangents = new Array<THREE.Vector3>(nodes.length)
    for (let i = 0; i < nodeNormals.length; i += 1) {
      const normal = nodeNormals[i]
      snakeContactFallbackTemp.set(0, 0, 0)
      if (i + 1 < nodeNormals.length) {
        snakeContactFallbackTemp.add(nodeNormals[i + 1]).addScaledVector(normal, -1)
      }
      if (i > 0) {
        snakeContactFallbackTemp.add(normal).addScaledVector(nodeNormals[i - 1], -1)
      }
      snakeContactFallbackTemp.addScaledVector(normal, -snakeContactFallbackTemp.dot(normal))
      if (snakeContactFallbackTemp.lengthSq() <= 1e-8) {
        buildTangentBasis(normal, snakeContactFallbackTemp, snakeContactOffsetTemp)
      } else {
        snakeContactFallbackTemp.normalize()
      }
      nodeTangents[i] = snakeContactFallbackTemp.clone()
    }

    const nodeRadii = new Array<number>(nodes.length)
    for (let i = 0; i < nodeNormals.length; i += 1) {
      const normal = nodeNormals[i]
      const tangent = nodeTangents[i]
      let nodeRadius = getSnakeCenterlineRadius(normal, radiusOffset, snakeRadius)
      nodeRadius += applySnakeContactLift(
        normal,
        tangent,
        nodeRadius,
        snakeRadius,
        groundingInfo,
      )
      nodeRadii[i] = nodeRadius
    }

    let prevNormal: THREE.Vector3 | null = null
    let prevTangent: THREE.Vector3 | null = null
    let prevRadius = nodeRadii[0] ?? PLANET_RADIUS + radiusOffset

    for (let i = 0; i < nodes.length; i += 1) {
      const normal = nodeNormals[i]
      const tangent = nodeTangents[i]
      const nodeRadius = nodeRadii[i]
      if (
        prevNormal &&
        prevTangent &&
        i > 1 &&
        i < nodes.length - 1 &&
        Math.abs(nodeRadius - prevRadius) >= SNAKE_SLOPE_INSERT_RADIUS_DELTA
      ) {
        const midpointNormal = prevNormal.clone().add(normal)
        if (midpointNormal.lengthSq() > 1e-8) {
          midpointNormal.normalize()
        } else {
          midpointNormal.copy(normal)
        }
        snakeContactFallbackTemp.copy(prevTangent).add(tangent)
        snakeContactFallbackTemp.addScaledVector(
          midpointNormal,
          -snakeContactFallbackTemp.dot(midpointNormal),
        )
        if (snakeContactFallbackTemp.lengthSq() <= 1e-8) {
          buildTangentBasis(midpointNormal, snakeContactFallbackTemp, snakeContactOffsetTemp)
        } else {
          snakeContactFallbackTemp.normalize()
        }
        let midpointRadius = getSnakeCenterlineRadius(
          midpointNormal,
          radiusOffset,
          snakeRadius,
        )
        midpointRadius += applySnakeContactLift(
          midpointNormal,
          snakeContactFallbackTemp,
          midpointRadius,
          snakeRadius,
          groundingInfo,
        )
        curvePoints.push(midpointNormal.multiplyScalar(midpointRadius))
      }

      curvePoints.push(normal.clone().multiplyScalar(nodeRadius))
      prevNormal = normal
      prevTangent = tangent
      prevRadius = nodeRadius
    }

    return curvePoints
  }

  const buildTailCapGeometry = (
    tubeGeometry: THREE.TubeGeometry,
    tailDirection: THREE.Vector3,
  ): THREE.BufferGeometry | null => {
    const params = tubeGeometry.parameters as { radialSegments?: number; tubularSegments?: number }
    const radialSegments = params.radialSegments ?? 8
    const tubularSegments = params.tubularSegments ?? 1
    const ringVertexCount = radialSegments + 1
    const ringStart = tubularSegments * ringVertexCount
    const positions = tubeGeometry.attributes.position
    if (!positions || positions.count < ringStart + radialSegments) return null

    const ringPoints: THREE.Vector3[] = []
    const ringVectors: THREE.Vector3[] = []
    const center = new THREE.Vector3()

    for (let i = 0; i < radialSegments; i += 1) {
      const index = ringStart + i
      const point = new THREE.Vector3(
        positions.getX(index),
        positions.getY(index),
        positions.getZ(index),
      )
      ringPoints.push(point)
      center.add(point)
    }

    if (ringPoints.length === 0) return null
    center.multiplyScalar(1 / ringPoints.length)

    let radius = 0
    for (const point of ringPoints) {
      const vector = point.clone().sub(center)
      ringVectors.push(vector)
      radius += vector.length()
    }
    radius = radius / ringVectors.length
    if (!Number.isFinite(radius) || radius <= 0) return null

    const ringNormal = ringVectors[1 % radialSegments].clone().cross(ringVectors[0])
    if (ringNormal.lengthSq() < 1e-8) return null
    ringNormal.normalize()
    const tailDirNorm = tailDirection.clone().normalize()
    const flip = ringNormal.dot(tailDirNorm) < 0
    const capDir = flip ? ringNormal.clone().negate() : ringNormal.clone()

    const rings = Math.max(2, TAIL_CAP_SEGMENTS)
    const vertexCount = rings * radialSegments + 1
    const capPositions = new Float32Array(vertexCount * 3)

    for (let s = 0; s < rings; s += 1) {
      const theta = (s / rings) * (Math.PI / 2)
      const scale = Math.cos(theta)
      const offset = Math.sin(theta) * radius
      for (let i = 0; i < radialSegments; i += 1) {
        const vector = ringVectors[i]
        const point = center
          .clone()
          .addScaledVector(vector, scale)
          .addScaledVector(capDir, offset)
        const index = (s * radialSegments + i) * 3
        capPositions[index] = point.x
        capPositions[index + 1] = point.y
        capPositions[index + 2] = point.z
      }
    }

    const tip = center.clone().addScaledVector(capDir, radius)
    const tipOffset = rings * radialSegments * 3
    capPositions[tipOffset] = tip.x
    capPositions[tipOffset + 1] = tip.y
    capPositions[tipOffset + 2] = tip.z

    const indices: number[] = []
    const pushTri = (a: number, b: number, c: number) => {
      if (flip) {
        indices.push(a, c, b)
      } else {
        indices.push(a, b, c)
      }
    }

    for (let s = 0; s < rings - 1; s += 1) {
      for (let i = 0; i < radialSegments; i += 1) {
        const next = (i + 1) % radialSegments
        const a = s * radialSegments + i
        const b = s * radialSegments + next
        const c = (s + 1) * radialSegments + i
        const d = (s + 1) * radialSegments + next
        pushTri(a, c, b)
        pushTri(b, c, d)
      }
    }

    const tipIndex = rings * radialSegments
    const lastRingStart = (rings - 1) * radialSegments
    for (let i = 0; i < radialSegments; i += 1) {
      const next = (i + 1) % radialSegments
      const a = lastRingStart + i
      const b = lastRingStart + next
      pushTri(a, tipIndex, b)
    }

    const capGeometry = new THREE.BufferGeometry()
    capGeometry.setAttribute('position', new THREE.BufferAttribute(capPositions, 3))
    capGeometry.setIndex(indices)
    capGeometry.computeVertexNormals()
    capGeometry.computeBoundingSphere()
    return capGeometry
  }

  const applyDigestionBulges = (tubeGeometry: THREE.TubeGeometry, digestions: DigestionVisual[]) => {
    if (!digestions.length) return
    const params = tubeGeometry.parameters as { radialSegments?: number; tubularSegments?: number }
    const radialSegments = params.radialSegments ?? 8
    const tubularSegments = params.tubularSegments ?? 1
    const ringVertexCount = radialSegments + 1
    const ringCount = tubularSegments + 1
    const positions = tubeGeometry.attributes.position
    if (!positions) return

    const bulgeByRing = new Array<number>(ringCount).fill(0)
    const startOffset = Math.min(
      DIGESTION_START_MAX,
      DIGESTION_START_RINGS / Math.max(1, ringCount - 1),
    )
    const endOffset = startOffset
    for (const digestion of digestions) {
      const strength = clamp(digestion.strength, 0, 1)
      if (strength <= 0) continue
      const influenceRadius = THREE.MathUtils.lerp(DIGESTION_WIDTH_MIN, DIGESTION_WIDTH_MAX, strength)
      const bulgeStrength = THREE.MathUtils.lerp(DIGESTION_BULGE_MIN, DIGESTION_BULGE_MAX, strength)
      const t = clamp(digestion.t, 0, 1)
      const mapped = startOffset + t * Math.max(0, 1 - startOffset - endOffset)
      const center = mapped * (ringCount - 1)
      const start = Math.max(0, Math.floor(center - influenceRadius))
      const end = Math.min(ringCount - 1, Math.ceil(center + influenceRadius))
      const sigma = Math.max(0.5, influenceRadius * 0.7)
      const tailFade = smoothstep(0, 0.016, 1 - mapped)
      const headFade = smoothstep(0, 0.012, mapped)
      const travelFade = Math.min(headFade, tailFade)
      if (travelFade <= 0) continue
      for (let ring = start; ring <= end; ring += 1) {
        const dist = ring - center
        const normalized = dist / sigma
        const weight = Math.exp(-0.5 * normalized * normalized)
        bulgeByRing[ring] += weight * bulgeStrength * travelFade
      }
    }
    for (let pass = 0; pass < 2; pass += 1) {
      const source = bulgeByRing.slice()
      for (let ring = 0; ring < ringCount; ring += 1) {
        const prev = source[Math.max(0, ring - 1)]
        const current = source[ring]
        const next = source[Math.min(ringCount - 1, ring + 1)]
        bulgeByRing[ring] = prev * 0.22 + current * 0.56 + next * 0.22
      }
    }
    for (let ring = 0; ring < ringCount; ring += 1) {
      const distanceToEdge = Math.min(ring, ringCount - 1 - ring)
      const edgeClamp = smoothstep(0, 1.35, distanceToEdge)
      const maxRingBulge = THREE.MathUtils.lerp(
        DIGESTION_MAX_BULGE_MIN,
        DIGESTION_MAX_BULGE_MAX,
        edgeClamp,
      )
      bulgeByRing[ring] = Math.min(maxRingBulge, bulgeByRing[ring])
    }

    const center = new THREE.Vector3()
    const vertex = new THREE.Vector3()
    for (let ring = 0; ring < ringCount; ring += 1) {
      const bulge = bulgeByRing[ring]
      if (bulge <= 0) continue
      center.set(0, 0, 0)
      const ringStart = ring * ringVertexCount
      for (let i = 0; i < radialSegments; i += 1) {
        const index = ringStart + i
        center.x += positions.getX(index)
        center.y += positions.getY(index)
        center.z += positions.getZ(index)
      }
      center.multiplyScalar(1 / radialSegments)

      const scale = 1 + bulge
      for (let i = 0; i < ringVertexCount; i += 1) {
        const index = ringStart + i
        vertex.set(positions.getX(index), positions.getY(index), positions.getZ(index))
        vertex.sub(center).multiplyScalar(scale).add(center)
        positions.setXYZ(index, vertex.x, vertex.y, vertex.z)
      }
    }

    positions.needsUpdate = true
    tubeGeometry.computeVertexNormals()
  }

  const buildDigestionVisuals = (digestions: DigestionSnapshot[]) => {
    const visuals: DigestionVisual[] = []
    let tailGrowth = 0

    for (const digestion of digestions) {
      const travelT = clamp(digestion.progress, 0, 1)
      const travelBiased = Math.pow(travelT, DIGESTION_TRAVEL_EASE)
      const growth = clamp(digestion.progress - 1, 0, 1)
      const strength = clamp(digestion.strength, 0.05, 1) * (1 - growth)
      visuals.push({ t: travelBiased, strength })
      if (growth > tailGrowth) tailGrowth = growth
    }

    return { visuals, tailGrowth }
  }


  const computeTailDirection = (
    curvePoints: THREE.Vector3[],
    tailBasisPrev?: THREE.Vector3 | null,
    tailBasisTail?: THREE.Vector3 | null,
    fallbackDirection?: THREE.Vector3 | null,
    overrides?: {
      tailPos?: THREE.Vector3
      prevPos?: THREE.Vector3
      preferFallbackBelow?: number
    },
  ) => {
    if (curvePoints.length < 2) return null
    const tailPos = overrides?.tailPos ?? curvePoints[curvePoints.length - 1]
    const prevPos = overrides?.prevPos ?? curvePoints[curvePoints.length - 2]
    const preferFallbackBelow = overrides?.preferFallbackBelow ?? 0
    const tailNormal = tailPos.clone().normalize()

    const projectToTangent = (dir: THREE.Vector3) => {
      dir.addScaledVector(tailNormal, -dir.dot(tailNormal))
      return dir
    }

    const lastSegmentDir = projectToTangent(tailPos.clone().sub(prevPos))
    const lastSegmentLen = lastSegmentDir.length()
    const hasLastSegment = lastSegmentLen > 1e-8
    const lastSegmentUnit = hasLastSegment
      ? lastSegmentDir.multiplyScalar(1 / lastSegmentLen)
      : null

    let fallbackDir: THREE.Vector3 | null = null
    if (tailBasisPrev && tailBasisTail) {
      const basisDir = projectToTangent(tailBasisTail.clone().sub(tailBasisPrev))
      if (basisDir.lengthSq() > 1e-8) {
        fallbackDir = basisDir.normalize()
      }
    }

    if (!fallbackDir && fallbackDirection) {
      const providedDir = projectToTangent(fallbackDirection.clone())
      if (providedDir.lengthSq() > 1e-8) {
        fallbackDir = providedDir.normalize()
      }
    }

    if (lastSegmentUnit && fallbackDir && preferFallbackBelow > 0) {
      const blendStart = preferFallbackBelow
      const blendEnd = preferFallbackBelow * 1.5
      if (lastSegmentLen <= blendStart) {
        return fallbackDir
      }
      if (lastSegmentLen >= blendEnd) {
        return lastSegmentUnit
      }
      const t = clamp((lastSegmentLen - blendStart) / (blendEnd - blendStart), 0, 1)
      return fallbackDir.clone().lerp(lastSegmentUnit, t).normalize()
    }

    if (lastSegmentUnit) {
      return lastSegmentUnit
    }

    return fallbackDir
  }

  const computeExtendedTailPoint = (
    curvePoints: THREE.Vector3[],
    extendDistance: number,
    tailBasisPrev?: THREE.Vector3 | null,
    tailBasisTail?: THREE.Vector3 | null,
    fallbackDirection?: THREE.Vector3 | null,
    preferFallbackBelow?: number,
    overrideDirection?: THREE.Vector3 | null,
  ) => {
    if (extendDistance <= 0 || curvePoints.length < 2) return null
    const tailPos = curvePoints[curvePoints.length - 1]
    const tailRadius = tailPos.length()
    if (!Number.isFinite(tailRadius) || tailRadius <= 1e-6) return null
    const tailNormal = tailPos.clone().normalize()
    let tailDir = overrideDirection
      ? overrideDirection.clone()
      : computeTailDirection(
          curvePoints,
          tailBasisPrev,
          tailBasisTail,
          fallbackDirection,
          { preferFallbackBelow },
        )
    if (tailDir) {
      tailDir.addScaledVector(tailNormal, -tailDir.dot(tailNormal))
      if (tailDir.lengthSq() > 1e-8) {
        tailDir.normalize()
      } else {
        tailDir = null
      }
    }
    if (!tailDir) return null

    const axis = tailNormal.clone().cross(tailDir)
    const angle = extendDistance / tailRadius
    let extended: THREE.Vector3
    if (axis.lengthSq() < 1e-8 || !Number.isFinite(angle)) {
      extended = tailPos
        .clone()
        .addScaledVector(tailDir, extendDistance)
        .normalize()
        .multiplyScalar(tailRadius)
    } else {
      axis.normalize()
      extended = tailPos
        .clone()
        .applyAxisAngle(axis, angle)
        .normalize()
        .multiplyScalar(tailRadius)
    }
    return extended
  }

  const computeTailExtendDirection = (
    curvePoints: THREE.Vector3[],
    preferFallbackBelow: number,
  ) => {
    if (curvePoints.length < 2) return null
    const tailPos = curvePoints[curvePoints.length - 1]
    const prevPos = curvePoints[curvePoints.length - 2]
    const tailNormal = tailPos.clone().normalize()

    const projectToTangent = (dir: THREE.Vector3) => {
      dir.addScaledVector(tailNormal, -dir.dot(tailNormal))
      return dir
    }

    const lastDir = projectToTangent(tailPos.clone().sub(prevPos))
    const lastLen = lastDir.length()

    let prevDir: THREE.Vector3 | null = null
    let prevLen = 0
    if (curvePoints.length >= 3) {
      const prevPrev = curvePoints[curvePoints.length - 3]
      prevDir = projectToTangent(prevPos.clone().sub(prevPrev))
      prevLen = prevDir.length()
    }

    if (lastLen < preferFallbackBelow && prevDir && prevLen > 1e-8) {
      return prevDir.multiplyScalar(1 / prevLen)
    }

    if (lastLen > 1e-8 && prevDir && prevLen > 1e-8) {
      lastDir.multiplyScalar(1 / lastLen)
      prevDir.multiplyScalar(1 / prevLen)
      if (prevDir.dot(lastDir) < 0) {
        prevDir.multiplyScalar(-1)
      }
      return prevDir.lerp(lastDir, TAIL_EXTEND_CURVE_BLEND).normalize()
    }

    if (lastLen > 1e-8) {
      return lastDir.multiplyScalar(1 / lastLen)
    }

    if (prevDir && prevLen > 1e-8) {
      return prevDir.multiplyScalar(1 / prevLen)
    }

    return null
  }

  const getPelletTerrainRadius = (pellet: PelletSnapshot) => {
    const nx = pellet.x
    const ny = pellet.y
    const nz = pellet.z
    const cached = pelletGroundCache.get(pellet.id)
    if (cached) {
      const dx = cached.x - nx
      const dy = cached.y - ny
      const dz = cached.z - nz
      if (dx * dx + dy * dy + dz * dz <= PELLET_GROUND_CACHE_NORMAL_EPS) {
        return cached.radius
      }
    }
    tempVectorE.set(nx, ny, nz)
    if (tempVectorE.lengthSq() <= 1e-8) {
      tempVectorE.set(0, 0, 1)
    } else {
      tempVectorE.normalize()
    }
    const radius = getTerrainRadius(tempVectorE)
    pelletGroundCache.set(pellet.id, {
      x: tempVectorE.x,
      y: tempVectorE.y,
      z: tempVectorE.z,
      radius,
    })
    return radius
  }

  const getPelletSurfacePosition = (pellet: PelletSnapshot, out: THREE.Vector3) => {
    const radius = getPelletTerrainRadius(pellet)
    out.set(pellet.x, pellet.y, pellet.z)
    if (out.lengthSq() <= 1e-8) {
      out.set(0, 0, 1)
    } else {
      out.normalize()
    }
    out.multiplyScalar(radius + PELLET_OFFSET)
    return out
  }

  const updateTongue = (
    playerId: string,
    visual: SnakeVisual,
    headPosition: THREE.Vector3,
    headNormal: THREE.Vector3,
    forward: THREE.Vector3,
    pellets: PelletSnapshot[] | null,
    deltaSeconds: number,
  ): PelletOverride | null => {
    let state = tongueStates.get(playerId)
    if (!state) {
      state = { length: 0, mode: 'idle', targetPosition: null, carrying: false }
      tongueStates.set(playerId, state)
    }

    const mouthPosition = tempVectorD
      .copy(headPosition)
      .addScaledVector(forward, TONGUE_MOUTH_FORWARD)
      .addScaledVector(headNormal, TONGUE_MOUTH_OUT)

    let desiredLength = 0
    let candidatePosition: THREE.Vector3 | null = null
    let candidateDistance = Infinity
    let hasCandidate = false
    let matchedPelletId: number | null = null
    let matchedPosition: THREE.Vector3 | null = null

    if (!pellets || pellets.length === 0) {
      if (state.mode !== 'idle') {
        state.mode = 'retract'
        state.carrying = false
        state.targetPosition = null
      }
    } else {
      if (state.targetPosition) {
        let bestDistanceSq = Infinity
        let bestPelletId: number | null = null
        let bestPosition: THREE.Vector3 | null = null
        for (let i = 0; i < pellets.length; i += 1) {
          const pellet = pellets[i]
          getPelletSurfacePosition(pellet, tempVectorE)
          const distSq = tempVectorE.distanceToSquared(state.targetPosition)
          if (distSq < bestDistanceSq) {
            bestDistanceSq = distSq
            bestPelletId = pellet.id
            bestPosition = tempVectorE.clone()
          }
        }
        const matchThresholdSq = TONGUE_PELLET_MATCH * TONGUE_PELLET_MATCH
        if (bestPelletId !== null && bestPosition && bestDistanceSq <= matchThresholdSq) {
          matchedPelletId = bestPelletId
          matchedPosition = bestPosition
          state.targetPosition.copy(bestPosition)
        } else if (state.mode === 'retract') {
          state.carrying = false
          state.targetPosition = null
        } else if (state.mode === 'extend') {
          state.mode = 'retract'
          state.carrying = false
          state.targetPosition = null
        }
      }

      if (state.mode === 'extend' && state.targetPosition) {
        tempVectorF.copy(state.targetPosition).sub(mouthPosition)
        const distance = tempVectorF.length()
        tempVectorG.copy(tempVectorF).addScaledVector(headNormal, -tempVectorF.dot(headNormal))
        const tangentLen = tempVectorG.length()
        if (tangentLen > 1e-6) {
          tempVectorG.multiplyScalar(1 / tangentLen)
        }
        const angle = tangentLen > 1e-6 ? Math.acos(clamp(forward.dot(tempVectorG), -1, 1)) : Math.PI
        if (distance <= TONGUE_NEAR_RANGE && angle <= TONGUE_ANGLE_LIMIT) {
          candidatePosition = state.targetPosition
          candidateDistance = distance
          desiredLength = Math.min(distance, TONGUE_MAX_LENGTH)
          hasCandidate = true
        } else {
          state.mode = 'retract'
          state.carrying = false
          state.targetPosition = null
        }
      }

      if (!hasCandidate && state.mode === 'idle') {
        for (let i = 0; i < pellets.length; i += 1) {
          const pellet = pellets[i]
          getPelletSurfacePosition(pellet, tempVectorE)
          tempVectorF.copy(tempVectorE).sub(mouthPosition)
          const distance = tempVectorF.length()
          tempVectorG.copy(tempVectorF).addScaledVector(headNormal, -tempVectorF.dot(headNormal))
          const tangentLen = tempVectorG.length()
          if (tangentLen < 1e-6) continue
          tempVectorG.multiplyScalar(1 / tangentLen)
          const angle = Math.acos(clamp(forward.dot(tempVectorG), -1, 1))
          if (angle > TONGUE_ANGLE_LIMIT) continue
          if (distance > TONGUE_MAX_RANGE) continue
          if (distance > TONGUE_NEAR_RANGE) continue
          if (distance < candidateDistance) {
            candidateDistance = distance
            candidatePosition = tempVectorE.clone()
          }
        }
      }

      if (candidatePosition) {
        desiredLength = Math.min(candidateDistance, TONGUE_MAX_LENGTH)
        state.targetPosition = candidatePosition
        state.mode = 'extend'
        state.carrying = false
        hasCandidate = true
      } else if (state.mode === 'extend') {
        state.mode = 'retract'
        state.carrying = false
      }
    }

    const targetLength = state.mode === 'extend' && hasCandidate ? desiredLength : 0
    state.length = smoothValue(
      state.length,
      targetLength,
      deltaSeconds,
      TONGUE_EXTEND_RATE,
      TONGUE_RETRACT_RATE,
    )

    if (state.mode === 'extend' && hasCandidate && state.length >= desiredLength - TONGUE_GRAB_EPS) {
      state.mode = 'retract'
      state.carrying = matchedPelletId !== null && matchedPosition !== null
      if (!state.carrying) {
        state.targetPosition = null
      }
    }

    if (state.mode === 'retract' && state.length <= TONGUE_HIDE_THRESHOLD) {
      if (!state.carrying) {
        state.mode = 'idle'
        state.targetPosition = null
        state.carrying = false
      }
    }

    let override: PelletOverride | null = null
    let targetPosition = state.targetPosition

    if (state.mode === 'retract' && state.carrying && targetPosition && pellets && pellets.length > 0) {
      if (matchedPelletId !== null && matchedPosition) {
        if (state.targetPosition) {
          state.targetPosition.copy(matchedPosition)
        } else {
          state.targetPosition = matchedPosition
        }
        targetPosition = state.targetPosition
        tempVectorF.copy(targetPosition).sub(mouthPosition)
        if (tempVectorF.lengthSq() > 1e-6) {
          tempVectorF.normalize()
        } else {
          tempVectorF.copy(forward)
        }
        const grabbedPos = mouthPosition.clone().addScaledVector(tempVectorF, state.length)
        override = { id: matchedPelletId, position: grabbedPos }
      } else {
        state.carrying = false
        state.targetPosition = null
      }
    }

    const isVisible = state.length > TONGUE_HIDE_THRESHOLD
    visual.tongue.visible = isVisible
    if (!isVisible) {
      return override
    }

    let tongueDir = forward
    if (targetPosition) {
      tempVectorF.copy(targetPosition).sub(mouthPosition)
      if (tempVectorF.lengthSq() > 1e-6) {
        tempVectorF.normalize()
        tongueDir = tempVectorF
      }
    }

    visual.tongue.position.copy(mouthPosition)
    tempQuat.setFromUnitVectors(tongueUp, tongueDir)
    visual.tongue.quaternion.copy(tempQuat)

    const tongueLength = Math.max(state.length, 0.001)
    visual.tongueBase.scale.set(1, tongueLength, 1)
    const forkLength = Math.min(TONGUE_FORK_LENGTH, tongueLength * 0.6)
    visual.tongueForkLeft.scale.set(1, forkLength, 1)
    visual.tongueForkRight.scale.set(1, forkLength, 1)
    visual.tongueForkLeft.position.set(0, tongueLength, 0)
    visual.tongueForkRight.position.set(0, tongueLength, 0)

    return override
  }


  const updateSnake = (
    player: PlayerSnapshot,
    isLocal: boolean,
    deltaSeconds: number,
    pellets: PelletSnapshot[] | null,
  ): PelletOverride | null => {
    let visual = snakes.get(player.id)
    if (!visual) {
      visual = createSnakeVisual(player.color)
      snakes.set(player.id, visual)
      snakesGroup.add(visual.group)
    }

    if (visual.color !== player.color) {
      visual.color = player.color
    }
    const groundingInfo = isLocal ? createGroundingInfo() : null

    const wasAlive = lastAliveStates.get(player.id)
    if (wasAlive === undefined || wasAlive !== player.alive) {
      if (!player.alive) {
        deathStates.set(player.id, { start: performance.now() })
      } else {
        deathStates.delete(player.id)
        resetSnakeTransientState(player.id)
      }
      lastAliveStates.set(player.id, player.alive)
    }

    let opacity = 1
    if (!player.alive) {
      const deathState = deathStates.get(player.id)
      const start = deathState?.start ?? performance.now()
      const elapsed = (performance.now() - start) / 1000
      const t = clamp(elapsed / DEATH_FADE_DURATION, 0, 1)
      opacity = DEATH_START_OPACITY * (1 - t)
    }

    visual.group.visible = opacity > DEATH_VISIBILITY_CUTOFF

    updateSnakeMaterial(visual.tube.material, visual.color, isLocal, opacity)
    updateSnakeMaterial(visual.head.material, visual.color, isLocal, opacity)
    updateSnakeMaterial(visual.tail.material, visual.color, isLocal, opacity)
    updateSnakeMaterial(visual.eyeLeft.material, '#ffffff', false, opacity, 0)
    updateSnakeMaterial(visual.eyeRight.material, '#ffffff', false, opacity, 0)
    updateSnakeMaterial(visual.pupilLeft.material, '#1b1b1b', false, opacity, 0)
    updateSnakeMaterial(visual.pupilRight.material, '#1b1b1b', false, opacity, 0)
    updateSnakeMaterial(visual.tongueBase.material, '#ff6f9f', false, opacity, 0.3)
    updateSnakeMaterial(visual.tongueForkLeft.material, '#ff6f9f', false, opacity, 0.3)
    updateSnakeMaterial(visual.tongueForkRight.material, '#ff6f9f', false, opacity, 0.3)

    const previousSnakeStart = lastSnakeStarts.get(player.id)
    if (previousSnakeStart !== undefined && previousSnakeStart !== player.snakeStart) {
      resetSnakeTransientState(player.id)
    }
    lastSnakeStarts.set(player.id, player.snakeStart)

    if (player.snakeDetail === 'stub') {
      if (isLocal) {
        localGroundingInfo = null
      }
      resetSnakeTransientState(player.id)
      visual.tube.visible = false
      visual.tail.visible = false
      visual.head.visible = false
      visual.eyeLeft.visible = false
      visual.eyeRight.visible = false
      visual.pupilLeft.visible = false
      visual.pupilRight.visible = false
      visual.tongue.visible = false
      visual.bowl.visible = false
      return null
    }

    const nodes = player.snake
    const debug = isTailDebugEnabled() && isLocal
    const maxDigestion =
      player.digestions.length > 0
        ? Math.max(...player.digestions.map((digestion) => digestion.progress))
        : 0
    const lastTailDirection = lastTailDirections.get(player.id) ?? null
    let lengthIncreased = false
    const prevLength = lastSnakeLengths.get(player.id)
    if (prevLength !== undefined) {
      if (nodes.length > prevLength && nodes.length >= 2) {
        lengthIncreased = true
        tailAddStates.set(player.id, {
          progress: 0,
          duration: Math.max(0.05, TAIL_ADD_SMOOTH_MS / 1000),
          carryDistance: lastTailTotalLengths.get(player.id) ?? 0,
          carryExtra: lastTailExtensionDistances.get(player.id) ?? 0,
          startPos: null,
        })
        if (debug) {
          console.log(
            `[TAIL_DEBUG] ${player.id} length_increase ${prevLength} -> ${nodes.length} max_digestion=${maxDigestion.toFixed(
              3,
            )}`,
          )
        }
      } else if (nodes.length < prevLength) {
        tailAddStates.delete(player.id)
        tailGrowthStates.delete(player.id)
        if (debug) {
          console.log(
            `[TAIL_DEBUG] ${player.id} length_decrease ${prevLength} -> ${nodes.length}`,
          )
        }
      }
    }
    lastSnakeLengths.set(player.id, nodes.length)
    const digestionState = buildDigestionVisuals(player.digestions)
    const targetTailGrowth = digestionState.tailGrowth
    const previousGrowth = tailGrowthStates.get(player.id)
    let smoothedTailGrowth = targetTailGrowth
    if (previousGrowth !== undefined && targetTailGrowth < previousGrowth) {
      smoothedTailGrowth = smoothValue(
        previousGrowth,
        targetTailGrowth,
        deltaSeconds,
        TAIL_GROWTH_RATE_UP,
        TAIL_GROWTH_RATE_DOWN,
      )
    }
    if (targetTailGrowth > 0) {
      smoothedTailGrowth = Math.max(previousGrowth ?? 0, smoothedTailGrowth)
    }
    tailGrowthStates.set(player.id, smoothedTailGrowth)
    const radius = isLocal ? SNAKE_RADIUS * 1.1 : SNAKE_RADIUS
    const radiusOffset = radius * SNAKE_LIFT_FACTOR
    let headCurvePoint: THREE.Vector3 | null = null
    let secondCurvePoint: THREE.Vector3 | null = null
    let tailCurveTail: THREE.Vector3 | null = null
    let tailCurvePrev: THREE.Vector3 | null = null
    let tailExtendDistance = 0
    let tailAddProgress = 0
    let tailBasisPrev: THREE.Vector3 | null = null
    let tailBasisTail: THREE.Vector3 | null = null
    let tailSegmentLength = 0
    let tailSegmentDir: THREE.Vector3 | null = null
    let tailDirMinLen = 0
    let tailExtraTarget = 0
    let tailExtensionDistance = 0
    let tailDirDebug: THREE.Vector3 | null = null
    let tailSegDirDebug: THREE.Vector3 | null = null
    let tailDirAngle = 0
    let tailExtendOverride: THREE.Vector3 | null = null
    if (nodes.length < 2) {
      visual.tube.visible = false
      visual.tail.visible = false
    } else {
      visual.tube.visible = true
      visual.tail.visible = true
      const curvePoints = buildSnakeCurvePoints(
        nodes,
        radiusOffset,
        radius,
        groundingInfo,
      )
      headCurvePoint = curvePoints[0]?.clone() ?? null
      secondCurvePoint = curvePoints[1]?.clone() ?? null
      const tailAddState = tailAddStates.get(player.id)
      if (tailAddState && curvePoints.length >= 2) {
        tailAddState.progress = clamp(
          tailAddState.progress + deltaSeconds / tailAddState.duration,
          0,
          1,
        )
        tailAddProgress = tailAddState.progress
        const fallbackStart = curvePoints[curvePoints.length - 2]
        const end = curvePoints[curvePoints.length - 1]
        let referenceDir: THREE.Vector3 | null = null
        let referenceDistance = fallbackStart.distanceTo(end)
        if (curvePoints.length >= 3) {
          const prev = curvePoints[curvePoints.length - 3]
          const startNormal = fallbackStart.clone().normalize()
          const rawDir = fallbackStart.clone().sub(prev)
          rawDir.addScaledVector(startNormal, -rawDir.dot(startNormal))
          if (rawDir.lengthSq() > 1e-8) {
            referenceDistance = rawDir.length()
            referenceDir = rawDir.multiplyScalar(1 / referenceDistance)
          }
        }
        if (!tailAddState.startPos) {
          tailAddState.startPos = fallbackStart.clone()
        }
        let start = tailAddState.startPos
        if (!start) {
          start = end
        }
        const startRadius = start.length()
        if (startRadius > 1e-6) {
          start = start.clone().normalize().multiplyScalar(startRadius)
        } else {
          start = end
        }

        let blendedEnd = end
        if (referenceDir && referenceDistance > 1e-6) {
          const syntheticEnd = advanceOnSphere(
            start,
            referenceDir,
            referenceDistance,
            Math.max(start.length(), 1e-6),
          )
          const alignBlend = clamp((tailAddState.progress - 0.35) / 0.35, 0, 1)
          blendedEnd = slerpProjectedPoint(syntheticEnd, end, alignBlend)
        }

        curvePoints[curvePoints.length - 1] = slerpProjectedPoint(
          start,
          blendedEnd,
          tailAddState.progress,
        )
        if (tailAddState.progress >= 1) {
          tailAddStates.delete(player.id)
        }
        if (curvePoints.length >= 3) {
          tailBasisPrev = curvePoints[curvePoints.length - 3]
          tailBasisTail = curvePoints[curvePoints.length - 2]
          if (tailBasisPrev.distanceToSquared(tailBasisTail) < 1e-6) {
            tailBasisPrev = null
            tailBasisTail = null
          }
        }
      }
      if (curvePoints.length >= 2) {
        const tailPos = curvePoints[curvePoints.length - 1]
        const prevPos = curvePoints[curvePoints.length - 2]
        tailSegmentLength = tailPos.distanceTo(prevPos)
        const tailNormal = tailPos.clone().normalize()
        const segmentDir = tailPos.clone().sub(prevPos)
        segmentDir.addScaledVector(tailNormal, -segmentDir.dot(tailNormal))
        if (segmentDir.lengthSq() > 1e-8) {
          tailSegmentDir = segmentDir.normalize()
        }
      }
      const referenceLength =
        tailBasisPrev && tailBasisTail
          ? tailBasisTail.distanceTo(tailBasisPrev)
          : tailSegmentLength
      tailDirMinLen = Number.isFinite(referenceLength)
        ? Math.max(0, referenceLength * TAIL_DIR_MIN_RATIO)
        : 0
      const baseLength = tailSegmentLength
      const easedGrowth = Math.pow(clamp(smoothedTailGrowth, 0, 1), TAIL_GROWTH_EASE)
      const growthExtra = referenceLength * easedGrowth
      let extraLengthTarget = growthExtra
      let minExtraLength = 0
      if (tailAddState) {
        const carryDistance = Number.isFinite(tailAddState.carryDistance)
          ? tailAddState.carryDistance
          : lastTailTotalLengths.get(player.id) ?? baseLength
        tailAddState.carryDistance = carryDistance
        minExtraLength = Math.max(0, carryDistance - baseLength)
        extraLengthTarget = minExtraLength + growthExtra
      }
      const extraTargetClamped = Math.max(0, extraLengthTarget)
      let extensionDistance = extraTargetClamped
      const previousExtension = lastTailExtensionDistances.get(player.id)
      const seedOverride = lengthIncreased ? extraTargetClamped : null
      const extraState = tailExtraStates.get(player.id)
      if (extraState) {
        const seed = seedOverride ?? previousExtension ?? extraState.value ?? extraTargetClamped
        extraState.value = seed
        const rateUp = tailAddState ? TAIL_EXTEND_RATE_UP_ADD : TAIL_EXTEND_RATE_UP
        const rateDown = tailAddState ? TAIL_EXTEND_RATE_DOWN_ADD : TAIL_EXTEND_RATE_DOWN
        extensionDistance = smoothValue(
          extraState.value,
          extraTargetClamped,
          deltaSeconds,
          rateUp,
          rateDown,
        )
        if (!Number.isFinite(extensionDistance)) {
          extensionDistance = extraTargetClamped
        }
        extraState.value = extensionDistance
      } else {
        const seed = seedOverride ?? previousExtension ?? extraTargetClamped
        const rateUp = tailAddState ? TAIL_EXTEND_RATE_UP_ADD : TAIL_EXTEND_RATE_UP
        const rateDown = tailAddState ? TAIL_EXTEND_RATE_DOWN_ADD : TAIL_EXTEND_RATE_DOWN
        extensionDistance = smoothValue(seed, extraTargetClamped, deltaSeconds, rateUp, rateDown)
        if (!Number.isFinite(extensionDistance)) {
          extensionDistance = extraTargetClamped
        }
        tailExtraStates.set(player.id, { value: extensionDistance })
      }
      if (tailAddState) {
        extensionDistance = Math.min(extensionDistance, extraTargetClamped)
        extensionDistance = Math.max(extensionDistance, minExtraLength)
        const clampState = tailExtraStates.get(player.id)
        if (clampState) {
          clampState.value = extensionDistance
        }
      }
      const prevExtension = lastTailExtensionDistances.get(player.id)
      if (prevExtension !== undefined) {
        const maxGrow =
          (tailAddState ? TAIL_EXTEND_MAX_GROW_SPEED_ADD : TAIL_EXTEND_MAX_GROW_SPEED) *
          deltaSeconds
        const maxShrink =
          (tailAddState
            ? TAIL_EXTEND_MAX_SHRINK_SPEED_ADD
            : TAIL_EXTEND_MAX_SHRINK_SPEED) * deltaSeconds
        extensionDistance = clamp(
          extensionDistance,
          prevExtension - maxShrink,
          prevExtension + maxGrow,
        )
        const limitedState = tailExtraStates.get(player.id)
        if (limitedState) {
          limitedState.value = extensionDistance
        }
      }
      extensionDistance = Math.min(extensionDistance, extraTargetClamped)
      if (seedOverride !== null) {
        lastTailExtensionDistances.set(player.id, extensionDistance)
      }
      tailExtraTarget = extraTargetClamped
      tailExtensionDistance = extensionDistance
      lastTailExtensionDistances.set(player.id, extensionDistance)
      const extendDir = computeTailExtendDirection(curvePoints, tailDirMinLen)
      if (extendDir) {
        tailExtendOverride = extendDir
      }
      if (debug && (extensionDistance > 0 || extraTargetClamped > 0 || tailAddState)) {
        tailDirDebug =
          tailExtendOverride ??
          tailSegmentDir ??
          computeTailDirection(
            curvePoints,
            tailBasisPrev,
            tailBasisTail,
            lastTailDirection,
            { preferFallbackBelow: tailDirMinLen },
          )
        if (curvePoints.length >= 2) {
          const tailPos = curvePoints[curvePoints.length - 1]
          const prevPos = curvePoints[curvePoints.length - 2]
          const tailNormal = tailPos.clone().normalize()
          tailSegDirDebug = tailPos.clone().sub(prevPos)
          tailSegDirDebug.addScaledVector(tailNormal, -tailSegDirDebug.dot(tailNormal))
          if (tailSegDirDebug.lengthSq() > 1e-8) {
            tailSegDirDebug.normalize()
          }
        }
        if (tailDirDebug && tailSegDirDebug && tailSegDirDebug.lengthSq() > 1e-8) {
          const dotValue = clamp(tailDirDebug.dot(tailSegDirDebug), -1, 1)
          tailDirAngle = Math.acos(dotValue)
        }
      }
      if (extensionDistance > 0) {
        const extendedTail = computeExtendedTailPoint(
          curvePoints,
          extensionDistance,
          tailBasisPrev,
          tailBasisTail,
          lastTailDirection,
          tailDirMinLen,
          tailExtendOverride,
        )
        if (extendedTail) {
          curvePoints[curvePoints.length - 1] = extendedTail
          const prevPos = curvePoints[curvePoints.length - 2]
          tailSegmentLength = extendedTail.distanceTo(prevPos)
        }
      }
      if (curvePoints.length >= 2) {
        const tailPos = curvePoints[curvePoints.length - 1]
        const prevPos = curvePoints[curvePoints.length - 2]
        snakeContactNormalTemp.copy(tailPos).normalize()
        snakeContactTangentTemp.copy(tailPos).sub(prevPos)
        snakeContactTangentTemp.addScaledVector(
          snakeContactNormalTemp,
          -snakeContactTangentTemp.dot(snakeContactNormalTemp),
        )
        if (snakeContactTangentTemp.lengthSq() <= 1e-8) {
          buildTangentBasis(
            snakeContactNormalTemp,
            snakeContactTangentTemp,
            snakeContactBitangentTemp,
          )
        } else {
          snakeContactTangentTemp.normalize()
        }
        const tailRadius = tailPos.length()
        const tailLift = applySnakeContactLift(
          snakeContactNormalTemp,
          snakeContactTangentTemp,
          tailRadius,
          radius,
          groundingInfo,
        )
        if (tailLift > 0) {
          tailPos.addScaledVector(snakeContactNormalTemp, tailLift)
          tailSegmentLength = tailPos.distanceTo(prevPos)
        }
      }
      if (curvePoints.length >= 2) {
        tailCurvePrev = curvePoints[curvePoints.length - 2]
        tailCurveTail = curvePoints[curvePoints.length - 1]
        tailExtendDistance = tailCurveTail.distanceTo(tailCurvePrev)
        lastTailTotalLengths.set(player.id, baseLength + extensionDistance)
        lastTailBasePositions.set(player.id, tailCurveTail.clone())
      }
      const baseCurve = new THREE.CatmullRomCurve3(curvePoints, false, 'centripetal')
      const tubularSegments = Math.max(8, curvePoints.length * 4)
      const tubeGeometry = new THREE.TubeGeometry(baseCurve, tubularSegments, radius, 10, false)
      if (digestionState.visuals.length) {
        applyDigestionBulges(tubeGeometry, digestionState.visuals)
      }
      visual.tube.geometry.dispose()
      visual.tube.geometry = tubeGeometry
    }

    if (nodes.length === 0) {
      visual.head.visible = false
      visual.eyeLeft.visible = false
      visual.eyeRight.visible = false
      visual.pupilLeft.visible = false
      visual.pupilRight.visible = false
      visual.tongue.visible = false
      visual.bowl.visible = false
      lastHeadPositions.delete(player.id)
      lastForwardDirections.delete(player.id)
      lastTailDirections.delete(player.id)
      lastSnakeLengths.delete(player.id)
      tailAddStates.delete(player.id)
      tailExtraStates.delete(player.id)
      lastTailBasePositions.delete(player.id)
      lastTailExtensionDistances.delete(player.id)
      lastTailTotalLengths.delete(player.id)
      tailGrowthStates.delete(player.id)
      tailDebugStates.delete(player.id)
      tongueStates.delete(player.id)
      lastSnakeStarts.delete(player.id)
      if (isLocal) {
        localGroundingInfo = finalizeGroundingInfo(groundingInfo)
      }
      return null
    }

    const hasHead = player.snakeStart === 0
    let tongueOverride: PelletOverride | null = null

    if (!hasHead) {
      visual.head.visible = false
      visual.eyeLeft.visible = false
      visual.eyeRight.visible = false
      visual.pupilLeft.visible = false
      visual.pupilRight.visible = false
      visual.tongue.visible = false
      visual.bowl.visible = false
      lastHeadPositions.delete(player.id)
      lastForwardDirections.delete(player.id)
      tongueStates.delete(player.id)
    } else {
      visual.head.visible = true
      visual.eyeLeft.visible = true
      visual.eyeRight.visible = true
      visual.pupilLeft.visible = true
      visual.pupilRight.visible = true

    if (debug) {
      const prevDebug = tailDebugStates.get(player.id)
      const extendActive = tailExtraTarget > 0 || tailExtensionDistance > 0
      const extBucket = extendActive ? Math.floor(tailExtensionDistance / 0.01) : -1
      const angleBucket =
        extendActive && Number.isFinite(tailDirAngle) ? Math.floor(tailDirAngle / 0.25) : -1
      const extendStarted = extendActive && (!prevDebug || !prevDebug.lastExtendActive)
      const extendEnded = !extendActive && !!prevDebug?.lastExtendActive
      const extendStep =
        extendActive &&
        (!prevDebug ||
          prevDebug.lastExtBucket !== extBucket ||
          prevDebug.lastDirAngleBucket !== angleBucket)

      if (extendStarted) {
        console.log(
          `[TAIL_DEBUG] ${player.id} tail_extend_start ` +
            `ext=${formatNum(tailExtensionDistance)} target=${formatNum(tailExtraTarget)} ` +
            `seg_len=${formatNum(tailSegmentLength)} add_prog=${formatNum(tailAddProgress, 3)} ` +
            `tail_growth=${formatNum(digestionState.tailGrowth, 3)}`,
        )
      }

      if (extendStep) {
        console.log(
          `[TAIL_DEBUG] ${player.id} tail_extend ` +
            `ext=${formatNum(tailExtensionDistance)} target=${formatNum(tailExtraTarget)} ` +
            `extend_len=${formatNum(tailExtendDistance)} seg_len=${formatNum(tailSegmentLength)} ` +
            `dir_angle=${formatNum(tailDirAngle, 3)}`,
        )
      }

      if (extendEnded) {
        console.log(`[TAIL_DEBUG] ${player.id} tail_extend_end`)
      }

      tailDebugStates.set(player.id, {
        lastExtendActive: extendActive,
        lastExtBucket: extBucket,
        lastDirAngleBucket: angleBucket,
      })
    }

    const headPoint = nodes[0]
    const headNormal = tempVector.set(headPoint.x, headPoint.y, headPoint.z).normalize()
    snakeContactTangentTemp.set(0, 0, 0)
    if (headCurvePoint && secondCurvePoint) {
      snakeContactTangentTemp.copy(headCurvePoint).sub(secondCurvePoint)
    } else if (nodes.length > 1) {
      const nextPoint = nodes[1]
      snakeContactFallbackTemp.set(nextPoint.x, nextPoint.y, nextPoint.z).normalize()
      snakeContactTangentTemp.copy(headNormal).sub(snakeContactFallbackTemp)
    }
    snakeContactTangentTemp.addScaledVector(
      headNormal,
      -snakeContactTangentTemp.dot(headNormal),
    )
    if (snakeContactTangentTemp.lengthSq() <= 1e-8) {
      buildTangentBasis(headNormal, snakeContactTangentTemp, snakeContactBitangentTemp)
    } else {
      snakeContactTangentTemp.normalize()
    }
    const headCenterlineRadius = getSnakeCenterlineRadius(
      headNormal,
      radiusOffset,
      radius,
    )
    const headLift = applySnakeContactLift(
      headNormal,
      snakeContactTangentTemp,
      headCenterlineRadius,
      HEAD_RADIUS,
      groundingInfo,
    )
    const headPosition = headNormal
      .clone()
      .multiplyScalar(headCenterlineRadius + headLift)
    visual.head.position.copy(headPosition)
    visual.bowl.position.copy(headPosition)

    let underwater = false
    if (lakes.length > 0) {
      const sample = sampleLakes(headNormal, lakes, lakeSampleTemp)
      underwater = !!sample.lake && sample.boundary > LAKE_WATER_MASK_THRESHOLD
    }
    const crackAmount = underwater ? clamp((0.35 - player.oxygen) / 0.35, 0, 1) : 0
    visual.bowlCrackUniform.value = crackAmount
    if (webglShaderHooksEnabled) {
      visual.bowlMaterial.color.set('#cfefff')
      visual.bowlMaterial.emissive.set(0x000000)
      visual.bowlMaterial.emissiveIntensity = 0
      visual.bowlMaterial.opacity = 0.45 * opacity
    } else {
      const tint = crackAmount
      visual.bowlMaterial.color.setRGB(
        0.81 - 0.31 * tint,
        0.94 - 0.44 * tint,
        1.0 - 0.54 * tint,
      )
      visual.bowlMaterial.emissive.setRGB(0.08 * tint, 0.04 * tint, 0.03 * tint)
      visual.bowlMaterial.emissiveIntensity = 1
      visual.bowlMaterial.opacity = (0.45 + tint * 0.22) * opacity
    }
    visual.bowl.visible = underwater && visual.group.visible

    let forward = tempVectorB
    let hasForward = false
    const lastHead = lastHeadPositions.get(player.id)
    const lastForward = lastForwardDirections.get(player.id)

    if (lastHead) {
      const delta = headPosition.clone().sub(lastHead)
      delta.addScaledVector(headNormal, -delta.dot(headNormal))
      if (delta.lengthSq() > 1e-8) {
        delta.normalize()
        forward.copy(delta)
        hasForward = true
        if (lastForward) {
          lastForward.copy(forward)
        } else {
          lastForwardDirections.set(player.id, forward.clone())
        }
      } else if (lastForward) {
        forward.copy(lastForward)
        hasForward = true
      }
    }

    if (!hasForward) {
      if (nodes.length > 1) {
        const nextPoint =
          secondCurvePoint ??
          (() => {
            const nextNode = nodes[1]
            const nextNormal = new THREE.Vector3(nextNode.x, nextNode.y, nextNode.z).normalize()
            const nextRadius = getSnakeCenterlineRadius(nextNormal, radiusOffset, radius)
            return nextNormal.multiplyScalar(nextRadius)
          })()
        forward = headPosition.clone().sub(nextPoint)
      } else {
        forward = new THREE.Vector3().crossVectors(headNormal, new THREE.Vector3(0, 1, 0))
      }
      if (forward.lengthSq() < 0.00001) {
        forward = new THREE.Vector3().crossVectors(headNormal, new THREE.Vector3(1, 0, 0))
      }
      forward.normalize()
    }

    const cachedHead = lastHeadPositions.get(player.id)
    if (cachedHead) {
      cachedHead.copy(headPosition)
    } else {
      lastHeadPositions.set(player.id, headPosition.clone())
    }

    const right = new THREE.Vector3().crossVectors(forward, headNormal)
    if (right.lengthSq() < 0.00001) {
      right.set(1, 0, 0)
    }
    right.normalize()

    const eyeOut = HEAD_RADIUS * 0.16
    const eyeForward = HEAD_RADIUS * 0.28
    const eyeSpacing = HEAD_RADIUS * 0.52

    const leftEyePosition = headPosition
      .clone()
      .addScaledVector(headNormal, eyeOut)
      .addScaledVector(forward, eyeForward)
      .addScaledVector(right, -eyeSpacing)
    const rightEyePosition = headPosition
      .clone()
      .addScaledVector(headNormal, eyeOut)
      .addScaledVector(forward, eyeForward)
      .addScaledVector(right, eyeSpacing)

    visual.eyeLeft.position.copy(leftEyePosition)
    visual.eyeRight.position.copy(rightEyePosition)

    const clampedYaw = 0
    const pupilSurfaceDistance = PUPIL_OFFSET

    const updatePupil = (eyePosition: THREE.Vector3, eyeNormal: THREE.Vector3, output: THREE.Vector3) => {
      tempVectorH.copy(right)
      tempVectorH.addScaledVector(eyeNormal, -tempVectorH.dot(eyeNormal))
      if (tempVectorH.lengthSq() > 1e-6) {
        tempVectorH.normalize()
      } else {
        tempVectorH.copy(right)
      }

      const yawCos = Math.cos(clampedYaw)
      const yawSin = Math.sin(clampedYaw)
      output
        .copy(eyePosition)
        .addScaledVector(eyeNormal, pupilSurfaceDistance * yawCos)
        .addScaledVector(tempVectorH, pupilSurfaceDistance * yawSin)
    }

    tempVectorF.copy(leftEyePosition).sub(headPosition).normalize()
    updatePupil(leftEyePosition, tempVectorF, visual.pupilLeft.position)
    tempVectorG.copy(rightEyePosition).sub(headPosition).normalize()
    updatePupil(rightEyePosition, tempVectorG, visual.pupilRight.position)

    if (isLocal) {
      tongueOverride = updateTongue(player.id, visual, headPosition, headNormal, forward, pellets, deltaSeconds)
    } else {
      visual.tongue.visible = false
      tongueStates.delete(player.id)
    }
    }

    if (nodes.length > 1) {
      const tailPos =
        tailCurveTail ??
        (() => {
          const tailNode = nodes[nodes.length - 1]
          const tailNormalFallback = new THREE.Vector3(
            tailNode.x,
            tailNode.y,
            tailNode.z,
          ).normalize()
          const tailRadius = getSnakeCenterlineRadius(
            tailNormalFallback,
            radiusOffset,
            radius,
          )
          return tailNormalFallback.multiplyScalar(tailRadius)
        })()
      const prevPos =
        tailCurvePrev ??
        (() => {
          const prevNode = nodes[nodes.length - 2]
          const prevNormalFallback = new THREE.Vector3(
            prevNode.x,
            prevNode.y,
            prevNode.z,
          ).normalize()
          const prevRadius = getSnakeCenterlineRadius(
            prevNormalFallback,
            radiusOffset,
            radius,
          )
          return prevNormalFallback.multiplyScalar(prevRadius)
        })()
      const tailNormal = tailPos.clone().normalize()
      const tailDir = tailPos.clone().sub(prevPos)
      tailDir.addScaledVector(tailNormal, -tailDir.dot(tailNormal))
      if (tailDir.lengthSq() < 1e-8 || (tailDirMinLen > 0 && tailDir.length() < tailDirMinLen)) {
        if (lastTailDirection) {
          tailDir.copy(lastTailDirection)
        }
      }
      if (tailDir.lengthSq() < 1e-8) {
        tailDir.crossVectors(tailNormal, new THREE.Vector3(0, 1, 0))
        if (tailDir.lengthSq() < 1e-6) {
          tailDir.crossVectors(tailNormal, new THREE.Vector3(1, 0, 0))
        }
      }
      tailDir.normalize()
      if (lastTailDirection) {
        lastTailDirection.copy(tailDir)
      } else {
        lastTailDirections.set(player.id, tailDir.clone())
      }
      if (visual.tube.geometry instanceof THREE.TubeGeometry) {
        const capGeometry = buildTailCapGeometry(visual.tube.geometry, tailDir)
        if (capGeometry) {
          if (visual.tail.geometry !== tailGeometry) {
            visual.tail.geometry.dispose()
          }
          visual.tail.geometry = capGeometry
        }
      }
      visual.tail.position.set(0, 0, 0)
      visual.tail.quaternion.identity()
      visual.tail.scale.setScalar(1)
    }

    if (isLocal) {
      localGroundingInfo = finalizeGroundingInfo(groundingInfo)
    }

    return tongueOverride
  }

  const removeSnake = (visual: SnakeVisual, id: string) => {
    snakesGroup.remove(visual.group)
    visual.tube.geometry.dispose()
    if (visual.tail.geometry !== tailGeometry) {
      visual.tail.geometry.dispose()
    }
    visual.tube.material.dispose()
    visual.head.material.dispose()
    visual.eyeLeft.material.dispose()
    visual.eyeRight.material.dispose()
    visual.pupilLeft.material.dispose()
    visual.pupilRight.material.dispose()
    visual.tongueBase.material.dispose()
    visual.tongueForkLeft.material.dispose()
    visual.tongueForkRight.material.dispose()
    visual.bowlMaterial.dispose()
    resetSnakeTransientState(id)
    deathStates.delete(id)
    lastAliveStates.delete(id)
    lastSnakeStarts.delete(id)
  }

  const updateSnakes = (
    players: PlayerSnapshot[],
    localPlayerId: string | null,
    deltaSeconds: number,
    pellets: PelletSnapshot[] | null,
  ): PelletOverride | null => {
    const activeIds = new Set<string>()
    localGroundingInfo = null
    let pelletOverride: PelletOverride | null = null
    for (const player of players) {
      activeIds.add(player.id)
      const override = updateSnake(
        player,
        player.id === localPlayerId,
        deltaSeconds,
        pellets,
      )
      if (override) {
        pelletOverride = override
      }
    }

    for (const [id, visual] of snakes) {
      if (!activeIds.has(id)) {
        removeSnake(visual, id)
        snakes.delete(id)
        lastHeadPositions.delete(id)
        lastForwardDirections.delete(id)
      }
    }

    return pelletOverride
  }

  const normalizePelletColorIndex = (colorIndex: number) => {
    if (PELLET_BUCKET_COUNT <= 0) return 0
    const mod = colorIndex % PELLET_BUCKET_COUNT
    return mod >= 0 ? mod : mod + PELLET_BUCKET_COUNT
  }

  const createPelletBucket = (bucketIndex: number, capacity: number): PelletSpriteBucket => {
    const geometry = new THREE.BufferGeometry()
    const positionArray = new Float32Array(capacity * 3)
    const positionAttribute = new THREE.BufferAttribute(positionArray, 3)
    positionAttribute.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttribute)
    geometry.setDrawRange(0, 0)

    const material = new THREE.PointsMaterial({
      size: PELLET_POINT_SIZE,
      map: pelletSpriteTexture ?? undefined,
      alphaMap: pelletSpriteTexture ?? undefined,
      color: PELLET_COLORS[bucketIndex] ?? '#ffd166',
      transparent: true,
      opacity: 0.84,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
    })
    const points = new THREE.Points(geometry, material)
    points.visible = false
    points.frustumCulled = false
    pelletsGroup.add(points)
    return { points, positionAttribute, capacity }
  }

  const ensurePelletBucketCapacity = (bucketIndex: number, required: number): PelletSpriteBucket => {
    const targetCapacity = Math.max(1, required)
    let bucket = pelletBuckets[bucketIndex]
    if (!bucket) {
      let capacity = 1
      while (capacity < targetCapacity) {
        capacity *= 2
      }
      bucket = createPelletBucket(bucketIndex, capacity)
      pelletBuckets[bucketIndex] = bucket
      return bucket
    }
    if (bucket.capacity >= targetCapacity) {
      return bucket
    }

    let nextCapacity = Math.max(1, bucket.capacity)
    while (nextCapacity < targetCapacity) {
      nextCapacity *= 2
    }
    const geometry = new THREE.BufferGeometry()
    const positionArray = new Float32Array(nextCapacity * 3)
    const positionAttribute = new THREE.BufferAttribute(positionArray, 3)
    positionAttribute.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttribute)
    geometry.setDrawRange(0, 0)

    bucket.points.geometry.dispose()
    bucket.points.geometry = geometry
    bucket.positionAttribute = positionAttribute
    bucket.capacity = nextCapacity
    return bucket
  }

  const updatePellets = (pellets: PelletSnapshot[], override: PelletOverride | null) => {
    pelletIdsSeen.clear()
    for (let i = 0; i < PELLET_BUCKET_COUNT; i += 1) {
      pelletBucketCounts[i] = 0
      pelletBucketOffsets[i] = 0
    }

    for (let i = 0; i < pellets.length; i += 1) {
      const pellet = pellets[i]
      const bucketIndex = normalizePelletColorIndex(pellet.colorIndex)
      pelletBucketCounts[bucketIndex] += 1
      pelletIdsSeen.add(pellet.id)
    }

    const bucketPositions: Array<Float32Array | null> = new Array(PELLET_BUCKET_COUNT).fill(null)
    for (let bucketIndex = 0; bucketIndex < PELLET_BUCKET_COUNT; bucketIndex += 1) {
      const required = pelletBucketCounts[bucketIndex]
      const bucket = pelletBuckets[bucketIndex]
      if (required <= 0) {
        if (bucket) {
          bucket.points.visible = false
          bucket.points.geometry.setDrawRange(0, 0)
        }
        continue
      }
      const nextBucket = ensurePelletBucketCapacity(bucketIndex, required)
      nextBucket.points.visible = true
      nextBucket.points.geometry.setDrawRange(0, required)
      bucketPositions[bucketIndex] = nextBucket.positionAttribute.array as Float32Array
    }

    for (let i = 0; i < pellets.length; i += 1) {
      const pellet = pellets[i]
      const bucketIndex = normalizePelletColorIndex(pellet.colorIndex)
      const positions = bucketPositions[bucketIndex]
      if (!positions) continue

      if (override && override.id === pellet.id) {
        tempVector.copy(override.position)
      } else {
        getPelletSurfacePosition(pellet, tempVector)
      }

      const itemIndex = pelletBucketOffsets[bucketIndex]
      pelletBucketOffsets[bucketIndex] += 1
      const pOffset = itemIndex * 3
      positions[pOffset] = tempVector.x
      positions[pOffset + 1] = tempVector.y
      positions[pOffset + 2] = tempVector.z
    }

    for (let bucketIndex = 0; bucketIndex < PELLET_BUCKET_COUNT; bucketIndex += 1) {
      if (pelletBucketCounts[bucketIndex] <= 0) continue
      const bucket = pelletBuckets[bucketIndex]
      if (!bucket) continue
      bucket.positionAttribute.needsUpdate = true
    }

    for (const id of pelletGroundCache.keys()) {
      if (!pelletIdsSeen.has(id)) {
        pelletGroundCache.delete(id)
      }
    }
  }

  const render = (
    snapshot: GameStateSnapshot | null,
    cameraState: Camera,
    localPlayerId: string | null,
    cameraDistance: number,
  ) => {
    const now = performance.now()
    const deltaSeconds = Math.min(0.1, Math.max(0, (now - lastFrameTime) / 1000))
    lastFrameTime = now

    if (cameraState.active) {
      world.quaternion.set(cameraState.q.x, cameraState.q.y, cameraState.q.z, cameraState.q.w)
    } else {
      world.quaternion.identity()
    }
    if (Number.isFinite(cameraDistance)) {
      camera.position.set(0, 0, cameraDistance)
    }
    camera.updateMatrixWorld()

    let localHeadScreen: { x: number; y: number } | null = null

    if (snapshot && localPlayerId) {
      const localPlayer = snapshot.players.find((player) => player.id === localPlayerId)
      const head = localPlayer?.snakeDetail !== 'stub' ? localPlayer?.snake[0] : undefined
      if (head) {
        const radius = SNAKE_RADIUS * 1.1
        const radiusOffset = radius * SNAKE_LIFT_FACTOR
        const headNormal = tempVectorC.set(head.x, head.y, head.z).normalize()
        snakeContactTangentTemp.set(0, 0, 0)
        if (localPlayer && localPlayer.snake.length > 1) {
          const next = localPlayer.snake[1]
          snakeContactFallbackTemp.set(next.x, next.y, next.z).normalize()
          snakeContactTangentTemp.copy(headNormal).sub(snakeContactFallbackTemp)
          snakeContactTangentTemp.addScaledVector(
            headNormal,
            -snakeContactTangentTemp.dot(headNormal),
          )
          if (snakeContactTangentTemp.lengthSq() <= 1e-8) {
            buildTangentBasis(headNormal, snakeContactTangentTemp, snakeContactBitangentTemp)
          } else {
            snakeContactTangentTemp.normalize()
          }
        } else {
          buildTangentBasis(headNormal, snakeContactTangentTemp, snakeContactBitangentTemp)
        }
        const headCenterlineRadius = getSnakeCenterlineRadius(
          headNormal,
          radiusOffset,
          radius,
        )
        const headLift = applySnakeContactLift(
          headNormal,
          snakeContactTangentTemp,
          headCenterlineRadius,
          HEAD_RADIUS,
          null,
        )
        const headPosition = headNormal
          .clone()
          .multiplyScalar(headCenterlineRadius + headLift)
        headPosition.applyQuaternion(world.quaternion)
        headPosition.project(camera)

        const screenX = (headPosition.x * 0.5 + 0.5) * viewportWidth
        const screenY = (-headPosition.y * 0.5 + 0.5) * viewportHeight
        if (Number.isFinite(screenX) && Number.isFinite(screenY)) {
          localHeadScreen = { x: screenX, y: screenY }
        }
      }
    }

    if (snapshot) {
      const pelletOverride = updateSnakes(
        snapshot.players,
        localPlayerId,
        deltaSeconds,
        snapshot.pellets,
      )
      updatePellets(snapshot.pellets, pelletOverride)
    } else {
      updateSnakes([], localPlayerId, deltaSeconds, null)
      updatePellets([], null)
    }

    patchCenterQuat.copy(world.quaternion).invert()
    cameraLocalPosTemp.copy(camera.position).applyQuaternion(patchCenterQuat)
    cameraLocalDirTemp.copy(cameraLocalPosTemp).normalize()
    const aspect = viewportHeight > 0 ? viewportWidth / viewportHeight : 1
    const viewAngle = computeVisibleSurfaceAngle(camera.position.z, aspect)
    if (PLANET_PATCH_ENABLED) {
      updatePlanetPatchVisibility(cameraLocalDirTemp, viewAngle)
    }
    updateLakeVisibility(cameraLocalDirTemp, viewAngle)
    updateEnvironmentVisibility(cameraLocalPosTemp, cameraLocalDirTemp, viewAngle)

    const lakeTimeSeconds = now * 0.001
    for (let i = 0; i < lakeMaterials.length; i += 1) {
      const material = lakeMaterials[i]
      const uniforms = (material.userData as LakeMaterialUserData).lakeWaterUniforms
      if (uniforms) {
        uniforms.time.value = lakeTimeSeconds
      } else {
        material.emissiveIntensity =
          LAKE_WATER_EMISSIVE_BASE +
          Math.sin(lakeTimeSeconds * LAKE_WATER_WAVE_SPEED + i * 0.73) * LAKE_WATER_EMISSIVE_PULSE
      }
    }

    renderer.render(scene, camera)
    return localHeadScreen
  }

  const setEnvironment = (environment: Environment) => {
    buildEnvironment(environment)
  }

  const setDebugFlags = (flags: {
    mountainOutline?: boolean
    lakeCollider?: boolean
    treeCollider?: boolean
    terrainTessellation?: boolean
  }) => {
    if (typeof flags.mountainOutline === 'boolean') {
      mountainDebugEnabled = flags.mountainOutline
      if (mountainDebugGroup) {
        mountainDebugGroup.visible = mountainDebugEnabled
      }
    }
    if (typeof flags.lakeCollider === 'boolean') {
      lakeDebugEnabled = flags.lakeCollider
      if (lakeDebugGroup) {
        lakeDebugGroup.visible = lakeDebugEnabled
      }
    }
    if (typeof flags.treeCollider === 'boolean') {
      treeDebugEnabled = flags.treeCollider
      if (treeDebugGroup) {
        treeDebugGroup.visible = treeDebugEnabled
      }
    }
    if (typeof flags.terrainTessellation === 'boolean') {
      terrainTessellationDebugEnabled = flags.terrainTessellation
      if (planetPatchMaterial) {
        planetPatchMaterial.wireframe = terrainTessellationDebugEnabled
        planetPatchMaterial.needsUpdate = true
      }
      if (planetMesh?.material instanceof THREE.MeshStandardMaterial) {
        planetMesh.material.wireframe = terrainTessellationDebugEnabled
        planetMesh.material.needsUpdate = true
      }
    }
  }

  const resize = (width: number, height: number, dpr: number) => {
    viewportWidth = width
    viewportHeight = height
    renderer.setPixelRatio(dpr)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }

  const dispose = () => {
    renderer.dispose()
    disposeEnvironment()
    headGeometry.dispose()
    bowlGeometry.dispose()
    tailGeometry.dispose()
    eyeGeometry.dispose()
    pupilGeometry.dispose()
    eyeMaterial.dispose()
    pupilMaterial.dispose()
    tongueBaseGeometry.dispose()
    tongueForkGeometry.dispose()
    tongueMaterial.dispose()
    for (let i = 0; i < pelletBuckets.length; i += 1) {
      const bucket = pelletBuckets[i]
      if (!bucket) continue
      pelletsGroup.remove(bucket.points)
      bucket.points.geometry.dispose()
      bucket.points.material.dispose()
      pelletBuckets[i] = null
    }
    pelletSpriteTexture?.dispose()
    pelletGroundCache.clear()
    pelletIdsSeen.clear()
    for (const [id, visual] of snakes) {
      removeSnake(visual, id)
    }
    snakes.clear()

    if (debugEnabled && typeof window !== 'undefined') {
      const debugWindow = window as Window & { __SNAKE_DEBUG__?: unknown }
      if (debugWindow.__SNAKE_DEBUG__ === debugApi) {
        delete debugWindow.__SNAKE_DEBUG__
      }
    }
  }

  return {
    resize,
    render,
    setEnvironment,
    setDebugFlags,
    dispose,
  }
}

export async function createRenderScene(
  canvas: HTMLCanvasElement,
  requestedBackend: RendererPreference = 'auto',
): Promise<CreateRenderSceneResult> {
  if (requestedBackend === 'webgl') {
    const scene = await createScene(canvas, requestedBackend, 'webgl', null)
    return {
      scene,
      activeBackend: 'webgl',
      fallbackReason: null,
    }
  }

  if (!(await hasWebGpuSupport())) {
    const fallbackReason = 'WebGPU is unavailable in this browser/runtime'
    const scene = await createScene(canvas, requestedBackend, 'webgl', fallbackReason)
    return {
      scene,
      activeBackend: 'webgl',
      fallbackReason,
    }
  }

  try {
    const scene = await createScene(canvas, requestedBackend, 'webgpu', null)
    return {
      scene,
      activeBackend: 'webgpu',
      fallbackReason: null,
    }
  } catch (error) {
    const fallbackReason = formatRendererError(error)
    const scene = await createScene(canvas, requestedBackend, 'webgl', fallbackReason)
    return {
      scene,
      activeBackend: 'webgl',
      fallbackReason,
    }
  }
}

export async function createWebGLScene(canvas: HTMLCanvasElement): Promise<WebGLScene> {
  const { scene } = await createRenderScene(canvas, 'webgl')
  return scene
}
