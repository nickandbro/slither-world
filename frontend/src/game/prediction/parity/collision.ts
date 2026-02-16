import type { Environment, Point } from '@game/types'
import { clamp, cross, dot, normalize } from '@game/math'
import {
  CONTACT_ITERATIONS,
  PLANET_RADIUS,
  STICK_THRESHOLD,
  TREE_TRUNK_RADIUS,
} from './constants'
import { sampleOutlineRadius, tangentBasis } from './geometry'
import { applySnakeRotationStep, rotateSnakeAroundAxis, type SnakeParityState } from './snake'

const lengthOf = (point: Point): number => Math.hypot(point.x, point.y, point.z)

const projectTangent = (tangent: Point, normal: Point): Point => {
  if (lengthOf(tangent) < 1e-6) return tangent
  const inward = dot(tangent, normal)
  const projected =
    inward < 0
      ? {
          x: tangent.x - normal.x * inward,
          y: tangent.y - normal.y * inward,
          z: tangent.z - normal.z * inward,
        }
      : tangent
  if (lengthOf(projected) < STICK_THRESHOLD) {
    return { x: 0, y: 0, z: 0 }
  }
  return normalize(projected)
}

const fallbackTangent = (normal: Point): Point => tangentBasis(normal).tangent

const resolveCircleContact = (
  head: Point,
  center: Point,
  radius: number,
  snakeAngularRadius: number,
): { head: Point; normal: Point } | null => {
  const dotValue = clamp(dot(head, center), -1, 1)
  const angle = Math.acos(dotValue)
  const targetAngle = radius + snakeAngularRadius
  if (!Number.isFinite(angle) || angle >= targetAngle) return null

  let dir = {
    x: head.x - center.x * dotValue,
    y: head.y - center.y * dotValue,
    z: head.z - center.z * dotValue,
  }
  if (lengthOf(dir) < 1e-6) {
    dir = fallbackTangent(center)
  }
  const dirNorm = normalize(dir)
  const newHead = normalize({
    x: center.x * Math.cos(targetAngle) + dirNorm.x * Math.sin(targetAngle),
    y: center.y * Math.cos(targetAngle) + dirNorm.y * Math.sin(targetAngle),
    z: center.z * Math.cos(targetAngle) + dirNorm.z * Math.sin(targetAngle),
  })
  return { head: newHead, normal: dirNorm }
}

const resolveMountainContact = (
  head: Point,
  mountain: Environment['mountains'][number],
  snakeAngularRadius: number,
): { head: Point; normal: Point } | null => {
  const dotValue = clamp(dot(head, mountain.normal), -1, 1)
  const angle = Math.acos(dotValue)
  if (!Number.isFinite(angle)) return null

  const { tangent, bitangent } = tangentBasis(mountain.normal)
  let projection = {
    x: head.x - mountain.normal.x * dotValue,
    y: head.y - mountain.normal.y * dotValue,
    z: head.z - mountain.normal.z * dotValue,
  }
  if (lengthOf(projection) < 1e-6) {
    projection = tangent
  }
  const x = dot(projection, tangent)
  const y = dot(projection, bitangent)
  let theta = Math.atan2(y, x)
  if (theta < 0) theta += Math.PI * 2

  const outlineRadius = sampleOutlineRadius(mountain.outline, theta)
  const targetAngle = outlineRadius + snakeAngularRadius
  if (angle >= targetAngle) return null

  const dir = normalize({
    x: tangent.x * x + bitangent.x * y,
    y: tangent.y * x + bitangent.y * y,
    z: tangent.z * x + bitangent.z * y,
  })
  const newHead = normalize({
    x: mountain.normal.x * Math.cos(targetAngle) + dir.x * Math.sin(targetAngle),
    y: mountain.normal.y * Math.cos(targetAngle) + dir.y * Math.sin(targetAngle),
    z: mountain.normal.z * Math.cos(targetAngle) + dir.z * Math.sin(targetAngle),
  })
  return { head: newHead, normal: dir }
}

const resolveHeadCollisions = (
  head: Point,
  axis: Point,
  snakeAngularRadius: number,
  environment: Environment | null,
): { correctedHead: Point; correctedAxis: Point } => {
  if (!environment) {
    return {
      correctedHead: normalize(head),
      correctedAxis: normalize(axis),
    }
  }

  let correctedHead = normalize(head)
  let tangent = cross(axis, correctedHead)
  if (lengthOf(tangent) > 1e-6) {
    tangent = normalize(tangent)
  }

  for (let i = 0; i < CONTACT_ITERATIONS; i += 1) {
    let hadContact = false

    for (const tree of environment.trees) {
      if (tree.widthScale < 0) continue
      const treeRadius = (TREE_TRUNK_RADIUS * tree.widthScale) / PLANET_RADIUS
      const result = resolveCircleContact(correctedHead, tree.normal, treeRadius, snakeAngularRadius)
      if (!result) continue
      correctedHead = result.head
      tangent = projectTangent(tangent, result.normal)
      hadContact = true
    }

    for (const mountain of environment.mountains) {
      const result = resolveMountainContact(correctedHead, mountain, snakeAngularRadius)
      if (!result) continue
      correctedHead = result.head
      tangent = projectTangent(tangent, result.normal)
      hadContact = true
    }

    if (!hadContact) break
  }

  const correctedAxis =
    lengthOf(tangent) < 1e-6 ? normalize(axis) : normalize(cross(correctedHead, tangent))
  return {
    correctedHead,
    correctedAxis,
  }
}

export function applySnakeWithCollisions(
  state: SnakeParityState,
  axis: Point,
  snakeAngularRadius: number,
  stepVelocity: number,
  steps: number,
  environment: Environment | null,
): Point {
  let axisOut = normalize(axis)
  const stepCount = Math.max(1, steps)
  for (let i = 0; i < stepCount; i += 1) {
    applySnakeRotationStep(state, axisOut, stepVelocity)
    if (state.nodes.length === 0) continue

    const headNode = state.nodes[0]
    if (!headNode) continue
    const rawHead = normalize({
      x: headNode.x,
      y: headNode.y,
      z: headNode.z,
    })
    const resolved = resolveHeadCollisions(rawHead, axisOut, snakeAngularRadius, environment)
    const dotValue = clamp(dot(rawHead, resolved.correctedHead), -1, 1)
    const angle = Math.acos(dotValue)
    if (Number.isFinite(angle) && angle > 1e-6) {
      const correctionAxis = cross(rawHead, resolved.correctedHead)
      if (lengthOf(correctionAxis) > 1e-8) {
        rotateSnakeAroundAxis(state, normalize(correctionAxis), angle)
      }
    }
    axisOut = resolved.correctedAxis
  }
  return axisOut
}
