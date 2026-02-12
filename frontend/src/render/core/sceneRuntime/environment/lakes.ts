import * as THREE from 'three'
import type { Environment } from '../../../../game/types'
import {
  DESERT_BIOME_ANGLE,
  DESERT_BIOME_BLEND,
  DESERT_BIOME_CENTER,
  DESERT_BIOME_MIN_DOT,
  DESERT_DUNE_PRIMARY,
  DESERT_DUNE_SECONDARY,
  DESERT_DUNE_TERTIARY,
  DESERT_GROUND_COLOR,
  FOREST_GROUND_COLOR,
  LAKE_CENTER_PIT_RATIO,
  LAKE_CENTER_PIT_START,
  LAKE_EDGE_FALLOFF,
  LAKE_EDGE_SHARPNESS,
  LAKE_GRID_MASK_THRESHOLD,
  LAKE_MAX_ANGLE,
  LAKE_MAX_DEPTH,
  LAKE_MIN_ANGLE,
  LAKE_MIN_DEPTH,
  LAKE_NOISE_AMPLITUDE,
  LAKE_NOISE_FREQ_MAX,
  LAKE_NOISE_FREQ_MIN,
  LAKE_SHELF_CORE,
  LAKE_SHELF_DEPTH_RATIO,
  LAKE_SHORE_DROP_BLEND_END,
  LAKE_SHORE_DROP_BLEND_START,
  LAKE_SHORE_DROP_EXP,
  LAKE_SHORE_DROP_EXTRA_MAX,
  LAKE_SURFACE_DEPTH_EPS,
  LAKE_SURFACE_EXTRA_INSET,
  LAKE_SURFACE_INSET_RATIO,
  LAKE_TERRAIN_CLAMP_EPS,
  LAKE_VISUAL_DEPTH_MULT,
  LAKE_WATER_ALPHA_PULSE,
  LAKE_WATER_EDGE_EXPAND_ANGLE,
  LAKE_WATER_EDGE_EXPAND_BOUNDARY,
  LAKE_WATER_EMISSIVE_BASE,
  LAKE_WATER_FRESNEL_STRENGTH,
  LAKE_WATER_MASK_THRESHOLD,
  LAKE_WATER_OPACITY,
  LAKE_WATER_OVERDRAW,
  LAKE_WATER_SURFACE_LIFT,
  LAKE_WATER_WAVE_SCALE,
  LAKE_WATER_WAVE_SPEED,
  LAKE_WATER_WAVE_STRENGTH,
  PLANET_RADIUS,
  WORLD_RIGHT,
  WORLD_UP,
} from '../constants'
import { clamp, createSeededRandom, randomOnSphere, smoothstep } from '../utils/math'

export type Lake = {
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

export type LakeWaterUniforms = {
  time: { value: number }
}

export type LakeMaterialUserData = {
  lakeWaterUniforms?: LakeWaterUniforms
}

export type TreeInstance = {
  normal: THREE.Vector3
  widthScale: number
  heightScale: number
  twist: number
}

export type MountainInstance = {
  normal: THREE.Vector3
  radius: number
  height: number
  variant: number
  twist: number
  outline: number[]
  tangent: THREE.Vector3
  bitangent: THREE.Vector3
}

export const createLakes = (seed: number, count: number) => {
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
export const buildTangentBasis = (
  normal: THREE.Vector3,
  tangent: THREE.Vector3,
  bitangent: THREE.Vector3,
) => {
  const up = Math.abs(normal.y) < 0.9 ? WORLD_UP : WORLD_RIGHT
  tangent.copy(up).cross(normal).normalize()
  bitangent.copy(normal).cross(tangent).normalize()
}

export const buildLakeFromData = (data: Environment['lakes'][number]) => {
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

export const buildTreeFromData = (data: Environment['trees'][number]): TreeInstance => ({
  normal: new THREE.Vector3(data.normal.x, data.normal.y, data.normal.z).normalize(),
  widthScale: data.widthScale,
  heightScale: data.heightScale,
  twist: data.twist,
})

export const buildMountainFromData = (data: Environment['mountains'][number]): MountainInstance => {
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
export const sampleLakes = (normal: THREE.Vector3, lakes: Lake[], temp: THREE.Vector3) => {
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

export const getLakeTerrainDepth = (sample: ReturnType<typeof sampleLakes>) => {
  if (!sample.lake || sample.boundary <= LAKE_WATER_MASK_THRESHOLD) return 0
  // Keep beds below water so moving actors follow the same terrain shape as the planet mesh.
  return Math.max(sample.depth, sample.lake.surfaceInset + LAKE_TERRAIN_CLAMP_EPS)
}

export const getVisualLakeTerrainDepth = (sample: ReturnType<typeof sampleLakes>) => {
  const baseDepth = getLakeTerrainDepth(sample)
  if (!sample.lake || baseDepth <= 0) return 0
  const boundary = clamp(sample.boundary, 0, 1)
  const shoreBlendRaw =
    1 - smoothstep(LAKE_SHORE_DROP_BLEND_START, LAKE_SHORE_DROP_BLEND_END, boundary)
  const shoreBlend = Math.pow(shoreBlendRaw, LAKE_SHORE_DROP_EXP)
  const deepened = baseDepth * LAKE_VISUAL_DEPTH_MULT + shoreBlend * LAKE_SHORE_DROP_EXTRA_MAX
  return Math.max(deepened, sample.lake.surfaceInset + LAKE_TERRAIN_CLAMP_EPS)
}

export const isDesertBiome = (normal: THREE.Vector3) => normal.dot(DESERT_BIOME_CENTER) >= DESERT_BIOME_MIN_DOT

export const sampleDesertBlend = (normal: THREE.Vector3) => {
  const angle = Math.acos(clamp(normal.dot(DESERT_BIOME_CENTER), -1, 1))
  const start = Math.max(0, DESERT_BIOME_ANGLE - DESERT_BIOME_BLEND)
  const end = DESERT_BIOME_ANGLE + DESERT_BIOME_BLEND
  return 1 - smoothstep(start, end, angle)
}

export const sampleDuneOffset = (normal: THREE.Vector3) => {
  const lon = Math.atan2(normal.z, normal.x)
  const lat = Math.asin(clamp(normal.y, -1, 1))
  const waveA = Math.sin(lon * 3.1 + lat * 1.7)
  const waveB = Math.sin(lon * 5.8 - lat * 2.6 + 1.2)
  const waveC = Math.cos((normal.x * 2.9 + normal.z * 2.15) * Math.PI + lat * 0.75)
  return waveA * DESERT_DUNE_PRIMARY + waveB * DESERT_DUNE_SECONDARY + waveC * DESERT_DUNE_TERTIARY
}

export const applyLakeDepressions = (geometry: THREE.BufferGeometry, lakes: Lake[]) => {
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
export const createLakeSurfaceGeometry = (sampleGeometry: THREE.BufferGeometry, lakes: Lake[]) => {
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

export const createLakeMaskMaterial = (lake: Lake) => {
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

export const createLakeMaterial = () => {
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

export const createShorelineFillGeometry = (planetGeometry: THREE.BufferGeometry, lakes: Lake[]) => {
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
export const createFilteredGridGeometry = (gridGeometry: THREE.BufferGeometry, lakes: Lake[]) => {
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
export const createShorelineGeometry = (gridGeometry: THREE.BufferGeometry, lakes: Lake[]) => {
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
export const isLakeDebugEnabled = () => {
  if (typeof window === 'undefined') return false
  try {
    if ((window as { __LAKE_DEBUG__?: boolean }).__LAKE_DEBUG__ === true) return true
    return window.localStorage.getItem('spherical_snake_lake_debug') === '1'
  } catch {
    return false
  }
}
export const dumpLakeGeometry = (geometry: THREE.BufferGeometry) => {
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
