import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'

type MenuFlowInfo = {
  phase: 'preplay' | 'spawning' | 'playing'
  hasSpawned: boolean
  cameraBlend: number
  cameraDistance: number
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ARTIFACT_DIR = path.resolve(__dirname, '../../output/playwright')

test('menu onboarding gates spawn and transitions camera smoothly', async ({ page }) => {
  await mkdir(ARTIFACT_DIR, { recursive: true })

  await page.goto('/')
  await expect(page.locator('.menu-overlay')).toBeVisible()
  await expect(page.locator('.status')).toContainText('Connected')
  await expect(page.locator('.scorebar')).toHaveCount(0)
  await expect(page.locator('.leaderboard')).toHaveCount(0)

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, 'menu-preplay.png'),
    fullPage: false,
  })

  const playButton = page.getByRole('button', { name: 'Play' })
  await expect(playButton).toBeEnabled()
  await playButton.click()

  await page.waitForFunction(() => {
    const debugApi = (
      window as Window & {
        __SNAKE_DEBUG__?: {
          getMenuFlowInfo?: () => MenuFlowInfo
        }
      }
    ).__SNAKE_DEBUG__
    const info = debugApi?.getMenuFlowInfo?.()
    return info?.phase === 'playing' && info.cameraBlend >= 0.99
  })

  await expect(page.locator('.scorebar')).toBeVisible()
  await expect(page.locator('.leaderboard')).toBeVisible()

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, 'menu-postplay-camera.png'),
    fullPage: false,
  })
})
