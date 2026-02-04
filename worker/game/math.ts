import type { Point } from './types'
import { COLLISION_DISTANCE } from './constants'

export function pointFromSpherical(theta: number, phi: number): Point {
  const sinPhi = Math.sin(phi)
  return {
    x: Math.cos(theta) * sinPhi,
    y: Math.sin(theta) * sinPhi,
    z: Math.cos(phi),
  }
}

export function copyPoint(src: Point): Point {
  return { x: src.x, y: src.y, z: src.z }
}

export function length(point: Point) {
  return Math.sqrt(point.x * point.x + point.y * point.y + point.z * point.z)
}

export function normalize(point: Point): Point {
  const len = length(point)
  if (!Number.isFinite(len) || len === 0) return { x: 0, y: 0, z: 0 }
  return { x: point.x / len, y: point.y / len, z: point.z / len }
}

export function dot(a: Point, b: Point) {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function cross(a: Point, b: Point): Point {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

export function rotateZ(point: Point, angle: number) {
  const cosA = Math.cos(angle)
  const sinA = Math.sin(angle)
  const x = point.x
  const y = point.y
  point.x = cosA * x - sinA * y
  point.y = sinA * x + cosA * y
}

export function rotateY(point: Point, angle: number) {
  const cosA = Math.cos(angle)
  const sinA = Math.sin(angle)
  const x = point.x
  const z = point.z
  point.x = cosA * x + sinA * z
  point.z = -sinA * x + cosA * z
}

export function rotateAroundAxis(point: Point, axis: Point, angle: number) {
  const u = normalize(axis)
  const cosA = Math.cos(angle)
  const sinA = Math.sin(angle)
  const ux = u.x
  const uy = u.y
  const uz = u.z
  const x = point.x
  const y = point.y
  const z = point.z
  const dotProd = ux * x + uy * y + uz * z

  point.x = x * cosA + (uy * z - uz * y) * sinA + ux * dotProd * (1 - cosA)
  point.y = y * cosA + (uz * x - ux * z) * sinA + uy * dotProd * (1 - cosA)
  point.z = z * cosA + (ux * y - uy * x) * sinA + uz * dotProd * (1 - cosA)
}

export function rotateToward(current: Point, target: Point, maxAngle: number) {
  const currentNorm = normalize(current)
  const targetNorm = normalize(target)
  const dotValue = clamp(dot(currentNorm, targetNorm), -1, 1)
  const angle = Math.acos(dotValue)
  if (!Number.isFinite(angle) || angle <= maxAngle) return targetNorm
  if (angle === 0) return currentNorm

  const axis = cross(currentNorm, targetNorm)
  const axisLength = length(axis)
  if (axisLength === 0) return currentNorm
  const axisNorm = { x: axis.x / axisLength, y: axis.y / axisLength, z: axis.z / axisLength }
  const rotated = { ...currentNorm }
  rotateAroundAxis(rotated, axisNorm, maxAngle)
  return normalize(rotated)
}

export function randomAxis(): Point {
  const angle = Math.random() * Math.PI * 2
  return { x: Math.cos(angle), y: Math.sin(angle), z: 0 }
}

export function collision(a: Point, b: Point) {
  const dist = Math.sqrt(
    Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2) + Math.pow(a.z - b.z, 2),
  )
  return dist < COLLISION_DISTANCE
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
