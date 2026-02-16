import { clamp, cross, dot, normalize } from '@game/math'
import type { Point } from '@game/types'
import { NODE_ANGLE, NODE_QUEUE_SIZE } from './constants'

export type SnakeNodeParity = {
  x: number
  y: number
  z: number
  posQueue: Array<Point | null>
}

export type SnakeParityState = {
  nodes: SnakeNodeParity[]
}

const FALLBACK_SPACING = NODE_ANGLE * 2
const MIN_SPACING = NODE_ANGLE * 0.75
const MAX_SPACING = NODE_ANGLE * 3

const lengthOf = (point: Point): number => Math.hypot(point.x, point.y, point.z)

const tangentProject = (direction: Point, normal: Point): Point => {
  const radial = dot(direction, normal)
  return {
    x: direction.x - normal.x * radial,
    y: direction.y - normal.y * radial,
    z: direction.z - normal.z * radial,
  }
}

export function rotateAroundAxis(point: Point, axis: Point, angle: number): Point {
  const u = normalize(axis)
  const cosA = Math.cos(angle)
  const sinA = Math.sin(angle)
  const dotProd = u.x * point.x + u.y * point.y + u.z * point.z
  return normalize({
    x:
      point.x * cosA +
      (u.y * point.z - u.z * point.y) * sinA +
      u.x * dotProd * (1 - cosA),
    y:
      point.y * cosA +
      (u.z * point.x - u.x * point.z) * sinA +
      u.y * dotProd * (1 - cosA),
    z:
      point.z * cosA +
      (u.x * point.y - u.y * point.x) * sinA +
      u.z * dotProd * (1 - cosA),
  })
}

const queueStepAngleFor = (
  node: Point,
  tailNeighbor: Point | null,
  headNeighbor: Point | null,
): { axis: Point; stepAngle: number } | null => {
  let spacing = FALLBACK_SPACING
  if (tailNeighbor) {
    const tailAngle = Math.acos(clamp(dot(node, tailNeighbor), -1, 1))
    if (Number.isFinite(tailAngle) && tailAngle > 1e-6) {
      spacing = clamp(tailAngle, MIN_SPACING, MAX_SPACING)
    }
  } else if (headNeighbor) {
    const headAngle = Math.acos(clamp(dot(node, headNeighbor), -1, 1))
    if (Number.isFinite(headAngle) && headAngle > 1e-6) {
      spacing = clamp(headAngle, MIN_SPACING, MAX_SPACING)
    }
  }

  let trailDirection = { x: 0, y: 0, z: 0 }
  if (tailNeighbor) {
    trailDirection = tangentProject(
      {
        x: tailNeighbor.x - node.x,
        y: tailNeighbor.y - node.y,
        z: tailNeighbor.z - node.z,
      },
      node,
    )
  } else if (headNeighbor) {
    trailDirection = tangentProject(
      {
        x: node.x - headNeighbor.x,
        y: node.y - headNeighbor.y,
        z: node.z - headNeighbor.z,
      },
      node,
    )
  }

  if (lengthOf(trailDirection) <= 1e-8) {
    const fallback = Math.abs(node.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }
    trailDirection = tangentProject(
      {
        x: fallback.x,
        y: fallback.y,
        z: fallback.z,
      },
      node,
    )
  }
  const trailDirNorm = normalize(trailDirection)
  if (lengthOf(trailDirNorm) <= 1e-8) return null
  const axis = normalize(cross(node, trailDirNorm))
  if (lengthOf(axis) <= 1e-8) return null
  const stepAngle = spacing / Math.max(1, NODE_QUEUE_SIZE + 1)
  return {
    axis,
    stepAngle: Math.max(1e-6, stepAngle),
  }
}

const seedNodeQueue = (
  node: Point,
  tailNeighbor: Point | null,
  headNeighbor: Point | null,
): Array<Point | null> => {
  const seeded: Array<Point | null> = []
  const params = queueStepAngleFor(node, tailNeighbor, headNeighbor)
  if (!params) {
    for (let i = 0; i < NODE_QUEUE_SIZE; i += 1) seeded.push(null)
    return seeded
  }
  for (let k = 1; k <= NODE_QUEUE_SIZE; k += 1) {
    seeded.push(rotateAroundAxis(node, params.axis, params.stepAngle * k))
  }
  return seeded
}

export function pointsFromSnakeParityState(state: SnakeParityState): Point[] {
  return state.nodes.map((node) =>
    normalize({
      x: node.x,
      y: node.y,
      z: node.z,
    }),
  )
}

export function cloneSnakeParityState(state: SnakeParityState): SnakeParityState {
  return {
    nodes: state.nodes.map((node) => ({
      x: node.x,
      y: node.y,
      z: node.z,
      posQueue: node.posQueue.map((point) => (point ? { ...point } : null)),
    })),
  }
}

export function createSnakeParityStateFromPoints(snake: Point[]): SnakeParityState {
  const normalized = snake.map((node) => normalize(node))
  const nodes: SnakeNodeParity[] = normalized.map((node, index) => {
    const tailNeighbor = index < normalized.length - 1 ? normalized[index + 1] ?? null : null
    const headNeighbor = index > 0 ? normalized[index - 1] ?? null : null
    return {
      x: node.x,
      y: node.y,
      z: node.z,
      posQueue: seedNodeQueue(node, tailNeighbor, headNeighbor),
    }
  })
  return { nodes }
}

export function rebaseSnakeParityState(
  authoritativeSnake: Point[],
  previousState: SnakeParityState | null,
): SnakeParityState {
  if (!previousState || previousState.nodes.length !== authoritativeSnake.length) {
    return createSnakeParityStateFromPoints(authoritativeSnake)
  }

  const rebased = cloneSnakeParityState(previousState)
  for (let i = 0; i < rebased.nodes.length; i += 1) {
    const node = rebased.nodes[i]
    const nextPoint = normalize(authoritativeSnake[i] ?? { x: node.x, y: node.y, z: node.z })
    const prevPoint = normalize({ x: node.x, y: node.y, z: node.z })
    const axis = cross(prevPoint, nextPoint)
    const axisLen = lengthOf(axis)
    const angle = Math.acos(clamp(dot(prevPoint, nextPoint), -1, 1))
    if (axisLen > 1e-8 && Number.isFinite(angle) && angle > 1e-6) {
      const axisNorm = {
        x: axis.x / axisLen,
        y: axis.y / axisLen,
        z: axis.z / axisLen,
      }
      node.posQueue = node.posQueue.map((queued) =>
        queued ? rotateAroundAxis(queued, axisNorm, angle) : null,
      )
    }
    node.x = nextPoint.x
    node.y = nextPoint.y
    node.z = nextPoint.z
    if (node.posQueue.length < NODE_QUEUE_SIZE) {
      while (node.posQueue.length < NODE_QUEUE_SIZE) {
        node.posQueue.push(null)
      }
    } else if (node.posQueue.length > NODE_QUEUE_SIZE) {
      node.posQueue.splice(NODE_QUEUE_SIZE)
    }
  }
  return rebased
}

export function rotateSnakeAroundAxis(state: SnakeParityState, axis: Point, angle: number): void {
  for (const node of state.nodes) {
    const rotated = rotateAroundAxis({ x: node.x, y: node.y, z: node.z }, axis, angle)
    node.x = rotated.x
    node.y = rotated.y
    node.z = rotated.z
    node.posQueue = node.posQueue.map((queued) =>
      queued ? rotateAroundAxis(queued, axis, angle) : null,
    )
  }
}

export function applySnakeRotationStep(state: SnakeParityState, axis: Point, velocity: number): void {
  let nextPosition: Point | null = null
  for (let index = 0; index < state.nodes.length; index += 1) {
    const node = state.nodes[index]
    if (!node) continue
    const oldPosition = {
      x: node.x,
      y: node.y,
      z: node.z,
    }

    if (index === 0 || !nextPosition) {
      const rotated = rotateAroundAxis(oldPosition, axis, velocity)
      node.x = rotated.x
      node.y = rotated.y
      node.z = rotated.z
    } else {
      node.x = nextPosition.x
      node.y = nextPosition.y
      node.z = nextPosition.z
    }

    node.posQueue.unshift(oldPosition)
    const popped = node.posQueue.pop()
    nextPosition = popped ?? null
  }
}
