import * as THREE from 'three'
import { clamp } from '../utils/math'

export const clampGirthScale = (value: number): number => clamp(value, 1, 2)

export const projectToTangentPlane = (direction: THREE.Vector3, normal: THREE.Vector3) => {
  const projected = direction.clone().addScaledVector(normal, -direction.dot(normal))
  if (projected.lengthSq() <= 1e-8) return null
  return projected.normalize()
}

export const transportDirectionOnSphere = (
  direction: THREE.Vector3,
  fromNormal: THREE.Vector3,
  toNormal: THREE.Vector3,
) => {
  const from = fromNormal.clone().normalize()
  const to = toNormal.clone().normalize()
  const aligned = clamp(from.dot(to), -1, 1)
  const transported = direction.clone()

  if (aligned < 0.999_999) {
    const axis = from.clone().cross(to)
    if (axis.lengthSq() > 1e-10) {
      axis.normalize()
      transported.applyAxisAngle(axis, Math.acos(aligned))
    } else if (aligned < -0.999_999) {
      const fallbackAxis = new THREE.Vector3(1, 0, 0).cross(from)
      if (fallbackAxis.lengthSq() < 1e-8) {
        fallbackAxis.set(0, 1, 0).cross(from)
      }
      if (fallbackAxis.lengthSq() > 1e-8) {
        fallbackAxis.normalize()
        transported.applyAxisAngle(fallbackAxis, Math.PI)
      }
    }
  }

  return projectToTangentPlane(transported, to)
}

const computeTailDirectionFromRecentSegments = (
  curvePoints: THREE.Vector3[],
  tailNormal: THREE.Vector3,
  minSegmentLength: number,
) => {
  const segmentCount = curvePoints.length - 1
  if (segmentCount <= 0) return null
  const sampleCount = Math.min(5, segmentCount)
  const directionAccum = new THREE.Vector3()
  let totalWeight = 0
  const stableLength = Math.max(minSegmentLength, 1e-6)

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const endIndex = curvePoints.length - 1 - sample
    const startIndex = endIndex - 1
    if (startIndex < 0) break
    const endPoint = curvePoints[endIndex]
    const startPoint = curvePoints[startIndex]
    const segment = endPoint.clone().sub(startPoint)
    const segmentLength = segment.length()
    if (segmentLength <= 1e-8) continue

    const endNormal = endPoint.clone().normalize()
    const localTangent = projectToTangentPlane(segment.multiplyScalar(1 / segmentLength), endNormal)
    if (!localTangent) continue

    const transported = transportDirectionOnSphere(localTangent, endNormal, tailNormal)
    if (!transported) continue

    const recencyWeight = 1 / (sample + 1)
    const lengthWeight = clamp(segmentLength / (stableLength * 1.8), 0.05, 1)
    const weight = recencyWeight * lengthWeight
    directionAccum.addScaledVector(transported, weight)
    totalWeight += weight
  }

  if (totalWeight <= 1e-8 || directionAccum.lengthSq() <= 1e-8) return null
  return directionAccum.normalize()
}

export const computeTailExtendDirection = (
  curvePoints: THREE.Vector3[],
  minSegmentLength: number,
  previousDirection?: THREE.Vector3 | null,
  frameState?: { normal: THREE.Vector3; tangent: THREE.Vector3 } | null,
) => {
  if (curvePoints.length < 2) return null
  const tailPos = curvePoints[curvePoints.length - 1]
  const prevPos = curvePoints[curvePoints.length - 2]
  const tailNormal = tailPos.clone().normalize()
  const stableLength = Math.max(minSegmentLength, 1e-6)

  const recentDirection = computeTailDirectionFromRecentSegments(
    curvePoints,
    tailNormal,
    stableLength,
  )
  const frameDirection =
    frameState && frameState.tangent.lengthSq() > 1e-8
      ? transportDirectionOnSphere(frameState.tangent, frameState.normal, tailNormal)
      : null
  const previousProjected =
    previousDirection && previousDirection.lengthSq() > 1e-8
      ? projectToTangentPlane(previousDirection, tailNormal)
      : null
  const alignReference = recentDirection ?? frameDirection ?? previousProjected
  const alignToReference = (direction: THREE.Vector3 | null) => {
    if (!direction || !alignReference) return direction
    if (direction.dot(alignReference) < 0) {
      direction.multiplyScalar(-1)
    }
    return direction
  }

  const recentAligned = alignToReference(recentDirection)
  const frameAligned = alignToReference(frameDirection)
  const previousAligned = alignToReference(previousProjected)

  let chosenDirection: THREE.Vector3 | null
  if (recentAligned && frameAligned) {
    const tailSegmentLength = tailPos.distanceTo(prevPos)
    const tailConfidence = clamp(tailSegmentLength / (stableLength * 1.6), 0, 1)
    const recentWeight = 0.6 + tailConfidence * 0.3
    chosenDirection = frameAligned
      .clone()
      .multiplyScalar(1 - recentWeight)
      .addScaledVector(recentAligned, recentWeight)
  } else {
    chosenDirection = recentAligned?.clone() ?? frameAligned?.clone() ?? previousAligned?.clone() ?? null
  }

  if (!chosenDirection || chosenDirection.lengthSq() <= 1e-8) {
    chosenDirection = projectToTangentPlane(tailPos.clone().sub(prevPos), tailNormal)
  }
  if (!chosenDirection || chosenDirection.lengthSq() <= 1e-8) {
    chosenDirection = previousAligned?.clone() ?? null
  }
  if (!chosenDirection || chosenDirection.lengthSq() <= 1e-8) {
    chosenDirection = tailNormal.clone().cross(new THREE.Vector3(0, 1, 0))
    if (chosenDirection.lengthSq() <= 1e-8) {
      chosenDirection.crossVectors(tailNormal, new THREE.Vector3(1, 0, 0))
    }
  }

  if (chosenDirection.lengthSq() <= 1e-8) return null
  return chosenDirection.normalize()
}

export const computeExtendedTailPoint = (
  curvePoints: THREE.Vector3[],
  extendDistance: number,
  overrideDirection?: THREE.Vector3 | null,
) => {
  if (extendDistance <= 0 || curvePoints.length < 2) return null
  const tailPos = curvePoints[curvePoints.length - 1]
  const tailRadius = tailPos.length()
  if (!Number.isFinite(tailRadius) || tailRadius <= 1e-6) return null
  const tailNormal = tailPos.clone().normalize()
  const tailDir = overrideDirection ? projectToTangentPlane(overrideDirection, tailNormal) : null
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

export type SnakeTubeCache = {
  radialSegments: number
  tubularSegments: number
  ringVertexCount: number
  ringCount: number
  vertexCount: number
  indexCount: number
  positionAttr: THREE.BufferAttribute
  normalAttr: THREE.BufferAttribute
  uvAttr: THREE.BufferAttribute
  indexAttr: THREE.BufferAttribute
  positionArray: Float32Array
  normalArray: Float32Array
  uvArray: Float32Array
  indexArray: Uint16Array | Uint32Array
  circleCos: Float32Array
  circleSin: Float32Array
  tailCap: TailCapCache | null
}

export type TailCapCache = {
  geometry: THREE.BufferGeometry
  radialSegments: number
  rings: number
  flip: boolean
  positionAttr: THREE.BufferAttribute
  uvAttr: THREE.BufferAttribute
  indexAttr: THREE.BufferAttribute
  indexAttrFlipped: THREE.BufferAttribute
  positions: Float32Array
  uvs: Float32Array
}

type SnakeTailVisualRef = {
  tail: {
    geometry: THREE.BufferGeometry
  }
}

export type CreateSnakeTubeGeometryHelpersParams = {
  snakeTubeCaches: Map<string, SnakeTubeCache>
  getTubeParams: (
    geometry: THREE.BufferGeometry,
  ) => { radialSegments: number; tubularSegments: number } | null
  buildTangentBasis: (
    normal: THREE.Vector3,
    tangent: THREE.Vector3,
    bitangent: THREE.Vector3,
  ) => void
  snakeTubeRadialSegments: number
  planetRadius: number
  snakeTailCapUSpan: number
  tailCapSegments: number
  baseTailGeometry: THREE.BufferGeometry
}

export type SnakeTubeGeometryHelpers = {
  applySnakeSkinUVs: (
    geometry: THREE.BufferGeometry,
    snakeStart: number,
    snakeLen: number,
  ) => void
  ensureSnakeTubeCache: (
    playerId: string,
    geometry: THREE.BufferGeometry,
    tubularSegments: number,
  ) => SnakeTubeCache
  updateSnakeTubeGeometry: (
    cache: SnakeTubeCache,
    curve: THREE.CatmullRomCurve3,
    radius: number,
  ) => void
  updateSnakeTailCap: (
    playerId: string,
    visual: SnakeTailVisualRef,
    tubeGeometry: THREE.BufferGeometry,
    tailDirection: THREE.Vector3,
  ) => void
}

export const createSnakeTubeGeometryHelpers = ({
  snakeTubeCaches,
  getTubeParams,
  buildTangentBasis,
  snakeTubeRadialSegments,
  planetRadius,
  snakeTailCapUSpan,
  tailCapSegments,
  baseTailGeometry,
}: CreateSnakeTubeGeometryHelpersParams): SnakeTubeGeometryHelpers => {
  const snakeTubeCircleCos = (() => {
    const radialSegments = snakeTubeRadialSegments
    const ringVertexCount = radialSegments + 1
    const values = new Float32Array(ringVertexCount)
    for (let i = 0; i < ringVertexCount; i += 1) {
      const theta = (i / radialSegments) * Math.PI * 2
      // Match THREE.TubeGeometry's vertex ordering (it uses `cos = -Math.cos( v )`).
      values[i] = -Math.cos(theta)
    }
    return values
  })()
  const snakeTubeCircleSin = (() => {
    const radialSegments = snakeTubeRadialSegments
    const ringVertexCount = radialSegments + 1
    const values = new Float32Array(ringVertexCount)
    for (let i = 0; i < ringVertexCount; i += 1) {
      const theta = (i / radialSegments) * Math.PI * 2
      values[i] = Math.sin(theta)
    }
    return values
  })()

  const snakeTubePointTemp = new THREE.Vector3()
  const snakeTubeTangentTemp = new THREE.Vector3()
  const snakeTubePrevTangentTemp = new THREE.Vector3()
  const snakeTubeNormalTemp = new THREE.Vector3()
  const snakeTubeBinormalTemp = new THREE.Vector3()
  const snakeTubeAxisTemp = new THREE.Vector3()
  const snakeTubeScratchTemp = new THREE.Vector3()
  const SNAKE_TUBE_ARC_LENGTH_DIVISIONS = 200
  const snakeTubeArcLengths = new Float32Array(SNAKE_TUBE_ARC_LENGTH_DIVISIONS + 1)
  const snakeTubeArcPrevPointTemp = new THREE.Vector3()
  const snakeTubeArcCurPointTemp = new THREE.Vector3()
  const snakeTubePrevPointTemp = new THREE.Vector3()
  const snakeTubeNextPointTemp = new THREE.Vector3()

  const tailCapRingVectorsScratch = Array.from(
    { length: snakeTubeRadialSegments },
    () => new THREE.Vector3(),
  )
  const tailCapCenterTemp = new THREE.Vector3()
  const tailCapRingNormalTemp = new THREE.Vector3()
  const tailCapDirTemp = new THREE.Vector3()
  const tailCapTailDirTemp = new THREE.Vector3()

  const applySnakeSkinUVs = (
    geometry: THREE.BufferGeometry,
    snakeStart: number,
    snakeLen: number,
  ) => {
    const uvAttr = geometry.getAttribute('uv')
    if (!(uvAttr instanceof THREE.BufferAttribute)) return
    const params = getTubeParams(geometry)
    if (!params) return
    const radialSegments = params.radialSegments
    const tubularSegments = params.tubularSegments
    const ringVertexCount = radialSegments + 1
    const ringCount = tubularSegments + 1
    const ringDenom = Math.max(1, ringCount - 1)
    const vDenom = Math.max(1, radialSegments)
    const uvArray = uvAttr.array as Float32Array

    const safeStart = Number.isFinite(snakeStart) ? Math.max(0, snakeStart) : 0
    // snakeLen can be fractional (tail extension) so skin patterns advance smoothly as the tail grows.
    const safeLen = Number.isFinite(snakeLen) ? Math.max(0, snakeLen) : 0
    const span = Math.max(0, safeLen)
    for (let ring = 0; ring < ringCount; ring += 1) {
      const t = ring / ringDenom
      const globalIndex = safeStart + t * span
      let u = globalIndex / 8
      // Avoid an exact integer boundary at the tail so RepeatWrapping doesn't snap to u=0 at the seam.
      if (ring === ringCount - 1) {
        u = u - 0.0001
      }
      const ringOffset = ring * ringVertexCount
      for (let i = 0; i < ringVertexCount; i += 1) {
        const v = i / vDenom
        const out = (ringOffset + i) * 2
        uvArray[out] = u
        uvArray[out + 1] = v
      }
    }
    uvAttr.needsUpdate = true
  }

  const buildSnakeTubeIndices = (
    target: Uint16Array | Uint32Array,
    tubularSegments: number,
    radialSegments: number,
    ringVertexCount: number,
  ) => {
    let offset = 0
    for (let i = 0; i < tubularSegments; i += 1) {
      const ring = i * ringVertexCount
      const nextRing = (i + 1) * ringVertexCount
      for (let j = 0; j < radialSegments; j += 1) {
        const a = ring + j
        const b = nextRing + j
        const c = nextRing + j + 1
        const d = ring + j + 1
        target[offset++] = a
        target[offset++] = b
        target[offset++] = d
        target[offset++] = b
        target[offset++] = c
        target[offset++] = d
      }
    }
  }

  const createSnakeTubeCache = (
    geometry: THREE.BufferGeometry,
    tubularSegments: number,
  ): SnakeTubeCache => {
    const radialSegments = snakeTubeRadialSegments
    const ringVertexCount = radialSegments + 1
    const ringCount = tubularSegments + 1
    const vertexCount = ringCount * ringVertexCount
    const indexCount = tubularSegments * radialSegments * 6

    const positionArray = new Float32Array(vertexCount * 3)
    const normalArray = new Float32Array(vertexCount * 3)
    const uvArray = new Float32Array(vertexCount * 2)
    const indexArray: Uint16Array | Uint32Array =
      vertexCount > 0xffff ? new Uint32Array(indexCount) : new Uint16Array(indexCount)
    buildSnakeTubeIndices(indexArray, tubularSegments, radialSegments, ringVertexCount)

    const positionAttr = new THREE.BufferAttribute(positionArray, 3)
    positionAttr.setUsage(THREE.DynamicDrawUsage)
    const normalAttr = new THREE.BufferAttribute(normalArray, 3)
    normalAttr.setUsage(THREE.DynamicDrawUsage)
    const uvAttr = new THREE.BufferAttribute(uvArray, 2)
    uvAttr.setUsage(THREE.DynamicDrawUsage)
    const indexAttr = new THREE.BufferAttribute(indexArray, 1)
    indexAttr.setUsage(THREE.StaticDrawUsage)

    geometry.setAttribute('position', positionAttr)
    geometry.setAttribute('normal', normalAttr)
    geometry.setAttribute('uv', uvAttr)
    geometry.setIndex(indexAttr)
    geometry.setDrawRange(0, indexCount)
    // Snakes always live on/near the planet surface; keep bounds stable to avoid per-frame recomputes.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), planetRadius + 2)
    ;(geometry.userData as { snakeTubeParams?: unknown }).snakeTubeParams = {
      radialSegments,
      tubularSegments,
    }

    return {
      radialSegments,
      tubularSegments,
      ringVertexCount,
      ringCount,
      vertexCount,
      indexCount,
      positionAttr,
      normalAttr,
      uvAttr,
      indexAttr,
      positionArray,
      normalArray,
      uvArray,
      indexArray,
      circleCos: snakeTubeCircleCos,
      circleSin: snakeTubeCircleSin,
      tailCap: null,
    }
  }

  const ensureSnakeTubeCache = (
    playerId: string,
    geometry: THREE.BufferGeometry,
    tubularSegments: number,
  ): SnakeTubeCache => {
    const existing = snakeTubeCaches.get(playerId) ?? null
    if (existing && existing.tubularSegments === tubularSegments) {
      return existing
    }
    const cache = createSnakeTubeCache(geometry, tubularSegments)
    snakeTubeCaches.set(playerId, cache)
    return cache
  }

  const mapArcLengthUToT = (
    arcLengths: Float32Array,
    divisions: number,
    u: number,
    totalLength: number,
  ) => {
    const uu = clamp(u, 0, 1)
    if (!(totalLength > 1e-8) || divisions <= 0) return uu

    const target = uu * totalLength
    let low = 0
    let high = divisions
    while (low <= high) {
      const mid = Math.floor(low + (high - low) * 0.5)
      const diff = (arcLengths[mid] ?? 0) - target
      if (diff < 0) {
        low = mid + 1
      } else if (diff > 0) {
        high = mid - 1
      } else {
        high = mid
        break
      }
    }

    const index = clamp(high, 0, divisions - 1)
    const lengthBefore = arcLengths[index] ?? 0
    const lengthAfter = arcLengths[index + 1] ?? lengthBefore
    const segmentLength = lengthAfter - lengthBefore
    const segmentFraction =
      segmentLength > 1e-8 ? clamp((target - lengthBefore) / segmentLength, 0, 1) : 0
    return (index + segmentFraction) / divisions
  }

  const pickTubeInitialNormal = (tangent: THREE.Vector3, normalOut: THREE.Vector3) => {
    const ax = Math.abs(tangent.x)
    const ay = Math.abs(tangent.y)
    const az = Math.abs(tangent.z)
    if (ax <= ay && ax <= az) {
      normalOut.set(1, 0, 0)
    } else if (ay <= ax && ay <= az) {
      normalOut.set(0, 1, 0)
    } else {
      normalOut.set(0, 0, 1)
    }
    // Match Curve.computeFrenetFrames initial frame selection (TubeGeometry uses this).
    snakeTubeScratchTemp.crossVectors(tangent, normalOut)
    if (snakeTubeScratchTemp.lengthSq() <= 1e-10) {
      // Fallback axis (extremely rare).
      normalOut.set(0, 1, 0)
      snakeTubeScratchTemp.crossVectors(tangent, normalOut)
    }
    if (snakeTubeScratchTemp.lengthSq() <= 1e-10) {
      normalOut.set(0, 0, 1)
      return
    }
    snakeTubeScratchTemp.normalize()

    normalOut.crossVectors(tangent, snakeTubeScratchTemp)
    if (normalOut.lengthSq() <= 1e-10) {
      normalOut.set(0, 0, 1)
    } else {
      normalOut.normalize()
    }
  }

  const updateSnakeTubeGeometry = (
    cache: SnakeTubeCache,
    curve: THREE.CatmullRomCurve3,
    radius: number,
  ) => {
    const tubularSegments = cache.tubularSegments
    const ringVertexCount = cache.ringVertexCount
    const ringCount = cache.ringCount
    if (ringCount <= 1 || ringVertexCount <= 1) return

    const positions = cache.positionArray
    const normals = cache.normalArray
    const circleCos = cache.circleCos
    const circleSin = cache.circleSin

    // CatmullRomCurve3's built-in arc-length helpers allocate (Curve.getLengths() creates new
    // Vector3s). Keep sampling allocation-free by building a small arc-length LUT ourselves and
    // using chord-based tangents between successive rings.
    const arcDivisions = SNAKE_TUBE_ARC_LENGTH_DIVISIONS
    let totalLength = 0
    curve.getPoint(0, snakeTubeArcPrevPointTemp)
    snakeTubeArcLengths[0] = 0
    for (let p = 1; p <= arcDivisions; p += 1) {
      curve.getPoint(p / arcDivisions, snakeTubeArcCurPointTemp)
      totalLength += snakeTubeArcCurPointTemp.distanceTo(snakeTubeArcPrevPointTemp)
      snakeTubeArcLengths[p] = totalLength
      snakeTubeArcPrevPointTemp.copy(snakeTubeArcCurPointTemp)
    }

    const invSegments = tubularSegments > 0 ? 1 / tubularSegments : 0
    curve.getPoint(0, snakeTubePointTemp)
    snakeTubePrevPointTemp.copy(snakeTubePointTemp)

    const t1 = mapArcLengthUToT(snakeTubeArcLengths, arcDivisions, invSegments, totalLength)
    curve.getPoint(t1, snakeTubeNextPointTemp)

    // Initialize frame at the head.
    snakeTubeTangentTemp.copy(snakeTubeNextPointTemp).sub(snakeTubePointTemp)
    if (snakeTubeTangentTemp.lengthSq() <= 1e-10) {
      snakeTubeTangentTemp.set(0, 0, 1)
    } else {
      snakeTubeTangentTemp.normalize()
    }
    pickTubeInitialNormal(snakeTubeTangentTemp, snakeTubeNormalTemp)
    snakeTubeBinormalTemp.crossVectors(snakeTubeTangentTemp, snakeTubeNormalTemp)
    if (snakeTubeBinormalTemp.lengthSq() <= 1e-10) {
      buildTangentBasis(snakeTubeTangentTemp, snakeTubeNormalTemp, snakeTubeBinormalTemp)
    } else {
      snakeTubeBinormalTemp.normalize()
    }
    snakeTubePrevTangentTemp.copy(snakeTubeTangentTemp)

    // Ring 0.
    {
      const ringBase = 0
      for (let j = 0; j < ringVertexCount; j += 1) {
        const cos = circleCos[j] ?? 1
        const sin = circleSin[j] ?? 0
        const nx = snakeTubeNormalTemp.x * cos + snakeTubeBinormalTemp.x * sin
        const ny = snakeTubeNormalTemp.y * cos + snakeTubeBinormalTemp.y * sin
        const nz = snakeTubeNormalTemp.z * cos + snakeTubeBinormalTemp.z * sin
        const out = (ringBase + j) * 3
        positions[out] = snakeTubePointTemp.x + nx * radius
        positions[out + 1] = snakeTubePointTemp.y + ny * radius
        positions[out + 2] = snakeTubePointTemp.z + nz * radius
        normals[out] = nx
        normals[out + 1] = ny
        normals[out + 2] = nz
      }
    }

    for (let i = 1; i <= tubularSegments; i += 1) {
      snakeTubePointTemp.copy(snakeTubeNextPointTemp)
      if (i < tubularSegments) {
        const uNext = (i + 1) * invSegments
        const tNext = mapArcLengthUToT(snakeTubeArcLengths, arcDivisions, uNext, totalLength)
        curve.getPoint(tNext, snakeTubeNextPointTemp)
        snakeTubeTangentTemp.copy(snakeTubeNextPointTemp).sub(snakeTubePrevPointTemp)
      } else {
        snakeTubeTangentTemp.copy(snakeTubePointTemp).sub(snakeTubePrevPointTemp)
      }

      if (snakeTubeTangentTemp.lengthSq() <= 1e-10) {
        snakeTubeTangentTemp.copy(snakeTubePrevTangentTemp)
      } else {
        snakeTubeTangentTemp.normalize()
      }

      snakeTubeAxisTemp.crossVectors(snakeTubePrevTangentTemp, snakeTubeTangentTemp)
      if (snakeTubeAxisTemp.lengthSq() > 1e-12) {
        snakeTubeAxisTemp.normalize()
        const theta = Math.acos(clamp(snakeTubePrevTangentTemp.dot(snakeTubeTangentTemp), -1, 1))
        if (Number.isFinite(theta) && theta > 1e-6) {
          snakeTubeNormalTemp.applyAxisAngle(snakeTubeAxisTemp, theta)
        }
      }
      snakeTubeBinormalTemp.crossVectors(snakeTubeTangentTemp, snakeTubeNormalTemp)
      if (snakeTubeBinormalTemp.lengthSq() <= 1e-10) {
        buildTangentBasis(snakeTubeTangentTemp, snakeTubeNormalTemp, snakeTubeBinormalTemp)
      } else {
        snakeTubeBinormalTemp.normalize()
      }
      snakeTubePrevTangentTemp.copy(snakeTubeTangentTemp)

      const ringBase = i * ringVertexCount
      for (let j = 0; j < ringVertexCount; j += 1) {
        const cos = circleCos[j] ?? 1
        const sin = circleSin[j] ?? 0
        const nx = snakeTubeNormalTemp.x * cos + snakeTubeBinormalTemp.x * sin
        const ny = snakeTubeNormalTemp.y * cos + snakeTubeBinormalTemp.y * sin
        const nz = snakeTubeNormalTemp.z * cos + snakeTubeBinormalTemp.z * sin
        const out = (ringBase + j) * 3
        positions[out] = snakeTubePointTemp.x + nx * radius
        positions[out + 1] = snakeTubePointTemp.y + ny * radius
        positions[out + 2] = snakeTubePointTemp.z + nz * radius
        normals[out] = nx
        normals[out + 1] = ny
        normals[out + 2] = nz
      }

      snakeTubePrevPointTemp.copy(snakeTubePointTemp)
    }

    cache.positionAttr.needsUpdate = true
    cache.normalAttr.needsUpdate = true
  }

  const createTailCapIndexAttributes = (radialSegments: number, rings: number) => {
    const tipIndex = rings * radialSegments
    const indexCount = (rings - 1) * radialSegments * 6 + radialSegments * 3
    const indices = new Uint16Array(indexCount)
    let offset = 0

    // Body quads between rings.
    for (let s = 0; s < rings - 1; s += 1) {
      const ringStart = s * radialSegments
      const nextRingStart = (s + 1) * radialSegments
      for (let i = 0; i < radialSegments; i += 1) {
        const next = (i + 1) % radialSegments
        const a = ringStart + i
        const b = ringStart + next
        const c = nextRingStart + i
        const d = nextRingStart + next
        // Match buildTailCapGeometry's non-flip winding.
        indices[offset++] = a
        indices[offset++] = c
        indices[offset++] = b
        indices[offset++] = b
        indices[offset++] = c
        indices[offset++] = d
      }
    }

    // Tip fan.
    const lastRingStart = (rings - 1) * radialSegments
    for (let i = 0; i < radialSegments; i += 1) {
      const next = (i + 1) % radialSegments
      const a = lastRingStart + i
      const b = lastRingStart + next
      indices[offset++] = a
      indices[offset++] = tipIndex
      indices[offset++] = b
    }

    const flipped = new Uint16Array(indices.length)
    for (let i = 0; i < indices.length; i += 3) {
      flipped[i] = indices[i]!
      flipped[i + 1] = indices[i + 2]!
      flipped[i + 2] = indices[i + 1]!
    }

    const indexAttr = new THREE.BufferAttribute(indices, 1)
    indexAttr.setUsage(THREE.StaticDrawUsage)
    const indexAttrFlipped = new THREE.BufferAttribute(flipped, 1)
    indexAttrFlipped.setUsage(THREE.StaticDrawUsage)
    return { indexAttr, indexAttrFlipped, indexCount }
  }

  const ensureSnakeTailCapCache = (tubeCache: SnakeTubeCache): TailCapCache => {
    const radialSegments = tubeCache.radialSegments
    const rings = Math.max(2, tailCapSegments)
    const existing = tubeCache.tailCap
    if (existing && existing.radialSegments === radialSegments && existing.rings === rings) {
      return existing
    }

    const geometry = new THREE.BufferGeometry()
    const vertexCount = rings * radialSegments + 1
    const positions = new Float32Array(vertexCount * 3)
    const uvs = new Float32Array(vertexCount * 2)
    const positionAttr = new THREE.BufferAttribute(positions, 3)
    positionAttr.setUsage(THREE.DynamicDrawUsage)
    const uvAttr = new THREE.BufferAttribute(uvs, 2)
    uvAttr.setUsage(THREE.DynamicDrawUsage)
    const { indexAttr, indexAttrFlipped, indexCount } = createTailCapIndexAttributes(
      radialSegments,
      rings,
    )

    geometry.setAttribute('position', positionAttr)
    geometry.setAttribute('uv', uvAttr)
    geometry.setIndex(indexAttr)
    geometry.setDrawRange(0, indexCount)
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), planetRadius + 2)
    geometry.computeVertexNormals()

    const cache: TailCapCache = {
      geometry,
      radialSegments,
      rings,
      flip: false,
      positionAttr,
      uvAttr,
      indexAttr,
      indexAttrFlipped,
      positions,
      uvs,
    }
    tubeCache.tailCap = cache
    return cache
  }

  const updateSnakeTailCap = (
    playerId: string,
    visual: SnakeTailVisualRef,
    tubeGeometry: THREE.BufferGeometry,
    tailDirection: THREE.Vector3,
  ) => {
    const tubeCache = snakeTubeCaches.get(playerId) ?? null
    if (!tubeCache) return

    const params = getTubeParams(tubeGeometry)
    if (!params) return
    const radialSegments = params.radialSegments
    const tubularSegments = params.tubularSegments
    if (radialSegments <= 2 || tubularSegments <= 0) return

    const positionsAttr = tubeGeometry.getAttribute('position')
    const uvAttr = tubeGeometry.getAttribute('uv')
    if (!(positionsAttr instanceof THREE.BufferAttribute) || !(uvAttr instanceof THREE.BufferAttribute)) {
      return
    }
    const tubePositions = positionsAttr.array as Float32Array
    const tubeUvs = uvAttr.array as Float32Array

    const ringVertexCount = radialSegments + 1
    const ringStartVertex = tubularSegments * ringVertexCount
    if (positionsAttr.count < ringStartVertex + radialSegments) return

    // Compute center of the last tube ring and cache ring vectors (without the duplicate seam vertex).
    tailCapCenterTemp.set(0, 0, 0)
    for (let i = 0; i < radialSegments; i += 1) {
      const index = (ringStartVertex + i) * 3
      tailCapCenterTemp.x += tubePositions[index]
      tailCapCenterTemp.y += tubePositions[index + 1]
      tailCapCenterTemp.z += tubePositions[index + 2]
    }
    const invCount = radialSegments > 0 ? 1 / radialSegments : 1
    tailCapCenterTemp.multiplyScalar(invCount)

    let radius = 0
    for (let i = 0; i < radialSegments; i += 1) {
      const index = (ringStartVertex + i) * 3
      const vec = tailCapRingVectorsScratch[i]!
      vec.set(
        tubePositions[index] - tailCapCenterTemp.x,
        tubePositions[index + 1] - tailCapCenterTemp.y,
        tubePositions[index + 2] - tailCapCenterTemp.z,
      )
      radius += vec.length()
    }
    radius = radius / radialSegments
    if (!Number.isFinite(radius) || radius <= 1e-8) return

    tailCapRingNormalTemp
      .copy(tailCapRingVectorsScratch[1 % radialSegments]!)
      .cross(tailCapRingVectorsScratch[0]!)
    if (tailCapRingNormalTemp.lengthSq() < 1e-10) return
    tailCapRingNormalTemp.normalize()
    tailCapTailDirTemp.copy(tailDirection)
    if (tailCapTailDirTemp.lengthSq() <= 1e-10) return
    tailCapTailDirTemp.normalize()

    const flip = tailCapRingNormalTemp.dot(tailCapTailDirTemp) < 0
    tailCapDirTemp.copy(tailCapRingNormalTemp)
    if (flip) tailCapDirTemp.multiplyScalar(-1)

    const cap = ensureSnakeTailCapCache(tubeCache)
    if (cap.flip !== flip) {
      cap.flip = flip
      cap.geometry.setIndex(flip ? cap.indexAttrFlipped : cap.indexAttr)
    }

    let baseU = 1
    const baseUvOffset = ringStartVertex * 2
    if (tubeUvs.length >= baseUvOffset + 1) {
      const candidate = tubeUvs[baseUvOffset]
      if (Number.isFinite(candidate)) baseU = candidate
    }

    const uSpan = Math.max(0, snakeTailCapUSpan)
    const minU = Math.floor(baseU) + 0.0001
    const capSpan = Math.min(uSpan, Math.max(0, baseU - minU))
    const ringDenom = Math.max(1, cap.rings - 1)

    const capPositions = cap.positions
    const capUvs = cap.uvs
    const centerX = tailCapCenterTemp.x
    const centerY = tailCapCenterTemp.y
    const centerZ = tailCapCenterTemp.z
    const dirX = tailCapDirTemp.x
    const dirY = tailCapDirTemp.y
    const dirZ = tailCapDirTemp.z

    for (let s = 0; s < cap.rings; s += 1) {
      const theta = (s / cap.rings) * (Math.PI / 2)
      const scale = Math.cos(theta)
      const offset = Math.sin(theta) * radius
      const u = baseU - (s / ringDenom) * capSpan
      for (let i = 0; i < radialSegments; i += 1) {
        const vec = tailCapRingVectorsScratch[i]!
        const out = (s * radialSegments + i) * 3
        capPositions[out] = centerX + vec.x * scale + dirX * offset
        capPositions[out + 1] = centerY + vec.y * scale + dirY * offset
        capPositions[out + 2] = centerZ + vec.z * scale + dirZ * offset

        const uvOut = (s * radialSegments + i) * 2
        capUvs[uvOut] = u
        capUvs[uvOut + 1] = radialSegments > 0 ? i / radialSegments : 0
      }
    }

    const tipOffset = cap.rings * radialSegments * 3
    capPositions[tipOffset] = centerX + dirX * radius
    capPositions[tipOffset + 1] = centerY + dirY * radius
    capPositions[tipOffset + 2] = centerZ + dirZ * radius
    const tipUvOffset = cap.rings * radialSegments * 2
    capUvs[tipUvOffset] = baseU - capSpan
    capUvs[tipUvOffset + 1] = 0

    cap.positionAttr.needsUpdate = true
    cap.uvAttr.needsUpdate = true
    cap.geometry.computeVertexNormals()
    const capNormals = cap.geometry.getAttribute('normal')
    if (capNormals instanceof THREE.BufferAttribute) {
      capNormals.needsUpdate = true
    }

    if (visual.tail.geometry !== cap.geometry) {
      if (visual.tail.geometry !== baseTailGeometry) {
        visual.tail.geometry.dispose()
      }
      visual.tail.geometry = cap.geometry
    }
  }

  return {
    applySnakeSkinUVs,
    ensureSnakeTubeCache,
    updateSnakeTubeGeometry,
    updateSnakeTailCap,
  }
}
