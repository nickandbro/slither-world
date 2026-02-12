import * as THREE from 'three'
import { clamp, smoothstep } from '../utils/math'

type TubeParams = { radialSegments: number; tubularSegments: number }

type CreateSnakeOverlapGlowHelpersParams = {
  minArcMult: number
  gridCells: number
  distFullMult: number
  distStartMult: number
  blurRadius: number
  blurPasses: number
}

export type SnakeOverlapGlowHelpers = {
  computeSnakeSelfOverlapPointIntensities: (
    curvePoints: THREE.Vector3[],
    radius: number,
  ) => { intensities: Float32Array; maxIntensity: number }
  getTubeParams: (geometry: THREE.BufferGeometry) => TubeParams | null
  applySnakeSelfOverlapColors: (
    geometry: THREE.BufferGeometry,
    intensities: Float32Array,
    pointCount: number,
  ) => void
}

export const createSnakeOverlapGlowHelpers = ({
  minArcMult,
  gridCells,
  distFullMult,
  distStartMult,
  blurRadius,
  blurPasses,
}: CreateSnakeOverlapGlowHelpersParams): SnakeOverlapGlowHelpers => {
  const snakeSelfOverlapBucketPool = new Map<number, number[]>()
  const snakeSelfOverlapUsedBuckets: number[] = []
  let snakeSelfOverlapCellX = new Int16Array(0)
  let snakeSelfOverlapCellY = new Int16Array(0)
  let snakeSelfOverlapCellZ = new Int16Array(0)
  let snakeSelfOverlapIntensityA = new Float32Array(0)
  let snakeSelfOverlapIntensityB = new Float32Array(0)

  const ensureSnakeSelfOverlapScratch = (pointCount: number) => {
    if (pointCount <= snakeSelfOverlapIntensityA.length) {
      return
    }
    snakeSelfOverlapCellX = new Int16Array(pointCount)
    snakeSelfOverlapCellY = new Int16Array(pointCount)
    snakeSelfOverlapCellZ = new Int16Array(pointCount)
    snakeSelfOverlapIntensityA = new Float32Array(pointCount)
    snakeSelfOverlapIntensityB = new Float32Array(pointCount)
  }

  const computeSnakeSelfOverlapPointIntensities = (
    curvePoints: THREE.Vector3[],
    radius: number,
  ): { intensities: Float32Array; maxIntensity: number } => {
    const pointCount = curvePoints.length
    ensureSnakeSelfOverlapScratch(pointCount)

    for (let i = 0; i < snakeSelfOverlapUsedBuckets.length; i += 1) {
      const key = snakeSelfOverlapUsedBuckets[i]
      const bucket = snakeSelfOverlapBucketPool.get(key)
      if (bucket) bucket.length = 0
    }
    snakeSelfOverlapUsedBuckets.length = 0

    if (!Number.isFinite(radius) || radius <= 1e-6 || pointCount < 3) {
      snakeSelfOverlapIntensityA.fill(0, 0, pointCount)
      return { intensities: snakeSelfOverlapIntensityA, maxIntensity: 0 }
    }

    let segmentSum = 0
    for (let i = 1; i < pointCount; i += 1) {
      segmentSum += curvePoints[i].distanceTo(curvePoints[i - 1])
    }
    const avgSegmentLen = segmentSum / Math.max(1, pointCount - 1)
    const minArc = radius * minArcMult
    const minIndexGap = clamp(
      Math.ceil(minArc / Math.max(1e-6, avgSegmentLen)),
      4,
      Math.max(4, pointCount - 1),
    )

    const cellCount = gridCells
    const distFull = radius * distFullMult
    const distStart = radius * distStartMult
    const distFullSq = distFull * distFull
    const distStartSq = distStart * distStart

    for (let i = 0; i < pointCount; i += 1) {
      const p = curvePoints[i]
      const lenSq = p.x * p.x + p.y * p.y + p.z * p.z
      let nx = 0
      let ny = 1
      let nz = 0
      if (lenSq > 1e-10) {
        const invLen = 1 / Math.sqrt(lenSq)
        nx = p.x * invLen
        ny = p.y * invLen
        nz = p.z * invLen
      }
      let ix = Math.floor((nx * 0.5 + 0.5) * cellCount)
      let iy = Math.floor((ny * 0.5 + 0.5) * cellCount)
      let iz = Math.floor((nz * 0.5 + 0.5) * cellCount)
      ix = clamp(ix, 0, cellCount - 1)
      iy = clamp(iy, 0, cellCount - 1)
      iz = clamp(iz, 0, cellCount - 1)
      snakeSelfOverlapCellX[i] = ix
      snakeSelfOverlapCellY[i] = iy
      snakeSelfOverlapCellZ[i] = iz
      const key = ix + cellCount * (iy + cellCount * iz)
      let bucket = snakeSelfOverlapBucketPool.get(key)
      if (!bucket) {
        bucket = []
        snakeSelfOverlapBucketPool.set(key, bucket)
      }
      if (bucket.length === 0) {
        snakeSelfOverlapUsedBuckets.push(key)
      }
      bucket.push(i)
    }

    const intensities = snakeSelfOverlapIntensityA
    for (let i = 0; i < pointCount; i += 1) {
      const ix = snakeSelfOverlapCellX[i]
      const iy = snakeSelfOverlapCellY[i]
      const iz = snakeSelfOverlapCellZ[i]
      const p = curvePoints[i]
      let minDistSq = Number.POSITIVE_INFINITY
      for (let dz = -1; dz <= 1; dz += 1) {
        const z = iz + dz
        if (z < 0 || z >= cellCount) continue
        for (let dy = -1; dy <= 1; dy += 1) {
          const y = iy + dy
          if (y < 0 || y >= cellCount) continue
          for (let dx = -1; dx <= 1; dx += 1) {
            const x = ix + dx
            if (x < 0 || x >= cellCount) continue
            const key = x + cellCount * (y + cellCount * z)
            const bucket = snakeSelfOverlapBucketPool.get(key)
            if (!bucket || bucket.length === 0) continue
            for (let k = 0; k < bucket.length; k += 1) {
              const j = bucket[k]
              const gap = Math.abs(i - j)
              if (gap <= minIndexGap) continue
              const q = curvePoints[j]
              const dx = p.x - q.x
              const dy = p.y - q.y
              const dz = p.z - q.z
              const distSq = dx * dx + dy * dy + dz * dz
              if (distSq < minDistSq) {
                minDistSq = distSq
                if (minDistSq <= distFullSq) break
              }
            }
            if (minDistSq <= distFullSq) break
          }
          if (minDistSq <= distFullSq) break
        }
        if (minDistSq <= distFullSq) break
      }

      let intensity = 0
      if (minDistSq < distStartSq) {
        intensity = 1 - smoothstep(distFullSq, distStartSq, minDistSq)
      }
      intensities[i] = intensity
    }

    let blurred = intensities
    if (blurPasses > 0 && blurRadius > 0 && pointCount >= 3) {
      let a = intensities
      let b = snakeSelfOverlapIntensityB
      const radiusSamples = Math.floor(blurRadius)
      const passes = Math.floor(blurPasses)
      for (let pass = 0; pass < passes; pass += 1) {
        for (let i = 0; i < pointCount; i += 1) {
          let sum = 0
          let weight = 0
          for (let offset = -radiusSamples; offset <= radiusSamples; offset += 1) {
            const j = i + offset
            if (j < 0 || j >= pointCount) continue
            const w = radiusSamples + 1 - Math.abs(offset)
            sum += a[j] * w
            weight += w
          }
          b[i] = weight > 0 ? sum / weight : 0
        }
        const tmp = a
        a = b
        b = tmp
      }
      blurred = a
    }

    let maxIntensity = 0
    for (let i = 0; i < pointCount; i += 1) {
      maxIntensity = Math.max(maxIntensity, blurred[i] ?? 0)
    }
    return { intensities: blurred, maxIntensity }
  }

  const getTubeParams = (geometry: THREE.BufferGeometry): TubeParams | null => {
    const params = (geometry as unknown as { parameters?: unknown }).parameters as
      | { radialSegments?: number; tubularSegments?: number }
      | undefined
    if (
      params &&
      typeof params.radialSegments === 'number' &&
      typeof params.tubularSegments === 'number'
    ) {
      return {
        radialSegments: params.radialSegments,
        tubularSegments: params.tubularSegments,
      }
    }
    const userParams = (geometry.userData as { snakeTubeParams?: unknown }).snakeTubeParams as
      | { radialSegments?: number; tubularSegments?: number }
      | undefined
    if (
      userParams &&
      typeof userParams.radialSegments === 'number' &&
      typeof userParams.tubularSegments === 'number'
    ) {
      return {
        radialSegments: userParams.radialSegments,
        tubularSegments: userParams.tubularSegments,
      }
    }
    return null
  }

  const applySnakeSelfOverlapColors = (
    geometry: THREE.BufferGeometry,
    intensities: Float32Array,
    pointCount: number,
  ) => {
    const positionAttr = geometry.getAttribute('position')
    if (!(positionAttr instanceof THREE.BufferAttribute)) {
      return
    }
    const params = getTubeParams(geometry)
    if (!params) return
    const radialSegments = params.radialSegments
    const tubularSegments = params.tubularSegments
    const ringVertexCount = radialSegments + 1
    const ringCount = tubularSegments + 1
    const ringDenom = Math.max(1, ringCount - 1)

    const vertexCount = positionAttr.count
    let colorAttr = geometry.getAttribute('color')
    if (!(colorAttr instanceof THREE.BufferAttribute) || colorAttr.count !== vertexCount) {
      const colors = new Float32Array(vertexCount * 3)
      colorAttr = new THREE.BufferAttribute(colors, 3)
      colorAttr.setUsage(THREE.DynamicDrawUsage)
      geometry.setAttribute('color', colorAttr)
    }
    const colors = colorAttr.array as Float32Array
    const scale = pointCount > 1 ? pointCount - 1 : 0
    for (let v = 0; v < vertexCount; v += 1) {
      const ring = ringVertexCount > 0 ? Math.floor(v / ringVertexCount) : 0
      const t = ringDenom > 0 ? ring / ringDenom : 0
      const idx = clamp(Math.round(t * scale), 0, scale)
      const intensity = intensities[idx] ?? 0
      const out = v * 3
      colors[out] = intensity
      colors[out + 1] = intensity
      colors[out + 2] = intensity
    }
    colorAttr.needsUpdate = true
  }

  return {
    computeSnakeSelfOverlapPointIntensities,
    getTubeParams,
    applySnakeSelfOverlapColors,
  }
}
