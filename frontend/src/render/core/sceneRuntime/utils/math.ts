import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils'
import {
  PLANET_PATCH_OUTER_MAX,
  PLANET_PATCH_OUTER_MIN,
  PLANET_RADIUS,
} from '../constants'

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
export const smoothValue = (current: number, target: number, deltaSeconds: number, rateUp: number, rateDown: number) => {
  const rate = target >= current ? rateUp : rateDown
  const alpha = 1 - Math.exp(-rate * Math.max(0, deltaSeconds))
  return current + (target - current) * alpha
}

export const smoothUnitVector = (
  current: THREE.Vector3,
  target: THREE.Vector3,
  deltaSeconds: number,
  rate: number,
) => {
  const alpha = 1 - Math.exp(-Math.max(0, rate) * Math.max(0, deltaSeconds))
  current.lerp(target, alpha)
  if (current.lengthSq() <= 1e-10) {
    current.copy(target)
  }
  current.normalize()
  return current
}

export const surfaceAngleFromRay = (cameraDistance: number, halfFov: number) => {
  const clampedDistance = Math.max(cameraDistance, PLANET_RADIUS + 1e-3)
  const sinHalf = Math.sin(halfFov)
  const cosHalf = Math.cos(halfFov)
  const under = PLANET_RADIUS * PLANET_RADIUS - clampedDistance * clampedDistance * sinHalf * sinHalf
  if (under <= 0) {
    return Math.acos(clamp(PLANET_RADIUS / clampedDistance, -1, 1))
  }
  const rayDistance = clampedDistance * cosHalf - Math.sqrt(under)
  const hitZ = clampedDistance - rayDistance * cosHalf
  return Math.acos(clamp(hitZ / PLANET_RADIUS, -1, 1))
}

export const computeVisibleSurfaceAngle = (cameraDistance: number, aspect: number) => {
  const halfY = (40 * Math.PI) / 360
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const halfX = Math.atan(Math.tan(halfY) * safeAspect)
  const halfDiag = Math.min(Math.PI * 0.499, Math.hypot(halfX, halfY))
  const base = surfaceAngleFromRay(cameraDistance, halfDiag)
  return clamp(base, PLANET_PATCH_OUTER_MIN, PLANET_PATCH_OUTER_MAX)
}
export const createMountainGeometry = (seed: number) => {
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
export const createSeededRandom = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export const createIcosphereGeometry = (radius: number, detail: number) => {
  const clampedDetail = Math.max(0, Math.floor(detail))
  const geometry = new THREE.IcosahedronGeometry(radius, clampedDetail)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

export const bucketIndexFromDirection = (
  normal: THREE.Vector3,
  bands: number,
  slices: number,
) => {
  const latitude = Math.asin(clamp(normal.y, -1, 1))
  const longitude = Math.atan2(normal.z, normal.x)
  const band = clamp(
    Math.floor(((latitude + Math.PI * 0.5) / Math.PI) * bands),
    0,
    bands - 1,
  )
  const slice = clamp(
    Math.floor(((longitude + Math.PI) / (Math.PI * 2)) * slices),
    0,
    slices - 1,
  )
  return { band, slice }
}


export const randomOnSphere = (rand: () => number, target = new THREE.Vector3()) => {
  const theta = rand() * Math.PI * 2
  const z = rand() * 2 - 1
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  target.set(r * Math.cos(theta), z, r * Math.sin(theta))
  return target
}
