import { expect, test, type Page } from '@playwright/test'

type TerrainLodInfo = {
  rings: number
  segments: number
  outerAngle: number
  rebuildCount: number
  lastRebuildReason: 'force' | 'zoom' | 'detail' | 'center' | null
  centerMode: 'camera' | 'head'
  wireframeEnabled: boolean
}

const getTerrainLodInfo = async (page: Page) => {
  return page.evaluate(() => {
    const debugApi = (
      window as Window & {
        __SNAKE_DEBUG__?: {
          getTerrainLodInfo?: () => TerrainLodInfo
        }
      }
    ).__SNAKE_DEBUG__
    return debugApi?.getTerrainLodInfo?.() ?? null
  })
}

test.describe('terrain lod stabilization', () => {
  test('keeps fixed topology and camera-centered patch in webgl', async ({ page }) => {
    await page.goto('/?renderer=webgl')
    await expect(page.locator('.status')).toContainText('Connected')

    await page.waitForFunction(() => {
      const debugApi = (
        window as Window & {
          __SNAKE_DEBUG__?: {
            getTerrainLodInfo?: () => TerrainLodInfo
          }
        }
      ).__SNAKE_DEBUG__
      const lod = debugApi?.getTerrainLodInfo?.()
      return !!lod && lod.rings > 0 && lod.segments > 0
    })

    const beforeMove = await getTerrainLodInfo(page)
    expect(beforeMove).not.toBeNull()
    expect(beforeMove?.centerMode).toBe('camera')
    expect(beforeMove?.rings).toBe(72)
    expect(beforeMove?.segments).toBe(192)
    expect(beforeMove?.wireframeEnabled).toBe(false)

    const tessellationToggle = page.getByRole('checkbox', { name: 'Terrain tessellation' })
    await tessellationToggle.check()
    await expect(tessellationToggle).toBeChecked()
    await page.waitForFunction(() => {
      const debugApi = (
        window as Window & {
          __SNAKE_DEBUG__?: {
            getTerrainLodInfo?: () => TerrainLodInfo
          }
        }
      ).__SNAKE_DEBUG__
      return debugApi?.getTerrainLodInfo?.()?.wireframeEnabled === true
    })

    await page.mouse.move(140, 180)
    await page.mouse.move(520, 220)
    await page.mouse.move(860, 260)
    await page.waitForTimeout(900)

    const afterMove = await getTerrainLodInfo(page)
    expect(afterMove).not.toBeNull()
    expect(afterMove?.centerMode).toBe('camera')
    expect(afterMove?.rings).toBe(72)
    expect(afterMove?.segments).toBe(192)
    expect(afterMove?.wireframeEnabled).toBe(true)
    expect(afterMove?.rebuildCount).toBeGreaterThanOrEqual(beforeMove?.rebuildCount ?? 0)
    expect(afterMove?.lastRebuildReason).not.toBe('detail')
  })

  test('exposes the same fixed terrain LOD info in webgpu mode @webgpu', async ({ page }) => {
    await page.goto('/?renderer=webgpu')
    await expect(page.locator('.status')).toContainText('Connected')

    await page.waitForFunction(() => {
      const debugApi = (
        window as Window & {
          __SNAKE_DEBUG__?: {
            getTerrainLodInfo?: () => TerrainLodInfo
          }
        }
      ).__SNAKE_DEBUG__
      const lod = debugApi?.getTerrainLodInfo?.()
      return !!lod && lod.rings > 0 && lod.segments > 0
    })

    const info = await getTerrainLodInfo(page)
    expect(info).not.toBeNull()
    expect(info?.centerMode).toBe('camera')
    expect(info?.rings).toBe(72)
    expect(info?.segments).toBe(192)
    expect(info?.wireframeEnabled).toBe(false)
  })
})
