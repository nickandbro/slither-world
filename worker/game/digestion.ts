import type { Digestion, Player } from './types'
import { DIGESTION_GROWTH_STEPS, DIGESTION_TRAVEL_SPEED_MULT, NODE_QUEUE_SIZE } from './constants'
import { clamp } from './math'
import { addSnakeNode } from './snake'

export function addDigestion(player: Player) {
  const travelSteps = Math.max(
    1,
    Math.round(((player.snake.length - 1) * NODE_QUEUE_SIZE) / DIGESTION_TRAVEL_SPEED_MULT),
  )
  const total = travelSteps + DIGESTION_GROWTH_STEPS
  player.digestions.push({
    remaining: total,
    total,
    growthSteps: DIGESTION_GROWTH_STEPS,
  })
}

export function advanceDigestions(player: Player, steps = 1) {
  const stepCount = Math.max(1, Math.floor(steps))
  for (let step = 0; step < stepCount; step += 1) {
    let growthTaken = false

    for (let i = 0; i < player.digestions.length; ) {
      const digestion = player.digestions[i]
      const atTail = digestion.remaining <= digestion.growthSteps

      if (atTail) {
        if (!growthTaken) {
          digestion.remaining -= 1
          growthTaken = true
        } else {
          digestion.remaining = Math.max(digestion.remaining, digestion.growthSteps)
        }
      } else {
        digestion.remaining -= 1
      }

      if (digestion.remaining <= 0) {
        addSnakeNode(player.snake, player.axis)
        player.digestions.splice(i, 1)
        continue
      }

      i += 1
    }
  }
}

export function getDigestionProgress(digestion: Digestion) {
  const travelTotal = Math.max(1, digestion.total - digestion.growthSteps)
  const travelRemaining = Math.max(0, digestion.remaining - digestion.growthSteps)
  const travelProgress = clamp(1 - travelRemaining / travelTotal, 0, 1)
  const growthProgress =
    digestion.remaining <= digestion.growthSteps
      ? clamp(1 - digestion.remaining / digestion.growthSteps, 0, 1)
      : 0
  return travelProgress + growthProgress
}
