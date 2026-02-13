import { expect, test } from '@playwright/test'
import { enterGame } from './helpers'
import { runDeterministicPredictionPath } from './predictionPath'

const STORAGE_KEYS = {
  name: 'spherical_snake_player_name',
  best: 'spherical_snake_best_score',
  room: 'spherical_snake_room',
  prediction: 'spherical_snake_prediction',
}

type MotionInfo = {
  backwardCorrectionCount: number
  minHeadDot: number
  sampleCount: number
}

type PredictionInfo = {
  enabled: boolean
  replayedInputCountLastFrame: number
}

test('steering input keeps motion stable while local prediction remains active', async ({ page }, testInfo) => {
  const room = `e2e-steer-${Date.now()}-${testInfo.parallelIndex}`
  await page.addInitScript(
    ({ keys, roomName }) => {
      localStorage.setItem(keys.name, 'E2E Steering')
      localStorage.setItem(keys.best, '0')
      localStorage.setItem(keys.room, roomName)
      localStorage.setItem(keys.prediction, '1')
    },
    { keys: STORAGE_KEYS, roomName: room },
  )

  await page.goto('/?renderer=webgl&prediction=1')
  await enterGame(page)

  await runDeterministicPredictionPath(page, {
    durationMs: 3_500,
    boostWindows: [],
  })

  const result = await page.evaluate(() => {
    const api = (
      window as Window & {
        __SNAKE_DEBUG__?: {
          getMotionStabilityInfo?: () => MotionInfo
          getPredictionInfo?: () => PredictionInfo
        }
      }
    ).__SNAKE_DEBUG__
    return {
      motion: api?.getMotionStabilityInfo?.() ?? null,
      prediction: api?.getPredictionInfo?.() ?? null,
    }
  })

  expect(result.motion).not.toBeNull()
  expect(result.motion?.sampleCount ?? 0).toBeGreaterThan(20)
  expect(result.motion?.minHeadDot ?? 0).toBeGreaterThanOrEqual(0.985)
  expect(result.prediction).not.toBeNull()
  expect(result.prediction?.enabled).toBeTruthy()
  expect(result.prediction?.replayedInputCountLastFrame ?? -1).toBeGreaterThanOrEqual(0)
})
