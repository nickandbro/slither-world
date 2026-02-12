import * as THREE from 'three'
import {
  PLANET_OBJECT_HIDE_EXTRA,
  PLANET_OBJECT_VIEW_MARGIN,
  PLANET_RADIUS,
} from '../constants'
import { clamp } from '../utils/math'

const directionTemp = new THREE.Vector3()
const rayDirTemp = new THREE.Vector3()
const occlusionPointTemp = new THREE.Vector3()

export const dotToAngle = (dot: number): number => Math.acos(clamp(dot, -1, 1))

export const isWithinAngularThreshold = (
  center: THREE.Vector3,
  direction: THREE.Vector3,
  threshold: number,
): boolean => dotToAngle(center.dot(direction)) <= threshold

export const isAngularVisible = (
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

export const isDirectionNearSide = (
  x: number,
  y: number,
  z: number,
  cameraLocalDir: THREE.Vector3,
  minDirectionDot: number,
) => {
  const lengthSq = x * x + y * y + z * z
  if (!Number.isFinite(lengthSq) || lengthSq <= 1e-8) return true
  const invLength = 1 / Math.sqrt(lengthSq)
  const directionDot =
    x * invLength * cameraLocalDir.x +
    y * invLength * cameraLocalDir.y +
    z * invLength * cameraLocalDir.z
  return directionDot >= minDirectionDot
}

export const isOccludedByPlanet = (
  point: THREE.Vector3,
  cameraLocalPos: THREE.Vector3,
) => {
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

export const isPointVisible = (
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
