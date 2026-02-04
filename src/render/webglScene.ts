import * as THREE from 'three'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils'
import type { Camera, GameStateSnapshot, PlayerSnapshot, Point } from '../game/types'

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
  color: string
}

type PointerState = {
  screenX: number
  screenY: number
  active: boolean
}

type GazeRay = {
  origin: THREE.Vector3
  direction: THREE.Vector3
}

type TongueState = {
  length: number
  mode: 'idle' | 'extend' | 'retract'
  targetPosition: THREE.Vector3 | null
  carrying: boolean
}

type PelletOverride = {
  index: number
  position: THREE.Vector3
}

type DigestionVisual = {
  t: number
  strength: number
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

type WebGLScene = {
  resize: (width: number, height: number, dpr: number) => void
  render: (
    snapshot: GameStateSnapshot | null,
    camera: Camera,
    localPlayerId: string | null,
    pointer: PointerState | null,
    cameraDistance: number,
  ) => { x: number; y: number } | null
  dispose: () => void
}

const PLANET_RADIUS = 1
const PLANET_FIBONACCI_POINTS = 2048
const LAKE_SURFACE_POINTS = PLANET_FIBONACCI_POINTS * 3
const LAKE_SURFACE_SEGMENTS = 96
const LAKE_SURFACE_RINGS = 64
const LAKE_COUNT = 2
const LAKE_MIN_ANGLE = 0.9
const LAKE_MAX_ANGLE = 1.3
const LAKE_MIN_DEPTH = PLANET_RADIUS * 0.07
const LAKE_MAX_DEPTH = PLANET_RADIUS * 0.12
const LAKE_EDGE_FALLOFF = 0.08
const LAKE_EDGE_SHARPNESS = 1.8
const LAKE_NOISE_AMPLITUDE = 0.55
const LAKE_NOISE_FREQ_MIN = 3
const LAKE_NOISE_FREQ_MAX = 6
const LAKE_SHELF_DEPTH_RATIO = 0.45
const LAKE_SHELF_CORE = 0.55
const LAKE_CENTER_PIT_START = 0.72
const LAKE_CENTER_PIT_RATIO = 0.35
const LAKE_SURFACE_INSET_RATIO = 0.5
const LAKE_SURFACE_EXTRA_INSET = PLANET_RADIUS * 0.01
const LAKE_SURFACE_DEPTH_EPS = PLANET_RADIUS * 0.0015
const LAKE_WATER_OVERDRAW = PLANET_RADIUS * 0.01
const LAKE_TERRAIN_CLAMP_EPS = PLANET_RADIUS * 0.0008
const LAKE_WATER_MASK_THRESHOLD = 0
const LAKE_GRID_MASK_THRESHOLD = LAKE_WATER_MASK_THRESHOLD
const LAKE_EXCLUSION_THRESHOLD = 0.18
const SNAKE_RADIUS = 0.045
const HEAD_RADIUS = SNAKE_RADIUS * 1.35
const SNAKE_LIFT_FACTOR = 0.85
const EYE_RADIUS = SNAKE_RADIUS * 0.65
const PUPIL_RADIUS = EYE_RADIUS * 0.55
const PUPIL_OFFSET = EYE_RADIUS * 0.6
const PELLET_RADIUS = SNAKE_RADIUS * 0.75
const PELLET_OFFSET = 0.035
const GAZE_FOCUS_DISTANCE = 6
const GAZE_MIN_DOT = 0.2
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
const DIGESTION_BULGE = 0.55
const DIGESTION_WIDTH = 2.5
const DIGESTION_MAX_BULGE = 0.85
const DIGESTION_START_RINGS = 3
const DIGESTION_START_MAX = 0.18
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
const TREE_HEIGHT = PLANET_RADIUS * 0.3
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
const MOUNTAIN_COUNT = 8
const MOUNTAIN_VARIANTS = 3
const MOUNTAIN_RADIUS_MIN = PLANET_RADIUS * 0.12
const MOUNTAIN_RADIUS_MAX = PLANET_RADIUS * 0.22
const MOUNTAIN_HEIGHT_MIN = PLANET_RADIUS * 0.12
const MOUNTAIN_HEIGHT_MAX = PLANET_RADIUS * 0.26
const MOUNTAIN_BASE_SINK = 0.015
const MOUNTAIN_MIN_ANGLE = 0.55
const PEBBLE_COUNT = 220
const PEBBLE_RADIUS_MIN = PLANET_RADIUS * 0.0045
const PEBBLE_RADIUS_MAX = PLANET_RADIUS * 0.014
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
const createFibonacciSphereGeometry = (radius: number, count: number) => {
  const points: THREE.Vector3[] = []
  const offset = 2 / count
  const increment = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i += 1) {
    const y = i * offset - 1 + offset * 0.5
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const phi = i * increment
    points.push(new THREE.Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r).multiplyScalar(radius))
  }
  const geometry = new ConvexGeometry(points)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}
const createLakes = (seed: number, count: number) => {
  const rng = createSeededRandom(seed)
  const lakes: Lake[] = []
  const randRange = (min: number, max: number) => min + (max - min) * rng()
  const pickCenter = (radius: number, out: THREE.Vector3) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      randomOnSphere(rng, out)
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
const applyLakeDepressions = (geometry: THREE.BufferGeometry, lakes: Lake[]) => {
  const positions = geometry.attributes.position
  const normal = new THREE.Vector3()
  const temp = new THREE.Vector3()
  for (let i = 0; i < positions.count; i += 1) {
    normal.set(positions.getX(i), positions.getY(i), positions.getZ(i)).normalize()
    const sample = sampleLakes(normal, lakes, temp)
    let depth = sample.depth
    if (sample.lake && sample.boundary > LAKE_WATER_MASK_THRESHOLD) {
      const surfaceDepth = sample.lake.surfaceInset
      // Keep lake beds below the rendered water surface to avoid visible seams.
      depth = Math.max(depth, surfaceDepth + LAKE_TERRAIN_CLAMP_EPS)
    }
    const radius = PLANET_RADIUS - depth
    positions.setXYZ(i, normal.x * radius, normal.y * radius, normal.z * radius)
  }
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
    samples.push({ sample, depth: sample.depth })
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
      if (samples[s].sample.boundary > LAKE_WATER_MASK_THRESHOLD) {
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

    const surfaceRadius = PLANET_RADIUS - bestSample.sample.lake.surfaceInset
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
    emissiveIntensity: 0.32,
    transparent: true,
  })
  const extensions =
    (material as THREE.Material & { extensions?: { derivatives?: boolean } }).extensions ?? {}
  extensions.derivatives = true
  ;(material as THREE.Material & { extensions?: { derivatives?: boolean } }).extensions = extensions
  material.onBeforeCompile = (shader) => {
    shader.uniforms.lakeCenter = { value: lake.center }
    shader.uniforms.lakeTangent = { value: lake.tangent }
    shader.uniforms.lakeBitangent = { value: lake.bitangent }
    shader.uniforms.lakeRadius = { value: lake.radius }
    shader.uniforms.lakeEdgeFalloff = { value: lake.edgeFalloff }
    shader.uniforms.lakeEdgeSharpness = { value: LAKE_EDGE_SHARPNESS }
    shader.uniforms.lakeNoiseAmplitude = { value: lake.noiseAmplitude }
    shader.uniforms.lakeNoiseFrequency = { value: lake.noiseFrequency }
    shader.uniforms.lakeNoiseFrequencyB = { value: lake.noiseFrequencyB }
    shader.uniforms.lakeNoiseFrequencyC = { value: lake.noiseFrequencyC }
    shader.uniforms.lakeNoisePhase = { value: lake.noisePhase }
    shader.uniforms.lakeNoisePhaseB = { value: lake.noisePhaseB }
    shader.uniforms.lakeNoisePhaseC = { value: lake.noisePhaseC }
    shader.uniforms.lakeWarpAmplitude = { value: lake.warpAmplitude }
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
uniform float lakeEdgeSharpness;
uniform float lakeNoiseAmplitude;
uniform float lakeNoiseFrequency;
uniform float lakeNoiseFrequencyB;
uniform float lakeNoiseFrequencyC;
uniform float lakeNoisePhase;
uniform float lakeNoisePhaseB;
uniform float lakeNoisePhaseC;
uniform float lakeWarpAmplitude;

float lakeEdgeBlend(vec3 normal) {
  float dotValue = clamp(dot(lakeCenter, normal), -1.0, 1.0);
  float angle = acos(dotValue);
  if (angle >= lakeRadius + lakeEdgeFalloff) return 0.0;
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
  );
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
float lakeAlpha = smoothstep(0.0, lakeAa, lakeEdge);
diffuseColor.a *= lakeAlpha;
#include <dithering_fragment>`,
      )
  }
  return material
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

function pointToVector(point: Point, radius: number) {
  return new THREE.Vector3(point.x, point.y, point.z).normalize().multiplyScalar(radius)
}

class SphericalCurve extends THREE.Curve<THREE.Vector3> {
  private base: THREE.CatmullRomCurve3
  private radius: number

  constructor(base: THREE.CatmullRomCurve3, radius: number) {
    super()
    this.base = base
    this.radius = radius
  }

  getPoint(t: number, optionalTarget = new THREE.Vector3()) {
    this.base.getPoint(t, optionalTarget)
    return optionalTarget.normalize().multiplyScalar(this.radius)
  }
}

export function createWebGLScene(canvas: HTMLCanvasElement): WebGLScene {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.setClearColor(0x000000, 0)

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

  const lakes = createLakes(0x91fcae12, LAKE_COUNT)
  const basePlanetGeometry = createFibonacciSphereGeometry(PLANET_RADIUS, PLANET_FIBONACCI_POINTS)
  const planetGeometry = basePlanetGeometry.clone()
  applyLakeDepressions(planetGeometry, lakes)
  const planetMaterial = new THREE.MeshStandardMaterial({
    color: '#7ddf6a',
    roughness: 0.9,
    metalness: 0.05,
  })
  const planetMesh = new THREE.Mesh(planetGeometry, planetMaterial)
  world.add(planetMesh)

  const rawGridGeometry = new THREE.WireframeGeometry(planetGeometry)
  const gridGeometry = createFilteredGridGeometry(rawGridGeometry, lakes)
  rawGridGeometry.dispose()
  const gridMaterial = new THREE.LineBasicMaterial({
    color: '#1b4965',
    transparent: true,
    opacity: 0.12,
  })
  gridMaterial.depthWrite = false
  const gridMesh = new THREE.LineSegments(gridGeometry, gridMaterial)
  gridMesh.scale.setScalar(1.002)
  world.add(gridMesh)

  const lakeSurfaceGeometry = new THREE.SphereGeometry(1, LAKE_SURFACE_SEGMENTS, LAKE_SURFACE_RINGS)
  const lakeMeshes: THREE.Mesh[] = []
  const lakeMaterials: THREE.MeshStandardMaterial[] = []
  for (const lake of lakes) {
    const lakeMaterial = createLakeMaskMaterial(lake)
    const lakeMesh = new THREE.Mesh(lakeSurfaceGeometry, lakeMaterial)
    lakeMesh.scale.setScalar(PLANET_RADIUS - lake.surfaceInset)
    lakeMesh.renderOrder = 2
    world.add(lakeMesh)
    lakeMeshes.push(lakeMesh)
    lakeMaterials.push(lakeMaterial)
  }
  if (isLakeDebugEnabled()) {
    const lakeBaseGeometry = createFibonacciSphereGeometry(PLANET_RADIUS, LAKE_SURFACE_POINTS)
    const lakeGeometry = createLakeSurfaceGeometry(lakeBaseGeometry, lakes)
    lakeGeometry.dispose()
    lakeBaseGeometry.dispose()
  }
  basePlanetGeometry.dispose()

  const environmentGroup = new THREE.Group()
  world.add(environmentGroup)

  const snakesGroup = new THREE.Group()
  const pelletsGroup = new THREE.Group()
  world.add(snakesGroup)
  world.add(pelletsGroup)

  const headGeometry = new THREE.SphereGeometry(HEAD_RADIUS, 18, 18)
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

  const pelletGeometry = new THREE.SphereGeometry(PELLET_RADIUS, 14, 14)
  const pelletMaterial = new THREE.MeshStandardMaterial({
    color: '#ffb703',
    emissive: '#b86a00',
    emissiveIntensity: 0.45,
    roughness: 0.25,
  })
  const treeTierGeometries: THREE.BufferGeometry[] = []
  const treeTierMeshes: THREE.InstancedMesh[] = []
  let treeTrunkGeometry: THREE.BufferGeometry | null = null
  let treeTrunkMesh: THREE.InstancedMesh | null = null
  let treeLeafMaterial: THREE.MeshStandardMaterial | null = null
  let treeTrunkMaterial: THREE.MeshStandardMaterial | null = null
  const mountainGeometries: THREE.BufferGeometry[] = []
  const mountainMeshes: THREE.InstancedMesh[] = []
  let mountainMaterial: THREE.MeshStandardMaterial | null = null
  let pebbleGeometry: THREE.BufferGeometry | null = null
  let pebbleMaterial: THREE.MeshStandardMaterial | null = null
  let pebbleMesh: THREE.InstancedMesh | null = null
  let pelletMesh: THREE.InstancedMesh | null = null
  let pelletCapacity = 0
  let viewportWidth = 1
  let viewportHeight = 1
  let lastFrameTime = performance.now()

  const snakes = new Map<string, SnakeVisual>()
  const lastHeadPositions = new Map<string, THREE.Vector3>()
  const lastForwardDirections = new Map<string, THREE.Vector3>()
  const lastTailDirections = new Map<string, THREE.Vector3>()
  const lastSnakeLengths = new Map<string, number>()
  const tailAddStates = new Map<string, TailAddState>()
  const tailExtraStates = new Map<string, TailExtraState>()
  const lastTailBasePositions = new Map<string, THREE.Vector3>()
  const lastTailExtensionDistances = new Map<string, number>()
  const lastTailTotalLengths = new Map<string, number>()
  const tailGrowthStates = new Map<string, number>()
  const tailDebugStates = new Map<string, TailDebugState>()
  const tongueStates = new Map<string, TongueState>()
  const tempMatrix = new THREE.Matrix4()
  const tempVector = new THREE.Vector3()
  const tempVectorB = new THREE.Vector3()
  const tempVectorC = new THREE.Vector3()
  const tempVectorD = new THREE.Vector3()
  const tempVectorE = new THREE.Vector3()
  const tempVectorF = new THREE.Vector3()
  const tempVectorG = new THREE.Vector3()
  const tempQuat = new THREE.Quaternion()
  const tongueUp = new THREE.Vector3(0, 1, 0)

  {
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
    treeLeafMaterial = leafMaterial
    treeTrunkMaterial = trunkMaterial
    const treeInstanceCount = Math.max(0, TREE_COUNT - MOUNTAIN_COUNT)

    for (let i = 0; i < treeTierHeights.length; i += 1) {
      const height = treeTierHeights[i]
      const radius = treeTierRadii[i]
      const geometry = new THREE.ConeGeometry(radius, height, 6, 1)
      geometry.translate(0, height / 2, 0)
      treeTierGeometries.push(geometry)
      const mesh = new THREE.InstancedMesh(geometry, leafMaterial, TREE_COUNT)
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
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
    treeTrunkMesh.count = treeInstanceCount
    environmentGroup.add(treeTrunkMesh)

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

    const treeNormals: THREE.Vector3[] = []
    const treeScales: THREE.Vector3[] = []
    const minDot = Math.cos(TREE_MIN_ANGLE)
    const minHeightScale = TREE_MIN_HEIGHT / baseTreeHeight
    const maxHeightScale = Math.max(minHeightScale, TREE_MAX_HEIGHT / baseTreeHeight)
    const lakeSampleTemp = new THREE.Vector3()
    const isInLake = (candidate: THREE.Vector3) =>
      sampleLakes(candidate, lakes, lakeSampleTemp).boundary > LAKE_EXCLUSION_THRESHOLD

    const pickSparseNormal = (out: THREE.Vector3) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        randomOnSphere(rng, out)
        if (isInLake(out)) continue
        let ok = true
        for (const existing of treeNormals) {
          if (existing.dot(out) > minDot) {
            ok = false
            break
          }
        }
        if (ok) return out
      }
      for (let attempt = 0; attempt < 40; attempt += 1) {
        randomOnSphere(rng, out)
        if (!isInLake(out)) return out
      }
      return out
    }

    for (let i = 0; i < treeInstanceCount; i += 1) {
      const candidate = new THREE.Vector3()
      pickSparseNormal(candidate)
      const widthScale = randRange(TREE_MIN_SCALE, TREE_MAX_SCALE)
      const heightScale = randRange(minHeightScale, maxHeightScale)
      treeNormals.push(candidate)
      treeScales.push(new THREE.Vector3(widthScale, heightScale, widthScale))
    }

    for (let i = 0; i < treeNormals.length; i += 1) {
      normal.copy(treeNormals[i])
      baseQuat.setFromUnitVectors(up, normal)
      twistQuat.setFromAxisAngle(up, randRange(0, Math.PI * 2))
      baseQuat.multiply(twistQuat)
      baseScale.copy(treeScales[i])
      position.copy(normal).multiplyScalar(PLANET_RADIUS + TREE_BASE_OFFSET - TREE_TRUNK_HEIGHT * 0.12)
      baseMatrix.compose(position, baseQuat, baseScale)

      if (treeTrunkMesh) {
        worldMatrix.copy(baseMatrix)
        treeTrunkMesh.setMatrixAt(i, worldMatrix)
      }

      for (let t = 0; t < treeTierMeshes.length; t += 1) {
        localMatrix.makeTranslation(0, treeTierOffsets[t], 0)
        worldMatrix.copy(baseMatrix).multiply(localMatrix)
        treeTierMeshes[t].setMatrixAt(i, worldMatrix)
      }
    }

    const mountainNormals: THREE.Vector3[] = []
    const mountainScales: THREE.Vector3[] = []
    const mountainMinDot = Math.cos(MOUNTAIN_MIN_ANGLE)
    const pickMountainNormal = (out: THREE.Vector3) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        randomOnSphere(rng, out)
        if (isInLake(out)) continue
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
        if (!isInLake(out)) return out
      }
      return out
    }
    for (let i = 0; i < MOUNTAIN_COUNT; i += 1) {
      const candidate = new THREE.Vector3()
      pickMountainNormal(candidate)
      const radius = randRange(MOUNTAIN_RADIUS_MIN, MOUNTAIN_RADIUS_MAX)
      const height = randRange(MOUNTAIN_HEIGHT_MIN, MOUNTAIN_HEIGHT_MAX)
      mountainNormals.push(candidate)
      mountainScales.push(new THREE.Vector3(radius, height, radius))
    }

    if (mountainMeshes.length > 0) {
      const mountainCounts = new Array(mountainMeshes.length).fill(0)
      for (let i = 0; i < mountainNormals.length; i += 1) {
        const variantIndex = Math.floor(rng() * mountainMeshes.length)
        const mesh = mountainMeshes[variantIndex]
        const instanceIndex = mountainCounts[variantIndex]
        if (!mesh) continue
        normal.copy(mountainNormals[i])
        baseQuat.setFromUnitVectors(up, normal)
        twistQuat.setFromAxisAngle(up, randRange(0, Math.PI * 2))
        baseQuat.multiply(twistQuat)
        baseScale.copy(mountainScales[i])
        position.copy(normal).multiplyScalar(PLANET_RADIUS - MOUNTAIN_BASE_SINK)
        baseMatrix.compose(position, baseQuat, baseScale)
        mesh.setMatrixAt(instanceIndex, baseMatrix)
        mountainCounts[variantIndex] += 1
      }
      for (let i = 0; i < mountainMeshes.length; i += 1) {
        const mesh = mountainMeshes[i]
        mesh.count = mountainCounts[i]
        mesh.instanceMatrix.needsUpdate = true
      }
    }

    if (treeTrunkMesh) {
      treeTrunkMesh.instanceMatrix.needsUpdate = true
    }
    for (const mesh of treeTierMeshes) {
      mesh.instanceMatrix.needsUpdate = true
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
        if (isInLake(normal)) continue
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
        pebbleMesh.setMatrixAt(placed, worldMatrix)
        placed += 1
      }
      pebbleMesh.count = placed
      pebbleMesh.instanceMatrix.needsUpdate = true
    }
  }

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

    const tail = new THREE.Mesh(tailGeometry, tubeMaterial)
    group.add(tail)

    const eyeLeft = new THREE.Mesh(eyeGeometry, eyeMaterial)
    const eyeRight = new THREE.Mesh(eyeGeometry, eyeMaterial)
    const pupilLeft = new THREE.Mesh(pupilGeometry, pupilMaterial)
    const pupilRight = new THREE.Mesh(pupilGeometry, pupilMaterial)
    const tongue = new THREE.Group()
    const tongueBase = new THREE.Mesh(tongueBaseGeometry, tongueMaterial)
    const tongueForkLeft = new THREE.Mesh(tongueForkGeometry, tongueMaterial)
    const tongueForkRight = new THREE.Mesh(tongueForkGeometry, tongueMaterial)
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
      color,
    }
  }

  const updateSnakeMaterial = (material: THREE.MeshStandardMaterial, color: string, isLocal: boolean) => {
    const base = new THREE.Color(color)
    material.color.copy(base)
    material.emissive.copy(base)
    material.emissiveIntensity = isLocal ? 0.3 : 0.12
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

    const bulgeByRing = new Array(ringCount).fill(0)
    const startOffset = Math.min(
      DIGESTION_START_MAX,
      DIGESTION_START_RINGS / Math.max(1, ringCount - 1),
    )
    const influenceRadius = DIGESTION_WIDTH
    for (const digestion of digestions) {
      const strength = clamp(digestion.strength, 0, 1)
      if (strength <= 0) continue
      const t = clamp(digestion.t, 0, 1)
      const mapped = startOffset + t * (1 - startOffset)
      const center = mapped * (ringCount - 1)
      const start = Math.max(0, Math.floor(center - influenceRadius))
      const end = Math.min(ringCount - 1, Math.ceil(center + influenceRadius))
      for (let ring = start; ring <= end; ring += 1) {
        const dist = ring - center
        const normalized = dist / influenceRadius
        const cap = 1 - normalized * normalized
        if (cap <= 0) continue
        const weight = Math.sqrt(cap)
        bulgeByRing[ring] = Math.min(
          DIGESTION_MAX_BULGE,
          bulgeByRing[ring] + weight * DIGESTION_BULGE * strength,
        )
      }
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

  const buildDigestionVisuals = (digestions: number[]) => {
    const visuals: DigestionVisual[] = []
    let tailGrowth = 0

    for (const digestion of digestions) {
      const travelT = clamp(digestion, 0, 1)
      const travelBiased = Math.pow(travelT, DIGESTION_TRAVEL_EASE)
      const growth = clamp(digestion - 1, 0, 1)
      visuals.push({ t: travelBiased, strength: 1 - growth })
      if (growth > tailGrowth) tailGrowth = growth
    }

    return { visuals, tailGrowth }
  }


  const computeTailDirection = (
    curvePoints: THREE.Vector3[],
    centerlineRadius: number,
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
    centerlineRadius: number,
    tailBasisPrev?: THREE.Vector3 | null,
    tailBasisTail?: THREE.Vector3 | null,
    fallbackDirection?: THREE.Vector3 | null,
    preferFallbackBelow?: number,
    overrideDirection?: THREE.Vector3 | null,
  ) => {
    if (extendDistance <= 0 || curvePoints.length < 2) return null
    const tailPos = curvePoints[curvePoints.length - 1]
    const tailNormal = tailPos.clone().normalize()
    let tailDir = overrideDirection
      ? overrideDirection.clone()
      : computeTailDirection(
          curvePoints,
          centerlineRadius,
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
    const angle = extendDistance / centerlineRadius
    let extended: THREE.Vector3
    if (axis.lengthSq() < 1e-8 || !Number.isFinite(angle)) {
      extended = tailPos
        .clone()
        .addScaledVector(tailDir, extendDistance)
        .normalize()
        .multiplyScalar(centerlineRadius)
    } else {
      axis.normalize()
      extended = tailPos
        .clone()
        .applyAxisAngle(axis, angle)
        .normalize()
        .multiplyScalar(centerlineRadius)
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

  const updateTongue = (
    playerId: string,
    visual: SnakeVisual,
    headPosition: THREE.Vector3,
    headNormal: THREE.Vector3,
    forward: THREE.Vector3,
    pellets: Point[] | null,
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
    let matchedIndex = -1
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
        let bestIndex = -1
        let bestPosition: THREE.Vector3 | null = null
        for (let i = 0; i < pellets.length; i += 1) {
          const pellet = pellets[i]
          tempVectorE
            .set(pellet.x, pellet.y, pellet.z)
            .normalize()
            .multiplyScalar(PLANET_RADIUS + PELLET_OFFSET)
          const distSq = tempVectorE.distanceToSquared(state.targetPosition)
          if (distSq < bestDistanceSq) {
            bestDistanceSq = distSq
            bestIndex = i
            bestPosition = tempVectorE.clone()
          }
        }
        const matchThresholdSq = TONGUE_PELLET_MATCH * TONGUE_PELLET_MATCH
        if (bestIndex >= 0 && bestPosition && bestDistanceSq <= matchThresholdSq) {
          matchedIndex = bestIndex
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
          tempVectorE
            .set(pellet.x, pellet.y, pellet.z)
            .normalize()
            .multiplyScalar(PLANET_RADIUS + PELLET_OFFSET)
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
      state.carrying = matchedIndex >= 0 && matchedPosition !== null
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
      if (matchedIndex >= 0 && matchedPosition) {
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
        override = { index: matchedIndex, position: grabbedPos }
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
    gazeRay: GazeRay | null,
    pellets: Point[] | null,
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

    updateSnakeMaterial(visual.tube.material, visual.color, isLocal)
    updateSnakeMaterial(visual.head.material, visual.color, isLocal)

    const nodes = player.snake
    const debug = isTailDebugEnabled() && isLocal
    const maxDigestion =
      player.digestions.length > 0 ? Math.max(...player.digestions) : 0
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
    const centerlineRadius = PLANET_RADIUS + radius * SNAKE_LIFT_FACTOR
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
      const curvePoints = nodes.map((node) => pointToVector(node, centerlineRadius))
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
        start = start.clone().normalize().multiplyScalar(centerlineRadius)

        let blendedEnd = end
        if (referenceDir && referenceDistance > 1e-6) {
          const syntheticEnd = advanceOnSphere(
            start,
            referenceDir,
            referenceDistance,
            centerlineRadius,
          )
          const alignBlend = clamp((tailAddState.progress - 0.35) / 0.35, 0, 1)
          blendedEnd = slerpOnSphere(syntheticEnd, end, alignBlend, centerlineRadius)
        }

        curvePoints[curvePoints.length - 1] = slerpOnSphere(
          start,
          blendedEnd,
          tailAddState.progress,
          centerlineRadius,
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
            centerlineRadius,
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
          centerlineRadius,
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
        tailCurvePrev = curvePoints[curvePoints.length - 2]
        tailCurveTail = curvePoints[curvePoints.length - 1]
        tailExtendDistance = tailCurveTail.distanceTo(tailCurvePrev)
        lastTailTotalLengths.set(player.id, baseLength + extensionDistance)
        lastTailBasePositions.set(player.id, tailCurveTail.clone())
      }
      const baseCurve = new THREE.CatmullRomCurve3(curvePoints, false, 'centripetal')
      const curve = new SphericalCurve(baseCurve, centerlineRadius)
      const tubularSegments = Math.max(8, nodes.length * 4)
      const tubeGeometry = new THREE.TubeGeometry(curve, tubularSegments, radius, 10, false)
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
      return null
    }

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
    const headPosition = headNormal.clone().multiplyScalar(centerlineRadius)
    visual.head.position.copy(headPosition)

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
        const nextPoint = pointToVector(nodes[1], centerlineRadius)
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

    const eyeOut = HEAD_RADIUS * 0.24
    const eyeForward = HEAD_RADIUS * 0.32
    const eyeSpacing = HEAD_RADIUS * 0.72

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

    const gazeTarget =
      isLocal && gazeRay
        ? tempVectorD.copy(gazeRay.origin).addScaledVector(gazeRay.direction, GAZE_FOCUS_DISTANCE)
        : null

    const updatePupil = (eyePosition: THREE.Vector3, eyeNormal: THREE.Vector3, output: THREE.Vector3) => {
      if (gazeTarget) {
        tempVectorE.copy(gazeTarget).sub(eyePosition)
        if (tempVectorE.lengthSq() < 1e-6) {
          tempVectorE.copy(forward)
        }
      } else {
        tempVectorE.copy(forward)
      }
      tempVectorE.normalize()
      const dot = tempVectorE.dot(eyeNormal)
      if (dot < GAZE_MIN_DOT) {
        const blend = clamp((GAZE_MIN_DOT - dot) / (1 - GAZE_MIN_DOT), 0, 1)
        tempVectorE.lerp(eyeNormal, blend).normalize()
      }
      output.copy(eyePosition).addScaledVector(tempVectorE, PUPIL_OFFSET)
    }

    tempVectorF.copy(leftEyePosition).sub(headPosition).normalize()
    updatePupil(leftEyePosition, tempVectorF, visual.pupilLeft.position)
    tempVectorG.copy(rightEyePosition).sub(headPosition).normalize()
    updatePupil(rightEyePosition, tempVectorG, visual.pupilRight.position)

    let tongueOverride: PelletOverride | null = null
    if (isLocal) {
      tongueOverride = updateTongue(player.id, visual, headPosition, headNormal, forward, pellets, deltaSeconds)
    } else {
      visual.tongue.visible = false
      tongueStates.delete(player.id)
    }

    if (nodes.length > 1) {
      const tailPos = tailCurveTail ?? pointToVector(nodes[nodes.length - 1], centerlineRadius)
      const prevPos = tailCurvePrev ?? pointToVector(nodes[nodes.length - 2], centerlineRadius)
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
    lastSnakeLengths.delete(id)
    lastTailDirections.delete(id)
    tailAddStates.delete(id)
    tailExtraStates.delete(id)
    lastTailBasePositions.delete(id)
    lastTailExtensionDistances.delete(id)
    lastTailTotalLengths.delete(id)
    tailGrowthStates.delete(id)
    tailDebugStates.delete(id)
    tongueStates.delete(id)
  }

  const updateSnakes = (
    players: PlayerSnapshot[],
    localPlayerId: string | null,
    deltaSeconds: number,
    gazeRay: GazeRay | null,
    pellets: Point[] | null,
  ): PelletOverride | null => {
    const activeIds = new Set<string>()
    let pelletOverride: PelletOverride | null = null
    for (const player of players) {
      activeIds.add(player.id)
      const override = updateSnake(
        player,
        player.id === localPlayerId,
        deltaSeconds,
        gazeRay,
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

  const updatePellets = (pellets: Point[], override: PelletOverride | null) => {
    const count = pellets.length
    if (!pelletMesh || pelletCapacity !== Math.max(count, 1)) {
      if (pelletMesh) {
        pelletsGroup.remove(pelletMesh)
      }
      pelletCapacity = Math.max(count, 1)
      pelletMesh = new THREE.InstancedMesh(pelletGeometry, pelletMaterial, pelletCapacity)
      pelletsGroup.add(pelletMesh)
    }

    if (!pelletMesh) return
    pelletMesh.count = count
    pelletMesh.visible = count > 0

    for (let i = 0; i < count; i += 1) {
      if (override && override.index === i) {
        tempVector.copy(override.position)
      } else {
        const pellet = pellets[i]
        tempVector
          .set(pellet.x, pellet.y, pellet.z)
          .normalize()
          .multiplyScalar(PLANET_RADIUS + PELLET_OFFSET)
      }
      tempMatrix.makeTranslation(tempVector.x, tempVector.y, tempVector.z)
      pelletMesh.setMatrixAt(i, tempMatrix)
    }
    pelletMesh.instanceMatrix.needsUpdate = true
  }

  const render = (
    snapshot: GameStateSnapshot | null,
    cameraState: Camera,
    localPlayerId: string | null,
    pointer: PointerState | null,
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
    let gazeRay: GazeRay | null = null

    if (pointer?.active && viewportWidth > 0 && viewportHeight > 0) {
      const ndcX = (pointer.screenX / viewportWidth) * 2 - 1
      const ndcY = -(pointer.screenY / viewportHeight) * 2 + 1
      if (Number.isFinite(ndcX) && Number.isFinite(ndcY)) {
        tempVectorD.set(ndcX, ndcY, 0.5).unproject(camera)
        tempQuat.copy(world.quaternion).invert()
        tempVectorD.applyQuaternion(tempQuat)
        tempVectorE.copy(camera.position).applyQuaternion(tempQuat)
        tempVectorF.copy(tempVectorD).sub(tempVectorE)
        if (tempVectorF.lengthSq() > 1e-8) {
          tempVectorF.normalize()
          gazeRay = { origin: tempVectorE.clone(), direction: tempVectorF.clone() }
        }
      }
    }

    if (snapshot) {
      const pelletOverride = updateSnakes(
        snapshot.players,
        localPlayerId,
        deltaSeconds,
        gazeRay,
        snapshot.pellets,
      )
      updatePellets(snapshot.pellets, pelletOverride)

      if (localPlayerId) {
        const localPlayer = snapshot.players.find((player) => player.id === localPlayerId)
        const head = localPlayer?.snake[0]
        if (head) {
          const radius = SNAKE_RADIUS * 1.1
          const centerlineRadius = PLANET_RADIUS + radius * SNAKE_LIFT_FACTOR
          const headNormal = tempVectorC.set(head.x, head.y, head.z).normalize()
          const headPosition = headNormal.clone().multiplyScalar(centerlineRadius)
          headPosition.applyQuaternion(world.quaternion)
          headPosition.project(camera)

          const screenX = (headPosition.x * 0.5 + 0.5) * viewportWidth
          const screenY = (-headPosition.y * 0.5 + 0.5) * viewportHeight
          if (Number.isFinite(screenX) && Number.isFinite(screenY)) {
            localHeadScreen = { x: screenX, y: screenY }
          }
        }
      }
    } else {
      updateSnakes([], localPlayerId, deltaSeconds, gazeRay, null)
      updatePellets([], null)
    }

    renderer.render(scene, camera)
    return localHeadScreen
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
    planetGeometry.dispose()
    planetMaterial.dispose()
    gridGeometry.dispose()
    gridMaterial.dispose()
    for (const mesh of lakeMeshes) {
      world.remove(mesh)
    }
    for (const material of lakeMaterials) {
      material.dispose()
    }
    lakeSurfaceGeometry.dispose()
    for (const mesh of treeTierMeshes) {
      environmentGroup.remove(mesh)
    }
    if (treeTrunkMesh) {
      environmentGroup.remove(treeTrunkMesh)
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
    if (treeTrunkGeometry) {
      treeTrunkGeometry.dispose()
    }
    if (treeLeafMaterial) {
      treeLeafMaterial.dispose()
    }
    if (treeTrunkMaterial) {
      treeTrunkMaterial.dispose()
    }
    for (const geometry of mountainGeometries) {
      geometry.dispose()
    }
    if (mountainMaterial) {
      mountainMaterial.dispose()
    }
    if (pebbleGeometry) {
      pebbleGeometry.dispose()
    }
    if (pebbleMaterial) {
      pebbleMaterial.dispose()
    }
    headGeometry.dispose()
    tailGeometry.dispose()
    eyeGeometry.dispose()
    pupilGeometry.dispose()
    eyeMaterial.dispose()
    pupilMaterial.dispose()
    tongueBaseGeometry.dispose()
    tongueForkGeometry.dispose()
    tongueMaterial.dispose()
    pelletGeometry.dispose()
    pelletMaterial.dispose()
    if (pelletMesh) {
      pelletsGroup.remove(pelletMesh)
    }
    for (const [id, visual] of snakes) {
      removeSnake(visual, id)
    }
    snakes.clear()
  }

  return {
    resize,
    render,
    dispose,
  }
}
