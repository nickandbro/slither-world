import * as THREE from 'three'
import type { DigestionVisual } from './digestion'
import { clamp, smoothstep } from '../utils/math'

export type TailFrameState = {
  normal: THREE.Vector3
  tangent: THREE.Vector3
}

type TubeParams = {
  radialSegments: number
  tubularSegments: number
}

type DigestionBulgeApplicatorParams = {
  getTubeParams: (tubeGeometry: THREE.BufferGeometry) => TubeParams | null
  digestionWidthMin: number
  digestionWidthMax: number
  digestionBulgeMin: number
  digestionBulgeMax: number
  digestionMaxBulgeMin: number
  digestionMaxBulgeMax: number
}

type TailCapGeometryParams = {
  tailCapSegments: number
  snakeTailCapUSpan: number
}

type StoreTailFrameStateParams = {
  tailFrameStates: Map<string, TailFrameState>
  playerId: string
  tailNormal: THREE.Vector3
  tailDirection: THREE.Vector3
  projectToTangentPlane: (
    direction: THREE.Vector3,
    normal: THREE.Vector3,
  ) => THREE.Vector3 | null
}

export const buildTailCapGeometry = (
  tubeGeometry: THREE.TubeGeometry,
  tailDirection: THREE.Vector3,
  { tailCapSegments, snakeTailCapUSpan }: TailCapGeometryParams,
): THREE.BufferGeometry | null => {
  const params = tubeGeometry.parameters as { radialSegments?: number; tubularSegments?: number }
  const radialSegments = params.radialSegments ?? 8
  const tubularSegments = params.tubularSegments ?? 1
  const ringVertexCount = radialSegments + 1
  const ringStart = tubularSegments * ringVertexCount
  const positions = tubeGeometry.attributes.position
  const uvs = tubeGeometry.attributes.uv
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

  const rings = Math.max(2, tailCapSegments)
  const vertexCount = rings * radialSegments + 1
  const capPositions = new Float32Array(vertexCount * 3)
  const capUvs = new Float32Array(vertexCount * 2)

  let baseU = 1
  if (uvs && uvs.count > ringStart) {
    const candidate = uvs.getX(ringStart)
    if (Number.isFinite(candidate)) baseU = candidate
  }
  const uSpan = Math.max(0, snakeTailCapUSpan)
  // Keep the cap within the current RepeatWrapping cycle so slot colors don't snap across the seam,
  // but still vary u so ring-band stripes flow down the cap instead of flattening out.
  const minU = Math.floor(baseU) + 0.0001
  const capSpan = Math.min(uSpan, Math.max(0, baseU - minU))
  const ringDenom = Math.max(1, rings - 1)

  for (let s = 0; s < rings; s += 1) {
    const theta = (s / rings) * (Math.PI / 2)
    const scale = Math.cos(theta)
    const offset = Math.sin(theta) * radius
    const u = baseU - (s / ringDenom) * capSpan
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

      const uvIndex = (s * radialSegments + i) * 2
      capUvs[uvIndex] = u
      capUvs[uvIndex + 1] = radialSegments > 0 ? i / radialSegments : 0
    }
  }

  const tip = center.clone().addScaledVector(capDir, radius)
  const tipOffset = rings * radialSegments * 3
  capPositions[tipOffset] = tip.x
  capPositions[tipOffset + 1] = tip.y
  capPositions[tipOffset + 2] = tip.z
  const tipUvOffset = rings * radialSegments * 2
  capUvs[tipUvOffset] = baseU - capSpan
  capUvs[tipUvOffset + 1] = 0

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
  capGeometry.setAttribute('uv', new THREE.BufferAttribute(capUvs, 2))
  capGeometry.setIndex(indices)
  capGeometry.computeVertexNormals()
  capGeometry.computeBoundingSphere()
  return capGeometry
}

export const computeDigestionStartOffset = (
  curvePoints: THREE.Vector3[],
  digestionStartNodeIndex: number,
  sourceNodeCount?: number,
) => {
  if (curvePoints.length < 2) return 0
  const hasSourceNodeCount =
    typeof sourceNodeCount === 'number' &&
    Number.isFinite(sourceNodeCount) &&
    sourceNodeCount > 1
  const sourceSegmentCount = hasSourceNodeCount
    ? Math.max(1, Math.round(sourceNodeCount) - 1)
    : Math.max(1, curvePoints.length - 1)
  const startNode = Math.round(clamp(digestionStartNodeIndex, 0, sourceSegmentCount))
  return clamp(startNode / sourceSegmentCount, 0, 0.95)
}

export const createDigestionBulgeApplicator = ({
  getTubeParams,
  digestionWidthMin,
  digestionWidthMax,
  digestionBulgeMin,
  digestionBulgeMax,
  digestionMaxBulgeMin,
  digestionMaxBulgeMax,
}: DigestionBulgeApplicatorParams) => {
  let digestionBulgeScratchA = new Float32Array(0)
  let digestionBulgeScratchB = new Float32Array(0)

  return (
    tubeGeometry: THREE.BufferGeometry,
    digestions: DigestionVisual[],
    headStartOffset: number,
    bulgeScale: number,
    sourceNodeCount?: number,
  ) => {
    if (!digestions.length) return 0
    const params = getTubeParams(tubeGeometry)
    if (!params) return 0
    const radialSegments = params.radialSegments
    const tubularSegments = params.tubularSegments
    const ringVertexCount = radialSegments + 1
    const ringCount = tubularSegments + 1
    const hasSourceNodeCount =
      typeof sourceNodeCount === 'number' &&
      Number.isFinite(sourceNodeCount) &&
      sourceNodeCount > 1
    const sourceSegmentCount = hasSourceNodeCount
      ? Math.max(1, Math.round(sourceNodeCount) - 1)
      : Math.max(1, ringCount - 1)
    const ringsPerSourceSegment = (ringCount - 1) / sourceSegmentCount
    const baselineRingsPerSourceSegment = 4
    const widthScale = clamp(ringsPerSourceSegment / baselineRingsPerSourceSegment, 1, 8)
    const positionsAttr = tubeGeometry.getAttribute('position')
    if (!(positionsAttr instanceof THREE.BufferAttribute)) return 0
    const positions = positionsAttr.array as Float32Array

    if (digestionBulgeScratchA.length < ringCount) {
      digestionBulgeScratchA = new Float32Array(ringCount)
      digestionBulgeScratchB = new Float32Array(ringCount)
    }
    digestionBulgeScratchA.fill(0, 0, ringCount)

    const bulgeByRing = digestionBulgeScratchA
    const startOffset = clamp(headStartOffset, 0, 0.95)
    const headStartRing = Math.ceil(startOffset * Math.max(1, ringCount - 1))
    for (const digestion of digestions) {
      const strength = clamp(digestion.strength, 0, 1)
      if (strength <= 0) continue
      const influenceRadius =
        THREE.MathUtils.lerp(digestionWidthMin, digestionWidthMax, strength) * widthScale
      const bulgeStrength =
        THREE.MathUtils.lerp(digestionBulgeMin, digestionBulgeMax, strength) * bulgeScale
      const t = clamp(digestion.t, 0, 1)
      const mapped = startOffset + t * Math.max(0, 1 - startOffset)
      const center = mapped * (ringCount - 1)
      const start = Math.max(0, Math.floor(center - influenceRadius))
      const end = Math.min(ringCount - 1, Math.ceil(center + influenceRadius))
      const sigma = Math.max(0.5, influenceRadius * 0.7)
      const tailFade = smoothstep(0, 0.016, 1 - mapped)
      const travelFade = tailFade
      if (travelFade <= 0) continue
      for (let ring = start; ring <= end; ring += 1) {
        if (ring < headStartRing) continue
        const dist = ring - center
        const normalized = dist / sigma
        const weight = Math.exp(-0.5 * normalized * normalized)
        bulgeByRing[ring] += weight * bulgeStrength * travelFade
      }
    }
    for (let pass = 0; pass < 2; pass += 1) {
      const source = pass === 0 ? digestionBulgeScratchA : digestionBulgeScratchB
      const dest = pass === 0 ? digestionBulgeScratchB : digestionBulgeScratchA
      for (let ring = 0; ring < ringCount; ring += 1) {
        const prev = source[Math.max(0, ring - 1)] ?? 0
        const current = source[ring] ?? 0
        const next = source[Math.min(ringCount - 1, ring + 1)] ?? 0
        dest[ring] = prev * 0.22 + current * 0.56 + next * 0.22
      }
    }
    for (let ring = 0; ring < ringCount; ring += 1) {
      const distanceToEdge = Math.min(ring, ringCount - 1 - ring)
      const edgeClamp = smoothstep(0, 1.35, distanceToEdge)
      const maxRingBulge = THREE.MathUtils.lerp(
        digestionMaxBulgeMin,
        digestionMaxBulgeMax,
        edgeClamp,
      ) * bulgeScale
      const rawBulge = Math.max(0, bulgeByRing[ring])
      if (rawBulge <= 0) {
        bulgeByRing[ring] = 0
        continue
      }
      const saturated = maxRingBulge * (1 - Math.exp(-rawBulge / Math.max(maxRingBulge, 1e-4)))
      bulgeByRing[ring] = Math.min(maxRingBulge, saturated)
    }

    let maxAppliedBulge = 0
    for (let ring = 0; ring < ringCount; ring += 1) {
      const bulge = bulgeByRing[ring]
      if (bulge <= 0) continue
      if (bulge > maxAppliedBulge) maxAppliedBulge = bulge
      const ringStart = ring * ringVertexCount
      let centerX = 0
      let centerY = 0
      let centerZ = 0
      for (let i = 0; i < radialSegments; i += 1) {
        const index = (ringStart + i) * 3
        centerX += positions[index]
        centerY += positions[index + 1]
        centerZ += positions[index + 2]
      }
      const invCount = radialSegments > 0 ? 1 / radialSegments : 1
      centerX *= invCount
      centerY *= invCount
      centerZ *= invCount

      const scale = 1 + bulge
      for (let i = 0; i < ringVertexCount; i += 1) {
        const index = (ringStart + i) * 3
        const dx = positions[index] - centerX
        const dy = positions[index + 1] - centerY
        const dz = positions[index + 2] - centerZ
        positions[index] = centerX + dx * scale
        positions[index + 1] = centerY + dy * scale
        positions[index + 2] = centerZ + dz * scale
      }
    }

    positionsAttr.needsUpdate = true
    return maxAppliedBulge
  }
}

export const storeTailFrameState = ({
  tailFrameStates,
  playerId,
  tailNormal,
  tailDirection,
  projectToTangentPlane,
}: StoreTailFrameStateParams) => {
  const tangent = projectToTangentPlane(tailDirection, tailNormal)
  if (!tangent) {
    tailFrameStates.delete(playerId)
    return
  }
  const state = tailFrameStates.get(playerId)
  if (state) {
    state.normal.copy(tailNormal)
    state.tangent.copy(tangent)
  } else {
    tailFrameStates.set(playerId, {
      normal: tailNormal.clone(),
      tangent,
    })
  }
}
