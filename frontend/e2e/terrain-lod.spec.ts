import { expect, test, type Page } from '@playwright/test'

type TerrainPatchInfo = {
  totalPatches: number
  visiblePatches: number
  patchBands: number
  patchSlices: number
  dynamicRebuilds: boolean
  wireframeEnabled: boolean
}

type EnvironmentCullInfo = {
  totalTrees: number
  visibleTrees: number
  totalMountains: number
  visibleMountains: number
  totalPebbles: number
  visiblePebbles: number
  totalLakes: number
  visibleLakes: number
}

const getTerrainPatchInfo = async (page: Page) => {
  return page.evaluate(() => {
    const debugApi = (
      window as Window & {
        __SNAKE_DEBUG__?: {
          getTerrainPatchInfo?: () => TerrainPatchInfo
        }
      }
    ).__SNAKE_DEBUG__
    return debugApi?.getTerrainPatchInfo?.() ?? null
  })
}

const getEnvironmentCullInfo = async (page: Page) => {
  return page.evaluate(() => {
    const debugApi = (
      window as Window & {
        __SNAKE_DEBUG__?: {
          getEnvironmentCullInfo?: () => EnvironmentCullInfo
        }
      }
    ).__SNAKE_DEBUG__
    return debugApi?.getEnvironmentCullInfo?.() ?? null
  })
}

test.describe('terrain patch visibility', () => {
  test('keeps static patch topology and updates visibility in webgl', async ({ page }) => {
    await page.goto('/?renderer=webgl')
    await expect(page.locator('.status')).toContainText('Connected')

    await page.waitForFunction(() => {
      const debugApi = (
        window as Window & {
          __SNAKE_DEBUG__?: {
            getTerrainPatchInfo?: () => TerrainPatchInfo
          }
        }
      ).__SNAKE_DEBUG__
      const info = debugApi?.getTerrainPatchInfo?.()
      return !!info && info.totalPatches > 0 && info.visiblePatches > 0
    })

    const before = await getTerrainPatchInfo(page)
    expect(before).not.toBeNull()
    expect(before?.patchBands).toBe(12)
    expect(before?.patchSlices).toBe(24)
    expect(before?.dynamicRebuilds).toBe(false)
    expect(before?.wireframeEnabled).toBe(false)
    expect((before?.visiblePatches ?? 0) > 0).toBeTruthy()
    expect((before?.visiblePatches ?? 0) <= (before?.totalPatches ?? 0)).toBeTruthy()

    const cullBefore = await getEnvironmentCullInfo(page)
    expect(cullBefore).not.toBeNull()
    expect((cullBefore?.totalTrees ?? 0) > 0).toBeTruthy()
    expect((cullBefore?.visibleTrees ?? 0) <= (cullBefore?.totalTrees ?? 0)).toBeTruthy()

    const wireframeToggle = page.getByRole('checkbox', { name: 'Terrain wireframe' })
    await wireframeToggle.check()
    await expect(wireframeToggle).toBeChecked()
    await page.waitForFunction(() => {
      const debugApi = (
        window as Window & {
          __SNAKE_DEBUG__?: {
            getTerrainPatchInfo?: () => TerrainPatchInfo
          }
        }
      ).__SNAKE_DEBUG__
      return debugApi?.getTerrainPatchInfo?.()?.wireframeEnabled === true
    })

    await page.mouse.move(500, 260)
    await page.mouse.wheel(0, 1200)
    await page.waitForTimeout(700)

    const afterZoom = await getTerrainPatchInfo(page)
    expect(afterZoom).not.toBeNull()
    expect(afterZoom?.totalPatches).toBe(before?.totalPatches)
    expect((afterZoom?.visiblePatches ?? 0) <= (afterZoom?.totalPatches ?? 0)).toBeTruthy()
    expect(afterZoom?.wireframeEnabled).toBe(true)
    expect((afterZoom?.visiblePatches ?? 0) >= (before?.visiblePatches ?? 0)).toBeTruthy()

    await page.mouse.move(140, 180)
    await page.mouse.move(520, 220)
    await page.mouse.move(860, 260)
    await page.waitForTimeout(900)

    const cullAfter = await getEnvironmentCullInfo(page)
    expect(cullAfter).not.toBeNull()
    expect((cullAfter?.visibleTrees ?? 0) <= (cullAfter?.totalTrees ?? 0)).toBeTruthy()
    expect((cullAfter?.visibleMountains ?? 0) <= (cullAfter?.totalMountains ?? 0)).toBeTruthy()
    expect((cullAfter?.visiblePebbles ?? 0) <= (cullAfter?.totalPebbles ?? 0)).toBeTruthy()
    expect((cullAfter?.visibleLakes ?? 0) <= (cullAfter?.totalLakes ?? 0)).toBeTruthy()
  })

  test('exposes patch info in webgpu mode @webgpu', async ({ page }) => {
    await page.goto('/?renderer=webgpu')
    await expect(page.locator('.status')).toContainText('Connected')

    await page.waitForFunction(() => {
      const debugApi = (
        window as Window & {
          __SNAKE_DEBUG__?: {
            getTerrainPatchInfo?: () => TerrainPatchInfo
          }
        }
      ).__SNAKE_DEBUG__
      const info = debugApi?.getTerrainPatchInfo?.()
      return !!info && info.totalPatches > 0 && info.visiblePatches > 0
    })

    const info = await getTerrainPatchInfo(page)
    expect(info).not.toBeNull()
    expect(info?.patchBands).toBe(12)
    expect(info?.patchSlices).toBe(24)
    expect(info?.dynamicRebuilds).toBe(false)
    expect(info?.wireframeEnabled).toBe(false)
  })
})
