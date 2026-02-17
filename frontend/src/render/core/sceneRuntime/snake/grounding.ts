import * as THREE from 'three'
import type { Point } from '../../../../game/types'

export type SnakeGroundingInfo = {
  minClearance: number
  maxPenetration: number
  maxAppliedLift: number
  sampleCount: number
}

export const createGroundingInfo = (): SnakeGroundingInfo => ({
  minClearance: Number.POSITIVE_INFINITY,
  maxPenetration: 0,
  maxAppliedLift: 0,
  sampleCount: 0,
})

export const finalizeGroundingInfo = (
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

export type CreateSnakeCurveBuilderParams = {
  planetRadius: number
  getTerrainRadius: (normal: THREE.Vector3) => number
  getSnakeCenterlineRadius: (
    normal: THREE.Vector3,
    radiusOffset: number,
    snakeRadius: number,
  ) => number
  buildTangentBasis: (
    normal: THREE.Vector3,
    tangent: THREE.Vector3,
    bitangent: THREE.Vector3,
  ) => void
  snakeContactArcSamples: number
  snakeContactLiftIterations: number
  snakeContactLiftEps: number
  snakeContactClearance: number
  snakeSlopeInsertRadiusDelta: number
  snakeCurveRoundingIterations: number
  snakeCurveRoundingAngleStartDeg: number
  snakeCurveRoundingAngleFullDeg: number
  snakeCurveRoundingBlendMin: number
  snakeCurveRoundingBlendMax: number
}

export type SnakeCurveBuilder = {
  applySnakeContactLift: (
    normal: THREE.Vector3,
    tangent: THREE.Vector3,
    centerlineRadius: number,
    supportRadius: number,
    groundingInfo: SnakeGroundingInfo | null,
  ) => number
  buildSnakeCurvePoints: (
    nodes: Point[],
    radiusOffset: number,
    snakeRadius: number,
    groundingInfo: SnakeGroundingInfo | null,
  ) => THREE.Vector3[]
}

export const createSnakeCurveBuilder = ({
  planetRadius,
  getTerrainRadius,
  getSnakeCenterlineRadius,
  buildTangentBasis,
  snakeContactArcSamples,
  snakeContactLiftIterations,
  snakeContactLiftEps,
  snakeContactClearance,
  snakeSlopeInsertRadiusDelta,
  snakeCurveRoundingIterations,
  snakeCurveRoundingAngleStartDeg,
  snakeCurveRoundingAngleFullDeg,
  snakeCurveRoundingBlendMin,
  snakeCurveRoundingBlendMax,
}: CreateSnakeCurveBuilderParams): SnakeCurveBuilder => {
  const snakeContactCenterTemp = new THREE.Vector3()
  const snakeContactTangentTemp = new THREE.Vector3()
  const snakeContactBitangentTemp = new THREE.Vector3()
  const snakeContactOffsetTemp = new THREE.Vector3()
  const snakeContactPointTemp = new THREE.Vector3()
  const snakeContactNormalTemp = new THREE.Vector3()
  const snakeContactFallbackTemp = new THREE.Vector3()
  const snakeMidpointNormalTemp = new THREE.Vector3()
  const snakeMidpointTangentTemp = new THREE.Vector3()
  const snakeCurveRoundPrevDirTemp = new THREE.Vector3()
  const snakeCurveRoundNextDirTemp = new THREE.Vector3()
  const snakeCurveRoundMidpointTemp = new THREE.Vector3()

  // Allocation-light snake curve generation scratch. Reused across all snakes each frame.
  const snakeCurvePointsScratch: THREE.Vector3[] = []
  const snakeCurvePointsSmoothScratch: THREE.Vector3[] = []
  const snakeNodeNormalsScratch: THREE.Vector3[] = []
  const snakeNodeTangentsScratch: THREE.Vector3[] = []
  let snakeNodeRadiiScratch = new Float32Array(0)
  const roundIterations = Math.max(0, Math.floor(snakeCurveRoundingIterations))
  const roundAngleStartDeg = Math.max(0, snakeCurveRoundingAngleStartDeg)
  const roundAngleFullDeg = Math.max(roundAngleStartDeg + 1e-6, snakeCurveRoundingAngleFullDeg)
  const roundBlendMin = Math.max(0, snakeCurveRoundingBlendMin)
  const roundBlendMax = Math.max(roundBlendMin, snakeCurveRoundingBlendMax)

  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

  const smoothstep = (edge0: number, edge1: number, x: number) => {
    const t = clamp((x - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1)
    return t * t * (3 - 2 * t)
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
    const sampleCount = Math.max(3, snakeContactArcSamples)
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
    for (let iteration = 0; iteration < snakeContactLiftIterations; iteration += 1) {
      const lift = sampleSnakeContactLift(
        normal,
        tangent,
        liftedRadius,
        supportRadius,
        snakeContactClearance,
        null,
      )
      if (lift <= snakeContactLiftEps) break
      liftedRadius += lift
      totalLift += lift
    }
    if (groundingInfo) {
      sampleSnakeContactLift(
        normal,
        tangent,
        liftedRadius,
        supportRadius,
        snakeContactClearance,
        groundingInfo,
      )
      groundingInfo.maxAppliedLift = Math.max(groundingInfo.maxAppliedLift, totalLift)
    }
    return totalLift
  }

  const ensureVectorScratchCapacity = (scratch: THREE.Vector3[], capacity: number) => {
    for (let i = scratch.length; i < capacity; i += 1) {
      scratch.push(new THREE.Vector3())
    }
  }

  const writeChaikinPoint = (
    out: THREE.Vector3,
    a: THREE.Vector3,
    b: THREE.Vector3,
    t: number,
  ) => {
    out.copy(a).lerp(b, t)
    const radiusA = a.length()
    const radiusB = b.length()
    const targetRadius = radiusA + (radiusB - radiusA) * t
    if (out.lengthSq() <= 1e-10) {
      out.copy(a)
    }
    if (targetRadius > 1e-8) {
      out.normalize().multiplyScalar(targetRadius)
    }
  }

  const writeRoundedInteriorPoint = (
    out: THREE.Vector3,
    prev: THREE.Vector3,
    curr: THREE.Vector3,
    next: THREE.Vector3,
  ) => {
    snakeCurveRoundPrevDirTemp.copy(curr).sub(prev)
    snakeCurveRoundNextDirTemp.copy(next).sub(curr)
    const prevLen = snakeCurveRoundPrevDirTemp.length()
    const nextLen = snakeCurveRoundNextDirTemp.length()
    if (prevLen <= 1e-8 || nextLen <= 1e-8) {
      out.copy(curr)
      return
    }
    snakeCurveRoundPrevDirTemp.multiplyScalar(1 / prevLen)
    snakeCurveRoundNextDirTemp.multiplyScalar(1 / nextLen)
    const bendDot = clamp(
      snakeCurveRoundPrevDirTemp.dot(snakeCurveRoundNextDirTemp),
      -1,
      1,
    )
    const bendDeg = (Math.acos(bendDot) * 180) / Math.PI
    if (!Number.isFinite(bendDeg)) {
      out.copy(curr)
      return
    }
    const roundT = smoothstep(roundAngleStartDeg, roundAngleFullDeg, bendDeg)
    if (roundT <= 1e-6) {
      out.copy(curr)
      return
    }
    const blend = roundBlendMin + (roundBlendMax - roundBlendMin) * roundT
    snakeCurveRoundMidpointTemp.copy(prev).add(next).multiplyScalar(0.5)
    out.copy(curr).lerp(snakeCurveRoundMidpointTemp, blend)

    const currRadius = curr.length()
    const neighborRadius = (prev.length() + next.length()) * 0.5
    const targetRadius = currRadius + (neighborRadius - currRadius) * blend
    if (out.lengthSq() <= 1e-10) {
      out.copy(curr)
    }
    if (targetRadius > 1e-8) {
      out.normalize().multiplyScalar(targetRadius)
    }
  }

  const buildSnakeCurvePoints = (
    nodes: Point[],
    radiusOffset: number,
    snakeRadius: number,
    groundingInfo: SnakeGroundingInfo | null,
  ) => {
    if (nodes.length === 0) {
      snakeCurvePointsScratch.length = 0
      return snakeCurvePointsScratch
    }

    ensureVectorScratchCapacity(snakeNodeNormalsScratch, nodes.length)
    ensureVectorScratchCapacity(snakeNodeTangentsScratch, nodes.length)
    // Midpoint insertion can (worst case) double the number of curve points.
    ensureVectorScratchCapacity(snakeCurvePointsScratch, nodes.length * 2 + 2)

    if (snakeNodeRadiiScratch.length < nodes.length) {
      const nextSize = Math.max(
        nodes.length,
        snakeNodeRadiiScratch.length > 0 ? snakeNodeRadiiScratch.length * 2 : 64,
      )
      snakeNodeRadiiScratch = new Float32Array(nextSize)
    }

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]!
      const normal = snakeNodeNormalsScratch[i]!
      normal.set(node.x, node.y, node.z)
      if (normal.lengthSq() <= 1e-10) {
        normal.set(0, 0, 1)
      } else {
        normal.normalize()
      }
    }

    for (let i = 0; i < nodes.length; i += 1) {
      const normal = snakeNodeNormalsScratch[i]!
      snakeContactFallbackTemp.set(0, 0, 0)
      if (i + 1 < nodes.length) {
        snakeContactFallbackTemp.add(snakeNodeNormalsScratch[i + 1]!).addScaledVector(normal, -1)
      }
      if (i > 0) {
        snakeContactFallbackTemp.add(normal).addScaledVector(snakeNodeNormalsScratch[i - 1]!, -1)
      }
      snakeContactFallbackTemp.addScaledVector(normal, -snakeContactFallbackTemp.dot(normal))
      if (snakeContactFallbackTemp.lengthSq() <= 1e-8) {
        buildTangentBasis(normal, snakeContactFallbackTemp, snakeContactOffsetTemp)
      } else {
        snakeContactFallbackTemp.normalize()
      }
      snakeNodeTangentsScratch[i]!.copy(snakeContactFallbackTemp)
    }

    for (let i = 0; i < nodes.length; i += 1) {
      const normal = snakeNodeNormalsScratch[i]!
      const tangent = snakeNodeTangentsScratch[i]!
      let nodeRadius = getSnakeCenterlineRadius(normal, radiusOffset, snakeRadius)
      nodeRadius += applySnakeContactLift(
        normal,
        tangent,
        nodeRadius,
        snakeRadius,
        groundingInfo,
      )
      snakeNodeRadiiScratch[i] = nodeRadius
    }

    let prevNormal: THREE.Vector3 | null = null
    let prevTangent: THREE.Vector3 | null = null
    let prevRadius = snakeNodeRadiiScratch[0] ?? (planetRadius + radiusOffset)
    let writeIndex = 0

    for (let i = 0; i < nodes.length; i += 1) {
      const normal = snakeNodeNormalsScratch[i]!
      const tangent = snakeNodeTangentsScratch[i]!
      const nodeRadius = snakeNodeRadiiScratch[i] ?? (planetRadius + radiusOffset)
      if (
        prevNormal &&
        prevTangent &&
        i > 1 &&
        i < nodes.length - 1 &&
        Math.abs(nodeRadius - prevRadius) >= snakeSlopeInsertRadiusDelta
      ) {
        snakeMidpointNormalTemp.copy(prevNormal!).add(normal)
        if (snakeMidpointNormalTemp.lengthSq() > 1e-8) {
          snakeMidpointNormalTemp.normalize()
        } else {
          snakeMidpointNormalTemp.copy(normal)
        }
        snakeMidpointTangentTemp.copy(prevTangent!).add(tangent)
        snakeMidpointTangentTemp.addScaledVector(
          snakeMidpointNormalTemp,
          -snakeMidpointTangentTemp.dot(snakeMidpointNormalTemp),
        )
        if (snakeMidpointTangentTemp.lengthSq() <= 1e-8) {
          buildTangentBasis(snakeMidpointNormalTemp, snakeMidpointTangentTemp, snakeContactOffsetTemp)
        } else {
          snakeMidpointTangentTemp.normalize()
        }
        let midpointRadius = getSnakeCenterlineRadius(
          snakeMidpointNormalTemp,
          radiusOffset,
          snakeRadius,
        )
        midpointRadius += applySnakeContactLift(
          snakeMidpointNormalTemp,
          snakeMidpointTangentTemp,
          midpointRadius,
          snakeRadius,
          groundingInfo,
        )
        snakeCurvePointsScratch[writeIndex]!
          .copy(snakeMidpointNormalTemp)
          .multiplyScalar(midpointRadius)
        writeIndex += 1
      }

      snakeCurvePointsScratch[writeIndex]!.copy(normal).multiplyScalar(nodeRadius)
      writeIndex += 1
      prevNormal = normal
      prevTangent = tangent
      prevRadius = nodeRadius
    }

    snakeCurvePointsScratch.length = writeIndex
    if (writeIndex < 4) {
      return snakeCurvePointsScratch
    }

    // Smooth sharp turns by corner-cutting the rendered centerline.
    // This keeps gameplay/collision nodes authoritative while making visual loops rounder.
    ensureVectorScratchCapacity(snakeCurvePointsSmoothScratch, writeIndex * 2 + 2)
    let smoothWriteIndex = 0
    snakeCurvePointsSmoothScratch[smoothWriteIndex]!.copy(snakeCurvePointsScratch[0]!)
    smoothWriteIndex += 1
    for (let i = 0; i < writeIndex - 1; i += 1) {
      const p0 = snakeCurvePointsScratch[i]!
      const p1 = snakeCurvePointsScratch[i + 1]!
      writeChaikinPoint(snakeCurvePointsSmoothScratch[smoothWriteIndex]!, p0, p1, 0.25)
      smoothWriteIndex += 1
      writeChaikinPoint(snakeCurvePointsSmoothScratch[smoothWriteIndex]!, p0, p1, 0.75)
      smoothWriteIndex += 1
    }
    snakeCurvePointsSmoothScratch[smoothWriteIndex]!
      .copy(snakeCurvePointsScratch[writeIndex - 1]!)
    smoothWriteIndex += 1
    snakeCurvePointsSmoothScratch.length = smoothWriteIndex
    if (smoothWriteIndex < 4 || roundIterations <= 0) {
      return snakeCurvePointsSmoothScratch
    }

    ensureVectorScratchCapacity(snakeCurvePointsScratch, smoothWriteIndex)
    snakeCurvePointsScratch.length = smoothWriteIndex
    let roundSource = snakeCurvePointsSmoothScratch
    let roundTarget = snakeCurvePointsScratch
    const lastIndex = smoothWriteIndex - 1
    for (let iter = 0; iter < roundIterations; iter += 1) {
      roundTarget[0]!.copy(roundSource[0]!)
      for (let i = 1; i < lastIndex; i += 1) {
        writeRoundedInteriorPoint(
          roundTarget[i]!,
          roundSource[i - 1]!,
          roundSource[i]!,
          roundSource[i + 1]!,
        )
      }
      roundTarget[lastIndex]!.copy(roundSource[lastIndex]!)
      const nextSource = roundTarget
      roundTarget = roundSource
      roundSource = nextSource
    }
    roundSource.length = smoothWriteIndex
    return roundSource
  }

  return {
    applySnakeContactLift,
    buildSnakeCurvePoints,
  }
}
