import type { Point, Quaternion } from './types'

export const IDENTITY_QUAT: Quaternion = { x: 0, y: 0, z: 0, w: 1 }

export function normalize(point: Point): Point {
  const len = Math.sqrt(point.x * point.x + point.y * point.y + point.z * point.z)
  if (!Number.isFinite(len) || len === 0) return { x: 0, y: 0, z: 0 }
  return { x: point.x / len, y: point.y / len, z: point.z / len }
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function cross(a: Point, b: Point): Point {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

export function dot(a: Point, b: Point) {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function normalizeQuat(q: Quaternion) {
  const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w)
  if (!Number.isFinite(len) || len === 0) return { ...IDENTITY_QUAT }
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len }
}

export function quatFromBasis(right: Point, up: Point, forward: Point): Quaternion {
  const m00 = right.x
  const m01 = right.y
  const m02 = right.z
  const m10 = up.x
  const m11 = up.y
  const m12 = up.z
  const m20 = forward.x
  const m21 = forward.y
  const m22 = forward.z

  const trace = m00 + m11 + m22
  let x = 0
  let y = 0
  let z = 0
  let w = 1

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    w = 0.25 / s
    x = (m21 - m12) * s
    y = (m02 - m20) * s
    z = (m10 - m01) * s
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    w = (m21 - m12) / s
    x = 0.25 * s
    y = (m01 + m10) / s
    z = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    w = (m02 - m20) / s
    x = (m01 + m10) / s
    y = 0.25 * s
    z = (m12 + m21) / s
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
    w = (m10 - m01) / s
    x = (m02 + m20) / s
    y = (m12 + m21) / s
    z = 0.25 * s
  }

  return {
    x,
    y,
    z,
    w,
  }
}

export function rotateVectorByQuat(vector: Point, q: Quaternion) {
  const qv = { x: q.x, y: q.y, z: q.z }
  const uv = cross(qv, vector)
  const uuv = cross(qv, uv)
  return {
    x: vector.x + (uv.x * q.w + uuv.x) * 2,
    y: vector.y + (uv.y * q.w + uuv.y) * 2,
    z: vector.z + (uv.z * q.w + uuv.z) * 2,
  }
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

export function lerpPoint(a: Point, b: Point, t: number): Point {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
  }
}
