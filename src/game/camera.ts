import type { Camera, Point } from './types'
import { cross, dot, normalize, normalizeQuat, quatFromBasis, rotateVectorByQuat, IDENTITY_QUAT } from './math'

export function updateCamera(head: Point | null, current: Camera, upRef: { current: Point }): Camera {
  if (!head) return { q: { ...IDENTITY_QUAT }, active: false }
  const headNorm = normalize(head)
  const currentUp = upRef.current
  const upDot = dot(currentUp, headNorm)
  let projectedUp = {
    x: currentUp.x - headNorm.x * upDot,
    y: currentUp.y - headNorm.y * upDot,
    z: currentUp.z - headNorm.z * upDot,
  }
  let projectedLen = Math.sqrt(
    projectedUp.x * projectedUp.x +
      projectedUp.y * projectedUp.y +
      projectedUp.z * projectedUp.z,
  )
  if (!Number.isFinite(projectedLen) || projectedLen < 1e-3) {
    const fallback = Math.abs(headNorm.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }
    const fallbackDot = dot(fallback, headNorm)
    projectedUp = {
      x: fallback.x - headNorm.x * fallbackDot,
      y: fallback.y - headNorm.y * fallbackDot,
      z: fallback.z - headNorm.z * fallbackDot,
    }
    projectedLen = Math.sqrt(
      projectedUp.x * projectedUp.x +
        projectedUp.y * projectedUp.y +
        projectedUp.z * projectedUp.z,
    )
  }
  projectedUp = normalize(projectedUp)
  upRef.current = projectedUp

  let right = cross(projectedUp, headNorm)
  right = normalize(right)
  let upOrtho = cross(headNorm, right)
  upOrtho = normalize(upOrtho)

  const desired = normalizeQuat(quatFromBasis(right, upOrtho, headNorm))
  return { q: desired, active: true }
}

export function axisFromPointer(angle: number, camera: Camera) {
  const axis = { x: Math.sin(angle), y: Math.cos(angle), z: 0 }
  if (!camera.active) return normalize(axis)
  const inverse = { x: -camera.q.x, y: -camera.q.y, z: -camera.q.z, w: camera.q.w }
  return normalize(rotateVectorByQuat(axis, inverse))
}
