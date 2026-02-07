import { expect, test, type Page } from '@playwright/test'
import { enterGame } from './helpers'

type BoostTrailInfo = {
  sampleCount: number
  boosting: boolean
  retiring: boolean
  oldestAgeMs: number
  newestAgeMs: number
}

const readBoostTrailInfo = async (page: Page, playerId: string): Promise<BoostTrailInfo | null> => {
  return page.evaluate((id) => {
    const debugApi = (
      window as Window & {
        __SNAKE_DEBUG__?: {
          getBoostTrailInfo?: (playerId: string) => BoostTrailInfo | null
        }
      }
    ).__SNAKE_DEBUG__
    return debugApi?.getBoostTrailInfo?.(id) ?? null
  }, playerId)
}

test('boost skid marks grow while boosting and retire oldest-first after boost stops', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.status')).toContainText('Connected')
  await enterGame(page)

  await expect
    .poll(async () => {
      return page.evaluate(() => window.localStorage.getItem('spherical_snake_player_id'))
    })
    .not.toBeNull()

  const playerId = await page.evaluate(() => {
    return window.localStorage.getItem('spherical_snake_player_id') ?? ''
  })
  expect(playerId).not.toBe('')

  await expect
    .poll(async () => {
      return page.evaluate((id) => {
        const debugApi = (
          window as Window & {
            __SNAKE_DEBUG__?: {
              getSnakeHeadPosition?: (playerId: string) => { x: number; y: number; z: number } | null
            }
          }
        ).__SNAKE_DEBUG__
        return debugApi?.getSnakeHeadPosition?.(id) ?? null
      }, playerId)
    }, { timeout: 8_000 })
    .not.toBeNull()

  const viewport = page.viewportSize()
  if (viewport) {
    await page.mouse.click(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2))
  }

  await page.keyboard.down('Space')

  await expect
    .poll(async () => {
      const info = await readBoostTrailInfo(page, playerId)
      return info?.sampleCount ?? 0
    }, { timeout: 6_000 })
    .toBeGreaterThan(0)

  await expect
    .poll(async () => {
      const info = await readBoostTrailInfo(page, playerId)
      return info?.boosting ?? false
    }, { timeout: 4_000 })
    .toBeTruthy()

  await page.keyboard.up('Space')

  await expect
    .poll(async () => {
      const info = await readBoostTrailInfo(page, playerId)
      return info?.boosting ?? false
    }, { timeout: 6_000 })
    .toBeFalsy()

  const retirementSamples: number[] = []
  for (let i = 0; i < 6; i += 1) {
    await page.waitForTimeout(220)
    const info = await readBoostTrailInfo(page, playerId)
    retirementSamples.push(info?.sampleCount ?? 0)
  }

  for (let i = 1; i < retirementSamples.length; i += 1) {
    expect(retirementSamples[i]).toBeLessThanOrEqual(retirementSamples[i - 1])
  }

  await expect
    .poll(async () => {
      const info = await readBoostTrailInfo(page, playerId)
      return info?.sampleCount ?? 0
    }, { timeout: 6_000 })
    .toBe(0)
})
