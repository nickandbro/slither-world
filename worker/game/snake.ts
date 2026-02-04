import type { Point, SnakeNode } from './types'
import { NODE_ANGLE, NODE_QUEUE_SIZE, STARTING_LENGTH } from './constants'
import { copyPoint, rotateAroundAxis, rotateY, rotateZ } from './math'

export function addSnakeNode(snake: SnakeNode[], axis: Point) {
  const snakeNode: SnakeNode = {
    x: 0,
    y: 0,
    z: -1,
    posQueue: [],
  }

  for (let i = 0; i < NODE_QUEUE_SIZE; i += 1) {
    snakeNode.posQueue.push(null)
  }

  if (snake.length > 0) {
    const last = snake[snake.length - 1]
    const lastPos = last.posQueue[NODE_QUEUE_SIZE - 1]

    if (lastPos === null) {
      snakeNode.x = last.x
      snakeNode.y = last.y
      snakeNode.z = last.z
      rotateAroundAxis(snakeNode, axis, -NODE_ANGLE * 2)
    } else {
      snakeNode.x = lastPos.x
      snakeNode.y = lastPos.y
      snakeNode.z = lastPos.z
    }
  }

  snake.push(snakeNode)
}

export function applySnakeRotationStep(snake: SnakeNode[], axis: Point, velocity: number) {
  let nextPosition: Point | null = null

  for (let i = 0; i < snake.length; i += 1) {
    const node = snake[i]
    const oldPosition = copyPoint(node)

    if (i === 0) {
      rotateAroundAxis(node, axis, velocity)
    } else if (nextPosition === null) {
      rotateAroundAxis(node, axis, velocity)
    } else {
      node.x = nextPosition.x
      node.y = nextPosition.y
      node.z = nextPosition.z
    }

    node.posQueue.unshift(oldPosition)
    nextPosition = node.posQueue.pop() ?? null
  }
}

export function applySnakeRotation(
  snake: SnakeNode[],
  axis: Point,
  stepVelocity: number,
  steps = 1,
) {
  const stepCount = Math.max(1, Math.floor(steps))
  for (let i = 0; i < stepCount; i += 1) {
    applySnakeRotationStep(snake, axis, stepVelocity)
  }
}

export function createSnake(axis: Point) {
  const snake: SnakeNode[] = []
  for (let i = 0; i < STARTING_LENGTH; i += 1) {
    addSnakeNode(snake, axis)
  }
  return snake
}

export function rotateSnake(snake: SnakeNode[], zAngle: number, yAngle: number) {
  for (const node of snake) {
    rotateY(node, yAngle)
    rotateZ(node, zAngle)
    for (const queued of node.posQueue) {
      if (!queued) continue
      rotateY(queued, yAngle)
      rotateZ(queued, zAngle)
    }
  }
}
