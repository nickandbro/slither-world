import { clamp } from '../../game/math'
import {
  CAMERA_FOV_DEGREES,
  PLANET_RADIUS,
  VIEW_RADIUS_EXTRA_MARGIN,
} from './constants'

export const formatRendererError = (error: unknown) => {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  return 'Renderer initialization failed'
}

const surfaceAngleFromRay = (cameraDistance: number, halfFov: number) => {
  const clampedDistance = Math.max(cameraDistance, PLANET_RADIUS + 1e-3)
  const sinHalf = Math.sin(halfFov)
  const cosHalf = Math.cos(halfFov)
  const underSqrt = PLANET_RADIUS * PLANET_RADIUS - clampedDistance * clampedDistance * sinHalf * sinHalf
  if (underSqrt <= 0) {
    return Math.acos(clamp(PLANET_RADIUS / clampedDistance, -1, 1))
  }
  const rayDistance = clampedDistance * cosHalf - Math.sqrt(underSqrt)
  const hitZ = clampedDistance - rayDistance * cosHalf
  return Math.acos(clamp(hitZ / PLANET_RADIUS, -1, 1))
}

export const computeViewRadius = (cameraDistance: number, aspect: number) => {
  const halfY = (CAMERA_FOV_DEGREES * Math.PI) / 360
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const halfX = Math.atan(Math.tan(halfY) * safeAspect)
  const halfDiag = Math.min(Math.PI * 0.499, Math.hypot(halfX, halfY))
  const base = surfaceAngleFromRay(cameraDistance, halfDiag)
  return clamp(base + VIEW_RADIUS_EXTRA_MARGIN, 0.2, 1.4)
}
