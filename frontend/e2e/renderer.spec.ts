import { expect, test } from '@playwright/test'
import { enterGame } from './helpers'

type RendererInfo = {
  requestedBackend: 'auto' | 'webgl' | 'webgpu'
  activeBackend: 'webgl' | 'webgpu'
  fallbackReason: string | null
}

test.describe('renderer mode controls @webgpu', () => {
  test('resolves webgpu preference with explicit runtime info', async ({ page }) => {
    await page.goto('/?renderer=webgpu')
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
      return info?.requestedBackend === 'webgpu'
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
    expect(info.requestedBackend).toBe('webgpu')
    expect(['webgpu', 'webgl']).toContain(info.activeBackend)
    if (info.activeBackend === 'webgl') {
      expect(info.fallbackReason).toBeTruthy()
    }
  })

  test('persists manual renderer selection and syncs query param', async ({ page }) => {
    await page.goto('/')
    await enterGame(page)

    const rendererInput = page.locator('#renderer-mode')
    await rendererInput.selectOption('webgl')
    await expect(page).toHaveURL(/renderer=webgl/)

    await page.waitForFunction(() => {
      const debugApi = (
        window as Window & {
          __SNAKE_DEBUG__?: {
            getRendererInfo?: () => RendererInfo
          }
        }
      ).__SNAKE_DEBUG__
      const info = debugApi?.getRendererInfo?.() ?? null
      return info?.requestedBackend === 'webgl' && info?.activeBackend === 'webgl'
    })

    await page.reload()
    await expect(rendererInput).toHaveValue('webgl')
    await page.waitForFunction(() => {
      const debugApi = (
        window as Window & {
          __SNAKE_DEBUG__?: {
            getRendererInfo?: () => RendererInfo
          }
        }
      ).__SNAKE_DEBUG__
      const info = debugApi?.getRendererInfo?.() ?? null
      return info?.requestedBackend === 'webgl' && info?.activeBackend === 'webgl'
    })
  })
})
