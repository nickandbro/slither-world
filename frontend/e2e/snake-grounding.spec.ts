import { expect, test, type Page } from '@playwright/test'
import { enterGame } from './helpers'

type SnakeGroundingInfo = {
  minClearance: number
  maxPenetration: number
  maxAppliedLift: number
  sampleCount: number
}

const readSnakeGroundingInfo = async (page: Page) => {
  return page.evaluate(() => {
    const debugApi = (
      window as Window & {
        __SNAKE_DEBUG__?: {
          getSnakeGroundingInfo?: () => SnakeGroundingInfo | null
        }
      }
    ).__SNAKE_DEBUG__
    return debugApi?.getSnakeGroundingInfo?.() ?? null
  })
}

test('keeps local snake segments grounded against terrain facets', async ({ page }) => {
  await page.goto('/?renderer=webgl')
  await enterGame(page)

  const viewport = page.viewportSize()
  if (viewport) {
    await page.mouse.move(Math.floor(viewport.width * 0.28), Math.floor(viewport.height * 0.34))
  }

  await page.waitForFunction(() => {
    const debugApi = (
      window as Window & {
        __SNAKE_DEBUG__?: {
          getSnakeGroundingInfo?: () => SnakeGroundingInfo | null
        }
      }
    ).__SNAKE_DEBUG__
    const info = debugApi?.getSnakeGroundingInfo?.() ?? null
    return !!info && info.sampleCount > 0
  })

  const samples: SnakeGroundingInfo[] = []
  const path = [
    [0.18, 0.34],
    [0.84, 0.3],
    [0.78, 0.72],
    [0.26, 0.76],
    [0.58, 0.48],
  ]
  const captureMs = 4000
  const intervalMs = 150
  const start = Date.now()
  let step = 0
  while (Date.now() - start < captureMs) {
    const info = await readSnakeGroundingInfo(page)
    if (info) {
      samples.push(info)
    }
    if (viewport) {
      const [xNorm, yNorm] = path[step % path.length]
      await page.mouse.move(
        Math.floor(viewport.width * xNorm),
        Math.floor(viewport.height * yNorm),
      )
      step += 1
    }
    await page.waitForTimeout(intervalMs)
  }

  expect(samples.length).toBeGreaterThan(8)
  const worstPenetration = samples.reduce((worst, info) => Math.max(worst, info.maxPenetration), 0)
  const lowestClearance = samples.reduce(
    (lowest, info) => Math.min(lowest, info.minClearance),
    Number.POSITIVE_INFINITY,
  )
  const strongestLift = samples.reduce((strongest, info) => Math.max(strongest, info.maxAppliedLift), 0)

  expect(worstPenetration).toBeLessThan(0.0025)
  expect(lowestClearance).toBeGreaterThan(-0.0025)
  expect(strongestLift).toBeGreaterThan(0.002)
})
