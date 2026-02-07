import { updateCamera } from '../../game/camera'
import { IDENTITY_QUAT, clamp, normalize, normalizeQuat } from '../../game/math'
import type { Camera, Point } from '../../game/types'

export type MenuPhase = 'preplay' | 'spawning' | 'playing'

export type MenuFlowDebugInfo = {
  phase: MenuPhase
  hasSpawned: boolean
  cameraBlend: number
  cameraDistance: number
}

export const MENU_CAMERA_TARGET: Point = normalize({ x: 0.06, y: 0.992, z: 0.11 })

const createMenuCamera = () => {
  const upRef = { current: { x: 0, y: 1, z: 0 } }
  const camera = updateCamera(MENU_CAMERA_TARGET, upRef)
  if (camera.active) return camera
  return { q: { ...IDENTITY_QUAT }, active: true }
}

export const MENU_CAMERA = createMenuCamera()

export const easeInOutCubic = (t: number) => {
  if (t <= 0) return 0
  if (t >= 1) return 1
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

export const slerpQuaternion = (a: Camera['q'], b: Camera['q'], t: number): Camera['q'] => {
  const clampedT = clamp(t, 0, 1)
  if (clampedT <= 0) return a
  if (clampedT >= 1) return b

  let bx = b.x
  let by = b.y
  let bz = b.z
  let bw = b.w
  let cosHalfTheta = a.x * bx + a.y * by + a.z * bz + a.w * bw

  if (cosHalfTheta < 0) {
    cosHalfTheta = -cosHalfTheta
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }

  if (cosHalfTheta > 0.9995) {
    return normalizeQuat({
      x: a.x + (bx - a.x) * clampedT,
      y: a.y + (by - a.y) * clampedT,
      z: a.z + (bz - a.z) * clampedT,
      w: a.w + (bw - a.w) * clampedT,
    })
  }

  const halfTheta = Math.acos(clamp(cosHalfTheta, -1, 1))
  const sinHalfTheta = Math.sqrt(1 - cosHalfTheta * cosHalfTheta)
  if (!Number.isFinite(sinHalfTheta) || sinHalfTheta < 1e-6) {
    return normalizeQuat({
      x: a.x + (bx - a.x) * clampedT,
      y: a.y + (by - a.y) * clampedT,
      z: a.z + (bz - a.z) * clampedT,
      w: a.w + (bw - a.w) * clampedT,
    })
  }

  const ratioA = Math.sin((1 - clampedT) * halfTheta) / sinHalfTheta
  const ratioB = Math.sin(clampedT * halfTheta) / sinHalfTheta
  return {
    x: a.x * ratioA + bx * ratioB,
    y: a.y * ratioA + by * ratioB,
    z: a.z * ratioA + bz * ratioB,
    w: a.w * ratioA + bw * ratioB,
  }
}
