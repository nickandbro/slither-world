import { expect, test, type Page } from '@playwright/test'

const readBoostIntensity = async (page: Page) => {
  return page.evaluate(() => {
    const boostFx = document.querySelector('.boost-fx')
    if (!(boostFx instanceof HTMLElement)) return -1
    const raw = getComputedStyle(boostFx).getPropertyValue('--boost-intensity')
    const value = Number.parseFloat(raw)
    return Number.isFinite(value) ? value : 0
  })
}

test('boost effect ramps up and down with local boost', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.status')).toContainText('Connected')
  await expect(page.locator('.boost-fx')).toHaveCount(1)

  const layering = await page.evaluate(() => {
    const boostFx = document.querySelector('.boost-fx')
    const gameSurface = document.querySelector('.game-surface')
    const controlPanel = document.querySelector('.control-panel')
    if (
      !(boostFx instanceof HTMLElement) ||
      !(gameSurface instanceof HTMLElement) ||
      !(controlPanel instanceof HTMLElement)
    ) {
      return null
    }
    return {
      containedInSurface: gameSurface.contains(boostFx),
      pointerEvents: getComputedStyle(boostFx).pointerEvents,
      boostZ: Number.parseInt(getComputedStyle(boostFx).zIndex || '0', 10),
      controlsZ: Number.parseInt(getComputedStyle(controlPanel).zIndex || '0', 10),
    }
  })
  expect(layering).not.toBeNull()
  expect(layering?.containedInSurface).toBeTruthy()
  expect(layering?.pointerEvents).toBe('none')
  expect(layering?.controlsZ).toBeGreaterThan(layering?.boostZ ?? 0)

  await expect
    .poll(async () => readBoostIntensity(page))
    .toBeLessThan(0.05)

  const viewport = page.viewportSize()
  if (viewport) {
    await page.mouse.click(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2))
  }
  await page.keyboard.down('Space')

  await expect
    .poll(async () => readBoostIntensity(page), { timeout: 6000 })
    .toBeGreaterThan(0.35)

  await page.keyboard.up('Space')

  await expect
    .poll(async () => readBoostIntensity(page), { timeout: 4000 })
    .toBeLessThan(0.08)
})
