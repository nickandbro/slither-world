import { expect, test } from '@playwright/test'
import { enterGame } from './helpers'

type RendererInfo = {
  activeBackend: 'webgl'
  webglShaderHooksEnabled: boolean
}

test.describe('renderer runtime', () => {
  test('reports webgl runtime info', async ({ page }) => {
    await page.goto('/')
    await enterGame(page)

    await page.waitForFunction(() => {
      const debugApi = (
        window as Window & {
          __SNAKE_DEBUG__?: {
            getRendererInfo?: () => RendererInfo
          }
        }
      ).__SNAKE_DEBUG__
      const info = debugApi?.getRendererInfo?.() ?? null
      return info?.activeBackend === 'webgl'
    })

    const info = await page.evaluate(() => {
      const debugApi = (
        window as Window & {
          __SNAKE_DEBUG__?: {
            getRendererInfo?: () => RendererInfo
          }
        }
      ).__SNAKE_DEBUG__
      return debugApi?.getRendererInfo?.() ?? null
    })

    expect(info).not.toBeNull()
    expect(info?.activeBackend).toBe('webgl')
    expect(typeof info?.webglShaderHooksEnabled).toBe('boolean')
  })

  test('drops legacy renderer query param', async ({ page }) => {
    await page.goto('/?renderer=webgpu')
    await enterGame(page)
    await expect(page).not.toHaveURL(/renderer=/)
    await expect(page.locator('#renderer-mode')).toHaveCount(0)
  })
})
